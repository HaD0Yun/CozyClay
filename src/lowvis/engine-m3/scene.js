// Scene helpers of engine m3: the demos' props as motion3 scene records, and a carried prop's track read back from
// the hands of the finished clip.
import { INDEX, REST, TIPS, JOINT_COUNT, qRotate, qAxisAngle } from "../rig17.js";
import { addProp } from "../clip.js";

/** A demo prop ({ id, size: [w, h, d], at: centre }) as a motion3 scene record (base pivot = bottom centre). */
export const boxRecord = p => ({ id: p.id, name: p.id, renderer: "box", x: p.at[0], y: p.at[1] - p.size[1] / 2, z: p.at[2], footprint: { width: p.size[0], depth: p.size[2] }, height: p.size[1] });

const PALM = { l: ["LeftHand", TIPS.LeftHand], r: ["RightHand", TIPS.RightHand] };
/** The palm centre of a clip character's hand at frame f: halfway from the wrist to the fingertips. */
function palm(c, f, k) {
	const j = INDEX[PALM[k][0]], i = f * JOINT_COUNT + j, p = c.pos.subarray(i * 3, i * 3 + 3), q = Array.from(c.quat.subarray(i * 4, i * 4 + 4));
	const o = qRotate(q, PALM[k][1].map((v, n) => (v - REST[j][n]) * 0.5));
	return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}
/** Midpoint of the two palms and the heading of the line between them (the holder's left is +X at heading 0). */
function grip(c, f) {
	const l = palm(c, f, "l"), r = palm(c, f, "r");
	return { mid: l.map((v, i) => (v + r[i]) / 2), yaw: Math.atan2(-(l[2] - r[2]), l[0] - r[0]) };
}
const turn = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

/**
 * Adds prop `def` (demos.js) to the clip as an animated box that rides between the two palms of whoever holds it.
 * holds = [{ from, who }] in frame order: from each `from` frame the box keeps the place it had between that
 * character's palms on that frame (the first one takes it where it rests). release = { at, to, settle }: from frame
 * `at` it is let go and eases onto centre `to`, upright at `yaw` (radians), over `settle` frames.
 */
export function carriedProp(clip, def, holds, release) {
	const prop = addProp(clip, def.id, def.size, clip.frameCount), who = id => clip.characters.find(c => c.id === id);
	let pos = def.at.slice(), yaw = 0, hold = null, left = null;
	for (let f = 0; f < clip.frameCount; f++) {
		const next = holds.find(h => h.from === f);
		if (next && !(release && f >= release.at)) {
			const g = grip(who(next.who), f);
			hold = { c: who(next.who), off: turn(pos.map((v, i) => v - g.mid[i]), -g.yaw), dyaw: yaw - g.yaw };
		}
		if (release && f >= release.at) {
			left ??= { pos: pos.slice(), yaw };
			const t = Math.min(1, (f - release.at + 1) / release.settle), s = t * t * (3 - 2 * t);
			pos = left.pos.map((v, i) => v + (release.to[i] - v) * s);
			yaw = left.yaw + ((release.yaw ?? left.yaw) - left.yaw) * s;
		} else if (hold) {
			const g = grip(hold.c, f), o = turn(hold.off, g.yaw);
			pos = g.mid.map((v, i) => v + o[i]);
			yaw = g.yaw + hold.dyaw;
		}
		prop.pos.set(pos, f * 3);
		prop.quat.set(qAxisAngle([0, 1, 0], yaw), f * 4);
	}
	return prop;
}
