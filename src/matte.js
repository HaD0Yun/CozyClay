/**
 * Background removal: the step between "a photo" and "a cutout".
 *
 * A card IS its transparency. A JPEG of a sofa imported as-is stands up as a
 * rectangle of somebody's living room, which blocks nothing and reads as a
 * mistake in the frame. So the picture has to lose its background before it
 * can be a set piece.
 *
 * This is the cheap, offline half of that job (issue #17 P2): grow a region
 * from the edges of the frame and drop what it reaches. It cannot cut a
 * subject out of a busy street — that is the model-backed half, P3, which
 * needs a segmentation model behind a server-side runner — but it is exact on the
 * pictures previs actually uses: a product shot, a prop on a sweep, anything
 * photographed against a wall.
 *
 * Two rules make it hold up on real photographs:
 *
 *   - Growth is LOCAL. A pixel joins the background if it is close to the
 *     pixel it grew from, not merely close to the corner it started at. A wall
 *     that shades from top to bottom is one region; a global threshold either
 *     stops halfway up it or eats the subject.
 *   - Growth is also BOUNDED by the seed colours, so a local chain of small
 *     steps cannot walk across a soft edge and out the other side into the
 *     subject.
 *
 * Everything here is pure: pixels in, pixels out, no DOM. `cutOutBackground`
 * at the bottom is the browser glue, and every browser API it needs is
 * injected — the same seam `importImageFile` uses, for the same reason.
 */

import { assetIdForBytes, normalizeAsset } from "./scene-assets.js";

/** Colour distance is compared squared, so nothing here takes a square root. */
const dist2 = (data, a, b) => {
	const dr = data[a] - data[b];
	const dg = data[a + 1] - data[b + 1];
	const db = data[a + 2] - data[b + 2];
	return dr * dr + dg * dg + db * db;
};

const seedDist2 = (data, index, seeds) => {
	let best = Infinity;
	for (let s = 0; s < seeds.length; s += 3) {
		const dr = data[index] - seeds[s];
		const dg = data[index + 1] - seeds[s + 1];
		const db = data[index + 2] - seeds[s + 2];
		const value = dr * dr + dg * dg + db * db;
		if (value < best) best = value;
	}
	return best;
};

/**
 * Where to start growing from. Every pixel on the frame's edge is a candidate
 * background sample; they are quantized to a small palette so a noisy border
 * does not turn into ten thousand reference colours.
 *
 * `points` overrides this entirely — that is the "click the background you
 * meant" path, and one deliberate click beats four guessed corners on a
 * picture whose subject runs off the edge.
 */
export function borderSeeds({ data, width, height }, points = null) {
	const sampleColour = (x, y) => {
		const index = (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4;
		return index;
	};
	if (points?.length) {
		const seeds = [];
		for (const { x, y } of points) {
			const index = sampleColour(Math.round(x), Math.round(y));
			seeds.push(data[index], data[index + 1], data[index + 2]);
		}
		return { seeds: Float64Array.from(seeds), starts: points.map(({ x, y }) => sampleColour(Math.round(x), Math.round(y))) };
	}

	// Quantize to 16 levels per channel: enough to tell a wall from a sofa,
	// coarse enough that grain does not multiply the reference set.
	const counts = new Map();
	const starts = [];
	const step = Math.max(1, Math.round(Math.min(width, height) / 64));
	const tally = (x, y) => {
		const index = sampleColour(x, y);
		starts.push(index);
		const key = ((data[index] >> 4) << 8) | ((data[index + 1] >> 4) << 4) | (data[index + 2] >> 4);
		const seen = counts.get(key);
		if (seen) seen.count += 1;
		else counts.set(key, { count: 1, r: data[index], g: data[index + 1], b: data[index + 2] });
	};
	for (let x = 0; x < width; x += step) {
		tally(x, 0);
		tally(x, height - 1);
	}
	for (let y = 0; y < height; y += step) {
		tally(0, y);
		tally(width - 1, y);
	}

	// Only the colours that DOMINATE the border are background. A subject
	// rooted at the bottom of the frame — which is most subjects — touches the
	// edge too, and taking every border colour as a reference would let the
	// growth start inside it and eat the picture from its own feet up.
	const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
	const floor = (ranked[0]?.count ?? 0) * 0.2;
	const seeds = [];
	for (const entry of ranked) {
		if (entry.count < floor) break;
		seeds.push(entry.r, entry.g, entry.b);
	}
	return { seeds: Float64Array.from(seeds), starts };
}

/**
 * `within`, when given, fences the growth: a pixel can only be entered if it is
 * marked there. That is what lets the eraser be the same tool as the brush —
 * growing back through a region that is already selected, and stopping where
 * the selection stops, rather than nibbling at it a disc at a time.
 */
export function backgroundMask(pixels, { points = null, tolerance = 0.18, within = null } = {}) {
	const { data, width, height } = pixels;
	const total = width * height;
	const background = new Uint8Array(total);
	if (!total) return background;

	const { seeds, starts } = borderSeeds(pixels, points);
	if (!seeds.length) return background;

	// 0–1 maps onto a squared distance in 0–255³ space. The local step is a
	// fraction of the global bound: small enough that a soft edge stops it,
	// large enough to walk a gradient.
	const globalLimit = (tolerance * 441.67) ** 2;
	const localLimit = (tolerance * 441.67 * 0.42) ** 2;

	const stack = new Int32Array(total);
	let top = 0;
	for (const start of starts) {
		const pixel = start >> 2;
		if (background[pixel]) continue;
		if (within && !within[pixel]) continue;
		// A start that is already far from every seed colour (a subject running
		// off the frame edge) is not background and must not begin a region.
		if (seedDist2(data, start, seeds) > globalLimit) continue;
		background[pixel] = 1;
		stack[top++] = pixel;
	}

	while (top > 0) {
		const pixel = stack[--top];
		const index = pixel << 2;
		const x = pixel % width;
		const y = (pixel - x) / width;
		for (let edge = 0; edge < 4; edge++) {
			const nx = x + (edge === 0 ? -1 : edge === 1 ? 1 : 0);
			const ny = y + (edge === 2 ? -1 : edge === 3 ? 1 : 0);
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
			const neighbour = ny * width + nx;
			if (background[neighbour]) continue;
			if (within && !within[neighbour]) continue;
			const neighbourIndex = neighbour << 2;
			// Already transparent counts as background: an image that arrives
			// half-cut stays cut.
			const clear = data[neighbourIndex + 3] === 0;
			if (!clear && dist2(data, neighbourIndex, index) > localLimit) continue;
			if (!clear && seedDist2(data, neighbourIndex, seeds) > globalLimit) continue;
			background[neighbour] = 1;
			stack[top++] = neighbour;
		}
	}
	return background;
}

/**
 * A round stroke into the paint layer: `value` 1 means "this is background
 * after all", -1 means "put that back". The paint layer is kept SEPARATE from
 * the automatic mask so moving the tolerance slider re-runs the growth without
 * throwing away a stroke someone has already made.
 *
 * Coordinates and radius are in the paint layer's own pixels.
 */
export function paintMask(paint, { width, height }, { x, y, radius, value = 1 }) {
	const cx = Math.round(x);
	const cy = Math.round(y);
	const r = Math.max(0.5, radius);
	const r2 = r * r;
	const minX = Math.max(0, Math.floor(cx - r));
	const maxX = Math.min(width - 1, Math.ceil(cx + r));
	const minY = Math.max(0, Math.floor(cy - r));
	const maxY = Math.min(height - 1, Math.ceil(cy + r));
	let touched = 0;
	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const dx = px - cx;
			const dy = py - cy;
			if (dx * dx + dy * dy > r2) continue;
			const at = py * width + px;
			if (paint[at] === value) continue;
			paint[at] = value;
			touched += 1;
		}
	}
	return touched;
}

/**
 * The automatic mask with the strokes laid over it.
 *
 * The two layers can be different sizes on purpose: the editor paints on a
 * preview a few hundred pixels wide, while the mask that is finally applied is
 * grown at the picture's full resolution. A brush stroke is coarse by nature,
 * so sampling it up is honest; the machine-cut edge stays exact.
 */
export function combineMask(auto, paint, { width, height, paintWidth = width, paintHeight = height } = {}) {
	const out = Uint8Array.from(auto);
	if (!paint) return out;
	const sx = paintWidth / width;
	const sy = paintHeight / height;
	for (let y = 0; y < height; y++) {
		const py = Math.min(paintHeight - 1, Math.floor(y * sy));
		for (let x = 0; x < width; x++) {
			const stroke = paint[py * paintWidth + Math.min(paintWidth - 1, Math.floor(x * sx))];
			if (!stroke) continue;
			out[y * width + x] = stroke > 0 ? 1 : 0;
		}
	}
	return out;
}

/**
 * Turn a mask into transparency: erode the fringe, soften the boundary, write
 * the alpha. Split from the growth above so the editor can show a mask, let
 * someone paint on it, and only then pay for the pixels.
 */
/**
 * Edge-line cleanup: screenshot imports often carry a thin frame-line baked
 * into the picture (a window border, a card edge) — a stroke the seed colours
 * never claimed, so the mask grows around it and shrink only eats the rim
 * beside it. Such a line is recognizable: it survives the mask, touches a
 * picture edge, and is small next to the frame. Any kept component with all
 * three marks is folded back into the background before the cut is written.
 */
function dropEdgeLines(data, width, height) {
	const total = width * height;
	const visited = new Uint8Array(total);
	const stack = [];
	let changed = 0;
	for (let i = 0; i < total; i += 1) {
		if (data[i * 4 + 3] < 8 || visited[i]) continue;
		stack.length = 0;
		stack.push(i);
		visited[i] = 1;
		const members = [];
		let touchesEdge = false;
		while (stack.length) {
			const index = stack.pop();
			members.push(index);
			const x = index % width;
			const y = (index / width) | 0;
			if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
				const ni = ny * width + nx;
				if (!visited[ni] && data[ni * 4 + 3] >= 8) {
					visited[ni] = 1;
					stack.push(ni);
				}
			}
		}
		// a kept component that touches the frame edge and stays tiny relative
		// to the picture is a baked-in border line, not a subject
		if (touchesEdge && members.length < total * 0.05) {
			for (const index of members) {
				data[index * 4 + 3] = 0;
				changed += 1;
			}
		}
	}
	return changed;
}

export function applyMask(pixels, mask, { shrink = 1, feather = 1 } = {}) {
	const { width, height } = pixels;
	const data = new Uint8ClampedArray(pixels.data);
	const total = width * height;
	if (!total) return { data, width, height, removed: 0 };

	/* -- fringe: trim the blended rim, WITHOUT eating thin structures ------- */
	//
	// A photographed edge is a pixel of subject mixed with a pixel of wall, and
	// that mixture is far enough from the wall's own colour that the growth
	// cannot take it. Left alone it survives as a ring of half-wall around the
	// cutout, which on a set reads as an outline drawn round the card — the
	// thing that makes a cutout look cut out.
	//
	// Eroding the kept region by a pixel removes it. Eroding it BLINDLY also
	// removes every structure thinner than the erosion: hair, branches, chair
	// legs, an antenna. So a pixel is only trimmed where there is DEPTH behind
	// it — three more kept pixels away from the background it touches. A mass
	// gets its rim taken; anything up to three pixels thick is left whole,
	// because that is not a rim, it is the subject.
	let grown = mask;
	for (let pass = 0; pass < Math.max(0, Math.round(shrink)); pass++) {
		const next = Uint8Array.from(grown);
		const kept = (x, y) => x >= 0 && y >= 0 && x < width && y < height && !grown[y * width + x];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const pixel = y * width + x;
				if (grown[pixel]) continue;
				for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
					const nx = x + dx;
					const ny = y + dy;
					// Background in this direction, and depth in the other one.
					const background = nx < 0 || ny < 0 || nx >= width || ny >= height || grown[ny * width + nx];
					if (!background) continue;
					if (kept(x - dx, y - dy) && kept(x - dx * 2, y - dy * 2) && kept(x - dx * 3, y - dy * 3)) {
						next[pixel] = 1;
						break;
					}
				}
			}
		}
		grown = next;
	}

	const alpha = new Float32Array(total);
	let removed = 0;
	for (let pixel = 0; pixel < total; pixel++) {
		if (grown[pixel]) removed += 1;
		alpha[pixel] = grown[pixel] ? 0 : data[(pixel << 2) + 3];
	}
	for (let pass = 0; pass < Math.max(0, Math.round(feather)); pass++) {
		const blurred = Float32Array.from(alpha);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const pixel = y * width + x;
				let sum = alpha[pixel];
				let count = 1;
				if (x > 0) { sum += alpha[pixel - 1]; count++; }
				if (x < width - 1) { sum += alpha[pixel + 1]; count++; }
				if (y > 0) { sum += alpha[pixel - width]; count++; }
				if (y < height - 1) { sum += alpha[pixel + width]; count++; }
				const average = sum / count;
				// Only the boundary softens. Blurring the interior would make a
				// solid subject faintly see-through, which reads as a ghost.
				if (average !== alpha[pixel]) blurred[pixel] = average;
			}
		}
		alpha.set(blurred);
	}
	for (let pixel = 0; pixel < total; pixel++) data[(pixel << 2) + 3] = Math.round(alpha[pixel]);

	// A line baked into the picture (a screenshot's window border) survives
	// both the growth and the rim trim: it is not the wall's colour, and it is
	// not a blended rim. Fold any such edge-touching sliver into the cut.
	removed += dropEdgeLines(data, width, height);

	return { data, width, height, removed };
}

/**
 * Drop the background, in place on a copy — the one-shot path, and the same
 * two steps the editor runs separately.
 *
 * `tolerance` (0–1) is the one control a person should ever need: it scales
 * both the bound against the seed colours and the local step. `shrink` eats
 * the fringe of background-coloured pixels that survives any threshold, and
 * `feather` softens what is left so the card's edge does not read as a
 * cut-out-with-scissors line against the set.
 */
export function removeBackground(pixels, { points = null, tolerance = 0.18, shrink = 1, feather = 1, mask = null } = {}) {
	const grown = mask ?? backgroundMask(pixels, { points, tolerance });
	return applyMask(pixels, grown, { shrink, feather });
}

/** The box the picture still occupies, or null when nothing survived. */
export function opaqueBounds({ data, width, height }, threshold = 8) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] < threshold) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Crop to a box. Cutting the empty margin away is not tidiness: the card's
 * width is derived from the picture's aspect, so a frame of dead transparency
 * is a card that is wider than the thing it shows and stands the subject off
 * the floor.
 */
export function cropPixels({ data, width }, box) {
	const out = new Uint8ClampedArray(box.width * box.height * 4);
	for (let y = 0; y < box.height; y++) {
		const from = ((box.y + y) * width + box.x) * 4;
		out.set(data.subarray(from, from + box.width * 4), y * box.width * 4);
	}
	return { data: out, width: box.width, height: box.height };
}

function defaultCanvas(width, height) {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	throw new Error("this browser cannot edit images — OffscreenCanvas is unavailable");
}

/**
 * The purple, as a storable picture.
 *
 * A card keeps TWO things: the photograph it was imported from, untouched, and
 * the region someone has decided is background. The second one has to survive
 * a reload like the first, and the asset store already knows how to keep a
 * picture — so the mask is written as one. White is "this goes", and PNG's own
 * compression handles a mask of flat regions better than anything worth
 * hand-rolling.
 */
export async function encodeMask(mask, { width, height }, { makeCanvas = defaultCanvas } = {}) {
	const canvas = makeCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("this browser cannot store a selection — no 2D context");
	const data = new Uint8ClampedArray(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const value = mask[pixel] ? 255 : 0;
		const index = pixel << 2;
		data[index] = value;
		data[index + 1] = value;
		data[index + 2] = value;
		data[index + 3] = 255;
	}
	context.putImageData(new ImageData(data, width, height), 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return blob.arrayBuffer();
}

/** The purple as an asset record, ready for the store the pictures live in. */
export async function maskAsset(mask, { width, height, name = "matte" }, deps = {}) {
	const bytes = await encodeMask(mask, { width, height }, deps);
	const asset = normalizeAsset({
		id: await assetIdForBytes(bytes, deps.subtle ?? globalThis.crypto?.subtle),
		type: "image/png",
		width,
		height,
		bytes,
		name,
	});
	if (!asset) throw new Error("that selection could not be stored");
	return asset;
}

/** The purple back out of a stored picture. */
export async function decodeMask(asset, { createBitmap = globalThis.createImageBitmap, makeCanvas = defaultCanvas } = {}) {
	const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }));
	try {
		const canvas = makeCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d", { willReadFrequently: true });
		context.drawImage(bitmap, 0, 0);
		const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
		const mask = new Uint8Array(bitmap.width * bitmap.height);
		for (let pixel = 0; pixel < mask.length; pixel++) mask[pixel] = image.data[pixel << 2] > 127 ? 1 : 0;
		return { mask, width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap?.close?.();
	}
}

/**
 * An asset with its background gone, as a NEW asset record.
 *
 * New, not edited: assets are addressed by their own bytes, so a cut picture
 * is a different picture. Keeping the original addressable is what makes the
 * cut undoable and what lets a second card use the untouched photo.
 *
 * `heightScale` comes back with it. Trimming changes how much of the frame the
 * subject fills, and the card is sized in metres — so the caller multiplies the
 * card's height by this to keep the subject exactly the size it already was.
 */
export async function cutOutBackground(asset, options = {}, {
	subtle = globalThis.crypto?.subtle,
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = defaultCanvas,
} = {}) {
	if (!asset?.bytes) throw new TypeError("cutOutBackground needs an asset record");
	if (typeof createBitmap !== "function") throw new Error("this browser cannot decode images — createImageBitmap is unavailable");
	const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }));
	try {
		const canvas = makeCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("this browser cannot edit images — no 2D context");
		context.drawImage(bitmap, 0, 0);
		const source = context.getImageData(0, 0, bitmap.width, bitmap.height);

		// A mask from the editor wins over growing a fresh one: it already IS
		// the answer, corrected by hand at this picture's own resolution. It has
		// to BE this picture's resolution, or it would land on the wrong pixels.
		const pixels = { data: source.data, width: source.width, height: source.height };
		if (options.mask && options.mask.length !== source.width * source.height) {
			throw new Error("that selection was made on a different picture");
		}
		const mask = combineMask(options.mask ?? backgroundMask(pixels, options), options.paint ?? null, {
			width: source.width,
			height: source.height,
			paintWidth: options.paintWidth ?? source.width,
			paintHeight: options.paintHeight ?? source.height,
		});
		const cut = applyMask(pixels, mask, options);
		const box = opaqueBounds(cut);
		if (!box) throw new Error("that removed the whole picture — try a lower tolerance");
		const trimmed = options.trim === false ? cut : cropPixels(cut, box);

		const out = makeCanvas(trimmed.width, trimmed.height);
		const outContext = out.getContext("2d");
		outContext.putImageData(new ImageData(trimmed.data, trimmed.width, trimmed.height), 0, 0);
		// PNG always: whatever came in, what goes out has alpha to carry.
		const blob = await out.convertToBlob({ type: "image/png" });
		const bytes = await blob.arrayBuffer();
		const cutAsset = normalizeAsset({
			id: await assetIdForBytes(bytes, subtle),
			type: "image/png",
			width: trimmed.width,
			height: trimmed.height,
			bytes,
			name: asset.name,
		});
		if (!cutAsset) throw new Error("the cut picture could not be stored");
		return {
			asset: cutAsset,
			heightScale: trimmed.height / (source.height || 1),
			removed: cut.removed / (source.width * source.height),
		};
	} finally {
		bitmap?.close?.();
	}
}
