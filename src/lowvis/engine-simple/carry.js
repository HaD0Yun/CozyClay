// A body on a prop that moves: a body-layer action with `on: propId` (any verb) is done on that prop and goes with it.
// The body layer works such an action out against the prop as the scene places it (as a sit or a lie on a prop always
// has), so its places (`to`, the seat, where it lies) and headings are the prop's as it stands in the scene, and each
// frame is then carried to where the prop is on that frame: turned and moved as the prop is turned and moved from its
// scene place. Where the body gets on or off, the state between two actions is carried over the same way, so the
// body goes on from where it is. The prop's place on each frame comes from a first build of the clip (the props'
// tracks, carriedBuild); the body then follows it on every frame of the second.
import { add, qConj, qMul, qRotate, qY, sub } from "./math.js";

/** A carrier's motion on one frame: x (its scene frame) -> q (x - c0) + c (the world), from its scene place
 *  { c, q } and its place on that frame. */
const motionOf = (scene, at) => ({ q: qMul(at.q, qConj(scene.q)), c0: scene.c, c: at.c });
const out = (D, x) => add(qRotate(D.q, sub(x, D.c0)), D.c);
const back = (D, x) => add(qRotate(qConj(D.q), sub(x, D.c)), D.c0);
const yawOf = q => { const z = qRotate(q, [0, 0, 1]); return Math.atan2(z[0], z[2]); };
const ID = { q: [0, 0, 0, 1], c0: [0, 0, 0], c: [0, 0, 0] };

/** carrier ({ scene(id), at(id, f) } -> { c, q }): the motion of prop id on frame f, the identity for none (the world). */
const motionAt = (carrier, id, f) => (id == null ? ID : motionOf(carrier.scene(id), carrier.at(id, f)));
/** The map of a point from frame `from` to frame `to` (prop ids or null) on frame f. */
const across = (carrier, from, to, f) => { const A = motionAt(carrier, from, f), B = motionAt(carrier, to, f); return { point: x => back(B, out(A, x)), turn: qMul(qConj(B.q), A.q) }; };

/** Body state B (solve.js) moved by map m ({ point, turn }); the floor under each foot moves with it. */
function moveB(B, m) {
	const yaw = yawOf(m.turn);
	return {
		...B, p: m.point(B.p), q: qMul(m.turn, B.q), yaw: B.yaw + yaw,
		feet: B.feet.map(ft => ({ ...ft, a: m.point(ft.a), q: qMul(m.turn, ft.q), floor: m.point([ft.a[0], ft.floor ?? 0, ft.a[2]])[1] })),
	};
}

/** The body layer's state between actions (gait.js: p and feet g are [x, z] on the floor) carried from frame `from`
 *  to frame `to` on frame f. */
export function carryState(st, carrier, from, to, f) {
	if (from === to) return st;
	const m = across(carrier, from, to, f), flat = g => { const p = m.point([g[0], 0, g[1]]); return [p[0], p[2]]; }, turn = yawOf(m.turn);
	return { ...st, p: flat(st.p), yaw: st.yaw + turn, feet: st.feet.map(ft => ({ ...ft, g: flat(ft.g), yaw: ft.yaw + turn })), ...(st.lastB ? { lastB: moveB(st.lastB, m) } : {}) };
}

/** The body layer's frames (out[f].on: the prop whose frame it is in, else the world) with the pelvis heights blurred
 *  as the body layer blurs them, each frame's neighbours read in that frame's own, then all carried to the world. */
export function carriedFrames(out, F, carrier) {
	for (let pass = 0; pass < 3; pass++) {
		const p = out.map(B => B.p.slice()), y = (n, f) => (out[n].on === out[f].on ? p[n][1] : across(carrier, out[n].on, out[f].on, n).point(p[n])[1]);
		out.forEach((B, f) => { B.p[1] = 0.25 * y(Math.max(0, f - 1), f) + 0.5 * p[f][1] + 0.25 * y(Math.min(F - 1, f + 1), f); });
	}
	return out.map((B, f) => (B.on == null ? B : moveB(B, across(carrier, B.on, null, f))));
}

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
