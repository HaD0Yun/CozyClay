// The prop layer's ride: from the key's frame the prop keeps a place and turn on its carrier, another prop
// (ride {on: propId}) or a joint of a character's body (ride {joint, of: characterId}), however the carrier moves, until
// a later key of its own or until a hand takes it off (hold, carry). A ride that has not begun when a hand holds the prop
// (written while it is held, or taken on the key's own frame) begins on the first frame no hand holds it. Riders move
// after the carriers' keys, after the first pass of the figures and after the second (share.js, engine.js), so they
// follow the carrier's pose of that same frame and a place on them is current for each pass; on the frame a hand takes
// one off it is still carried there once, at the start of the frame, and the hand has it from there. The place is taken
// once per ride: `at` (the prop's centre in the carrier's own frame, its axes along the carrier's turned `deg` about
// `axis`), else where the prop is on the carrier as both ended the frame before the ride begins (on frame 0: against a
// prop as it stands after its keys, against a joint as the body ended that frame). A ride with `at` that begins after
// frame 0 goes there on the carrier from that place, counted from the frame before, in its `over` frames with its `ease`
// (prop-keys.js eased; default 12 frames and no later than the prop's next key, inout; 0 or 1 = there on its first
// frame), so the prop keeps a continuous place and turn whatever had it before, and ride keys written a frame apart
// put it on each key's place on that key's frame.
import { INDEX as J, qAxisAngle } from "../rig17.js";
import { EASE, add, len, mixV, norm, qConj, qMul, qRotate, qSlerp, qY, rad, sub } from "./math.js";
import { eased } from "./prop-keys.js";
import { solveSized } from "./size.js";

/** The key that drives free prop p on frame f (null while a hand holds it, while it rides, and for a key of its own
 *  that a hand took the prop off: let go, the prop stays where it is until a later key of its own) and its ride in p.ride.
 *  k.off: the frame a hand took the prop off that ride (it rode the frame before); the ride is over from then on. On
 *  that frame the ride that carried it the frame before carries it once more (moveRiders), whatever key starts there.
 *  A key of the prop's own that moves it over some frames (tip, move) and starts on a frame the prop rode into: the
 *  ride carries the prop on that frame as well and the key drives it from the next one, from where the ride left it
 *  (prop-keys.js), so the prop does not stand still for a frame while its carrier moves on. */
export function propKey(p, f) {
	const k = p.keys.findLast(k => k.f <= f), riding = k?.verb === "ride", took = p.holder && p.rideAt === f - 1 ? p.rel?.k : null;
	if (took) took.off ??= f;
	const into = !p.holder && !riding && k?.f === f && k.verb !== "launch" && (k.over ?? 12) > 0 && p.rideAt === f - 1 && p.rel.k.off == null ? p.rel.k : null;
	p.ride = took?.off === f ? took : into ?? (riding && !p.holder && k.off == null ? k : null);
	const left = !!k?.c0 && p.droveAt !== f - 1; // a key that drove the prop and not on the frame before: a hand had it since, and it stays where that hand let it go
	return p.holder || riding || into || left ? null : k;
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
		if ((k.deg !== undefined || k.axis !== undefined) && !(Number.isFinite(k.deg) && vec(k.axis) && len(k.axis) > 1e-9)) throw bad(`deg wants a number and axis: [x, y, z], got deg ${JSON.stringify(k.deg)}, axis ${JSON.stringify(k.axis)}`);
		if (k.deg !== undefined && k.at === undefined) throw bad("axis and deg turn the prop on its at; without at it keeps the turn it has when the ride begins: give at, or leave axis and deg out");
		if (k.over !== undefined && !(Number.isFinite(k.over) && k.over >= 0)) throw bad(`over wants a count of frames, 0 or more, got ${JSON.stringify(k.over)}`);
		if (k.ease !== undefined && !Object.hasOwn(EASE, k.ease)) throw bad(`ease wants one of ${Object.keys(EASE).join(", ")}, got ${JSON.stringify(k.ease)}`);
	}
}

/** Moves every riding prop onto its carrier for frame f; a carrier that rides on another moves first. byId: the
 *  characters by id; final: the bodies as they ended the frame (the last call of the frame). A prop a hand took off this
 *  frame moves on the first call only. p.end: each prop as it ended the frame (kept by the final call). */
export function moveRiders(props, f, byId = {}, final = false) {
	const done = new Set();
	const move = p => {
		if (done.has(p.id)) return;
		done.add(p.id);
		const k = p.ride, body = k.joint !== undefined, car = body ? jointFrame(byId[k.of], J[k.joint], f, final) : props[k.on];
		if (!car || car === p) throw new Error(`engine-simple: ${p.id} ride wants {on: <another prop id>}, got ${JSON.stringify(k.on)}`);
		if (!p.moves) throw new Error(`engine-simple: ${p.id} rides on ${body ? `${k.of}'s ${k.joint}` : car.id} but has no moves: true in the scene`);
		if (car.ride) move(car);
		if (!(p.rideAt >= f - 1) || p.rel.k !== k) { // it begins; without at its place is taken against the carrier as it ended the frame before
			const o = byId[k.of], before = f > 0 && (body ? o.world && { c: o.world.pos[J[k.joint]], q: o.world.quat[J[k.joint]] } : car.end);
			p.rel = { k, f, from: { c: p.c.slice(), q: p.q.slice() }, before }; k.entry.began ??= f;
		}
		if (!p.rel.firm) { // without at, on a body on frame 0: taken again on each pass of that frame, kept from its last
			const at = p.rel.before || car, was = { c: qRotate(qConj(at.q), sub(p.rel.from.c, at.c)), q: qMul(qConj(at.q), p.rel.from.q) };
			p.rel.c = k.at ?? was.c;
			p.rel.q = k.at ? (k.axis ? qAxisAngle(norm(k.axis), rad(k.deg)) : [0, 0, 0, 1]) : was.q;
			// with at after frame 0 it goes there from where it was on the frame before: in over frames, by default 12 and
			// no later than the prop's next key (keys a frame apart are each there on their frame)
			p.rel.was = k.at && p.rel.before ? was : null;
			p.rel.over = k.over ?? Math.min(12, (k.entry.next ?? Infinity) - f);
			p.rel.firm = !body || !!k.at || !!p.rel.before || final;
			k.entry.rel = { c: p.rel.c, q: p.rel.q }; k.entry.over = p.rel.was ? p.rel.over : 0;
		}
		p.rideAt = f;
		const u = p.rel.was ? eased({ over: p.rel.over, ease: k.ease }, f, p.rel.f - 1) : 1, c = u < 1 ? mixV(p.rel.was.c, p.rel.c, u) : p.rel.c, q = u < 1 ? qSlerp(p.rel.was.q, p.rel.q, u) : p.rel.q;
		p.c = add(car.c, qRotate(car.q, c)); p.q = qMul(car.q, q);
		const z = qRotate(p.q, [0, 0, 1]);
		p.yaw = Math.atan2(z[0], z[2]); // its heading, which a carry keeps against the line of the hands (engine.js)
	};
	for (const p of Object.values(props)) if (p.ride) move(p);
	for (const p of Object.values(props)) if (p.holder) p.ride = null;
	if (final) for (const p of Object.values(props)) p.end = { c: p.c.slice(), q: p.q.slice() };
}

/** What carries prop p as the frame ended, as ids (the clip's per-frame `by`, clip.js): the characters whose hands hold
 *  it (one hand, a carry or a push of one character, or every character of a shared hold), else the character whose
 *  joint or the prop it rides; [] when nothing does (it stands, moves by its own keys or flies). */
export function carriersOf(p) {
	if (p.grips?.length) return [...new Set(p.grips.map(g => g.c.id))];
	if (p.holder) return [p.holder];
	return p.ride ? [p.ride.joint === undefined ? p.ride.on : p.ride.of] : [];
}

/** The ride keys of the props, checked (checkRides), as { rides } for engine.js's aux, or {} when there is none: per key
 *  its carrier, its next key's frame, whether at was given, the frames its way to at took (over: 0 at once, null never began), the verb of a key of the prop written after it on its own
 *  frame (hidden: that key drives the prop, the ride never does), and, filled in as the clip is built (moveRiders), the
 *  frame it began (null: never) and its place on the carrier ({ c, q } in the carrier's frame), which the rows read (measure.mjs). */
export function ridesOf(props, byId) {
	const rides = Object.values(props).flatMap(p => { checkRides(p, byId); return p.keys.filter(k => k.verb === "ride").map(k => (k.entry = {
		prop: p.id, f: k.f, ...(k.joint === undefined ? { on: k.on } : { joint: k.joint, of: k.of }), at: !!k.at, over: null, next: p.keys.find(n => n.f > k.f)?.f ?? null, began: null, rel: null,
		hidden: p.keys.findLast(n => n.f === k.f) === k ? null : p.keys.findLast(n => n.f === k.f).verb,
	})); });
	return rides.length ? { rides } : {};
}
