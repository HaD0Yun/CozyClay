// The balance row (the studio variant's flag "balance", compile-tool.mjs): on the frames where a body is at rest, how far
// its centre of mass, dropped to the floor, lies outside the area its supports span. Nothing here moves a body: the row
// tells the writer, who chooses the posture. Everything is read from the parsed clip, the build's aux and the spec as
// built (repeats written out); nothing knows a motion.
//
// Masses: the shares of an adult human body's segments (a standard table of body segment parameters), each at a point of
// its segment between two places of the clip, so they follow the character's scale. What a body holds or carries is not weighed, nor a
// support (the row's note names it).
// At rest: the Hips joint and both ankle joints move at most BALANCE.still x scale metres to each neighbouring frame, on
// at least BALANCE.frames frames in a row, with no tilt (and no tilt blending back) and no pose, carry, hold or place of
// its own within its first `over` frames (12 when not given), and no sit, stand, kneel or lie of its own within its `over`
// frames (when not given: up to its next body action; a stand of a body that does not sit changes nothing, as in the engine).
// The posture is the engine's (spec-layers.js buildBody): a sit, kneel or lie holds until a stand of a body that sat, or
// until a walk, run, push or turn takes a step (a foot of the engine's own body layer, built again here from the scene
// as the engine builds it, before poses and tilt, lifts or lands within it).
// Supports, each dropped to the floor plane:
//   a foot the engine holds planted (aux.contacts): its sole from under the ankle to the toe tip, BALANCE.foot x scale
//     wide, the corners within 20 mm x scale of its lowest corner;
//   in a sit: the hip joints and the points halfway to the knees (on a prop: those over the prop's footprint);
//   in a kneel: a knee joint within BALANCE.near x scale of the floor or of a prop that does not move;
//   in a lie: every joint (on a prop: those over its footprint);
//   a hand, an elbow or a foot within BALANCE.on of the target its pose gave it (aux.reach; a foot whose target lies
//     under the lowest its ankle can be: of that target raised by the entry's floor, where the floor stops it), where
//     that target lies within BALANCE.near x scale of the floor or of a prop that does not move (a foot: its sole, as a
//     planted one).
// The side: from the hip joints (left, right, and the line across them: front and back, in a lie feet and head).
// A frame with a support the engine cannot vouch for is not told: a sit or a lie on a prop that moves, or a hand, an
// elbow or a foot on its target on a prop that moves or on another body. Nor is a frame with no support counted.
import { INDEX as J, JOINT_COUNT, REST, TIPS } from "../rig17.js";
import { qConj, qRotate } from "../engine-simple/math.js";
import { SOLE } from "../engine-simple/solve.js";
import { buildBodySized } from "../engine-simple/size.js";

export const BALANCE = Object.freeze({ still: 0.002, frames: 12, outside: 0.03, foot: 0.09, near: 0.1, on: 0.01 });
const SIDE = ["L", "R"], LR = ["Left", "Right"], MM = 1000;
const POSE_SLOT = [["L", "hands"], ["R", "hands"], ["footL"], ["footR"], ["elbowL"], ["elbowR"]], SLOT_NAME = ["L hand", "R hand", "L foot", "R foot", "L elbow", "R elbow"];
const BLENDS = new Set(["pose", "carry", "hold", "place"]), POSTURES = new Set(["sit", "stand", "kneel", "lie"]), BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);
const tipOf = name => TIPS[name].map((v, k) => v - REST[J[name]][k]); // a tip from its joint, in the joint's rest frame
// [share, from, to, along]: a place is a joint index, [joint, tip offset] or ["mid", a, b]
const SEGMENTS = [
	[0.081, J.Head, [J.Head, tipOf("Head")], 0.5], [0.216, J.Spine2, J.Neck, 0.5], [0.139, J.Spine, J.Spine2, 0.5], [0.142, J.Hips, ["mid", J.LeftUpLeg, J.RightUpLeg], 0.5],
	...LR.flatMap(s => [[0.028, J[`${s}Arm`], J[`${s}ForeArm`], 0.436], [0.016, J[`${s}ForeArm`], J[`${s}Hand`], 0.43], [0.006, J[`${s}Hand`], [J[`${s}Hand`], tipOf(`${s}Hand`)], 0.4],
		[0.1, J[`${s}UpLeg`], J[`${s}Leg`], 0.433], [0.0465, J[`${s}Leg`], J[`${s}Foot`], 0.433], [0.0145, J[`${s}Foot`], [J[`${s}Foot`], tipOf(`${s}Foot`)], 0.5]]),
];
const SOLES = LR.map(s => { const toe = tipOf(`${s}Foot`); return [[1, toe], [-1, toe], [1, SOLE], [-1, SOLE]]; });

/** A point of the convex hull of `pts` ([x, z]) nearest to p, and how far p lies outside it (0 inside). */
function outsideHull(p, pts) {
	const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), half = list => { const h = []; for (const q of list) { while (h.length > 1 && cr(h.at(-2), h.at(-1), q) <= 1e-12) h.pop(); h.push(q); } h.pop(); return h; };
	const hull = s.length < 3 ? s : [...half(s), ...half(s.slice().reverse())], seg = (a, b) => { const d = [b[0] - a[0], b[1] - a[1]], l = d[0] ** 2 + d[1] ** 2, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l)) : 0; return [a[0] + d[0] * t, a[1] + d[1] * t]; };
	if (hull.length > 2 && hull.every((a, i) => cr(a, hull[(i + 1) % hull.length], p) >= 0)) return { d: 0, near: p };
	let best = { d: Infinity };
	for (let i = 0; i < hull.length; i++) { const q = seg(hull[i], hull[(i + 1) % hull.length]), d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best.d) best = { d, near: q }; }
	return best;
}

// the side: fwd along the hip joints' line turned a quarter in the floor plane, left along that line; ends: the words of
// fwd's two ends (front and back; for a body that lies on its back that direction is toward its feet)
const way = (fwd, left, [pos, neg]) => { const a = Math.atan2(left, fwd) * 180 / Math.PI, side = a > 0 ? "left" : "right", m = Math.abs(a), end = m < 90 ? pos : neg, both = pos === "front" ? `${end} ${side}` : `${end} and ${side}`; return m <= 22.5 ? pos : m >= 157.5 ? neg : m < 67.5 || m > 112.5 ? both : side; };
const spans = list => list.reduce((out, f) => { if (out.at(-1)?.[1] === f - 1) out.at(-1)[1] = f; else out.push([f, f]); return out; }, []).map(([a, b]) => (a === b ? `f${a}` : `f${a}-${b}`));

/** The balance rows of a clip: one per character with a frame at rest whose centre of mass lies more than
 *  BALANCE.outside x scale outside its supports. spec: the spec as built; scene: the scene the clip was built from
 *  (without it a walk, run, push or turn ends a posture). -> [row] (measure.mjs row shape). */
export function balanceRows(clip, aux, spec, scene) {
	const layerProps = Object.fromEntries((scene?.props ?? []).map(p => [p.id, { id: p.id, size: p.size, c: p.at.slice(), turn: (p.turn ?? 0) * Math.PI / 180 }])); // as engine.js gives them to the body layer
	const F = clip.frameCount, rows = [], statics = clip.props.filter(p => p.pos.length === 3), moving = new Set(clip.props.filter(p => p.pos.length > 3).map(p => p.id)), chars = new Set(clip.characters.map(c => c.id));
	const local = (p, pt) => qRotate(qConj(p.quat.slice(0, 4)), [pt[0] - p.pos[0], pt[1] - p.pos[1], pt[2] - p.pos[2]]);
	const toBox = (p, pt) => { const l = local(p, pt).map((v, k) => Math.abs(v) - p.size[k] / 2); return Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)); };
	const overTop = (p, pt) => { const l = local(p, pt); return Math.abs(l[0]) <= p.size[0] / 2 && Math.abs(l[2]) <= p.size[2] / 2; };
	const surface = (pt, s) => { if (pt[1] <= BALANCE.near * s) return "the floor"; return statics.find(p => toBox(p, pt) <= BALANCE.near * s)?.id ?? null; }; // the floor or a static prop it lies on or near
	for (const c of clip.characters) {
		const s = c.scale ?? 1, at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; }, rot = (f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
		const place = (f, x) => { if (!Array.isArray(x)) return at(f, x); if (x[0] === "mid") return at(f, x[1]).map((v, k) => (v + at(f, x[2])[k]) / 2); const o = qRotate(rot(f, x[0]), x[1]); return at(f, x[0]).map((v, k) => v + o[k] * s); };
		const com = f => SEGMENTS.reduce((m, [w, a, b, t]) => { const p = place(f, a), q = place(f, b); return m.map((v, k) => v + w * (p[k] + (q[k] - p[k]) * t)); }, [0, 0, 0]);
		const sole = (f, side) => { const pts = SOLES[side].map(([x, o]) => { const d = qRotate(rot(f, J[`${LR[side]}Foot`]), [o[0] + x * BALANCE.foot / 2, o[1], o[2]]); return at(f, J[`${LR[side]}Foot`]).map((v, k) => v + d[k] * s); }), low = Math.min(...pts.map(p => p[1])); return pts.filter(p => p[1] <= low + 0.02 * s); };
		const acts = (Array.isArray(spec[c.id]) ? spec[c.id] : []).filter(a => Array.isArray(a) && Number.isInteger(a[0])).slice().sort((a, b) => a[0] - b[0]);
		const tilts = acts.filter(a => a[1] === "pose" && a[2]?.tilt !== undefined);
		const tilted = f => { const k = tilts.findLast(a => a[0] <= f); if (!k) return false; const t = k[2].tilt ?? []; return [t[0], t[1], ...(k[2].shift ?? [])].some(v => Number(v ?? 0)) || f < k[0] + (k[2].over ?? 12); }; // read as the engine reads it (spec-layers.js buildUpper)
		// the posture of each frame and the posture changes ([from, to]), by the engine's rules (the header)
		// the body layer's frames (only its feet's planted flags are read, so the floor under a kneel or a lie is not needed)
		const sc = scene?.characters?.find(x => x.id === c.id), layer = sc && buildBodySized(sc, (spec[c.id] ?? []).slice().sort((a, b) => a[0] - b[0]), F, { props: layerProps, ground: () => 0 }, s);
		const body = acts.filter(a => BODY.has(a[1])), stance = new Array(F).fill(null), changes = [];
		let cur = null, seat = false;
		body.forEach((a, i) => {
			const end = Math.min(F, body[i + 1]?.[0] ?? F), from = Math.max(0, a[0]), stands = a[1] === "stand" && seat;
			const steps = () => { if (!layer) return true; for (let g = from + 1; g < end; g++) if ([0, 1].some(k => !!layer[g].feet[k].planted !== !!layer[g - 1].feet[k].planted)) return true; return false; };
			if (a[1] === "sit" || a[1] === "kneel" || a[1] === "lie") { cur = a; seat ||= a[1] === "sit"; }
			else if (stands || (a[1] !== "stand" && a[1] !== "idle" && steps())) { cur = null; seat = false; }
			if (POSTURES.has(a[1]) && (a[1] !== "stand" || stands)) changes.push([a[0], a[2]?.over != null ? a[0] + Math.round(a[2].over) : end]); // until its over ends, else the next body action
			for (let f = from; f < end; f++) stance[f] = cur;
		});
		const blending = f => acts.some(a => BLENDS.has(a[1]) && a[0] <= f && f < a[0] + (a[2]?.over ?? 12)) || changes.some(([a, b]) => a <= f && f < b);
		const posture = f => stance[f];
		const still = f => [J.Hips, J.LeftFoot, J.RightFoot].every(j => [f - 1, f + 1].every(g => g < 0 || g >= F || Math.hypot(...at(f, j).map((v, k) => v - at(g, j)[k])) <= BALANCE.still * s));
		const quiet = Array.from({ length: F }, (_, f) => still(f) && !tilted(f) && !blending(f)), rest = quiet.map(() => false);
		for (let f = 0; f < F;) { let g = f; while (g < F && quiet[g]) g++; if (g - f >= BALANCE.frames) for (let k = f; k < g; k++) rest[k] = true; f = g + 1; }
		// what holds the body up on frame f: { pts, names } or null when a support the engine cannot vouch for is in use
		const supports = f => {
			const pts = [], names = [];
			[0, 1].forEach(side => { if (aux.contacts[c.id]?.[f]?.[side]) { pts.push(...sole(f, side)); names.push(`${SIDE[side]} foot planted`); } });
			const p = posture(f), prop = p?.[2]?.on != null ? clip.props.find(q => q.id === p[2].on) : null;
			if (prop && moving.has(prop.id)) return null;
			if (p?.[1] === "sit") { const list = [J.LeftUpLeg, J.RightUpLeg].flatMap(j => [at(f, j), at(f, j).map((v, k) => (v + at(f, j + 1)[k]) / 2)]).filter(q => !prop || overTop(prop, q)); if (list.length) { pts.push(...list); names.push(prop ? `the seat on ${prop.id}` : "the seat"); } }
			if (p?.[1] === "kneel") [J.LeftLeg, J.RightLeg].forEach((j, side) => { if (surface(at(f, j), s)) { pts.push(at(f, j)); names.push(`${SIDE[side]} knee`); } });
			if (p?.[1] === "lie") { const list = Array.from({ length: JOINT_COUNT }, (_, j) => at(f, j)).filter(q => !prop || overTop(prop, q)); if (list.length) { pts.push(...list); names.push(prop ? `lying on ${prop.id}` : "lying"); } }
			for (let slot = 0; slot < 6; slot++) {
				const e = aux.reach[c.id]?.[f]?.[slot];
				if (!e || (e.floor ? Math.hypot(...at(f, slot === 2 ? J.LeftFoot : J.RightFoot).map((v, k) => v - e.t[k] - (k === 1 ? e.floor : 0))) : e.d) > BALANCE.on) continue; // a foot the floor stops: from its target raised by e.floor
				const key = acts.findLast(a => a[0] === e.key && a[1] === "pose" && POSE_SLOT[slot].some(n => a[2]?.[n] !== undefined)), t = key && POSE_SLOT[slot].map(n => key[2][n]).find(v => v !== undefined);
				if (!t || typeof t !== "object") continue; // the rest pose, a hold, a carry or a place: no support
				const id = Array.isArray(t) ? null : t.on ?? t.prop ?? t.meet ?? t.chest ?? t.of;
				if (id != null && (moving.has(id) || (chars.has(id) && id !== c.id))) return null;
				if (!Array.isArray(t) && t.joint && (!t.of || t.of === c.id)) continue; // a place on its own body
				const on = surface(e.t, s);
				if (!on) continue;
				pts.push(...(slot === 2 || slot === 3 ? sole(f, slot - 2) : [at(f, [J.LeftHand, J.RightHand, 0, 0, J.LeftForeArm, J.RightForeArm][slot])]));
				names.push(`${SLOT_NAME[slot]} on its target on ${on}`);
			}
			return pts.length ? { pts, names } : null;
		};
		let worst = null;
		const off = [];
		for (let f = 0; f < F; f++) {
			if (!rest[f]) continue;
			const sup = supports(f);
			if (!sup) continue;
			const m = com(f), o = outsideHull([m[0], m[2]], sup.pts.map(q => [q[0], q[2]]));
			if (o.d <= BALANCE.outside * s) continue;
			off.push(f);
			if (!worst || o.d > worst.d) worst = { f, d: o.d, v: [m[0] - o.near[0], m[2] - o.near[1]], names: sup.names };
		}
		if (!worst) continue;
		const held = clip.props.filter(p => String(aux.holders?.[p.id]?.[worst.f] ?? "").split("+").some(h => h.split(":")[0] === c.id)).map(p => p.id);
		const l = at(worst.f, J.LeftUpLeg), r = at(worst.f, J.RightUpLeg), lx = l[0] - r[0], lz = l[2] - r[2], n = Math.hypot(lx, lz) || 1; // the body's left, from its hip joints
		const side = way((worst.v[0] * -lz + worst.v[1] * lx) / n, (worst.v[0] * lx + worst.v[1] * lz) / n, posture(worst.f)?.[1] === "lie" ? ["feet", "head"] : ["front", "back"]);
		rows.push({ key: `balance:${c.id}`, label: "at rest: centre of mass outside its supports", short: "off balance", value: worst.d * MM, unit: "mm", frame: worst.f, who: c.id, worse: 1, spike: BALANCE.outside * s * MM,
			note: `toward its ${side}; over ${Math.round(BALANCE.outside * s * MM)} mm on ${off.length} frame${off.length === 1 ? "" : "s"} at rest (${spans(off).slice(0, 4).join(", ")}${spans(off).length > 4 ? ", ..." : ""}); supports at f${worst.f}: ${worst.names.join(", ")}${held.length ? `; it holds ${held.join(" and ")}, not weighed and not a support` : ""}` });
	}
	return rows;
}
