// The gap rows: for every contact the spec asks for with a prop whose drawn shape is known (the scene's parts,
// engine-simple/parts.js), how far the body ends from the nearest drawn part, measured on the clip as built. Nothing is
// moved by it. A contact, per frame:
//  - hand: a hand whose target is on the prop ({on}, after its blend: aux.reach), or that holds or carries it
//    (aux.holders, aux.grips); the hand is its wrist to its finger tip (5 points), the nearest of them counts.
//  - foot: a foot whose target is on the prop (aux.reach); the foot is its sole and its toe tip.
//  - feet: the frames of a body action on the prop other than a sit or a lie (it stands or walks on it); the foot nearer a part.
//  - seat: the frames of a sit on the prop after its change of posture (its over), up to the next body action: the Hips
//    joint less the engine's seat height (posture.js SEAT_UP, times the body's size) against the highest drawn top under
//    it, up to SUNK over it (+ it floats, - it sinks), or the nearest part when nothing is drawn under it.
// A row is told when the gap passes GAP (times the body's scale) on a tenth of a second's worth of frames or more
// (prompt.mjs seenFrames): one row per body, limb and prop, at its worst frame, with the nearest part there.
import { INDEX as J, JOINT_COUNT, REST, TIPS } from "../rig17.js";
import { qConj, qRotate } from "../engine-simple/math.js";
import { SOLE, TOE } from "../engine-simple/solve.js";
import { SEAT_UP } from "../engine-simple/posture.js";
import { nearestPart, partBoxes, topUnder } from "../engine-simple/parts.js";
import { seenFrames } from "./prompt.mjs";

/** The gap a contact is told past, metres at body scale 1. */
const GAP = 0.03;
const SUNK = 0.1; // m at scale 1: a top this far over the Hips joint is still the seat the hips sank into
const BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);
const HAND = [J.LeftHand, J.RightHand], FOOT = [J.LeftFoot, J.RightFoot], LIMB = ["L hand", "R hand", "L foot", "R foot"];

/** The spans of frames of the spec's body actions on prop id: { sit: [[a, b]], stand: [[a, b]] }. A sit holds through
 *  the idles after it (as inside.mjs reads it); its span starts where its change of posture ends (its over, else its
 *  last frame). */
function bodySpans(acts, id, F) {
	const body = acts.filter(a => Array.isArray(a) && Number.isInteger(a[0]) && BODY.has(a[1])).sort((x, y) => x[0] - y[0]), out = { sit: [], stand: [] };
	for (let i = 0; i < body.length; i++) {
		const a = body[i], end = body.slice(i + 1).find(b => b[0] > a[0])?.[0] ?? F;
		if (a[1] === "sit" && a[2]?.on === id) {
			let k = i + 1;
			while (body[k]?.[1] === "idle") k++;
			out.sit.push([Number.isFinite(a[2].over) ? Math.min(end, a[0] + Math.round(a[2].over)) : end - 1, body[k]?.[0] ?? F]);
			i = k - 1;
		} else if (a[2]?.on === id && a[1] !== "lie" && a[1] !== "sit") out.stand.push([a[0], end]);
	}
	return out;
}

/**
 * The gap rows of a clip: [{ key: "gap:<who>.<limb>><prop>", who, prop, limb, value (mm; a seat signed), frame, part,
 * frames, first, last, limit (mm) }]. def: the scene as built (props with parts); spec: as built (repeats written out).
 */
export function gapRows(clip, aux, { def, spec }) {
	const F = clip.frameCount, rows = new Map(), seen = seenFrames(clip.fps);
	const shapes = (def?.props ?? []).map(p => [p.id, partBoxes(p)]).filter(([, b]) => b);
	if (!shapes.length) return [];
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const off = (c, f, j, v) => { const a = at(c, f, j), d = qRotate(rot(c, f, j), v), s = c.scale ?? 1; return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s]; };
	const handPts = (c, f, i) => { const w = at(c, f, HAND[i]), t = off(c, f, HAND[i], TIPS[i ? "RightHand" : "LeftHand"].map((v, k) => v - REST[HAND[i]][k])); return [0, 1, 2, 3, 4].map(n => w.map((v, k) => v + (t[k] - v) * n / 4)); };
	const footPts = (c, f, i) => [off(c, f, FOOT[i], SOLE), off(c, f, FOOT[i], TOE)];
	const note = (key, e, d, f, part, limit) => {
		const r = rows.get(key) ?? rows.set(key, { ...e, value: 0, frame: f, part, frames: 0, first: f, last: f, limit }).get(key);
		if (Math.abs(d) <= limit) return;
		if (!r.frames) r.first = f;
		r.frames++; r.last = f;
		if (Math.abs(d) > Math.abs(r.value)) Object.assign(r, { value: d, frame: f, part });
	};
	for (const [id, boxes] of shapes) {
		const p = clip.props.find(x => x.id === id);
		if (!p) continue;
		const local = (f, v) => { const i = p.pos.length === 3 ? 0 : f, c = [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]], q = [p.quat[i * 4], p.quat[i * 4 + 1], p.quat[i * 4 + 2], p.quat[i * 4 + 3]]; return qRotate(qConj(q), [v[0] - c[0], v[1] - c[1], v[2] - c[2]]); };
		const nearest = (f, pts) => pts.map(v => nearestPart(boxes, local(f, v))).reduce((a, b) => (b.d < a.d ? b : a));
		for (const c of clip.characters) {
			const s = c.scale ?? 1, limit = GAP * s, spans = bodySpans(Array.isArray(spec?.[c.id]) ? spec[c.id] : [], id, F);
			for (let f = 0; f < F; f++) {
				const reach = aux.reach?.[c.id]?.[f] ?? [], held = String(aux.holders?.[id]?.[f] ?? "").split("+").filter(Boolean), grip = aux.grips?.[id]?.[f];
				for (let i = 0; i < 2; i++) {
					const mine = held.includes(`${c.id}:${"LR"[i]}`) || (held.includes(c.id) && (grip?.c !== c.id || grip.hand === i));
					if (!mine && reach[i]?.on !== id) continue;
					const n = nearest(f, handPts(c, f, i));
					note(`gap:${c.id}.${LIMB[i]}>${id}`, { who: c.id, prop: id, limb: LIMB[i] }, n.d, f, n.part, limit);
				}
				for (let i = 0; i < 2; i++) if (reach[2 + i]?.on === id) { const n = nearest(f, footPts(c, f, i)); note(`gap:${c.id}.${LIMB[2 + i]}>${id}`, { who: c.id, prop: id, limb: LIMB[2 + i] }, n.d, f, n.part, limit); }
				if (spans.stand.some(([a, b]) => f >= a && f < b)) {
					const n = [0, 1].map(i => nearest(f, footPts(c, f, i))).reduce((a, b) => (b.d < a.d ? b : a));
					note(`gap:${c.id}.feet>${id}`, { who: c.id, prop: id, limb: "feet" }, n.d, f, n.part, limit);
				}
				if (spans.sit.some(([a, b]) => f >= a && f < b)) {
					const h = local(f, at(c, f, J.Hips)), top = topUnder(boxes, h[0], h[2], h[1] + SUNK * s), n = top == null ? nearestPart(boxes, h) : null;
					note(`gap:${c.id}.seat>${id}`, { who: c.id, prop: id, limb: "seat" }, top == null ? n.d : h[1] - top - SEAT_UP * s, f, top == null ? `${n.part}, none drawn under the hips` : "the drawn top under the hips", limit);
				}
			}
		}
	}
	return [...rows.values()].filter(r => r.frames >= seen).map(r => ({ ...r, key: `gap:${r.who}.${r.limb}>${r.prop}`, value: r.value * 1000, limit: r.limit * 1000 }));
}
