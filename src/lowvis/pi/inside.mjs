// One measure of things inside props: on every frame, how deep each solid of each body (each part of the look as
// drawn, taken as the convex solid around it, at the character's scale; the hands are left out) and each moving prop
// is inside every other prop. The depth of two solids is the least distance one would have to move to be clear of the
// other (separating axes; a ball by its centre's distance). A case is a body or a moving prop with one prop; it is told
// when its depth passes the limit on a tenth of a second's worth of frames (prompt.mjs seenFrames, which says why), or
// on the clip's first or last frame whatever its count: a pair the clip begins or ends with is cut by the clip, which
// does not show how long it lasts, and a still of either end shows it. Nothing is moved by it.
//
// Not told, from the engine's own state: a body with a prop its own actions hold, carry, push or place, on the frames
// aux.holders names that body among the prop's holders (the whole body: the engine moves the prop with the hands, so
// where it lies against that body is the hold's, not a pass through it). Not told, from what the spec says is a
// contact: a body with the prop it sits or lies on (from that action through the idles after it and the change of
// posture that leaves it), an elbow's limb (upper arm and forearm) and a hand's forearm with the prop of its target
// (the engine's own keys of that limb, spec-layers.js buildUpper: from a key that names the prop up to the limb's next
// key), a prop with the body joint or the prop it rides on (while it rides: up to its next key or a hand taking it off;
// and after the ride for as long as the pair has been past the limit on every frame since the ride's last one: a prop
// that rides that deep leaves the ride's place through those frames), and any pair with a prop the scene marks hollow
// (things may be inside it).
import { CLIP_FPS } from "../clip.js";
import { INDEX as J, JOINTS, JOINT_COUNT } from "../rig17.js";
import { qConj, qRotate } from "../engine-simple/math.js";
import { buildUpper } from "../engine-simple/spec-layers.js";
import { LOOK_SOLIDS as LOOKS } from "../looks/solids.js";
import { seenFrames } from "./prompt.mjs";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = v => { const l = Math.hypot(...v); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
/** A look's solids with what the measure reads of each, once: the extent of every corner along each face normal, the
 *  edges' directions, each triangle's plane and the ball around it, the radius around the box centre, and the ball
 *  inside the solid about the mean of its corners. */
const prepared = solids => solids.map(o => {
	const planes = o.n.map(n => { const d = o.v.map(p => dot(p, n)); return { n, lo: Math.min(...d), hi: Math.max(...d) }; });
	const g = [0, 1, 2].map(k => o.v.reduce((t, p) => t + p[k], 0) / o.v.length);
	const tris = o.t.map(([i, j, k]) => {
		const n = unit(cross(sub(o.v[j], o.v[i]), sub(o.v[k], o.v[i]))), mid = [0, 1, 2].map(x => (o.v[i][x] + o.v[j][x] + o.v[k][x]) / 3);
		return n && { i, j, k, n, off: dot(n, o.v[i]), mid, rad: Math.max(...[i, j, k].map(x => Math.hypot(...sub(o.v[x], mid)))) };
	}).filter(Boolean);
	return { ...o, planes, g, tris, ri: Math.max(0, Math.min(...planes.map(P => P.hi - dot(P.n, g)))),
		// [direction, one face's normal, the other's] per edge, flat; a line between two triangles of one face is no edge
		edges: Float64Array.from(o.e.flatMap(([i, j, n1, n2]) => { const d = unit(sub(o.v[j], o.v[i])); return d && dot(n1, n2) < 1 - 1e-9 ? [...d, ...n1, ...n2] : []; })),
		reach: Math.max(...o.v.map(p => Math.hypot(...sub(p, o.c)))) };
});
const cache = {};
/** The look the solids are taken from: the one named (the Studio's launch look) when it states solids, else block. */
const solidsLook = name => LOOKS[name] ? name : "block";
const solidsOf = name => (cache[solidsLook(name)] ??= prepared(LOOKS[solidsLook(name)]()));

/** The depth limit, metres: 25 mm times the body's scale (two props: 25 mm). The engine's own steps put the drawn sole
 *  up to about 20 mm x scale under the surface the body walks on (the foot pitches as a step ends: block look 18.9 mm,
 *  cube look 20.1 mm), so a told part is deeper than a foot that walks on a prop; the thinnest drawn limb is 50 mm (the
 *  block look's forearm at the wrist; the cube look's 58 mm). A body through a thin plate is as deep as it would have
 *  to move to be clear of it, not the plate's thickness. */
const LIMIT = 0.025;
const POSTURE = new Set(["sit", "stand", "kneel", "lie"]), BODY = new Set(["idle", "walk", "run", "push", "turn", ...POSTURE]);
const LIMB = { L: ["LeftForeArm"], R: ["RightForeArm"], elbowL: ["LeftArm", "LeftForeArm"], elbowR: ["RightArm", "RightForeArm"] };
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Depth of two oriented boxes { c, ax: [3 unit axes], h: [3 half sizes] } by separating axes; <= 0 when apart. */
function boxBox(a, b) {
	const t = sub(b.c, a.c), axes = [...a.ax, ...b.ax];
	for (const u of a.ax) for (const v of b.ax) { const n = unit(cross(u, v)); if (n) axes.push(n); }
	let depth = Infinity;
	for (const L of axes) {
		const ra = a.h[0] * Math.abs(dot(a.ax[0], L)) + a.h[1] * Math.abs(dot(a.ax[1], L)) + a.h[2] * Math.abs(dot(a.ax[2], L));
		const rb = b.h[0] * Math.abs(dot(b.ax[0], L)) + b.h[1] * Math.abs(dot(b.ax[1], L)) + b.h[2] * Math.abs(dot(b.ax[2], L));
		const o = ra + rb - Math.abs(dot(t, L));
		if (o <= 0) return o;
		depth = Math.min(depth, o);
	}
	return depth;
}
/** Depth of a ball { c, r } in a box: its radius less its centre's signed distance to the box. */
function ballBox(s, b) {
	const d = sub(s.c, b.c), l = b.ax.map((u, k) => Math.abs(dot(d, u)) - b.h[k]);
	return s.r - (Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)));
}
const depthOf = (a, b) => a.r != null ? (b.r != null ? a.r + b.r - Math.hypot(...sub(a.c, b.c)) : ballBox(a, b)) : b.r != null ? ballBox(b, a) : boxBox(a, b);

/** Distance of point p to the triangle a b c. */
function triDist(p, a, b, c) {
	const n = cross(sub(b, a), sub(c, a)), side = (x, y) => dot(cross(sub(y, x), sub(p, x)), n) >= 0;
	if (side(a, b) && side(b, c) && side(c, a)) return Math.abs(dot(sub(p, a), n)) / Math.hypot(...n);
	const seg = (x, y) => { const xy = sub(y, x), t = Math.max(0, Math.min(1, dot(sub(p, x), xy) / dot(xy, xy))); return Math.hypot(...sub(p, [x[0] + xy[0] * t, x[1] + xy[1] * t, x[2] + xy[2] * t])); };
	return Math.min(seg(a, b), seg(b, c), seg(c, a));
}
/**
 * Depth of a drawn part (prepared solid o at scale s) in a prop given in the part's own frame ({ c, ax, h } or { c, r }):
 * the least overlap over the separating axes of the two (face normals, the box's axes, and the crosses of an edge of the
 * part with an axis of the box where the edge's two faces lie on either side of that axis); a ball: its radius less its
 * centre's signed distance to the part. Stops as soon as the overlap is at most stop.
 */
function partDepth(o, s, b, stop) {
	if (b.r != null) { // the centre's distance to the part: inside it the nearest face plane, outside it the nearest triangle
		let out = -Infinity, near = null;
		for (const T of o.tris) { const d = dot(b.c, T.n) - T.off * s; if (d > out) { out = d; near = T; } }
		if (out <= 0 || out >= b.r) return b.r - out;
		const c = [b.c[0] / s, b.c[1] / s, b.c[2] / s], tri = T => triDist(c, o.v[T.i], o.v[T.j], o.v[T.k]);
		let best = tri(near);
		for (const T of o.tris) if (T !== near && Math.hypot(...sub(c, T.mid)) - T.rad < best) best = Math.min(best, tri(T)); // a triangle further than its ball cannot be nearer
		return b.r - best * s;
	}
	let best = Infinity;
	const radius = u => b.h[0] * Math.abs(dot(b.ax[0], u)) + b.h[1] * Math.abs(dot(b.ax[1], u)) + b.h[2] * Math.abs(dot(b.ax[2], u));
	const over = (u, lo, hi) => { const m = dot(b.c, u), r = radius(u); best = Math.min(best, hi - (m - r), m + r - lo); return best <= stop; };
	const scan = u => { // the part spans at least its inner ball along u: when that overlap is no less than the best, u cannot lower it
		const m = dot(b.c, u), r = radius(u), g = dot(o.g, u) * s, ri = o.ri * s;
		if (Math.min(g + ri - m + r, m + r - g + ri) >= best) return false;
		let lo = Infinity, hi = -Infinity;
		for (const p of o.v) { const d = dot(p, u); if (d < lo) lo = d; if (d > hi) hi = d; }
		return over(u, lo * s, hi * s);
	};
	for (const P of o.planes) if (over(P.n, P.lo * s, P.hi * s)) return best;
	for (const A of b.ax) if (scan(A)) return best;
	const E = o.edges;
	for (const [x, y, z] of b.ax) for (let i = 0; i < E.length; i += 9) {
		if ((E[i + 3] * x + E[i + 4] * y + E[i + 5] * z) * (E[i + 6] * x + E[i + 7] * y + E[i + 8] * z) >= 0) continue;
		const u = unit([E[i + 1] * z - E[i + 2] * y, E[i + 2] * x - E[i] * z, E[i] * y - E[i + 1] * x]);
		if (u && scan(u)) return best;
	}
	return best;
}

/** The frames on which the spec's words make a body or a prop touch a prop: { <who>|<prop>: [{ a, b, joints? }] }. */
function contacts(spec, aux, F, def, chars) {
	const out = {}, put = (key, e) => (out[key] ??= []).push(e);
	const props = Object.fromEntries((def?.props ?? []).map(p => [p.id, { size: p.size, turn: 0 }]));
	for (const c of chars) {
		const acts = (Array.isArray(spec[c.id]) ? spec[c.id] : []).filter(a => Array.isArray(a) && Number.isInteger(a[0])).slice().sort((x, y) => x[0] - y[0]), body = acts.filter(a => BODY.has(a[1]));
		body.forEach((a, i) => {
			if ((a[1] !== "sit" && a[1] !== "lie") || typeof a[2]?.on !== "string") return;
			let k = i + 1; // the posture holds through idle actions; a change of posture after it leaves the prop when its change ends (its over, spec-layers.js)
			while (body[k]?.[1] === "idle") k++;
			const n = body[k], N = (body[k + 1]?.[0] ?? F) - (n?.[0] ?? F), over = n?.[2]?.over;
			put(`${c.id}|${a[2].on}`, { a: a[0], b: !n ? F : n[0] + (POSTURE.has(n[1]) ? (over == null ? N : Math.min(N, Math.round(over))) : 0) });
		});
		const { keys } = buildUpper(c.id, acts, props, c.scale ?? 1);
		for (const [field, joints] of Object.entries(LIMB)) keys[field].forEach((k, i) => {
			const on = k.to && typeof k.to === "object" && !Array.isArray(k.to) ? k.to.on ?? k.to.prop : k.place?.on;
			if (typeof on === "string") put(`${c.id}|${on}`, { a: k.f, b: keys[field][i + 1]?.f ?? F, joints: new Set(joints.map(n => J[n])) });
		});
	}
	for (const r of aux.rides ?? []) if (r.began != null) {
		let b = r.next ?? F; // the ride ends at the prop's next key or on the first frame a hand holds it
		for (let f = r.began; f < b; f++) if (aux.holders?.[r.prop]?.[f]) { b = f; break; }
		const span = { a: r.began, b, ride: true }; // a ride's span can grow past its end (rideKeeps)
		if (r.joint) put(`${r.of}|${r.prop}`, { ...span, joints: new Set([J[r.joint]]) });
		else { put(`${r.prop}|${r.on}`, span); put(`${r.on}|${r.prop}`, span); }
	}
	return out;
}
/** Whether a span of list covers frame f (and the joint, for a span of some joints only; joint null: any span). */
const touching = (list, f, joint) => list?.some(e => f >= e.a && f < e.b && (!e.joints || joint == null || e.joints.has(joint)));
/** The ride's span of list (for the joint) whose last frame is f or that ended on f: the two frames its end is read on. */
const rideEdge = (list, f, joint) => list?.find(e => e.ride && e.a <= f && (e.b === f || e.b === f + 1) && (!e.joints || joint == null || e.joints.has(joint)));
/** Whether frame f is of ride span e, read on the frames rideEdge gives. past: the pair is past the limit on f. The
 *  span keeps the last of its frames on which the pair was past the limit (deep); on the frame after its end it grows
 *  by that frame when the pair was past the limit on the frame before and still is. So after a ride a pair is not told
 *  only while it has been past the limit on every frame since the ride's last one. */
function rideKeeps(e, f, past) {
	if (past && f === e.b && e.deep === f - 1) e.b++;
	if (past && f === e.b - 1) e.deep = f;
	return f < e.b;
}

/**
 * The inside rows of a clip. def: the scene as built (props with hollow); spec: as built (repeats written out);
 * look: the look the bodies are drawn in (solidsLook). One row per body or moving prop and prop past the limit:
 * { key: "inside:<who>><prop>", value: depth mm on the worst frame, frame, who (a body), prop, part, frames (over the
 *   limit), first, last, limit (mm) }.
 */
export function insideRows(clip, aux, { def, spec, look }) {
	const F = clip.frameCount, solids = solidsOf(look), hollow = new Set((def?.props ?? []).filter(p => p.hollow === true).map(p => p.id));
	const touch = contacts(spec ?? {}, aux, F, def, clip.characters), cases = new Map();
	// who holds a prop on a frame: a character id, or "<id>:<side>" joined by "+" for hands of several (share.js)
	const holdersAt = (id, f) => String(aux.holders?.[id]?.[f] ?? "").split("+").filter(Boolean).map(h => h.replace(/:[LR]$/, ""));
	const propBox = (p, f) => {
		const i = p.pos.length === 3 ? 0 : f, c = Array.from(p.pos.slice(i * 3, i * 3 + 3)), q = Array.from(p.quat.slice(i * 4, i * 4 + 4));
		const b = p.shape === "sphere" ? { c, r: p.size[0] / 2 } : { c, q, ax: AXES.map(a => qRotate(q, a)), h: p.size.map(v => v / 2) };
		b.reach = b.r ?? Math.hypot(...b.h);
		return b;
	};
	const apart = (a, ra, b) => { const x = a[0] - b.c[0], y = a[1] - b.c[1], z = a[2] - b.c[2], r = ra + b.reach; return x * x + y * y + z * z > r * r; };
	// of two moving props, the smaller is named inside the larger (equal ones: by id)
	const volume = p => p.size[0] * p.size[1] * p.size[2], inner = (p, m) => volume(p) < volume(m) || (volume(p) === volume(m) && p.id < m.id);
	const note = (key, who, prop, part, d, f, limit) => {
		if (d <= limit) return;
		const e = cases.get(key) ?? cases.set(key, { key, who, prop, part, value: 0, frame: f, frames: 0, first: f, last: -1, limit }).get(key);
		if (e.last !== f) e.frames++;
		e.last = f; e.limit = Math.min(e.limit, limit);
		if (d > e.value) Object.assign(e, { value: d, frame: f, part });
	};
	const props = clip.props.filter(p => !hollow.has(p.id)), moving = props.map(p => p.pos.length > 3), boxes = props.map(p => propBox(p, 0));
	for (let f = 0; f < F; f++) {
		props.forEach((p, i) => { if (moving[i]) boxes[i] = propBox(p, f); });
		for (const c of clip.characters) {
			const s = c.scale ?? 1, lim = LIMIT * s;
			const parts = solids.map(o => {
				const i = f * JOINT_COUNT + o.joint, q = Array.from(c.quat.slice(i * 4, i * 4 + 4)), P = [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]], d = qRotate(q, o.c);
				return { o, q, P, c: [P[0] + d[0] * s, P[1] + d[1] * s, P[2] + d[2] * s], ax: AXES.map(a => qRotate(q, a)), h: o.h.map(v => v * s), reach: o.reach * s };
			});
			const hip = (f * JOINT_COUNT + J.Hips) * 3, at = [c.pos[hip], c.pos[hip + 1], c.pos[hip + 2]], all = Math.max(...parts.map(o => Math.hypot(...sub(o.c, at)) + o.reach));
			props.forEach((p, n) => {
				const b = boxes[n];
				if (apart(at, all, b)) return;
				const key = `${c.id}|${p.id}`, list = touch[key];
				if (holdersAt(p.id, f).includes(c.id) || list?.some(e => f >= e.a && f < e.b && !e.joints)) return; // it handles the prop, or the whole body touches it
				for (const o of parts) {
					if (apart(o.c, o.reach, b)) continue;
					// a contact of the spec's words covers the part; on the two frames a ride's end is read on it is measured all the same
					const contact = touching(list, f, o.o.joint), edge = list && rideEdge(list, f, o.o.joint);
					const up = contact && !edge ? 0 : depthOf(o, b);
					if (up <= lim) continue; // the box around the part is not past the limit
					const iq = qConj(o.q), own = { c: qRotate(iq, sub(b.c, o.P)), r: b.r, ax: b.ax?.map(a => qRotate(iq, a)), h: b.h };
					if (edge && (rideKeeps(edge, f, partDepth(o.o, s, own, lim) > lim) || contact)) continue;
					// the part's depth lies between that of the ball inside it and that of the box around it; it is worked out
					// only as far as it can count this frame or raise the case's worst
					const e = cases.get(key), counted = e?.last === f, worst = e?.value ?? 0;
					if (counted && up <= worst) continue;
					const low = counted ? 0 : depthOf({ c: o.o.g.map(v => v * s), r: o.o.ri * s }, own);
					if (low > lim && up <= worst) { note(key, c.id, p.id, JOINTS[o.o.joint], low, f, lim); continue; }
					note(key, c.id, p.id, JOINTS[o.o.joint], Math.max(low, partDepth(o.o, s, own, counted || low > lim ? Math.max(lim, worst) : lim)), f, lim);
				}
			});
		}
		for (let i = 0; i < props.length; i++) if (moving[i]) {
			const m = props[i], a = boxes[i];
			for (let n = 0; n < props.length; n++) {
				const p = props[n], b = boxes[n];
				if (n === i || (moving[n] && n < i) || apart(a.c, a.reach, b)) continue; // a pair of movers once
				const list = touch[`${m.id}|${p.id}`], edge = rideEdge(list, f, null), d = !edge && touching(list, f, null) ? 0 : depthOf(a, b);
				if (d <= LIMIT || (edge && (rideKeeps(edge, f, true) || touching(list, f, null)))) continue;
				const [x, y] = moving[n] && inner(p, m) ? [p, m] : [m, p];
				note(`${x.id}|${y.id}`, null, y.id, x.id, d, f, LIMIT);
			}
		}
	}
	// a pair past the limit on fewer frames than last a tenth of a second is not told, unless they hold the clip's first or last frame
	const seen = seenFrames(clip.fps);
	return [...cases.values()].filter(e => e.frames >= seen || e.first === 0 || e.last === F - 1).map(e => ({ ...e, key: `inside:${e.who ?? e.part}>${e.prop}`, value: e.value * 1000, limit: e.limit * 1000 }));
}

/** What the inside lines measure and leave out, said once in a session (compile-tool.mjs): look, the look the bodies
 *  are drawn in (the one whose solids are measured is solidsLook: when it is another, the text says so); fps, the clip's rate. */
export const insideText = (look, fps = CLIP_FPS) => `inside lines (said once): on every frame, how deep each body (each part as the ${solidsLook(look)} look draws it${look && solidsLook(look) !== look ? `, the tool having none for the Studio's ${look} look` : ""}, taken as the convex solid around it, at the body's scale; the hands left out) and each prop with moves: true is inside every other prop: the least distance it would have to move to be clear of it. A pair is told when it is deeper than the limit its line states on ${seenFrames(fps)} frames or more (at ${fps} fps the fewest that last a tenth of a second), or on the clip's first or last frame; its line counts the frames it is deeper. Not told and not counted: a body with a prop it holds, carries, pushes or places, on the frames the engine has it in that body's hands; a body with the prop it sits or lies on, up to the end of its next change of posture or the start of its next walk, run, push or turn; an elbow's limb with the prop of its target, and the forearm with the prop of its hand's target, until that limb's next key; a prop with the joint or the prop it rides on, while it rides, and after the ride while it has been deeper than the limit on every frame since the ride's last one; anything with a hollow prop. The engine moves nothing because of it.`;
