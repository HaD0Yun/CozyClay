// The prop layer's own keys (engine.js): where a move or tip key puts a free prop on a frame, and whether a prop is
// shown. A key starts from where the key before it puts the prop on the key's own frame when that key drove the prop
// on the frame before (it ended there or is cut into), as the upper layer's fields start from the key before (flow.js),
// so a prop keyed key after key never stands still for a frame between them; after anything else (a hold, a ride, a
// flight, the scene) it starts from where the prop is. hide / show keys are kept apart from the motion keys: they say
// only whether the prop is drawn from their frame on.
import { qAxisAngle } from "../rig17.js";
import { EASE, add, mixV, norm, qMul, qRotate, rad, sub } from "./math.js";

/** Verbs of the prop layer that only show or hide the prop. */
const SHOWN = new Set(["hide", "show"]);

/** A prop's actions of the spec as { keys: its motion keys, shownKeys: its hide / show keys }, each by frame. */
export const propKeys = acts => ({
	keys: acts.filter(a => !SHOWN.has(a[1])).map(([f, verb, o = {}]) => ({ f, verb, ...o })).sort((a, b) => a.f - b.f),
	shownKeys: acts.filter(a => SHOWN.has(a[1])).map(([f, verb]) => ({ f, verb })).sort((a, b) => a.f - b.f),
});

/** The place and turn { c, q } key k gives its prop on frame f (k.c0, k.q0: where it starts). over: 0 = there at once. */
function placeOf(k, f) {
	const over = k.over ?? 12, u = EASE[k.ease ?? "inout"](over > 0 ? (f - k.f) / over : 1), r = k.axis ? qAxisAngle(norm(k.axis), rad(k.deg) * u) : [0, 0, 0, 1];
	return { c: k.verb === "tip" ? add(k.pivot, qRotate(r, sub(k.c0, k.pivot))) : k.to ? mixV(k.c0, k.to, u) : k.c0, q: qMul(r, k.q0) };
}

/** The place and turn { c, q } that key k (one of p.keys, driving free prop p on frame f) gives p on frame f. */
export function keyPose(p, k, f) {
	if (!k.c0) {
		const prev = p.keys[p.keys.indexOf(k) - 1], from = prev && p.drove === prev && p.droveAt === f - 1 ? placeOf(prev, f) : { c: p.c, q: p.q };
		k.c0 = from.c.slice(); k.q0 = from.q.slice();
	}
	p.drove = k; p.droveAt = f;
	return placeOf(k, f);
}

/** 1 when prop p (its hide / show keys in p.shownKeys, by frame) is drawn on frame f, else 0: shown until a hide key. */
export const shownAt = (p, f) => (p.shownKeys.findLast(k => k.f <= f)?.verb === "hide" ? 0 : 1);
