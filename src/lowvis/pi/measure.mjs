// The check numbers of a clip as rows, each with the frame of its worst value.
// checks.js (frozen) returns the numbers without frames, so this repeats its formulas and keeps the frame; compile-tool.mjs
// prints checkClip's own value and drops the frame of a row whose value here differs from it.
//
// The `inside:` rows are not in checks.js: a body or a moving prop inside another prop past a limit (inside.mjs).
// The `reach:` rows are not in checks.js either: a hand, a foot or an elbow that is not where its action put it (aux.reach).
// Nor the `seat:` rows: a sit on a prop whose hips end off the prop's top or whose feet stand inside it (aux.seats).
// Nor the `gap:` rows: a hand, a foot, the feet or a seat the spec puts on a prop with drawn parts, off them (gaps.mjs).
// Nor the `body:` rows: a hand or a foot on a body, a prop riding a joint, a body's limbs, against the drawn bodies (bodies.mjs).
// Nor the `jump:` rows: a body's Hips joint or a moving prop whose step between two frames is far from the steps around
// it (jumps.js), within a frame of a key of the spec.
//
// row: { key, label, short, value, unit, frame?, who?, prop?, note?, worse, spike?, word? }
//   short: the row's name on a sheet label
//   worse: 1 = a higher value is worse, -1 = a value below zero is worse, 0 = neither
//   spike: the value past which the row counts as a spike (compile-tool.mjs then shows the frames around `frame`)
import { INDEX as J, JOINTS, JOINT_COUNT } from "../rig17.js";
import { qConj, qMul, qRotate } from "../engine-simple/math.js";
import { MAX_STEP, SOLE, TOE } from "../engine-simple/solve.js";
import { PAD } from "../engine-simple/prop-frame.js";
import { reachWhy } from "./reach-why.mjs";
import { bodyRows } from "./bodies.mjs";
export { bodyText } from "./bodies.mjs";
export { airLines } from "../engine-simple/air-told.js"; // a body off the ground, for the tool's text
import { insideRows } from "./inside.mjs";
import { gapRows } from "./gaps.mjs";
import { JUMP, RIDE_TURN, groupJumps } from "../jumps.js";

const FEET = [J.LeftFoot, J.RightFoot], HANDS = [J.LeftHand, J.RightHand], SIDE = ["L", "R"];
const MM = 1000, DEG = 180 / Math.PI;
const num1 = v => String(Math.round(v * 10) / 10);

/** How bad a row's value is: its size when higher is worse, its depth below zero when lower is worse. */
export const badness = row => row.worse > 0 ? row.value : row.worse < 0 ? Math.max(0, -row.value) : 0;
export const isSpike = row => row.spike != null && row.frame != null && badness(row) > row.spike;

/** inside: { def, spec, look, bodies? } for the inside rows (inside.mjs) and, with bodies, the body rows (bodies.mjs); none without it. spec: the spec as built (repeats
 *  written out) for the jump rows; none without it. */
export function measure(clip, aux, { stretch = 0, inside = null, spec = null } = {}) {
	const F = clip.frameCount, rows = [];
	const propAt = (p, f) => { const i = p.pos.length === 3 ? 0 : f; return { c: p.pos.slice(i * 3, i * 3 + 3), q: p.quat.slice(i * 4, i * 4 + 4) }; };
	// a world point over (or under) a static prop's footprint, in the prop's own frame
	const over = (pt, s) => { const l = qRotate(qConj(s.quat.slice(0, 4)), [pt[0] - s.pos[0], 0, pt[2] - s.pos[2]]); return Math.abs(l[0]) <= s.size[0] / 2 && Math.abs(l[2]) <= s.size[2] / 2; };
	const toBox = (pt, p, f) => { const { c, q } = propAt(p, f), l = qRotate(qConj(q), [pt[0] - c[0], pt[1] - c[1], pt[2] - c[2]]).map((v, k) => Math.abs(v) - p.size[k] / 2); return Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)); };
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	// best(a, b, sign): keeps the larger (sign 1) or smaller (sign -1) of two { v, ... } records
	const best = (a, b, sign = 1) => !a || (b.v - a.v) * sign > 0 ? b : a;
	const row = (key, label, rec, unit, scale, extra) => rec && rows.push({ key, label, value: rec.v * scale, unit, frame: rec.f, who: rec.who, prop: rec.prop, note: rec.note, ...extra });

	rows.push({ key: "stretch", label: "bone stretch", value: stretch * MM, unit: "mm", worse: 1 });
	let head, elbow, wrist, jointLow, footLow, slide, slideStep;
	for (const c of clip.characters) {
		for (let f = 0; f < F; f++) {
			for (let j = 0; j < JOINT_COUNT; j++) jointLow = best(jointLow, { v: at(c, f, j)[1], f, who: c.id, note: JOINTS[j] }, -1);
			if (!f) continue;
			const q = rot(c, f, J.Head), p = rot(c, f - 1, J.Head), sp = j => dist(at(c, f, j), at(c, f - 1, j));
			head = best(head, { v: 2 * Math.acos(Math.min(1, Math.abs(q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] * p[3]))), f, who: c.id });
			elbow = best(elbow, { v: Math.max(sp(J.LeftForeArm), sp(J.RightForeArm)), f, who: c.id });
			wrist = best(wrist, { v: Math.max(sp(J.LeftHand), sp(J.RightHand)), f, who: c.id });
		}
		FEET.forEach((j, side) => {
			let sum = 0, prev = null;
			for (let f = 0; f < F; f++) {
				const pts = [TOE, SOLE].map(o => { const a = at(c, f, j), d = qRotate(rot(c, f, j), o), s = c.scale ?? 1; return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s]; }); // the toe tip and the sole of a foot of the body's size
				footLow = best(footLow, { v: Math.min(pts[0][1], pts[1][1]), f, who: c.id, note: SIDE[side] }, -1);
				if (!aux.contacts[c.id][f][side]) { sum = 0; prev = null; continue; }
				if (prev) {
					const step = Math.min(...pts.map((p, k) => dist(p, prev[k])));
					sum += step;
					slideStep = best(slideStep, { v: step, f, who: c.id, note: SIDE[side] }); slide = best(slide, { v: sum, f, who: c.id, note: SIDE[side] });
				}
				prev = pts;
			}
		});
	}
	row("slide", "foot slide in one plant", slide ?? { v: 0 }, "mm", MM, { short: "foot slide", worse: 1, spike: 20 });
	row("slideStep", "foot slide per frame", slideStep ?? { v: 0 }, "mm", MM, { short: "foot slide", worse: 1, spike: 5 });
	row("footLow", "lowest foot point", footLow, "mm", MM, { short: "under floor", worse: -1, spike: 10 });
	row("jointLow", "lowest joint", jointLow, "mm", MM, { short: "under floor", worse: -1, spike: 10 });

	let carryMin, carryMax, drift, turn, free = 0, freeAt;
	for (const p of clip.props) {
		if (p.pos.length === 3) continue;
		let ref = null;
		for (let f = 0; f < F; f++) {
			const holder = clip.characters.find(ch => ch.id === aux.holders[p.id][f]), g = aux.grips[p.id][f];
			if (f && !aux.holders[p.id][f] && !aux.holders[p.id][f - 1] && !aux.keyed[p.id][f]) { const d = dist(propAt(p, f).c, propAt(p, f - 1).c); free += d; if (d > 1e-6) freeAt ??= { f, prop: p.id }; }
			if (holder && !g) for (const j of HANDS) {
				const d = { v: toBox(at(holder, f, j), p, f), f, who: holder.id, prop: p.id, note: p.id };
				carryMin = best(carryMin, d, -1); carryMax = best(carryMax, d);
			}
			const c = g && clip.characters.find(ch => ch.id === g.c);
			if (!c) continue;
			const j = HANDS[g.hand], hq = qConj(rot(c, f, j)), { c: pc, q: pq } = propAt(p, f), h = at(c, f, j);
			const off = qRotate(hq, [pc[0] - h[0], pc[1] - h[1], pc[2] - h[2]]), axis = qRotate(hq, qRotate(pq, [0, 0, 1]));
			if (ref?.from !== g.from) ref = { off, axis, from: g.from }; // from where it lay in the hand when that hand took it
			drift = best(drift, { v: dist(off, ref.off), f, who: c.id, prop: p.id, note: p.id });
			turn = best(turn, { v: Math.asin(Math.min(1, Math.hypot(axis[1] * ref.axis[2] - axis[2] * ref.axis[1], axis[2] * ref.axis[0] - axis[0] * ref.axis[2], axis[0] * ref.axis[1] - axis[1] * ref.axis[0]))), f, who: c.id, prop: p.id, note: p.id });
		}
	}
	row("carryGap", "carry: widest wrist gap to the prop", carryMax, "mm", MM, { short: "carry gap", worse: 1, spike: 80 });
	row("carryIn", "carry: closest wrist to the prop", carryMin, "mm", MM, { short: "hand inside", worse: -1, spike: 50 });
	if (clip.props.some(p => p.pos.length > 3)) row("freeTravel", "travel of a prop nothing holds or keys", { v: free, f: freeAt?.f, prop: freeAt?.prop }, "mm", MM, { short: "prop drifts", worse: 1, spike: 1 });
	row("gripDrift", "prop in one hand: drift", drift, "mm", MM, { short: "grip drift", worse: 1, spike: 5 });
	row("gripTurn", "prop in one hand: turn", turn, "deg", DEG, { short: "grip turn", worse: 1, spike: 2 });
	// a keyed prop starts to move while a prop is in a hand (the cut): distance from the held prop's long axis to it
	aux.keyStarts.forEach((k, n) => {
		for (const p of clip.props) {
			if (!aux.grips[p.id]?.[k.f]) continue;
			const target = clip.props.find(t => t.id === k.prop), { c, q } = propAt(p, k.f);
			let d = Infinity;
			for (let i = 0; i <= 40; i++) { const o = qRotate(q, [0, 0, (i / 40 - 0.5) * p.size[2]]); d = Math.min(d, toBox([c[0] + o[0], c[1] + o[1], c[2] + o[2]], target, k.f)); }
			rows.push({ key: `cut:${p.id}>${k.prop}#${n}`, label: `cut: ${p.id} to ${k.prop} when it starts to move`, short: "cut gap", value: Math.max(0, d) * MM, unit: "mm", frame: k.f, who: aux.grips[p.id][k.f].c, prop: k.prop, note: d < 0 ? `inside it by ${(-d * MM).toFixed(0)} mm` : "not touching", worse: 1, spike: 30, raw: d });
		}
	});
	row("headTurn", "fastest head turn", head, "deg/frame", DEG, { short: "head turn", worse: 1, spike: 12 });
	row("elbow", "fastest elbow", elbow, "cm/frame", 100, { short: "elbow", worse: 1, spike: 20, word: "faster" });
	row("wrist", "fastest wrist", wrist, "cm/frame", 100, { short: "wrist", worse: 1, spike: 25, word: "faster" });
	// a prop released into a roll: its speed, the jump of its position and speed at the release, its height while rolling
	for (const e of aux.releases) {
		const p = clip.props.find(q => q.id === e.prop), c = f => propAt(p, f).c, a = c(e.f - 2), b = c(e.f - 1), n = c(e.f);
		let low = Infinity, high = -Infinity, off = 0;
		for (let f = e.f; f < F; f++) {
			if (!aux.rolling[e.prop][f]) continue;
			const pc = c(f), under = clip.props.filter(s => s.pos.length === 3 && over(pc, s) && s.pos[1] + s.size[1] / 2 < 0.3);
			if (!under.length) off++;
			const h = pc[1] - p.size[1] / 2 - Math.max(0, ...under.map(s => s.pos[1] + s.size[1] / 2));
			low = Math.min(low, h); high = Math.max(high, h);
		}
		const tag = { frame: e.f, prop: e.prop };
		rows.push({ key: `release:${e.prop}:speed`, label: `release of ${e.prop}: speed`, value: dist(n, b) * 24, unit: "m/s", ...tag, note: Number.isFinite(low) ? `rolls ${(low * MM).toFixed(0)}..${(high * MM).toFixed(0)} mm over the surface under it, ${off} frames with no static prop under it` : undefined, worse: 0 });
		rows.push({ key: `release:${e.prop}:posJump`, label: `release of ${e.prop}: position jump`, short: "release jump", value: Math.hypot(n[0] - 2 * b[0] + a[0], n[1] - 2 * b[1] + a[1], n[2] - 2 * b[2] + a[2]) * MM, unit: "mm", ...tag, worse: 1, spike: 10 });
		rows.push({ key: `release:${e.prop}:speedJump`, label: `release of ${e.prop}: speed jump`, short: "release jump", value: Math.abs(dist(n, b) - dist(b, a)) * MM, unit: "mm/frame", ...tag, worse: 1, spike: 10 });
	}
	// a place: how far the prop is from its target on the frame the place ends; who placed it, whether they held it, who holds it on
	for (const p of aux.placed) {
		const on = aux.holders?.[p.prop]?.[p.f], who = p.who?.join(" and "), note = [p.held === false && `${who} did not hold ${p.prop}, so the place did not move it`, on && `${on} hold it on`].filter(Boolean).join("; ");
		rows.push({ key: `place:${p.prop}`, label: p.held === false ? `place: ${p.prop} is this far from its target` : `place: ${p.prop} let go this far from its target`, short: "place miss", value: p.miss * MM, unit: "mm", frame: p.f, prop: p.prop, ...(note ? { note } : {}), worse: 1, spike: 30 });
	}
	// a ride (aux.rides, ride.js) that never began: a key of the prop written after it on its frame drives the prop, or
	// hands held it on every frame from the key to its next key or the end (who, on which frames, as the clip has it);
	// a ride with at: the largest step of the prop on its carrier in one frame while it goes from where it was to that
	// place (the frames the ride's over gave it, up to its next key or a hand taking it off), told over JUMP or RIDE_TURN
	// with those frames and, when the spacing of the prop's keys cut the default, that key; over 0 or 1: the whole way on
	// its first frame
	for (const r of aux.rides ?? []) {
		const on = r.joint ? `${r.of}'s ${r.joint}` : r.on, tag = { frame: r.began ?? r.f, who: r.of, prop: r.prop }, end = r.next ?? F;
		const runs = []; for (let f = r.f; f < end; f++) { const h = aux.holders[r.prop]?.[f] ?? "nobody"; if (runs.at(-1)?.h === h) runs.at(-1).b = f; else runs.push({ h, a: f, b: f }); }
		const why = r.hidden ? `the ${r.hidden} key of ${r.prop} on that frame is written after it and drives ${r.prop}` : `who held it from that frame to ${r.next == null ? "the last frame" : `its next key at f${r.next}`}: ${runs.map(x => `${x.h} f${x.a}-${x.b}`).join(", ")}`;
		if (r.began == null) rows.push({ key: `ride:${r.prop}:${r.f}`, label: `ride: ${r.prop} never rode on ${on}, the key at f${r.f}`, short: "no ride", value: end - r.f, unit: "frames", ...tag, note: why, worse: 1 });
		if (!r.at || !r.began || !r.rel) continue;
		const carAt = f => (r.joint ? { c: at(clip.characters.find(c => c.id === r.of), f, J[r.joint]), q: rot(clip.characters.find(c => c.id === r.of), f, J[r.joint]) } : propAt(clip.props.find(p => p.id === r.on), f));
		const onCar = f => { const car = carAt(f), p = propAt(clip.props.find(x => x.id === r.prop), f); return { c: qRotate(qConj(car.q), [p.c[0] - car.c[0], p.c[1] - car.c[1], p.c[2] - car.c[2]]), q: qMul(qConj(car.q), p.q) }; };
		const w = { d: 0, f: r.began, turn: 0 };
		for (let f = r.began; f <= Math.min(r.began - 1 + Math.max(1, Math.ceil(r.over ?? 0)), (r.off ?? end) - 1, F - 1); f++) {
			const a = onCar(f - 1), b = onCar(f), d = dist(a.c, b.c);
			if (d > w.d) Object.assign(w, { d, f });
			w.turn = Math.max(w.turn, 2 * Math.acos(Math.min(1, Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]))) * DEG);
		}
		if (w.d > JUMP || w.turn > RIDE_TURN) rows.push({ key: `ride:${r.prop}:${r.f}`, label: `ride: ${r.prop} moved this far in one frame on ${on} going to its at`, short: "ride jump", value: w.d * MM, unit: "mm", ...tag, frame: w.f, note: `turning up to ${w.turn.toFixed(0)} deg a frame; it began ${Math.round(dist(onCar(r.began - 1).c, r.rel.c) * MM)} mm from its at, over ${r.over} frame${r.over === 1 ? "" : "s"}${r.cut == null ? "" : `, the gap to its key at f${r.cut}`}`, worse: 1, spike: 10 });
	}
	// a sit on a prop that did not end on it (aux.seats): the hips off the top's footprint over 10 mm, or feet inside the prop
	for (const s of aux.seats ?? []) if (s.off > 0.01 || s.feetIn) rows.push({ key: `seat:${s.who}:${s.f}`, label: `sit: hips end this far off the top of ${s.prop}`, short: "off seat", value: s.off * MM, unit: "mm", frame: s.f, who: s.who, prop: s.prop, note: s.feetIn ? `${s.feetIn === 1 ? "a foot stands" : "both feet stand"} inside ${s.prop}` : undefined, worse: 1 });
	// a body or a moving prop inside another prop past the limit: one row per pair, at its deepest frame
	for (const e of inside ? insideRows(clip, aux, inside) : []) rows.push({ key: e.key, label: `${e.who ? `${e.who}'s body` : e.part} inside ${e.prop}`, short: "inside", value: e.value, unit: "mm", frame: e.frame, who: e.who ?? undefined, prop: e.prop, note: `${e.who ? `deepest part: ${e.part}; ` : ""}deeper than ${num1(e.limit)} mm on ${e.frames} frame${e.frames === 1 ? "" : "s"}, from f${e.first} to f${e.last}`, worse: 1 });
	// a contact the spec asks for with a prop whose drawn parts are known, past the gap (gaps.mjs): one row per body, limb and prop
	for (const e of inside ? gapRows(clip, aux, inside) : []) rows.push({ key: e.key, label: `${e.who}'s ${e.limb} to the drawn ${e.prop}`, short: "off drawn", value: Math.abs(e.value), unit: "mm", frame: e.frame, who: e.who, prop: e.prop, note: `${e.part == null ? `${e.value > 0 ? "floats over" : "sinks into"} the drawn top under the hips` : `nearest part ${e.part}${e.limb === "seat" ? ", none drawn under the hips" : ""}`}; past ${num1(e.limit)} mm on ${e.frames} frame${e.frames === 1 ? "" : "s"}, from f${e.first} to f${e.last}`, worse: 1 });
	if (inside?.bodies) rows.push(...bodyRows(clip, aux, inside)); // against the drawn bodies: one row per body, limb and body, riding prop and body, body and body
	// a hand that took hold of a prop short of its place on it (a reach entry's took): the prop was pulled to the hand on that
	// frame; why (share.js): no place was asked (the prop's nearest point), the hands' top speed, a place past the arm's reach
	const tookWhy = (w, s, prop) => [w?.near && `the hold gives no at, so its place is the point nearest the hand ${Math.round(PAD * s * MM)} mm off the surface of ${prop}`,
		w?.slow > 0.005 && `late: a wrist moves at most ${Math.round(MAX_STEP * s * MM)} mm a frame in the body frame unless its key says fast, and that held it ${Math.round(w.slow * MM)} mm short of its place on that frame`,
		w?.beyond > 0.005 && `the place was ${Math.round(w.beyond * MM)} mm beyond the arm's reach from the shoulder`].filter(Boolean).map(t => `; ${t}`).join("");
	for (const c of clip.characters) [0, 1].forEach(i => {
		let worst = null;
		(aux.reach?.[c.id] ?? []).forEach((at, f) => { if (at[i]?.took > (worst?.v ?? 0.01)) worst = { v: at[i].took, f, who: c.id, prop: at[i].prop, note: `${SIDE[i]} hand, the action at f${at[i].key}${tookWhy(at[i].tookWhy, c.scale ?? 1, at[i].prop)}` }; });
		row(`reach:${c.id}:${i}:took`, "hand took hold short of its place; the prop was pulled to the hand", worst, "mm", MM, { short: "pulled", worse: 1, spike: 60 });
		// a hand kept on its place on a prop that more hands hold, off where its own action (the hold or a later pose) puts it
		// by more than the pad a holding wrist keeps off the prop's surface
		let kept = null;
		(aux.reach?.[c.id] ?? []).forEach((at, f) => { if (at[i]?.held > (kept?.v ?? PAD * (c.scale ?? 1))) kept = { v: at[i].held, f, who: c.id, prop: at[i].prop, note: `${SIDE[i]} hand; the action at f${at[i].key} has it hold ${at[i].prop}, which ${aux.holders?.[at[i].prop]?.[f]} hold on that frame, so it stays on its place on it, off where the action at f${at[i].heldKey} puts it` }; });
		row(`reach:${c.id}:${i}:held`, "hand kept on its place on a prop that more hands hold, off where its own action puts it", kept, "mm", MM, { short: "held off", worse: 1, spike: 60 });
	});
	// a hand or a foot off the target its action gave it, after that action's blend has ended: the worst frame of each limb
	const LIMB = ["L hand", "R hand", "L foot", "R foot", "L elbow", "R elbow"], PART = ["hand", "foot", "elbow"]; // elbows only for a character with elbow keys
	for (const c of clip.characters) LIMB.forEach((limb, i) => {
		let worst = null, frames = 0;
		const list = (aux.reach?.[c.id] ?? []).map(at => at[i] ?? null);
		list.forEach((e, f) => { if (!e) return; if (e.d > 0.01) frames++; if (e.d > (worst?.v ?? 0.001)) worst = { v: e.d, f, who: c.id, key: e.key }; });
		if (worst) worst.note = `${limb}, the action at f${worst.key}; over 10 mm off on ${frames} frame${frames === 1 ? "" : "s"}${worst.v > 0.01 ? `; ${reachWhy(list, worst.f, i, c.scale ?? 1)}` : ""}`;
		if (worst) row(`reach:${c.id}:${i}`, `${PART[i >> 1]} off its target`, worst, "mm", MM, { short: `${PART[i >> 1]} off`, worse: 1, spike: 60 });
	});
	if (spec) rows.push(...jumpRows(clip, spec, rows.filter(r => r.short === "ride jump")));
	return rows;
}

/** A step of one frame far outside the steps before and after it (jumps.js) of a body's Hips joint (over JUMP times the
 *  body's scale) or of a prop that moves (over JUMP): one row per body and one for the props, at the largest. Only the
 *  jumps within a frame of a key of the spec (a key's frame, or the frame its written over ends): those are where
 *  the spec's words can change something. Not on the frame of a key of its own id written with over 0 or 1, or the
 *  frame after it: that key asks for the step. Nor a prop's jump onto the place of its ride, which has its own row. */
function jumpRows(clip, spec, rides) {
	const F = clip.frameCount, cm = v => (v * 100).toFixed(1), out = [], near = new Set(), asked = {};
	for (const r of rides) (asked[r.prop] ??= new Set()).add(r.frame); // told as its own row
	for (const [id, acts] of Object.entries(spec)) for (const [f, , o] of Array.isArray(acts) ? acts : []) {
		for (const k of o?.over > 0 ? [f, f + o.over] : [f]) for (const d of [-1, 0, 1]) near.add(k + d);
		if (o?.over === 0 || o?.over === 1) (asked[id] ??= new Set()).add(f).add(f + 1);
	}
	const add = (key, tracks, min, tag) => {
		const g = groupJumps(tracks, F, min, (t, f) => near.has(f) && !asked[t.id]?.has(f));
		if (g) out.push({ key, label: "jump between two frames", short: "jump", value: g.size * 100, unit: "cm", frame: g.f, ...tag(g), worse: 1, spike: min * 100,
			note: `${g.part}; steps into f${g.f - 1}, f${g.f}, f${g.f + 1}: ${g.steps.map(cm).join(", ")} cm${g.frames > 1 ? `; ${g.frames} frames with one, f${g.first}-f${g.last}` : ""}${g.parts.length > 1 ? `, props ${g.parts.slice(0, 4).join(", ")}${g.parts.length > 4 ? ` and ${g.parts.length - 4} more` : ""}` : ""}` });
	};
	for (const c of clip.characters) add(`jump:${c.id}`, [{ part: "Hips", id: c.id, at: f => Array.from(c.pos.slice(f * JOINT_COUNT * 3, f * JOINT_COUNT * 3 + 3)) }], JUMP * (c.scale ?? 1), () => ({ who: c.id }));
	add("jump:props", clip.props.filter(p => p.pos.length > 3).map(p => ({ part: p.id, id: p.id, at: f => Array.from(p.pos.slice(f * 3, f * 3 + 3)) })), JUMP, g => ({ prop: g.part }));
	return out;
}

/** A difference's own identity: the check (the row key, which names the limb, the cut or the release where it has
 *  one), the character and the prop; not the frame, so a difference that moves a few frames stays the same one. */
export const rowId = r => `${r.key}|${r.who ?? ""}|${r.prop ?? ""}`;
/** For how many compiles in a row each row has been past its spike value: { <rowId>: n }, only the rows past it now;
 *  before is the map of the last compile. A row in its normal range (a hand on a carried prop) is no difference. */
export const inARow = (rows, before) => Object.fromEntries(rows.filter(r => r.spike != null && badness(r) > r.spike).map(r => [rowId(r), (before?.[rowId(r)] ?? 0) + 1]));

/** checkClip's value for a row key, in the row's unit; undefined when checks.js has no such number. */
export function checkValue(key, c) {
	const cut = /^cut:.*#(\d+)$/.exec(key);
	if (cut) return undefined;
	const rel = /^release:(.+):(speed|posJump|speedJump)$/.exec(key), e = rel && c.releases.find(r => r.prop === rel[1]);
	if (rel) return e && (rel[2] === "speed" ? e.speed * 24 : e[rel[2]] * MM);
	return { slide: c.slide * MM, slideStep: c.slideStep * MM, footLow: c.footLow * MM, jointLow: c.jointLow * MM, carryGap: c.carryMax == null ? undefined : c.carryMax * MM, carryIn: c.carryMin == null ? undefined : c.carryMin * MM,
		freeTravel: c.freeTravel * MM, gripDrift: c.gripDrift == null ? undefined : c.gripDrift * MM, gripTurn: c.gripTurn == null ? undefined : c.gripTurn * DEG,
		headTurn: c.headTurn, elbow: c.elbow * 100, wrist: c.wrist * 100 }[key];
}

const MOVING = new Set(["walk", "run", "push"]), BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie", "launch"]);
const m2 = v => v.toFixed(2);
/** How a written count or stepFrames of a walk (aux.walks, gait.js fitCount) differs from what it walked, as the writer reads it. */
const toldText = w => {
	const [a, n] = w.steps, turned = (w.turns ?? []).reduce((k, t) => k + t.frames, 0), g = w.gait ?? w.verb, because = [w.as?.facing && "it has facing", w.as?.under != null && `it goes ${m2(w.distance)} m, under 0.5 m times its body's scale, ${m2(w.as.under)} m`].filter(Boolean).join(" and "), as = g === w.verb ? "" : ` (this ${w.verb} steps as a ${g}${because ? `: ${because}` : ""})`;
	const lg = (k, l, why) => `longer than the longest step of a ${k} that way${why}, ${m2(l)} m`, fu = (k, r) => `further than a ${k} at a steady pace of its longest steps that way puts one, ${m2(r)} m`;
	const longer = lg(g, w.longest, as), further = fu(g, w.reach), sp = w.split, spWhy = sp && (sp.turn ? "" : sp.gait === g ? as : "");
	const why = [w.step > w.longest + 1e-6 && longer, w.far != null && `and put a foot up to ${m2(w.far)} m from the hips as it lands or lifts, ${further}`].filter(Boolean).join(", ");
	return [
		n !== a && `steps ${a} asked: ${a < 2 ? `a ${w.verb} of ${m2(w.distance)} m takes 2 plants at least (the last brings the feet together), steps no longer than the longest of a ${g} that way${as}, ${m2(w.longest)} m` : `${a} plants over ${m2(w.distance)} m make ${a - 1} step${a === 2 ? "" : "s"} of up to ${m2(w.step)} m${w.pace ? ` at the pace ${w.pace}` : ""} (the last plant brings the feet ${w.end ? "to their end spots" : "together"}), ${why}`}, so it took ${n} plants`,
		sp && `its end spots, which the count is not fitted to, make a step of up to ${m2(sp.step)} m onto them and put a foot ${m2(sp.far)} m from the hips as it lands: ${[sp.long && `${lg(sp.gait, sp.longest, spWhy)}${sp.was != null ? `, and than a step there without its end spots, ${m2(sp.was)} m` : ""}`, sp.wide && `${fu(sp.gait, sp.reach)}${sp.own != null ? `, and than that foot lands without its end spot, ${m2(sp.own)} m` : ""}`].filter(Boolean).join(", and ")}${sp.turn ? " (it steps onto them as a walk, in its turn on the spot at the end)" : ""}`,
		w.stepFrames[0] != null && w.stepFrames[1] < w.stepFrames[0] - 0.05 && `stepFrames ${w.stepFrames[0]} asked: ${n} plants at ${w.stepFrames[0]} frames need ${Math.round(w.need)} frames to land, the action has ${Math.round(w.room)} (up to the next body action, less 3 to stand still)${turned ? ` and turns on the spot in ${turned} of them, leaving ${Math.round(w.stepsRoom)}` : ""}, so each step took ${w.stepFrames[1].toFixed(1)}`,
		...(w.turns ?? []).map(t => `it turned on the spot ${t.when} (${t.plants} plants in ${t.frames} frames) besides its ${n} plants`),
	].filter(Boolean).map(t => `the ${w.verb} at f${w.f}: ${t}`).join("; ");
};
/**
 * What each stretch of travel came out as: one record per character and run of consecutive walk / run / push actions
 * of its body layer. spec: the spec as built (repeats written out). The Hips joint's path on the floor plane counts
 * while it moves faster than 0.05 m/s (seconds are those frames); steps are the foot plants (aux.contacts, the test
 * the foot-slide row uses) that begin inside the stretch. told: for each of its actions whose written count or
 * stepFrames was not walked as written (aux.walks), the difference and why.
 * -> [{ who, a, b, verb, distance (m), seconds, speed (m/s), steps, cadence (per minute, null under 2 steps), told: [text] }]
 */
export function travel(clip, aux, spec) {
	const F = clip.frameCount, fps = clip.fps ?? 24, out = [];
	for (const c of clip.characters) {
		const body = (Array.isArray(spec[c.id]) ? spec[c.id] : []).filter(x => Array.isArray(x) && BODY.has(x[1])).sort((x, y) => x[0] - y[0]);
		for (let i = 0; i < body.length; i++) {
			if (!MOVING.has(body[i][1])) continue;
			const a = body[i][0], verbs = new Set();
			while (MOVING.has(body[i + 1]?.[1])) verbs.add(body[i++][1]);
			verbs.add(body[i][1]);
			const b = Math.min(F - 1, body[i + 1]?.[0] ?? F - 1);
			let distance = 0, moving = 0, steps = 0;
			for (let f = a + 1; f <= b; f++) {
				const p = f * JOINT_COUNT * 3, q = (f - 1) * JOINT_COUNT * 3, d = Math.hypot(c.pos[p] - c.pos[q], c.pos[p + 2] - c.pos[q + 2]);
				if (d * fps > 0.05) { distance += d; moving++; }
				for (let side = 0; side < 2; side++) if (aux.contacts[c.id][f][side] && !aux.contacts[c.id][f - 1][side]) steps++;
			}
			const seconds = moving / fps;
			const told = (aux.walks ?? []).filter(w => w.who === c.id && w.f >= a && w.f <= b).map(toldText);
			out.push({ who: c.id, a, b, verb: [...verbs].join("+"), distance, seconds, speed: seconds ? distance / seconds : 0, steps, cadence: steps >= 2 && seconds ? steps / seconds * 60 : null, told });
		}
	}
	return out;
}
