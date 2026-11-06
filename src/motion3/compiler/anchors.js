// Hand-target anchors and hand-held props for the motion3 compiler.
//
// spec.anchors = { name: anchor }, an anchor being one of
//   { kind: "world",    p: [x,y,z] }                        fixed world point (m)
//   { kind: "body",     p: [x,y,z] }                        root-relative, rotated by root yaw
//   { kind: "bone",     bone: "LeftLeg", offset: [x,y,z] }  world offset from a bone joint
//   { kind: "segment",  from: "LeftUpLeg", to: "LeftLeg", t: 0.4, offset: [x,y,z], reach: "l" }
//                       point along a segment; with reach, slides toward `from` until the arm reaches
//   { kind: "object",   object: "Car_Door_L", local: [x,y,z] }  point fixed to a scene object or group where it is at
//                       that frame (hinged, carried, following; object-pose.js objectPoseAt), in its own axes
//   { kind: "landmark", name: "mouth" }                     measured face landmark on the Head bone
//   { kind: "prop",     prop: "cig", point: "tip", offset: [x,y,z] }  a point on a prop held by the other hand; while
//                       that hand does not hold the object it carries, the point stays on that object (propOnCarry)
//   { kind: "person",   person: "char-b", bone: "LeftArm", offset: [x,y,z] }  world offset from another character's joint
//                       where its installed take has it at that frame (people.js)
// spec.props = { name: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"],
//                        points: { name: [d, l, n] } } }   offsets along the palm axes (m)
import { add, sub, scale, len, dot, norm, apply, ry, T } from "./math.js";
import { bonePoint } from "./skeleton.js";
import { palmAxes } from "./limbs.js";
import { supportAt } from "./support-hold.js";
import { SIDES } from "./pose.js";
import { HAND_CLEAR, keepOut } from "../body.js";
import { groupsOf } from "../scene.js";
import { personJoint, peopleList } from "../people.js";
import { isCarried } from "../carried.js";
import { socketsOf, socketNamed, socketWorld, socketDistance, faceFrom, rimPoint } from "../sockets.js";
import { partsOf } from "../object-pose.js";
import { GRASP_POINTS } from "./vocab.js";

/** Shoulder to wrist with the arm straight (rest bone lengths), m. */
export function armReach(sk, k) {
	const side = SIDES[k], P = sk.restWorldPos, I = sk.index;
	return len(sub(P[I[`${side}ForeArm`]], P[I[`${side}Arm`]])) + len(sub(P[I[`${side}Hand`]], P[I[`${side}ForeArm`]]));
}

/** Resolve a named anchor to a world point for the current (partial) frame state. */
/** Anchors placed off the root (a pocket): with fix.self (ctx.keepOut, compile.js) a point the pose put inside
 * the skin resolves onto it, HAND_CLEAR off, for the hand and for every check alike. A bone's or a segment's
 * anchor is the spec's own place on that limb (a hand resting on a thigh) and stays. */
const ON_BODY = new Set(["body"]);
/** side: the hand ("l" | "r") this point is a target for while the compiler solves it; none for a reader of a solved frame. */
export function resolveAnchor(ctx, name, s, diag, c, side) {
	const a = ctx.spec.anchors?.[name];
	if (!a) throw new Error(`MOTION_SPEC_INVALID: unknown anchor "${name}"`);
	const p = anchorPoint(ctx, a, name, s, diag, c, side), skin = ON_BODY.has(a.kind) && ctx.keepOut;
	return skin ? keepOut(skin.body, ctx.sk, s, keepOut(skin.body, ctx.sk, s, p, HAND_CLEAR, skin.skip), HAND_CLEAR, skin.skip) : p;
}

// pose.js solves the right arm, then the left
const ARMS = ["r", "l"], HAND = { l: "left", r: "right" };

/**
 * The pose { pos, R } an object anchor's `local` is in at frame diag.frame: where the object is then (ctx.objectPose,
 * the pose refs and probes read). A hand cannot aim at what rides on it: the hand that carries the object keeps the
 * scene pose, where it took it. While the right arm is solved the left is not, so the right hand cannot aim at what
 * the left carries (refused).
 */
export function objectFrame(ctx, a, name, { s, diag, c }, side) {
	const f = diag.frame, still = () => ctx.restingAt?.(a.object, f) ?? ctx.objectsAt(f)[a.object] ?? groupsOf(ctx.scene)[a.object];
	const hand = ctx.objectPose && f !== undefined ? ctx.objectHand(a.object, f) : null;
	if (side && hand && ARMS.indexOf(hand) > ARMS.indexOf(side)) throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" is on "${a.object}", which the ${HAND[hand]} hand holds at f${f}; the right arm is solved before the left, so the right hand cannot follow it. Carry "${a.object}" in the right hand (a right-hand prop) and put the left hand on it, or give the right hand another anchor`);
	const pose = !ctx.objectPose || f === undefined || hand === side ? still() : nested(ctx, name, a.object, f, () => ctx.objectPose(a.object, f, { s, diag, c }));
	if (!pose) throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" names unknown object "${a.object}"`);
	return pose;
}

// Reading an object may solve another frame (a keyed carry's grab offset, object-keys.js), whose hands read objects
// again; legitimate reads nest a few deep, so a deeper chain is a loop and is refused instead of overflowing the stack.
const MAX_NEST = 16;
function nested(ctx, name, object, f, read) {
	if ((ctx.nest ?? 0) >= MAX_NEST) throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" on "${object}" at f${f} reads a pose that needs this frame solved again (an anchor and carry loop); anchor the hand on a point that does not ride on the hand it moves`);
	ctx.nest = (ctx.nest ?? 0) + 1;
	try { return read(); } finally { ctx.nest--; }
}

function anchorPoint(ctx, a, name, s, diag, c, side) {
	const { sk } = ctx, I = sk.index;
	switch (a.kind) {
		case "world": return a.p.slice();
		case "body": return add(c.root ?? s.P[I.Hips], apply(ry(c.yaw ?? 0), a.p));
		case "bone": return add(s.P[I[a.bone]], a.offset ?? [0, 0, 0]);
		case "segment": {
			const A = s.P[I[a.from]], B = s.P[I[a.to]], off = a.offset ?? [0, 0, 0];
			const at = t => add(add(A, scale(sub(B, A), t)), off);
			if (!a.reach) return at(a.t ?? 0.5);
			const sh = s.P[I[`${SIDES[a.reach]}Arm`]], r = 0.95 * armReach(sk, a.reach);
			for (let t = a.t ?? 0.45; t >= (a.tMin ?? 0.15); t -= 0.01) if (len(sub(at(t), sh)) <= r) return at(t);
			return at(a.tMin ?? 0.15);
		}
		case "object": {
			if (a.grasp && a.local === undefined) return anchorSocket(ctx, name, s, diag, c, side).p;
			const o = objectFrame(ctx, a, name, { s, diag, c }, side);
			return add(o.pos, apply(o.R, a.local ?? [0, 0, 0]));
		}
		case "landmark": return bonePoint(s, I.Head, sk.landmarks[a.name] ?? (() => { throw new Error(`MOTION_SPEC_INVALID: unknown landmark "${a.name}"`); })());
		case "prop": {
			const p = propOnCarry(ctx, a, name, diag?.frame) ?? diag.props?.[a.prop]?.[a.point];
			if (!p) throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" needs prop ${a.prop}.${a.point}, which is held by an arm solved later`);
			return add(p, a.offset ?? [0, 0, 0]);
		}
		case "person": {
			const p = personJoint(ctx.scene, a.person, a.bone, diag?.frame ?? 0);
			if (!p) throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" names person "${a.person}" bone "${a.bone}", which the scene does not have (people: ${peopleList(ctx.scene)})`);
			return add(p, a.offset ?? [0, 0, 0]);
		}
		default: throw new Error(`MOTION_SPEC_INVALID: anchor "${name}" has unknown kind "${a.kind}"`);
	}
}

/**
 * A point of a prop on a hand that carries an object, at a frame that hand does not hold it: where the point sits on
 * the object at the grab (or the release) nearest in time, carried with the object (at rest before the grab, let go
 * after the release). In hand the point rides the palm; before the grab the palm still turns into its grip (and after
 * the release out of it), and a point held off it swept through the other arm's reach: session 02263581's barbell put
 * the left hand on a point 55 cm off the right palm, and the left elbow jumped 28 cm in a frame at the grab and the
 * release. Read off the object, the point is where the left hand takes the bar, and meets the palm's at the grab. null
 * when no carry of that hand applies (the palm's point is used).
 */
function propOnCarry(ctx, a, name, f) {
	const hand = ctx.spec.props?.[a.prop]?.hand;
	if (!hand || f === undefined || !ctx.solvedAt || !ctx.carrySpan) return null;
	let pick = null;
	for (const [id, o] of Object.entries(ctx.spec.objects ?? {})) {
		if (!isCarried(o) || ctx.spec.props?.[o.prop]?.hand !== hand) continue;
		const [grab, release] = ctx.carrySpan(o);
		if (f >= grab && f <= release) return null;
		const at = f < grab ? grab : release;
		if (!pick || Math.abs(f - at) < Math.abs(f - pick.at)) pick = { id, at };
	}
	if (!pick) return null;
	const there = nested(ctx, name, pick.id, pick.at, () => ctx.solvedAt(pick.at).diag.props?.[a.prop]?.[a.point]);
	const was = ctx.objectPose(pick.id, pick.at), now = ctx.objectPose(pick.id, f);
	return there && was && now ? add(now.pos, apply(now.R, apply(T(was.R), sub(there, was.pos)))) : null;
}

/**
 * The socket (../sockets.js) an object anchor with `grasp` takes the hand by, in world space on its object's pose that
 * frame: { p, axis?, from?, thumb? }, p the anchor's point (its `local` when it has one). Its `socket`, else the one
 * nearest its `local` point or, without one, nearest the shoulder of the hand: picked once per compile (ctx.sockets),
 * so the hand does not hop between sockets. An object with no socket gives the bare point: the palm faces it.
 */
export function anchorSocket(ctx, name, s, diag, c, side) {
	const a = ctx.spec.anchors[name], now = { s, diag, c }, poseOf = id => objectFrame(ctx, { ...a, object: id }, name, now, side);
	if (a.grasp === "support" && ctx.scene?.objects?.[a.object]?.half) {
		return supportAt(ctx, name, a, s, diag, side, (id, frame) => objectFrame(ctx, { ...a, object: id }, name, { s, diag: { ...diag, frame }, c }, side), c);
	}
	const local = a.local && (o => add(o.pos, apply(o.R, a.local)))(poseOf(a.object));
	ctx.sockets ??= new Map();
	if (!ctx.sockets.has(name)) {
		const all = socketsOf(ctx.scene, a.object), I = ctx.sk.index, near = local ?? s.P[I[side ? `${SIDES[side]}Arm` : "Hips"]];
		const pick = a.socket ? socketNamed(ctx.scene, a.object, a.socket) : all.map(k => ({ k, d: socketDistance(socketWorld(k, poseOf(k.owner)), near) })).sort((x, y) => x.d - y.d)[0]?.k;
		ctx.sockets.set(name, pick ?? null);
	}
	const sock = ctx.sockets.get(name);
	let w = sock ? socketWorld(sock, poseOf(sock.owner)) : { p: local ?? poseOf(a.object).pos };
	if (sock?.rim) w = rimHold(ctx, name, side, sock, poseOf(sock.owner), w, local ?? s.P[ctx.sk.index[side ? `${SIDES[side]}Arm` : "Hips"]]);
	else if (local) w.p = local;
	// a thick body (a cup) holds its axis further off the finger middles than the grasp's point does (vocab.js GRASP_POINTS,
	// 2 cm on a power grip): the point moves out from the axis toward the hand's shoulder by the difference, so the fingers
	// close on the surface instead of being asked into the body (session 7f15b4ae: a 4 cm cup, fingers asked 2 cm inside)
	else if (w.axis && w.radius > 0) {
		const inset = Math.abs(GRASP_POINTS[a.grasp]?.[2] ?? 0), out = w.radius - inset, sh = s.P[ctx.sk.index[`${SIDES[side] ?? "Right"}Arm`]];
		const v = sub(sh, w.p), across = sub(v, scale(w.axis, dot(v, w.axis)));
		if (out > 1e-4 && len(across) > 1e-6) w.p = add(w.p, scale(norm(across), out));
	}
	// a socket with neither an axis nor a side (a box, a wall): the palm faces against the face of the body nearest the point
	if (!w.axis && !w.from) w.from = faceFrom(partsOf(ctx.scene, a.object).map(id => ({ ...poseOf(id), half: ctx.scene.objects[id].half })), w.p);
	return w;
}

/**
 * A rim socket held by hand `side`: the rim point nearest q (the anchor's local point, else the shoulder) the first time
 * it is asked, kept in the rim's own axes so the hand stays on that spot of the rim as the rim moves (a wheel in a truck).
 */
function rimHold(ctx, name, side, sock, pose, w, q) {
	ctx.rims ??= new Map();
	// asked with no hand (a contact check, a goal): the spot a hand already holds
	const held = side ? null : [...ctx.rims.keys()].find(k => k.startsWith(`${name}|`) && !k.endsWith("|"));
	const key = held ?? `${name}|${side ?? ""}`;
	if (!ctx.rims.has(key)) {
		const r = rimPoint(w, q), back = v => apply(T(pose.R), v);
		ctx.rims.set(key, { at: back(sub(r.p, pose.pos)), axis: back(r.axis) });
	}
	return socketWorld(ctx.rims.get(key), pose);
}

/** Points of every prop held by hand k, in world space, written to diag.props. */
export function measureProps(ctx, k, s, diag) {
	const { sk } = ctx;
	for (const [name, prop] of Object.entries(ctx.spec.props ?? {})) {
		if (prop.hand !== k) continue;
		const ax = palmAxes(sk, s, SIDES[k]);
		const origin = scale(prop.origin.map(b => s.P[sk.index[b]]).reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / prop.origin.length);
		const pts = {};
		for (const [pn, [d, l, n]] of Object.entries(prop.points ?? {})) pts[pn] = add(origin, add(scale(ax.d, d), add(scale(ax.l, l), scale(ax.n, n))));
		pts.origin = origin;
		pts.axes = ax;
		(diag.props ??= {})[name] = pts;
	}
}
