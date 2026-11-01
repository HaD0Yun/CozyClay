// Hands that hold a carried object keep the author's curve inside a MotionBricks fill. The model does not see scene objects
// (MotionBricks paper, Sec. 8.1: object interaction is not modelled), so between two keys its hands drift off a held box
// (stairs + box bench, 2026-10-31: REACH 32 and the box left hanging in every gated-off take). pinHands (fill.js) holds a hand
// planted on an anchor; this does the same for a carry: from an object's grab to its release (spec.objects.<id> with a prop on
// a hand), the carrying hand, and the other hand when the authored keys at both gap ends give it an IK target (a two-hand
// hold), follow the compiled curve of the authored hand keys instead of the model's hand. The body and legs stay the model's.
const EASE = 4; // frames from the grab over which the hand blends from the model onto the author's curve
// frames after the grab over which the target goes from the world curve to the body frame: the lift off a support follows the
// author's path (the body dipping as it takes the weight sank the box 9 mm into the table), the carry rides the body
const LIFT = 12;
const smooth = t => t * t * (3 - 2 * t);

/** Carry spans of a spec: [{ hand: "l" | "r", f0, f1 }] from objects with a prop on a hand and a grab frame. */
function carrySpans(spec) {
	const out = [];
	for (const o of Object.values(spec?.objects ?? {})) {
		const hand = spec.props?.[o?.prop]?.hand;
		if ((hand !== "l" && hand !== "r") || !Number.isFinite(o.grab)) continue;
		out.push({ hand, f0: o.grab, f1: Number.isFinite(o.release) ? o.release : Infinity });
	}
	return out;
}

const turn = (v, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), n = Math.sin(a); return [v[0] * c + v[2] * n, v[1], -v[0] * n + v[2] * c]; };
/** A hand target in the body frame (root position, root yaw) at frame f of the compiled channels, or null. */
const bodyLocal = (baked, ch, f) => { const r = baked?.root?.[f], h = baked?.[ch]?.[f]; return r && h ? turn([h[0] - r[0], h[1] - r[1], h[2] - r[2]], -(baked.yaw?.[f] ?? 0)) : null; };

/** A hand keyed at frame f on the IK arm. armw holds from the last key that set it: the guide sets it on the first key only. */
const ikHand = (authored, f, k) => {
	if (!authored.some(key => key.f === f && Array.isArray(key.set?.[`hand_${k}`]))) return false;
	const weight = authored.filter(key => key.f <= f && key.set?.[`armw_${k}`] !== undefined).sort((a, b) => a.f - b.f).at(-1)?.set[`armw_${k}`];
	return (weight ?? 0) >= 0.5;
};

/**
 * dense: the fill's rows for spec frames fa..fb (row i is frame fa + i). baked: the compiled channels of the spec without this
 * gap's fill. The hand goes where the authored keys put it relative to the body (root and yaw), blended across the gap and
 * placed on the model's body of that frame: a held box turns and climbs with the body, and two hands keyed on its sides stay
 * that far apart through a turn (a straight world-space line between two keys 90 degrees apart cut the corner and closed the
 * hands into the box). Without root and yaw (a test row) the compiled hand curve is used. Returns dense, changed in place.
 */
export function carryHands(dense, fa, fb, spec, authored, baked) {
	for (const span of carrySpans(spec)) {
		const lo = Math.max(fa, span.f0), hi = Math.min(fb, span.f1);
		if (lo > hi) continue;
		const other = span.hand === "l" ? "r" : "l", hands = ikHand(authored, fa, other) && ikHand(authored, fb, other) ? [span.hand, other] : [span.hand];
		for (const k of hands) {
			const ch = `hand_${k}`, curve = baked?.[ch], a = bodyLocal(baked, ch, fa), b = bodyLocal(baked, ch, fb);
			if (!curve) continue;
			for (let f = lo; f <= hi; f++) {
				const row = dense[f - fa], u = fb > fa ? (f - fa) / (fb - fa) : 0;
				const body = a && b && Array.isArray(row?.root) && Number.isFinite(row?.yaw) ? turn(a.map((v, i) => v + (b[i] - v) * u), row.yaw).map((v, i) => v + row.root[i]) : null;
				const t = smooth(Math.min(1, Math.max(0, (f - span.f0) / LIFT))), want = body && Array.isArray(curve[f]) ? curve[f].map((v, i) => v + (body[i] - v) * t) : body ?? curve[f];
				if (!row || !Array.isArray(want)) continue;
				const w = smooth(Math.min(1, (f - span.f0 + 1) / EASE));
				row[ch] = Array.isArray(row[ch]) ? row[ch].map((v, i) => v + (want[i] - v) * w) : want.slice();
			}
		}
	}
	return dense;
}
