// A body off the ground (the body action `launch`): its hips fly under gravity from the last frame on the ground before
// the action to the frame of the next body action, where it comes down. The engine makes the take-off and the landing
// from the speeds of that flight: over the frames before it the hips dip into a crouch and push up onto the toes, and
// their speed along the ground goes over to the flight's; over the frames after it they give into a crouch with the
// speed they come down with and rise again, while the speed along the ground goes over to the next action's. Lengths
// and speeds here are the rig body's (size.js divides them by the body's scale); gravity is 9.8 m/s2 in the world.
import { clamp, mix, mixV, poseEase, qRotate, qSlerp, qY, smooth, wrap } from "./math.js";
import { flowAdd, startScalar } from "./flow.js";
import { STAND_Y, footPose, hold, home, standB } from "./gait.js";
import { LEG_LEN, SOLE } from "./solve.js";
import { pushFoot, strideLegs } from "./air-legs.js";
import { INDEX as J, OFFSET, REST } from "../rig17.js";

const FPS = 24, G = 9.8 / FPS / FPS; // m per frame per frame, in the world
/** The push of the legs, m/s2: the hips' speed as they leave the ground, squared, over twice their rise from the lowest
 *  point of the crouch, in five captured running jumps 7 to 12 (mean 9.4 at 120 samples a second); the give after the
 *  landing, the same way, 7 to 15 (HARD: the hardest). */
export const PUSH = 9.3;
const HARD = 15;
const TOES = 0.13, CROUCH = 0.3; // m of the rig body: hips over standing as the feet push off or touch down on their toes (captured 0.06-0.13); deepest crouch before a push and after a landing that PUSH can give
const DEEP = STAND_Y - REST[J.LeftLeg][1]; // the deepest a landing gives that comes down faster than HARD takes up in CROUCH: hips down to the knees' standing height (0.50 m of the rig body)
const DIP = 7, RISE = 10, EDGE = 2; // frames: into the crouch before the push, back up after the landing's give, of speed change along the ground past the push and the give

const UPLEG = [J.LeftUpLeg, J.RightUpLeg];
const xz = p => [p[0], p[2]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]], sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** How far the hips of body frame B are under standing over the floor its feet are on (a crouch, a seat, a kneel, a lie: the legs straighten from there as they push or give). */
const low = B => Math.max(0, STAND_Y + Math.max(...B.feet.map(ft => ft.floor ?? 0)) - B.p[1]);
/** How far the hips of body frame B can go down from there: to `deep` under standing (none from a seat, a kneel or a lie). */
const room = (B, deep = CROUCH) => clamp(deep - low(B), 0, deep);

/** The up and down of a flight of T frames whose landing frame's hips are dy over its take-off frame's (g, acc: gravity
 *  and the legs' push, per frame per frame). The hips leave ra over the take-off frame's height at v0 a frame and come
 *  down rb over the landing frame's at v1: on the toes of straight legs (lowA, lowB: low() at both ends), or for a hop
 *  too small for that as high as its push or give reaches. Before it they dip cUp over `dip` frames and push for tUp
 *  frames; after it they give cDn over tDn frames: as PUSH takes the speed up, no deeper than roomB; a faster landing
 *  is given harder, up to `hard`, and only one faster than that deeper, down to deepB. n: the frames on the ground
 *  before it (the dip and the push take no more); roomA, roomB, deepB: room() at both ends. */
function upDown(dy, T, g, acc, n, roomA, roomB, lowA = 0, lowB = 0, deepB = roomB, hard = acc) {
	let ra = n ? TOES + lowA : 0, rb = TOES + lowB, v0 = 0, v1 = 0;
	const speeds = () => { v0 = (dy + rb - ra) / T + g * T / 2; v1 = v0 - g * T; };
	for (let i = 0; i < 40; i++) { // ra and rb follow from the speeds and the speeds from them: settled step by step
		speeds();
		ra += ((v0 > 0 ? Math.min(lowA + Math.min(TOES, v0 * v0 / (4 * acc)), v0 * n / 2) : 0) - ra) / 4;
		rb += ((v1 < 0 ? lowB + Math.min(TOES, v1 * v1 / (4 * acc)) : 0) - rb) / 4;
	}
	speeds();
	const up = v0 > 0, down = v1 < 0, want = up ? Math.max(0, v0 * v0 / (2 * acc) - ra) : 0;
	// with few frames on the ground the dip is as much shallower as it is shorter, so it is never faster than a whole one
	const cUp = up ? Math.min(want, roomA, Math.max(0, roomA * (n - 2 * ra / v0) / (DIP + 2 * roomA / v0))) : 0, tUp = up ? 2 * (cUp + ra) / v0 : 0;
	const cDn = down ? Math.max(clamp(v1 * v1 / (2 * acc) - rb, 0, roomB), clamp(v1 * v1 / (2 * hard) - rb, 0, deepB)) : 0, tDn = down ? 2 * (cDn + rb) / -v1 : 0;
	// short: the frames the ground before it lacks for the whole dip and push that speed takes
	const rAll = up ? lowA + Math.min(TOES, v0 * v0 / (4 * acc)) : 0, cAll = Math.min(roomA, Math.max(0, v0 * v0 / (2 * acc) - rAll)), all = up ? (cAll > 0 ? DIP : 0) + 2 * (cAll + rAll) / v0 : 0;
	return { ra, rb, v0, v1, cUp, tUp, dip: cUp > 0 ? Math.min(DIP, n - tUp) : 0, cDn, tDn, short: Math.max(0, Math.round(all) - n) };
}

/** The hips over the landing frame's height t frames after they touch down rb over it at v1 a frame: they give cDn over
 *  tDn frames and rise again over RISE. */
const settle = (t, rb, v1, cDn, tDn) => (t < tDn ? rb + v1 * t - 0.5 * v1 / tDn * t * t : -cDn * (1 - smooth((t - tDn) / RISE)));
/** The give of a landing on frame b with plan P (upDown) beside the spec's hip keys (lower: how far they lower the hips
 *  on a frame, null: none): on no frame do the give and they together lower the hips deeper than the give alone may
 *  (`deep`: to the knees' standing height), or than they alone do on that frame. The give is the deepest that keeps to
 *  that, and as much quicker as it is shallower, with the same speed at the touch-down. launch() plans the flight
 *  along the ground with the same give. Returns { cDn, tDn }. */
function give(P, deep, lower, b) {
	const { rb, v1 } = P, frames = c => 2 * (c + rb) / -v1;
	const fits = c => { for (let t = 0, tDn = frames(c); t <= tDn + RISE; t++) if (-settle(t, rb, v1, c, tDn) > Math.max(0, deep - lower(b + t)) + 1e-9) return false; return true; };
	if (!lower || !(P.cDn > 0) || fits(P.cDn)) return { cDn: P.cDn, tDn: P.tDn };
	let lo = 0, hi = P.cDn;
	for (let i = 0; i < 30; i++) { const c = (lo + hi) / 2; if (fits(c)) lo = c; else hi = c; }
	return { cDn: lo, tDn: frames(lo) };
}

/** The frames of a launch action of n frames from state st. o: { to?: [x, z], vel?: [x, y, z] (m/s, world; to is then
 *  not read), heading? (rad) }; at: { out: the frames before it, before: the frame it leaves from in this action's own
 *  frame of reference (null: the last of out), s: the body's scale, f0: its frame, lo: the frame the flight before it
 *  came down on (0: none), was: that flight, up: how high over the floor the drawn top is that it stands on and leaves,
 *  wait: frames it stands first, lift: shiftOf() of its tilt keys (null: none), lower: as fly() gets it }. Returns
 *  { frames, st, flight }: the frames in the air (with vel, then the frames it stands where it came down), the state
 *  it lands in, and the flight for fly() (null: it never leaves; along: its step along the ground a frame). */
export function launch(st, n, o, { out, before, s, f0, lo, was, up = 0, wait = 0, lift, lower }) {
	if (wait) { const stood = hold(st, wait), r = launch(st, n - wait, o, { out: [...out, ...stood], before: stood.at(-1), s, f0: f0 + wait, lo, was, up, lift, lower }); return { ...r, frames: [...stood, ...r.frames] }; }
	before ??= out.at(-1) ?? hold(st, 1)[0];
	const yaw = o.heading ?? st.yaw, g = G / s, acc = PUSH / FPS / FPS / s, a = f0 - 1;
	// the step along the ground on frame k of the frames before (the frames of the flight before it stand where it left, then where it landed: its steps are that flight's)
	const v = k => (was && k >= was.f0 && k <= was.f1 ? was.along : k > 0 && k < out.length ? sub2(xz(out[k].p), xz(out[k - 1].p)) : [0, 0]);
	const moved = t => (lift ? sub3(lift(a, lo || null), lift(a + t, a + t)) : [0, 0, 0]); // how far a pose's shift has the body from where it has it after t frames in the air (shiftOf)
	const fall = t => before.p[1] + up - STAND_Y + moved(t)[1]; // how far the hips are over where they stand on the floor then
	const plan = t => upDown(-fall(t), t, g, acc, a - lo, room(before), CROUCH, low(before), 0, DEEP, HARD / FPS / FPS / s); // of a flight of t frames after which it stands there
	let fast = [0, 0]; // the speed along the ground it had: that of its fastest frame in the second before
	for (let k = Math.max(1, f0 - FPS); k < f0; k++) if (Math.hypot(...v(k)) > Math.hypot(...fast)) fast = v(k);
	let T = n + 1; // frames from the last frame on the ground to the first again
	if (Array.isArray(o.vel)) { // thrown: in the air the whole number of frames whose flight leaves nearest that speed up, unless the next body action comes first
		const vel = o.vel.map(x => x / FPS / s), reach = t => Math.round((vel[1] + Math.sqrt(vel[1] ** 2 + 2 * g * Math.max(0, fall(Math.max(1, t))))) / g); // the frames gravity takes down to where it stands after t
		let near = reach(1); for (let i = 0; i < 8 && reach(near) > near; i++) near = reach(near); // (a shift's key may lower that place while it flies: the first time the two agree)
		T = Math.max(1, near);
		for (let k = Math.max(1, near - 3); k <= near + 3; k++) if (Math.abs(plan(k).v0 - vel[1]) < Math.abs(plan(T).v0 - vel[1])) T = k;
		T = Math.min(n + 1, T); fast = [vel[0], vel[2]];
	}
	if (T < 2 || n < 1) return { frames: hold(st, n), st, flight: null }; // no frame in the air
	// fly()'s sum of the take-off, the flight and the landing, for a body that then stands: where that speed takes the hips, or with `to` the speed that takes them there
	const P = plan(T), wa = Math.max(lo, Math.round(a - P.tUp - EDGE)), m = a - wa, ml = Math.max(0, Math.round(give(P, DEEP, lower, f0 + Math.min(n, T - 1)).tDn + EDGE)), span = T + (m ? (m + 1) / 2 : 0) + (ml ? (ml - 1) / 2 : 0);
	const stand = xz(standB({ ...st, p: [0, 0], yaw }).p), slow = v(wa).map(x => x * (m ? (m - 1) / 2 : 0));
	let to = Array.isArray(o.vel) ? null : o.to, hips = xz(before.p);
	for (let k = wa + 1; k <= a; k++) hips = sub2(hips, v(k));
	if (Array.isArray(to)) fast = sub2(sub2(add2(sub2(to, xz(moved(T))), stand), hips), slow).map(x => x / span);
	else to = add2(sub2(add2(hips, [0, 1].map(i => slow[i] + fast[i] * span)), stand), xz(moved(T)));
	const land = { p: to.slice(), yaw, feet: [1, -1].map(side => ({ g: home(to, yaw, side), yaw })) };
	const air = Array.from({ length: Math.min(n, T - 1) }, () => ({ ...before, p: before.p.slice(), feet: before.feet.map(ft => ({ ...ft, planted: false })) }));
	const after = Array.from({ length: n - air.length }, () => standB(land));
	return { frames: [...air, ...after], st: land, flight: { f0, f1: f0 + air.length, along: fast } };
}

/** Puts each flight's hips on the path gravity gives from the last frame on the ground to the first again and makes its
 *  take-off and landing from the speeds of that path (the head of this file). out: the body frames (rig body, where
 *  they are in the world); s: the body's scale. A frame in the air gets B.air = the flight; the flight gets short: the
 *  frames the ground before it lacked for its whole dip and push. lower: lowerOf() of the spec's hip keys in the rig
 *  body's lengths, 0 past the clip's end (null: none; give()). */
export function fly(out, flights, s, lower = null) {
	const F = out.length, g = G / s, acc = PUSH / FPS / FPS / s;
	flights.forEach((fl, n) => {
		const a = fl.f0 - 1, b = fl.f1, T = b - a;
		if (a < 0 || T < 1) return;
		const lo = n ? flights[n - 1].f1 : 0, hi = flights[n + 1] ? flights[n + 1].f0 - 1 : F - 1, end = out[Math.min(b, F - 1)], A0 = out[a], push = pushFoot(A0);
		const base = out.map(B => xz(B.p)), d = k => (k > 0 ? sub2(base[k], base[k - 1]) : [0, 0]); // the steps along the ground before this flight moves them
		const P = upDown(end.p[1] - A0.p[1], T, g, acc, a - lo, room(A0), room(end), low(A0), low(end), room(end, DEEP), HARD / FPS / FPS / s), ya = A0.p[1] + P.ra;
		const { rb, v0, v1, cUp, tUp, dip, short } = P, { cDn, tDn } = give(P, room(end, DEEP), lower, b);
		// along the ground: from the speed at the start of the take-off to the flight's, and from it to the speed at the end of the landing
		// (the legs change it while they push and while they give: over the push and the give and EDGE frames more)
		const va = Math.max(lo, Math.round(a - Math.max(dip, EDGE) - tUp)), vb = Math.min(hi, Math.round(b + tDn + RISE)), wa = Math.max(va, Math.round(a - tUp - EDGE)), wb = Math.min(vb, Math.round(b + tDn + EDGE));
		const us = d(wa), ue = wb > b && wb < F - 1 ? d(wb) : [0, 0];
		let Ka = 0, Ja = 0, Kl = 0, Jl = 0, dispA = [0, 0], dispB = [0, 0];
		for (let k = wa + 1; k <= a; k++) { const w = (k - wa) / (a - wa); Ka += w; Ja += 1 - w; dispA = add2(dispA, d(k)); }
		for (let k = b + 1; k <= wb; k++) { const w = (k - b) / (wb - b); Kl += 1 - w; Jl += w; dispB = add2(dispB, d(k)); }
		const vh = [0, 1].map(i => (xz(end.p)[i] - xz(A0.p)[i] - ue[i] * Jl + dispB[i] - us[i] * Ja + dispA[i]) / (T + Kl + Ka));
		// the take-off: the speed along the ground, and the dip and push of the hips
		let off = [0, 0];
		for (let k = va + 1; k <= a; k++) {
			const w = (k - wa) / (a - wa), t = k - a;
			if (k > wa) off = add2(off, sub2([mix(us[0], vh[0], w), mix(us[1], vh[1], w)], d(k)));
			move(out, k, off, !(tUp > 0) ? 0 : t >= -tUp ? -cUp + 0.5 * v0 / tUp * (t + tUp) ** 2 : dip > 0 ? -cUp * smooth((t + tUp + dip) / dip) : 0);
		}
		// the landing: the speed along the ground goes over to the one after; the hips give and rise again
		const back = [];
		off = [0, 0];
		for (let k = vb; k > wb; k--) back[k] = off;
		for (let k = wb; k >= b; k--) { back[k] = off; if (k > b) { const w = (k - b) / (wb - b); off = sub2(off, sub2([mix(vh[0], ue[0], w), mix(vh[1], ue[1], w)], d(k))); } }
		back[b] = off;
		const pa = xz(out[a].p), pb = add2(xz(end.p), off);
		for (let k = b; k <= vb && k < F; k++) {
			const t = k - b;
			move(out, k, back[k], settle(t, rb, v1, cDn, tDn));
		}
		// the flight: the hips on the parabola; the feet go with them from where they left to where they come down (from a stride: below)
		const L = out[Math.min(b, F - 1)], fa = out[a].feet.map(ft => sub3(ft.a, out[a].p)), fb = L.feet.map(ft => sub3(ft.a, L.p)), vx = sub2(pb, pa);
		for (let k = a + 1; k < b && k < F; k++) {
			const t = k - a, u = t / T, w = smooth(u), p = [pa[0] + vx[0] * u, ya + v0 * t - 0.5 * g * t * t, pa[1] + vx[1] * u];
			out[k] = { ...out[k], p, q: qSlerp(out[a].q, L.q, w), yaw: out[a].yaw + wrap(L.yaw - out[a].yaw) * w, lean: mix(out[a].lean, L.lean, w), air: fl,
				feet: out[k].feet.map((ft, i) => ({ ...ft, a: add3(p, mixV(fa[i], fb[i], w)), q: qSlerp(out[a].feet[i].q, L.feet[i].q, w), planted: false })) };
		}
		// a flight from a stride: the legs of captured flights (air-legs.js)
		const way = Math.hypot(...vx) > 1e-3 * T ? vx : [Math.sin(out[a].yaw), Math.cos(out[a].yaw)], l = Math.hypot(...way);
		strideLegs(out, { a, b, push, fwd: [way[0] / l, 0, way[1] / l], lo, down: tDn, hi: hi - 1, s });
		fl.short = short;
	});
}

/** Where the shift of a character's tilt keys (spec-layers.js buildUpper) moves its body on frame f, world [x, y, z]:
 *  the tilt as engine.js blends it (its scalar(): each key from where the field is, by its ease, with the flow of keys
 *  that pass each other, flow.js). With b, the frame a flight comes down on: from b on, the key in effect on b has the
 *  value it ends on, at the end of its blend or on the frame before the next key (the body comes down where that key
 *  brings it, and the rest of its blend is the flight's). null with no tilt key. */
export function shiftOf(keys) {
	const at = keyed(keys, [0, 0, 0, 0, 0], 0);
	return at && ((f, b) => at(f, b).slice(2, 5));
}
/** How far the spec's hip keys lower the hips on frame f (m, world; 0 where they raise them), as engine.js blends them. null with no hip key. */
export function lowerOf(keys) {
	const at = keyed(keys, [0, 0, 0], 1);
	return at && (f => Math.max(0, -(at(f)[1] ?? 0)));
}
/** The value of a vector field's keys on frame f as engine.js blends it (its scalar(): each key from where the field is, by
 *  its ease, with the flow of keys that pass each other, flow.js; mj as scalar() has it for the field: 0 for tilt, 1 for
 *  hip); with b (shiftOf), from b on as the key in effect on b ends. null with no key. */
function keyed(keys, zero, mj) {
	if (!keys?.length) return null;
	const ks = keys.map(k => ({ ...k })), seen = []; // copies (a key's start is written on it); seen[f]: the value on frame f
	const value = f => {
		for (let g = seen.length; g <= f; g++) {
			const k = ks.findLast(x => x.f <= g);
			if (k && k.from === undefined) startScalar(ks, k, g, seen[g - 1] ?? undefined, seen[g - 2] ?? undefined, zero, mj);
			const u = k && (k.over > 0 ? (g - k.f) / k.over : 1), on = k && k.over > 0 && flowAdd(k.m0, k.m1, u, k.over, mj);
			seen.push(k ? mixV(k.from, k.to, (poseEase(k.ease, mj) ?? poseEase("inout", mj))(u)).map((x, n) => (on ? x + on[n] : x)) : null);
		}
		return seen[f];
	};
	return (f, b) => {
		const i = b == null || f < b ? -1 : ks.findLastIndex(x => x.f <= b), k = ks[i], end = k && Math.min(k.f + k.over, (ks[i + 1]?.f ?? Infinity) - 1);
		return value(k && f < end ? end : f) ?? zero;
	};
}
/** Body frame B moved by d (world), its feet and the floor under them with it (sign -1: back). */
export const raised = (B, d, sign) => ({ ...B, p: B.p.map((v, i) => v + sign * d[i]), feet: B.feet.map(ft => ({ ...ft, a: ft.a.map((v, i) => v + sign * d[i]), floor: (ft.floor ?? 0) + sign * d[1] })) });

/** Moves frame k's hips by off along the ground and y up; a planted foot rises onto its toes as the hips rise over standing. */
function move(out, k, off, y) {
	const B = out[k];
	out[k] = { ...B, p: [B.p[0] + off[0], B.p[1] + y, B.p[2] + off[1]] };
	out[k].feet = B.feet.map((ft, i) => (ft.planted ? onToes(ft, add3(out[k].p, qRotate(qY(B.yaw), OFFSET[UPLEG[i]]))) : ft));
}
/** A planted foot pitched on its toe tip (at most 60 deg) until its ankle is in reach of its hip joint at `hip`. */
function onToes(ft, hip) {
	const reach = ankle => Math.hypot(...sub3(hip, ankle)) <= 0.99 * LEG_LEN;
	if (reach(ft.a)) return ft;
	const g = add3(ft.a, qRotate(ft.q, SOLE)), fwd = qRotate(ft.q, [0, 0, 1]), yaw = Math.atan2(fwd[0], fwd[2]), at = m => footPose([g[0], g[2]], g[1], yaw, m);
	let lo = 0, hi = Math.PI / 3;
	for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (reach(at(m).a)) hi = m; else lo = m; }
	const on = at(hi);
	if (reach(on.a)) return { ...ft, ...on };
	const d = sub3(on.a, hip), l = Math.hypot(...d) / (0.99 * LEG_LEN); // out of reach on its toes too: it leaves the floor toward the hip
	return { ...ft, q: on.q, a: add3(hip, [d[0] / l, d[1] / l, d[2] / l]), planted: false };
}
