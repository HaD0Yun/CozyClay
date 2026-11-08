// Which frames a v4 render shows (design 3.4). Pure over Out (the frames the track store builds).
//   events  takeoff, apex and landing of each air run; contact on and off of the palms and soles;
//           the COM low and high; the first and last frame. Kept by that priority, at least 3
//           frames apart, then filled with even frames up to count, ascending.
//   even    count frames spread evenly, both ends included.
//   [list]  the frames as given, clamped to the take.
import { centerOfMass } from "../../motion3/qa/com.js";
import { airRuns } from "../../motion3/qa/style.js";
import { solePoints, sdBox } from "../../motion3/qa/geometry.js";

/** Within this gap (m) of the floor or a box a palm or sole touches it. */
const TOUCH = 0.02;
const APART = 3, MIN_RUN = 2, LONG_RUN = 9;
const ENDS = [["palm_l", "Left", "palm"], ["palm_r", "Right", "palm"], ["sole_l", "Left", "sole"], ["sole_r", "Right", "sole"]];

/**
 * The contact end points of frame f: [{ end, key, p, gap, against }] for palm_l, palm_r, sole_l,
 * sole_r. A palm is the midpoint of the wrist and the middle knuckle; a sole is its heel, ball or
 * tip point (qa/geometry.js solePoints), whichever is nearest a surface. gap is the signed distance
 * (m) to the floor (y = 0) or a scene box (negative inside), against its id or "floor".
 */
export function contactPoints(out, f) {
	const sk = out.ctx.sk, s = out.frames[f].s, I = sk.index;
	const boxes = Object.entries(out.objectsAt?.(f) ?? {}).filter(([, b]) => b?.half && !b.ignore);
	return ENDS.map(([end, S, kind]) => {
		const points = kind === "palm" ? { palm: s.P[I[`${S}Hand`]].map((v, i) => (v + s.P[I[`${S}HandMiddle1`]][i]) / 2) } : solePoints(sk, s, S);
		let best = null;
		for (const [key, p] of Object.entries(points)) {
			if (!best || p[1] < best.gap) best = { end, key, p, gap: p[1], against: "floor" };
			for (const [id, b] of boxes) { const d = sdBox(p, b); if (d < best.gap) best = { end, key, p, gap: d, against: id }; }
		}
		return best;
	});
}

/** n frames spread evenly over a..b, both ends included (fewer when the range is shorter). */
function evenFrames(a, b, n) {
	const k = Math.max(1, Math.min(n, b - a + 1));
	return k === 1 ? [a] : Array.from({ length: k }, (_, i) => a + Math.round((i * (b - a)) / (k - 1)));
}

/** Contact runs of 2+ frames inside a..b per end: on (unless at a), off (unless at b), mid of a long run. */
function contactEvents(out, a, b, ends) {
	const rows = [];
	for (let f = a; f <= b; f++) rows.push(contactPoints(out, f));
	const events = [];
	ENDS.forEach(([end], k) => {
		if (ends && !ends.includes(end)) return;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i][k].gap > TOUCH) continue;
			let j = i;
			while (j + 1 < rows.length && rows[j + 1][k].gap <= TOUCH) j++;
			if (j - i + 1 >= MIN_RUN) {
				if (i > 0) events.push({ f: a + i, why: `${end} on ${rows[i][k].against}`, end });
				if (j < rows.length - 1) events.push({ f: a + j, why: `${end} off`, end });
				if (ends && j - i + 1 >= LONG_RUN) events.push({ f: a + Math.round((i + j) / 2), why: `${end} mid`, end, tier: 1 });
			}
			i = j;
		}
	});
	return events.sort((x, y) => (x.tier ?? 0) - (y.tier ?? 0) || x.f - y.f).map(({ tier, ...e }) => e);
}

/** Every candidate frame in priority order: air events, contact events, COM extremes, first and last. */
function candidates(out, a, b) {
	const sk = out.ctx.sk, com = [];
	for (let f = a; f <= b; f++) com.push(centerOfMass(sk, out.frames[f].s)?.[1] ?? out.frames[f].s.P[sk.index.Hips][1]);
	const air = [], last = out.frames.length - 1;
	for (const [r0, r1] of airRuns(out)) {
		if (r1 < a || r0 > b) continue;
		let apex = Math.max(r0, a);
		for (let f = apex; f <= Math.min(r1, b); f++) if (com[f - a] > com[apex - a]) apex = f;
		air.push({ f: Math.max(0, r0 - 1), why: "takeoff" }, { f: apex, why: "apex" }, { f: Math.min(last, r1 + 1), why: "landing" });
	}
	const low = com.indexOf(Math.min(...com)), high = com.indexOf(Math.max(...com));
	return [...air, ...contactEvents(out, a, b), { f: a + low, why: "com low" }, { f: a + high, why: "com high" }, { f: a, why: "first" }, { f: b, why: "last" }];
}

/**
 * pickFrames(out, { mode = "events", count = 8, from, to, ends }) -> [{ f, why, end? }] ascending.
 * mode "events", "even" or an integer list. With ends (e.g. ["palm_l", "palm_r"]) "events" answers
 * only the contact events of those ends (on, off, mid of a long run), maybe none, with no fill.
 */
export function pickFrames(out, { mode = "events", count = 8, from = 0, to, ends } = {}) {
	const last = out.frames.length - 1, clamp = f => Math.max(0, Math.min(last, Math.round(f)));
	if (last < 0) throw new Error("pickFrames: the take has no frames.");
	if (Array.isArray(mode)) return mode.map(f => ({ f: clamp(f), why: "asked" }));
	const a = clamp(from ?? 0), b = clamp(to ?? last);
	if (a > b) throw new Error(`from ${a} is after to ${b}.`);
	if (mode === "even") return evenFrames(a, b, count).map(f => ({ f, why: "even" }));
	if (mode !== "events") throw new Error(`frames must be "events", "even" or a list of frame numbers; got ${JSON.stringify(mode)}.`);
	// With ends the 3-frame spacing holds per end: both feet may show the same frame.
	const picks = [], apart = c => picks.every(p => (ends && p.end !== c.end) || Math.abs(p.f - c.f) >= APART);
	const keep = c => { if (picks.length < count && c.f >= a && c.f <= b && apart(c)) picks.push(c); };
	if (ends) contactEvents(out, a, b, ends).forEach(keep);
	else {
		candidates(out, a, b).forEach(keep);
		for (const n of [count, count * 2, count * 4]) evenFrames(a, b, n).forEach(f => keep({ f, why: "even" }));
	}
	return picks.sort((x, y) => x.f - y.f || String(x.end).localeCompare(String(y.end)));
}
