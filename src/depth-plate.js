// The depth plate a shot hands on (the depth video, the depth still): which distances its greys cover, how the relief
// of a surface is kept, and how soft its edges are. The pass itself is drawn by render-passes.js.
//
// The stage knows every distance exactly, and a plate has 256 greys for a body two metres from the lens and a horizon
// forty metres away. Written straight into 8 bits, a body 30 cm deep at four metres gets five greys. So the pass is read
// back at half-float precision (PLATE_PASS: the nearness of every pixel by distance ratio, 0 sky to 1 at the lens), and
// the greys are made here: shared out by ratio and by where the shot's surfaces stand, with each surface's own relief
// drawn larger than the tone curve alone would draw it. A renderer that cannot read half floats back (capture.precise
// is false) gets the same share-out by ratio drawn straight into 8 bits, without the relief.
import { DEPTH_RANGE_M, greyDistance, renderPass } from "./render-passes.js";

// How soft the edges of a depth plate are: the sigma of a gaussian in pixels of a 1080-high frame. A plate with hard
// steps tells whatever reads it that every edge of a blocking figure is exact; this lets them give a little.
export const DEPTH_SOFTEN_PX = 0.6;
/** The pass a plate is made from (renderPass options). */
export const PLATE_PASS = Object.freeze({ depthCurve: "ratio", precise: true });

const BINS = 1024, CLIP = 0.01, SURVEYED = 120;
// TONE_BY_SURFACE: the share of the greys that goes by where the shot's surfaces stand (the rest goes evenly by ratio).
// RELIEF: how many times its size in the tone curve a surface's own relief is added on top. RELIEF_REACH: how far apart
// (as a share of the ratio span) two pixels may stand and still be one surface. RELIEF_SPAN: the neighbourhood a
// surface's level is read from, as a share of the frame height.
const TONE_BY_SURFACE = 0.5, RELIEF = 3, RELIEF_REACH = 0.02, RELIEF_SPAN = 0.045, STEP = 4;

let halves = null;
/** Every half float as a number, by its 16 bits. */
function halfFloats() {
	if (halves) return halves;
	halves = new Float32Array(65536);
	for (let bits = 0; bits < 65536; bits += 1) {
		const exponent = (bits >> 10) & 31, mantissa = bits & 1023, sign = bits & 32768 ? -1 : 1;
		halves[bits] = exponent === 0 ? sign * 2 ** -14 * (mantissa / 1024) : exponent === 31 ? 0 : sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
	}
	return halves;
}

/** Count one pre-pass frame's greys into `counts` (256 bins), every 16th pixel. */
function countDepthGreys(depth, counts = new Uint32Array(256)) {
	for (let index = 0; index < depth.length; index += 64) counts[depth[index]] += 1;
	return counts;
}

/** The near and far distance that hold the counted surface but for `clip` of it at each end, so a sliver beside the
 * lens or a speck at the horizon does not take the greys of everything else; then a twentieth of the span (as a ratio) is
 * given back at each end, so what was left out still steps and the farthest wall is not the sky. Bin 0 is sky, or past the far end. */
function depthRangeFromCounts(counts, near, far, curve, clip = CLIP) {
	let total = 0;
	for (let grey = 1; grey < 256; grey += 1) total += counts[grey];
	if (!total) return { near, far };
	let low = 1, high = 255;
	for (let seen = counts[low]; seen < total * clip && low < 255;) seen += counts[low += 1];
	for (let seen = counts[high]; seen < total * clip && high > 1;) seen += counts[high -= 1];
	const nearest = Math.max(near, greyDistance(high + 0.5, near, far, curve)), farthest = Math.max(greyDistance(low - 0.5, near, far, curve), nearest * 1.01);
	const give = (farthest / nearest) ** 0.05;
	return { near: Math.max(near, nearest / give), far: farthest * give };
}

/** The range of a depth video drawn with one curve straight into 8 bits ("linear", "inverse"): one pre-pass over its
 * frames. `draw(frame)` answers that frame's pre-pass from `near` to the stage's working depth; `after(frame)` is the
 * caller's own step between two frames. */
export async function depthRangeOverFrames(startFrame, endFrame, near, curve, draw, after = null) {
	const counts = new Uint32Array(256);
	for (let frame = startFrame; frame <= endFrame; frame += 1) {
		countDepthGreys(draw(frame), counts);
		await after?.(frame);
	}
	return depthRangeFromCounts(counts, near, DEPTH_RANGE_M, curve);
}

/** A per-frame decorator for offscreen-export: `(frame, rgba) => rgba`, the grey under a gaussian of `sigma` pixels. */
export function createDepthSoftener(width, height, sigma) {
	const radius = Math.max(1, Math.ceil(sigma * 3)), count = width * height;
	const kernel = Float32Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
	const sum = kernel.reduce((total, weight) => total + weight, 0);
	const a = new Float32Array(count), b = new Float32Array(count), out = new Uint8ClampedArray(count * 4);
	const pass = (from, to, n, step, lines, lineStep) => {
		for (let line = 0; line < lines; line += 1) {
			const base = line * lineStep;
			for (let i = 0; i < n; i += 1) {
				let acc = 0;
				for (let k = -radius; k <= radius; k += 1) acc += kernel[k + radius] * from[base + Math.min(n - 1, Math.max(0, i + k)) * step];
				to[base + i * step] = acc / sum;
			}
		}
	};
	return (frame, rgba) => {
		for (let i = 0; i < count; i += 1) a[i] = rgba[i * 4];
		pass(a, b, width, 1, height, width);
		pass(b, a, height, width, width, 1);
		for (let i = 0; i < count; i += 1) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = a[i]; out[i * 4 + 3] = 255; }
		return out;
	};
}

/** The plate maker of one shot. survey(half) counts a pre-pass frame (the half-float read-back of PLATE_PASS), settle()
 * makes the shot's tone curve from the counts, bytes(half) answers a frame's plate as RGBA bytes in the read-back's row order. */
function createDepthPlate(width, height) {
	const count = width * height, table = halfFloats(), counts = new Float64Array(BINS), tone = Float32Array.from({ length: BINS + 1 }, (_, i) => i / BINS);
	const lw = Math.ceil(width / STEP), lh = Math.ceil(height / STEP), low = new Float32Array(lw * lh), across = new Float32Array(lw * lh), level = new Float32Array(lw * lh), inside = new Uint8Array(lw * lh);
	const near = new Float32Array(count), grey = new Uint8ClampedArray(count * 4), soften = createDepthSoftener(width, height, (DEPTH_SOFTEN_PX * height) / 1080);
	const radius = Math.max(2, Math.round((RELIEF_SPAN * height) / STEP / 2)), beside = Float32Array.from({ length: radius + 1 }, (_, k) => Math.exp(-(k * k) / (2 * (radius / 2) ** 2)));
	// how much two pixels a given step of nearness apart are one surface: a table over 0 .. 4 reaches
	const same = Float32Array.from({ length: 257 }, (_, i) => (i === 256 ? 0 : Math.exp(-((i / 64) ** 2) / 2))), alike = (a, b) => same[Math.min(256, Math.round((Math.abs(a - b) / RELIEF_REACH) * 64))];
	let span = 1;
	// A surface's relief at each sample: its nearness less the level around it, the level read only from samples of the
	// same surface (one pass across, one down). A sample on an edge is a mix of two surfaces (the pass is anti-aliased)
	// and stands for neither: it is left out. Samples are taken in pairs, one on each side, or not at all: a slope then
	// averages to its own centre, beside an edge and at the frame's border too, and has no relief.
	const levels = () => {
		for (let y = 0; y < lh; y += 1) {
			for (let x = 0; x < lw; x += 1) {
				const at = Math.min(height - 2, y * STEP + 2) * width + Math.min(width - 2, x * STEP + 2), t = near[at];
				low[y * lw + x] = t;
				inside[y * lw + x] = Math.abs(near[at + 1] - t) < RELIEF_REACH && Math.abs(near[at + width] - t) < RELIEF_REACH && Math.abs(near[Math.max(0, at - 1)] - t) < RELIEF_REACH && Math.abs(near[Math.max(0, at - width)] - t) < RELIEF_REACH ? 1 : 0;
			}
		}
		for (const [from, to, n, step, lines, lineStep] of [[low, across, lw, 1, lh, lw], [across, level, lh, lw, lw, 1]]) {
			for (let line = 0; line < lines; line += 1) {
				for (let i = 0; i < n; i += 1) {
					const at = line * lineStep + i * step, centre = low[at], reach = Math.min(radius, i, n - 1 - i);
					let acc = from[at], weights = 1;
					for (let k = 1; k <= reach; k += 1) {
						const a = at - k * step, b = at + k * step, weight = beside[k] * Math.min(inside[a] * alike(low[a], centre), inside[b] * alike(low[b], centre));
						acc += weight * (from[a] + from[b]);
						weights += 2 * weight;
					}
					to[at] = acc / weights;
				}
			}
		}
		for (let i = 0; i < level.length; i += 1) level[i] = low[i] - level[i];
	};
	return {
		survey(half) {
			for (let i = 0; i < half.length; i += 64) { const t = table[half[i]]; if (t > 0) counts[Math.min(BINS - 1, Math.floor(t * BINS))] += 1; }
		},
		settle() {
			let total = 0, first = 0, last = BINS - 1;
			for (const n of counts) total += n;
			if (!total) return;
			for (let seen = counts[first]; seen < total * CLIP && first < BINS - 1;) seen += counts[first += 1];
			for (let seen = counts[last]; seen < total * CLIP && last > 0;) seen += counts[last -= 1];
			const give = (last + 1 - first) * 0.05, from = Math.max(0, first - give), to = Math.min(BINS, last + 1 + give);
			span = (to - from) / BINS;
			for (let i = 0, seen = 0; i <= BINS; seen += counts[i] ?? 0, i += 1) tone[i] = (1 - TONE_BY_SURFACE) * Math.min(1, Math.max(0, (i - from) / (to - from))) + TONE_BY_SURFACE * (seen / total);
		},
		bytes(half) {
			for (let i = 0; i < count; i += 1) near[i] = table[half[i * 4]];
			levels();
			for (let y = 0; y < height; y += 1) {
				const fy = Math.min(lh - 1, Math.max(0, (y - 2) / STEP)), y0 = Math.min(lh - 2, Math.floor(fy)), ty = fy - y0;
				for (let x = 0; x < width; x += 1) {
					const at = y * width + x, t = near[at];
					let value = 0;
					if (t > 0) {
						const fx = Math.min(lw - 1, Math.max(0, (x - 2) / STEP)), x0 = Math.min(lw - 2, Math.floor(fx)), tx = fx - x0, corner = y0 * lw + x0;
						const w00 = inside[corner] * (1 - tx) * (1 - ty) * alike(low[corner], t), w10 = inside[corner + 1] * tx * (1 - ty) * alike(low[corner + 1], t);
						const w01 = inside[corner + lw] * (1 - tx) * ty * alike(low[corner + lw], t), w11 = inside[corner + lw + 1] * tx * ty * alike(low[corner + lw + 1], t), weights = w00 + w10 + w01 + w11;
						const relief = weights > 1e-4 ? (w00 * level[corner] + w10 * level[corner + 1] + w01 * level[corner + lw] + w11 * level[corner + lw + 1]) / weights : 0;
						const bin = Math.min(BINS - 1e-3, t * BINS), edge = Math.floor(bin), curve = tone[edge] + (tone[edge + 1] - tone[edge]) * (bin - edge);
						// a pixel on an edge is a mix of two surfaces: it has no relief of its own
						const within = (other) => Math.abs(near[other] - t) < RELIEF_REACH;
						const whole = within(x > 0 ? at - 1 : at) && within(x < width - 1 ? at + 1 : at) && within(y > 0 ? at - width : at) && within(y < height - 1 ? at + width : at);
						value = curve + (whole ? (RELIEF * relief) / span : 0);
					}
					grey[at * 4] = value * 255;
				}
			}
			return new Uint8Array(soften(0, grey).buffer);
		},
	};
}

/** A shot's plate maker with its tone curve made: one pre-pass over the frames (about SURVEYED of them, evenly
 * spread, the last one always: where the surfaces of a shot stand does not need every frame). `draw(frame)` answers
 * that frame's PLATE_PASS read-back; `after(frame)` is the caller's own step between two frames. */
export async function surveyedDepthPlate(size, startFrame, endFrame, draw, after = null) {
	const plate = createDepthPlate(size.width, size.height), stride = Math.max(1, Math.ceil((endFrame - startFrame + 1) / SURVEYED));
	for (let frame = startFrame; frame <= endFrame; frame = frame < endFrame ? Math.min(endFrame, frame + stride) : frame + 1) {
		plate.survey(draw(frame));
		await after?.(frame);
	}
	plate.settle();
	return plate;
}

/** One frame's depth plate, made as the depth video makes its frames, from this frame's own surfaces. `size` is the
 * capture's { width, height }; `toDataUrl` encodes the RGBA bytes. */
export function depthStill(capture, camera, size, toDataUrl) {
	if (!capture.precise) {
		const first = renderPass(capture, capture.scene, camera, "depth", null, { depthCurve: "log" });
		if (!first) return null;
		const depthRange = depthRangeFromCounts(countDepthGreys(first), camera.near, DEPTH_RANGE_M, "log");
		const soften = createDepthSoftener(size.width, size.height, (DEPTH_SOFTEN_PX * size.height) / 1080);
		return renderPass(capture, capture.scene, camera, "depth", (buffer) => toDataUrl(soften(0, buffer)), { depthRange, depthCurve: "log" });
	}
	const half = renderPass(capture, capture.scene, camera, "depth", null, PLATE_PASS);
	if (!half) return null;
	const plate = createDepthPlate(size.width, size.height);
	plate.survey(half);
	plate.settle();
	return toDataUrl(plate.bytes(half));
}
