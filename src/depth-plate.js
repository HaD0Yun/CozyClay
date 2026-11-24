// The depth plate a shot hands on (the depth video, the depth still): which distances its greys cover, and how soft
// its edges are. The pass itself is drawn by render-passes.js.
import { DEPTH_RANGE_M, greyDistance, renderPass } from "./render-passes.js";

// How soft the edges of a depth plate are: the sigma of a gaussian in pixels of a 1080-high frame. A plate with hard
// steps tells whatever reads it that every edge of a blocking figure is exact; this lets them give a little.
export const DEPTH_SOFTEN_PX = 0.6;

/** Count one pre-pass frame's greys into `counts` (256 bins), every 16th pixel. */
function countDepthGreys(depth, counts = new Uint32Array(256)) {
	for (let index = 0; index < depth.length; index += 64) counts[depth[index]] += 1;
	return counts;
}

/** The near and far distance that hold the counted surface but for `clip` of it at each end, so a sliver beside the
 * lens or a speck at the horizon does not take the greys of everything else; then a twentieth of the span (as a ratio) is
 * given back at each end, so what was left out still steps and the farthest wall is not the sky. Bin 0 is sky, or past the far end. */
function depthRangeFromCounts(counts, near, far, curve, clip = 0.01) {
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

/** The range of a depth video: one pre-pass over its frames. `draw(frame)` answers that frame's depth pre-pass drawn
 * with `curve` from `near` to the stage's working depth; `after(frame)` is the caller's own step between two frames. */
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

/** One frame's depth plate, drawn as the depth video draws its frames: the range this frame's own surfaces cover, the
 * same curve, the same softness. `size` is the capture's { width, height }; `toDataUrl` encodes the RGBA read-back. */
export function depthStill(capture, camera, size, toDataUrl, curve = "log") {
	const first = renderPass(capture, capture.scene, camera, "depth", null, { depthCurve: curve });
	if (!first) return null;
	const depthRange = depthRangeFromCounts(countDepthGreys(first), camera.near, DEPTH_RANGE_M, curve);
	const soften = createDepthSoftener(size.width, size.height, (DEPTH_SOFTEN_PX * size.height) / 1080);
	return renderPass(capture, capture.scene, camera, "depth", (buffer) => toDataUrl(soften(0, buffer)), { depthRange, depthCurve: curve });
}
