// Hints for motion-type issues (reach, knees and elbows past their stop, pole flips, sliding, pops,
// floating, opted-in speed and acceleration) and for the spec's own checks (contacts, orient,
// below, appear). Orient and below try small changes of the wrist or elbow channels on the worst
// frame and scale the best one to the needed amount.
import { add, sub, scale, norm, len, dist, angle, apply, ry, clamp, dot } from "../compiler/math.js";
import { solveFrame } from "../compiler/compile.js";
import { channelsAt } from "../compiler/channels.js";
import { resolveAnchor } from "../compiler/anchors.js";
import { carried, reachAt, ELBOW_FOLD, ELBOW_STOP, KNEE_FOLD } from "../compiler/limbs.js";
import { pointOf } from "./spec-checks.js";
import { solePoints, ankleY } from "./geometry.js";
import { vec, m3 } from "./fmt.js";
import { moveHint } from "./hints-contact.js";
import { kneeFoldHint, kneeWhy } from "./hints-knee.js";
import { bodyMove } from "./hints-goal.js";
import { ballisticArc, arcFrames, arcPrescription } from "./ballistic.js";

const LIMB = { Leg: ["UpLeg", "Leg", "Foot", "knee"], ForeArm: ["Arm", "ForeArm", "Hand", "elbow"] };
const sideOf = s => (s.startsWith("Left") ? "l" : "r");
const weightOf = ch => (/^(w_|armw)/.test(ch) ? 0.5 : /^(root|foot|hand)/.test(ch) ? 1 : /^(knee|elbow)/.test(ch) ? 0.2 : 0.01);

/** Channels that move joint j, ranked by how much each changed into frame f (metres-equivalent). */
function movers(X, j, f) {
	const k = sideOf(j), b = X.out.baked;
	let list = ["root", "yaw", "pitch"];
	if (j === "Head") list = ["head_yaw", "head_pitch", "spine_pitch", "spine_yaw", "root", "yaw"];
	else if (/Hand|ForeArm/.test(j)) list = [`hand_${k}`, `armw_${k}`, `elbow_${k}`, `aswing_${k}`, `abend_${k}`, ...Object.keys(b).filter(ch => new RegExp(`^w_.+_${k}$`).test(ch)), "spine_yaw", "spine_pitch", "root", "yaw"];
	else if (/Foot|Leg/.test(j)) list = [`foot_${k}`, `knee_${k}`, `fpitch_${k}`, "root"];
	const change = ch => {
		const a = b[ch]?.[f - 1], c = b[ch]?.[f];
		if (a === undefined || c === undefined || typeof a === "object" && !Array.isArray(a)) return 0;
		return (Array.isArray(a) ? dist(a, c) : Math.abs(c - a)) * weightOf(ch);
	};
	return list.filter(ch => b[ch]).sort((p, q) => change(q) - change(p));
}

function speedHint(X, g, power) {
	const j = g.subject.split(" ")[0], f = g.worstFrame, ch = movers(X, j, f)[0] ?? "root";
	const { prev, next } = X.bracket(ch, f), stepped = X.keys(ch).find(k => k.step && Math.abs(k.f - f) <= 1);
	if (stepped) return { cause: X.cause(ch, f), hint: `${ch}: a step key jumps at f${Math.round(stepped.f)}; ease it over 4+ frames (key the old value 4 frames earlier, drop the step)` };
	const factor = Math.ceil(Math.pow(g.worst / g.limit, power) * 1.1 * 10) / 10;
	const a = Math.round(prev?.f ?? f - 4), b = Math.round(next?.f ?? f + 4), extra = Math.ceil((b - a) * (factor - 1));
	const anchor = /^w_(.+)_[lr]$/.exec(ch);
	return { cause: X.cause(ch, f), hint: `retime: stretch f${a}-f${b} by ${factor}x (+${extra} frames, move the keys from f${b} on later)${anchor ? ` - the hand switches to anchor ${anchor[1]} too fast` : ""}`,
		fix: X.spec.fix === false ? undefined : { path: "/fix/retime", value: true } };
}

/** A check point (joint:/prop:/anchor:) on a freshly solved frame. */
function pointOn(X, fr, ref) {
	const [kind, rest] = ref.split(/:(.*)/s);
	if (kind === "joint") return fr.s.P[X.I[rest]];
	if (kind === "prop") { const [p, pt] = rest.split("."); return fr.diag.props?.[p]?.[pt]; }
	return resolveAnchor(X.out.ctx, rest, fr.s, fr.diag, fr.c);
}

/** Try channel changes on frame f; returns the best { ch, value, gain } for measure() (higher is better). */
function probe(X, f, tries, measure) {
	const c0 = channelsAt(X.out.baked, f), base = measure(X.fr(f));
	let best = null;
	for (const [ch, value, unit] of tries) {
		const gain = measure(solveFrame(X.out.ctx, { ...c0, [ch]: value }, f)) - base;
		if (gain > 1e-6 && (!best || gain / unit > best.gain / best.unit)) best = { ch, value, gain, unit };
	}
	return { best, base, c0 };
}

/** The ballistic arc of a FLOAT group's run (its subject names f<a>-f<b>): the worst frame, the correction at any frame, the keys that follow it; { presc } past MAX_FIX; null without anchors. */
function floatArc(X, g) {
	const f0 = X.out.f0 ?? 0, [, a = g.first, b = g.last] = / f(\d+)-f(\d+)/.exec(g.subject)?.map(Number) ?? [];
	const y = X.out.frames.map(fr => fr.s.P[X.I.Hips][1]), G = 9.81 / (X.out.fps ?? 24) ** 2, arc = ballisticArc(y, a - f0, b - f0, G);
	if (!arc) { const p = arcPrescription(y, a - f0, b - f0, G); return p && { presc: { ...p, from: a - 1, to: b + 1 } }; }
	const dyAt = f => Math.round((arc.delta[f - f0 - arc.from - 1] ?? 0) * 1e4) / 1e4, at = q => ({ f: q + f0, dy: dyAt(q + f0) });
	return { ...at(arc.worst), from: arc.from + f0, to: arc.to + f0, dyAt, keys: arcFrames(arc).map(at) };
}

/** Root keys moved up or down by the arc: the agent's root key within 2 frames moves by the arc at its own frame, else a key is added; the anchors get their own height unless a root key sits within 2 frames. */
function arcOps(X, userSpec, arc) {
	const ops = Array.isArray(userSpec.keys) ? [] : [{ op: "add", path: "/keys", value: [] }], used = new Set(), r4 = v => Math.round(v * 1e4) / 1e4;
	for (const { f, dy } of arc.keys) {
		const i = (userSpec.keys ?? []).findIndex(k => Array.isArray(k?.set?.root) && k.set.root.length === 3 && Math.abs(k.f - f) <= 2 && k.f > arc.from && k.f < arc.to);
		if (i >= 0 && used.has(i)) continue;
		const r = i >= 0 ? userSpec.keys[i].set.root : X.fr(f).c.root, d = i >= 0 ? arc.dyAt(userSpec.keys[i].f) : dy;
		if (!Array.isArray(r)) continue;
		if (i >= 0) used.add(i);
		const value = [r4(r[0]), r4(r[1] + d), r4(r[2])];
		ops.push(i >= 0 ? { op: "replace", path: `/keys/${i}/set/root`, value } : { op: "add", path: "/keys/-", value: { f, set: { root: value } } });
	}
	// the anchors keep their height: without a root key near takeoff and landing the channel would ease into the arc early and hold its last key after
	const near = f => (userSpec.keys ?? []).some(k => Array.isArray(k?.set?.root) && Math.abs(k.f - f) <= 2);
	for (const f of [arc.from, arc.to]) if (!near(f) && Array.isArray(X.fr(f).c.root)) ops.push({ op: "add", path: "/keys/-", value: { f, set: { root: X.fr(f).c.root.map(r4) } } });
	return ops;
}

const hipOrShoulder = (X, k, f, limb) => X.fr(f).s.P[X.I[`${k === "l" ? "Left" : "Right"}${LIMB[limb][0]}`]];

export const motionHints = {
	REACH(X, g) {
		const [, limb, k] = /^(leg|arm)_miss_([lr])$/.exec(g.subject) ?? [], f = g.worstFrame, need = g.worst + 0.002;
		if (limb === "leg") {
			// an ankle target nearer the hip than the knee folds (compiler/limbs.js): the hips up off it
			const fold = X.fr(f).diag[`leg_fold_${k}`];
			if (fold) return kneeFoldHint(X, k, f, kneeWhy(`the ankle target is ${m3(g.worst)} m inside the shin's reach: `, fold), X.fr(f).c[`foot_${k}`]);
			const T = X.fr(f).c[`foot_${k}`] ?? [0, 0, 0], H = hipOrShoulder(X, k, f, "Leg"), v = sub(T, H), R = dist(H, T) - g.worst;
			const disc = v[1] * v[1] - dot(v, v) + R * R, side = [v[0], 0, v[2]];
			const alt = disc >= 0 ? `or root down ${m3(-v[1] - Math.sqrt(disc) + 0.002)} m${g.worst <= 0.05 ? " (fix.reach does this when on)" : ""}`
				: `or root ${vec(scale(norm(side), len(side) - R * 0.95))} m toward the foot (the foot is ${m3(len(side))} m sideways of the hip: the root and foot keys disagree)`;
			return { cause: X.cause(`foot_${k}`, f), hint: `foot_${k}: move ${vec(scale(norm(sub(H, T)), need))} m toward the hip at f${f}, ${alt}`, fix: { channel: `foot_${k}`, f, delta: scale(norm(sub(H, T)), need) } };
		}
		const S = k === "l" ? "Left" : "Right", { s, diag } = X.fr(f), dir = norm(sub(s.P[X.I[`${S}Hand`]], s.P[X.I[`${S}Arm`]]));
		// a target nearer the shoulder than the elbow folds (compiler/limbs.js): out from the shoulder, or the body back from it
		const fold = diag[`arm_fold_${k}`];
		if (fold) {
			const r = moveHint(X, `hand_${k}`, f, scale(dir, need), ` (the hand target is ${m3(g.worst)} m inside the forearm's reach: the elbow would fold ${Math.round(fold)}deg; it bends to ${ELBOW_FOLD}deg and stops at ${ELBOW_STOP}deg)`);
			return { cause: r.cause, hint: `${r.hint}, or bring root ${vec(scale([-dir[0], 0, -dir[2]], need))} m back from it`, fix: r.fix };
		}
		const r = moveHint(X, `hand_${k}`, f, scale(dir, -need), "");
		// a hand on a point the scene or the spec pins (an object anchor, one a goal or contact check names) stays: the body comes closer
		const a = X.hand(k, f).anchor, refs = JSON.stringify([X.spec.goals ?? [], X.spec.checks?.contacts ?? []]);
		const pinned = a && (X.spec.anchors?.[a]?.kind === "object" || refs.includes(`"anchor:${a}"`)), fit = X.spec.fits?.[X.hand(k, f).fit ?? -1];
		// a fit pushes the wrist target far past reach; the body comes as far as the effector is short
		const eff = fit?.effector?.prop && X.fr(f).diag.props?.[fit.effector.prop]?.[fit.effector.point];
		const gap = eff ? dist(eff, add(pointOn(X, X.fr(f), `anchor:${a}`), fit.offset ?? [0, 0, 0])) + 0.01 : need;
		const body = pinned && bodyMove(X, k, f, Math.min(need, gap));
		if (body) return { cause: r.cause, hint: `${body.hint} (out of reach by ${m3(g.worst)} m), or ${r.hint}`, fix: body.fix };
		return { cause: r.cause, hint: `${r.hint} (out of reach by ${m3(g.worst)} m), or bring root ${vec(scale([dir[0], 0, dir[2]], need))} m closer`, fix: r.fix };
	},
	KNEE(X, g) {
		const k = sideOf(g.subject), S = k === "l" ? "Left" : "Right", f = g.worstFrame, { s, c } = X.fr(f), P = s.P, I = X.I;
		if (/backward/.test(g.subject)) {
			const toe = sub(P[I[`${S}ToeBase`]], P[I[`${S}Foot`]]); toe[1] = 0;
			const pole = add(norm(apply(ry(-(c.yaw ?? 0)), toe)), [0, 0.3, 0]);
			return { cause: X.cause(`knee_${k}`, f), hint: `knee_${k}: key ${vec(norm(pole))} (body frame, along the foot) at f${f}; a knee pole is +z forward, +x the character's left`, fix: { channel: `knee_${k}`, f, value: norm(pole) } };
		}
		// past the stop (the solver stops every knee at KNEE_STOP, so this pose came from outside it): the hips up off the foot
		if (/ folds /.test(g.subject)) return kneeFoldHint(X, k, f, ` (the knee folds ${m3(g.worst)}deg, past its ${g.limit}deg stop; it bends freely to ${KNEE_FOLD}deg)`, P[I[`${S}Foot`]]);
		const H = P[I[`${S}UpLeg`]], K = P[I[`${S}Leg`]], A = P[I[`${S}Foot`]], a = dist(H, K), b = dist(K, A);
		const inner = (180 - (g.limit - 5)) * Math.PI / 180, want = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(inner));
		return { cause: X.cause(`foot_${k}`, f), hint: `foot_${k}: move ${vec(scale(norm(sub(A, H)), want - dist(H, A)))} m away from the hip at f${f} (the knee folds ${m3(g.worst)} deg, limit ${g.limit})`,
			fix: { channel: `foot_${k}`, f, delta: scale(norm(sub(A, H)), want - dist(H, A)) } };
	},
	// the solver stops every elbow at ELBOW_STOP, so a fold past it comes from outside the solver: the hand out from the shoulder
	ELBOW(X, g) {
		const k = sideOf(g.subject), S = k === "l" ? "Left" : "Right", f = g.worstFrame, P = X.fr(f).s.P, I = X.I;
		const A = P[I[`${S}Arm`]], E = P[I[`${S}ForeArm`]], W = P[I[`${S}Hand`]], delta = scale(norm(sub(W, A)), reachAt(dist(A, E), dist(E, W), ELBOW_FOLD) - dist(A, W));
		return moveHint(X, `hand_${k}`, f, delta, ` (the elbow folds ${m3(g.worst)}deg, past its ${g.limit}deg stop; it bends freely to ${ELBOW_FOLD}deg)`);
	},
	FLIP(X, g) {
		const [, S, limb] = /^(Left|Right)(Leg|ForeArm) /.exec(g.subject) ?? [], f = g.worstFrame;
		if (!limb) return null;
		const k = sideOf(S), [r, m, e, pole] = LIMB[limb], I = X.I, gap = +(/ over (\d+) frames$/.exec(g.subject)?.[1] ?? 1);
		// an elbow on its stop: the target passes near the shoulder and the stopped hand swings round it, whatever the pole
		const fd = X.fr(f).diag, asked = limb === "ForeArm" && (fd[`arm_fold_${k}`] ?? fd[`hold_${k}`]?.fold);
		if (asked) {
			const held = fd[`hold_${k}`]?.fold && Object.entries(X.spec.objects ?? {}).find(([, o]) => o.keys?.length && X.spec.props?.[o.prop]?.hand === k)?.[0];
			return { cause: held ? `objects.${held}.keys` : X.cause(X.hand(k, f).ch, f), hint: `the ${held ? `keys of ${held} ask` : "hand target asks"} the elbow to fold ${Math.round(asked)}deg at f${f}, past its ${ELBOW_STOP}deg stop, so the hand swings round the shoulder on the stop: move ${held ? "the keyed pose" : "the target"} out from the shoulder (REACH says how far)` };
		}
		const bendAt = q => { const P = X.fr(q).s.P; return angle(sub(P[I[`${S}${m}`]], P[I[`${S}${r}`]]), sub(P[I[`${S}${e}`]], P[I[`${S}${m}`]])); };
		// a flip over several frames passed through the straight (or folded) frames between: the straightest names it
		const fb = Array.from({ length: Math.max(1, gap - 1) }, (_, i) => (gap > 1 ? f - 1 - i : f)).reduce((p, q) => (bendAt(q) < bendAt(p) ? q : p)), bend = bendAt(fb);
		const ch = `${pole}_${k}`, prevPole = X.out.baked[ch]?.[Math.max(0, f - 1)];
		if (prevPole && len(prevPole) < 0.5) return { cause: X.cause(ch, f), hint: `${ch}: the pole passes near zero (length ${m3(len(prevPole))}) at f${f} while it turns between opposite keys; add an in-between pole key (e.g. the average direction, normalised) so it turns, not shrinks` };
		const straight = bend < 12 ? `the limb is almost straight at f${fb} (bend ${m3(bend)} deg), so the pole cannot hold it: bring the ${limb === "Leg" ? "foot" : "hand"} target ~0.02 m toward the ${limb === "Leg" ? "hip" : "shoulder"}, or ` : "";
		return { cause: X.cause(ch, f), hint: `${ch}: ${straight}keep the pole on one side through f${f}${prevPole ? ` (key ${vec(prevPole)} there)` : ""}`, fix: prevPole && { channel: ch, f, value: prevPole } };
	},
	SLIDE(X, g) {
		const k = sideOf(g.subject), S = k === "l" ? "Left" : "Right", key = g.subject.includes("heel") ? "heel" : "ball";
		const f0 = Math.max(0, g.first - 1), at = f => solePoints(X.sk, X.fr(f).s, S)[key];
		const slid = Math.hypot(at(g.last)[0] - at(f0)[0], at(g.last)[2] - at(f0)[2]), hold = X.out.baked[`foot_${k}`]?.[f0];
		// the ankle stays and the foot turns flat on the floor (fyaw): the turn is the slide
		const turn = X.out.baked[`fyaw_${k}`], end = X.out.baked[`foot_${k}`]?.[g.last];
		if (turn && hold && end && Math.hypot(end[0] - hold[0], end[2] - hold[2]) < slid / 2 && Math.abs(turn[g.last] - turn[f0]) > 1) return { cause: X.cause(`fyaw_${k}`, g.worstFrame),
			hint: `fyaw_${k}: the flat foot turns ${m3(turn[f0])} -> ${m3(turn[g.last])} deg over f${f0}-f${g.last} and the ${key} slides ${m3(slid)} m; key fyaw_${k} ${m3(turn[f0])} at f${g.last} so it turns once the foot is up, or lift the heel first (fpitch_${k} +) so it pivots on the ball`,
			fix: { channel: `fyaw_${k}`, f: g.last, value: turn[f0] } };
		return { cause: X.cause(`foot_${k}`, g.worstFrame), hint: `foot_${k}: hold it still over f${f0}-f${g.last}${hold ? ` (key ${vec(hold)} at both ends)` : ""}; the ${key} slides ${m3(slid)} m${slid < 0.01 ? "; fix.slide locks this when on" : ""}`,
			fix: hold && { channel: `foot_${k}`, f: g.last, value: hold } };
	},
	SPEED: (X, g) => speedHint(X, g, 1),
	POP: (X, g) => speedHint(X, g, 0.5),
	ACC: (X, g) => speedHint(X, g, 0.5),
	FLOAT(X, g) {
		const base = `over f${g.first}-f${g.last} lower the root or key foot_l/foot_r back onto the ground, the floor or the top of an object under the foot (the ankle stands ${ankleY(X.sk)} m above it); a jump needs the hips to rise and fall; a seat or ledge the hips rest on goes in checks.supports (a foot on an object's top needs none)`;
		const arc = floatArc(X, g);
		if (!arc) return { cause: X.cause("root", g.worstFrame), hint: base };
		const p = arc.presc, m2 = v => (Math.round(v * 100) / 100).toFixed(2), other = p && p.fits >= 2 && p.fits !== p.frames;
		if (p) return { cause: X.cause("root", g.worstFrame), hint: `hips held ${m2(Math.abs(p.off))} m ${p.off > 0 ? "below" : "above"} a ballistic arc over ${p.frames} frames (f${p.from}-f${p.to}): either ${p.apex > p.height ? "raise" : "lower"} the apex to ${m2(p.apex)} m above takeoff${other ? `, or ${p.fits < p.frames ? "shorten" : "lengthen"} the air run to ${p.fits} frames for this apex (${m2(p.height)} m)` : ""}; or ${base}` };
		const { f, dy } = arc;
		return { cause: X.cause("root", f), hint: `hips should be ${Math.round(Math.abs(dy) * 100)} cm ${dy < 0 ? "lower" : "higher"} at f${f} (ballistic arc from f${arc.from} to f${arc.to}): root ${vec([0, dy, 0])} m there${arc.keys.length > 1 ? ` (keys at ${arc.keys.map(k => `f${k.f} ${vec([0, k.dy, 0])}`).join(", ")} follow the arc)` : ""}; or ${base}`,
			fix: { channel: "root", f, delta: [0, dy, 0], ops: userSpec => arcOps(X, userSpec, arc) } };
	},
	LENGTH: () => ({ cause: "compiler", hint: "a bone changed length: report the spec, this is a compiler fault" }),
	CONTACT(X, g) {
		const ck = (X.spec.checks?.contacts ?? []).find(c => g.subject.startsWith(`${c.name}:`)), f = g.worstFrame, i = X.rel(f);
		if (!ck) return null;
		const a = pointOf(X.out, i, ck.point), b = pointOf(X.out, i, ck.target), delta = sub(b, a);
		const prop = /^prop:([^.]+)/.exec(ck.point), k = prop ? X.spec.props?.[prop[1]]?.hand : sideOf(ck.point.slice(6));
		const { diag } = X.fr(f), over = Math.max(diag[`reach_over_${k}`] ?? 0, diag[`arm_miss_${k}`] ?? 0);
		const anchor = /^anchor:(.+)$/.exec(ck.target)?.[1], fit = (X.spec.fits ?? []).findIndex(ft => ft.side === k && ft.anchor === anchor);
		const cause = fit >= 0 ? `fits[${fit}] (${k} -> anchor ${anchor})` : moveHint(X, `hand_${k}`, f, delta).cause;
		const toRoot = scale(norm([delta[0], 0, delta[2]]), over + 0.01), fold = diag[`arm_fold_${k}`];
		if (over > 0.002 && fold) {
			const S = X.fr(f).s.P[X.I[`${k === "l" ? "Left" : "Right"}Arm`]], back = scale(norm([S[0] - b[0], 0, S[2] - b[2]]), over + 0.01);
			return { cause, hint: `inside the forearm's reach by ${m3(over)} m at f${f} (the elbow would fold ${Math.round(fold)}deg; it stops at ${ELBOW_STOP}deg): bring root ${vec(back)} m back from ${anchor ?? "the target"}, or move the target out from the shoulder`, fix: { channel: "root", f, delta: back } };
		}
		if (over > 0.002) return { cause, hint: `out of reach by ${m3(over)} m at f${f}: bring root ${vec(toRoot)} m toward ${anchor ?? "the target"}, or move the target`, fix: { channel: "root", f, delta: toRoot } };
		const r = moveHint(X, `hand_${k}`, f, delta);
		return { cause, hint: `${r.hint}${fit < 0 && anchor ? `; or add fits: [{ side: "${k}", anchor: "${anchor}", effector: ${prop ? `{ prop: "${prop[1]}", point: "${ck.point.split(".")[1]}" }` : "{ joints: [...] }"} }]` : ""}`, fix: r.fix };
	},
	ORIENT(X, g) {
		const ck = (X.spec.checks?.orient ?? []).find(c => g.subject.startsWith(`${c.name}:`)), f = g.worstFrame;
		if (!ck) return null;
		const prop = /^prop:([^.]+)/.exec(ck.from), k = prop ? X.spec.props?.[prop[1]]?.hand : sideOf(ck.from.slice(6)), minCos = ck.minCos ?? 0.64;
		const along = fr => (ck.along === "up" ? [0, 1, 0] : ck.along === "face" ? carried(X.sk, fr.s, X.I.Head, [0, 0, 1]) : norm(ck.along));
		const cos = fr => dot(norm(sub(pointOn(X, fr, ck.to), pointOn(X, fr, ck.from))), along(fr));
		const c = channelsAt(X.out.baked, f), tw = c[`wtwist_${k}`] ?? 0, fx = c[`wflex_${k}`] ?? 0;
		const { best, base } = probe(X, f, [[`wtwist_${k}`, clamp(tw + 15, -85, 85), 15], [`wtwist_${k}`, clamp(tw - 15, -85, 85), 15], [`wflex_${k}`, clamp(fx + 15, -70, 70), 15], [`wflex_${k}`, clamp(fx - 15, -70, 70), 15]], cos);
		if (!best) return { cause: X.cause(`wtwist_${k}`, f), hint: `turn the prop another way: wrist twist/flex do not help at f${f} (cos ${m3(base)}, needs ${minCos}); change elbow_${k} or the prop points` };
		const from = best.ch.startsWith("wtwist") ? tw : fx, lim = best.ch.startsWith("wtwist") ? 85 : 70;
		const want = clamp(from + (best.value - from) * Math.min(4, (minCos - base + 0.03) / best.gain), -lim, lim);
		return { cause: X.cause(best.ch, f), hint: `${best.ch}: key ${m3(want)} deg at f${f} (now ${m3(from)}; cos ${m3(base)}, needs ${minCos})`, fix: { channel: best.ch, f, value: want } };
	},
	BELOW(X, g) {
		const ck = (X.spec.checks?.below ?? []).find(c => g.subject.startsWith(`${c.name}:`)), f = g.worstFrame;
		if (!ck) return null;
		const k = sideOf(ck.joint), ch = `${/Leg/.test(ck.joint) ? "knee" : "elbow"}_${k}`, pole = channelsAt(X.out.baked, f)[ch] ?? [0, -1, -0.3];
		const drop = fr => fr.s.P[X.I[ck.ref]][1] - fr.s.P[X.I[ck.joint]][1];
		// candidate poles (body frame), nearest to the current one first among those that are enough
		const need = (ck.min ?? 0.08) + 0.01, c0 = channelsAt(X.out.baked, f), base = drop(X.fr(f));
		const tries = [[0, -1, 0], [0.5, -1, 0], [-0.5, -1, 0], [0, -1, -0.4], [0, -1, 0.4], [0.5, -1, 0.5], [-0.5, -1, 0.5], [0.5, -1, -0.4], [-0.5, -1, -0.4]]
			.map(p => ({ p, d: drop(solveFrame(X.out.ctx, { ...c0, [ch]: p }, f)), turn: angle(p, pole) }));
		const ok = tries.filter(t => t.d >= need).sort((p, q) => p.turn - q.turn)[0], best = ok ?? tries.sort((p, q) => q.d - p.d)[0];
		if (!(best.d > base)) return { cause: X.cause(ch, f), hint: `${ch}: no pole change lowers ${ck.joint} at f${f}; lower the hand target instead` };
		return { cause: X.cause(ch, f), hint: `${ch}: key ${vec(best.p)} (body frame: +y up, +z forward) at f${f} (${ck.joint} ${m3(base)} m below ${ck.ref} -> ${m3(best.d)}, needs ${ck.min ?? 0.08})`, fix: { channel: ch, f, value: best.p } };
	},
	APPEAR(X, g) {
		const ck = (X.spec.checks?.appear ?? []).find(c => g.subject.startsWith(`${c.name}:`)), f = g.worstFrame;
		if (!ck) return null;
		let best = null;
		for (let q = Math.max(X.out.f0 ?? 0, f - 24); q <= Math.min((X.out.f0 ?? 0) + X.out.frames.length - 1, f + 24); q++) {
			const d = len(sub(pointOf(X.out, X.rel(q), `joint:${ck.joint}`), pointOf(X.out, X.rel(q), `anchor:${ck.anchor}`)));
			if (!best || d < best.d) best = { q, d };
		}
		const tol = ck.tol ?? 0.035;
		return { cause: X.cause(ck.channel, f), hint: best.d <= tol ? `${ck.channel}: move the step from f${f} to f${best.q} (${ck.joint} ${m3(best.d)} m from ${ck.anchor} there)`
			: `${ck.joint} never gets within ${tol} m of ${ck.anchor} near f${f} (closest ${m3(best.d)} m at f${best.q}): hold its weight w_${ck.anchor}_${sideOf(ck.joint)} at 1 around the switch` };
	},
};
