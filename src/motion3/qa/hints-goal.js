// Hints for GOAL groups (C8, C6). The hint moves whatever drives the goal's moving side at the
// worst frame by the shortfall (+3 mm): a hand (a hand joint, a prop point, an object in hand),
// else a foot or the root, through moveHint (hints-contact.js, read only). The fix is
// { channel: "hand_l", f, delta } when the hand target drives that hand (qa/patch.js turns it into
// a patch), { path: "/anchors/<a>/p", delta } when a world anchor does, and none for an FK arm.
// still moves the point back toward where it should stay; speed and a goal that waits on another
// (after/before) get a hint without a fix. Two causes come first, because moving the hand target
// cannot cure them:
//   - another anchor weight of that hand is above 0 at the frame (it ramps between two keys
//     across the goal), so the hand goes part of the way to that anchor: key it 0 there;
//   - the arm is at full reach (the wrist target is clamped or missed): move the body (bodyMove).
import { resolveBone } from "../bones.js";
import { inHandAt } from "../object-pose.js";
import { refPoint } from "../refs.js";
import { scale, norm, sub, len } from "../compiler/math.js";
import { moveHint } from "./hints-contact.js";
import { goalKinds, goalName, goalNeed, goalWindow, movedHome, movedRef, nearRefs } from "./goals.js";
import { m3, vec } from "./fmt.js";

const MARGIN = 0.003, LEAK = 0.02, BODY_MAX = 0.2;

/**
 * The body move that brings shoulder k `need` m nearer its hand at f (the arm points at its
 * target when at full reach): { delta, hint, fix } with fix { channel: "root", f, delta, hold:
 * true } (qa/patch.js moves what places the body: a standIdle at, a walkTo's steps or the agent's
 * root keys). null when the arm points mostly up or down, where walking closer does not help.
 */
export function bodyMove(X, k, f, need, why = "") {
	const S = k === "l" ? "Left" : "Right", { s } = X.fr(f), v = sub(s.P[X.I[`${S}Hand`]], s.P[X.I[`${S}Arm`]]);
	const flat = Math.hypot(v[0], v[2]) / Math.max(len(v), 1e-9);
	if (flat < 0.5) return null;
	const delta = scale(norm([v[0], 0, v[2]]), Math.min(BODY_MAX, need / flat));
	return { delta, hint: `body: move ${vec(delta)} m toward the target at f${f}, ${X.cause("root", f)} (arm ${k} is at full reach)${why}`, fix: { channel: "root", f, delta, hold: true } };
}

/** Arm k cannot reach its wrist target at f (soft reach clamped it, or the IK missed; not a target inside the elbow's fold, arm_fold). */
export const atReach = (X, k, f) => (X.fr(f).diag[`reach_over_${k}`] ?? 0) > 1e-3 || ((X.fr(f).diag[`arm_miss_${k}`] ?? 0) > 2e-3 && !X.fr(f).diag[`arm_fold_${k}`]);

/** The largest other anchor weight of hand k above LEAK at f while `drive` leads it, or null. */
function leakOf(X, k, f, drive) {
	let best = null;
	for (const [ch, w] of Object.entries(X.fr(f).c)) {
		if (ch === drive || !new RegExp(`^w_.+_${k}$`).test(ch) || !(w > LEAK) || (best && w <= best.w)) continue;
		best = { ch, w };
	}
	return best;
}

/** Leak hint: key the stray weight 0 at the goal's last frame when it rises from 0 there, else at f. */
function leakHint(X, goal, part, f, why) {
	const k = part.slice(-1), d = X.hand(k, f), leak = d.anchor ? leakOf(X, k, f, d.ch) : null;
	if (!leak) return null;
	const end = Array.isArray(goal.at) ? goal.at[1] : goal.at, prev = X.bracket(leak.ch, f).prev;
	const at = prev && Math.abs(X.out.baked[leak.ch]?.[Math.round(prev.f)] ?? 1) <= LEAK && end >= f && !(X.bracket(leak.ch, f).next?.f <= end) ? end : f;
	const share = leak.w / Math.max(1, (X.fr(f).c[d.ch] ?? 1) + leak.w), other = leak.ch.replace(/^w_/, "").replace(/_[lr]$/, "");
	return { cause: X.cause(leak.ch, f), hint: `${leak.ch} is ${m3(leak.w)} at f${f}, so anchor ${other} takes ${Math.round(share * 100)}% of the hand target from ${d.label}: key ${leak.ch} 0 at f${at}${why}`,
		fix: { channel: leak.ch, f: at, value: 0 } };
}

/** The goal a GOAL group reports: the longest name its subject starts with. */
function goalOf(X, g) {
	let best = null;
	(X.spec?.goals ?? []).forEach((goal, i) => {
		const name = goalName(goal, i);
		if (g.subject.startsWith(`${name}:`) && (!best || name.length > best.name.length)) best = { goal, name, i };
	});
	return best;
}

/** The record that carries object `id` at frame f (the id itself or a group above it), or null. */
function carrierOf(X, id, f) {
	const ids = [id, ...(X.out.ctx.scene?.objects?.[id]?.ancestors ?? [])];
	const key = ids.find(k => inHandAt(X.spec.objects?.[k], f));
	return key ? X.spec.objects[key] : null;
}

/** The body part (moveHint name) that moves ref at frame f: hand_<k>, foot_<k>, root, or null for a still point. */
function partOf(X, ref, f) {
	const [, kind, rest] = /^([a-z]+):(.+)$/s.exec(ref) ?? [];
	if (kind === "prop") return X.spec.props?.[rest.split(".")[0]]?.hand ? `hand_${X.spec.props[rest.split(".")[0]].hand}` : null;
	if (kind === "object") {
		const o = carrierOf(X, rest.replace(/\.(center|top|base|rim)$/, ""), f), k = o && X.spec.props?.[o.prop]?.hand;
		return k ? `hand_${k}` : null;
	}
	if (kind === "landmark") return "root";
	if (kind !== "joint" && kind !== "bone") return null;
	const bone = resolveBone(X.sk, rest).bone ?? "", side = /^Left/.test(bone) ? "l" : /^Right/.test(bone) ? "r" : null;
	if (side && /^(Left|Right)(Hand|ForeArm)/.test(bone)) return `hand_${side}`;
	if (side && /^(Left|Right)(Foot|Toe|Leg)/.test(bone)) return `foot_${side}`;
	return "root";
}

/** fix for moving `part` by delta at f, when it applies to a channel or a world anchor. */
function fixFor(X, part, f, delta) {
	const k = part.slice(-1);
	if (!part.startsWith("hand_")) return { channel: part, f, delta };
	const d = X.hand(k, f);
	if (d.ch === `hand_${k}`) return { channel: d.ch, f, delta };
	if (d.anchor && X.spec.anchors?.[d.anchor]?.kind === "world") return { path: `/anchors/${d.anchor}/p`, delta };
	return null;
}

/** The side to move and its delta: [part, delta], hands first, then a body part, a to b (still: back toward its home, from `from`). */
function plan(X, goal, kind, f, amount, from) {
	if (kind === "moved" || kind === "still") {
		const ref = goal[kind], part = partOf(X, ref, f), home = movedHome(X.out, goal, from), p = refPoint(X.out, f, movedRef(ref));
		const away = p && home && len(sub(p, home)) > 1e-3 ? norm(sub(p, home)) : [0, 1, 0];
		return part ? [part, scale(away, kind === "still" ? -amount : amount)] : null;
	}
	// a near goal measures what goals.js nearRefs reads (a cup's rim at the mouth)
	const [a, b] = kind === "near" ? nearRefs(X.out.ctx.scene, goal) : goal[kind], pa = partOf(X, a, f), pb = partOf(X, b, f);
	const rank = p => (p?.startsWith("hand_") ? 2 : p ? 1 : 0), moveA = rank(pa) >= rank(pb);
	const part = moveA ? pa : pb, sign = moveA ? 1 : -1;
	if (!part) return null;
	if (kind === "above") return [part, [0, sign * amount, 0]];
	const qa = refPoint(X.out, f, a), qb = refPoint(X.out, f, b);
	return qa && qb ? [part, scale(norm(sub(qb, qa)), sign * amount)] : null;
}

export const goalHints = {
	/** GOAL(X, g) -> { cause, hint, fix? } | null */
	GOAL(X, g) {
		const found = X.spec && goalOf(X, g), f = g.worstFrame;
		if (!found) return { cause: `goal ${g.subject.split(":")[0]}`, hint: `change the keys around f${f} until the goal holds` };
		const { goal, name, i } = found, kind = goalKinds(goal)[0], amount = g.worst + MARGIN, w = goalWindow(X.out, X.spec.goals, i);
		if (w.wait) {
			const other = goal.after ?? goal.before;
			return { cause: `goal ${name}`, hint: `${name} ${w.wait}: make goal "${other}" hold${goal.after !== undefined && goal.before !== undefined ? ` and "${goal.before}"` : ""} where this one needs it, or move at` };
		}
		const unit = kind === "speed" ? "m/s" : "m", at = kind === "near" || kind === "still" ? "<=" : ">=";
		const why = ` (goal "${name}" is ${m3(g.worst)} ${unit} ${kind === "still" ? "off" : "short"}; needs ${at} ${goalNeed(goal, kind)})`;
		if (kind === "speed") {
			const part = partOf(X, goal.speed, f);
			return { cause: part ? X.cause(part, f) : `goal ${name}`,
				hint: `${goal.speed} is too slow at f${f}: put its keys around f${f} closer in time, or farther apart in space${why}` };
		}
		const move = plan(X, goal, kind, f, amount, w.a);
		if (!move) {
			if (kind === "still" && goal.still.startsWith("object:")) {
				const id = goal.still.slice(7).replace(/\.(center|top|base|rim)$/, "");
				return { cause: `objects.${id}`, hint: `${id} moves at f${f}, where it should stay: hold its hinge channel or keys until then, or start them later${why}` };
			}
			if (kind === "still") return { cause: `goal ${name}`, hint: `${goal.still} moves at f${f} and nothing that follows the body moves it; name a joint, prop point or held object${why}` };
			if (kind === "moved" && !goal.moved.startsWith("object:")) return { cause: `goal ${name}`, hint: `${goal.moved} does not move with the body at f${f}; name a joint, prop point or held object` };
			if (kind === "moved") {
				const id = goal.moved.slice(7).replace(/\.(center|top|base|rim)$/, "");
				return { cause: `objects.${id}`, hint: `${id} is not in a hand at f${f}, so nothing moves it: carry it (objects.${id} = { prop, grab }) or hinge it` };
			}
			return { cause: `goal ${name}`, hint: `neither ${goal[kind][0]} nor ${goal[kind][1]} moves with the body at f${f}; name a joint, prop point or held object` };
		}
		const [part, delta] = move;
		if (part.startsWith("hand_")) {
			const leak = leakHint(X, goal, part, f, why);
			if (leak) return leak;
			const body = atReach(X, part.slice(-1), f) && bodyMove(X, part.slice(-1), f, amount, why);
			if (body) return { cause: X.cause("root", f), hint: body.hint, fix: body.fix };
		}
		const r = moveHint(X, part, f, delta, why), fix = fixFor(X, part, f, delta);
		return { cause: r.cause, hint: r.hint, ...(fix ? { fix } : {}) };
	},
};
