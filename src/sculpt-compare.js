/**
 * Sculpt comparison: how close is a sculpt's silhouette to its reference image?
 *
 * The agent used to judge a capture against its memory of the reference. This
 * module makes that a number and a picture, without a browser:
 *
 *  1. the reference becomes a foreground mask (alpha when it has one, otherwise
 *     everything that differs from the border colour);
 *  2. the recipe's parts are rasterized as a silhouette from a view (yaw,
 *     elevation, orthographic — the reference's perspective is unknown);
 *  3. the silhouette is fitted onto the mask's bounding box (height, centre),
 *     so the score measures shape, not framing;
 *  4. IoU, proportion deltas, the parts that stick out or fall short, and a
 *     side-by-side sheet (reference | overlay: grey both, red missing, blue extra).
 *
 * Pure: image buffers in, numbers and RGBA out. The MCP tool owns the files.
 */
import { expandSculptParts, patchSculptRecipe } from "./sculpt-recipe.js";
import { SCULPT_SHAPE_SPECS } from "./sculpt-shapes.js";
import { repeatCopies } from "./sculpt-repeat.js";
import { applyMatrix, multiply } from "./sculpt-matrix.js";

const COMPARE_SIZE = 256;

function shrink(image, size) {
	const scale = Math.min(1, size / Math.max(image.width, image.height));
	const width = Math.max(1, Math.round(image.width * scale));
	const height = Math.max(1, Math.round(image.height * scale));
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const sy = Math.min(image.height - 1, Math.floor(y / scale));
		for (let x = 0; x < width; x += 1) {
			const sx = Math.min(image.width - 1, Math.floor(x / scale));
			const s = (sy * image.width + sx) * 4, d = (y * width + x) * 4;
			data[d] = image.data[s]; data[d + 1] = image.data[s + 1]; data[d + 2] = image.data[s + 2]; data[d + 3] = image.data[s + 3];
		}
	}
	return { width, height, data };
}

function largestComponentFilled(mask, width, height) {
	const label = new Int32Array(width * height);
	let best = 0, bestSize = 0, next = 0;
	const stack = [];
	for (let i = 0; i < mask.length; i += 1) {
		if (!mask[i] || label[i]) continue;
		next += 1; let size = 0; stack.push(i); label[i] = next;
		while (stack.length) {
			const p = stack.pop(); size += 1;
			const x = p % width, y = (p - x) / width;
			for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
				if (q >= 0 && mask[q] && !label[q]) { label[q] = next; stack.push(q); }
			}
		}
		if (size > bestSize) { bestSize = size; best = next; }
	}
	const kept = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i += 1) kept[i] = label[i] === best ? 1 : 0;
	const outside = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i += 1) {
		const x = i % width, y = (i - x) / width;
		if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && !kept[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
	}
	while (stack.length) {
		const p = stack.pop(), x = p % width, y = (p - x) / width;
		for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
			if (q >= 0 && !kept[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
		}
	}
	for (let i = 0; i < mask.length; i += 1) if (!outside[i]) kept[i] = 1;
	return { mask: kept, area: bestSize };
}

/**
 * The subject of a reference image as a mask at COMPARE_SIZE. Alpha wins when
 * the image has a real transparent background; otherwise the border colour is
 * the background (a flat studio backdrop, the usual reference).
 */
export function referenceMask(image, { tolerance = 40, size = COMPARE_SIZE } = {}) {
	const small = shrink(image, size);
	const { width, height, data } = small;
	const n = width * height;
	let transparent = 0;
	for (let i = 0; i < n; i += 1) if (data[i * 4 + 3] < 128) transparent += 1;
	const raw = new Uint8Array(n);
	let source;
	if (transparent > n * 0.05) {
		source = "alpha";
		for (let i = 0; i < n; i += 1) raw[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
	} else {
		source = "border-colour";
		const border = [];
		for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
		for (let y = 0; y < height; y += 1) border.push(y * width, y * width + width - 1);
		const channel = (k) => border.map((i) => data[i * 4 + k]).sort((a, b) => a - b)[border.length >> 1];
		const bg = [channel(0), channel(1), channel(2)];
		for (let i = 0; i < n; i += 1) {
			const d = Math.abs(data[i * 4] - bg[0]) + Math.abs(data[i * 4 + 1] - bg[1]) + Math.abs(data[i * 4 + 2] - bg[2]);
			raw[i] = d > tolerance ? 1 : 0;
		}
	}
	const { mask, area } = largestComponentFilled(raw, width, height);
	if (area < n * 0.01) throw new Error("No subject found in the reference: give it a flat background or transparency.");
	if (area > n * 0.97) throw new Error("The reference has no background to separate the subject from.");
	return { width, height, mask, source, image: small };
}

const DEG = Math.PI / 180;

/** Orthographic view from a camera at azimuth `yawDeg` (0 = in front, +90 = on the
 * subject's own left, +x) and `elevationDeg` above: [screen right, screen up]. */
function viewProject([x, y, z], yawDeg, elevationDeg) {
	const a = yawDeg * DEG, e = elevationDeg * DEG;
	const right = x * Math.cos(a) - z * Math.sin(a);
	const towardCamera = x * Math.sin(a) + z * Math.cos(a);
	return [right, y * Math.cos(e) - towardCamera * Math.sin(e)];
}


function convexHull(points) {
	const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [], upper = [];
	for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
	for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Projected convex outline of every drawn part, in view metres. Frames keep their hole. A cutter (op) adds no area and cuts no hole: the reference mask fills enclosed holes anyway, and an intersect's parent keeps its uncut outline. */
export function sculptViewPolygons(recipe, { yaw = 0, elevation = 0 } = {}) {
	// A repeated part outlines every copy (sculpt-repeat.js).
	return expandSculptParts(recipe).filter((part) => !part.op).flatMap((part) => repeatCopies(part).map((copy) => [part, multiply(part.matrix, copy)])).map(([part, matrix]) => {
		const project = (point) => viewProject(applyMatrix(matrix, point), yaw, elevation);
		const spec = SCULPT_SHAPE_SPECS[part.shape];
		// See-through only where the front and back openings overlap; the front
		// face's opening alone is a slightly generous stand-in.
		const opening = spec.hole?.(part);
		const holeHull = opening ? convexHull(opening.map(project)) : [];
		const hole = holeHull.length >= 3 ? holeHull : null;
		// One polygon per sample group, all carrying the part's id.
		return spec.samples(part).map((group) => ({ id: part.id, polygon: convexHull(group.map(project)), hole }));
	}).flat();
}

function insidePolygon(polygon, x, y) {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function boundsOf(polygons) {
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const { polygon } of polygons) for (const [x, y] of polygon) {
		minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
	}
	return { minX, maxX, minY, maxY };
}

function maskBounds(mask, width, height) {
	let minX = width, maxX = -1, minY = height, maxY = -1;
	for (let i = 0; i < mask.length; i += 1) if (mask[i]) {
		const x = i % width, y = (i - x) / width;
		if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	return { minX, maxX: maxX + 1, minY, maxY: maxY + 1 };
}

/**
 * Rasterize the sculpt so its bounding box sits on `box` (pixel space, height
 * matched, centred). Returns the mask and a per-pixel owner (part index + 1).
 */
function rasterizeFitted(polygons, width, height, box, shiftX = 0) {
	const world = boundsOf(polygons);
	const scale = (box.maxY - box.minY) / Math.max(1e-6, world.maxY - world.minY);
	const cx = (box.minX + box.maxX) / 2 - ((world.minX + world.maxX) / 2) * scale + shiftX;
	const top = box.minY + world.maxY * scale;
	const mask = new Uint8Array(width * height), owner = new Int32Array(width * height);
	const pixel = polygons.map(({ id, polygon, hole }) => ({
		id,
		polygon: polygon.map(([x, y]) => [cx + x * scale, top - y * scale]),
		hole: hole?.map(([x, y]) => [cx + x * scale, top - y * scale]) ?? null,
	}));
	pixel.forEach(({ polygon, hole }, index) => {
		if (polygon.length < 3) return;
		const b = boundsOf([{ polygon }]);
		for (let y = Math.max(0, Math.floor(b.minY)); y < Math.min(height, Math.ceil(b.maxY)); y += 1) {
			for (let x = Math.max(0, Math.floor(b.minX)); x < Math.min(width, Math.ceil(b.maxX)); x += 1) {
				if (!insidePolygon(polygon, x + 0.5, y + 0.5)) continue;
				if (hole && insidePolygon(hole, x + 0.5, y + 0.5)) continue;
				mask[y * width + x] = 1;
				owner[y * width + x] = index + 1;
			}
		}
	});
	return { mask, owner, parts: pixel, shiftX };
}

const MISSING = [220, 40, 40], EXTRA = [40, 90, 220], BOTH = [190, 190, 190];

/**
 * Compare a recipe with a reference image (RGBA). `yaw` is the reference
 * camera's azimuth: 0 is straight on, positive moves the camera round to the
 * subject's own left (+x) side; `elevation` looks down from above.
 */
export function compareSculptToReference(recipe, image, { yaw = 0, elevation = 0 } = {}) {
	const ref = referenceMask(image);
	const { width, height } = ref;
	const box = maskBounds(ref.mask, width, height);
	const polygons = sculptViewPolygons(recipe, { yaw, elevation });
	// Height and top are matched; the horizontal offset is searched, because a
	// centred bounding box blames the body when only an arm sticks out.
	const overlap = (sil) => {
		let both = 0, union = 0;
		for (let i = 0; i < sil.mask.length; i += 1) { both += ref.mask[i] & sil.mask[i]; union += ref.mask[i] | sil.mask[i]; }
		return both / Math.max(1, union);
	};
	let sil = rasterizeFitted(polygons, width, height, box), bestScore = overlap(sil);
	const reach = Math.round((box.maxX - box.minX) / 2);
	for (let step = 8; step >= 1; step >>= 1) {
		for (const direction of [-1, 1]) {
			for (let shift = sil.shiftX + direction * step; Math.abs(shift) <= reach; shift += direction * step) {
				const candidate = rasterizeFitted(polygons, width, height, box, shift), score = overlap(candidate);
				if (score <= bestScore) break;
				sil = candidate; bestScore = score;
			}
		}
	}
	let both = 0, missing = 0, extra = 0;
	const extraByPart = new Map();
	for (let i = 0; i < ref.mask.length; i += 1) {
		const r = ref.mask[i], s = sil.mask[i];
		if (r && s) both += 1;
		else if (r) missing += 1;
		else if (s) { extra += 1; const id = sil.parts[sil.owner[i] - 1].id; extraByPart.set(id, (extraByPart.get(id) ?? 0) + 1); }
	}
	const area = both + missing;
	// Missing reference pixels, in thirds of the subject's height, so the agent knows where to add.
	const bandMissing = [0, 0, 0];
	const bandHeight = (box.maxY - box.minY) / 3;
	for (let i = 0; i < ref.mask.length; i += 1) if (ref.mask[i] && !sil.mask[i]) {
		const y = (i - (i % width)) / width;
		bandMissing[Math.min(2, Math.max(0, Math.floor((y - box.minY) / bandHeight)))] += 1;
	}
	const silBox = maskBounds(sil.mask, width, height);
	const refAspect = (box.maxX - box.minX) / (box.maxY - box.minY);
	const silAspect = (silBox.maxX - silBox.minX) / Math.max(1, silBox.maxY - silBox.minY);
	const round = (v, d = 3) => Number(v.toFixed(d));
	const report = {
		iou: round(both / Math.max(1, both + missing + extra)),
		missingFraction: round(missing / Math.max(1, area)),
		extraFraction: round(extra / Math.max(1, area)),
		widthToHeight: { reference: round(refAspect), sculpt: round(silAspect), delta: round(silAspect - refAspect) },
		missingByBand: { top: round(bandMissing[0] / Math.max(1, area)), middle: round(bandMissing[1] / Math.max(1, area)), bottom: round(bandMissing[2] / Math.max(1, area)) },
		extraByPart: [...extraByPart.entries()].map(([id, px]) => ({ id, fraction: round(px / Math.max(1, area)) })).filter((row) => row.fraction >= 0.005).sort((a, b) => b.fraction - a.fraction).slice(0, 6),
		mask: ref.source,
		view: { yaw, elevation },
	};
	const sheet = new Uint8Array(width * 2 * height * 4);
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const s = (y * width + x) * 4, i = y * width + x;
		const left = (y * width * 2 + x) * 4, right = left + width * 4;
		const alpha = ref.image.data[s + 3] / 255;
		for (let k = 0; k < 3; k += 1) sheet[left + k] = Math.round(ref.image.data[s + k] * alpha + 255 * (1 - alpha));
		sheet[left + 3] = 255;
		const colour = ref.mask[i] && sil.mask[i] ? BOTH : ref.mask[i] ? MISSING : sil.mask[i] ? EXTRA : [255, 255, 255];
		sheet[right] = colour[0]; sheet[right + 1] = colour[1]; sheet[right + 2] = colour[2]; sheet[right + 3] = 255;
	}
	return { report, sheet: { width: width * 2, height, data: sheet } };
}

/** Try a few yaws and keep the best: the reference's angle is usually a guess. */
export function bestViewForReference(recipe, image, { yaws = [-45, -30, -15, 0, 15, 30, 45], elevation = 0 } = {}) {
	let best = null;
	for (const yaw of yaws) {
		const result = compareSculptToReference(recipe, image, { yaw, elevation });
		if (!best || result.report.iou > best.report.iou) best = result;
	}
	return best;
}

/**
 * The one scoring path behind MCP compare_sculpt and the editor's sculpt.compare:
 * score the recipe (at `yaw`, or the best of -45..45 when it is undefined), and
 * when `candidates` are given, score each patched recipe from that same view and
 * rank them with the current sculpt. Nothing is applied.
 * Returns { result, ranked?: [{ label, result }] best first, refused?: [{ label, error }] }.
 */
export function scoreSculptAgainstReference(recipe, image, { yaw, elevation = 0, candidates } = {}) {
	const score = (next, view) => (view === undefined ? bestViewForReference(next, image, { elevation }) : compareSculptToReference(next, image, { yaw: view, elevation }));
	const result = score(recipe, yaw);
	if (!candidates) return { result };
	// Every candidate is scored from the same view as the current sculpt, so the ranking compares shapes, not angles.
	const view = result.report.view.yaw;
	const ranked = [{ label: "current", result }];
	const refused = [];
	for (const candidate of candidates) {
		const patched = patchSculptRecipe(recipe, candidate.edits);
		if (!patched.ok) refused.push({ label: candidate.label, error: patched.error });
		else ranked.push({ label: candidate.label, result: score(patched.recipe, view) });
	}
	ranked.sort((a, b) => b.result.report.iou - a.result.report.iou);
	return { result, ranked, refused };
}

/** One ranking row: the candidate's score against the current sculpt's. */
export function rankingRow({ label, result }, current) {
	const { report } = result;
	return { label, iou: report.iou, delta: Number((report.iou - current.report.iou).toFixed(3)), missingByBand: report.missingByBand, extraByPart: report.extraByPart.slice(0, 3) };
}

/**
 * The reference outline measured in pixels, for the agent's first draft: the subject's
 * width:height and, for `rows` horizontal slices from the head top down, the filled
 * spans across that slice. x is a fraction of the subject's height from its horizontal
 * centre, positive toward image right (the subject's own left in a front view); y is a
 * fraction of height from the top. Measuring beats eyeballing: a measured draft scored
 * IoU 0.945 where an eyeballed one scored about 0.75.
 */
export function measureReferenceOutline(image, { rows = 12 } = {}) {
	const { width, height, mask } = referenceMask(image);
	let top = height, bottom = -1, left = width, right = -1;
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		if (!mask[y * width + x]) continue;
		if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x;
	}
	if (bottom < 0) throw new Error("no subject found in the reference image");
	const h = bottom - top + 1, centre = (left + right + 1) / 2;
	const round = value => Math.round(value * 100) / 100;
	const slices = [];
	for (let i = 0; i < rows; i += 1) {
		const y = Math.min(bottom, Math.round(top + ((i + 0.5) / rows) * h));
		const spans = [];
		let start = -1;
		for (let x = 0; x <= width; x += 1) {
			const on = x < width && mask[y * width + x];
			if (on && start < 0) start = x;
			if (!on && start >= 0) { if (x - start >= 2) spans.push([round((start - centre) / h), round((x - centre) / h)]); start = -1; }
		}
		slices.push({ y: round((y - top) / h), spans });
	}
	// Where the subject sits in the image (fractions of the image), so a view can draw the slices over it.
	const box = { left: (left) / width, top: top / height, width: (right - left + 1) / width, height: h / height, aspect: height / width };
	return { widthToHeight: round((right - left + 1) / h), rows: slices, box };
}
