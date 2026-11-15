// The check numbers of a clip as rows, each with the frame of its worst value.
// checks.js (frozen) returns the numbers without frames, so this repeats its formulas and keeps the frame; compile-tool.mjs
// prints checkClip's own value and drops the frame of a row whose value here differs from it. One row is not in
// checks.js: `clear`, the nearest joint to any prop (hands excluded), because the engine has no collision.
//
// The `reach:` rows are not in checks.js either: a hand or a foot that is not where its action put it (aux.reach).
//
// row: { key, label, short, value, unit, frame?, who?, prop?, note?, worse, spike?, word? }
//   short: the row's name on a sheet label
//   worse: 1 = a higher value is worse, -1 = a value below zero is worse, 0 = neither
//   spike: the value past which the row counts as a spike (compile-tool.mjs then shows the frames around `frame`)
import { INDEX as J, JOINTS, JOINT_COUNT } from "../rig17.js";
import { qConj, qRotate } from "../engine-simple/math.js";
import { SOLE, TOE } from "../engine-simple/solve.js";

const FEET = [J.LeftFoot, J.RightFoot], HANDS = [J.LeftHand, J.RightHand], SIDE = ["L", "R"];
const MM = 1000, DEG = 180 / Math.PI;

/** How bad a row's value is: its size when higher is worse, its depth below zero when lower is worse. */
export const badness = row => row.worse > 0 ? row.value : row.worse < 0 ? Math.max(0, -row.value) : 0;
export const isSpike = row => row.spike != null && row.frame != null && badness(row) > row.spike;

export function measure(clip, aux, { stretch = 0 } = {}) {
	const F = clip.frameCount, rows = [];
	const propAt = (p, f) => { const i = p.pos.length === 3 ? 0 : f; return { c: p.pos.slice(i * 3, i * 3 + 3), q: p.quat.slice(i * 4, i * 4 + 4) }; };
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
				const pts = [TOE, SOLE].map(o => { const a = at(c, f, j), d = qRotate(rot(c, f, j), o); return [a[0] + d[0], a[1] + d[1], a[2] + d[2]]; });
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

	let carryMin, carryMax, body, drift, turn, clear, free = 0, freeAt;
	for (const p of clip.props) {
		for (const c of clip.characters) for (let f = 0; f < F; f++) for (let j = 0; j < JOINT_COUNT; j++) {
			if (HANDS.includes(j)) continue;
			const d = { v: toBox(at(c, f, j), p, f), f, who: c.id, prop: p.id, note: `${JOINTS[j]} to ${p.id}` };
			clear = best(clear, d, -1);
			if (aux.slid[p.id]) body = best(body, d, -1);
		}
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
			ref ??= { off, axis };
			drift = best(drift, { v: dist(off, ref.off), f, who: c.id, prop: p.id, note: p.id });
			turn = best(turn, { v: Math.asin(Math.min(1, Math.hypot(axis[1] * ref.axis[2] - axis[2] * ref.axis[1], axis[2] * ref.axis[0] - axis[0] * ref.axis[2], axis[0] * ref.axis[1] - axis[1] * ref.axis[0]))), f, who: c.id, prop: p.id, note: p.id });
		}
	}
	row("carryGap", "carry: widest wrist gap to the prop", carryMax, "mm", MM, { short: "carry gap", worse: 1, spike: 80 });
	row("carryIn", "carry: closest wrist to the prop", carryMin, "mm", MM, { short: "hand inside", worse: -1, spike: 50 });
	row("bodyToBox", "body to the pushed prop", body, "mm", MM, { short: "inside prop", worse: -1, spike: 20 });
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
			const pc = c(f), under = clip.props.filter(s => s.pos.length === 3 && Math.abs(pc[0] - s.pos[0]) <= s.size[0] / 2 && Math.abs(pc[2] - s.pos[2]) <= s.size[2] / 2 && s.pos[1] + s.size[1] / 2 < 0.3);
			if (!under.length) off++;
			const h = pc[1] - p.size[1] / 2 - Math.max(0, ...under.map(s => s.pos[1] + s.size[1] / 2));
			low = Math.min(low, h); high = Math.max(high, h);
		}
		const tag = { frame: e.f, prop: e.prop };
		rows.push({ key: `release:${e.prop}:speed`, label: `release of ${e.prop}: speed`, value: dist(n, b) * 24, unit: "m/s", ...tag, note: Number.isFinite(low) ? `rolls ${(low * MM).toFixed(0)}..${(high * MM).toFixed(0)} mm over the surface under it, ${off} frames with no static prop under it` : undefined, worse: 0 });
		rows.push({ key: `release:${e.prop}:posJump`, label: `release of ${e.prop}: position jump`, short: "release jump", value: Math.hypot(n[0] - 2 * b[0] + a[0], n[1] - 2 * b[1] + a[1], n[2] - 2 * b[2] + a[2]) * MM, unit: "mm", ...tag, worse: 1, spike: 10 });
		rows.push({ key: `release:${e.prop}:speedJump`, label: `release of ${e.prop}: speed jump`, short: "release jump", value: Math.abs(dist(n, b) - dist(b, a)) * MM, unit: "mm/frame", ...tag, worse: 1, spike: 10 });
	}
	for (const p of aux.placed) rows.push({ key: `place:${p.prop}`, label: `place: ${p.prop} let go this far from its target`, short: "place miss", value: p.miss * MM, unit: "mm", frame: p.f, prop: p.prop, worse: 1, spike: 30 });
	row("clear", "nearest joint to a prop (hands excluded)", clear, "mm", MM, { short: "inside prop", worse: -1, spike: 30 });
	// a hand or a foot off the target its action gave it, after that action's blend has ended: the worst frame of each limb
	const LIMB = ["L hand", "R hand", "L foot", "R foot"];
	for (const c of clip.characters) LIMB.forEach((limb, i) => {
		let worst = null, frames = 0;
		(aux.reach?.[c.id] ?? []).forEach((at, f) => { if (!at[i]) return; if (at[i].d > 0.01) frames++; if (at[i].d > (worst?.v ?? 0.001)) worst = { v: at[i].d, f, who: c.id, key: at[i].key }; });
		if (worst) worst.note = `${limb}, the action at f${worst.key}; over 10 mm off on ${frames} frame${frames === 1 ? "" : "s"}`;
		if (worst) row(`reach:${c.id}:${i}`, `${i < 2 ? "hand" : "foot"} off its target`, worst, "mm", MM, { short: i < 2 ? "hand off" : "foot off", worse: 1, spike: 60 });
	});
	return rows;
}

/** checkClip's value for a row key, in the row's unit; undefined when checks.js has no such number. */
export function checkValue(key, c) {
	const cut = /^cut:.*#(\d+)$/.exec(key);
	if (cut) return undefined;
	const rel = /^release:(.+):(speed|posJump|speedJump)$/.exec(key), e = rel && c.releases.find(r => r.prop === rel[1]);
	if (rel) return e && (rel[2] === "speed" ? e.speed * 24 : e[rel[2]] * MM);
	return { slide: c.slide * MM, slideStep: c.slideStep * MM, footLow: c.footLow * MM, jointLow: c.jointLow * MM, carryGap: c.carryMax == null ? undefined : c.carryMax * MM, carryIn: c.carryMin == null ? undefined : c.carryMin * MM,
		bodyToBox: c.bodyToBox == null ? undefined : c.bodyToBox * MM, freeTravel: c.freeTravel * MM, gripDrift: c.gripDrift == null ? undefined : c.gripDrift * MM, gripTurn: c.gripTurn == null ? undefined : c.gripTurn * DEG,
		headTurn: c.headTurn, elbow: c.elbow * 100, wrist: c.wrist * 100 }[key];
}

const MOVING = new Set(["walk", "run", "push"]), BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);
/**
 * What each stretch of travel came out as: one record per character and run of consecutive walk / run / push actions
 * of its body layer. spec: the spec as built (repeats written out). The Hips joint's path on the floor plane counts
 * while it moves faster than 0.05 m/s (seconds are those frames); steps are the foot plants (aux.contacts, the test
 * the foot-slide row uses) that begin inside the stretch.
 * -> [{ who, a, b, verb, distance (m), seconds, speed (m/s), steps, cadence (per minute, null under 2 steps) }]
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
			out.push({ who: c.id, a, b, verb: [...verbs].join("+"), distance, seconds, speed: seconds ? distance / seconds : 0, steps, cadence: steps >= 2 && seconds ? steps / seconds * 60 : null });
		}
	}
	return out;
}
