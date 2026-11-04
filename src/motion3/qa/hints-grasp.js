// Hints for the grasp kinds (#816, qa/grasp-checks.js, skills/catch.js): { cause, hint, fix? } as the other hints-*.js.
//   FINGER_GAP  fix.grasp false: the fingers stopped at the preset; fix /fix/grasp true. Else the hand toward the object
//   FINGER_PEN  fix.grasp false: the same fix. Else the hand out of it along its surface normal at the phalanx
//   THUMB_OFF   the fingers channel: a grip preset held on while the hand holds it (or the object nearer the palm)
//   SUPPORT     the carry names the grasp its shape takes (sphere: spherical, cylinder: power, else palm); with
//               fix.grasp false, grasp back on first
//   CATCH       catchObject's f0 earlier by the frames the hand came late (the ball passed the catch point that much
//               before the grab)
// LOAD's hint is load.js's (the second hand).
import { moveHint } from "./hints-contact.js";
import { add, scale, sub, len } from "../compiler/math.js";
import { shapeOf, normalAt, signedDistance } from "../shapes.js";
import { partsOf, restingAt } from "../object-pose.js";
import { atReach, bodyMove } from "./hints-goal.js";

const MARGIN = 0.005;
const graspOff = X => X.spec?.fix?.grasp === false;
const turnOn = { cause: "spec.fix.grasp false: the fingers stopped at the preset curl", hint: "turn grasp physics on (fix.grasp true): the fingers close until they touch and the thing rests in the hand", fix: { path: "/fix/grasp", value: true } };

/** The held object's part entries at frame f, as drawn. */
function heldAt(X, id, f) {
	const { scene } = X.out.ctx, at = X.out.objectsAt?.(X.rel(f)) ?? {};
	return partsOf(scene, id).map(p => ({ ...scene.objects[p], ...(X.out.ctx.objectPose?.(p, f) ?? at[p] ?? {}) }));
}

/**
 * Box QA 2026-11-04 (a cup in the middle of a table): the arm was at full reach on the reach to the grab, so the hand
 * stopped at the cup's rim and the fingers closed on air; the grip hints (nearer the palm, another point on the cup)
 * sent the agent through six compiles. When hand k is at full reach on the frames before the grab of carry `id`, the
 * fix is the body (bodyMove, `need` m nearer), else the object nearer the body: null when the arm reached.
 */
function outOfReach(X, k, id, need) {
	const grab = X.spec?.objects?.[id]?.grab;
	if (!Number.isInteger(grab) || !X.fr) return null;
	const f = [grab, grab - 1, grab - 2].find(g => g >= 0 && atReach(X, k, g));
	if (f === undefined) return null;
	const why = ` (${id} is out of reach: the hand stops at its rim and the fingers cannot close round it; or move ${id} nearer the body first)`;
	const body = bodyMove(X, k, f, Math.max(need, 0.03), why), cause = `${id} out of reach at f${f}`;
	return body ? { cause, ...body } : { cause, hint: `${id}: arm ${k} is at full reach at f${f}; move ${id} nearer the body, or the body nearer it` };
}

export const graspHints = {
	FINGER_GAP(X, g) {
		if (graspOff(X)) return turnOn;
		const [, side, id] = /^(left|right) fingers off (\S+)$/.exec(g.subject) ?? [];
		if (!id || !X.out) return null;
		const k = side === "left" ? "l" : "r", S = side === "left" ? "Left" : "Right", f = g.worstFrame, { s } = X.fr(f);
		const palm = scale(add(s.P[X.I[`${S}Hand`]], s.P[X.I[`${S}HandMiddle1`]]), 0.5), parts = heldAt(X, id, f);
		if (!parts.length) return null;
		const near = parts.reduce((m, e) => (signedDistance(e, palm) < signedDistance(m, palm) ? e : m)), gap = signedDistance(near, palm);
		const short = outOfReach(X, k, id, Math.max(0, gap - 0.03));
		if (short) return short;
		return moveHint(X, `hand_${k}`, f, scale(normalAt(near, palm), -Math.max(0, gap - 0.03)), ` (onto ${id}: the fingers reach it from nearer)`);
	},
	FINGER_PEN(X, g) {
		if (graspOff(X)) return turnOn;
		const [, bone, id] = /^(\S+) into (\S+)$/.exec(g.subject) ?? [];
		if (!id || !X.out || X.I[bone] === undefined) return null;
		const k = bone.startsWith("Left") ? "l" : "r", f = g.worstFrame, p = X.fr(f).s.P[X.I[bone]], parts = heldAt(X, id, f);
		if (!parts.length) return null;
		const into = parts.reduce((m, e) => (signedDistance(e, p) < signedDistance(m, p) ? e : m));
		return moveHint(X, `hand_${k}`, f, scale(normalAt(into, p), g.worst - g.limit + MARGIN), ` (out of ${id})`);
	},
	THUMB_OFF(X, g) {
		if (graspOff(X)) return turnOn;
		const [, side, id] = /^(left|right) thumb off (\S+)$/.exec(g.subject) ?? [];
		if (!id) return null;
		const k = side === "left" ? "l" : "r";
		return { cause: X.cause(`fingers_${k}`, g.worstFrame), hint: `${id}: the thumb is ${(g.worst * 100).toFixed(1)} cm off it; key fingers_${k} with the grip (or spherical) preset at 1 while the hand holds it, or set the hand so ${id} sits in the palm` };
	},
	SUPPORT(X, g) {
		if (graspOff(X)) return turnOn;
		const id = /^(\S+) not supported$/.exec(g.subject)?.[1], o = X.spec?.objects?.[id];
		if (!o || !X.out) return null;
		const part = X.out.ctx.scene.objects[partsOf(X.out.ctx.scene, id)[0]], kind = part ? shapeOf(part).kind : "box";
		const grasp = kind === "sphere" ? "spherical" : kind === "cylinder" ? "power" : "palm";
		const k = X.spec?.props?.[o.prop]?.hand, short = k && outOfReach(X, k, id, 0.03);
		if (short) return short;
		if (o.grasp === grasp) return { cause: `objects.${id}.grasp ${grasp}`, hint: `${id} rests on the fingers only: hold it nearer the palm (the hand lower under it) or with both hands` };
		return { cause: `objects.${id} (no grasp for a ${kind})`, hint: `${id}: set objects.${id}.grasp to "${grasp}" (how a ${kind} is held)`, fix: { path: `/objects/${id}/grasp`, value: grasp } };
	},
	CATCH(X, g) {
		const [, id] = /^(\S+) missed by/.exec(g.subject) ?? [], o = X.spec?.objects?.[id];
		if (!o || !X.out) return null;
		const grab = g.worstFrame, target = X.spec.anchors?.[`${id}Catch0`]?.p;
		if (!target) return { cause: `objects.${id}.grab`, hint: `${id}: the hand is ${(g.worst * 100).toFixed(1)} cm from it at f${grab}; reach it earlier` };
		// the frame the flight was at the catch point: the hand came that many frames after it
		let best = null;
		for (let f = Math.max(0, grab - 30); f < grab; f++) {
			const at = restingAt(X.out, id, f)?.pos;
			if (at && (!best || len(sub(at, target)) < best.d)) best = { f, d: len(sub(at, target)) };
		}
		const lead = best ? grab - best.f : 0, hint = `${id}: the hand gets there ${lead} frame(s) after it passed (${(g.worst * 100).toFixed(1)} cm off at f${grab}); start catchObject ${lead} frame(s) earlier`;
		if (!(lead > 0)) return { cause: `use catchObject ${id}`, hint };
		return { cause: `use catchObject ${id} f0`, hint, fix: { ops: user => {
			const i = (user.use ?? []).findIndex(u => u.skill === "catchObject" && u.args?.object === id);
			return i < 0 ? null : [{ op: "replace", path: `/use/${i}/f0`, value: Math.max(0, user.use[i].f0 - lead) }];
		} } };
	},
};
