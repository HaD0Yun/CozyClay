// What a hand holds weighs on its arm (#816). The load on a hand is the held object's mass (mass.js) x G x the
// horizontal distance from its shoulder to its wrist (N m), read on the solved frames:
//   sag      a carry whose load can reach LIGHT N m (its mass at the arm's full reach) lowers the wrist target of a
//            plain IK hand (a hand_k target: not a fit, whose passes re-solve it, nor a keyed carry, whose keys lead
//            it) by min(SAG_MAX, SAG_PER_KG x mass) and draws it as far in toward the shoulder, so the elbow bends
//            more; eased in over the settle from the grab and out the same before the release (seat.js SETTLE)
//   observe  output.observations.load: each hand that carries something, { object, mass, maxNm, at, frames }
//   LOAD     "<side> holds <id> at <x> N m": past QA_LIMITS-style ONE_HAND N m with no second hand on the object; its
//            hint asks for the other hand, and when the right hand holds, a patch adds a left reachGrip that arrives at
//            the grab on the object's face nearest the left shoulder, with the other faces as candidates repair compiles
//            and picks from (repair.js; second-hand.js holds only a right-hand carry)
// fix.grasp false turns all three off: the take of before.
import { add, sub, scale, norm, apply, T, len } from "./compiler/math.js";
import { SIDES } from "./compiler/pose.js";
import { armReach } from "./compiler/anchors.js";
import { isCarried } from "./carried.js";
import { massOf } from "./mass.js";
import { handOf, spanOf, partsOf, objectPoseAt } from "./object-pose.js";
import { SETTLE, restOf } from "./seat.js";

const REACH = 10, G = 9.81, LIGHT = 2, SAG_MAX = 0.06, SAG_PER_KG = 0.006, ONE_HAND = 25, SECOND = 0.5;
// the left palm's axis sits a palm radius (qa/grasp-checks.js PALM) out of the face, so its skin is on it, not its bone;
// on the 12 kg box at 0 the forearm grazed the edge (+X face: QA 42), at 0.022 none (QA 0); at most FACES candidates.
// reachGrip's palm point is the skin's (vocab.js GRASP_POINTS), so the palm stands 2 cm off the face: the patch keeps
// the relaxed fingers QA does not judge as a hold (qa/grasp-checks.js). Judged as one (a palm grasp closes flat, 2026-11-04)
// no face of that box is clean: on the face the forearm meets the edge or the arm falls 11-13 cm short (QA 113-235)
const STANDOFF = 0.022, FACES = 4;
export const LOAD_UNITS = "load: what each hand carries, kg, and its most N m (mass x 9.81 x the shoulder-to-wrist distance across) at f; frames [first, last] held";

const graspOn = spec => spec?.fix !== false && spec?.fix?.grasp !== false;
const ease = t => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };

/** The carries of spec, [id, entry, hand] (hand "l" | "r"). */
const carries = spec => Object.entries(spec.objects ?? {}).filter(([, o]) => isCarried(o) && spec.props?.[o.prop]).map(([id, o]) => [id, o, spec.props[o.prop].hand]);

/**
 * The world offset (m) the wrist target of hand k takes at frame f for what it carries, or null: ctx is the compile
 * context (its spec, scene, sk, carrySpan), s the frame's pose so far, target the wrist target, free the share of the
 * arm on a plain target.
 */
export function sagOf(ctx, k, f, s, target, free) {
	const { spec, scene, sk } = ctx;
	if (!graspOn(spec) || !(free > 1e-3)) return null;
	for (const [id, o, hand] of carries(spec)) {
		if (hand !== k || o.keys?.length) continue;
		const mass = massOf(spec, scene, id), [grab, release] = ctx.carrySpan(o);
		if (f < grab || f > release || mass * G * armReach(sk, k) < LIGHT) continue;
		const w = ease((f - grab) / SETTLE) * ease((release - f) / SETTLE) * free, drop = Math.min(SAG_MAX, SAG_PER_KG * mass) * w;
		if (!(drop > 0)) return null;
		const toShoulder = sub(s.P[sk.index[`${SIDES[k]}Arm`]], target);
		const across = len([toShoulder[0], 0, toShoulder[2]]) > 1e-6 ? norm([toShoulder[0], 0, toShoulder[2]]) : [0, 0, 0];
		return add([0, -drop, 0], scale(across, drop));
	}
	return null;
}

/** N m on hand k on pose s holding `mass` kg. */
const nm = (sk, s, k, mass) => { const d = sub(s.P[sk.index[`${SIDES[k]}Hand`]], s.P[sk.index[`${SIDES[k]}Arm`]]); return mass * G * Math.hypot(d[0], d[2]); };

/** fn({ id, o, k, mass, f, Nm }) for each carry on each frame of out its hand holds it (grasp physics on). */
function eachHeld(sk, out, fn) {
	const { spec, scene } = out.ctx, f0 = out.f0 ?? 0;
	if (!graspOn(spec)) return;
	const list = carries(spec).map(([id, o, k]) => ({ id, o, k, mass: massOf(spec, scene, id) }));
	if (!list.length) return;
	out.frames.forEach(({ s }, i) => {
		const f = i + f0;
		for (const c of list) if (handOf(out, c.id, f) === c.k) fn({ ...c, f, Nm: nm(sk, s, c.k, c.mass) });
	});
}

/** observeLoad(sk, out) -> { hand_l?, hand_r? } (each { object, mass, maxNm, at, frames: [first, last] }) or null. */
export function observeLoad(sk, out) {
	const res = {};
	eachHeld(sk, out, ({ id, k, mass, f, Nm }) => {
		const row = res[`hand_${k}`] ??= { object: id, mass: Math.round(mass * 1000) / 1000, maxNm: 0, at: f, frames: [f, f] };
		if (Nm > row.maxNm) { row.maxNm = Nm; row.at = f; }
		row.frames[1] = f;
	});
	for (const row of Object.values(res)) row.maxNm = Math.round(row.maxNm * 10) / 10;
	return Object.keys(res).length ? res : null;
}

/** True when the hand other than k is on carry id (an object anchor on it or a prop anchor on its prop) at f. */
function secondOn(out, id, o, k, f) {
	const j = k === "r" ? "l" : "r", { spec, scene } = out.ctx, parts = new Set([id, ...partsOf(scene, id)]);
	return Object.entries(spec.anchors ?? {}).some(([name, a]) => (out.baked?.[`w_${name}_${j}`]?.[f] ?? 0) > SECOND
		&& ((a.kind === "object" && parts.has(a.object)) || (a.kind === "prop" && a.prop === o.prop)));
}

/** QA LOAD issues: a hand carrying past ONE_HAND N m with no second hand on the object. */
export function loadChecks(sk, out) {
	const issues = [];
	eachHeld(sk, out, ({ id, o, k, f, Nm }) => {
		if (Nm > ONE_HAND && !secondOn(out, id, o, k, f)) issues.push({ kind: "LOAD", msg: `${SIDES[k].toLowerCase()} holds ${id} at ${Nm.toFixed(0)} N m`, frame: f, value: Math.round(Nm * 10) / 10, limit: ONE_HAND });
	});
	return issues;
}

/**
 * The anchor points (object local) for the left hand on carry id at frame f, nearest the left shoulder first: the
 * centres of the faces other than the bottom and the one the right palm is on (the box's other side, as two hands hold
 * it), each STANDOFF out of its face. Which face is cheapest the distance does not tell (on the 12 kg box the top won
 * by 0.3 mm and sent the hand through the edge: QA 121, the +X face 42), so repair compiles them all (repair.js).
 */
function otherFaces(out, id, f) {
	const { sk, scene } = out.ctx, s = out.frames[f - (out.f0 ?? 0)]?.s, pose = objectPoseAt(out, id, f), rest = restOf(scene, id);
	const part = scene.objects[partsOf(scene, id)[0]] ?? scene.objects[id];
	if (!s || !pose || !part?.half) return [];
	const toLocal = p => apply(T(pose.R), sub(p, pose.pos)), c = apply(T(rest.R), sub(add(part.pos, apply(part.R, [0, part.half[1], 0])), rest.pos));
	const palm = toLocal(scale(add(s.P[sk.index.RightHand], s.P[sk.index.RightHandMiddle1]), 0.5)), shoulder = toLocal(s.P[sk.index.LeftArm]);
	const faces = [0, 1, 2].flatMap(i => [-1, 1].map(sg => { const p = c.slice(); p[i] += sg * part.half[i]; return { p, i, sg }; })).filter(x => !(x.i === 1 && x.sg < 0));
	const palmFace = faces.reduce((m, x) => (Math.abs(palm[x.i] - x.p[x.i]) < Math.abs(palm[m.i] - m.p[m.i]) ? x : m));
	const off = x => x.p.map((v, i) => Math.round((i === x.i ? v + x.sg * STANDOFF : v) * 1000) / 1000);
	return faces.filter(x => x !== palmFace).map(x => ({ x, d: len(sub(x.p, shoulder)) })).sort((a, b) => a.d - b.d).slice(0, FACES).map(({ x }) => off(x));
}

export const loadHints = {
	/** LOAD(X, g) -> { cause, hint, fix? }: the other hand on it; a patch when the right hand holds. */
	LOAD(X, g) {
		const [, side, id] = /^(left|right) holds (\S+) at/.exec(g.subject) ?? [], o = X.spec?.objects?.[id];
		if (!o || !X.out) return null;
		const k = side === "left" ? "l" : "r", other = k === "r" ? "left" : "right", [grab] = spanOf(X.out, o), kg = massOf(X.spec, X.out.ctx.scene, id);
		const plain = { cause: `objects.${id} (${kg.toFixed(1)} kg)`, hint: `${id} weighs ${kg.toFixed(1)} kg: ${g.worst.toFixed(0)} N m on the ${side} arm at f${g.worstFrame} (one hand holds ${ONE_HAND}); put the ${other} hand on it too (a reachGrip on an object anchor on ${id} from f${grab}), or carry it closer to the body` };
		if (k !== "r") return plain;
		const faces = otherFaces(X.out, id, Math.max(grab, Math.min(g.worstFrame, spanOf(X.out, o)[1])));
		if (!faces.length) return plain;
		const name = `${id}Other`;
		// a big face takes the flat palm against it (a power grip's thumb would go into the box)
		const ops = local => user => { const anchor = { kind: "object", object: id, local, grasp: "palm" };
			return [user.anchors ? { op: "add", path: `/anchors/${name}`, value: anchor } : { op: "add", path: "/anchors", value: { [name]: anchor } },
				{ op: "add", path: "/use/-", value: { skill: "reachGrip", f0: Math.max(0, grab - REACH), args: { anchor: name, side: "l", reach: Math.min(REACH, grab) || 1, hold: Math.max(1, spanOf(X.out, o)[1] - grab), release: 1, fingers: "relaxed" } } }]; };
		return { ...plain, fix: { ops: ops(faces[0]), candidates: faces.map(ops) } };
	},
};
