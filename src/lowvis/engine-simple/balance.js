// Balance assist (LOWVIS_BALANCE_ASSIST=1; off by default, and then nothing here runs but one look at the switch per
// body): while the clip is built, a body that stands on its feet and whose centre of mass, dropped to the floor, lies
// outside the soles it stands on moves its pelvis over them. The idea is the textbook one of static balance: a body at
// rest stays up only while the vertical through its centre of mass passes through its support polygon (the convex
// hull of what touches the ground). The centre of mass is the sum of the segments' masses at their centres, from a
// standard table of body segment parameters (the shares of an adult's segments and where along each its centre lies).
//
// What it moves: only the pelvis, sideways and forward or back (on top of the hip key's x and z). Planted feet stay
// (the legs reach them as the solver always does), a foot a key lifts stays on its target, and no upper-body key (bow,
// lean, look, twist) is changed. On each frame the solver is run as the spec has it (that pose gives the centre of
// mass, the supports and the hands' distances) and, when the body needs a shift, again with it. In that second solve a
// hand still in its blend toward a target is held where the first one has it, so it keeps its path in the world.
// Supports: the soles of the feet that are on the floor in the first pose (a foot the body layer holds planted, or a
// keyed foot whose sole lies within 10 mm x scale of the floor and whose key's target is down there too: a foot that
// a key lifts counts as leaving from the key's first frame, so the weight goes over to the other foot while it lifts),
// and a hand on its target on the floor.
// What the body needs is taken as it is at rest: less what the centre of mass's own speed toward its supports will
// bring back (the time constant of an inverted pendulum of the body's height, sqrt(h / g)), and none while the body
// comes up from a bend (a body that straightens up is on its way back over its feet).
// Smoothness: the shift follows its target with a limited acceleration (it eases in and out, never jumps); it is eased
// away before a frame the assist must leave alone (seen ahead from the body layer and the keys) and is zero on such
// frames. Hands keep priority: a shift that would leave a hand further than 1.5 mm x scale more from its target than
// the pose without it is cut back until it does not.
// Left alone (the frames of): a sit, kneel or lie, a push stance (it leans on what it pushes), a step, turn, walk, run, push or change of posture of the body layer,
// a launch and its flight, a body on a prop (standing on it or riding it), a tilt, a hold, carry or place of a prop or
// line (and a hand, elbow or foot on a target that is a prop, a world point or another body), a body that carries a
// riding prop on one of its joints (all of its frames), and a deep crouch (the shift fades out as the hips go below
// 0.52 m x scale over the floor and is none below 0.45 m x scale).
import { ANKLE_HEIGHT, INDEX as J, REST, TIPS } from "../rig17.js";
import { clamp, qRotate, qY, smooth } from "./math.js";
import { solveSized } from "./size.js";
import { LEG_LEN } from "./solve.js";

// metres and frames at scale 1. margin: how far inside the supports the centre of mass is taken; accel: the most the
// shift's speed changes in a frame; most: the largest shift; ahead: the frames over which it eases away before a frame
// it must leave alone; hands: how much further a hand may end from its target; on: a sole this near the floor is down
const ASSIST = Object.freeze({ margin: 0.005, accel: 0.002, most: 0.25, ahead: 10, hands: 0.0015, on: 0.01, crouch: [0.45, 0.52] });
const tipOf = name => TIPS[name].map((v, k) => v - REST[J[name]][k]); // a tip from its joint, in the joint's rest frame
// [share of the body's mass, from, to, where its centre lies from `from`]; a place is a joint or [joint, tip offset]
const SEGMENTS = [
	[0.081, J.Head, [J.Head, tipOf("Head")], 0.5], [0.216, J.Spine2, J.Neck, 0.5], [0.139, J.Spine, J.Spine2, 0.5], [0.142, J.Hips, [J.LeftUpLeg, J.RightUpLeg], 0.5],
	...["Left", "Right"].flatMap(s => [[0.028, J[`${s}Arm`], J[`${s}ForeArm`], 0.436], [0.016, J[`${s}ForeArm`], J[`${s}Hand`], 0.43], [0.006, J[`${s}Hand`], [J[`${s}Hand`], tipOf(`${s}Hand`)], 0.4],
		[0.1, J[`${s}UpLeg`], J[`${s}Leg`], 0.433], [0.0465, J[`${s}Leg`], J[`${s}Foot`], 0.433], [0.0145, J[`${s}Foot`], [J[`${s}Foot`], tipOf(`${s}Foot`)], 0.5]]),
];
const FEET = [J.LeftFoot, J.RightFoot], HANDS = [J.LeftHand, J.RightHand], UPLEG = [J.LeftUpLeg, J.RightUpLeg];
// the corners of each sole in the foot's rest frame: the toe tip and 60 mm behind the point under the ankle, 90 mm wide
const SOLES = ["LeftFoot", "RightFoot"].map(n => [tipOf(n), [0, -ANKLE_HEIGHT, -0.06]].flatMap(o => [1, -1].map(x => [o[0] + x * 0.045, o[1], o[2]])));
const POSTURE = new Set(["sit", "kneel", "lie", "push"]), BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie", "launch"]);

/** Whether the switch is on (read once per body and build: the browser has no process). */
const switchedOn = () => globalThis.process?.env?.LOWVIS_BALANCE_ASSIST === "1";

/** The centre of mass of a solved pose (world). */
function centreOf(pose, s) {
	const at = x => (!Array.isArray(x) ? pose.pos[x] : typeof x[1] === "number" ? pose.pos[x[0]].map((v, k) => (v + pose.pos[x[1]][k]) / 2) : pose.pos[x[0]].map((v, k) => v + qRotate(pose.quat[x[0]], x[1])[k] * s));
	const m = [0, 0, 0];
	for (const [w, a, b, t] of SEGMENTS) { const p = at(a), q = at(b); for (let k = 0; k < 3; k++) m[k] += w * (p[k] + (q[k] - p[k]) * t); }
	return m;
}

/** The convex hull of [x, z] points, counter-clockwise (Andrew's monotone chain). */
function hullOf(pts) {
	const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	if (s.length < 3) return s;
	const half = list => { const h = []; for (const q of list) { while (h.length > 1 && cr(h.at(-2), h.at(-1), q) <= 1e-12) h.pop(); h.push(q); } h.pop(); return h; };
	return [...half(s), ...half(s.slice().reverse())];
}

/** How far [x, z] point p must move to lie `margin` inside the hull of pts: [dx, dz], [0, 0] when it does. */
function moveInside(p, pts, margin) {
	const h = hullOf(pts), n = h.length, seg = (a, b) => { const d = [b[0] - a[0], b[1] - a[1]], l = d[0] ** 2 + d[1] ** 2, t = l ? clamp(((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l) : 0; return [a[0] + d[0] * t, a[1] + d[1] * t]; };
	let near = null, nd = Infinity, depth = Infinity, inward = null, inside = n > 2;
	for (let i = 0; i < n; i++) {
		const a = h[i], b = h[(i + 1) % n], q = seg(a, b), d = Math.hypot(p[0] - q[0], p[1] - q[1]);
		if (d < nd) { nd = d; near = q; }
		if (n < 3) continue;
		const e = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(e[0], e[1]) || 1, side = (e[0] * (p[1] - a[1]) - e[1] * (p[0] - a[0])) / l; // > 0: on the inner side of this edge
		if (side < 0) inside = false;
		if (side < depth) { depth = side; inward = [-e[1] / l, e[0] / l]; }
	}
	if (inside) return depth >= margin ? [0, 0] : [inward[0] * (margin - depth), inward[1] * (margin - depth)];
	if (nd < 1e-12) return [0, 0];
	const k = n < 3 ? 1 : (nd + margin) / nd;
	return [(near[0] - p[0]) * k, (near[1] - p[1]) * k];
}

/** The frames the assist leaves alone, seen before the clip is built: [bool] per frame, or null when it leaves all. */
function blockedFrames(c, ctx) {
	const F = ctx.F, B = c.body, acts = (ctx.spec[c.id] ?? []).filter(a => Array.isArray(a)).slice().sort((a, b) => a[0] - b[0]);
	if (Object.values(ctx.props).some(p => p.keys?.some(k => k.verb === "ride" && (k.of === c.id || k.on === c.id)))) return null; // a prop rides on this body
	const sig = b => [b.p[0], b.p[2], ...b.q, ...b.feet.flatMap(ft => [ft.a[0], ft.a[2], ...ft.q])];
	const moved = B.map((b, f) => f > 0 && sig(b).some((v, k) => Math.abs(v - sig(B[f - 1])[k]) > 1e-9));
	const out = new Array(F).fill(false), body = acts.filter(a => BODY.has(a[1])), span = (a, b) => { for (let f = Math.max(0, a); f < Math.min(F, b); f++) out[f] = true; };
	for (let f = 0, last = 0; f < F; f++) {
		if (moved[f]) last = f;
		const b = B[f], under = body.findLast(a => a[0] <= last);
		if (moved[f] || moved[f + 1] || b.air || b.on != null || b.feet.some(ft => (ft.floor ?? 0) > 1e-9) || (under && POSTURE.has(under[1]))) out[f] = true;
	}
	const tilt = c.keys.tilt.find(k => k.to.some(v => Math.abs(v) > 1e-12)); if (tilt) span(tilt.f, F); // a tilted body, from its first tilt
	// a hand, elbow or foot on a target that is not a point of the body frame or a place on the body itself
	const free = (to, foot) => (foot ? to === "plant" || (!to.place && !to.world) : to === "rest" || Array.isArray(to) || (!!to?.joint && !to.of));
	for (const [name, foot] of [["L"], ["R"], ["elbowL"], ["elbowR"], ["footL", true], ["footR", true]]) c.keys[name].forEach((k, i, list) => { if (!free(k.to, foot)) span(k.f, list[i + 1]?.f ?? F); });
	// a prop or a line held, carried or being placed: from the action to the let-go
	for (const e of [...c.events.filter(e => e.holder === c.id), ...(c.lineEvents ?? []).filter(e => !e.off)]) {
		const end = [...c.events.filter(x => x.prop === e.prop && x.holder == null), ...(c.lineEvents ?? []).filter(x => x.prop === e.prop && x.off)].map(x => x.f).filter(f => f >= e.f);
		span(e.f, end.length ? Math.min(...end) + 1 : F);
	}
	return out;
}

/** The per-body plan: the frames left alone and how near each frame is to the next of them, or false (switch off,
 *  or every frame left alone). */
function planOf(c, ctx) {
	if (!switchedOn()) return false;
	const blocked = blockedFrames(c, ctx);
	if (!blocked || blocked.every(Boolean)) return false;
	const room = new Array(ctx.F); // the part of the shift kept: eased to 0 over the `ahead` frames before a frame left alone
	for (let f = ctx.F - 1, next = Infinity; f >= 0; f--) { if (blocked[f]) next = f; room[f] = blocked[f] ? 0 : smooth((next - f) / ASSIST.ahead); }
	return { blocked, room, done: { f: -1, g: 0.85 }, next: null };
}

/** The corners of foot i's sole in pose P (world). */
const cornersOf = (P, i, s) => SOLES[i].map(o => { const d = qRotate(P.quat[FEET[i]], o); return P.pos[FEET[i]].map((v, k) => v + d[k] * s); });
/** The height of the lowest corner of foot i's sole in pose P. */
const soleLow = (P, i, s) => Math.min(...cornersOf(P, i, s).map(p => p[1]));

/** The supports of pose P ([x, z] points) for body state Bn and upper layer U, or null when there are none. */
function supportsOf(P, Bn, U, s) {
	const pts = [];
	for (let i = 0; i < 2; i++) {
		const ft = U.feet?.[i], floor = Bn.feet[i].floor ?? 0, corners = cornersOf(P, i, s), low = Math.min(...corners.map(p => p[1]));
		const lowAt = a => a[1] + Math.min(...SOLES[i].map(o => qRotate(ft.q, o)[1] * s)); // the lowest corner with the ankle at a
		const down = ft ? low <= floor + ASSIST.on * s && (ft.to == null || lowAt(ft.to) <= floor + ASSIST.on * s) : Bn.feet[i].planted;
		if (down) pts.push(...corners.filter(p => p[1] <= low + 0.02 * s).map(p => [p[0], p[2]]));
	}
	U.hands?.forEach((h, i) => { const t = h?.to; if (t && h.done && t[1] <= 0.1 * s && Math.hypot(...P.pos[HANDS[i]].map((v, k) => v - t[k])) <= ASSIST.on * s) pts.push([t[0], t[2]]); }); // a hand on a target on the floor
	return pts.length ? pts : null;
}

/** The solve of body c with its pelvis moved by world [dx, dz] on top of U's hip. With `pose`, the solve without the
 *  shift: a hand still in its blend toward a target (and no elbow target) is held where that pose has it, so it keeps
 *  its path in the world; and a foot off the floor that the shift takes out of the leg's reach goes with the pelvis
 *  (the part of the shift it takes grows from none where its hip joint, moved by the shift, is 94 % of the leg's reach
 *  from it to all of it at 99 %), so its leg is not pulled straight and does not snap back into a bend. */
function shiftedSolve(c, U, d, pose) {
	const l = qRotate(qY(-c.bodyNow.yaw), [d[0], 0, d[1]]), hip = U.hip ?? [0, 0, 0], B = c.bodyNow;
	const hands = pose && U.hands?.map((h, i) => (h?.to && !h.done && !h.elbow ? { ...h, from: pose.pos[HANDS[i]], to: pose.pos[HANDS[i]], w: 1, aimed: (h.from ? 1 - h.w : 0) + h.w, line: true, offset: null, flow: null, lead: null, swing: null } : h));
	const hang = !pose ? [0, 0] : B.feet.map((ft, i) => { // the target as the solver lifts it onto the floor, from the hip joint moved by the shift
		if (ft.planted || soleLow(pose, i, c.s) <= (ft.floor ?? 0) + ASSIST.on * c.s) return 0;
		const h = pose.pos[UPLEG[i]], r = Math.hypot(ft.a[0] - h[0] - d[0], ft.a[1] + pose.lift[i] - h[1], ft.a[2] - h[2] - d[1]) / (LEG_LEN * c.s);
		return smooth((r - 0.94) / 0.05);
	});
	const body = hang.some(Boolean) ? { ...B, feet: B.feet.map((ft, i) => (hang[i] ? { ...ft, a: [ft.a[0] + d[0] * hang[i], ft.a[1], ft.a[2] + d[1] * hang[i]] } : ft)) } : B;
	return solveSized(body, { ...U, hip: [hip[0] + l[0], hip[1], hip[2] + l[2]], ...(hands ? { hands } : {}) }, c.s);
}

/** solveSized for body c on frame f, with the balance assist when it is on. ctx: { spec, props, F, pass }. The engine
 *  solves each frame twice (pass 0, then pass 1 with the targets on other bodies and props current): pass 0 takes the
 *  shift of the frame before as it is, pass 1 works out this frame's from the state the frame before left. */
export function balanceSolve(c, f, U, ctx) {
	if (c.bal === undefined) c.bal = planOf(c, ctx);
	const A = c.bal;
	if (!A) return solveSized(c.bodyNow, U, c.s);
	if (A.next && A.next.f < f) A.done = A.next;
	const s = c.s, off = A.blocked[f] || !!c.tilt || c.bodyNow.on != null, last = A.done.m && A.done.f === f - 1 ? A.done : null;
	if (ctx.pass === 0) return !off && last?.shift ? shiftedSolve(c, U, last.shift) : solveSized(c.bodyNow, U, s);
	const pose = solveSized(c.bodyNow, U, s), m = centreOf(pose, s), hinge = pose.assist.bend + (U.bow ?? 0), was = last ?? { o: [0, 0], v: [0, 0], g: A.done.g, m, t: [0, 0] };
	const keep = (o, v, t, shift = null, g = was.g) => { A.next = { f, o, v, g, m, t, shift, hinge }; };
	if (off) { keep([0, 0], [0, 0], [0, 0]); return pose; }
	// the shift the body needs: its centre of mass taken inside its supports, through the part of it a shift of the pelvis
	// carries (the gain), less what the centre of mass's own speed toward its supports carries it over the time constant
	// of an inverted pendulum of its height, sqrt(h / g) (a body that straightens up over its feet is already coming back;
	// at rest it has no speed); none while the body comes up from a bend (its hinge at the hips, a bow's and the reach
	// assist's together, lessens: solve.js), which takes it back over its feet. The speed is that of the pose
	// without the shift; h is read at the rig's own size, so a body of another size moves as the rig's own figure (size.js)
	const sup = supportsOf(pose, c.bodyNow, U, s), T = 24 * Math.sqrt(Math.max(0.3, m[1] / s) / 9.8), raw = sup ? moveInside([m[0], m[2]], sup, ASSIST.margin * s) : [0, 0], nl = Math.hypot(...raw);
	const rising = was.hinge != null && hinge < was.hinge - 0.0005;
	const back = rising ? nl : nl > 0 ? Math.max(0, ((m[0] - was.m[0]) * raw[0] + (m[2] - was.m[2]) * raw[1]) / nl * T) : 0;
	let t = nl > back ? raw.map(v => v * (nl - back) / nl / was.g) : [0, 0];
	const tl = Math.hypot(...t);
	if (tl > ASSIST.most * s) t = t.map(v => v * ASSIST.most * s / tl);
	// follow it with a limited acceleration: the target's own speed and the most toward it that can still stop on it
	const e = [t[0] - was.o[0], t[1] - was.o[1]], el = Math.hypot(...e), amax = ASSIST.accel * s, sp = Math.min(Math.sqrt(2 * amax * el) * 0.85, 0.5 * el);
	const want = [0, 1].map(n => t[n] - was.t[n] + (el > 1e-12 ? e[n] / el * sp : 0)), dv = [want[0] - was.v[0], want[1] - was.v[1]], dl = Math.hypot(...dv), k = dl > amax ? amax / dl : 1;
	const v = [was.v[0] + dv[0] * k, was.v[1] + dv[1] * k], o = [was.o[0] + v[0], was.o[1] + v[1]];
	// the part of it the body takes: eased away before a frame left alone and in a deep crouch
	const h = pose.pos[J.Hips][1] - Math.max(0, ...c.bodyNow.feet.map(ft => ft.floor ?? 0)), crouch = smooth((h / s - ASSIST.crouch[0]) / (ASSIST.crouch[1] - ASSIST.crouch[0]));
	const part = A.room[f] * crouch, by = w => [o[0] * w, o[1] * w];
	if (Math.hypot(...o) * part < 1e-6 * s) { keep(o, v, t); return pose; }
	// hands first: the shift is cut back while a hand would end further from its target than without it
	const miss = P => U.hands?.map((hd, i) => (hd?.to ? Math.hypot(...P.pos[HANDS[i]].map((x, n) => x - hd.to[n] - (hd.offset?.[n] ?? 0))) : 0)) ?? [], base = miss(pose);
	const ok = P => miss(P).every((d, i) => d <= base[i] + ASSIST.hands * s);
	let w = part, out = shiftedSolve(c, U, by(w), pose);
	if (!ok(out)) { let lo = 0, hi = w; for (let n = 0; n < 8; n++) { const mid = (lo + hi) / 2; if (ok(shiftedSolve(c, U, by(mid), pose))) lo = mid; else hi = mid; } w = lo; out = w > 0 ? shiftedSolve(c, U, by(w), pose) : pose; }
	// how far the centre of mass moved per metre of the pelvis's shift: the next frame's gain
	const ol = Math.hypot(...o) * w, m1 = centreOf(out, s), gain = ol > 0.003 * s ? clamp(((m1[0] - m[0]) * o[0] + (m1[2] - m[2]) * o[1]) * w / (ol * ol), 0.4, 1.2) : was.g;
	keep(o, v, t, w > 0 ? by(w) : null, 0.7 * was.g + 0.3 * gain);
	return out;
}
