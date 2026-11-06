// Support holds (grasp "support", ../sockets.js): a box carried from below at its sides. supportAt places each hand's
// socket frame by frame from the box's size, what it rests on and the arm, and takes the hand off it at the let-go.
import { add, sub, scale, len, norm, apply, T, cross, axisRot } from "./math.js";
import { palmPoint, fingerReach } from "./limbs.js";
import { SIDES } from "./pose.js";
import { supportFace, supportHeight, gapUnder, bottomPoints, SUPPORT_CLEAR, SUPPORT_SLIDE, SUPPORT_LEAD } from "../sockets.js";
import { partsOf } from "../object-pose.js";
import { GRASP_FINGERS } from "./vocab.js";

/** Shoulder to wrist with the arm straight (rest bone lengths), m (anchors.js armReach). */
function armLength(sk, k) {
	const S = SIDES[k], P = sk.restWorldPos, I = sk.index;
	return len(sub(P[I[`${S}ForeArm`]], P[I[`${S}Arm`]])) + len(sub(P[I[`${S}Hand`]], P[I[`${S}ForeArm`]]));
}

// a support hold's hooked fingers turn under the bottom edge at their middle joints: the palm point stands their distance
// from it (the knuckle to the finger middles, less the palm point's own offset back from the knuckles: limbs.js palmPoint)
// above the bottom, the fingers SUPPORT_TILT deg off straight down (the hand's turn the wrist and elbow leave it: 45 on
// the T2 walk, measured), less SUPPORT_EDGE for the phalanx's own thickness past the edge
const SUPPORT_TILT = 30, SUPPORT_EDGE = 0.012;
function supportLow(sk, S) {
	const I = sk.index, P = sk.restWorldPos, bone = f => len(sub(P[I[`${S}Hand${f}2`]], P[I[`${S}Hand${f}1`]]));
	return ((bone("Index") + bone("Middle")) / 2 - palmPoint(sk, S, "support")[0]) * Math.cos((SUPPORT_TILT * Math.PI) / 180) - SUPPORT_EDGE;
}

/** How far the bottom of body `id` (on pose `pose`, its base pivot) stands above what is under it at frame f (../sockets.js gapUnder). */
const clearance = (ctx, id, pose, f) => gapUnder(ctx.scene, new Set([id, ...partsOf(ctx.scene, id)]), bottomPoints(pose, ctx.scene.objects[id].half), f === undefined ? {} : ctx.objectsAt?.(f)).gap;
/**
 * The same at frame f where the baked tracks have the body (ctx.objectsAt), once per bake: supportAt reads SUPPORT_LEAD
 * frames ahead on every evaluation of each hand, and measuring them again made the T2 support take compile in 2.36 s
 * against 1.74 s for the same take by hand numbers (CPU profile: sdBox, gapUnder, bottomPoints). null off the tracks.
 */
const TRACK_GAPS = new WeakMap();
function trackClearance(ctx, id, f) {
	// keyed on the pose the tracks hand back (a retime bakes new ones behind the same ctx.objectsAt: keyed on that, S10's
	// set-down read stale gaps and moved the hands 9.8 cm)
	const bodies = ctx.objectsAt?.(f), p = bodies?.[id];
	if (!p?.R) return null;
	if (!TRACK_GAPS.has(p)) TRACK_GAPS.set(p, gapUnder(ctx.scene, new Set([id, ...partsOf(ctx.scene, id)]), bottomPoints(p, ctx.scene.objects[id].half), bodies).gap);
	return TRACK_GAPS.get(p);
}

/**
 * The socket of a support hold (grasp "support", ../sockets.js): the side face picked once per compile for the hand that
 * takes the anchor (its fit's side), the palm point on it from the box's size and the rig's hand, its height by what the
 * box rests on (sockets.js supportHeight); `local`, when the spec gives one, is the point instead. { p, from, down }.
 */
/** poseAt(id, frame): body `id`'s pose at that frame as the hand reads it (the anchor's object frame). */
export function supportAt(ctx, name, a, s, diag, side, poseAt, c) {
	const poseOf = id => poseAt(id, diag?.frame);
	const k = side ?? (ctx.spec.fits ?? []).find(fit => fit.anchor === name)?.side ?? "r", S = SIDES[k], I = ctx.sk.index;
	// letting go (reachGrip's letgo_<anchor>_<k>): the hand leaves the box where it let go of it, at the frame the let-go
	// starts (the box may still come down after it, t2s1), and moves off from there (letGoOff)
	const ch = `letgo_${name}_${k}`, g = c?.[ch] ?? 0, f0 = diag?.frame;
	if (g > 0 && f0 !== undefined && ctx.weightAt) {
		let h0 = f0 - 1;
		while (h0 > 0 && (ctx.weightAt(ch, h0) ?? 0) > 0) h0--;
		const now = { ...diag, frame: h0 }, pose0 = poseAt(a.object, h0);
		const held = supportAt(ctx, name, a, s, now, side, poseAt, { ...c, [ch]: 0 });
		const sup = ctx.supports.get(name), n = [0, 0, 0];
		n[sup.axis] = sup.sign;
		return { ...held, p: add(held.p, letGoOff(ctx, a, sup, pose0, n, held.p, s, k, h0, g, c)) };
	}
	const half = ctx.scene.objects[a.object].half, pose = poseOf(a.object), back = v => apply(T(pose.R), v);
	ctx.supports ??= new Map();
	if (!ctx.supports.has(name)) {
		const sh = s.P[I[`${S}Arm`]], other = s.P[I[`${SIDES[k === "l" ? "r" : "l"]}Arm`]];
		ctx.supports.set(name, { ...supportFace(half, back(sub(sh, other)), back(sub(sh, pose.pos))), low: supportLow(ctx.sk, S), press: half[1],
			reach: fingerReach(ctx.sk, S, "support") + SUPPORT_TIP, hook: fingerReach(ctx.sk, S, "support", GRASP_FINGERS.support) + SUPPORT_TIP });
	}
	const sup = ctx.supports.get(name), at = sup.at.slice(), n = [0, 0, 0], f = diag?.frame, gap = clearance(ctx, a.object, pose, f);
	const upper = len(sub(ctx.sk.restWorldPos[I[`${S}ForeArm`]], ctx.sk.restWorldPos[I[`${S}Arm`]])), elbow = s.P[I[`${S}Arm`]][1] - upper;
	n[sup.axis] = sup.sign;
	let unroll = 1;
	if (f !== undefined && f > liftedAt(ctx, a.object)) {
		// setting it down: the palm rises by the fingers' depth still blocked, looking SUPPORT_LEAD frames ahead, and a
		// hold rolled under the edge (below) turns back onto the face first (rolled, the hand met the T2 shelf, 0.7 cm)
		let ahead = gap;
		for (let j = 1; j <= SUPPORT_LEAD; j++) { const g = trackClearance(ctx, a.object, f + j); if (g !== null) ahead = Math.min(ahead, g); }
		at[1] = sup.low + Math.max(0, SUPPORT_CLEAR - ahead);
		const u = Math.min(1, Math.max(0, (ahead - 0.01) / 0.04));
		unroll = u * u * (3 - 2 * u);
	} else at[1] = supportHeight(sup.low, sup.press, gap);
	// a hand hanging below the elbow points its fingers down the face, and finger-close straightens them off the box once
	// the palm is off the bottom edge: their tips reach SUPPORT_HANG0 + SUPPORT_HANG x (how far the palm is below the
	// elbow of a hanging upper arm) of their flat reach below the palm point (measured: 0.30 of straight down 0.12 m above
	// it, the T2 shelf; 0.75 at 0.13-0.16 m, the S10 table; 0.86 at 0.19-0.21, the T2 walk; 1.0 at 0.32, the S10 floor). The
	// palm stands that high over what the box rests on or lands on, eased in over the SUPPORT_LEAD frames before it lands
	// (the nearer, the more): rising only by the hook's depth, the S10 set-down put the fingertips 1.2 cm into the floor.
	// Raised arms keep the hook, never less than its whole reach (limbs.js fingerReach): set down with the fingers level,
	// its tips came 6.4-6.8 cm under the palm point and went 2 cm into the shelf (agent run t2s3, Y Bot, f315)
	// (the roll below: rolled under the edge the hook stays under the bottom, 1-2 cm; lifted by its whole reach over the
	// T2 shelf the rolled palm came 1.1 cm off the face, t2s3 f266-300)
	const edge = at.slice(), ax = norm(cross([0, 1, 0], n));
	edge[sup.axis] = sup.sign * half[sup.axis];
	edge[1] = 0;
	const t = Math.min(1, Math.max(0, (add(pose.pos, apply(pose.R, edge))[1] - elbow + SUPPORT_ROLL_FROM) / SUPPORT_ROLL_SPAN)), rolled = t * t * (3 - 2 * t) * unroll;
	const below = elbow - add(pose.pos, apply(pose.R, at))[1], drop = Math.max(sup.hook * (1 - rolled), sup.reach * Math.min(1, Math.max(0, SUPPORT_HANG0 + SUPPORT_HANG * below)));
	for (let j = 0; j <= SUPPORT_LEAD && f !== undefined; j++) {
		const g = j ? trackClearance(ctx, a.object, f + j) : gap, e = 1 - j / (SUPPORT_LEAD + 1);
		if (g !== null) at[1] = Math.max(at[1], e * e * (3 - 2 * e) * (drop - g));
	}
	// raised past the elbow the forearm points up and the fingers, on the face, lie forward off the bottom (0-1 of 4 tips
	// under on the T2 lift onto the shelf; swung up instead, the elbow asked the forearm's whole twist, 100-160 deg past
	// its 85): the hold rolls round the bottom edge, the palm point and the face's frame turned about the edge up to
	// SUPPORT_ROLL deg (up toward out toward down), the palm under the edge and the fingers in under the box
	const roll = axisRot(ax, SUPPORT_ROLL * rolled), turn = v => apply(roll, v);
	return { p: add(pose.pos, apply(pose.R, a.local ?? add(edge, turn(sub(at, edge))))), from: norm(apply(pose.R, turn(n))), down: norm(apply(pose.R, turn([0, -1, 0]))) };
}

// the let-go's first move: 3 cm out of the face and 3 cm up over the first half of it; LETGO_CLEAR past what it stood on
const LETGO_OUT = 0.03, LETGO_LIFT = 0.03, LETGO_CLEAR = 0.01, LETGO_FIRST = 0.5;
const ease = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const level = v => norm([v[0], 0, v[2]]);
/**
 * Where a support hold's anchor point moves at let-go share g (0..1, reachGrip's letgo_<anchor>_<k>) at frame f, from its
 * hold point p: out along the face's normal n (its axes) by LETGO_OUT and up LETGO_LIFT over the first LETGO_FIRST of it,
 * and over all of it back toward the body along the face until the hand (the fingers' reach round the palm point) is past
 * the near edge of what the box rests on, or up instead when that is shorter: high enough that the straight drop to the
 * hanging hand (below the shoulder) passes over that edge with the fingers clear. World offset, m.
 */
function letGoOff(ctx, a, sup, pose, n, p, s, k, f, g, c) {
	const I = ctx.sk.index, sh = s.P[I[`${SIDES[k]}Arm`]], other = s.P[I[`${SIDES[k === "l" ? "r" : "l"]}Arm`]], out = level(apply(pose.R, n));
	// where the hand hangs once the arm is down (pose.js: arm_rest below level, out from the shoulder line)
	const hang = ((90 - (Number.isFinite(c?.arm_rest) ? c.arm_rest : 72)) * Math.PI) / 180, reach = armLength(ctx.sk, k);
	const fk = add(add(sh, scale(level(sub(sh, other)), reach * Math.sin(hang))), [0, -reach * Math.cos(hang), 0]);
	let back = [fk[0] - p[0], 0, fk[2] - p[2]];
	const run = len(back);
	back = run > 1e-6 ? scale(back, 1 / run) : level(sub(sh, p));
	const bodies = ctx.objectsAt?.(f) ?? {}, on = gapUnder(ctx.scene, new Set([a.object, ...partsOf(ctx.scene, a.object)]), bottomPoints(pose, ctx.scene.objects[a.object].half), bodies).on;
	let dist = 0, dir = back;
	const b = on && bodies[on], h = on && ctx.scene.objects[on]?.half, r = sup.reach + LETGO_CLEAR;
	const top = b?.R && h ? b.pos[1] + b.R[1][1] * h[1] + [0, 1, 2].reduce((m, i) => m + Math.abs(b.R[1][i]) * h[i], 0) : -Infinity;
	// a surface the hanging hand comes down to: the hand leaves its top, its footprint grown by the fingers' reach
	if (top > fk[1] - r) {
		const q = apply(T(b.R), sub(p, b.pos)), d = apply(T(b.R), back);
		const exit = [0, 2].reduce((m, i) => (Math.abs(d[i]) < 1e-9 ? m : Math.min(m, (Math.sign(d[i]) * (h[i] + r) - q[i]) / d[i])), Infinity);
		const inside = Math.abs(q[0]) < h[0] + r && Math.abs(q[2]) < h[2] + r;
		dist = inside ? Math.max(0, exit) : 0;
		const lam = run > 1e-6 ? dist / run : Infinity;
		const up = dist > 0 && lam < 1 ? Math.max(0, (top + r - lam * fk[1]) / (1 - lam) - p[1] - LETGO_LIFT) : Infinity;
		if (up < dist) { dist = up; dir = [0, 1, 0]; }
	}
	const first = ease(g / LETGO_FIRST);
	return add(add(scale(out, LETGO_OUT * first), [0, LETGO_LIFT * first, 0]), scale(dir, dist * g));
}
const SUPPORT_ROLL = 60, SUPPORT_ROLL_FROM = 0.05, SUPPORT_ROLL_SPAN = 0.2;
// SUPPORT_TIP: a fingertip's skin (qa/grasp-checks.js PHALANX, 9 mm) and 5 mm clear of what the box lands on
const SUPPORT_HANG0 = 0.5, SUPPORT_HANG = 2, SUPPORT_TIP = 0.014;

/**
 * The first frame body `id` stands SUPPORT_SLIDE clear of what it rested on (its lift: the palm has slid down to the bottom
 * edge, sockets.js supportHeight), Infinity if never; per bake (ctx.objectsAt changes with it). At SUPPORT_CLEAR the palm
 * target jumped from 12.3 cm up the face to 2.7 in one frame (the T2 lift, f160-161: the hand 5.5 cm down the face).
 */
const LIFTS = new WeakMap();
function liftedAt(ctx, id) {
	const tracks = ctx.objectsAt;
	if (!tracks) return Infinity;
	let m = LIFTS.get(tracks);
	if (!m) LIFTS.set(tracks, (m = new Map()));
	if (!m.has(id)) {
		let at = Infinity;
		for (let g = 0; g < (ctx.frameCount ?? 0) && at === Infinity; g++) if ((trackClearance(ctx, id, g) ?? -1) >= SUPPORT_SLIDE) at = g;
		m.set(id, at);
	}
	return m.get(id);
}
