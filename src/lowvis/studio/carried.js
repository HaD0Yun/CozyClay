// The drawn body part on a joint that carries an object (a ride of the engine), in that object's own frame: the solids
// of the look the Studio draws the bodies in (src/lowvis/looks/solids.js: each part of the look as drawn, taken off the
// look's own shape), at the body's scale about that joint as the clip turns it. Any joint, any look, any object: only
// geometry. A joint the look's solids leave out (the hands, whose drawn shape changes as they hold) has none, and so has
// every joint of a look that states no solids.
// Node and browser safe: no three.js (contacts.js tells it, gaps.js measures against it).
//   partSolids(look, joint)                 the solids of a joint by its name: [{ v, t }], v in metres from the joint at rest
//   posed(solids, c, joint, f)              their corners in the world on frame f of clip character c: [[[x, y, z]]]
//   drawnPart(solids, c, joint, frames, local)  { size, lo, hi, turn } of the part over those frames (local(f, x): a world
//                                           point in the object's frame on frame f; turn(f): the object's turn there)
import { LOOK_SOLIDS } from "../looks/solids.js";
import { INDEX as J, qConj, qMul, qRotate } from "../rig17.js";

const NJ = 17, cache = {};
const r2 = v => Math.round(v * 100) / 100;
const median = list => { const s = list.slice().sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };

/** The solids of joint `joint` (a rig joint name) in look `look` (none named: the block look, which the Studio then
 *  draws); [] for a look that states no solids: its parts are not known here, and another look's are not told for it. */
export function partSolids(look, joint) {
	const name = look || "block";
	return LOOK_SOLIDS[name] ? (cache[name] ??= LOOK_SOLIDS[name]()).filter(s => s.joint === J[joint]).map(({ v, t }) => ({ v, t })) : [];
}

/** The corners of each solid in the world on frame f, at clip character c's scale about its joint. */
export function posed(solids, c, joint, f) {
	const j = J[joint], s = c.scale ?? 1, at = c.pos.slice((f * NJ + j) * 3, (f * NJ + j) * 3 + 3), q = c.quat.slice((f * NJ + j) * 4, (f * NJ + j) * 4 + 4);
	return solids.map(({ v }) => v.map(p => { const w = qRotate(q, [p[0] * s, p[1] * s, p[2] * s]); return [at[0] + w[0], at[1] + w[1], at[2] + w[2]]; }));
}

/** The part over frames, in the object's frame: size [w, h, d] (its own, along the joint's axes at rest), lo and hi (the
 *  box its corners span along the object's axes, median over the frames) and turn (degrees between its axes and the
 *  object's, median); null when the look draws no part there. local(f, x): world point x in the object's frame on frame
 *  f; turnOf(f): the object's turn on frame f. */
export function drawnPart(solids, c, joint, frames, local, turnOf) {
	if (!solids.length || !frames.length) return null;
	const all = solids.flatMap(o => o.v), s = c.scale ?? 1, j = J[joint];
	const size = [0, 1, 2].map(k => r2((Math.max(...all.map(p => p[k])) - Math.min(...all.map(p => p[k]))) * s));
	const spans = frames.map(f => { const pts = posed(solids, c, joint, f).flat().map(x => local(f, x)); return [0, 1, 2].map(k => [Math.min(...pts.map(p => p[k])), Math.max(...pts.map(p => p[k]))]); });
	const turns = frames.map(f => { const q = qMul(qConj(turnOf(f)), c.quat.slice((f * NJ + j) * 4, (f * NJ + j) * 4 + 4)); return (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI; });
	return { size, lo: [0, 1, 2].map(k => r2(median(spans.map(x => x[k][0])))), hi: [0, 1, 2].map(k => r2(median(spans.map(x => x[k][1])))), turn: Math.round(median(turns)) };
}
