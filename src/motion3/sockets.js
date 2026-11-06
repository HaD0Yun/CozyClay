// Grasp sockets (lane socket): where and how a hand takes hold of an object, so the agent names the part and the
// grasp and the compiler turns the hand. The grasp is the object's (sessions 02263581, 38322b5d: the agent computed
// the wrist by hand and held a barbell 90 deg off, the bar through the palm; a rifle's second hand was measured off
// the first). A socket is, in its record's own axes (metres from the base pivot, as an object anchor's `local`):
//   at     the point the fingers close on
//   axis   the line that runs across the palm, the knuckle line along it (a bar, a handle, a grip); none: any
//   from   the side the hand comes from: the palm faces against it; none: the roll the arm holds most easily
//          (compiler/socket-grip.js), or on a body with no axis the face nearest the point
//   thumb  the end of the axis the thumb takes; none: the end-state-comfort end (socketPalm)
// A record stores named sockets in `grasp` (src/object-grasp.js); every thin body (two half sizes under THIN m: a
// bar, a can, a handle) is one too, named by its id, through its centre along its long axis. An object anchor with
// `grasp` (power, pinch, hook, palm) takes the hand by a socket of its object: `socket` names it, else the one
// nearest the anchor's `local` point or, without one, nearest the shoulder of the hand, picked once per compile.
// A disc (a cylinder whose height is under THIN m and whose two sides are wider: a steering wheel) is a rim socket
// instead: `rim` its radius, `normal` its axis; the hand takes the rim where it is nearest the anchor's `local` point
// or the hand's shoulder, the knuckle line along the rim (session 2ad2760a: the wheel was held by points in the
// driver's frame, 15 cm off the rim, and they did not follow the truck). anchorSocket fixes that point once per hand.
import { add, sub, scale, norm, cross, dot, len, apply, ry, T } from "./compiler/math.js";
import { partsOf } from "./object-pose.js";
import { sdBox } from "./qa/geometry.js";

const THIN = 0.045, AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const flat = (v, n) => sub(v, scale(n, dot(v, n)));

/** The long axis index of a thin body's half sizes, else -1. */
function thinAxis(half) {
	if (!half) return -1;
	const long = [0, 1, 2].reduce((a, i) => (half[i] > half[a] ? i : a), 0);
	return [0, 1, 2].filter(i => i !== long).every(i => half[i] < THIN) ? long : -1;
}

/** A cylinder flat along its axis (its height under THIN m) and round across it, both sides over THIN m. */
const isDisc = (renderer, half) => renderer === "cylinder" && !!half && half[1] < THIN && Math.min(half[0], half[2]) >= THIN && Math.abs(half[0] - half[2]) < 0.1 * half[0];

/** The record's stored sockets: a body's in scene.objects, a group's (an Empty) in scene.others. */
const stored = (scene, id) => scene?.objects?.[id]?.grasp ?? scene?.others?.[id]?.grasp ?? null;

/**
 * Every socket of body or group `id`: [{ name, owner, at, axis?, from?, thumb? }], each in its owner's axes. The record's
 * own sockets by name; a part's as "<part>.<name>"; a thin part's derived one by the part id.
 */
export function socketsOf(scene, id) {
	const out = [], own = (owner, prefix) => Object.entries(stored(scene, owner) ?? {}).forEach(([name, s]) => out.push({ ...s, name: prefix + name, owner }));
	own(id, "");
	for (const part of partsOf(scene, id)) {
		if (part !== id) own(part, `${part}.`);
		const { half, renderer } = scene.objects[part], long = thinAxis(half);
		// a thin body's radius: the thinner of the two half sizes across the axis (how far the palm sits off the axis)
		if (long >= 0) out.push({ name: part, owner: part, at: [0, half[1], 0], axis: AXES[long], radius: Math.min(...half.filter((_, i) => i !== long)) });
		else if (isDisc(renderer, half)) out.push({ name: part, owner: part, at: [0, half[1], 0], rim: half[0], normal: AXES[1] });
	}
	return out;
}

/** The socket of `id` named `name`, or undefined. */
export const socketNamed = (scene, id, name) => socketsOf(scene, id).find(s => s.name === name);

/** A socket in world space on its owner's pose { pos, R }: { p, axis?, from?, thumb? }. */
export function socketWorld(socket, pose) {
	const dir = v => (v ? norm(apply(pose.R, v)) : undefined);
	return { p: add(pose.pos, apply(pose.R, socket.at ?? [0, 0, 0])), axis: dir(socket.axis), from: dir(socket.from), thumb: dir(socket.thumb), radius: socket.radius,
		...(socket.rim ? { rim: socket.rim, normal: dir(socket.normal) } : {}) };
}

/** The point of world rim socket w nearest world point q, and the rim's direction there: { p, axis }. */
export function rimPoint(w, q) {
	const v = flat(sub(q, w.p), w.normal), r = len(v) > 1e-6 ? norm(v) : norm(flat(Math.abs(w.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], w.normal));
	return { p: add(w.p, scale(r, w.rim)), axis: norm(cross(w.normal, r)) };
}

/** The outward normal of the face of the box (of boxes [{ pos, R, half }], base pivots) nearest world point p, or undefined. */
export function faceFrom(boxes, p) {
	let best;
	for (const b of boxes) {
		const q = apply(T(b.R), sub(p, add(b.pos, apply(b.R, [0, b.half[1], 0])))), out = [0, 1, 2].map(i => Math.abs(q[i]) - b.half[i]);
		const i = [0, 1, 2].reduce((m, j) => (out[j] > out[m] ? j : m), 0), gap = Math.max(...out);
		if (!best || gap < best.gap) best = { gap, n: scale([b.R[0][i], b.R[1][i], b.R[2][i]], q[i] < 0 ? -1 : 1) };
	}
	return best?.n;
}

// A support hold (grasp "support"): a box carried from below at its sides, the palm flat on a side face low and the
// fingers round its bottom edge (a crate against the chest; the A/B T2 recipe placed it by hand at [+-0.152, 0.04, -0.06]
// and the agents' runs put it at 0.10-0.15 m, the fingers never under: 0/3). The compiler places it:
//   face    of the four side faces (the body's own axes, its bottom on the base pivot) the one whose outward normal points
//           most along the hand's side of the body, picked once per compile
//   along   where the shoulder is along that face, kept SUPPORT_MARGIN inside its vertical edges
//   height  low (anchors.js supportLow: the hooked fingers' middle joints just past the bottom edge) once the bottom clears
//           what is under it by SUPPORT_SLIDE; pressing the side at mid height while it rests on a table, a shelf or the
//           floor before the lift, sliding down between (smoothstep): the fingers stay out from under it until there is room
//           (never lower than low + the depth still blocked, SUPPORT_CLEAR - gap). After the lift, setting it down, the palm
//           rises only by that depth, SUPPORT_LEAD frames before it lands, so the fingers are out from under it in time:
//           sliding up to mid height as the T2 box hovered over the shelf took the hands off it (the arm at its reach).
//           From hanging arms (a floor set-down) the fingers point down the face and straighten off it, so the palm rises
//           until their tips clear what the box rests on or lands on (compiler/anchors.js supportAt)
//   frame   the palm against the face, the fingers down the face toward the bottom edge (socketPalm), as far as the
//           wrist turns comfortably off the forearm (socket-grip.js towardDown)
export const SUPPORT_CLEAR = 0.03, SUPPORT_SLIDE = 0.1, SUPPORT_LEAD = 6;
const SUPPORT_MARGIN = 0.06, SUPPORT_SKIN = 0.002;

/** The face of a support hold on a body of half sizes `half`: { axis, sign, at } with `at` its palm point but the height, in the body's axes; lateral and shoulder in those axes too. */
export function supportFace(half, lateral, shoulder, margin = SUPPORT_MARGIN) {
	let best = null;
	for (const axis of [0, 2]) for (const sign of [1, -1]) if (!best || sign * lateral[axis] > best.score) best = { axis, sign, score: sign * lateral[axis] };
	const t = 2 - best.axis, room = Math.max(0, half[t] - margin), at = [0, 0, 0];
	at[best.axis] = best.sign * (half[best.axis] + SUPPORT_SKIN);
	at[t] = Math.max(-room, Math.min(room, shoulder[t]));
	return { axis: best.axis, sign: best.sign, at };
}

/** The palm's height above the bottom of a support hold whose bottom clears what is under it by `gap` m (see above). */
export function supportHeight(low, press, gap) {
	const t = Math.min(1, Math.max(0, gap / SUPPORT_SLIDE)), e = t * t * (3 - 2 * t);
	return Math.max(low + Math.max(0, SUPPORT_CLEAR - gap), press + (low - press) * e);
}

/** Nine points across the bottom face of a body of half sizes `half` on pose { pos, R } (its base pivot, the bottom centre). */
export const bottomPoints = (pose, half) => [-1, 0, 1].flatMap(x => [-1, 0, 1].map(z => add(pose.pos, apply(pose.R, [x * half[0], 0, z * half[2]]))));

/**
 * How far points `pts` (a body's bottom, bottomPoints) stand above what is under them: the ground (y 0) and every body of
 * `bodies` ({ id: pose }, base pivots, half sizes in scene.objects) not in `own` whose top is at most 5 mm above their
 * lowest, by the nearest point (so it changes smoothly as the body comes over a shelf's edge, not in a step). { gap (m,
 * >= 0), on: that body's id, null: the ground }. The one measure of the compiler (compiler/anchors.js supportAt) and QA (TIPS_OFF).
 */
export function gapUnder(scene, own, pts, bodies) {
	const bottom = Math.min(...pts.map(p => p[1]));
	let best = { gap: bottom, on: null };
	for (const [oid, b] of Object.entries(bodies ?? {})) {
		const h = scene.objects[oid]?.half;
		if (own.has(oid) || !h || !b?.R) continue;
		const top = b.pos[1] + b.R[1][1] * h[1] + [0, 1, 2].reduce((m, i) => m + Math.abs(b.R[1][i]) * h[i], 0);
		if (top > bottom + 0.005) continue;
		for (const p of pts) { const d = sdBox(p, { pos: b.pos, R: b.R, half: h }); if (d < best.gap) best = { gap: d, on: oid }; }
	}
	return { gap: Math.max(0, best.gap), on: best.on };
}

/** How far world point q is from a world socket: from its rim, else its axis line through p, else from p. */
export function socketDistance(w, q) {
	const v = sub(q, w.p);
	if (w.rim) return Math.hypot(dot(v, w.normal), len(flat(v, w.normal)) - w.rim);
	return len(w.axis ? flat(v, w.axis) : v);
}

/**
 * The palm frame (columns d, l, n of compiler/limbs.js palmAxes: d to the middle finger, l to the thumb side, n = d x
 * l; the palm is -n on the right hand, +n on the left) a grasp of `type` takes on world socket w, the forearm along fwd,
 * the body turned yawDeg. Along an axis (not a flat palm): with `from` the palm faces against it and the knuckle line
 * runs along the axis; without, the fingers stay on the forearm's line across the axis (a power grip turns the forearm,
 * not the wrist) and the palm closes on it. The thumb takes `thumb`'s end, else the end-state-comfort end (people take
 * the grip that ends comfortable, Rosenbaum): up when the forearm is level, toward the midline when it points down or
 * up. Without an axis the palm faces against `from` (anchorSocket gives a box face's), the fingers on the forearm's line.
 */
export function socketPalm(side, w, type, fwd, yawDeg = 0) {
	const right = side === "Right", sign = v => (right ? v : scale(v, -1));
	// a support hold: the palm against the face, the fingers down it toward the bottom edge they hook round, whatever the
	// forearm's line (on it they lay along the face when the forearm came up level onto a shelf, 0-1 of 4 tips under)
	if (type === "support" && w.from && w.down && len(flat(w.down, w.from)) > 1e-3) {
		const n = sign(w.from), d = norm(flat(w.down, n));
		return cols(d, cross(n, d), n);
	}
	// a side along the axis leaves no knuckle line across it: the palm then just faces against the side (below)
	if (w.axis && type !== "palm" && !(w.from && len(flat(w.axis, w.from)) < 1e-3)) {
		if (w.from) {
			const n = sign(w.from), l0 = norm(flat(w.axis, n)), pick = l => (w.thumb ? dot(l, w.thumb) : dot(cross(l, n), fwd));
			const l = pick(l0) >= pick(scale(l0, -1)) ? l0 : scale(l0, -1);
			return cols(cross(l, n), l, n);
		}
		const d = across(fwd, w.axis), medial = apply(ry(yawDeg), [right ? 1 : -1, 0, 0]), vy = Math.abs(d[1]);
		const want = w.thumb ?? flat(add(scale([0, 1, 0], 1 - vy), scale(medial, vy)), d), l0 = norm(flat(w.axis, d));
		const l = dot(l0, want) >= 0 ? l0 : scale(l0, -1);
		return cols(d, l, cross(d, l));
	}
	const n = sign(w.from ?? scale(fwd, -1)), d = across(fwd, n);
	return cols(d, cross(n, d), n);
}

/** fwd made perpendicular to v (unit); any perpendicular when fwd runs along v. */
function across(fwd, v) {
	const d = flat(fwd, v);
	return norm(len(d) > 1e-3 ? d : flat(Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], v));
}

const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
