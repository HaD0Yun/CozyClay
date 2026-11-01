// Key density by span: free motion is sparse and MotionBricks fills it; hand/foot contact and flight are authored densely.
// The take's frames are classed from the compiled curve: contact (a hand or foot on an anchor, or a goal / checks.contacts
// naming one, +-2 frames), flight (both feet more than 5 cm above the lowest authored ankle for 4+ frames, +-2), else free.
// Notes name keys[n] like QA hints:
//   KEYS_TOO_DENSE  two authored keys closer than 19 frames in a free span (no room for the fill; the keys stay)
//   CONTACT_UNKEYED two authored keys more than 8 frames apart while a hand or foot moves more than 2 cm in a contact, or more than 12
//                   frames apart across a held contact (held effectors repeat their coordinates every 8-12 frames)
//   FLIGHT_UNKEYED  a jump without its Entry (~0.2 s before takeoff), Apex and Exit (~0.4 s after landing) keys (upstream's jump primitive)
//   HAND_COORDS_FREE hand_l/r coordinates on keys in free motion (no contact there) with the arm on IK: one note naming them (deep research 8:
//                   D's sit keyed hand coordinates on 61-76% of keys, the reference sessions 32%, and they dragged the hands as the pelvis moved)
import { floorAnkle, limbContact, FLIGHT_MIN } from "./fill-spans.js";
import { isFillKey } from "./fill-src.js";

const PAD = 2, LIFT = 0.05, MOVE_MIN = 0.02, HELD_MAX = 12, FREE_MIN = 19, CONTACT_MAX = 8, ENTRY = 5, EXIT = 10; // entry ~0.2 s before takeoff, exit ~0.4 s after landing
const rangeOf = at => (Array.isArray(at) ? [at[0], at[1]] : Number.isFinite(at) ? [at, at] : null);

/** Per-frame kinds ("contact" > "flight" > "free") and their runs as spans [{ f0, f1, kind }]. */
export function classifySpans(spec, baked, frames) {
	const kind = new Array(frames).fill("free"), mark = (a, b, k) => {
		for (let f = Math.max(0, a - PAD); f <= Math.min(frames - 1, b + PAD); f++) if (kind[f] !== "contact") kind[f] = k;
	};
	const floor = floorAnkle((spec.keys ?? []).filter(k => !isFillKey(k)));
	if (floor !== null) {
		let start = -1;
		for (let f = 0; f <= frames; f++) {
			const up = f < frames && baked.foot_l?.[f]?.[1] > floor + LIFT && baked.foot_r?.[f]?.[1] > floor + LIFT;
			if (up && start < 0) start = f;
			if (!up && start >= 0) { if (f - start >= FLIGHT_MIN) mark(start, f - 1, "flight"); start = -1; }
		}
	}
	const contact = [];
	for (const [ch, values] of Object.entries(baked)) if (/^w_.+_[lr]$/.test(ch)) values.forEach((v, f) => { if (v > 0.5) contact.push([f, f]); });
	for (const goal of spec.goals ?? []) { const r = rangeOf(goal.at); if (r && limbContact([goal.near, goal.above, goal.still], r, baked, floor)) contact.push(r); }
	for (const check of spec.checks?.contacts ?? []) { const r = rangeOf(check.when); if (r && limbContact(check.point, r, baked, floor)) contact.push(r); }
	for (const [a, b] of contact) for (let f = Math.max(0, a - PAD); f <= Math.min(frames - 1, b + PAD); f++) kind[f] = "contact";
	const spans = [];
	kind.forEach((k, f) => { if (spans.at(-1)?.kind === k) spans.at(-1).f1 = f; else spans.push({ f0: f, f1: f, kind: k }); });
	return { kind, spans };
}

/** How far a hand or foot target travels between frames a and b (m); a hand on an anchor the whole time counts as still. */
function effectorMoves(baked, a, b) {
	let most = 0;
	for (const [ch, side] of [["hand_l", "l"], ["hand_r", "r"], ["foot_l", "l"], ["foot_r", "r"]]) {
		const values = baked[ch];
		if (!values?.[a]) continue;
		const held = ch.startsWith("hand") && Object.entries(baked).some(([w, v]) => new RegExp(`^w_.+_${side}$`).test(w) && v.slice(a, b + 1).every(x => x > 0.5));
		if (held) continue;
		for (let f = a; f <= b; f++) most = Math.max(most, Math.hypot(...values[f].map((x, i) => x - values[a][i])));
	}
	return most;
}

/** The density notes for the spec's keys (indices as stored: QA's keys[n]). */
export function densityNotes(keys, kind, spans, baked) {
	const authored = keys.map((k, i) => ({ k, i })).filter(({ k }) => !isFillKey(k)), notes = [];
	const name = ({ k, i }) => `keys[${i}] f${k.f}`;
	for (let n = 1; n < authored.length; n++) {
		const a = authored[n - 1], b = authored[n], gap = b.k.f - a.k.f;
		if (gap <= 0) continue;
		const inside = kind.slice(a.k.f, b.k.f + 1);
		if (gap < FREE_MIN && inside.every(k => k === "free")) notes.push(`KEYS_TOO_DENSE no room for the fill between ${name(a)} and ${name(b)} (${gap} frames; free motion keys every 19-24 frames, remove one)`);
		// across a plant (not only its +-2 padding), and only while a hand or foot MOVES there (> 2 cm): an effector held still or on an
		// anchor needs its two keys, not dense ones (research 1b: dense keys over a static hold ballooned box carry to 37 keys)
		// a held one is keyed again every 8-12 frames (hand-keyed motion keys contacts every 8 frames even when still): > 12 frames is unkeyed
		const across = inside.filter(k => k === "contact").length > 2 * PAD + 1, moves = across && gap > CONTACT_MAX && effectorMoves(baked, a.k.f, b.k.f) > MOVE_MIN;
		if (moves) notes.push(`CONTACT_UNKEYED ${name(a)} and ${name(b)} are ${gap} frames apart while a hand or foot moves in a contact; key it at least every ${CONTACT_MAX} frames`);
		else if (across && gap > HELD_MAX) notes.push(`CONTACT_UNKEYED ${name(a)} and ${name(b)} are ${gap} frames apart across a held contact; repeat the held coordinates every 8-12 frames`);
	}
	const near = f => authored.some(({ k }) => Math.abs(k.f - f) <= PAD);
	const within = (lo, hi) => authored.some(({ k }) => k.f >= lo && k.f <= hi);
	for (const span of spans.filter(s => s.kind === "flight")) {
		const takeoff = span.f0 + PAD, land = Math.max(takeoff, span.f1 - PAD);
		let apex = takeoff;
		for (let f = takeoff; f <= land; f++) if ((baked.root?.[f]?.[1] ?? 0) > (baked.root?.[apex]?.[1] ?? 0)) apex = f;
		const missing = [!near(apex) && `Apex (about f${apex})`, !within(takeoff - ENTRY - 3, takeoff - 2) && `Entry (about f${takeoff - ENTRY}, ~0.2 s before takeoff)`,
			!within(land + EXIT - 4, land + EXIT + 4) && `Exit (about f${land + EXIT}, ~0.4 s after landing)`].filter(Boolean);
		if (missing.length) notes.push(`FLIGHT_UNKEYED the jump f${takeoff}-f${land} needs Entry, Apex and Exit keys; missing ${missing.join(", ")}; write those poses`);
	}
	const free = authored.filter(({ k }) => kind[k.f] === "free" && ["l", "r"].some(q => k.set?.[`hand_${q}`] !== undefined && baked[`armw_${q}`]?.[k.f] > 0.5));
	if (free.length) notes.push(`HAND_COORDS_FREE ${free.map(name).join(", ")}: hand coordinates in free motion; prefer FK (aswing/abend), or an anchor for a plant`);
	return notes;
}
