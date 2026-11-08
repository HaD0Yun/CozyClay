// v4 render cameras (design 3.4). Pure over Out (the frames the track store builds).
// A camera has the shape src/motion3/views.js returns: { name, eye, target, quaternion, fovDeg,
// aspect, right, up, back, tanV, tanH }, looking along -back, fovDeg vertical, quaternion from
// the columns right, up, back (three.js). projectPoint (views.js) works on it.
import { add, sub, scale, dot, cross, len, norm, quatFromMat } from "../../motion3/compiler/math.js";
import { solePoints, sdBox, boxNormal } from "../../motion3/qa/geometry.js";

const UP = [0, 1, 0];
// The bench judge renderer (test/bench/physics/blender/render.py on the bench branch): 35 mm lens,
// 36 mm sensor width, the box padded 0.25 m, the camera 1.08 times as far as the tightest fit.
const LENS = 35, SENSOR = 36, PAD = 0.25, MARGIN = 1.08;
// Blender (x, y, z) -> set (x, z, -y): side (1, 0, 0.12) and front (0.7, -0.7, 0.25).
const JUDGE = { side: [1, 0.12, 0], front: [0.7, 0.25, 0.7] };
const SMOOTH = 6, RAISE = 25;
const rad = d => (d * Math.PI) / 180;
const deg = r => (r * 180) / Math.PI;
const mean = ps => scale(ps.reduce(add, [0, 0, 0]), 1 / Math.max(1, ps.length));
const clampFrame = (out, f) => Math.max(0, Math.min(out.frames.length - 1, Math.round(f)));
const boxesAt = (out, f) => Object.entries(out.objectsAt?.(f) ?? {}).filter(([, b]) => b?.half && !b.ignore);
const corners = b => [-1, 1].flatMap(x => [0, 2].flatMap(y => [-1, 1].map(z => add(b.pos, [0, 1, 2].map(i => b.R[i][0] * x * b.half[0] + b.R[i][1] * y * b.half[1] + b.R[i][2] * z * b.half[2])))));

function camera(name, eye, target, { right, up, back }, tanV, aspect) {
	const quaternion = quatFromMat([0, 1, 2].map(i => [right[i], up[i], back[i]]));
	return { name, eye, target, quaternion, fovDeg: deg(2 * Math.atan(tanV)), aspect, right, up, back, tanV, tanH: tanV * aspect };
}

/** A camera at eye looking at target, image up toward `up` (straight down or up: +Z is image up). */
export function lookAt(eye, target, up = UP, { name = "custom", fovDeg = 40, aspect = 1 } = {}) {
	const back = norm(sub(eye, target));
	if (len(back) < 0.5) throw new Error("A camera needs its eye apart from its target.");
	let right = cross(up, back);
	if (len(right) < 1e-6) right = cross([0, 0, 1], back);
	right = norm(right);
	return camera(name, eye.slice(), target.slice(), { right, up: cross(back, right), back }, Math.tan(rad(fovDeg / 2)), aspect);
}

/** The character's horizontal left at frame f (the hip line), or over every frame when f is null. */
function leftOf(out, f = null) {
	const I = out.ctx.sk.index, frames = f === null ? out.frames : [out.frames[clampFrame(out, f)]];
	let v = [0, 0, 0];
	for (const fr of frames) { const d = sub(fr.s.P[I.LeftUpLeg], fr.s.P[I.RightUpLeg]); v = add(v, [d[0], 0, d[2]]); }
	return len(v) > 1e-6 ? norm(v) : [1, 0, 0];
}

/**
 * The judge pair: one fixed camera per view (side, front) for the whole take, placed like the bench
 * renderer's place(). The box holds every joint on every 2nd frame (and the last), the scene boxes on
 * those frames and `position` (the character's), padded 0.25 m. Answers [side, front].
 */
export function judgeCameras(out, { aspect = 16 / 9, position = null } = {}) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	const grow = p => p && p.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
	const n = out.frames.length, frames = [];
	for (let f = 0; f < n; f += 2) frames.push(f);
	if (n > 1 && frames.at(-1) !== n - 1) frames.push(n - 1);
	for (const f of frames) {
		out.frames[f].s.P.forEach(grow);
		for (const [, b] of boxesAt(out, f)) corners(b).forEach(grow);
	}
	grow(position);
	if (!Number.isFinite(lo[0])) throw new Error("judgeCameras: the take has no joints.");
	const box = [lo.map(v => v - PAD), hi.map(v => v + PAD)];
	const points = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [box[x][0], box[y][1], box[z][2]])));
	const center = mean(points), tanH = SENSOR / 2 / LENS, tanV = tanH / aspect;
	return Object.entries(JUDGE).map(([name, dir]) => {
		const back = norm(dir), right = norm(cross(UP, back)), up = cross(back, right);
		let need = 0;
		for (const p of points) {
			const r = sub(p, center), depth = dot(r, back);
			need = Math.max(need, depth + Math.abs(dot(r, right)) / tanH, depth + Math.abs(dot(r, up)) / tanV);
		}
		return camera(name, add(center, scale(back, need * MARGIN)), center, { right, up, back }, tanV, aspect);
	});
}

/** The hips at every frame, each the mean over +-6 frames (fewer at the ends). */
function smoothHips(out) {
	const I = out.ctx.sk.index, hips = out.frames.map(fr => fr.s.P[I.Hips]), n = hips.length;
	return hips.map((_, f) => mean(hips.slice(Math.max(0, f - SMOOTH), Math.min(n, f + SMOOTH + 1))));
}

/**
 * One camera per frame of `frames` that follows the smoothed hips from the body's left (or right):
 * eye = smoothed hips + distance along the side + height up, the side fixed over the whole take so
 * the offset never changes. The vertical fov is a 35 mm lens at this aspect (32.3 degrees at 16:9).
 */
export function trackingCameras(out, frames, { distance = 4, height = 0.3, side = "left", aspect = 16 / 9 } = {}) {
	const smooth = smoothHips(out), left = leftOf(out), offset = add(scale(left, side === "right" ? -distance : distance), [0, height, 0]);
	const fovDeg = deg(2 * Math.atan(SENSOR / 2 / LENS / aspect));
	return frames.map(f => { const t = smooth[clampFrame(out, f)]; return lookAt(add(t, offset), t, UP, { name: "track", fovDeg, aspect }); });
}

const ENDS = { hand_l: ["Left", "hand"], hand_r: ["Right", "hand"], foot_l: ["Left", "foot"], foot_r: ["Right", "foot"] };

/** Outward normal of the nearest surface to p at frame f: the floor (+Y) or a scene box. */
function surfaceNormal(out, f, p) {
	let best = p[1], normal = UP;
	for (const [, b] of boxesAt(out, f)) { const d = sdBox(p, b); if (d < best) { best = d; normal = boxNormal(p, b); } }
	return normal;
}

/**
 * A square close-up of one end at frame f: target the palm centre (hand) or the ball of the foot,
 * eye `distance` away on the limb's outer side turned toward the contact surface's normal, raised
 * 25 degrees. end: hand_l, hand_r, foot_l, foot_r.
 */
export function closeUpCamera(out, f, end, { distance = 0.8, fovDeg = 30 } = {}) {
	const spec = ENDS[end];
	if (!spec) throw new Error(`closeUpCamera: end must be one of ${Object.keys(ENDS).join(", ")}; got ${end}.`);
	const [S, kind] = spec, sk = out.ctx.sk, I = sk.index, g = clampFrame(out, f), s = out.frames[g].s;
	const target = kind === "hand" ? scale(add(s.P[I[`${S}Hand`]], s.P[I[`${S}HandMiddle1`]]), 0.5) : solePoints(sk, s, S).ball;
	const n = surfaceNormal(out, g, target), outward = scale(leftOf(out, g), S === "Left" ? 1 : -1);
	let d = norm(add(outward, [n[0], 0, n[2]]));
	if (len(d) < 1e-6) d = outward;
	const dir = add(scale(d, Math.cos(rad(RAISE))), scale(UP, Math.sin(rad(RAISE))));
	return lookAt(add(target, scale(dir, distance)), target, UP, { name: end, fovDeg, aspect: 1 });
}
