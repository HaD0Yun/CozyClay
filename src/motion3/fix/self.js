// Self-collision auto-fix (spec.fix.self, on unless false): the arms keep out of the rest of the body,
// on the fitted skin the BODY check measures (body.js, qa/body-checks.js). Wrist targets inside the
// body already went out onto the skin when they were solved (compile.js keepOut); what is left here:
//  - elbow: an upper arm or forearm inside the body turns the elbow about the shoulder-wrist line
//    (ctx.swivel; the hand keeps its place and turn). The turn is planned over the whole take at once,
//    absolute: each frame scores every turn in TURNS by the depth left, the size of the turn and how
//    far the elbow rises past LOW under the shoulder (no chicken wing), plus the change from the frame before, and the cheapest
//    path wins (Viterbi), so the elbow eases in and out instead of snapping;
//  - hand: a hand or forearm still a little inside moves its wrist IK target out along the skin's
//    normal (ctx.skinPush), at most STEP a pass and REACH in all, eased over neighbouring frames. Deeper hits, and the
//    head and neck (a hand at the mouth is on purpose), stay for QA.
// Frames whose arm is FK (armw 0) only get the elbow turn. The report says what moved.
import { bodyFor, bodyNormal, limbDepth, segmentDepth } from "../body.js";
import { add, sub, scale, len, apply, axisRot } from "../compiler/math.js";
import { capsulesFor, segPoints, sdBox } from "../qa/geometry.js";
import { round4 } from "./ease.js";
import { turnWeight, SIDES } from "../compiler/pose.js";
import { allowance } from "../qa/checks.js";
import { regionOf } from "../qa/body-checks.js";

const TURNS = Array.from({ length: 19 }, (_, i) => -90 + i * 10);
const PASSES = 3, EASE = 5, MARGIN = 0.003, ALLOW = 0.003, STEP = 0.03, REACH = 0.08;
/** The most of a declared allowance the push leaves alone (m): a touch (a hand in a pocket), not a skill's leeway for a sweep it cannot avoid. */
const TOUCH = 0.03;
/** Plan weights: per cm^2 of depth, per (10 deg)^2 of turn, per cm^2 of elbow over the shoulder, per (10 deg)^2 of change a frame. */
const DEEP = 40, TURN = 0.05, RISE = 4, CHANGE = 2;
/** How far (m) under the shoulder the elbow may come before RISE counts. Where the spec declares a chicken-wing check
 * on this elbow (checks.below, joint <Side>ForeArm under <Side>Arm: the smoke skill's), rising past its min costs
 * WING_PRICE: a smoking elbow the turn raised past it broke that check once the wrist stopped at its limit (wrist-clamp.js). */
const LOW = 0.09, WING_PRICE = 400;

/** The spec's chicken-wing min (m) for the elbow of `side` on frame i (a below check on it at least half on), else null. */
function wingMin(out, i, side) {
	let min = null;
	for (const b of out.ctx.spec.checks?.below ?? []) {
		const joint = String(b.joint).replace(/^joint:/, ""), ref = String(b.ref).replace(/^joint:/, ""), f = out.f0 + i;
		const on = Array.isArray(b.when) ? f >= b.when[0] && f <= b.when[1] : b.when ? (out.frames[i].c[b.when] ?? 0) > 0.5 : true;
		if (on && joint === `${side}ForeArm` && ref === `${side}Arm` && Number.isFinite(b.min)) min = Math.max(min ?? 0, b.min);
	}
	return min;
}
/** The most the turn changes in one frame (deg): a fast arm turned faster than this pops. */
const STEP_TURN = 10;

/** How much hand k is on a measured target at channels c: a fit of its own (the mouth), or a fit of the
 * other hand anchored to a prop k holds (the flame under k's cigarette). Such a hand is not moved. */
export function fitWeight(spec, c, k) {
	let w = 0;
	for (const fit of spec.fits ?? []) {
		const a = spec.anchors?.[fit.anchor], on = c[`w_${fit.anchor}_${fit.side}`] ?? 0;
		if (fit.side === k || (a?.kind === "prop" && spec.props?.[a.prop]?.hand === k)) w = Math.max(w, on);
	}
	return Math.min(1, w);
}

const capR = (sk, part) => capsulesFor(sk).find(c => c[0] === part)[3];
/** How deep (m) segment A-B of radius r goes into the scene's boxes (QA's COLLIDE on the same capsules). */
function sceneDepth(boxes, A, B, r) {
	let worst = 0;
	for (const box of boxes) worst = Math.max(worst, r - Math.min(...segPoints(A, B, 5).map(p => sdBox(p, box))));
	return worst;
}

/** Deepest skin depth (m) of the upper arm and forearm with the elbow turned `deg` more about the shoulder-wrist line,
 * and how deep they go into the scene's boxes (an elbow turned out of the body must not turn into a steering wheel). */
function elbowDepth(body, sk, s, side, deg, boxes = []) {
	const I = sk.index, a = I[`${side}Arm`], fa = I[`${side}ForeArm`], S = s.P[a], W = s.P[I[`${side}Hand`]];
	const E = deg ? add(S, apply(axisRot(sub(W, S), deg), sub(s.P[fa], S))) : s.P[fa];
	const worst = Math.max(segmentDepth(body, sk, s, a, S, E), segmentDepth(body, sk, s, fa, E, W));
	const k = side === "Left" ? "l" : "r", scene = boxes.length ? Math.max(sceneDepth(boxes, S, E, capR(sk, `uarm_${k}`)), sceneDepth(boxes, E, W, capR(sk, `farm_${k}`))) : 0;
	return { depth: worst, scene, rise: Math.max(0, E[1] - (S[1] - LOW)), under: S[1] - E[1] };
}

/** Shoulder to wrist at full stretch (m), at bind. */
const armLength = (sk, side) => { const I = sk.index, P = sk.restWorldPos; return len(sub(P[I[`${side}ForeArm`]], P[I[`${side}Arm`]])) + len(sub(P[I[`${side}Hand`]], P[I[`${side}ForeArm`]])); };

/** Absolute elbow turns (deg) for side k over the take, or null when no frame needs or has one. */
function planTurns(out, body, k) {
	const { sk } = out.ctx, side = SIDES[k], n = out.frames.length, now = out.ctx.swivel[k];
	const cost = out.frames.map(({ s, c }, i) => {
		const tw = turnWeight(c[`armw_${k}`] ?? 0), cur = (now.get(out.f0 + i) ?? 0) * tw;
		if (!cur && elbowDepth(body, sk, s, side, 0).depth <= ALLOW) return null;
		// only the boxes the arm can reach this frame (their bounding sphere within the arm's length of the shoulder)
		const S = s.P[sk.index[`${side}Arm`]], reach = armLength(sk, side) + 0.15;
		const boxes = Object.values(out.objectsAt(i)).filter(box => box.half && !box.ignore && len(sub(add(box.pos, apply(box.R, [0, box.half[1], 0])), S)) - len(box.half) < reach);
		const base = elbowDepth(body, sk, s, side, -cur, boxes).scene, wmin = wingMin(out, i, side);
		return TURNS.map(deg => {
			const { depth, scene, rise, under } = elbowDepth(body, sk, s, side, deg * tw - cur, boxes), cm = Math.max(0, depth - ALLOW) * 100;
			const wing = wmin === null ? 0 : Math.max(0, wmin - under);
			// a box the arm was already in at no turn is QA's COLLIDE to report, not this plan's to avoid
			const hit = Math.max(0, scene - Math.max(base, ALLOW)) * 100;
			return DEEP * (cm * cm + hit * hit) + TURN * (deg / 10) ** 2 + RISE * (rise * 100) ** 2 + WING_PRICE * (wing * 100) ** 2;
		});
	});
	if (cost.every(c => !c)) return null;
	// a frame that needs no turn has none; the take may start already turned
	const zero = TURNS.indexOf(0), still = TURNS.map((_, j) => (j === zero ? 0 : Infinity));
	let acc = TURNS.map(() => 0);
	const back = [];
	for (let i = 0; i < n; i++) {
		const here = cost[i] ?? still, prev = acc, from = [];
		acc = here.map((h, j) => {
			let best = Infinity, arg = zero;
			for (let p = 0; p < TURNS.length; p++) {
				if (Math.abs(TURNS[j] - TURNS[p]) > STEP_TURN) continue;
				const v = prev[p] + CHANGE * ((TURNS[j] - TURNS[p]) / 10) ** 2;
				if (v < best) { best = v; arg = p; }
			}
			from.push(arg);
			return best + h;
		});
		back.push(from);
	}
	const path = new Array(n);
	let j = acc.indexOf(Math.min(...acc));
	for (let i = n - 1; i >= 0; i--) { path[i] = TURNS[j]; j = back[i][j]; }
	// the 10-degree steps, smoothed
	return path.map((_, i) => (path[Math.max(0, i - 1)] + 2 * path[i] + path[Math.min(n - 1, i + 1)]) / 4);
}

/** Per-frame wrist pushes for side k: a hand or forearm a little inside the skin (not the head or neck) goes out along its normal. */
function handPushes(out, body, k, stats) {
	const { sk } = out.ctx, side = SIDES[k], I = sk.index, n = out.frames.length, v = new Array(n).fill(null);
	const face = [I.Head, I.Neck, I.HeadTop_End].filter(b => b !== undefined);
	for (let i = 0; i < n; i++) {
		const { s, c } = out.frames[i], f = out.f0 + i;
		// a hand on a measured target (a fit's anchor: the mouth, the flame) stays where its goal needs it; on its way
		// there the push fades out with the target's weight
		const free = 1 - fitWeight(out.ctx.spec, c, k);
		if (free < 0.05) continue;
		// past what the spec allows (a hand in a pocket touches the hip: checks.allow), as QA's BODY measures it
		let hit = null;
		for (const b of [I[`${side}Hand`], I[`${side}ForeArm`]]) {
			const h = limbDepth(body, sk, s, b);
			if (h.into < 0 || face.includes(h.into)) continue;
			const allowed = Math.min(TOUCH, allowance(out.ctx.spec.checks?.allow, regionOf(sk, b), regionOf(sk, h.into)) ?? 0), past = h.depth - Math.max(allowed, ALLOW);
			if (past > 0 && (!hit || past > hit.past)) hit = { ...h, b, past };
		}
		if (!hit) continue;
		if (!(c[`armw_${k}`] > 1e-4)) { stats.skipped++; continue; }
		const done = len(out.ctx.skinPush[k].get(f) ?? [0, 0, 0]);
		if (done >= REACH) { stats.deep++; continue; }
		const nrm = bodyNormal(body, s, hit.p, new Set([...body.skip.get(hit.b), ...face]));
		if (nrm) v[i] = scale(nrm, free * Math.min(STEP, REACH - done, hit.past + MARGIN));
	}
	// eased dilation: neighbours get the strongest nearby push, scaled down
	const eased = new Array(n).fill(null);
	v.forEach((p, i) => {
		if (!p) return;
		for (let j = Math.max(0, i - EASE - 1); j <= Math.min(n - 1, i + EASE + 1); j++) {
			const t = 1 - Math.abs(i - j) / (EASE + 1), w = scale(p, t * t * (3 - 2 * t));
			if (!eased[j] || len(w) > len(eased[j])) eased[j] = w;
		}
	});
	return eased;
}

export function selfClear(out, engine) {
	const body = bodyFor(out.ctx.sk);
	if (!body) return null;
	const n = out.frames.length, stats = { skipped: 0, deep: 0 }, turned = new Set(), pushed = new Set();
	let maxTurn = 0, maxPush = 0;
	for (let pass = 0; pass < PASSES; pass++) {
		let touched = new Set();
		for (const k of ["r", "l"]) {
			const plan = planTurns(out, body, k);
			if (!plan) continue;
			plan.forEach((deg, i) => {
				const f = out.f0 + i, cur = out.ctx.swivel[k].get(f) ?? 0, next = Math.abs(deg) < 0.5 ? 0 : deg;
				if (Math.abs(next - cur) < 0.5) return;
				if (next) out.ctx.swivel[k].set(f, next); else out.ctx.swivel[k].delete(f);
				maxTurn = Math.max(maxTurn, Math.abs(next)); if (next) turned.add(`${k}${i}`); touched.add(f);
			});
		}
		if (touched.size) engine.solve([...touched]);
		touched = new Set();
		stats.skipped = 0; stats.deep = 0;
		for (const k of ["r", "l"]) {
			handPushes(out, body, k, stats).forEach((p, i) => {
				if (!p) return;
				const f = out.f0 + i, next = add(out.ctx.skinPush[k].get(f) ?? [0, 0, 0], p);
				out.ctx.skinPush[k].set(f, next);
				maxPush = Math.max(maxPush, len(next)); pushed.add(`${k}${i}`); touched.add(f);
			});
		}
		if (!touched.size) break;
		engine.solve([...touched]);
	}
	// the pushes add up pass by pass from frames that read their normals apart: smoothed over time, so the hand
	// does not jerk (a 1-4-6-4-1 kernel, twice)
	if (pushed.size) {
		const touched = new Set();
		for (const k of ["r", "l"]) {
			const at = i => out.ctx.skinPush[k].get(out.f0 + i) ?? [0, 0, 0];
			for (let pass = 0; pass < 2; pass++) {
				const was = Array.from({ length: n }, (_, i) => at(i));
				was.forEach((_, i) => {
					const sm = [-2, -1, 0, 1, 2].reduce((acc, d, j) => add(acc, scale(was[Math.min(n - 1, Math.max(0, i + d))], [1, 4, 6, 4, 1][j] / 16)), [0, 0, 0]);
					if (len(sm) < 1e-5 && !out.ctx.skinPush[k].has(out.f0 + i)) return;
					out.ctx.skinPush[k].set(out.f0 + i, sm); touched.add(out.f0 + i);
				});
			}
		}
		if (touched.size) engine.solve([...touched]);
	}
	if (!turned.size && !pushed.size && !stats.skipped) return null;
	return { elbowFrames: turned.size, maxTurn: Math.round(maxTurn), handFrames: pushed.size, maxPush: round4(maxPush), skipped: stats.skipped, tooDeep: stats.deep,
		how: "elbow turned about the shoulder-wrist line; a hand a little inside pushed out along the skin" };
}

