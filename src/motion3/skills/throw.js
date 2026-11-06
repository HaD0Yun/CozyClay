// throwObject: the hand throws what it carries at a point (#816). From the pose at f0 the arm winds up behind the shoulder,
// swings forward and lets go, then follows through. The launch is closed form: the arc's launch angle (low LOW deg, high
// HIGH deg) and the speed that carries the object from where the hand lets it go to args.to under G (free-motion.js). The
// last frame before the release and the release frame put the wrist one frame's travel apart along that velocity, so the
// wrist moves at the launch velocity there; the fall the skill writes leaves at that velocity, { at: release, v } (flight.js).
// Not v: "hand": the hand's turn as the elbow opens adds a whip to the object (about 2 m/s at the release, so the throw
// carried 2 m long), which only the solved frames know; "hand" stays for an agent's own release. It writes the carry's release and fall (fills: fields the agent's own entry leaves out) and a goal: the
// object near args.to at its landing. A release with no fall stays where the hand let it go (C3), so the skill writes one.
import { add, sub, scale, apply, ry, len, norm, cross, axisRot } from "../compiler/math.js";
import { G } from "../free-motion.js";
import { skillError } from "./book.js";
import { GRASP_FINGERS } from "../compiler/vocab.js";

const LOW = 20, HIGH = 50, WIND = 10, SWING = 8, FOLLOW = 10, SETTLE_FRAMES = 8, TOL = 0.25;
// the wrist at the release: ahead of the shoulder along the throw and up; the thing held rides PALM m ahead of the wrist
const AHEAD = 0.42, UP = 0.22, PALM = 0.09, BACK = 0.12, SIDE = 0.25, LOWER = 0.4;
// the last frames before the release, back from it: their steps as shares of the launch step, and the turn per frame
const RAMP_STEPS = [1, 0.75, 0.5, 0.3], TURN = 25, WIDE = 0.12, REACH_SHARE = 0.95;
const DEFAULT_ELBOW = [0, -1, -0.3]; // pose.js, an arm with no elbow key
const r3 = v => v.map(x => Math.round(x * 1000) / 1000);

/** How far the root of scene body or group `id` sits above its lowest point at rest (m). */
function liftOf(scene, id) {
	const parts = Object.entries(scene?.objects ?? {}).filter(([k, e]) => k === id || e.ancestors?.includes(id)).map(([, e]) => e);
	const root = scene?.objects?.[id]?.pos ?? parts[0]?.ancestorPoses?.[0]?.pos;
	if (!root || !parts.length) return 0;
	return root[1] - Math.min(...parts.map(e => e.pos[1]));
}

/** Shoulder to wrist of the rig's `S` arm at rest (m). */
function armLength(sk, S) {
	const P = sk.restWorldPos, at = j => P[sk.index[`${S}${j}`]];
	return len(sub(at("ForeArm"), at("Arm"))) + len(sub(at("Hand"), at("ForeArm")));
}

/** Channel `ch` at frame f from the keys a skill sees (ctx.keys): linear between the keys either side, held past them. */
function keyedAt(keys, ch, f, fallback) {
	let lo = null, hi = null;
	for (const k of keys) {
		if (k.set?.[ch] === undefined) continue;
		if (k.f <= f && (!lo || k.f >= lo.f)) lo = k;
		if (k.f > f && (!hi || k.f < hi.f)) hi = k;
	}
	if (!lo && !hi) return fallback;
	if (!lo || !hi) return (lo ?? hi).set[ch];
	const t = (f - lo.f) / (hi.f - lo.f), a = lo.set[ch], b = hi.set[ch];
	return Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t;
}

export function throwObject(ctx) {
	const { args, state, sk, scene, tag } = ctx, id = args.object, k = args.side ?? "r", o = ctx.objects?.[id];
	if (k !== "l" && k !== "r") skillError(tag, `args.side must be "l" or "r", got ${JSON.stringify(k)}`);
	if (!o?.prop || ctx.props?.[o.prop]?.hand !== k) skillError(tag, `args.object "${id}" must be carried by the ${k === "r" ? "right" : "left"} hand (objects.${id}.prop on a prop with hand "${k}")`);
	if (!Array.isArray(args.to) || args.to.length !== 3) skillError(tag, "args.to must be [x, y, z] world m (where it lands)");
	const theta = ((args.arc === "high" ? HIGH : LOW) * Math.PI) / 180, fps = ctx.fps ?? 24, S = k === "l" ? "Left" : "Right";
	// the shoulder where the body stands at frame f (the bind pose's offset from the hips, turned by the keyed yaw, on the
	// keyed root): every hand point is placed off it at its own frame. Placed off the shoulder at f0 only, a body that
	// turned and strode after f0 left the plan behind it and the arm caught up in one frame, releasing the ball over the
	// head (A/B baseball runs: 25-41 cm above it, the wrist 2.3-2.7 -> 9.8-12.7 m/s in a frame)
	const P = sk.restWorldPos, off = sub(P[sk.index[`${S}Arm`]], P[sk.index.Hips]), seen = ctx.keys ?? [];
	const shoulderAt = f => add(keyedAt(seen, "root", f, state.root ?? P[sk.index.Hips]), apply(ry(keyedAt(seen, "yaw", f, state.yaw ?? 0)), off));
	const release = ctx.f0 + WIND + SWING, shoulder = shoulderAt(release);
	const flat = [args.to[0] - shoulder[0], 0, args.to[2] - shoulder[2]], dist = len(flat);
	if (dist < 0.5) skillError(tag, `args.to is ${dist.toFixed(2)} m from the shoulder; throw it at least 0.5 m`);
	const dir = scale(flat, 1 / dist), out = scale([dir[2], 0, -dir[0]], k === "r" ? -1 : 1);
	// out on the hand's side of the shoulder: over it, the swing up to the release passed the hand through the head (QA BODY)
	const wrist = add(shoulder, add(add(scale(dir, AHEAD), scale(out, WIDE)), [0, UP, 0])), from = add(wrist, scale(dir, PALM));
	const land = args.to[1] + liftOf(scene, id), d = len([args.to[0] - from[0], 0, args.to[2] - from[2]]), dy = land - from[1];
	const den = 2 * Math.cos(theta) ** 2 * (d * Math.tan(theta) - dy);
	if (!(den > 0)) skillError(tag, `args.to is too high for a ${args.arc ?? "low"} arc from the hand; use arc "high" or a lower point`);
	const speed = Math.sqrt((G * d * d) / den), v = add(scale(dir, speed * Math.cos(theta)), [0, speed * Math.sin(theta), 0]);
	const flight = (v[1] + Math.sqrt(v[1] ** 2 + 2 * G * Math.max(0, from[1] - land))) / G;
	const landed = Math.min(ctx.frames - 1, release + Math.ceil(flight * fps) + SETTLE_FRAMES);
	// the wind-up goes back out on the hand's side (not behind the back), the follow-through on down across the body
	const hand = `hand_${k}`, armw = `armw_${k}`, elbow = `elbow_${k}`;
	// the elbow out on the hand's side (body frame, +x the left) from the wind-up to the release: on the default pole (down and
	// back) the elbow swung forward under the arm as the hand came over, and its bend plane turned 74 deg in a frame (QA FLIP)
	const sx = k === "r" ? -1 : 1, outPole = [sx, -0.2, -0.3], downPole = [sx * 0.5, -1, -0.3];
	const at = (f, local) => add(shoulderAt(f), local);
	const wind = at(ctx.f0 + WIND, add(add(scale(dir, -BACK), scale(out, SIDE)), [0, -0.05, 0]));
	// the swing builds up to the launch speed over the RAMP frames before the release instead of one. The ramp is built off
	// the shoulder: going back from the release, each frame's step is RAMP_STEPS of the hand's launch step against the
	// shoulder ((v - the shoulder's own velocity) / fps), turned up and back over the shoulder by TURN deg a frame, so the
	// wrist leaves at v in the world. Built in the world, a body that strode and turned into the throw left the early
	// ramp keys 0.77 m behind the shoulder (out of reach, QA REACH) and the last step 0.54 m long (13 m/s in one frame).
	// A ramp point past REACH_SHARE of the arm is drawn in to it.
	const axis = norm(cross([0, 1, 0], dir)), swing = [], reach = REACH_SHARE * armLength(sk, S);
	const vrel = sub(v, scale(sub(shoulder, shoulderAt(release - 1)), fps)), vrelHat = norm(vrel), relSpeed = len(vrel);
	let pt = sub(wrist, shoulder);
	RAMP_STEPS.forEach((share, i) => {
		pt = sub(pt, scale(apply(axisRot(axis, TURN * i), vrelHat), (share * relSpeed) / fps));
		swing.push({ f: release - 1 - i, p: len(pt) > reach ? scale(pt, reach / len(pt)) : pt });
	});
	// after the release it slows over three frames, going on and down, then crosses low in front
	const on = add(wrist, scale(v, 0.45 / fps)), through = at(release + 3, add(scale(dir, 0.46), [0, -0.1, 0])), follow = at(release + FOLLOW, add(add(scale(dir, 0.3), scale(out, -0.15)), [0, -LOWER, 0]));
	// the hand keeps its grip on the thing through the swing and opens as it lets go
	const fg = `fingers_${k}`, preset = GRASP_FINGERS[o.grasp] ?? "grip", grip = { ...state[fg], [preset]: 1 }, open = { ...state[fg], [preset]: 0 };
	const keys = [
		// the elbow pole as it stands at f0 (the compiler's default when unkeyed): a first elbow key at the wind-up is held
		// back to frame 0 and turned the elbow of the reach and grab before the throw (A/B baseball t4b1: 14 cm at f15)
		{ f: ctx.f0, set: { [armw]: state[armw] ?? 0, [fg]: grip, [elbow]: state[elbow] ?? DEFAULT_ELBOW, ...(state[hand] ? { [hand]: state[hand] } : {}) } },
		{ f: release, set: { [fg]: grip } }, { f: release + 3, set: { [fg]: open } },
		{ f: ctx.f0 + WIND, set: { [armw]: 1, [hand]: r3(wind), [elbow]: outPole } },
		...swing.map(({ f, p }) => ({ f, set: { [armw]: 1, [hand]: r3(at(f, p)) } })),
		{ f: release, set: { [armw]: 1, [hand]: r3(wrist), [elbow]: outPole } },
		{ f: release + 1, set: { [armw]: 1, [hand]: r3(on) } },
		{ f: release + 3, set: { [armw]: 1, [hand]: r3(through) } },
		{ f: release + FOLLOW, set: { [armw]: 1, [hand]: r3(follow), [elbow]: downPole } },
	];
	const target = `${id}Target`;
	return {
		keys, end: release + FOLLOW, anchors: { [target]: { kind: "world", p: r3([args.to[0], land, args.to[2]]) } },
		fills: { [id]: { release, fall: { at: release, v: r3(v) } } },
		goals: [{ name: `${id} lands at the target`, near: [`object:${id}`, `anchor:${target}`], at: landed, tol: TOL }],
		throw: { release, speed: Math.round(speed * 100) / 100, v: r3(v), flight: Math.round(flight * 100) / 100 },
	};
}
