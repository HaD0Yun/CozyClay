// Generators expand into ordinary keys before baking. "walk" plans footsteps along a curving
// path from the pose the earlier keys leave at f0: weight shift over the stance foot, pelvis
// bob and twist, toe-off, arm swing, feet together at the end. The steps keep a natural rhythm
// (gait-rhythm.js): period, swing, step, lift and armSwing are the averages, vary: 0 makes every
// step exactly those.
//
// { type: "walk", f0, steps: 8, step: 0.5, period: 20, swing: 14, halfWidth: 0.08, lift: 0.08,
//   heading: [h0, h1], turnDistance: 0.4, pelvisHigh: dy, pelvisLow: dy, firstStep: 0.4, armSwing: 14, vary: 1 }
// heading in degrees (yaw convention); pelvis heights are offsets from the standing hips height.
// The feet roll as a person's do, heel first (the three rockers of gait): the heel strikes with the
// toes up and the foot rolls down about the heel to flat; it stays flat while the shin passes over
// it; the heel comes up well before lift-off and the foot rolls over the ball, toes flat, to toe-off;
// in the air the foot follows the shin, the ankle near neutral (walk-pelvis.js fitSwing), into the next strike.
// The heel strikes with the toes up STRIKE_DF (a stroll's, then a brisk walk's), half that on the closing step (a walk generated from motion
// capture lands with the foot nearly flat: the heel touches a frame or two before the sole); TOE_OFF is the push-off pitch at a full stride (STRIDE_REF m of foot travel), less for
// a shorter one. A pivot is the very point QA reads (qa/geometry.js solePoints), so a rolling foot
// never counts as sliding.
// The upper body leads the legs and its sizes follow the pace (the speed against the default walk's 0.5 m per 20 frames),
// as a person's do: the slower the walk, the less the arms swing and the more the trunk dips and sways. Each arm peaks
// forward or back at a step's mid-swing (the arm's flow lag puts the visible peak about a quarter of a step before the
// strike), ARM_SWING deg a unit of pace (armSwing, when not given); each elbow bends with its swing, most with the arm
// forward and least behind (ELBOW +- ELBOW_SWING, both growing with the pace), and the hands hang with the wrists a
// little flexed (WRIST). The pelvis and chest turns, the side sway and the dip each peak at their own phase of the step
// (the constants below). All of it fades in over the first steps and back out on the closing one.
import { add, sub, scale, len, apply, ry, clamp } from "./math.js";
import { walkRhythm } from "./gait-rhythm.js";
import { fitPelvis, fitTrail, fitSwing, pivot, brisk } from "./walk-pelvis.js";

const STRIKE_DF = [6, 4], TOE_OFF = 50, STRIDE_REF = 1.1, ELBOW = [18, 3], ELBOW_SWING = [6, 3], WRIST = 8;
// The trunk over the stepping hips (degrees at a full stride, less for a shorter one): the pelvis drops on the
// swing side in single support (LIST), the trunk held over it but for SWAY of it; the pelvis turns with the leading
// leg (PELVIS_TURN) and the chest the other way (CHEST_TURN); the trunk dips forward before each strike and back in
// single support (LEAN).
const LIST = 4.5, SWAY = 0.26, PELVIS_TURN = 4.5, CHEST_TURN = 5.5, MID_SLOW = 0.015, STRIKE_AHEAD = [0.52, 0.64], HEEL_OFF = 0.3, HEEL_MIN = 4;
// the upper body by the pace p (module doc), measured against motion-capture walks of 0.7 and 1.4 m/s: the arm swing
// (ARM_SWING deg a unit of pace, at the strike ARM_FALL of its wave: a hanging arm falls back from its peak a little
// ahead of a sine); the chest turn peaking CHEST_AT(p) steps before the strike and the pelvis turn PELVIS_AT(p)
// steps after it (at a stroll the two turn nearly together, at a brisk walk against each other); the side sway SIDE(p)
// deg peaking SIDE_AT steps before the strike (just after the last); the dip LEAN(p) deg with its peaks LEAN_AT steps
// before the strike, about a forward lean of WALK_LEAN deg a unit of pace
const ARM_SWING = 6.4, ARM_FALL = 0.8, CHEST_AT = p => clamp(0.66 - 0.18 * p, 0.2, 0.48), PELVIS_AT = p => clamp(0.32 - 0.11 * p, 0, 0.45);
const SIDE = p => clamp(2.8 - 0.45 * p, 1.2, 3), SIDE_AT = 0.92, LEAN = p => clamp(4.7 - 1.1 * p, 1.8, 4), LEAN_AT = [0.2, 0.6], WALK_LEAN = 0.9;
// the swing's path: the heel kicks up right after toe-off (EARLY_AT of the swing, 2 frames at least: EARLY_FWD of the
// way to mid-swing, EARLY_LIFT m up at a full stride and a swing of KICK_AIR frames or more, KICK_STROLL of that at a stroll's
// pace: a person strolling folds the knee less), so the knee folds as the
// toe leaves; it comes down LAND_BACK of the stride behind and LAND_ABOVE m over the strike LAND_AT of the swing before
// it. A swing too short for a key leaves it out (the foot would jolt between keys a frame apart), and the closing step
// sets down without either. The heel takes HEEL_MIN frames at least to rise and rises no higher than PITCH_MAX: past about 60 deg
// the toes sit behind the ankle and QA reads a bent knee as bending backward.
const EARLY_AT = 0.18, EARLY_FWD = 0.35, EARLY_LIFT = 0.18, KICK_STROLL = 0.55, KICK_AIR = 10, LAND_AT = 0.22, LAND_BACK = 0.12, LAND_ABOVE = 0.03, PITCH_MAX = 50;
const fwd = h => apply(ry(h), [0, 0, 1]);
const leftOf = h => apply(ry(h), [1, 0, 0]);
const smoothstep = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Last keyed value of every channel at or before frame f. */
export function stateAt(keys, f) {
	const st = {};
	for (const k of [...keys].sort((a, b) => a.f - b.f)) if (k.f <= f) Object.assign(st, k.set);
	return st;
}

/** gen -> keys; every key carries src (tag + step number) so QA can name the step it came from. */
export function walk(gen, keys, sk, tag = "walk") {
	let src = `${tag} start`;
	const out = [], at = (f, set) => { const key = { f, set, src }; out.push(key); return key; };
	const st = stateAt(keys, gen.f0);
	if (!st.foot_l || !st.foot_r || !st.root) throw new Error("MOTION_SPEC_INVALID: walk needs foot_l, foot_r and root keyed before f0");
	if (gen.vary !== undefined && !(Number.isFinite(gen.vary) && gen.vary >= 0 && gen.vary <= 2)) throw new Error(`MOTION_SPEC_INVALID: ${tag} vary must be a number from 0 (every step the same) to 2, got ${JSON.stringify(gen.vary)}`);
	const I = sk.index, P = sk.restWorldPos;
	const ank = P[I.LeftFoot][1], standY = P[I.Hips][1];
	const footRest = { l: sub(P[I.LeftToeBase], P[I.LeftFoot]), r: sub(P[I.RightToeBase], P[I.RightFoot]) };
	// QA's heel point from the ankle of a flat foot at yaw 0; a foot pitched `deg` about a point on the ground
	const heelOff = [0, 0.005 - ank, -0.045];
	const flatAt = { l: -Infinity, r: -Infinity };
	// Pelvis heights from the leg length: straight-ish over the stance foot, low enough at
	// double support that the trailing leg still reaches (2% knee slack).
	const leg = len(sub(P[I.LeftLeg], P[I.LeftUpLeg])) + len(sub(P[I.LeftFoot], P[I.LeftLeg]));
	const hipDrop = P[I.Hips][1] - P[I.LeftUpLeg][1], step0 = gen.step ?? 0.5, hw = gen.halfWidth ?? 0.08;
	const hipsAt = horiz => Math.sqrt(Math.max(0, (0.98 * leg) ** 2 - horiz ** 2)) + ank + hipDrop - standY;
	const W = { steps: 8, step: step0, period: 20, swing: 14, halfWidth: hw, lift: 0.08, turnDistance: 0.4, firstStep: 0.4,
		pelvisHigh: Math.min(-0.005, hipsAt(Math.hypot(0.03, hw - 0.035))), pelvisLow: hipsAt(Math.hypot(step0 / 2, hw)), vary: 1, ...gen };
	const pace = (W.step / W.period) / (0.5 / 20);
	W.armSwing = gen.armSwing ?? clamp(ARM_SWING * pace, 4, 22);
	const chestAt = CHEST_AT(pace), pelvisAt = PELVIS_AT(pace), sideSway = SIDE(pace), dipBy = LEAN(pace), walkLean = clamp(WALK_LEAN * pace, 0, 3);
	const elbow = ELBOW[0] + ELBOW[1] * Math.min(pace, 2.5), elbowSwing = ELBOW_SWING[0] + ELBOW_SWING[1] * Math.min(pace, 2.5);
	const [h0, h1] = W.heading ?? [st.yaw ?? 0, st.yaw ?? 0];
	const hs = s => h0 + (h1 - h0) * smoothstep(s / W.turnDistance);
	const c0 = scale(add(st.foot_l, st.foot_r), 0.5); c0[1] = 0;
	const path = [c0];
	for (let i = 0; i < 4000; i++) path.push(add(path[i], scale(fwd(hs(i * 0.01)), 0.01)));
	const C = s => path[Math.max(0, Math.min(path.length - 1, Math.round(s / 0.01)))];
	const footAt = (s, k) => { const p = add(C(s), scale(leftOf(hs(s)), (k === "l" ? 1 : -1) * W.halfWidth)); p[1] = ank; return p; };
	const stance = { l: -0.07, r: 0.07 }, state = { foot_l: st.foot_l, foot_r: st.foot_r, fyaw_l: st.fyaw_l ?? h0, fyaw_r: st.fyaw_r ?? h0 };
	const holdAll = ["root", "yaw", "roll", "foot_l", "foot_r", "fyaw_l", "fyaw_r", "spine_yaw", "spine_roll", "spine_pitch", "aswing_l", "aswing_r", "abend_l", "abend_r",
		"wflex_l", "wflex_r", "head_yaw"];
	const r0 = st.roll ?? 0, sr0 = st.spine_roll ?? 0, sp0 = st.spine_pitch ?? 0;
	// each foot's spans on the ground (fitPelvis): from a heel strike (or f0) to its lift-off, heel the frame its heel comes up
	const ground = { l: [{ a: gen.f0, b: Infinity, strike: false }], r: [{ a: gen.f0, b: Infinity, strike: false }] };
	at(gen.f0, Object.fromEntries(holdAll.map(ch => [ch, st[ch] ?? state[ch] ?? (ch === "yaw" ? h0 : 0)])));
	let sLast = stance.r, prev = null;
	const R = walkRhythm(W, { s0: sLast, turn: (a, b) => hs(b) - hs(a),
		seed: [gen.f0, W.steps, W.step, W.period, W.swing, W.firstStep, h0, h1, c0[0].toFixed(3), c0[2].toFixed(3)].join("|") });
	for (let i = 0; i < W.steps; i++) {
		src = `${tag} step ${i + 1}`;
		const k = i % 2 === 0 ? "l" : "r", other = k === "l" ? "r" : "l", last = i === W.steps - 1;
		const sNew = last ? sLast : sLast + R.inc[i];
		const ts = gen.f0 + 16 + R.lift[i], tl = ts + R.air[i], tm = ts + Math.floor(R.air[i] / 2);
		// gait initiation: move the weight over the stance foot before the first heel comes up
		if (i === 0) {
			const pre = add(C(stance[other]), scale(leftOf(h0), (other === "l" ? 1 : -1) * W.halfWidth * 0.75)); pre[1] = st.root[1];
			at(ts - 4, { root: pre, yaw: h0 });
			at(ts, { arm_hang: 1 });
		}
		// a longer stride pushes off more; the closing step pushes and strikes less
		const size = clamp(Math.abs(sNew - stance[k]) / STRIDE_REF, 0.3, 1.15), toeOff = TOE_OFF * (0.55 + 0.45 * size) * (last ? 0.8 : 1);
		// forefoot rocker: the heel comes up HEEL_OFF of a step before lift-off (a little sooner on the first
		// step, the weight only just over the other foot) and the foot rolls over the ball, slowly
		// while the other foot is still in the air, then fast to toe-off
		const ankle = state[`foot_${k}`], yw = state[`fyaw_${k}`], ball = add(ankle, apply(ry(yw), footRest[k]));
		const tHeel = Math.max(ts - Math.max(HEEL_MIN, Math.round((i === 0 ? 0.35 : HEEL_OFF) * W.period)), flatAt[k] + 1, gen.f0 + 1);
		Object.assign(ground[k].at(-1), { b: ts, heel: tHeel, ball, yw, flat: ankle });
		for (let f = tHeel; f <= ts; f++) {
			const d = toeOff * ((f - tHeel) / Math.max(1, ts - tHeel)) ** 1.8;
			at(f, { [`foot_${k}`]: pivot(ball, yw, d, ankle), [`fpitch_${k}`]: d, [`fyaw_${k}`]: yw });
		}
		// swing: the foot rises behind first (the knee folds right after toe-off), the toes trailing down, level at
		// mid-swing, and comes down onto the heel from above (the toes up) instead of skimming the floor
		const lead = Math.max(1, Math.round(LAND_AT * R.air[i]));
		const mid = footAt((stance[k] + sNew) / 2, k); mid[1] += R.height[i];
		const off = pivot(ball, yw, Math.min(toeOff, PITCH_MAX), ankle), rise = add(off, scale(sub(mid, off), EARLY_FWD));
		// a shorter swing kicks lower (the same rise in fewer frames would jolt the foot): by its length against KICK_AIR
		// and with the step's own lift (gait-rhythm), so no two swings fold the knee alike
		rise[1] = off[1] + EARLY_LIFT * size * Math.min(1, (R.air[i] / KICK_AIR) ** 2) * (KICK_STROLL + (1 - KICK_STROLL) * brisk(pace)) * (R.height[i] / W.lift);
		// in a turn the line from the toe-off to mid-swing cuts in toward the other foot: the kick stays out at mid-swing's side
		const outward = scale(leftOf(hs(stance[other])), k === "l" ? 1 : -1), foot = state[`foot_${other}`];
		const side = p => (p[0] - foot[0]) * outward[0] + (p[2] - foot[2]) * outward[2], inside = side(mid) - side(rise);
		if (inside > 0) { rise[0] += outward[0] * inside; rise[2] += outward[2] * inside; }
		const early = ts + Math.max(2, Math.round(EARLY_AT * R.air[i]));
		if (!last && early < tm - 1) at(early, { [`foot_${k}`]: rise, [`fpitch_${k}`]: 0.7 * Math.min(toeOff, PITCH_MAX) });
		at(tm, { [`foot_${k}`]: mid, [`fyaw_${k}`]: hs((stance[k] + sNew) / 2), [`fpitch_${k}`]: 0 });
		// at the strike the hips are past the middle of the stride (STRIKE_AHEAD: about half way at a stroll, well past it
		// at a brisk walk, so a slow walk's hips dip between spread legs), over the landing foot's side;
		// between strikes they cross the floor at an even pace, a little slower over mid-stance (MID_SLOW of the step)
		const sLand = stance[other] + (STRIKE_AHEAD[0] + (STRIKE_AHEAD[1] - STRIKE_AHEAD[0]) * brisk(pace)) * (sNew - stance[other]);
		const sEven = prev ? prev.s + (sLand - prev.s) * ((tm - prev.f) / (tl - prev.f)) : null;
		const sMid = sEven === null ? stance[other] + 0.03 : sEven - MID_SLOW * Math.abs(sNew - stance[k]) / 2, shift = i === 0 ? 0.015 : 0.032;
		const pm = add(C(sMid), scale(leftOf(hs(sMid)), (other === "l" ? 1 : -1) * shift)); pm[1] = standY + W.pelvisHigh;
		// a stride longer than the nominal one drops the hips a little more at double support, so the trailing leg still reaches
		const low = gen.pelvisLow ?? (R.inc[i] > step0 ? Math.min(W.pelvisLow, hipsAt(Math.hypot(R.inc[i] / 2, hw))) : W.pelvisLow);
		const pl = C(sLand).slice(); pl[1] = standY + (last ? W.pelvisHigh : low);
		prev = { f: tl, s: sLand };
		// heel rocker: the toes come up before the strike, then the foot rolls down about the heel to flat
		const land = footAt(sNew, k), lyaw = hs(sNew), heel = add(land, apply(ry(lyaw), heelOff));
		const strike = -(STRIKE_DF[0] + (STRIKE_DF[1] - STRIKE_DF[0]) * brisk(pace)) * (last ? 0.5 : 1), nFlat = Math.max(2, Math.round(0.2 * W.period));
		const touch = pivot(heel, lyaw, strike, land), above = add(touch, scale(fwd(lyaw), -LAND_BACK * Math.abs(sNew - stance[k])));
		above[1] += LAND_ABOVE;
		if (!last && lead > 1 && tl - lead > tm + 1) at(tl - lead, { [`foot_${k}`]: above, [`fpitch_${k}`]: 0.6 * strike });
		for (let j = 0; j <= nFlat; j++) {
			const d = strike * (1 - smoothstep(j / nFlat));
			at(tl + j, { [`foot_${k}`]: pivot(heel, lyaw, d, land), [`fpitch_${k}`]: d, [`fyaw_${k}`]: lyaw });
		}
		flatAt[k] = tl + nFlat;
		ground[k].push({ a: tl, b: Infinity, strike: true });
		state[`foot_${k}`] = land; state[`fyaw_${k}`] = lyaw; stance[k] = sNew;
		const swing = (last ? 0 : i < 3 ? [0, 0.3, 0.7][i] : 1) * R.arm[i], sg = k === "l" ? 1 : -1;
		const sp = clamp(size, 0.4, 1.1), ramp = last ? 0 : i === 0 ? 0.5 : 1, list = LIST * sp * ramp * (other === "l" ? 1 : -1);
		// the upper body leads the legs (module doc): the arms, the turns and the side sway are waves keyed at mid-swing (tm, dm
		// of a step before the strike) and at the strike, the arms peaking at tm: a wave peaking `peak` steps before the strike,
		// scaled so the larger of its two keys is 1 (the interpolation does not overshoot its keys); the dip is keyed at its peaks
		const dm = (tl - tm) / W.period, wave = peak => { const v = [Math.cos(Math.PI * (peak - dm)), Math.cos(Math.PI * peak)]; return v.map(x => x / Math.max(...v.map(Math.abs))); };
		const pelvis = wave(-pelvisAt).map(v => -PELVIS_TURN * sp * sg * swing * v), chest = wave(chestAt).map(v => CHEST_TURN * sp * sg * swing * v);
		const sway = wave(SIDE_AT).map(v => -Math.sign(list) * sideSway * sp * ramp * v);
		const arm = wave(dm).map((v, j) => (j ? ARM_FALL * v : v)), armAt = v => ({ aswing_l: -0.85 * W.armSwing * sg * swing * v,
			aswing_r: W.armSwing * sg * swing * v, abend_l: swing * (elbow - sg * elbowSwing * v), abend_r: swing * (elbow + sg * elbowSwing * v) });
		at(tm, { root: pm, yaw: hs(sMid) + pelvis[0], roll: r0 + list, spine_roll: sr0 - list * (1 + SWAY) + sway[0], spine_yaw: chest[0] - pelvis[0],
			...armAt(arm[0]), wflex_l: WRIST * swing, wflex_r: WRIST * swing });
		at(tl, { root: pl, yaw: hs(sLand) + pelvis[1], roll: r0, spine_roll: sr0 + sway[1], spine_yaw: chest[1] - pelvis[1], ...armAt(arm[1]), head_yaw: 0 });
		const lean = sp0 + walkLean * ramp, dip = dipBy * sp * ramp;
		at(Math.max(gen.f0 + 1, tl - Math.round(LEAN_AT[1] * W.period)), { spine_pitch: lean - 0.6 * dip });
		at(Math.max(gen.f0 + 1, tl - Math.round(LEAN_AT[0] * W.period)), { spine_pitch: lean + dip });
		sLast = sNew;
	}
	const tend = gen.f0 + 16 + W.steps * W.period + 18;
	// the hips' height from the legs on the ground, unless the walk gives its own pelvis heights
	// (only up to the walk's last key: after it the settle just holds, and a take may end there, walkTo)
	const settle = Math.max(...out.map(k => k.f));
	// each swing's path (from the planned toe-off), the hips over it, the heel rise they leave the trailing foot, and
	// each swing again from where that foot now lifts (its approach to the strike, which the hips saw, unchanged)
	if (gen.pelvisHigh === undefined && gen.pelvisLow === undefined) {
		fitSwing(out, { end: settle, ground });
		fitPelvis(sk, out, { f0: gen.f0, end: settle, period: W.period, pace, ground, start: `${tag} start` });
		fitTrail(sk, out, { end: settle, period: W.period, pace, ground });
		fitSwing(out, { end: settle, ground, sk });
	}
	src = `${tag} end`;
	at(tend, stateAt(out, tend));
	return out;
}

export function expandGenerators(spec, sk) {
	// a key filled by MotionBricks (src: "fill" or a pass-through "pass", bricks/fill.js) is the spec's own: QA names it keys[i] like any other
	let keys = (spec.keys ?? []).map((k, i) => (k.src && !/^(fill(#|$)|pass$)/.test(k.src) ? k : { ...k, src: `keys[${i}]`, ...(/^fill(#|$)/.test(k.src ?? "") ? { fill: true } : {}) }));
	(spec.generators ?? []).forEach((gen, i) => {
		if (gen.type !== "walk") throw new Error(`MOTION_SPEC_INVALID: generators[${i}] has unknown type "${gen.type}" (only "walk")`);
		keys = keys.concat(walk(gen, keys, sk, `generators[${i}] walk`));
	});
	return keys;
}
