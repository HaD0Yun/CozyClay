// A body on a prop that moves: a body-layer action with `on: propId` (any verb) is done on that prop and goes with it.
// The body layer works such an action out against the prop as the scene places it (as a sit or a lie on a prop always
// has), so its places (`to`, the seat, where it lies) and headings are the prop's as it stands in the scene, and each
// frame is then carried to where the prop is on that frame: turned and moved as the prop is turned and moved from its
// scene place. Where the body gets on or off, the state between two actions is carried over by the level part of that
// move (a turn about the vertical and a move over the floor, which the body layer's state can hold), so the body goes on
// from where it is; what the level part leaves out (the prop has risen, sunk or tipped by then) is the rest of the
// getting on or off: the body has all of it on that frame and none BLEND frames later, so it never jumps there.
// The prop's place on each frame comes from a first build of the clip (the props' tracks, carriedBuild); the body
// then follows it on every frame of the second.
import { add, mul, qConj, qMul, qRotate, qSlerp, qY, sub } from "./math.js";

/** Frames the rest of a getting on or off takes to go (half a second). */
const BLEND = 12;
// A rigid move { q, t }: x -> q x + t.
const ID = { q: [0, 0, 0, 1], t: [0, 0, 0] };
const apply = (T, x) => add(qRotate(T.q, x), T.t);
const then = (A, B) => ({ q: qMul(A.q, B.q), t: apply(A, B.t) }); // x -> A(B(x))
const inverse = T => { const q = qConj(T.q); return { q, t: qRotate(q, mul(T.t, -1)) }; };
const yawOf = q => { const z = qRotate(q, [0, 0, 1]); return Math.atan2(z[0], z[2]); };

/** carrier ({ scene(id), at(id, f) } -> { c, q }): the move of prop id on frame f from its scene place, none for the world (null). */
function motionAt(carrier, id, f) {
	if (id == null) return ID;
	const scene = carrier.scene(id), at = carrier.at(id, f), q = qMul(at.q, qConj(scene.q));
	return { q, t: sub(at.c, qRotate(q, scene.c)) };
}
/** What is left on frame f of the rest of a getting on or off (rest: { q, d, f0 }: at f0 a turn q about the floor point
 *  under the body and a move d), about floor point a. */
function restAt(rest, f, a) {
	const u = rest ? Math.min(1, (f - rest.f0) / BLEND) : 1, w = 1 - u * u * (3 - 2 * u);
	if (!(w > 0)) return ID;
	const q = qSlerp([0, 0, 0, 1], rest.q, w);
	return { q, t: add(sub(a, qRotate(q, a)), mul(rest.d, w)) };
}
/** Where the body layer's frame of a body on prop `on` (null: the world) is in the world on frame f: a floor point under the body. */
const worldOf = (carrier, on, rest, f, a) => (on == null && !rest ? ID : then(motionAt(carrier, on, f), restAt(rest, f, a)));

/** Body state B (solve.js) moved by T; the floor under each foot moves with it. */
function moveB(B, T) {
	if (T === ID) return B;
	return {
		...B, p: apply(T, B.p), q: qMul(T.q, B.q), yaw: B.yaw + yawOf(T.q),
		feet: B.feet.map(ft => ({ ...ft, a: apply(T, ft.a), q: qMul(T.q, ft.q), floor: apply(T, [ft.a[0], ft.floor ?? 0, ft.a[2]])[1] })),
	};
}

/** The body layer's state between actions (gait.js: p and feet g are [x, z] on the floor) as the body goes from being
 *  on prop `from` to being on prop `to` (null: the world) on frame f; rest: what is left of an earlier getting on or
 *  off. -> { st, rest }: the state in the new frame, moved by the level part of the move between the two at the body,
 *  and the rest of that move ({ q, d, f0 }, null when there is none), which the body's frames give back over BLEND frames. */
export function carryState(st, carrier, from, to, f, rest) {
	const a = [st.p[0], 0, st.p[1]], M = then(inverse(motionAt(carrier, to, f)), worldOf(carrier, from, rest, f, a));
	const turn = yawOf(M.q), at = apply(M, a), q = qY(turn), level = { q, t: sub([at[0], 0, at[2]], qRotate(q, a)) };
	const flat = g => { const p = apply(level, [g[0], 0, g[1]]); return [p[0], p[2]]; }, tilt = qMul(M.q, qConj(q));
	const none = Math.abs(at[1]) < 1e-9 && Math.hypot(tilt[0], tilt[1], tilt[2]) < 1e-9;
	return {
		st: { ...st, p: flat(st.p), yaw: st.yaw + turn, feet: st.feet.map(ft => ({ ...ft, g: flat(ft.g), yaw: ft.yaw + turn })), ...(st.lastB ? { lastB: moveB(st.lastB, level) } : {}) },
		rest: none ? null : { q: tilt, d: [0, at[1], 0], f0: f },
	};
}

/** The body layer's frames (out[f].on: the prop whose frame it is in, else the world; out[f].rest: carryState's) carried to the world. */
export const carriedFrames = (out, carrier) => out.map((B, f) => moveB(B, worldOf(carrier, B.on, B.rest, f, [B.p[0], 0, B.p[2]])));

/** carrier of the props ids (a Set) from a built clip (clip.js): each one's scene place (def.props) and its place on a
 *  frame, from its track. */
function carrierOf(clip, def, ids) {
	const tracks = new Map(clip.props.filter(p => ids.has(p.id)).map(p => [p.id, p])), scene = new Map(def.props.map(p => [p.id, { c: p.at.slice(), q: qY((p.turn ?? 0) * Math.PI / 180) }]));
	return {
		ids, scene: id => scene.get(id),
		at: (id, f) => { const p = tracks.get(id), k = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.subarray(k * 3, k * 3 + 3)), q: Array.from(p.quat.subarray(k * 4, k * 4 + 4)) }; },
	};
}

/** build(written, def, carrier) -> { clip, aux } (engine.js), built again with the props in ids carrying the bodies on
 *  them: up to 3 builds, until each prop's track is what the bodies followed (aux.carried: { <prop id>: the most, in
 *  metres, any frame of its track differs from the one the bodies followed, only where over 0.1 mm }). */
export function carriedBuild(written, def, build, ids) {
	let built = build(written, def, null);
	if (!ids.size) return built;
	for (let n = 0; n < 2; n++) {
		const carrier = carrierOf(built.clip, def, ids), next = build(written, def, carrier), off = {};
		for (const id of ids) {
			const a = built.clip.props.find(p => p.id === id).pos, b = next.clip.props.find(p => p.id === id).pos;
			let d = 0;
			for (let i = 0; i < a.length; i += 3) d = Math.max(d, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
			if (d > 1e-4) off[id] = d;
		}
		built = next;
		if (!Object.keys(off).length) return built;
		built.aux.carried = off;
	}
	return built;
}
