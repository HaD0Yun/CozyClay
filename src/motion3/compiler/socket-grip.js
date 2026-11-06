// The hand of a fit whose anchor takes a grasp (an object anchor with `grasp`, ../sockets.js) holds the object by its
// socket: the palm frame comes from the socket (the knuckle line along its axis, the palm against the side the hand
// comes from), not from the forearm's roll rule (grip.js). With no side given, the hand rolls about the axis to where
// the arm holds it most easily, and where the forearm cannot come across the axis the knuckle line tilts on it (an
// oblique grip, priced, up to TILT deg). The fingers' point stays where the fit put it; the elbow swivels to the pole
// that leaves the wrist least strained (arm-orient.js, as a held object's hand, hold.js), the forearm takes its share of
// the turn and the wrist the rest within its limits. Weighted by the fit's weight, so the hand turns into the grasp on
// the reach and out of it on the release.
// A hand that carries what it holds by a socket without keys keeps, after the grab, the wrist turn it had on the grab
// frame against the forearm (diag.socket_<k>.rel, measured on the plain forearm before the turn): the object rides the
// palm as it was taken (object-pose.js keeps the grab-frame offset), so neither the hand nor the object turns back. A
// keyed carry's hand follows the keys (hold.js), whose grab offset is taken on that same grasp (object-keys.js attach).
import { sub, norm, mul, T, axisRot, apply, cross, dot, scale, len } from "./math.js";
import { palmAxes, twoBone } from "./limbs.js";
import { aimArm, orient } from "./hold.js";
import { ELBOW_REST, WRIST_COMFORT, WRIST_LIMITS, swivel, wristNeed } from "./arm-orient.js";
import { anchorSocket } from "./anchors.js";
import { socketPalm } from "../sockets.js";
import { partsOf } from "../object-pose.js";

const ITER = 3, ROLLS = 12, TEMP = 0.05, PULL = 0.3, DEG = 180 / Math.PI, TILT = 40, SLANT = 1, STEADY = 0.3;
const TILTS = [-TILT, -TILT / 2, 0, TILT / 2, TILT];

/** The Boltzmann-weighted mean of [value, cost] pairs at a softer temperature (STEADY): it moves smoothly between them. */
function mean(all) {
	const low = Math.min(...all.map(x => x[1])), e = all.map(([a, c]) => [a, Math.exp(-(c - low) / STEADY)]);
	return e.reduce((m, [a, x]) => m + a * x, 0) / e.reduce((m, [, x]) => m + x, 0);
}

/** The Boltzmann-weighted circular mean of ROLLS angles under cost(th) (second-hand.js softmin). */
function softmin(cost) {
	const all = Array.from({ length: ROLLS }, (_, i) => { const th = (2 * Math.PI * i) / ROLLS - Math.PI; return [th, cost(th)]; }), low = Math.min(...all.map(x => x[1]));
	const m = all.reduce((acc, [th, v]) => { const e = Math.exp(-(v - low) / TEMP); return [acc[0] + e * Math.cos(th), acc[1] + e * Math.sin(th)]; }, [0, 0]);
	return Math.atan2(m[1], m[0]);
}
const cols = ({ d, l, n }) => [[d[0], l[0], n[0]], [d[1], l[1], n[1]], [d[2], l[2], n[2]]];

/** True when the anchor named `name` takes a grasp (an object anchor with `grasp`). */
export const graspAnchor = (spec, name) => spec.anchors?.[name]?.kind === "object" && !!spec.anchors[name].grasp;

/** True when the agent's own keys (spec.keys, not a skill's or a generator's) turn hand k's wrist (wtwist_<k>, wflex_<k>). */
export const ownWrist = (spec, k) => (spec.keys ?? []).some(key => (!key.src || key.src.startsWith("keys[")) && (key.set?.[`wtwist_${k}`] !== undefined || key.set?.[`wflex_${k}`] !== undefined));

/** True when a grasp fit of hand k is anchored on body or group `id` (on it, a part of it, or a group holding it). */
export function graspedBy(spec, scene, id, k) {
	const parts = new Set(partsOf(scene, id));
	return (spec.fits ?? []).some(fit => {
		if (fit.side !== k || !graspAnchor(spec, fit.anchor)) return false;
		const at = spec.anchors[fit.anchor].object;
		return at === id || parts.has(at) || partsOf(scene, at).some(p => parts.has(p));
	});
}

/** The carry hand k holds at frame f by a socket (graspedBy): { id, grab, keyed } for that spec.objects carry, else null. */
export function socketCarry(ctx, k, f) {
	const { spec, scene } = ctx;
	if (!ctx.objectHand || !(spec.fits ?? []).some(fit => fit.side === k && graspAnchor(spec, fit.anchor))) return null;
	for (const [id, o] of Object.entries(spec.objects ?? {})) if (o?.prop && ctx.objectHand(id, f) === k && graspedBy(spec, scene, id, k)) return { id, grab: ctx.carrySpan(o)[0], keyed: !!o.keys?.length };
	return null;
}

/**
 * socketHand(ctx, sk, s, side, k, c, diag, on, effector, implicit, f): turn the hand of fit `on` ({ fit, w }) into its
 * anchor's socket grasp (see above); effector(st) is the fit's effector point on a pose. `implicit` ({ w, type }) is
 * the world socket and grasp of a fit without one (grip.js: an upright thin body under a plain anchor); f the frame.
 */
export function socketHand(ctx, sk, s, side, k, c, diag, on, effector, implicit = null, f = undefined) {
	const I = sk.index, a = I[`${side}Arm`], fa = I[`${side}ForeArm`], h = I[`${side}Hand`], plain = s.R[fa];
	const w = implicit?.w ?? anchorSocket(ctx, on.fit.anchor, s, diag, c, k), F = effector(s), fwd = norm(sub(s.P[h], s.P[fa]));
	// a support hold's arm is placed as a flat palm's, the fingers on the forearm's line (towardDown turns them after)
	const type = implicit?.type ?? ctx.spec.anchors[on.fit.anchor].grasp, base = socketPalm(side, w, type === "support" ? "palm" : type, fwd, c.yaw);
	const measure = st => ({ pos: effector(st), R: cols(palmAxes(sk, st, side)) }), now = measure(s);
	// free to roll about its axis (no `from`): the roll the arm holds most easily, the Boltzmann mean of ROLLS rolls pulled
	// lightly toward the fingers on the forearm's line, so the hand closes on the bar from the side the arm comes from
	// then the knuckle line tilts on the bar (an oblique grip) up to TILT deg, priced, where the forearm cannot come across it
	const strain = R => { const t = aimArm(sk, s, side, { pos: F, R }, now, 1, "palm"); return swivel(sk, s, side, t.goal, t.wristAt(t.goal), t.plane, ELBOW_REST).cost; };
	const col = (M, i) => [M[0][i], M[1][i], M[2][i]], turned = th => mul(axisRot(col(base, 1), th * DEG), base);
	const pick = () => {
		const free = w.axis && !w.from && type !== "palm", roll = free ? softmin(th => strain(turned(th)) + PULL * (1 - Math.cos(th))) : 0;
		const rolled = turned(roll), tilted = a => mul(axisRot(col(rolled, 2), a), rolled);
		const tilt = w.axis && type !== "palm" ? mean(TILTS.map(a => [a, strain(tilted(a)) + SLANT * (a / TILT) ** 2])) : 0;
		return { R: tilted(tilt), roll, tilt };
	};
	const planned = plannedGrasp(ctx, on.fit.anchor, k, f, pick), { roll, tilt } = planned;
	let R = planned.R, { goal, plane, wristAt } = aimArm(sk, s, side, { pos: F, R }, now, on.w, "palm");
	const arm = swivel(sk, s, side, goal, wristAt(goal), plane, ELBOW_REST, { w: on.w });
	// a support hold: the elbow swivels as for that flat palm, then the fingers turn from the forearm's line down the face
	// only as far as the wrist turns comfortably (towardDown). Swivelled for the fingers straight down instead, the elbow
	// rose and the palm needed the forearm's whole twist to face the box: 84 deg on the T2 walk, 100-160 on the lift onto
	// the shelf, past its 85 deg limit, so the palm tipped 17-76 deg off the face and the thumb went 7 cm into the box
	if (type === "support") {
		twoBone(sk, s, a, fa, h, wristAt(goal), arm.pole, ELBOW_REST, "elbow");
		R = towardDown(sk, s, side, socketPalm(side, w, type, fwd, c.yaw), F, measure);
		// the palm against the hand bone measured again on the arm just placed (aimArm reads the pair off the pose)
		({ goal, wristAt } = aimArm(sk, s, side, { pos: F, R }, measure(s), on.w, "palm"));
	}
	let need = { twist: 0, flex: 0, dev: 0 };
	for (let i = 0; i < ITER; i++) {
		twoBone(sk, s, a, fa, h, wristAt(i ? s.R[h] : goal), arm.pole, ELBOW_REST, "elbow");
		need = orient(sk, s, side, h, fa, goal);
	}
	diag[`grip_${k}`] = { w: on.w, socket: true, ...need, roll: roll * DEG, tilt };
	diag[`socket_${k}`] = { rel: mul(T(plain), s.R[h]) };
}

/**
 * A support hold's palm frame R (columns d down the face, l, n into it; sockets.js socketPalm) with its fingers turned
 * from the forearm's line on the face toward straight down as far as the wrist turns comfortably: the ulnar/radial
 * deviation within WRIST_COMFORT and the flex and twist within WRIST_LIMITS, read the way orient and QA WRIST read the
 * wrist (arm-orient.js wristNeed on the arm just placed), by bisection on the turn. Asked straight down, the T2 support
 * hold's wrist clamped at its 35 deg limit on every carried frame (QA WRIST, 62-73 deg asked); 45 deg off down still
 * hooks the fingers under (the T2 recipe's walk, measured), and the palm stands low enough for it (anchors.js supportLow).
 */
function towardDown(sk, s, side, R, F, measure) {
	const I = sk.index, h = I[`${side}Hand`], fa = I[`${side}ForeArm`], col = i => [R[0][i], R[1][i], R[2][i]], d = col(0), n = col(2);
	const axT = norm(sub(s.P[h], s.P[fa])), f = sub(axT, scale(n, dot(axT, n))), ax = cross(f, d);
	if (len(f) < 1e-6 || len(ax) < 1e-6) return R;
	const fp = norm(f), full = Math.acos(Math.max(-1, Math.min(1, dot(fp, d)))) * DEG, axis = norm(ax);
	const frame = deg => { const d2 = norm(apply(axisRot(axis, deg), fp)); return cols({ d: d2, l: cross(n, d2), n }); };
	const now = measure(s), neutral = mul(s.R[fa], mul(T(sk.restWorldRot[fa]), sk.restWorldRot[h])), l = apply(mul(neutral, T(s.R[h])), palmAxes(sk, s, side).l);
	const within = (v, [lo, hi]) => v >= lo && v <= hi;
	const ok = deg => { const need = wristNeed(neutral, aimArm(sk, s, side, { pos: F, R: frame(deg) }, now, 1, "palm").goal, axT, l);
		return within(need.dev, WRIST_COMFORT.dev) && within(need.flex, WRIST_LIMITS.flex) && within(need.twist, WRIST_LIMITS.twist); };
	if (ok(full)) return R;
	let lo = 0, hi = full;
	for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
	return frame(lo);
}

/**
 * The grasp frame a reach turns the hand into, chosen once on the reach's first full-weight frame and kept on the
 * approach to it (ctx.graspPlans, per bake): a person sets the hand's turn for the grasp at its end and keeps it on the way
 * (end-state comfort), and a choice taken anew every frame flipped between two near-equal rolls as the fingers closed
 * (a 5.5 cm wrist jump in one frame). pick() chooses it on the pose being solved: { R, roll, tilt }.
 */
function plannedGrasp(ctx, name, k, f, pick) {
	const ch = `w_${name}_${k}`, at = g => ctx.weightAt?.(ch, g) ?? 0;
	if (!ctx.weightAt || !Number.isInteger(f)) return pick();
	let a = f, g;
	while (a > 0 && at(a - 1) > 1e-3) a--;
	for (g = a; g < ctx.frameCount - 1 && at(g) < 0.999 && at(g + 1) > 1e-3; g++);
	const key = `${ch}:${a}`;
	ctx.graspPlans ??= new Map();
	// from the grasp on, the hand follows what it holds (carried, it moves): the plan covers the approach only
	if (f >= g) { const plan = pick(); if (f === g) ctx.graspPlans.set(key, plan); return plan; }
	if (!ctx.graspPlans.has(key)) { ctx.graspPlans.set(key, null); (ctx.hold?.plainFrame ?? ctx.solvedAt)(g); }
	return ctx.graspPlans.get(key) ?? pick();
}

/**
 * The hand of a socket carry after its grab keeps the grab frame's wrist turn against the forearm (see above), read
 * once per bake (ctx.socketTurns) off the grab frame solved without the keys: a keyed carry's curve is built on
 * frames solved without keys, which come here, so the keyed solve of the grab frame would need that curve again.
 */
export function keepSocketTurn(ctx, sk, s, side, k, carry) {
	const key = `${k}:${carry.grab}`;
	ctx.socketTurns ??= new Map();
	if (!ctx.socketTurns.has(key)) {
		ctx.socketTurns.set(key, null);
		ctx.socketTurns.set(key, (ctx.hold?.plainFrame ?? ctx.solvedAt)(carry.grab)?.diag?.[`socket_${k}`]?.rel ?? null);
	}
	const rel = ctx.socketTurns.get(key);
	if (!rel) return;
	const I = sk.index, fa = I[`${side}ForeArm`], h = I[`${side}Hand`];
	orient(sk, s, side, h, fa, mul(s.R[fa], rel));
}
