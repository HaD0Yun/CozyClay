// Motion spec -> baked frames. Deterministic and pure: the same spec and scene give the same
// frames, so the agent can edit keys and recompile in a loop.
//
// spec = { schema: "cozyclay.motion-spec.v1", fps, frames, keys, anchors, props, fits, objects, generators, checks }
//   keys:       [{ f, set: { channel: value }, step?: [channel] }]   (see pose.js for channel names)
//   hand mix:   hand_<l|r> (world point) blended with w_<anchor>_<l|r> weights (anchors.js)
//   fits:       [{ side, anchor, effector: { prop, point } | { joints: [...] }, offset? }]
//               moves the wrist so the effector lands on the anchor whenever that weight is on
//   objects:    { id: { pivot: [x,y,z], axis: [x,y,z], channel: "door" } }  hinge angle in degrees
//               { id: { prop, grab?, release?, at?, along?, visible?, keys? } }   carried (../object-pose.js);
//               keys lead the holding hand (../object-keys.js, hold.js)
//               { id: { visible?, level? } }   a switch: shown/hidden and dimmed, never moved (C15)
//               { id: { follow, offset?, aim?, visible?, level? } }   rides a point of the body (C16, ../follow.js)
//               { id: { keys?, fall?, visible?, level? } }   moves on its own: keys and gravity falls (C17, ../free-motion.js)
//               id is a body or a group (Empty); a group moves every body under it
//   generators: [{ type: "walk", f0, ... }]  (walk.js)
//   fix:        { reach, slide, penetration, retime }  deterministic auto-fixes (../fix/)
//   flow:       { smooth, lag } | false  the body's swing carries through keys and trails (channels.js)
//   idle:       false turns off the idle layer (idle.js: a held pose breathes, drifts its head, shifts its weight)
// ctx = { sk, scene: { objects: { id: { pos, R, half, ancestors } } } }; out.ctx.scene keeps the scene (object-pose.js)
import { add, sub, scale, norm, len, dot, apply, axisRot } from "./math.js";
import { isCarried, isFollow, hingePose, movesRecord, compose, relative } from "../carried.js";
import { isFree, freeSwungAt } from "../free-motion.js";
import { groupsOf } from "../scene.js";
import { pose, SIDES } from "./pose.js";
import { graspAnchor } from "./socket-grip.js";
import { gripHand } from "./grip.js";
import { bakeChannels, channelsAt, flowOptions } from "./channels.js";
import { handBusy } from "./overlap.js";
import { idleLayer, withIdle, busyHands } from "./idle.js";
import { resolveAnchor, measureProps, armReach } from "./anchors.js";
import { expandGenerators } from "./walk.js";
import { steadyHead } from "./head-steady.js";
import { leadHead } from "./head-lead.js";
import { autoLayer } from "./auto.js";
import { fixOptions, applyFixes } from "../fix/index.js";
import { fitWeight } from "../fix/self.js";
import { holdHook } from "../object-keys.js";
import { HAND_CLEAR, keepOut, wristBody } from "../body.js";
import { objectPoseAt, handOf, restingAt, frameAt, spanOf } from "../object-pose.js";
import { heldFor, carryFingers } from "./finger-close.js";
import { sagOf } from "../load.js";

const smooth = x => x * x * (3 - 2 * x);
// how far past the straight arm a grasp fit's wrist target may end before it counts as wound up (solveFrame), m
const REACH_SLACK = 0.02;

/**
 * Scene boxes by frame. A body moves with its own spec.objects entry or its nearest group's (a
 * switch entry moves nothing; hinge: turned; free (C17): where its keys and falls put it, under the time map `mapOf()`, swung by its spring;
 * carry and follow: left at its scene pose and marked `carried` with the moving id). `obstacles` drops the carried
 * ones: QA, refs and object anchors read a carry where it rides (object-pose.js objectPoseAt, qa/object-checks.js);
 * a follow entry rides the body and is no obstacle.
 */
function objectTracks(spec, scene, baked, mapOf = () => undefined) {
	const cache = new Map(), kept = new Map();
	let map = mapOf();
	const all = f => {
		// a retime maps free keys and falls too: frames read before it are read again
		if (mapOf() !== map) { map = mapOf(); cache.clear(); kept.clear(); }
		if (cache.has(f)) return cache.get(f);
		const out = {};
		for (const [id, o] of Object.entries(scene?.objects ?? {})) {
			const mover = [id, ...(o.ancestors ?? [])].find(k => movesRecord(spec.objects?.[k])), entry = spec.objects?.[mover];
			if (!entry) out[id] = o;
			else if (isCarried(entry) || isFollow(entry)) out[id] = { ...o, carried: mover };
			else if (isFree(entry)) out[id] = { ...o, ...compose(freeSwungAt({ spec, scene, timeMap: map }, mover, f), relative(scene.objects[mover] ?? groupsOf(scene)[mover], o)) };
			else out[id] = { ...o, ...hingePose(entry, o, baked, f) };
		}
		cache.set(f, out);
		return out;
	};
	const obstacles = f => {
		if (mapOf() !== map) all(f);
		if (!kept.has(f)) kept.set(f, Object.fromEntries(Object.entries(all(f)).filter(([, box]) => !box.carried)));
		return kept.get(f);
	};
	return { all, obstacles };
}

function effectorPoint(sk, s, diag, eff) {
	if (eff.prop) return diag.props?.[eff.prop]?.[eff.point];
	const js = eff.joints ?? ["RightHandIndex2", "RightHandMiddle2"];
	return scale(js.map(j => s.P[sk.index[j]]).reduce((a, p) => add(a, p), [0, 0, 0]), 1 / js.length);
}

/** `lead` false solves without the object keys; a fit's own hand is solved without them (the keys override it). */
function hooksFor(ctx, c, f, inFit = false, lead = true, fitSide = null) {
	const { sk } = ctx;
	return {
		softReach: ctx.softReach,
		// a fit's passes find where the wrist must go with the elbow unstopped; the final pose stops its fold (limbs.js) and leaves the residual
		foldFree: inFit,
		hold: lead && ctx.hold ? (k, s) => (k === fitSide ? null : ctx.hold.lead(k, f, s, c)) : undefined,
		// auto-fix offsets ride on the final pose only, so a fit never cancels them
		push: inFit ? undefined : k => ctx.push?.[k]?.get(f),
		swivel: k => ctx.swivel?.[k]?.get(f), // in a fit's passes too: a turn that stops at the wrist's limit moves the fit's point (wrist-clamp.js)
		skinPush: inFit ? undefined : k => ctx.skinPush?.[k]?.get(f),
		handTarget(k, s, diag) {
			diag.frame = f;
			const fkHand = s.P[sk.index[k === "l" ? "LeftHand" : "RightHand"]];
			const terms = [];
			for (const [ch, w] of Object.entries(c)) {
				const m = /^w_(.+)_([lr])$/.exec(ch);
				if (!m || m[2] !== k || !(w > 1e-6)) continue;
				terms.push([w, add(resolveAnchor(ctx, m[1], s, diag, c, k), c[`fit_${m[1]}_${k}`] ?? [0, 0, 0])]);
			}
			let tot = terms.reduce((a, [w]) => a + w, 0);
			if (tot > 1) { for (const t of terms) t[0] /= tot; tot = 1; }
			let target = scale(c[`hand_${k}`] ?? fkHand, 1 - tot);
			for (const [w, p] of terms) target = add(target, scale(p, w));
			// Between targets, arc around the torso instead of cutting through it.
			const trans = Math.max(0, ...terms.map(([w]) => smooth(Math.min(1, Math.min(w, 1 - w) * 3))));
			if (trans > 0) {
				const a = s.P[sk.index.Spine], b = s.P[sk.index.Neck], u = sub(b, a);
				const t = Math.min(1, Math.max(0, dot(sub(target, a), u) / dot(u, u))), q = add(a, scale(u, t));
				const r = ctx.spec.detourRadius ?? 0.25, dv = sub(target, q), d = len(dv);
				if (d < r) {
					const fwd = apply(axisRot([0, 1, 0], c.yaw ?? 0), [0, 0, 1]);
					const dir = norm(add(d > 1e-6 ? scale(dv, 1 / d) : fwd, scale(fwd, 0.6)));
					target = add(target, scale(sub(add(q, scale(dir, r)), target), trans));
				}
			}
			// a wrist target inside the body (a pocket on a squatting thigh, a path through the chest) goes out onto its skin
			return target;
		},
		// the wrist target, blended with the FK hand, inside the body goes out onto its skin, twice at most (out of
		// one bone, then the next): a pocket the squat moved into the thigh, a path through the chest, a hand leaving
		// a thigh for its FK rest. A measured target (a fit's anchor: the mouth; or a prop another hand's fit is on:
		// the cigarette under the flame) stays where its goal needs it, and the move fades in and out with its weight;
		// an arm coming in from FK moves it no more than its IK weight.
		keepOut: ctx.keepOut && !inFit ? (k, s, target) => {
			const free = (1 - fitWeight(ctx.spec, c, k)) * Math.min(1, Math.max(0, c[`armw_${k}`] ?? 0));
			for (let i = 0; i < 2 && free > 1e-3; i++) {
				const moved = keepOut(ctx.keepOut.body, sk, s, target, HAND_CLEAR, ctx.keepOut.skip);
				if (moved === target) break;
				target = add(target, scale(sub(moved, target), free));
			}
			return target;
		} : undefined,
		afterArm: (k, s, diag) => measureProps(ctx, k, s, diag),
		// a fit's passes only place the wrist; the final pose (and a plain one) turns the hand onto the body
		grip: inFit ? undefined : (k, s, diag) => gripHand(ctx, sk, s, SIDES[k], k, c, f, diag),
		// a carry's weight lowers a plain IK hand's target, on the final pose only (load.js)
		sag: inFit ? undefined : (k, s, target) => sagOf(ctx, k, f, s, target, (1 - fitWeight(ctx.spec, c, k)) * Math.min(1, Math.max(0, c[`armw_${k}`] ?? 0))),
		// fingers close on what the hand holds, on the final pose only (finger-close.js)
		heldShapes: inFit || !ctx.grasp ? undefined : (k, s) => heldFor(ctx, c, f, k, s),
		fingerWeights: inFit || !ctx.grasp ? undefined : k => carryFingers(ctx, c, f, k),
	};
}

/** One frame with every active fit solved (fits run in spec order); lead false leaves the object keys out. */
export function solveFrame(ctx, c0, f, lead = true) {
	const c = { ...withIdle(c0, ctx.idle, f) };
	// a working hand keeps its forearm's slant (pose.js arm_hang)
	for (const k of ["l", "r"]) if (ctx.busy?.[k]) c[`hangoff_${k}`] = ctx.busy[k][f];
	for (const fit of ctx.spec.fits ?? []) {
		const wch = `w_${fit.anchor}_${fit.side}`;
		if (!(c[wch] > 1e-4)) continue;
		const full = { ...c, [wch]: 1, [`armw_${fit.side}`]: 1 };
		for (const ch of Object.keys(full)) if (ch !== wch && new RegExp(`^w_.+_${fit.side}$`).test(ch)) full[ch] = 0;
		// each pass adds what the effector still misses; an arm at full reach misses the same each pass, so on a grasp's fit
		// the sum wound the wrist target far past the anchor (session 7f15b4ae: 0.6 m, read back as REACH 0.845 m on a cup a
		// few cm out of reach). A grasp fit whose wrist target ends past the straight arm (REACH_SLACK) aims instead at the
		// anchor by the hand's own wrist-to-effector offset of its best pass: the arm reaches straight for it and its
		// residual (REACH) is what the effector misses. Other fits keep their passes as they were (their takes are pinned).
		let corr = [0, 0, 0], best = null, last = null;
		const grasp = graspAnchor(ctx.spec, fit.anchor), shoulder = ctx.sk.index[`${SIDES[fit.side]}Arm`], wristAt = ctx.sk.index[`${SIDES[fit.side]}Hand`];
		for (let i = 0; i < 6; i++) {
			full[`fit_${fit.anchor}_${fit.side}`] = corr;
			const { s, diag } = pose(ctx.sk, full, hooksFor(ctx, full, f, true, lead, fit.side));
			const eff = effectorPoint(ctx.sk, s, diag, fit.effector);
			const goal = add(resolveAnchor(ctx, fit.anchor, s, diag, full, fit.side), fit.offset ?? [0, 0, 0]);
			if (!eff) break;
			const miss = sub(goal, eff), err = len(miss);
			if (grasp && (!best || err < best.err)) best = { err, hand: sub(s.P[wristAt], eff) };
			last = { goal, shoulder: s.P[shoulder] };
			corr = add(corr, miss);
		}
		if (grasp && best && last && len(sub(add(last.goal, corr), last.shoulder)) > armReach(ctx.sk, fit.side) + REACH_SLACK) corr = best.hand;
		c[`fit_${fit.anchor}_${fit.side}`] = corr;
	}
	const { s, diag } = pose(ctx.sk, c, hooksFor(ctx, c, f, false, lead));
	// readers of the solved frame (refs, checks, hints) resolve its anchors at f, IK arms or not
	diag.frame = f;
	return { s, diag, c };
}

/**
 * opts.window = [a, b] solves only frames a..b (out.f0 = a, out.frames[i] is frame a + i);
 * opts.keys replaces the generator expansion; opts.fixes = false skips the auto-fix pass; opts.selfRepair = false runs
 * fix.self without its repair pass (fix/self-repair.js), the take that pass starts from.
 */
export function compileMotion(spec, { sk, scene }, opts = {}) {
	if (spec?.schema !== "cozyclay.motion-spec.v1") throw new Error("MOTION_SPEC_INVALID: schema must be cozyclay.motion-spec.v1");
	const frameCount = Math.round(spec.frames);
	if (!(frameCount >= 1 && frameCount <= 20000)) throw new Error("MOTION_SPEC_INVALID: frames must be 1..20000");
	const fix = fixOptions(spec.fix);
	const [a, b] = opts.window ? [Math.max(0, opts.window[0]), Math.min(frameCount - 1, opts.window[1])] : [0, frameCount - 1];
	const ctx = { sk, spec, scene, grasp: fix.grasp, softReach: fix.reach, push: { l: new Map(), r: new Map() }, swivel: { l: new Map(), r: new Map() }, skinPush: { l: new Map(), r: new Map() }, keepOut: fix.self ? wristBody(sk) : null };
	const out = { ctx, fps: spec.fps ?? 30, frameCount, f0: a, frames: [] };
	// object anchors read the pose refs read (object-pose.js), on the frame being solved
	ctx.objectPose = (id, f, now) => objectPoseAt(out, id, f, now);
	ctx.objectHand = (id, f) => handOf(out, id, f);
	// a keyed carry's grab offset is taken where it rests at grab (object-keys.js; a fall before grab: where it landed)
	ctx.restingAt = (id, f) => restingAt(out, id, f);
	// a prop anchor outside its hand's carry reads the carry's grab (release) frame (anchors.js propOnCarry)
	ctx.carrySpan = o => spanOf(out, o);
	ctx.solvedAt = f => frameAt(out, f);
	// a reach's grasp is planned on its first full-weight frame (socket-grip.js plannedGrasp)
	ctx.weightAt = (ch, f) => out.baked?.[ch]?.[f];
	ctx.frameCount = frameCount;
	const engine = {
		rebake(keys) {
			out.keys = keys;
			const flow = flowOptions(spec.flow, spec.label ?? "", handBusy(spec));
			out.baked = bakeChannels(keys, frameCount, flow);
			ctx.socketTurns = new Map();
			ctx.graspPlans = new Map();
			steadyHead(out.baked, keys, frameCount);
			leadHead(out.baked, keys, frameCount, flow.headLead);
			ctx.busy = busyHands(out.baked, spec, frameCount, out.fps);
			const tracks = objectTracks(spec, scene, out.baked, () => out.timeMap);
			ctx.objectsAt = tracks.all;
			// the walk's rules outside the walk and the gaze to spec.look (auto.js, #1080 #1081): before the idle layer reads the holds
			out.auto = autoLayer(out, ctx);
			// a held pose breathes and shifts its weight (idle.js): offsets solveFrame adds, contacts and out.baked stay as keyed
			ctx.idle = idleLayer(out.baked, { spec, sk, frameCount });
			out.objectsAt = a ? f => tracks.obstacles(f + a) : tracks.obstacles;
		},
		solve(frames) { for (const f of frames) if (f >= a && f <= b) out.frames[f - a] = solveFrame(ctx, channelsAt(out.baked, f), f); },
		all: () => Array.from({ length: b - a + 1 }, (_, i) => a + i),
	};
	ctx.hold = holdHook(ctx, out, f => solveFrame(ctx, channelsAt(out.baked, f), f, false), f => solveFrame(ctx, channelsAt(out.baked, f), f));
	engine.rebake(opts.keys ?? expandGenerators(spec, sk));
	engine.solve(engine.all());
	out.fixed = opts.fixes === false ? {} : applyFixes(out, fix, engine, { whole: !opts.window, repair: opts.selfRepair !== false });
	// a retime maps the key frames only once it is done: solve the keyed frames again on the final map
	if (ctx.hold && out.timeMap) engine.solve(engine.all());
	return out;
}
