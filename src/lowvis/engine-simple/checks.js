// Self-checks measured from a finished (parsed) clip. `aux` is buildClip's per-frame flags: which feet the engine
// calls planted and who holds each prop. Positions and rotations come from the clip only.
import { INDEX as J, JOINT_COUNT } from "../rig17.js";
import { qConj, qRotate } from "./math.js";
import { SOLE, TOE } from "./solve.js";

const FEET = [J.LeftFoot, J.RightFoot], HANDS = [J.LeftHand, J.RightHand];

export function checkClip(clip, aux) {
	const F = clip.frameCount, r = { slide: 0, slideStep: 0, footLow: Infinity, jointLow: Infinity, carryMin: null, carryMax: null, carryFrames: 0 };
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const contact = (c, f, j) => [TOE, SOLE].map(o => { const a = at(c, f, j), d = qRotate(rot(c, f, j), o); return [a[0] + d[0], a[1] + d[1], a[2] + d[2]]; });
	for (const c of clip.characters) {
		for (let f = 0; f < F; f++) for (let j = 0; j < JOINT_COUNT; j++) r.jointLow = Math.min(r.jointLow, c.pos[(f * JOINT_COUNT + j) * 3 + 1]);
		FEET.forEach((j, side) => {
			let sum = 0, prev = null;
			for (let f = 0; f < F; f++) {
				const pts = contact(c, f, j);
				r.footLow = Math.min(r.footLow, pts[0][1], pts[1][1]);
				if (!aux.contacts[c.id][f][side]) { sum = 0; prev = null; continue; }
				// a planted foot may roll on its toe or its heel: the slide of a frame is the smaller of the two moves
				if (prev) { const step = Math.min(...pts.map((p, k) => Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1], p[2] - prev[k][2]))); sum += step; r.slideStep = Math.max(r.slideStep, step); r.slide = Math.max(r.slide, sum); }
				prev = pts;
			}
		});
	}
	for (const p of clip.props) {
		if (p.pos.length === 3) continue;
		for (let f = 0; f < F; f++) {
			const c = clip.characters.find(ch => ch.id === aux.holders[p.id][f]);
			if (!c) continue;
			r.carryFrames++;
			const centre = p.pos.slice(f * 3, f * 3 + 3), q = qConj(p.quat.slice(f * 4, f * 4 + 4));
			for (const j of HANDS) { // signed distance from the wrist joint to the box surface (negative = inside)
				const h = at(c, f, j), l = qRotate(q, [h[0] - centre[0], h[1] - centre[1], h[2] - centre[2]]).map((v, k) => Math.abs(v) - p.size[k] / 2);
				const d = Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l));
				r.carryMin = Math.min(r.carryMin ?? d, d); r.carryMax = Math.max(r.carryMax ?? d, d);
			}
		}
	}
	return r;
}
