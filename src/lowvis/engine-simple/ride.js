// The prop layer's ride: from the key's frame the prop keeps a place and turn on its carrier, another prop
// (ride {on: propId}) or a joint of a character's body (ride {joint, of: characterId}), however the carrier moves, until
// a later key of its own or until a hand takes it (hold, carry). A ride key written while a hand holds the prop starts
// when the hand lets go. Riders move after the carriers' keys, after the first pass of the figures and after the second
// (share.js, engine.js), so they follow the carrier's pose of that same frame and a place on them is current for each
// pass. The place is taken once per ride: `at` (the prop's centre in the carrier's own frame, its axes along the
// carrier's turned `deg` about `axis`), else where the prop is when the ride begins: against a prop as it stands after
// its keys, against a joint as the body ended that frame.
import { INDEX as J, qAxisAngle } from "../rig17.js";
import { add, len, norm, qConj, qMul, qRotate, qY, rad, sub } from "./math.js";
import { solveSized } from "./size.js";

/** The key that drives free prop p on frame f (null while a hand holds it or while it rides) and its ride in p.ride.
 *  p.takenAt: the last frame a hand took the prop. */
export function propKey(p, f) {
	const k = p.keys.findLast(k => k.f <= f), riding = k?.verb === "ride";
	p.ride = riding && !p.holder && !(p.takenAt >= k.f) ? k : null;
	return p.holder || riding ? null : k;
}

/** A joint's place and turn { c, q } as the current pass reads body o (a character of engine.js): on the first pass its
 *  last pose carried with its body to frame f, on the second the first pass's pose of f; final: as it ended frame f. */
export function jointFrame(o, j, f, final = false) {
	if (final) return { c: o.poseNow.pos[j], q: o.poseNow.quat[j] };
	if (o.snapF === f) return { c: o.snap.pos[j], q: o.snap.quat[j] };
	if (!o.world || !o.prevB) { const P = solveSized(o.body[f], {}, o.s); return { c: P.pos[j], q: P.quat[j] }; }
	const B = o.body[f], turn = qY(B.yaw - o.prevB.yaw); // its last pose, carried with its body to this frame
	return { c: add(B.p, qRotate(turn, sub(o.world.pos[j], o.prevB.p))), q: qMul(turn, o.world.quat[j]) };
}

const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
/** Throws on a ride key of prop p that cannot be read: a joint or character that is not there, an at, axis or deg of
 *  the wrong form. byId: the characters by id. */
function checkRides(p, byId) {
	for (const k of p.keys.filter(k => k.verb === "ride")) {
		const bad = text => new Error(`engine-simple: ${p.id} ride at frame ${k.f}: ${text}`);
		if (k.joint !== undefined || k.of !== undefined) {
			if (k.on !== undefined) throw bad("give {on: propId} or {joint, of: characterId}, not both");
			if (!Object.hasOwn(J, k.joint ?? "")) throw bad(`unknown joint ${JSON.stringify(k.joint)}; want one of ${Object.keys(J).join(", ")}`);
			if (!Object.hasOwn(byId, k.of ?? "")) throw bad(`{joint, of} wants a character id, got ${JSON.stringify(k.of)}; characters: ${Object.keys(byId).join(", ")}`);
		}
		if (k.at !== undefined && !vec(k.at)) throw bad(`at wants [x, y, z], got ${JSON.stringify(k.at)}`);
		if (k.deg !== undefined && !(Number.isFinite(k.deg) && vec(k.axis) && len(k.axis) > 1e-9)) throw bad(`deg wants a number and axis: [x, y, z], got deg ${JSON.stringify(k.deg)}, axis ${JSON.stringify(k.axis)}`);
	}
}

/** Moves every riding prop onto its carrier for frame f; a carrier that rides on another moves first. byId: the
 *  characters by id; final: the bodies as they ended the frame (the last call of the frame). */
export function moveRiders(props, f, byId = {}, final = false) {
	const done = new Set();
	const move = p => {
		if (done.has(p.id)) return;
		done.add(p.id);
		const k = p.ride, body = k.joint !== undefined, car = body ? jointFrame(byId[k.of], J[k.joint], f, final) : props[k.on];
		if (!car || car === p) throw new Error(`engine-simple: ${p.id} ride wants {on: <another prop id>}, got ${JSON.stringify(k.on)}`);
		if (!p.moves) throw new Error(`engine-simple: ${p.id} rides on ${body ? `${k.of}'s ${k.joint}` : car.id} but has no moves: true in the scene`);
		if (car.ride) move(car);
		if (!(p.rideAt >= f - 1) || p.rel.k !== k) { p.rel = { k, f, from: { c: p.c.slice(), q: p.q.slice() } }; k.entry.began ??= f; }
		if (!p.rel.firm) { // without at, on a body: taken again on each pass of the first frame, kept from its last
			p.rel.c = k.at ?? qRotate(qConj(car.q), sub(p.rel.from.c, car.c));
			p.rel.q = k.at ? (k.axis ? qAxisAngle(norm(k.axis), rad(k.deg ?? 0)) : [0, 0, 0, 1]) : qMul(qConj(car.q), p.rel.from.q);
			p.rel.firm = !body || !!k.at || final;
			k.entry.rel = { c: p.rel.c, q: p.rel.q };
		}
		p.rideAt = f;
		p.c = add(car.c, qRotate(car.q, p.rel.c)); p.q = qMul(car.q, p.rel.q);
	};
	for (const p of Object.values(props)) if (p.ride) move(p);
}

/** The ride keys of the props, checked (checkRides), as { rides } for engine.js's aux, or {} when there is none: per key
 *  its carrier, its next key's frame, whether at was given, and, filled in as the clip is built (moveRiders), the frame
 *  it began (null: never) and its place on the carrier ({ c, q } in the carrier's frame), which the rows read (measure.mjs). */
export function ridesOf(props, byId) {
	const rides = Object.values(props).flatMap(p => { checkRides(p, byId); return p.keys.filter(k => k.verb === "ride").map(k => (k.entry = {
		prop: p.id, f: k.f, ...(k.joint === undefined ? { on: k.on } : { joint: k.joint, of: k.of }), at: !!k.at, next: p.keys.find(n => n.f > k.f)?.f ?? null, began: null, rel: null,
	})); });
	return rides.length ? { rides } : {};
}
