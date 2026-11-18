// A body of another size (the scene's `scale` of a character), by similarity: a figure of scale s in the world is the
// rig's own figure in a world 1 / s as large. So the body layer and the solver stay as they are: lengths go in divided
// by s and come out multiplied by s; angles, frames and flags pass through. At scale 1 they are called as they are.
import { BODY, buildBody } from "./spec-layers.js";
import { arc, solve } from "./solve.js";

const by = (v, k) => v && v.map(x => x * k);
/** A body state B (solve.js) with its lengths multiplied by k. */
const sizedB = (B, k) => ({ ...B, p: by(B.p, k), feet: B.feet.map(f => ({ ...f, a: by(f.a, k), ...(f.floor == null ? {} : { floor: f.floor * k }) })), hands: B.hands.map(h => by(h, k)) });
/** The options of a body-layer action with their lengths multiplied by k: to, at, the end foot offsets, a seat height. */
const sizedOptions = (o, k) => ({
	...o, ...(Array.isArray(o.to) ? { to: by(o.to, k) } : {}), ...(Array.isArray(o.at) ? { at: by(o.at, k) } : {}), ...(Number.isFinite(o.height) ? { height: o.height * k } : {}),
	...(o.end ? { end: Object.fromEntries(Object.entries(o.end).map(([side, v]) => [side, by(v, k)])) } : {}),
});

/** buildBody (spec-layers.js) for a character of scale s: the frames of its body layer, in world metres. */
export function buildBodySized(c, acts, F, ctx, s = 1) {
	if (s === 1) return buildBody(c, acts, F, ctx);
	const k = 1 / s, props = Object.fromEntries(Object.entries(ctx.props).map(([id, p]) => [id, { ...p, c: by(p.c, k), size: by(p.size, k) }]));
	const unit = acts.map(a => (BODY.has(a[1]) && a[2] ? [a[0], a[1], sizedOptions(a[2], k)] : a));
	const note = ctx.note && (e => ctx.note({ ...e, off: e.off * s }));
	const walked = ctx.walked && (e => ctx.walked({ ...e, to: by(e.to, s), distance: e.distance * s, step: e.step * s, stepWalked: e.stepWalked * s, longest: e.longest * s, far: e.far && e.far * s, reach: e.reach * s, split: e.split && { ...e.split, step: e.split.step * s, far: e.split.far * s }, as: e.as && { ...e.as, under: e.as.under && e.as.under * s } }));
	return buildBody({ ...c, at: by(c.at, k) }, unit, F, { props, ground: (x, z) => ctx.ground(x * s, z * s) * k, note, walked }).map(B => sizedB(B, s));
}

/** solve (solve.js) for a body of scale s: B, the points of U and the result are in world metres. */
export function solveSized(B, U = {}, s = 1) {
	if (s === 1) return solve(B, U);
	const k = 1 / s, hands = U.hands?.map(h => h && { ...h, from: by(h.from, k), to: by(h.to, k), prev: by(h.prev, k), offset: by(h.offset, k), ...(h.elbow ? { elbow: { ...h.elbow, from: by(h.elbow.from, k), to: by(h.elbow.to, k) } } : {}) });
	const r = solve(sizedB(B, k), { ...U, hip: by(U.hip, k), hands, assist: U.assist && { ...U.assist, drop: U.assist.drop * k } });
	return { ...r, pos: r.pos.map(p => by(p, s)), assist: { ...r.assist, drop: r.assist.drop * s }, lift: by(r.lift, s), slow: by(r.slow, s), late: by(r.late, s) };
}

/** arc (solve.js) for a limb of a body of scale s. */
export const arcSized = (a, b, w, sh, s = 1) => (s === 1 ? arc(a, b, w, sh) : by(arc(by(a, 1 / s), by(b, 1 / s), w, by(sh, 1 / s)), s));
