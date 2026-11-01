// A held camera for a whole take. frame_shot measures one pose, so a camera framed at the first frame answered "occluded: false"
// and then lost the character behind a wall for 4 of 6 sheet tiles (door kick scene, 2026-11-01). fitHeld frames every pose of the
// shot and turns the camera off the asked view only as far as the sightlines need; heldIssues says what any held camera misses.
// Pure over a compile result (compileSpec .out). Angles are degrees of azimuth: 0 looks from +z, 90 from +x.
import { blockersAt } from "./sightline.js";

const NEAR_DEG = 45, LENS_FACTORS = [1, 1.5, 2, 3], MIN_TAN_V = Math.tan((7.5 * Math.PI) / 180);
const CLEAR = 0.25, STEP = 3, MARGIN = 1.1, PAD = 0.12, HIDDEN_SHARE = 0.5, DEG = Math.PI / 180;
const jointsAt = (out, f) => out.frames?.[f - (out.f0 ?? 0)]?.s.P ?? [];
const dotOf = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * out with its joints where the stage draws them. A compile is in the world of take.placement; a character moved or turned since
 * carries its take along, and the scene's bodies stay. character: { x, y, z, rot (deg) }.
 */
export function placedOut(out, placement, character) {
	const from = placement?.position ?? [0, 0, 0], was = placement?.yaw ?? 0, to = [character.x ?? 0, character.y ?? 0, character.z ?? 0], yaw = character.rot ?? 0;
	if (Math.abs(was - yaw) < 1e-6 && from.every((v, i) => Math.abs(v - to[i]) < 1e-6)) return out;
	const a = (yaw - was) * DEG, c = Math.cos(a), n = Math.sin(a);
	const move = p => { const x = p[0] - from[0], y = p[1] - from[1], z = p[2] - from[2]; return [x * c + z * n + to[0], y + to[1], -x * n + z * c + to[2]]; };
	return { ...out, frames: out.frames.map(fr => ({ ...fr, s: { ...fr.s, P: fr.s.P.map(move) } })) };
}

/** The camera at azimuth deg on these points: their middle in view, far enough to hold them all at MARGIN and fill `fraction` of the height. */
function fitAt(points, deg, { tanV, aspect, fraction, levelShare }) {
	const back = [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)], right = [back[2], 0, -back[0]];
	const xs = points.map(p => dotOf(p, right)), ys = points.map(p => p[1]), zs = points.map(p => dotOf(p, back));
	const mid = v => (Math.min(...v) + Math.max(...v)) / 2, cx = mid(xs), cy = mid(ys), cz = mid(zs), height = Math.max(...ys) - Math.min(...ys);
	const need = points.map((_, i) => zs[i] - cz + MARGIN * Math.max((Math.abs(xs[i] - cx) + PAD) / (aspect * tanV), (Math.abs(ys[i] - cy) + PAD) / tanV));
	const distance = Math.max(height / (2 * fraction * tanV), ...need);
	const at = k => right[k] * cx + back[k] * cz;
	const lookAt = [at(0), cy, at(2)], eye = [lookAt[0] + back[0] * distance, Math.min(...ys) + height * levelShare, lookAt[2] + back[2] * distance];
	return { eye, lookAt };
}

/** What a camera that holds still misses: { hidden: [frames], outOfFrame: [frames] }, frames where a body hides most of the character or a joint leaves the picture. */
export function heldIssues(out, { eye, lookAt }, frames, { tanV, aspect }) {
	const f = [lookAt[0] - eye[0], lookAt[1] - eye[1], lookAt[2] - eye[2]], len = Math.hypot(...f) || 1, ahead = f.map(v => v / len);
	const flat = Math.hypot(ahead[0], ahead[2]) || 1, right = [-ahead[2] / flat, 0, ahead[0] / flat];
	const up = [right[1] * ahead[2] - right[2] * ahead[1], right[2] * ahead[0] - right[0] * ahead[2], right[0] * ahead[1] - right[1] * ahead[0]];
	const inside = p => {
		const rel = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]], depth = dotOf(rel, ahead);
		return depth > 0 && Math.abs(dotOf(rel, right)) <= depth * tanV * aspect && Math.abs(dotOf(rel, up)) <= depth * tanV;
	};
	return {
		hidden: frames.filter(frame => blockersAt(out, eye, frame).share >= HIDDEN_SHARE),
		outOfFrame: frames.filter(frame => jointsAt(out, frame).some(p => !inside(p))),
	};
}

/**
 * The held camera for frames. A wide lens stands close, where a doorway's wall cuts every sight line, so a view near the asked one (or
 * its mirror, profile from the other side) is tried from farther back on a longer lens first: same framing, flatter picture. Failing
 * that, every STEP degrees on the asked lens; a frame counts as blocked when a body hides CLEAR or more of the character, and the first
 * clear camera wins, else the one blocked least.
 * opts: { asked (deg), mirror (deg), tanV, aspect, fraction (of the picture's height the poses' height fills), levelShare, fixedLens }.
 * Answers { eye, lookAt, chosen (deg, -180..180), lensFactor (focal length multiple), hidden, outOfFrame }, or null with no poses.
 */
export function fitHeld(out, frames, opts) {
	const points = frames.flatMap(f => jointsAt(out, f));
	if (!points.length) return null;
	const score = cam => frames.reduce((sum, f) => { const { share } = blockersAt(out, cam.eye, f); return sum + (share >= CLEAR ? share : 0); }, 0);
	const wrap = d => ((((d + 180) % 360) + 360) % 360) - 180, off = d => Math.min(Math.abs(wrap(d - opts.asked)), Math.abs(wrap(d - (opts.mirror ?? opts.asked))));
	const around = Array.from({ length: 360 / STEP }, (_, k) => wrap(opts.asked + k * STEP)).sort((a, b) => off(a) - off(b) || Math.abs(wrap(a - opts.asked)) - Math.abs(wrap(b - opts.asked)));
	const near = around.filter(d => off(d) <= NEAR_DEG), factors = opts.fixedLens ? [1] : LENS_FACTORS.filter(k => opts.tanV / k >= MIN_TAN_V);
	const tries = [...factors.flatMap(lensFactor => near.map(chosen => ({ chosen, lensFactor }))), ...around.filter(d => off(d) > NEAR_DEG).map(chosen => ({ chosen, lensFactor: 1 }))];
	let best = null;
	for (const { chosen, lensFactor } of tries) {
		const cam = fitAt(points, chosen, { ...opts, tanV: opts.tanV / lensFactor }), hides = score(cam);
		if (!best || hides < best.hides) best = { ...cam, chosen, lensFactor, hides };
		if (hides === 0) break;
	}
	const { eye, lookAt, chosen, lensFactor } = best;
	return { eye, lookAt, chosen, lensFactor, ...heldIssues(out, { eye, lookAt }, frames, { ...opts, tanV: opts.tanV / lensFactor }) };
}
