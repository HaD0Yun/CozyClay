// Contact and flight classes for the fill route. A gap keeps the compiler's curve only under a checks.clearance span (check_span);
// hand plants and flights go through the model like upstream: the fill pins planted hands to the anchor (fill.js pinHands) and a
// jump needs Entry / Apex / Exit keys (fill-density.js FLIGHT_UNKEYED). limbContact and floorAnkle are the shared classifiers:
//   contact: a hand on an anchor or a goal / checks.contacts naming a hand, or a foot off the floor (on a support)
//   flight:  both feet more than 5 cm above the take's lowest authored ankle for 4+ frames (a stride's 2-3 frames is not a flight)
const LIFT = 0.05;
export const FLIGHT_MIN = 4;
const HAND = /hand|wrist|finger|thumb|index|palm/i, FOOT = /foot|toe|ankle/i;

/**
 * Whether a goal or contacts check names a limb in contact over [a, b]: any hand, or a foot that is off the floor there (on a
 * support, more than 5 cm above the take's floor ankle). A foot "landed / still" on the floor is locomotion, not a plant.
 */
export function limbContact(refs, [a, b], baked, floor) {
	const text = JSON.stringify(refs ?? "");
	if (HAND.test(text)) return true;
	if (!FOOT.test(text) || floor === null) return false;
	const sides = /left/i.test(text) && !/right/i.test(text) ? ["foot_l"] : /right/i.test(text) && !/left/i.test(text) ? ["foot_r"] : ["foot_l", "foot_r"];
	for (let f = Math.max(0, a); f <= b; f++) if (sides.some(ch => baked[ch]?.[f]?.[1] > floor + LIFT)) return true;
	return false;
}

const rangeOf = (at, frames) => (Array.isArray(at) ? [at[0], at[1]] : Number.isFinite(at) ? [at, at] : [0, frames - 1]);
// a span covers a gap when it overlaps its inside (a span that only meets the gap at a shared key frame does not); a one-frame
// contact on a key frame touches both gaps beside that key
const touches = ([a, b], fa, fb) => (a === b ? a >= fa && a <= fb : a < fb && b > fa);

/** The ankle height of a foot on the floor in this take: the lowest foot target any authored key sets. */
export function floorAnkle(keys) {
	const ys = keys.flatMap(k => ["foot_l", "foot_r"].map(ch => k.set?.[ch]?.[1]).filter(Number.isFinite));
	return ys.length ? Math.min(...ys) : null;
}

/** Why gap fa-fb stays the compiler's ("hand_contact" | "airborne" | "check_span"), or null. keys: the spec's authored keys. */
export function spanReason(spec, keys, baked, fa, fb) {
	// hand plants and flights run through the model now (the fill pins the hands, fill.js pinHands; jumps carry Entry / Apex /
	// Exit keys, fill-density.js); only a checked clearance span keeps the compiler's curve
	const frames = Number.isFinite(spec.frames) ? spec.frames : fb + 1;
	// a span is a clearance check with its own frames, under half the take; one over the whole take is a guard, not a span
	// (the span-density bench: a whole-take clearance made every gap check_span and the model never ran)
	for (const check of spec.checks?.clearance ?? []) {
		if (!Array.isArray(check.frames) && !Number.isFinite(check.frames)) continue;
		const span = rangeOf(check.frames, frames);
		if (span[1] - span[0] + 1 <= frames / 2 && touches(span, fa, fb)) return "check_span";
	}
	return null;
}
