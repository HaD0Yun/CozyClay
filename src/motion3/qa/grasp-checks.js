// Does the hand hold what it carries (#816)? The COLLIDE check excuses the holding hand and forearm (object-checks.js)
// and nothing judged the fingers, so a ball riding the finger middles, through them, scored QA 0 (session 7f15b4ae).
// On the physical-grasp path: a carry with no at/along (it rests in the hand) or naming a carry grasp, on grab..release,
// and a fit on an object anchor with grasp while it holds (its weight and its fingers' grip at least HELD: the reach has
// arrived and the skill has the hand closed; the object
// still rests where it stands, so SUPPORT does not judge it). A carry pinned with at/along and no
// grasp type (a cigarette, a lighter) keeps its preset grip and is not judged here. With fix.grasp false the carries it
// would seat are judged as they are held (the preset grip; qa/hints-grasp.js turns grasp back on); fix: false judges none.
// The fingers are phalanx capsules
// (PHALANX m) against the held object's shapes (shapes.js: a ball is round, not its box):
//   FINGER_PEN  "<Bone> into <id>": a phalanx's skin deeper than PEN in it
//   THUMB_OFF   "<side> thumb off <id>": a power or spherical hold whose fingers grip it with the thumb tip farther than GAP
//   FINGER_GAP  "<side> fingers off <id>": fewer than 3 of the 4 fingertips within GAP of its surface (pinch: the thumb
//               and the index); the thumb and two fingers hold too (a tripod: a small ball the ring and little fingers do
//               not reach)
//   PALM_OFF    "<side> palm off <id>": a palm or support hold (vocab.js PALM_GRASPS) whose palm (the PALM capsule) is
//               farther than GAP from it, the fingertips on it or not (2026-11-04: a box held by its sides, the palms 2.2 cm
//               off, only the tips on it)
//   PALM_GAP    "<side> palm centre off <id>": a power grip on an object anchor on a bar (reachGrip on a pull-up bar, a
//               barbell: a part BAR_LONG or longer and under BAR_THICK across, the thin bodies sockets.js grips) whose palm
//               centre (the midpoint of the Hand and HandMiddle1 joints) is farther than PALM_REACH from the bar's surface:
//               a bar is held across the palm, not on the finger middles. CONTACT measures the fingers' point, which a power
//               grip puts on the bar 2 cm under the finger middles (vocab.js GRASP_POINTS): physics bench 2026-11-07, the
//               muscle-up's fingers 0.6-1.5 cm from the bar (tol 4) with the palm centres 7.0-7.8 cm off it and QA clean.
//               A short thick body (a can) is not judged: its power grip leaves the palm centre 6 cm off as well
//   TIPS_OFF    "<side> fingertips not under <id>": a support hold with fewer than 3 of the 4 fingertips (the Index4..Pinky4
//               joints) under its box's bottom face, from TIP_BELOW under it to TIP_IN into it and inside its footprint (a
//               box pivots at its bottom centre), on a frame whose box stands SUPPORT_SLIDE clear of what is under it
//               (clearanceAt, the compiler's measure) on every frame within SUPPORT_LEAD of it (../sockets.js). Nearer,
//               the compiler has the fingers out from under it on purpose: the palm presses the side on the table, slides
//               down as the box lifts and comes out before it lands. value: the tips not under, limit 1. (A palm set by
//               hand 0.10-0.15 m up the face keeps the fingers off the bottom: the A/B T2 agents' runs, 0 of 3, sockets.js.)
//   SUPPORT     "<id> not supported": nothing touching it from below holds its centre over its contacts (within
//               SUPPORT_TOL across), no thumb presses against the fingers (OPPOSE deg between their contact normals)
//               and the contacts do not enclose it (their normals no more than ENCLOSE deg apart)
import { add, sub, scale, dot, norm, apply, T } from "../compiler/math.js";
import { PALM_GRASPS } from "../compiler/vocab.js";
import { isCarried } from "../carried.js";
import { spanOf, partsOf, objectPoseAt } from "../object-pose.js";
import { SUPPORT_SLIDE, SUPPORT_LEAD, gapUnder, bottomPoints } from "../sockets.js";
import { SETTLE, seatsInHand } from "../seat.js";
import { shapeOf, normalAt, closestPoint, capsuleDepth, signedDistance } from "../shapes.js";

const PHALANX = 0.009, PALM = 0.022, PEN = 0.004, GAP = 0.008, HELD = 0.995, SUPPORT_TOL = 0.01, OPPOSE = 120, ENCLOSE = 150, BELOW = -0.3, ARRIVED = 0.03;
const TIP_BELOW = 0.025, TIP_IN = 0.006;
/** How far (m) a power grip's palm centre may be from the bar it grips (the bench's "hands reach the bar": 4 cm); a bar is a
 * part at least BAR_LONG along and under BAR_THICK across (sockets.js THIN). */
const PALM_REACH = 0.04, BAR_LONG = 0.15, BAR_THICK = 0.045;
const FINGERS = ["Index", "Middle", "Ring", "Pinky"], SIDE = { l: "Left", r: "Right" };

/** The grasp a held object takes when the spec names none: a sphere's hand cups it, a cylinder's wraps it. */
function defaultGrasp(scene, id) {
	const parts = partsOf(scene, id), kind = parts.length === 1 ? shapeOf(scene.objects[parts[0]]).kind : "box";
	return kind === "sphere" ? "spherical" : kind === "cylinder" ? "power" : null;
}

/** The held carries and grasp fits, each { id, k (hand), grasp, from, to } in absolute frames, with the frames a fit weighs in. */
export function heldSpans(out) {
	const { spec: asked, scene } = out.ctx, spans = [], spec = asked.fix?.grasp === false ? { ...asked, fix: { ...asked.fix, grasp: true } } : asked;
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		// the carries grasp physics seats (with fix.grasp false: the ones it would)
		if (!isCarried(o) || !seatsInHand(spec, o, scene, id)) continue;
		const k = spec.props?.[o.prop]?.hand, [from, to] = spanOf(out, o);
		// judged once the object has settled into the hand (seat.js): the grab itself is the transition
		if (k) spans.push({ id, k, grasp: o.grasp ?? defaultGrasp(scene, id), from: from + SETTLE + 1, to });
	}
	for (const fit of spec.fits ?? []) {
		const a = spec.anchors?.[fit.anchor];
		// a rim socket (a steering wheel) keeps its rim grip: the fingers do not close on the disc the scene draws (finger-close.js)
		if (a?.kind !== "object" || !a.grasp || out.ctx.sockets?.get(fit.anchor)?.rim) continue;
		const ch = `w_${fit.anchor}_${fit.side}`, f0 = out.f0 ?? 0, fingers = out.baked?.[`fingers_${fit.side}`];
		const grip = f => Object.entries(fingers?.[f] ?? {}).reduce((acc, [p, v]) => acc + (p === "relaxed" ? 0 : v || 0), 0);
		const held = f => (out.baked?.[ch]?.[f] ?? 0) >= HELD && grip(f) >= HELD;
		spans.push({ id: a.object, k: fit.side, grasp: a.grasp, from: f0, to: f0 + out.frames.length - 1, held, rests: true });
	}
	return spans;
}

const entriesAt = (out, id, f) => partsOf(out.ctx.scene, id).map(p => ({ ...out.ctx.scene.objects[p], ...objectPoseAt(out, p, f) }));

const isBar = e => { const h = [...(e.half ?? [])].sort((a, b) => a - b); return h.length === 3 && h[1] < BAR_THICK && 2 * h[2] >= BAR_LONG; };

/** The palm centre of hand k (the Hand and HandMiddle1 joints' midpoint) from the nearest bar of `entries` at state s, m (0 inside); null without a bar. */
function palmGap(sk, s, k, entries) {
	const bars = entries.filter(isBar), P = j => s.P[sk.index[`${SIDE[k]}${j}`]];
	if (!bars.length) return null;
	const c = scale(add(P("Hand"), P("HandMiddle1")), 0.5);
	return Math.max(0, Math.min(...bars.map(e => signedDistance(e, c))));
}

/** PALM_GAP's measure at absolute frame f: hand k's palm centre from held object `id`'s bar (m), or null outside the compile or without a bar. */
export function palmGapAt(out, k, id, f) {
	const s = out.frames[f - (out.f0 ?? 0)]?.s;
	return s ? palmGap(out.ctx.sk, s, k, entriesAt(out, id, f)) : null;
}

function handCapsules(sk, s, k) {
	const S = SIDE[k], P = j => s.P[sk.index[`${S}Hand${j}`]], out = [{ bone: `${S}Hand`, finger: "palm", a: s.P[sk.index[`${S}Hand`]], b: P("Middle1"), r: PALM }];
	for (const f of [...FINGERS, "Thumb"]) for (let i = 1; i <= 3; i++) out.push({ bone: `${S}Hand${f}${i}`, finger: f, tip: i === 3, a: P(`${f}${i}`), b: P(`${f}${i + 1}`), r: PHALANX });
	return out;
}

function contacts(capsules, entries) {
	return capsules.map(c => {
		let best = { depth: -Infinity };
		for (const e of entries) { const d = capsuleDepth(e, c.a, c.b, c.r); if (d > best.depth) best = { depth: d, entry: e }; }
		const mid = scale(add(c.a, c.b), 0.5), at = best.entry && closestPoint(best.entry, mid);
		return { ...c, depth: best.depth, at, normal: best.entry && normalAt(best.entry, mid) };
	});
}

function hullDistance(p, pts) {
	if (!pts.length) return Infinity;
	const q = [p[0], p[2]], xs = pts.map(v => [v[0], v[2]]);
	const segDist = (a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1))); return Math.hypot(q[0] - a[0] - t * ab[0], q[1] - a[1] - t * ab[1]); };
	const hull = monotoneHull(xs);
	if (hull.length >= 3 && hull.every((a, i) => { const b = hull[(i + 1) % hull.length]; return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0; })) return 0;
	return Math.min(...hull.map((a, i) => segDist(a, hull[(i + 1) % hull.length])));
}
function monotoneHull(points) {
	const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	if (p.length < 3) return p;
	const lower = [], upper = [];
	for (const v of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), v) <= 0) lower.pop(); lower.push(v); }
	for (const v of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), v) <= 0) upper.pop(); upper.push(v); }
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * How far held object `id` stands above what is under it at absolute frame f, as the compiler measures it for a support
 * hold (../sockets.js gapUnder): from the nearest of nine points across each part's bottom face to the ground
 * (y 0) or to another body whose top is at most 5 mm above that bottom. { gap (m, >= 0), on: that body, null: the ground }.
 */
export function clearanceAt(out, id, f, entries = entriesAt(out, id, f)) {
	const { scene } = out.ctx;
	return gapUnder(scene, new Set([id, ...partsOf(scene, id)]), entries.flatMap(e => bottomPoints(e, e.half)), out.ctx.objectsAt?.(f));
}

/** True when p is under the bottom face of one of `entries` (on the base pivot, local y 0): from TIP_BELOW under it to TIP_IN into it, inside its footprint. */
const tipUnder = (p, entries) => entries.some(e => {
	const q = apply(T(e.R), sub(p, e.pos));
	return q[1] > -TIP_BELOW && q[1] < TIP_IN && Math.abs(q[0]) < e.half[0] && Math.abs(q[2]) < e.half[2];
});

function frameIssues(sk, s, h, entries, push, f, clear) {
	// clear(): the box stands SUPPORT_SLIDE clear of what is under it on every frame within SUPPORT_LEAD (graspChecks)
	const touch = contacts(handCapsules(sk, s, h.k), entries), side = SIDE[h.k].toLowerCase();
	// the palm of an arrived palm or support hold, however far: CONTACT measures the fingers' point to the anchor, and an
	// anchor off the face, or a fist's point, leaves the palm 4-6.5 cm off with CONTACT met (A/B T2 reruns t2h3, t2g1: QA 0)
	if (PALM_GRASPS.has(h.grasp) && touch[0].depth < -GAP) push("PALM_OFF", `${side} palm off ${h.id}`, f, -touch[0].depth, GAP);
	const gap = h.rests && h.grasp === "power" ? palmGap(sk, s, h.k, entries) : null;
	if (gap !== null && gap > PALM_REACH) push("PALM_GAP", `${side} palm centre off ${h.id}`, f, gap, PALM_REACH);
	// a reach whose hand never got there is REACH's and CONTACT's to report, not the fingers'
	if (h.rests && touch[0].depth < -ARRIVED) return;
	for (const c of touch) if (c.finger !== "palm" && c.depth > PEN) push("FINGER_PEN", `${c.bone} into ${h.id}`, f, c.depth, PEN);
	const tipOn = finger => touch.some(c => c.finger === finger && c.tip && c.depth >= -GAP);
	const fingersOn = FINGERS.filter(tipOn).length, thumb = tipOn("Thumb");
	// a pinch holds between the thumb and the index; a small ball in a tripod (the thumb and two fingers); else three fingers
	const gripped = h.grasp === "pinch" ? thumb && tipOn("Index") : fingersOn >= 3 || (thumb && fingersOn >= 2);
	if (!gripped) push("FINGER_GAP", `${side} fingers off ${h.id}`, f, fingersOn + (thumb ? 1 : 0), h.grasp === "pinch" ? 2 : 3);
	// a power or spherical hold closes the thumb against the fingers: three fingertips on the ball with the thumb out passed
	else if (!thumb && (h.grasp === "power" || h.grasp === "spherical")) push("THUMB_OFF", `${side} thumb off ${h.id}`, f, -Math.max(...touch.filter(c => c.finger === "Thumb" && c.tip).map(c => c.depth)), GAP);
	// a support hold carries the box on its fingertips once there is room under it
	if (h.grasp === "support" && clear()) {
		const tips = FINGERS.map(x => sk.index[`${SIDE[h.k]}Hand${x}4`]), n = tips.filter(j => j !== undefined && tipUnder(s.P[j], entries)).length;
		if (tips.every(j => j !== undefined) && n < 3) push("TIPS_OFF", `${side} fingertips not under ${h.id}`, f, 4 - n, 1);
	}
	const on = touch.filter(c => c.depth >= -GAP && c.normal);
	const c0 = scale(entries.reduce((acc, e) => add(acc, add(e.pos, apply(e.R, [0, e.half[1], 0]))), [0, 0, 0]), 1 / entries.length);
	const under = on.filter(c => c.normal[1] <= BELOW).map(c => c.at);
	const thumbN = on.filter(c => c.finger === "Thumb").map(c => c.normal), fingerN = on.filter(c => FINGERS.includes(c.finger)).map(c => c.normal);
	const mean = v => (v.length ? norm(v.reduce(add, [0, 0, 0])) : null), tn = mean(thumbN), fn = mean(fingerN);
	const opposed = tn && fn && (Math.acos(Math.max(-1, Math.min(1, dot(tn, fn)))) * 180) / Math.PI >= OPPOSE;
	const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
	const enclosed = on.some((a, i) => on.slice(i + 1).some(b => angle(a.normal, b.normal) >= ENCLOSE));
	if (!h.rests && !opposed && !enclosed && hullDistance(c0, under) > SUPPORT_TOL) push("SUPPORT", `${h.id} not supported`, f, Math.min(1, hullDistance(c0, under)), SUPPORT_TOL);
}

/** FINGER_PEN, FINGER_GAP, PALM_OFF, PALM_GAP, TIPS_OFF and SUPPORT issues of every held span (frames index out.frames, as every check's). */
export function graspChecks(sk, out) {
	// fix.grasp false is judged too: the hand that keeps its preset grip is what its hint turns grasp back on for
	if (out.ctx.spec.fix === false) return [];
	const issues = [], f0 = out.f0 ?? 0, push = (kind, msg, i, value, limit) => issues.push({ kind, msg, frame: i, value: +value.toFixed(4), limit });
	// what is under a held object, once a frame for both hands (read only for a support hold)
	const gaps = new Map(), gapAt = (id, g) => {
		if (!gaps.has(`${id}|${g}`)) gaps.set(`${id}|${g}`, clearanceAt(out, id, g).gap);
		return gaps.get(`${id}|${g}`);
	};
	const clearOf = (id, f) => () => {
		for (let g = Math.max(0, f - SUPPORT_LEAD); g <= Math.min(out.frameCount - 1, f + SUPPORT_LEAD); g++) if (gapAt(id, g) < SUPPORT_SLIDE) return false;
		return true;
	};
	for (const h of heldSpans(out)) {
		for (let f = Math.max(h.from, f0); f <= Math.min(h.to, f0 + out.frames.length - 1); f++) {
			if (h.held && !h.held(f)) continue;
			const entries = entriesAt(out, h.id, f);
			if (entries.length) frameIssues(sk, out.frames[f - f0].s, h, entries, push, f - f0, clearOf(h.id, f));
		}
	}
	return issues;
}

/** How many of hand k's 4 fingertips are under the bottom face of held object `id` at absolute frame f (TIPS_OFF's measure), or null without finger joints. */
export function tipsUnder(out, id, k, f) {
	const { sk } = out.ctx, s = out.frames[f - (out.f0 ?? 0)]?.s, tips = FINGERS.map(x => sk.index[`${SIDE[k]}Hand${x}4`]), entries = entriesAt(out, id, f);
	return s && tips.every(j => j !== undefined) ? tips.filter(j => tipUnder(s.P[j], entries)).length : null;
}
