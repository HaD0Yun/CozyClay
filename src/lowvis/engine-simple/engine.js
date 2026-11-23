// engine-simple: a small deterministic motion engine for the 17-joint figure. Pure JS on rig17.js; Node and browser.
//
// SPEC FORMAT. A spec is { demo, <characterId>: [[frame, verb, options], ...] }. The scene (start positions,
// props, frame count) comes from demos.js. An action lasts until the next action of the same layer.
//   Body layer (feet and pelvis):
//     idle | walk {to:[x,z], heading?, facing?, steps?, burst?, first?:"L"|"R", end?:{L:[left,fwd],R:[..]}, stepFrames?, ease?} | run {to} | push {to} | turn {heading}
//     sit {on:propId} | stand | kneel | lie {on:propId, head:deg}
//     sit / stand / kneel / lie {over}: `over` = frames the change takes (default and most: up to the next body
//     action), then the posture holds. `over: 0` = in it at once: at frame 0 the figure begins the clip in it, placed
//     from its scene `at` and `heading` as at the end of the change.
//     on: propId, on any body action: the body goes with that prop however it is moved (moves: true). Its places and
//     headings are written as if the prop stood where the scene puts it. Getting on, and off with the next action
//     without that `on`, goes on from where the body is (over 12 frames where the prop has risen or tipped).
//     Consecutive walk / run actions are one flowing path. `heading` is the arrival heading (the path curves, or a
//     turn on the spot is added). `facing` keeps the body facing that way (back / side steps). `steps: 1` is a lunge.
//     `push` is a low, leaning, short-step gait; `push {to: <where it stands>}` braces in place.
//     With `steps` (the feet's plants; the last one brings the feet together): `stepFrames` = frames per step (default:
//     at most 13, then it stands), `ease` = how the pelvis covers the distance ("in" = it speeds up, so each step is
//     longer than the one before; default: a steady speed with a speed-up and a slow-down of half a second each, a
//     little more than that when steps are slower than 13 frames, so the steps between are the same length). Steps
//     longer than the gait's longest at that pace (a walk 0.75 m ahead or back, 0.44 m to the side; a run 1.2 m; a
//     push 0.4 m; times the body's scale), or a pace that puts a foot further from the hips than a steady pace of those
//     steps does (one that stops or starts at full speed), become the fewest steps that fit; the `end` spots are not
//     fitted to. A run with `facing` or of under 0.5 m times the body's scale steps as a walk. The travel line says
//     what was walked.
//   Upper layer (each field keeps its value until a later action changes it; `over` = blend frames, `ease` = name):
//     Where a hands, L, R, lean, bow, twist, hipTurn, hip or tilt key with ease inout starts on the frame the inout key
//     before it in that field ends, the field is at the earlier key's target on that frame and passes it without
//     stopping, at the speed the targets before and after give (per coordinate, a hand's in the body frame and no more
//     than lets it be on that target on that frame at the most a hand moves per frame; none in a coordinate that turns
//     back there); such a key that starts while the key before it still blends starts where the field's move of the
//     frame before takes it and goes on with the part of that speed that goes toward its own target. Not so: a blend
//     to "rest" and the blends of carry and place start from a stop and stop on their targets, a blend from "rest"
//     starts at rest, and a hold's blend of a hand to its place stops on it.
//     pose {hands|L|R: target, lean:deg (chest), bow:deg (hinge at the hips), twist:deg, hipTurn:deg, hip:[x,y,z], look: id|[x,y,z]|"fwd", nod:n, shake:n,
//           aim:[x,y,z]|{x?,y?,z?:[x,y,z], world?:true}|"off", elbowL|elbowR: target, fast:true, over, ease}
//       aim: the hand that holds a prop turns so the prop's long z axis points that way, body frame; the object form
//         points the prop's own axes (those of its size: y = its height) instead, in the body frame or with world:true
//         the world; one axis given: the hand stays as near the forearm as it can
//       hand target: "rest" | [x,y,z] in the body frame from the Hips joint (x = own left, z = forward)
//                    | {prop:id} | {prop:id, face:true, y, w} | {meet:id} | {chest:id} | {world:[x,y,z]}
//                    | {joint:name, at?:[x,y,z], of?:characterId}   a place on the own body (of: on that character's
//                      body) that follows that joint; at = offset in the joint's own frame (the body frame at rest).
//                      Joints: Hips Spine Spine2 Neck Head and, with Left or Right before them, Arm (shoulder)
//                      ForeArm (elbow) Hand (wrist) UpLeg (hip) Leg (knee) Foot (ankle)
//                    | {on:propId, at?:[x,y,z]}   a place on a prop that follows it; at = offset from its centre in
//                      its own frame (the axes of its size)
//       elbowL|elbowR: a hand target form or "rest"; the elbow bends toward it and lies on it when the wrist's place
//         and the arm's length allow; a wrist with no target of its own goes with it: the whole arm turns about the
//         shoulder as one piece, keeping its bend (a wrist blending to or from its own target: by the part of the
//         blend it is not on that target, and the elbow bends the rest of the way toward it), so the elbow points at the target
//     carry {prop, at:[x,y,z], over}   the prop follows both hands from this frame, level, turning with the line
//                                      between them; no `at` = hands stay as they are;
//                                      slide:true = the prop only slides on the floor with the hands (a push);
//                                      carry takes the prop from any other hands
//     hold {prop, hand:"R"|"L"|"both", at?, over}   these hands of this character hold the prop until they let go;
//       its other hand and hands of other characters that hold it hold on too (a carry of its own ends). at = each
//       hand's place on the prop, [x,y,z] as in {on} ({L:[..], R:[..]} for both); no at = the point of the prop nearest
//       each hand on the hold's frame, a wrist's pad off its surface. With over 0 (the default) or with each hand within
//       a wrist's pad of its place they take hold on that frame (with no at, where they are); else they go there over
//       `over` frames (the hand speed limit below still holds) and take hold when they end.
//       A holding hand stays where it took hold in the body frame until a later pose moves it. The prop follows its
//       hands: in one hand fixed in it, as it lay in the hand when that hand came to hold it alone (aim turns it); in
//       more, the place and turn that best put each hand's place on that hand; about an axis its places hardly fix (all
//       on one line) it keeps the turn it had on the frame before, turned about the vertical as far as its holders'
//       headings turned (the mean over the hands) and otherwise only as its places turn it. Each hand is then
//       put on its place; its reach row is how far it is from it (a place out of reach); its `held` row is how far that
//       keeps it from where its own action (the hold, or a later pose of that hand) puts it (hands that pull apart). A
//       hand that arrives short of its place pulls the prop to it on that frame, told as its own row, and then takes
//       it on to where it holds it
//     release {prop, hand?, roll?}     this character lets go (hand: only that hand, of a hold or a carry; the other
//                                      keeps the prop as it is: a pushed one (slide) slides on with that hand at its
//                                      height and turn, the hand on its place on it); with no hand on it the prop stays
//                                      where it is; roll:true = it keeps the hand's velocity, drops to
//                                      the floor under it and rolls on until one of its own keys starts
//     pose {footL|footR: target, over, ease}   takes one foot off the floor: it leaves the body layer and goes to the
//       target along an arc about its hip; "plant" gives it back to the body layer (blend it into a step or a stance).
//       foot target: [x,y,z] | {at:[x,y,z], pitch:deg} | {world:[x,y,z], pitch:deg} | {joint, at?, of?, pitch:deg}
//       (a place on a body as for a hand) | "plant". The point is the ankle
//       joint; `at` is in the body frame from the floor point under the Hips joint (y = height over the floor);
//       pitch > 0 points the toes down. The other foot keeps the body; nothing moves a body to keep its balance (where
//       the tool has a balance row, that row says what it measures of a body at rest).
//     Hands blend along an arc about the shoulder and move at most 0.12 m per frame in the body frame unless fast
//     (a wrist an elbow key turns: unless that key or its hand's key says fast).
//     look: a character id, a prop id (its top), a world point or "fwd"; with no target the gaze stays level.
//     place {prop, at:[x,y,z] world, over}   the hands take the prop there and let go
//   Prop layer: <propId>: [[frame, verb, options], ...] moves a free prop by keys:
//     tip {pivot:[x,y,z], axis:[x,y,z], deg, over, ease} | move {to:[x,y,z], axis?, deg?, over, ease}   a key starts
//       where the key or the ride before it has the prop on its frame
//     launch {vel:[x,y,z] m/s, bounce?: 0.5, friction?: 1.5}   a kicked / thrown prop: it is still in place on the key's
//       frame and flies from the next one under gravity, bounces off the floor and off static props (as a ball of
//       diameter size[1]; bounce = speed kept), rolls with `friction` (m/s2) and stops. A later key of the prop ends it.
//       The frame is written by hand; checks.js measures how far the nearest foot is from the prop on that frame.
//     ride {on:propId} | {joint:name, of:characterId}, at?:[x,y,z], axis?, deg?   from this frame the prop keeps its
//       place and turn on that prop, however that one is carried, held or keyed, or on that joint of that body (joints
//       as for a hand target), however the body moves; at = its centre there in the carrier's own frame (as {on} and
//       {joint} targets give it), its axes along the carrier's, turned deg about axis (axis, deg: only with at); no at =
//       the place and turn it has on the carrier on the frame before the ride begins. Until a later key of its own or a
//       hand takes it off. While a hand holds it the ride waits (written while it is held, or taken on its frame: from the let-go)
//     hide | show   from this frame the prop is not drawn / drawn again; nothing else about it changes
// Angles in a spec are degrees; lengths are metres.
import { DEMOS } from "../demos.js";
import { INDEX as J, OFFSET, qAxisAngle } from "../rig17.js";
import { addCharacter, addProp, createClip, setPose } from "../clip.js";
import { EASE, add, clamp, dot, len, mix, mixV, mul, qConj, qMul, qRotate, qSlerp, qX, qY, rad, sub } from "./math.js";
import { keyPose, propKeys, shownAt } from "./prop-keys.js";
import { carriedBuild } from "./carry.js";
import { arcSized, buildBodySized, solveSized } from "./size.js";
import { PAD, across, offBox, toOwn, toWorld } from "./prop-frame.js";
import { bodyCarriers, buildUpper, expandRepeats } from "./spec-layers.js";
import { NOTES } from "./notes.js";
import { aimOf, elbowsOf, ownPoint, ownReach } from "./own-body.js";
import { carriersOf, moveRiders, propKey, ridesOf } from "./ride.js";
import { afterFirstPass, onPlaces, onPoint, otherPoint, otherReach, placed, shareEvent, startFrame } from "./share.js";
import { reachEntry } from "./reach.js";
import { inHand, settleHold } from "./take.js";
import { flowAdd, handsMoved, startHand, startScalar } from "./flow.js";

export { NOTES, expandRepeats };

const HAND = [J.LeftHand, J.RightHand], UPLEG = [J.LeftUpLeg, J.RightUpLeg];


/** Builds a clip from a spec. Returns { clip, aux } where aux has the per-frame contact and carry flags for checks.
 *  aux.reach[characterId][frame] = [L hand, R hand, L foot, R foot], each null or { key, d }: d metres between the limb
 *  and the target the action of frame `key` gave it, on the frames after that action's blend has ended. A spec with a
 *  body on a prop that moves is built again with that body carried (carry.js; aux.carried where the two do not settle). */
export function buildClip(written, def = DEMOS[written.demo]) { return carriedBuild(written, def, buildOnce, bodyCarriers(written, def)); }
function buildOnce(written, def, carrier) {
	const repeat = expandRepeats(written, def.frames), spec = repeat.spec;
	const F = def.frames, clip = createClip({ demo: spec.demo, engine: "simple", frameCount: F });
	const props = Object.fromEntries(def.props.map(p => [p.id, {
		id: p.id, size: p.size, c: p.at.slice(), turn: rad(p.turn ?? 0), yaw: rad(p.turn ?? 0), q: p.turn ? qY(rad(p.turn)) : [0, 0, 0, 1], holder: null, hand: null, moves: !!p.moves, h1: p.at.slice(), h2: p.at.slice(),
		...propKeys(spec[p.id] ?? []), // keys, shownKeys (prop-keys.js)
	}]));
	const inside = (p, x, z) => { const [lx, lz] = toOwn(p, x - p.c[0], z - p.c[2]); return Math.abs(lx) <= p.size[0] / 2 && Math.abs(lz) <= p.size[2] / 2; };
	const ground = (x, z, step = 0.3) => Math.max(0, ...Object.values(props).filter(p => !p.moves && p.c[1] + p.size[1] / 2 <= step && inside(p, x, z)).map(p => p.c[1] + p.size[1] / 2));
	const seats = [], walks = []; // every sit on a prop: how far its hips end from the seat top, how many feet stand inside the prop; walks: a count not walked as written (gait.js told)
	const chars = def.characters.map(c => {
		const acts = (spec[c.id] ?? []).slice().sort((a, b) => a[0] - b[0]), s = c.scale ?? 1; // s: the body's size (size.js); a floor it stands on is at most 0.3 m x s high
		const out = Object.assign(addCharacter(clip, c.id), s === 1 ? {} : { scale: s }, c.tint ? { tint: c.tint } : {});
		return { id: c.id, s, body: buildBodySized(c, acts, F, { props, ground: (x, z) => ground(x, z, 0.3 * s), note: e => seats.push({ who: c.id, ...e }), walked: e => walks.push({ who: c.id, ...e }), carrier }, s), ...buildUpper(c.id, acts, props, s), out, rest: [true, true], up: [0, 0], last: {}, cur: {}, pose: null };
	});
	const byId = Object.fromEntries(chars.map(c => [c.id, c]));
	const outProps = def.props.map(p => ({ p: props[p.id], out: Object.assign(addProp(clip, p.id, p.size, p.moves ? F : 1), p.shape ? { shape: p.shape } : {}, p.moves ? { by: [] } : {}, props[p.id].shownKeys.length ? { shown: [] } : {}) })); // by: what carries a moving prop on each frame, shown: whether it is drawn (clip.js)
	const aux = { contacts: Object.fromEntries(chars.map(c => [c.id, []])), holders: Object.fromEntries(def.props.map(p => [p.id, []])), placed: [] };
	Object.assign(aux, {
		grips: Object.fromEntries(def.props.map(p => [p.id, []])), keyed: Object.fromEntries(def.props.map(p => [p.id, []])), slid: {},
		rolling: Object.fromEntries(def.props.map(p => [p.id, []])), releases: [], launches: [],
		keyStarts: def.props.filter(p => props[p.id].keys.length).map(p => ({ prop: p.id, f: props[p.id].keys[0].f })),
		reach: Object.fromEntries(chars.map(c => [c.id, []])), repeat: { added: repeat.added, dropped: repeat.dropped }, seats, walks, ...ridesOf(props, byId), // rides: only with a ride key
	});

	// One frame of a launched prop: a ball of radius size[1] / 2 in small sub-steps, so it cannot pass through a wall.
	const walls = Object.values(props).filter(o => !o.moves && o.c[1] + o.size[1] / 2 > 0.3);
	const fly = p => {
		const r = p.size[1] / 2, b = p.fly.bounce, n = Math.max(1, Math.ceil(len(p.vel) / 0.03)), sp = Math.hypot(p.vel[0], p.vel[2]);
		let floor = 0;
		for (let s = 0; s < n; s++) {
			p.c = add(p.c, mul(p.vel, 1 / n));
			floor = ground(p.c[0], p.c[2]) + r;
			if (p.c[1] <= floor) { p.c[1] = floor; if (p.vel[1] < 0) p.vel[1] = -p.vel[1] * b > 0.02 ? -p.vel[1] * b : 0; } // a small rebound ends: it rolls
			for (const o of walls) {
				const d = offBox(o, p.c), l = len(d);
				if (l >= r || l < 1e-9) continue;
				const nrm = mul(d, 1 / l), vn = dot(p.vel, nrm);
				p.c = add(p.c, mul(nrm, r - l));
				if (vn < 0) p.vel = sub(p.vel, mul(nrm, (1 + b) * vn));
			}
		}
		if (sp > 1e-6) p.q = qMul(qAxisAngle([p.vel[2] / sp, 0, -p.vel[0] / sp], sp / r), p.q);
		if (p.c[1] > floor || p.vel[1] > 0) { p.vel[1] -= 0.017; return; } // in the air: gravity, 9.8 m/s2 at 24 fps
		const left = Math.hypot(p.vel[0], p.vel[2]) - p.fly.friction;
		p.vel = left > 0 ? [p.vel[0] * left / (left + p.fly.friction), 0, p.vel[2] * left / (left + p.fly.friction)] : null; // rolling: it slows down and stops
	};
	const handLine = pose => { const l = pose.pos[HAND[0]], r = pose.pos[HAND[1]]; return { mid: mixV(l, r, 0.5), yaw: Math.atan2(l[0] - r[0], l[2] - r[2]) }; };
	const follow = (p, c, f) => {
		if (p.hand != null) return inHand(p, c, f); // take.js
		const h = handLine(c.poseNow);
		if (p.slide) { p.c = [h.mid[0] - p.off[0], p.c[1], h.mid[2] - p.off[2]]; return; }
		p.yaw = h.yaw + p.yawOff; p.q = qY(p.yaw); p.c = sub(h.mid, qRotate(p.q, p.off));
	};
	// where hand s of a character at B holds a box centred at c: on its left / right face, a little toward the holder
	// k (here and below): the size of the body whose hand, chest or head a length belongs to
	const grab = (c, p, B, s, k) => {
		const d = [B.p[0] - c[0], B.p[2] - c[2]], l = Math.hypot(d[0], d[1]) || 1, dx = d[0] / l, dz = d[1] / l, half = across(p) / 2 + PAD * k;
		return [c[0] - dz * s * half + dx * 0.07 * k, c[1], c[2] + dx * s * half + dz * 0.07 * k];
	};
	const handTarget = (c, i, to, f) => {
		const B = c.body[f], s = i ? -1 : 1, k = c.s;
		if (to.joint) return to.of ? otherPoint(byId, to, f) : ownPoint(c, to, f);
		if (to.on) return onPoint(props, to);
		if (Array.isArray(to)) return add(B.p, qRotate(qY(B.yaw), to));
		if (to.world) return to.world;
		if (to.face) { // palms on the face of the box that looks at the figure (in the prop's own frame)
			const p = props[to.prop], d = toOwn(p, B.p[0] - p.c[0], B.p[2] - p.c[2]), alongX = Math.abs(d[0]) > Math.abs(d[1]);
			const dx = alongX ? Math.sign(d[0]) : 0, dz = alongX ? 0 : Math.sign(d[1]), out = (alongX ? p.size[0] : p.size[2]) / 2 + PAD * k, w = to.w ?? 0.2 * k;
			const [ox, oz] = toWorld(p, dx * out - dz * s * w, dz * out + dx * s * w);
			return [p.c[0] + ox, to.y ?? p.c[1], p.c[2] + oz];
		}
		if (to.at) return grab(to.at, props[to.prop], B, s, k);
		if (to.prop) return grab(props[to.prop].c, props[to.prop], B, s, k);
		const o = byId[to.meet ?? to.chest], oB = o.body[f];
		const d = [oB.p[0] - B.p[0], oB.p[2] - B.p[2]], l = Math.hypot(d[0], d[1]) || 1, dx = d[0] / l, dz = d[1] / l;
		if (to.meet) return [(B.p[0] + oB.p[0]) / 2 - dx * 0.06 * k, to.y ?? 1.1 * (k + o.s) / 2, (B.p[2] + oB.p[2]) / 2 - dz * 0.06 * k]; // one height for both bodies of the pair
		const ch = (o.poseNow ?? solveSized(oB, {}, o.s)).pos[J.Spine2]; // palms on the other figure's chest
		return [ch[0] - dx * 0.15 * o.s + dz * s * 0.1 * o.s, ch[1] + 0.03 * o.s, ch[2] - dz * 0.15 * o.s - dx * s * 0.1 * o.s];
	};
	const active = (list, f) => list.findLast(k => k.f <= f);
	const prog = (k, f) => k.over > 0 ? (f - k.f) / k.over : 1; // over: 0 = at once
	// the key before k, if its blend has ended by frame f: the new key then starts exactly from that key's target
	const ended = (list, k, f) => { const prev = list[list.indexOf(k) - 1]; return prev && f - prev.f >= prev.over ? prev : null; };
	const scalar = (c, name, f, zero) => {
		const k = active(c.keys[name], f);
		if (!k) return zero;
		if (k.from === undefined) startScalar(c.keys[name], k, f, c.last[name], c.last2?.[name], zero); // flow.js
		const w = EASE[k.ease](prog(k, f)), on = k.over > 0 && flowAdd(k.m0, k.m1, prog(k, f), k.over), v = Array.isArray(zero) ? mixV(k.from, k.to, w) : mix(k.from, k.to, w);
		return (c.cur[name] = !on ? v : Array.isArray(zero) ? v.map((x, n) => x + on[n]) : v + on);
	};
	// Tilt: the whole figure, as it is posed, turned about one point and then moved. The pose is solved untilted;
	// targets given in the world are taken into that untilted space first, and the solved pose is turned at the end.
	// Returns null for an upright figure, else { q, inv, pivot, shift }.
	const tiltOf = (c, f) => {
		const k = active(c.keys.tilt, f);
		if (!k) return null;
		const t = scalar(c, "tilt", f, [0, 0, 0, 0, 0]);
		if (t.every(v => Math.abs(v) < 1e-9)) return null;
		const B = c.body[f], yawQ = qY(B.yaw), ft = B.feet;
		const pivot = Array.isArray(k.about) ? k.about : k.about === "feet" ? [(ft[0].a[0] + ft[1].a[0]) / 2, Math.min(ft[0].floor ?? 0, ft[1].floor ?? 0), (ft[0].a[2] + ft[1].a[2]) / 2] : add(B.p, qRotate(yawQ, scalar(c, "hip", f, [0, 0, 0])));
		const q = qMul(qMul(yawQ, qMul(qX(t[0]), qAxisAngle([0, 0, 1], -t[1]))), qConj(yawQ));
		return { q, inv: qConj(q), pivot, shift: [t[2], t[3], t[4]] };
	};
	const toBody = (T, p) => T ? add(T.pivot, qRotate(T.inv, sub(sub(p, T.shift), T.pivot))) : p;
	const tilted = (T, pose) => T ? { ...pose, pos: pose.pos.map(p => add(add(T.pivot, qRotate(T.q, sub(p, T.pivot))), T.shift)), quat: pose.quat.map(q => qMul(T.q, q)) } : pose;
	// a hand target in the space the pose is solved in: a body-frame or own-body target as it is, any other brought in from the world
	const target = (c, i, to, f) => Array.isArray(to) || (to.joint && !to.of) ? handTarget(c, i, to, f) : toBody(c.tilt, handTarget(c, i, to, f));
	const upper = (c, f, first) => {
		const B = c.body[f], U = { lean: scalar(c, "lean", f, 0), twist: scalar(c, "twist", f, 0), hipTurn: scalar(c, "hipTurn", f, 0), bow: scalar(c, "bow", f, 0), hip: scalar(c, "hip", f, [0, 0, 0]), hands: [], assist: c.pose?.assist, knee: c.pose?.knee, noAssist: def.assist === false };
		[c.keys.L, c.keys.R].forEach((list, i) => {
			const k = active(list, f);
			let h = { from: null, to: null, w: 1 }, upTo = 0;
			if (k) {
				if (k.from === undefined) {
					const prev = ended(list, k, f), toLocal = (p, b) => qRotate(qY(-b.yaw), sub(p, b.p)), here = c.pose ? toLocal(c.pose.pos[HAND[i]], c.prevB) : null;
					const at = q => (q.to === "rest" ? null : q.to === "keep" ? (q.place ? toLocal(target(c, i, q.place, f), B) : here) : toLocal(target(c, i, q.to, f), B)); // a keep that a later key of its frame hid: its place, else where the hand is
					const local = prev ? at(prev) : here;
					k.from = !prev && c.rest[i] ? null : local;
					if (k.to === "keep") { k.to = k.place ? at(k) : local ?? "rest"; k.keptUp = c.up[i] > 0.5; } startHand(list, k, prev, c.handVel?.[i], 0.12 * c.s, at, here ?? qRotate(qY(-B.yaw), qRotate(B.q, B.hands[i]))); // flow.js
				}
				const u = clamp(prog(k, f)), w = EASE[k.ease](u), on = k.over > 0 && u < 1 && flowAdd(k.m0, k.m1, u, k.over);
				h = { from: k.from && add(B.p, qRotate(qY(B.yaw), k.from)), to: k.to === "rest" ? null : target(c, i, k.to, f), w, key: k.f, by: k.by ?? k.f, done: u >= 1 };
				if (k.pair) h.line = true; // two hands on one prop move as a pair, in a straight blend
				if (k.to?.joint || k.to?.on) h.self = k.to; // a target that follows something: measured again as it ended (share.js)
				if (k.shake) h.offset = [0, 0.035 * Math.sin(2 * Math.PI * k.shake * u) * c.s, 0]; if (on) h.flow = qRotate(qY(B.yaw), on); // flow.js
				if (k.to?.chest || k.to?.face) upTo = w;
				if (k.keptUp) upTo = 1;
				c.restNext[i] = k.to === "rest" && w >= 1;
			} else c.restNext[i] = true;
			if (first) c.up[i] += (upTo - c.up[i]) * 0.3;
			h.up = c.up[i];
			if (c.pose && !k?.fast) h.prev = add(B.p, qRotate(qY(B.yaw), qRotate(qY(-c.prevB.yaw), sub(c.pose.pos[HAND[i]], c.prevB.p))));
			U.hands.push(h);
		});
		// Feet: a foot key replaces the body layer's foot (it is not planted) until a "plant" key has blended back
		U.feet = [c.keys.footL, c.keys.footR].map((list, i) => {
			const k = active(list, f), bf = B.feet[i];
			if (!k) return null;
			const w = EASE[k.ease](prog(k, f));
			if (k.to === "plant" && w >= 1) return null;
			const at = t => t === "plant" ? bf : t.q ? t : { a: t.place ? target(c, i, t.place, f) : t.world ? toBody(c.tilt, t.world) : add([B.p[0], 0, B.p[2]], qRotate(qY(B.yaw), t.at)), q: qMul(qY(B.yaw), qX(t.pitch)) };
			if (k.from === undefined) k.from = list.indexOf(k) === 0 ? "plant" : ended(list, k, f)?.to ?? { a: c.feetPrev[i].a, q: c.feetPrev[i].q };
			const a = at(k.from), b = at(k.to);
			return { a: arcSized(a.a, b.a, w, add(B.p, qRotate(B.q, mul(OFFSET[UPLEG[i]], c.s))), c.s), q: qSlerp(a.q, b.q, w), planted: false, to: k.to === "plant" ? null : b.a, w, key: k.f, done: prog(k, f) >= 1, self: k.to.place, ...(c.tilt ? { floor: -1e9 } : {}) };
		});
		const helpers = { active, prog, ended, target };
		aimOf(c, f, U, helpers); elbowsOf(c, f, U, helpers);
		// Head: angles relative to the chest, measured from the neck (which the look does not move). With no target
		// the gaze stays level while the chest leans (not when lying down).
		const now = c.solved ?? c.pose, chestQ = now?.quat[J.Spine2] ?? B.q, neck = now?.pos[J.Neck] ?? add(B.p, [0, 0.46 * c.s, 0]);
		const angles = d => { // a target behind the head fades back to straight ahead instead of flipping sides
			const l = qRotate(qConj(chestQ), d), yaw = Math.atan2(l[0], l[2]), fade = clamp((Math.PI - Math.abs(yaw)) / (Math.PI - 1.9));
			return [clamp(yaw * fade, -1.2, 1.2), clamp(-Math.atan2(l[1], Math.hypot(l[0], l[2])), -0.7, 0.7) * fade];
		};
		const level = [0, angles([Math.sin(B.yaw), -0.08, Math.cos(B.yaw)])[1] * clamp(2 * qRotate(chestQ, [0, 1, 0])[1] - 0.3)];
		const k = active(c.keys.look, f);
		U.look = c.cur.look = level;
		if (k) {
			k.from ??= c.last.look ?? level;
			let t = level;
			if (k.to !== "fwd") {
				const o = byId[k.to], pr = props[k.to];
				t = angles(sub(toBody(c.tilt, o ? (o.poseNow?.pos[J.Head] ?? add(o.body[f].p, [0, 0.56 * o.s, 0])) : pr ? add(pr.c, [0, pr.size[1] / 2, 0]) : k.to), neck));
			}
			const u = clamp(prog(k, f));
			U.look = c.cur.look = mixV(k.from, t, EASE[k.ease](u));
			if (k.nod) U.look = [U.look[0], U.look[1] + 0.2 * Math.sin(2 * Math.PI * k.nod * u)];
		}
		if (c.last.head) U.look = U.look.map((v, n) => c.last.head[n] + clamp(v - c.last.head[n], -0.3, 0.3)); // the neck turns at most 0.3 rad a frame
		c.cur.head = U.look;
		return U;
	};

	for (let f = 0; f < F; f++) {
		for (const [c, e] of chars.flatMap(c => c.events.filter(e => e.f === f).map(e => [c, e])).sort((a, b) => (a[1].holder != null) - (b[1].holder != null))) { // lets-go first
			const p = props[e.prop];
			if (e.wait && !settleHold(e, c, f, p)) continue; // a hold: its hands take hold now or when they reach the prop (take.js)
			if (e.at && e.holder == null) placed(aux.placed, p, c, e, f); // also where other hands still hold it
			if (shareEvent(p, c, e, f, byId)) continue;
			p.holder = e.holder; p.hand = e.hand ?? null; p.slide = !!e.slide; if (e.holder) p.takenAt = f;
			if (e.hand != null) { p.gq = null; c.gripHand = e.hand; } // the hand takes it as it lies (take.js)
			if (e.roll) { p.vel = sub(p.h1, p.h2); p.fly = null; aux.releases.push({ prop: e.prop, f }); }
			else if (e.holder) {
				const h = handLine(byId[e.holder].world ?? solveSized(c.body[f], {}, c.s));
				if (e.slide) { p.off = sub(h.mid, p.c); aux.slid[e.prop] = true; }
				else { p.yawOff = p.yaw - h.yaw; p.off = qRotate(qY(-p.yaw), sub(h.mid, p.c)); }
			}
		}
		for (const p of Object.values(props)) { // a free prop follows its own keys
			let k = propKey(p, f); // null while held or riding (ride.js)
			if (k?.verb === "launch") { // starts a flight once; the prop then moves by itself
				if (k.f === f) { p.vel = mul(k.vel, 1 / 24); p.fly = { bounce: k.bounce ?? 0.5, friction: (k.friction ?? 1.5) / 576, wait: true }; aux.launches.push({ prop: p.id, f }); }
				k = null;
			} else if (k || p.holder || p.ride) p.vel = null;
			aux.keyed[p.id].push(!!k || !!p.vel || (!!p.ride && !p.holder)); aux.rolling[p.id].push(!!p.vel);
			if (k) Object.assign(p, keyPose(p, k, f)); // prop-keys.js (a key leaves no velocity, so nothing below moves it)
			else if (p.vel && p.fly?.wait) p.fly.wait = false; // the launch frame: still in place
			else if (p.vel && p.fly) fly(p);
			else if (p.vel) { // released with a velocity: it falls to the floor under it and rolls on at that speed
				const floor = ground(p.c[0], p.c[2]) + p.size[1] / 2, sp = Math.hypot(p.vel[0], p.vel[2]);
				p.c = add(p.c, p.vel); p.vel[1] -= 0.017; // gravity, 9.8 m/s2 at 24 fps
				if (p.c[1] <= floor) { p.c[1] = floor; p.vel[1] = 0; }
				if (sp > 1e-6) p.q = qMul(qAxisAngle([p.vel[2] / sp, 0, -p.vel[0] / sp], sp / (p.size[1] / 2)), p.q);
			}
		}
		startFrame(props, f, byId);
		for (let pass = 0; pass < 2; pass++) for (const c of chars) { // second pass: targets on other figures and props are current
			if (pass === 1 && c === chars[0]) afterFirstPass(props, chars, f);
			c.restNext = [true, true];
			c.tilt = tiltOf(c, f);
			const U = c.U = upper(c, f, pass === 0);
			if (pass === 1) onPlaces(props, c, U, f, p => toBody(c.tilt, p));
			c.bodyNow = U.feet.some(Boolean) ? { ...c.body[f], feet: c.body[f].feet.map((ft, i) => U.feet[i] ?? ft) } : c.body[f];
			c.solved = solveSized(c.bodyNow, U, c.s); c.solvedF = f;
			c.poseNow = tilted(c.tilt, c.solved);
			for (const p of Object.values(props)) if (p.holder === c.id) follow(p, c, f);
			if (pass === 1) aux.reach[c.id].push(ownReach(c, f, U, [
				...U.hands.map((h, i) => h.to && h.done ? reachEntry(c, i, h.key, h.offset ? add(h.to, h.offset) : h.to, { slow: c.solved.slow[i] }) : null),
				...U.feet.map((ft, i) => ft?.to && ft.done ? reachEntry(c, 2 + i, ft.key, ft.to, { floor: c.solved.lift[i] > 0.001 && c.solved.lift[i] }) : null),
			], { target }));
		}
		moveRiders(props, f, byId, true); // riders on a body: on its joint as it ended this frame
		for (const c of chars) otherReach(c, aux.reach[c.id].at(-1), byId, props, f, p => toBody(c.tilt, p), reachEntry);
		for (const c of chars) {
			c.pose = c.solved; c.world = c.poseNow; c.prevB = c.body[f]; c.feetPrev = c.bodyNow.feet; c.rest = c.restNext; c.last2 = c.last; c.last = { ...c.last, ...c.cur }; handsMoved(c);
			setPose(c.out, f, c.world);
			aux.contacts[c.id].push(c.bodyNow.feet.map(ft => ft.planted && !c.tilt && c.bodyNow.on == null)); // a tilted figure, or one on a moving prop, does not stand on the floor
		}
		for (const { p, out } of outProps) {
			p.h2 = p.h1; p.h1 = p.c.slice(); out.by?.push(carriersOf(p)); out.shown?.push(shownAt(p, f));
			aux.holders[p.id].push(p.holder); aux.grips[p.id].push(p.holder && p.hand != null ? { c: p.holder, hand: p.hand, from: p.takenAt } : null); // from: the frame it took hold
			if (out.pos.length === 3 && f > 0) continue;
			out.pos.set(p.c, out.pos.length === 3 ? 0 : f * 3); out.quat.set(p.q, out.pos.length === 3 ? 0 : f * 4);
		}
	}
	clip.notes.push(...NOTES);
	return { clip, aux };
}
