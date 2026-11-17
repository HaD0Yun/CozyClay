// The prop layer's ride {on: propId}: from the key's frame the prop keeps the place and turn it has on the carrier,
// however the carrier is carried, held or keyed, until a later key of its own or until a hand takes it (hold, carry).
// A ride key written while a hand holds the prop starts when the hand lets go. Riders move after the carriers' keys,
// after the first pass of the figures and after the second (share.js, engine.js), so they follow the carrier's pose of
// that same frame and a place on them is current for each pass; the place on the carrier is taken once per ride.
import { add, qConj, qMul, qRotate, sub } from "./math.js";

/** The key that drives free prop p on frame f (null while a hand holds it or while it rides) and its ride in p.ride.
 *  p.takenAt: the last frame a hand took the prop. */
export function propKey(p, f) {
	const k = p.keys.findLast(k => k.f <= f), riding = k?.verb === "ride";
	p.ride = riding && !p.holder && !(p.takenAt >= k.f) ? k : null;
	return p.holder || riding ? null : k;
}

/** Moves every riding prop onto its carrier for frame f; a carrier that rides on another moves first. */
export function moveRiders(props, f) {
	const done = new Set();
	const move = p => {
		if (done.has(p.id)) return;
		done.add(p.id);
		const car = props[p.ride.on];
		if (!car || car === p) throw new Error(`engine-simple: ${p.id} ride wants {on: <another prop id>}, got ${JSON.stringify(p.ride.on)}`);
		if (!p.moves) throw new Error(`engine-simple: ${p.id} rides on ${car.id} but has no moves: true in the scene`);
		if (car.ride) move(car);
		if (!(p.rideAt >= f - 1) || p.rel.k !== p.ride) p.rel = { k: p.ride, c: qRotate(qConj(car.q), sub(p.c, car.c)), q: qMul(qConj(car.q), p.q) };
		p.rideAt = f;
		p.c = add(car.c, qRotate(car.q, p.rel.c)); p.q = qMul(car.q, p.rel.q);
	};
	for (const p of Object.values(props)) if (p.ride) move(p);
}
