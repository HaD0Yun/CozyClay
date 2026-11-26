// A line (a rope, a cable, a leash, a string): a scene prop { id, line: { length, thick }, at, turn? } that bends. It is a
// chain of N points (segments of about 0.1 m, at most MAX_SEGMENTS) the engine solves once per frame, after the bodies
// and the box props have ended that frame: gravity, segments that cannot grow longer than their share of the length
// (they may fold), the floor and the solid props' boxes (their drawn parts when they have them) pushed out of, a little
// friction where it lies. Points the spec fastens are put where they are fastened (the line follows them: it pulls
// nothing back). Before frame 0 the line lies straight through `at` along its own X (turned `turn` degrees about Y), is
// laid from what frame 0 fastens (layOut) and settles. Plain doubles, a fixed order, fixed substeps: the same input gives the same
// clip. Fastenings: its own keys (tie, over, untie; LINE_VERBS) and the hands of a hold of it (spec-layers.js lineHold).
import { INDEX as J } from "../rig17.js";
import { add, mixV, qConj, qMul, qRotate, smooth } from "./math.js";
import { onPoint, otherPoint } from "./share.js";
import { partBoxes, partOf } from "./parts.js";
import { shownAt } from "./prop-keys.js";
import { LINES, lineMiddle, point3 } from "./line-point.js";
export { LINES, lineMiddle };
export { lineLines } from "./line-told.js";

const SEG = 0.1, MAX_SEGMENTS = 64, SUB = 8, IT = 24, G = 9.8, DAMP = 0.01, SETTLE = 48, PAY = 32, BOW = 0.001, SETTLE_DAMP = 0.05, FRICTION = 0.3;
const HAND = [J.LeftHand, J.RightHand], HANDS = ["L", "R"];
const LINE_VERBS = new Set(["tie", "over", "untie", "hide", "show"]);
/** Limits of a line's numbers (compile-tool.mjs tells them). */
const LINE_LIMITS = Object.freeze({ length: [0.05, 50], thick: [0.002, 0.3] });

export const isLine = p => p !== null && typeof p === "object" && p.line != null;
/** Segments of a line of length L. */
const segmentsOf = L => Math.max(4, Math.min(MAX_SEGMENTS, Math.ceil(L / SEG - 1e-9)));

/** Reasons a scene line cannot be built, in plain words (compile-tool.mjs problems). */
export function lineProblems(p, where) {
	const out = [], l = p.line, ok = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
	if (l === null || typeof l !== "object" || Array.isArray(l)) return [`${where}.line: want { length, thick } in metres, got ${JSON.stringify(l)}`];
	if (!ok(l.length, LINE_LIMITS.length)) out.push(`${where}.line.length: want metres from ${LINE_LIMITS.length.join(" to ")}, got ${JSON.stringify(l.length)}`);
	if (!ok(l.thick, LINE_LIMITS.thick)) out.push(`${where}.line.thick: want metres from ${LINE_LIMITS.thick.join(" to ")}, got ${JSON.stringify(l.thick)}`);
	if (!(Array.isArray(p.at) && p.at.length === 3 && p.at.every(Number.isFinite))) out.push(`${where}.at: want the middle of the line [x, y, z] as it lies straight before the clip, got ${JSON.stringify(p.at)}`);
	if (p.turn !== undefined && !Number.isFinite(p.turn)) out.push(`${where}.turn: want degrees about Y, got ${JSON.stringify(p.turn)}`);
	return out;
}

/** The scene with its lines apart: { ...def, props: the box props, lines: the lines } (a def already split is kept). */
export function splitLines(def) {
	if (!def?.props?.some(isLine)) return def;
	return { ...def, props: def.props.filter(p => !isLine(p)), lines: [...(def.lines ?? []), ...def.props.filter(isLine)] };
}

const bad = (id, text) => new Error(`engine-simple: ${id} ${text}`);

/** The lines of a scene, each ready to solve, by id (engine.js keeps the map as props[LINES]). */
export function makeLines(lines, spec) {
	return new Map((lines ?? []).map(d => {
		const L = d.line.length, N = segmentsOf(L), seg = L / N, x = new Float64Array((N + 1) * 3), yaw = (d.turn ?? 0) * Math.PI / 180;
		for (let i = 0; i <= N; i++) { const s = i * seg - L / 2; x.set([d.at[0] + Math.cos(yaw) * s, Math.max(d.line.thick / 2, d.at[1]), d.at[2] - Math.sin(yaw) * s], i * 3); }
		const acts = (spec[d.id] ?? []).slice().sort((a, b) => a[0] - b[0]);
		for (const [f, verb, o = {}] of acts) {
			if (!LINE_VERBS.has(verb)) throw bad(d.id, `${verb} at frame ${f}: a line takes ${[...LINE_VERBS].join(", ")} (its points are fastened, not keyed)`);
			if (verb === "tie" && !(Number.isFinite(o.at) && o.at >= 0 && o.at <= L)) throw bad(d.id, `tie at frame ${f}: at wants metres along the line from 0 to its length ${L}, got ${JSON.stringify(o.at)}`);
			if ((verb === "tie" || verb === "over") && !(o.to && typeof o.to === "object")) throw bad(d.id, `${verb} at frame ${f}: to wants {on: propId, part?, at?}, {joint, of: characterId, at?} or {world: [x, y, z]}, got ${JSON.stringify(o.to)}`);
			if (o.over !== undefined && !(Number.isFinite(o.over) && o.over >= 0)) throw bad(d.id, `${verb} at frame ${f}: over wants frames, 0 or more`);
		}
		return [d.id, {
			id: d.id, L, N, seg, R: d.line.thick / 2, along: [Math.cos(yaw), -Math.sin(yaw)], x, v: new Float64Array(x.length), keys: acts.filter(a => a[1] !== "hide" && a[1] !== "show").map(([f, verb, o = {}]) => ({ f, verb, ...o })),
			shownKeys: acts.filter(a => a[1] === "hide" || a[1] === "show").map(([f, verb]) => ({ f, verb })), anchors: [], events: [], out: null, told: { spans: [], jumps: [], floor: [] },
		}];
	}));
}

/** The metres along line l of its point nearest world point p. */
const nearest = (l, p) => { let best = 0, d = Infinity; for (let i = 0; i <= l.N; i++) { const e = Math.hypot(l.x[i * 3] - p[0], l.x[i * 3 + 1] - p[1], l.x[i * 3 + 2] - p[2]); if (e < d) { d = e; best = i; } } return best * l.seg; };

/** The solids a line meets on frame f: each solid prop's boxes ({ c, q, h }: centre, turn, half sizes) in the world, with
 *  a radius for a quick miss. hollow: ids left out. */
function solidsAt(props, hollow) {
	const out = [];
	for (const p of Object.values(props)) {
		if (hollow.has(p.id)) continue;
		for (const b of p.parts ?? [{ c: [0, 0, 0], q: [0, 0, 0, 1], h: p.size.map(v => v / 2) }]) {
			const c = add(p.c, qRotate(p.q, b.c)), q = qMul(p.q, b.q);
			out.push({ c, q, iq: qConj(q), h: b.h, r: Math.hypot(...b.h) });
		}
	}
	return out;
}
/** Pushes point i of l out of the floor and the solids; returns true when it rests on a top (an upward push). */
function pushOut(l, i, solids) {
	const x = l.x, R = l.R, o = i * 3;
	let top = false;
	if (x[o + 1] < R) { x[o + 1] = R; top = true; }
	for (const s of solids) {
		const dx = x[o] - s.c[0], dy = x[o + 1] - s.c[1], dz = x[o + 2] - s.c[2];
		if (dx * dx + dy * dy + dz * dz > (s.r + R) ** 2) continue;
		const lo = qRotate(s.iq, [dx, dy, dz]), pen = [0, 1, 2].map(k => s.h[k] + R - Math.abs(lo[k]));
		if (pen[0] <= 0 || pen[1] <= 0 || pen[2] <= 0) continue;
		const k = pen[0] < pen[1] ? (pen[0] < pen[2] ? 0 : 2) : pen[1] < pen[2] ? 1 : 2;
		lo[k] = (lo[k] < 0 ? -1 : 1) * (s.h[k] + R);
		const w = add(s.c, qRotate(s.q, lo));
		if (w[1] > x[o + 1] + 1e-9 && k === 1) top = true;
		x[o] = w[0]; x[o + 1] = w[1]; x[o + 2] = w[2];
	}
	if (x[o + 1] < R) { x[o + 1] = R; top = true; } // a box's underside pushes no point under the floor
	return top;
}

/** Line l before frame 0, laid from what frame 0 fastens (pins: Map(point index -> world point)), so that no fastening
 *  drags it through a prop: between two fastened points it runs straight from one to the other, and an end past the
 *  outermost one goes with that point as it lay. -> each segment's length as laid (shorter than its own where the span
 *  is slack: the settling lets that out, so a slack span sinks from the straight line); null with nothing fastened. */
function layOut(l, pins) {
	const ids = [...pins.keys()].sort((a, b) => a - b), x0 = l.x.slice(), len = new Float64Array(l.N).fill(l.seg);
	if (!ids.length) return null;
	for (let n = 0; n + 1 < ids.length; n++) { const a = pins.get(ids[n]), b = pins.get(ids[n + 1]); len.fill(Math.min(l.seg, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (ids[n + 1] - ids[n])), ids[n], ids[n + 1]); }
	for (let i = 0; i <= l.N; i++) {
		const hi = ids.find(k => k >= i) ?? ids.at(-1), lo = ids.findLast(k => k <= i) ?? ids[0], a = pins.get(lo), b = pins.get(hi), u = (i - lo) / (hi - lo || 1);
		const bow = lo < hi && len[lo] < l.seg ? BOW * Math.sin(Math.PI * u) : 0; // a slack span starts a hair to the side, so one straight up and down opens too
		l.x.set(lo < hi ? add(mixV(a, b, u), [l.along[0] * bow, 0, l.along[1] * bow]) : [0, 1, 2].map(c => a[c] + x0[i * 3 + c] - x0[lo * 3 + c]), i * 3);
	}
	return len;
}

/** One frame of line l: SUB substeps of gravity and the length rule; pins: Map(point index -> world point it ends the
 *  frame at), each moved there along a straight line from where the point began the frame. len: each segment's length
 *  in this step (the settling before frame 0), else its own. */
function step(l, pins, solids, damp, len = null) {
	const { x, v, N, seg } = l, dt = 1 / (24 * SUB), from = new Map([...pins.keys()].map(i => [i, point3(x, i)])), prev = new Float64Array(x.length);
	for (let sI = 1; sI <= SUB; sI++) {
		prev.set(x);
		for (let i = 0; i <= N; i++) {
			const o = i * 3;
			if (pins.has(i)) { const p = mixV(from.get(i), pins.get(i), sI / SUB); x[o] = p[0]; x[o + 1] = p[1]; x[o + 2] = p[2]; continue; }
			x[o] += v[o] * dt * (1 - damp); x[o + 1] += (v[o + 1] * (1 - damp) - G * dt) * dt; x[o + 2] += v[o + 2] * dt * (1 - damp);
		}
		const rest = new Uint8Array(N + 1);
		for (let it = 0; it < IT; it++) {
			for (let k = 0; k < N; k++) {
				const i = it % 2 ? N - 1 - k : k, a = i * 3, b = a + 3, pa = pins.has(i), pb = pins.has(i + 1);
				if (pa && pb) continue;
				const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2], d = Math.hypot(dx, dy, dz);
				if (d < 1e-12) continue;
				const c = (d - (len ? len[i] : seg)) / d, wa = pa ? 0 : pb ? 1 : 0.5, wb = pb ? 0 : pa ? 1 : 0.5;
				x[a] += dx * c * wa; x[a + 1] += dy * c * wa; x[a + 2] += dz * c * wa;
				x[b] -= dx * c * wb; x[b + 1] -= dy * c * wb; x[b + 2] -= dz * c * wb;
			}
			for (let i = 0; i <= N; i++) if (!pins.has(i) && pushOut(l, i, solids)) rest[i] = 1;
		}
		for (let i = 0; i <= N; i++) {
			const o = i * 3, keep = rest[i] ? 1 - FRICTION : 1;
			v[o] = (x[o] - prev[o]) / dt * keep; v[o + 1] = (x[o + 1] - prev[o + 1]) / dt; v[o + 2] = (x[o + 2] - prev[o + 2]) / dt * keep;
		}
	}
}

/** The world point an anchor of l fastens its point to on frame f; ctx: { props, byId }. */
function targetOf(l, a, f, { props, byId }) {
	if (a.kind === "hold") return byId[a.who].world.pos[HAND[a.hand]];
	const to = a.to;
	if (Array.isArray(to.world)) return to.world;
	if (to.joint !== undefined) return otherPoint(byId, to, f, true);
	if (to.on !== undefined && props[to.on]) return onPoint(props, to.part === undefined ? to : { on: to.on, at: add(partOf(props[to.on].parts ?? partBoxes(props[to.on]), to.part, to.on, `${l.id} ${a.kind} at frame ${a.f0}`).c, to.at ?? [0, 0, 0]) }, true);
	throw bad(l.id, `${a.kind} at frame ${a.f0}: to wants {on: propId, part?, at?}, {joint, of: characterId, at?} or {world: [x, y, z]}, got ${JSON.stringify(to)}`);
}
const nameOf = a => (a.kind === "hold" ? `${a.who}'s ${HANDS[a.hand]} hand` : a.to.world ? `the world point [${a.to.world.map(v => +v.toFixed(2)).join(", ")}]` : a.to.joint !== undefined ? `${a.to.of}'s ${a.to.joint}` : `${a.to.on}${a.to.part !== undefined ? ` (${a.to.part})` : ""}`);
const carrierOf = a => (a.kind === "hold" ? a.who : a.to.joint !== undefined ? a.to.of : a.to.on ?? null);

/** Starts and ends the fastenings of line l on frame f: its own keys and the holds of hands (events from spec-layers.js
 *  lineHold: { f, who, hand, at?, off? }); a let-go or untie before a fastening on the same frame. */
function fasten(l, f) {
	const ends = [...l.keys.filter(k => k.f === f && k.verb === "untie"), ...l.events.filter(e => e.f === f && e.off)], starts = [...l.keys.filter(k => k.f === f && k.verb !== "untie"), ...l.events.filter(e => e.f === f && !e.off)];
	for (const k of ends) {
		if (k.verb === "untie") l.anchors = l.anchors.filter(a => a.kind === "hold" || (k.at !== undefined ? a.s !== k.at : k.to !== undefined ? JSON.stringify(a.to) !== JSON.stringify(k.to) : false));
		else l.anchors = l.anchors.filter(a => !(a.kind === "hold" && a.who === k.who && (k.hand === undefined || a.hand === k.hand)));
	}
	for (const k of starts) {
		const a = k.verb ? { kind: k.verb, to: k.to, s: k.verb === "tie" ? k.at : null, over: k.over ?? 0, f0: f } : { kind: "hold", who: k.who, hand: k.hand, s: k.at ?? null, over: 0, f0: f };
		l.anchors = l.anchors.filter(b => !(a.s !== null && b.s === a.s) && !(a.kind === "hold" && b.kind === "hold" && b.who === a.who && b.hand === a.hand));
		l.anchors.push(a);
	}
}

/** Point index of anchor a of l, given its target p. A tie or a hold: its place (a hold with no at: the point nearest the
 *  hand as it takes hold). "over": first the inner point nearest it; then, between two points fastened on either side
 *  (fixed: those anchors with i and p of this frame), the line slides over it so that the two spans share the line
 *  between those points as the straight distances to it share it (both as taut, or as slack), one point a frame at most
 *  (at once on frame 0); with no fastened point on a side it stays where it lies. */
function indexOf(l, a, p, fixed, f) {
	if (a.kind !== "over") { if (a.s === null) a.s = nearest(l, p); return Math.max(0, Math.min(l.N, Math.round(a.s / l.seg))); }
	if (a.i === undefined) { let d = Infinity; for (let i = 1; i < l.N; i++) { const e = Math.hypot(l.x[i * 3] - p[0], l.x[i * 3 + 1] - p[1], l.x[i * 3 + 2] - p[2]); if (e < d) { d = e; a.i = i; } } }
	const lo = fixed.filter(b => b.i < a.i).sort((x, y) => y.i - x.i)[0], hi = fixed.filter(b => b.i > a.i).sort((x, y) => x.i - y.i)[0];
	if (lo && hi && hi.i - lo.i > 1) {
		const dl = Math.hypot(...p.map((v, k) => v - lo.p[k])), dh = Math.hypot(...p.map((v, k) => hi.p[k] - v)), want = Math.max(lo.i + 1, Math.min(hi.i - 1, Math.round(lo.i + (hi.i - lo.i) * dl / (dl + dh || 1))));
		a.i = f === 0 ? want : a.i + Math.sign(want - a.i);
	}
	return a.i;
}

/** Solves every line of the props map for frame f (engine.js, after the frame's bodies and props); writes the clip's
 *  points. ctx: { props, byId, F, hollow: Set of prop ids }. */
export function solveLines(props, f, ctx) {
	const lines = props[LINES];
	if (!lines?.size) return;
	const solids = solidsAt(props, ctx.hollow);
	for (const l of lines.values()) {
		fasten(l, f);
		const pins = new Map(), now = [], fixed = [];
		for (const a of [...l.anchors.filter(b => b.kind !== "over"), ...l.anchors.filter(b => b.kind === "over")]) {
			let p = targetOf(l, a, f, ctx).slice();
			const i = indexOf(l, a, p, fixed, f), here = point3(l.x, i);
			if (a.kind !== "over") fixed.push({ i, p });
			if (a.start === undefined) { a.start = here; if (f > 0 && a.over === 0) { const d = Math.hypot(p[0] - here[0], p[1] - here[1], p[2] - here[2]); if (d > 0.05) l.told.jumps.push({ f, s: +(i * l.seg).toFixed(2), name: nameOf(a), d }); } }
			if (a.over > 0 && f - a.f0 < a.over && f > 0) p = mixV(a.start, p, smooth((f - a.f0) / a.over));
			if (p[1] < l.R) { l.told.floor.push({ f, s: +(i * l.seg).toFixed(2), name: nameOf(a), d: l.R - p[1] }); p[1] = l.R; }
			pins.set(i, p); now.push({ i, name: nameOf(a), kind: a.kind, by: carrierOf(a) });
		}
		if (f === 0) { const laid = layOut(l, pins); for (let k = 0; k < SETTLE; k++) step(l, pins, solids, SETTLE_DAMP, laid && k < PAY ? laid.map(d => d + (l.seg - d) * (k + 1) / PAY) : null); l.v.fill(0); }
		step(l, pins, solids, DAMP);
		if (!l.out) l.out = { id: l.id, length: l.L, thick: 2 * l.R, segments: l.N, points: new Float32Array(ctx.F * (l.N + 1) * 3), by: [], ...(l.shownKeys.length ? { shown: [] } : {}) };
		l.out.points.set(l.x, f * (l.N + 1) * 3);
		l.out.by.push([...new Set(now.map(a => a.by).filter(Boolean))]);
		l.out.shown?.push(shownAt(l, f));
		l.told.spans.push(now.sort((a, b) => a.i - b.i));
	}
}

/** The clip's lines and what the tool reads of them (aux.lines: per line its segment length and, per frame, its fastened
 *  points; the fastenings that moved a point over 0.05 m in one frame; the points asked under the floor; aux.lineSolids:
 *  the boxes, in each prop's own frame, that the lines were pushed out of). */
export function linesOut(props, hollow) {
	const lines = [...(props[LINES]?.values() ?? [])];
	const solids = Object.values(props).filter(p => !hollow.has(p.id)).map(p => ({ id: p.id, boxes: (p.parts ?? [{ c: [0, 0, 0], q: [0, 0, 0, 1], h: p.size.map(v => v / 2) }]).map(b => ({ c: b.c, q: b.q, h: b.h })) }));
	return { clip: lines.map(l => l.out), aux: { lines: Object.fromEntries(lines.map(l => [l.id, { seg: l.seg, R: l.R, ...l.told }])), lineSolids: solids } };
}

/** A hold or a release of a line by character id (spec-layers.js buildUpper): the hand keys (to the line's point at `at`
 *  metres along it over `over` frames, then kept where it took hold, as a hold of a box) and the line's event, pushed to
 *  events: { f, who, hand, at?, off? }. k: the action's frame, over and ease as buildUpper reads them. */
export function lineHold(id, verb, o, k, keys, events, l) {
	const name = ["L", "R"], hands = o.hand === "both" ? [0, 1] : o.hand === "L" ? [0] : o.hand === "R" ? [1] : null;
	if (verb === "release") { events.push({ f: k.f, prop: o.prop, who: id, hand: hands?.length === 1 ? hands[0] : undefined, off: true }); return; }
	if (!hands) throw bad(id, `hold at frame ${k.f}: hand wants "L", "R" or "both"`);
	for (const i of hands) {
		const at = typeof o.at === "number" ? o.at : o.at?.[name[i]];
		if (o.at !== undefined && !(Number.isFinite(at) && at >= 0 && at <= l.L)) throw bad(id, `hold of the line ${l.id} at frame ${k.f}: at wants metres along it from 0 to ${l.L} (one number, or {L, R} for both hands), got ${JSON.stringify(o.at)}`);
		const place = at === undefined ? undefined : { on: o.prop, at }, over = at === undefined ? 0 : Math.max(0, Math.ceil(k.over));
		if (over > 0) keys[name[i]].push({ ...k, to: place });
		keys[name[i]].push({ f: k.f + over, over: 0, ease: "inout", fast: k.fast, to: "keep", place, auto: true, by: k.f });
		events.push({ f: k.f + over, prop: o.prop, who: id, hand: i, at });
	}
}
