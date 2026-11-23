// AI video reference ("blurmove"): the previs re-rendered so a reference-video
// model (Seedance 2.5 and the like) keeps the camera, cuts and blocking but not
// the grey mannequin look or its stiff poses.
//
// Every 4 frames of a shot: 1 frame is a light mosaic of the previs (96 cells
// across), the other 3 are the previs still playing under a heavy smooth blur
// (32 cells across, gaussian sigma 25 at 1280 px wide). The cycle restarts at
// each shot's first frame, so every cut opens on a readable frame.
//
// The numbers are fixed on purpose. They are the setting that held camera,
// cuts and timing on the 2026-11-21..23 Seedance 2.5 tests (snowmobile, office,
// truck, night street); the user locked them so every export is the same.
//
// Pure pixel math on top-down RGBA: no DOM, no WebGL, runs in node tests.

export const BLURMOVE = Object.freeze({
	cycle: 4, // frames per cycle (24 fps)
	on: 1, // mosaic frames at the start of each cycle
	mosaicCols: 96, // 96x54 on 16:9
	blurCols: 32, // 32x18 on 16:9
	blurSigma: 25, // gaussian sigma in px at `baseWidth`
	baseWidth: 1280, // the reference is rendered this wide
});

/** Output size for the reference: 1280 wide, the shot aspect, even height. */
export function blurmoveRefSize(aspectWidth, aspectHeight) {
	const width = BLURMOVE.baseWidth;
	const ratio = aspectWidth > 0 && aspectHeight > 0 ? aspectHeight / aspectWidth : 9 / 16;
	const height = Math.max(2, Math.round((width * ratio) / 2) * 2);
	return { width, height };
}

/** Grid rows for `cols` columns on a width x height frame (square cells). */
export function gridRows(cols, width, height) {
	return Math.max(1, Math.round((cols * height) / width));
}

/**
 * Index of `frame` inside its segment: segments start at each shot's first
 * frame (sorted), frames before the first start count from 0.
 */
export function segmentIndex(frame, segmentStarts = []) {
	let start = 0;
	for (const value of segmentStarts) {
		if (value <= frame && value >= start) start = value;
	}
	return frame - start;
}

/** True when `frame` is a mosaic frame (the rest are blur frames). */
export function isMosaicFrame(frame, segmentStarts = []) {
	return segmentIndex(frame, segmentStarts) % BLURMOVE.cycle < BLURMOVE.on;
}

// Box average of each grid cell (ffmpeg `scale=…:flags=area`), RGB floats.
function cellAverages(src, width, height, cols, rows) {
	const out = new Float32Array(cols * rows * 3);
	for (let r = 0; r < rows; r += 1) {
		const y0 = Math.floor((r * height) / rows);
		const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
		for (let c = 0; c < cols; c += 1) {
			const x0 = Math.floor((c * width) / cols);
			const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
			let sr = 0, sg = 0, sb = 0;
			for (let y = y0; y < y1; y += 1) {
				let i = (y * width + x0) * 4;
				for (let x = x0; x < x1; x += 1, i += 4) {
					sr += src[i];
					sg += src[i + 1];
					sb += src[i + 2];
				}
			}
			const n = (y1 - y0) * (x1 - x0);
			const o = (r * cols + c) * 3;
			out[o] = sr / n;
			out[o + 1] = sg / n;
			out[o + 2] = sb / n;
		}
	}
	return out;
}

/** Mosaic: cell averages drawn back as flat blocks (nearest upscale). */
export function mosaicRgba(src, width, height, cols, out = new Uint8ClampedArray(width * height * 4)) {
	const rows = gridRows(cols, width, height);
	const cells = cellAverages(src, width, height, cols, rows);
	const colOf = new Int32Array(width);
	for (let x = 0; x < width; x += 1) colOf[x] = Math.min(cols - 1, Math.floor((x * cols) / width));
	for (let y = 0; y < height; y += 1) {
		const rowBase = Math.min(rows - 1, Math.floor((y * rows) / height)) * cols;
		let i = y * width * 4;
		for (let x = 0; x < width; x += 1, i += 4) {
			const o = (rowBase + colOf[x]) * 3;
			out[i] = cells[o];
			out[i + 1] = cells[o + 1];
			out[i + 2] = cells[o + 2];
			out[i + 3] = 255;
		}
	}
	return out;
}

// Catmull-Rom weight.
function cubic(t) {
	const a = Math.abs(t);
	if (a <= 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
	if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
	return 0;
}

// Bicubic resample of an RGB float grid (cols x rows) to (w x h).
function bicubicUp(cells, cols, rows, w, h) {
	const out = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y += 1) {
		const fy = ((y + 0.5) * rows) / h - 0.5;
		const iy = Math.floor(fy);
		for (let x = 0; x < w; x += 1) {
			const fx = ((x + 0.5) * cols) / w - 0.5;
			const ix = Math.floor(fx);
			let r = 0, g = 0, b = 0, wsum = 0;
			for (let m = -1; m <= 2; m += 1) {
				const yy = Math.min(rows - 1, Math.max(0, iy + m));
				const wy = cubic(fy - (iy + m));
				for (let n = -1; n <= 2; n += 1) {
					const xx = Math.min(cols - 1, Math.max(0, ix + n));
					const wt = wy * cubic(fx - (ix + n));
					const o = (yy * cols + xx) * 3;
					r += cells[o] * wt;
					g += cells[o + 1] * wt;
					b += cells[o + 2] * wt;
					wsum += wt;
				}
			}
			const o = (y * w + x) * 3;
			out[o] = r / wsum;
			out[o + 1] = g / wsum;
			out[o + 2] = b / wsum;
		}
	}
	return out;
}

// Three box widths that together approximate a gaussian of `sigma`.
function boxesForGauss(sigma, n = 3) {
	const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
	let wl = Math.floor(wIdeal);
	if (wl % 2 === 0) wl -= 1;
	const wu = wl + 2;
	const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
	const m = Math.round(mIdeal);
	return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

// One horizontal + vertical box pass with clamped edges, in place.
function boxBlur(data, w, h, radius, tmp) {
	if (radius < 1) return;
	const span = radius * 2 + 1;
	for (let y = 0; y < h; y += 1) {
		for (let ch = 0; ch < 3; ch += 1) {
			let acc = 0;
			for (let k = -radius; k <= radius; k += 1) acc += data[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + ch];
			for (let x = 0; x < w; x += 1) {
				tmp[(y * w + x) * 3 + ch] = acc / span;
				const add = Math.min(w - 1, x + radius + 1);
				const sub = Math.max(0, x - radius);
				acc += data[(y * w + add) * 3 + ch] - data[(y * w + sub) * 3 + ch];
			}
		}
	}
	for (let x = 0; x < w; x += 1) {
		for (let ch = 0; ch < 3; ch += 1) {
			let acc = 0;
			for (let k = -radius; k <= radius; k += 1) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + ch];
			for (let y = 0; y < h; y += 1) {
				data[(y * w + x) * 3 + ch] = acc / span;
				const add = Math.min(h - 1, y + radius + 1);
				const sub = Math.max(0, y - radius);
				acc += tmp[(add * w + x) * 3 + ch] - tmp[(sub * w + x) * 3 + ch];
			}
		}
	}
}

// The blur is worked out on a 320-wide plate (the 32-cell grid is already
// far below that, so nothing is lost) and stretched to the output bilinearly.
const BLUR_PLATE_WIDTH = 320;

/**
 * Heavy smooth blur: cell averages (area), bicubic up, gaussian blur at the
 * reference's sigma, scaled to the output. No blocks survive.
 */
export function blurRgba(src, width, height, cols, sigmaAtBase, out = new Uint8ClampedArray(width * height * 4)) {
	const rows = gridRows(cols, width, height);
	const cells = cellAverages(src, width, height, cols, rows);
	const pw = Math.min(width, BLUR_PLATE_WIDTH);
	const ph = Math.max(1, Math.round((pw * height) / width));
	const plate = bicubicUp(cells, cols, rows, pw, ph);
	const sigma = (sigmaAtBase * pw) / BLURMOVE.baseWidth;
	const tmp = new Float32Array(plate.length);
	for (const box of boxesForGauss(sigma)) boxBlur(plate, pw, ph, (box - 1) / 2, tmp);
	for (let y = 0; y < height; y += 1) {
		const fy = Math.min(ph - 1, Math.max(0, ((y + 0.5) * ph) / height - 0.5));
		const y0 = Math.floor(fy), y1 = Math.min(ph - 1, y0 + 1), ty = fy - y0;
		let i = y * width * 4;
		for (let x = 0; x < width; x += 1, i += 4) {
			const fx = Math.min(pw - 1, Math.max(0, ((x + 0.5) * pw) / width - 0.5));
			const x0 = Math.floor(fx), x1 = Math.min(pw - 1, x0 + 1), tx = fx - x0;
			const a = (y0 * pw + x0) * 3, b = (y0 * pw + x1) * 3, c = (y1 * pw + x0) * 3, d = (y1 * pw + x1) * 3;
			for (let ch = 0; ch < 3; ch += 1) {
				const top = plate[a + ch] + (plate[b + ch] - plate[a + ch]) * tx;
				const bottom = plate[c + ch] + (plate[d + ch] - plate[c + ch]) * tx;
				out[i + ch] = top + (bottom - top) * ty;
			}
			out[i + 3] = 255;
		}
	}
	return out;
}

/**
 * A per-frame decorator for offscreen-export: `(frame, rgba) => rgba` turning
 * the previs frame into the reference frame. `segmentStarts` are the shots'
 * first frames on the exported timeline.
 */
export function createBlurmoveDecorator({ width, height, segmentStarts = [] }) {
	const starts = [...segmentStarts].filter(Number.isFinite).sort((a, b) => a - b);
	const out = new Uint8ClampedArray(width * height * 4);
	return (frame, rgba) => (isMosaicFrame(frame, starts)
		? mosaicRgba(rgba, width, height, BLURMOVE.mosaicCols, out)
		: blurRgba(rgba, width, height, BLURMOVE.blurCols, BLURMOVE.blurSigma, out));
}
