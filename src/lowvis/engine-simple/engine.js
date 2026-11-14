// engine-simple: a small deterministic motion engine for the 17-joint figure. Pure JS on rig17.js; Node and browser.
//
// SPEC FORMAT. A spec is { demo, <characterId>: [[frame, verb, options], ...] }. The scene (start positions,
// props, frame count) comes from demos.js. An action lasts until the next action of the same layer.
//   Body layer (feet and pelvis):
//     idle | walk {to:[x,z], heading?, facing?, steps?, burst?, first?:"L"|"R", end?:{L:[left,fwd],R:[..]}, stepFrames?, ease?} | run {to} | push {to} | turn {heading}
//     sit {on:propId} | stand | kneel | lie {on:propId, head:deg}
//     Consecutive walk / run actions are one flowing path. `heading` is the arrival heading (the path curves, or a
//     turn on the spot is added). `facing` keeps the body facing that way (back / side steps). `steps: 1` is a lunge.
//     `push` is a low, leaning, short-step gait; `push {to: <where it stands>}` braces in place.
//     With `steps`: `stepFrames` = frames per step (default: at most 13, then it stands), `ease` = how the pelvis
//     covers the distance ("in" = it speeds up, so each step is longer than the one before; default "inout").
//   Upper layer (each field keeps its value until a later action changes it; `over` = blend frames, `ease` = name):
//     pose {hands|L|R: target, lean:deg (chest), bow:deg (hinge at the hips), twist:deg, hipTurn:deg, hip:[x,y,z], look: id|[x,y,z]|"fwd", nod:n, shake:n,
//           aim:[x,y,z]|"off", fast:true, over, ease}     aim = where the long axis of the prop in the hand points, body frame
//       hand target: "rest" | [x,y,z] in the body frame from the Hips joint (x = own left, z = forward)
//                    | {prop:id} | {prop:id, face:true, y, w} | {meet:id} | {chest:id} | {world:[x,y,z]}
//     carry {prop, at:[x,y,z], over}   the prop follows both hands from this frame; no `at` = hands stay as they are;
//                                      slide:true = the prop only slides on the floor with the hands (a push)
//     hold {prop, hand:"R"|"L"}        the prop is fixed in one hand (its long z axis along the thumb side)
//     release {prop, roll?}            the prop stays where it is; roll:true = it keeps the hand's velocity, drops to
//                                      the floor under it and rolls on until one of its own keys starts
//     pose {footL|footR: target, over, ease}   takes one foot off the floor: it leaves the body layer and goes to the
//       target along an arc about its hip; "plant" gives it back to the body layer (blend it into a step or a stance).
//       foot target: [x,y,z] | {at:[x,y,z], pitch:deg} | {world:[x,y,z], pitch:deg} | "plant". The point is the ankle
//       joint; `at` is in the body frame from the floor point under the Hips joint (y = height over the floor);
//       pitch > 0 points the toes down. The other foot keeps the body; nothing checks the balance.
//     Hands blend along an arc about the shoulder and move at most 0.12 m per frame in the body frame unless fast.
//     look: a character id, a prop id (its top), a world point or "fwd"; with no target the gaze stays level.
//     place {prop, at:[x,y,z] world, over}   the hands take the prop there and let go
//   Prop layer: <propId>: [[frame, verb, options], ...] moves a free prop by keys:
//     tip {pivot:[x,y,z], axis:[x,y,z], deg, over, ease} | move {to:[x,y,z], axis?, deg?, over, ease}
//     launch {vel:[x,y,z] m/s, bounce?: 0.5, friction?: 1.5}   a kicked / thrown prop: it is still in place on the key's
//       frame and flies from the next one under gravity, bounces off the floor and off static props (as a ball of
//       diameter size[1]; bounce = speed kept), rolls with `friction` (m/s2) and stops. A later key of the prop ends it.
//       The frame is written by hand; checks.js measures how far the nearest foot is from the prop on that frame.
// Angles in a spec are degrees; lengths are metres.
import { DEMOS } from "../demos.js";
import { INDEX as J, OFFSET, qAxisAngle } from "../rig17.js";
import { addCharacter, addProp, createClip, setPose } from "../clip.js";
import { EASE, add, clamp, dot, len, mix, mixV, mul, norm, qConj, qMul, qRotate, qSlerp, qX, qY, rad, sub } from "./math.js";
import { arc, solve } from "./solve.js";
import { hold, home, locomote, shuffle } from "./gait.js";
import { kneel, lie, sit, stand } from "./posture.js";

const BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);
const HAND = [J.LeftHand, J.RightHand], FOOT = [J.LeftFoot, J.RightFoot], UPLEG = [J.LeftUpLeg, J.RightUpLeg];
const PAD = 0.03; // wrist centre to the surface it holds

export const NOTES = [
	"simple engine: no collision between bodies, limbs and props; contacts are where the spec puts them",
	"no fingers and no wrist detail: a hand is one box aligned with the forearm",
	"kneel is symmetric (both knees together); lying down is one blended roll, not a hand-supported descent",
	"reach assist bends the hips and knees toward low targets only; it does not step toward a far target",
	"a slow walk beat arrives early and stands; it is not stretched to fill the beat",
	"run is a short-stride jog at the demo's speed (about 1.2 m/s)",
	"a prop in one hand is held by that hand only (no second hand on the grip); its long axis must be its z axis",
	"a pushed prop slides with the hands; friction and weight are in the gait's timing, not simulated",
	"a keyed prop (the falling trunk, the pins) follows its keys; nothing checks that it misses the figure, and the frame a rolling prop hits something is written in the spec by hand",
	"a released prop keeps the hand's velocity exactly, so a swing that is not straight sends it off line",
	"elbow and knee directions come from one fixed pole hint; there is no hands-on-hips or crossed-arms pose",
];

function buildBody(c, acts, F, ctx) {
	const yaw = rad(c.heading), list = acts.filter(a => BODY.has(a[1])).map(([f, verb, o = {}]) => ({ f, verb, o }));
	if (!list.length || list[0].f > 0) list.unshift({ f: 0, verb: "idle", o: {} });
	let st = { p: c.at.slice(), yaw, feet: [1, -1].map(s => ({ g: home(c.at, yaw, s), yaw })) };
	const out = [], end = i => list[i + 1]?.f ?? F, moving = a => a && (a.verb === "walk" || a.verb === "run" || a.verb === "push");
	const seg = (a, N) => ({ kind: a.verb, to: a.o.to, N, steps: a.o.steps, burst: a.o.burst, first: a.o.first, end: a.o.end, stepFrames: a.o.stepFrames, ease: a.o.ease, heading: a.o.heading == null ? null : rad(a.o.heading), facing: a.o.facing == null ? null : rad(a.o.facing) });
	const special = a => a.o.steps != null || a.o.facing != null || a.o.end != null || a.o.first != null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i], N = end(i) - a.f, prop = ctx.props[a.o.on];
		let r;
		if (moving(a)) {
			const segs = [seg(a, N)];
			while (moving(list[i + 1]) && !special(list[i]) && !special(list[i + 1])) { i++; segs.push(seg(list[i], end(i) - list[i].f)); }
			r = locomote(st, segs);
		} else if (a.verb === "turn") r = shuffle(st, N, { yaw: rad(a.o.heading) });
		else if (a.verb === "sit") {
			const top = prop ? prop.c[1] + prop.size[1] / 2 : a.o.height, d = prop ? Math.hypot(prop.c[0] - st.p[0], prop.c[2] - st.p[1]) : 0.33;
			r = sit(st, N, { y: top, back: Math.min(0.35, d) });
		} else if (a.verb === "stand") r = st.seat ? stand(st, N) : { frames: hold(st, N), st };
		else if (a.verb === "kneel") r = kneel(st, N, ctx.ground);
		else if (a.verb === "lie") {
			const head = rad(a.o.head ?? c.heading), at = prop ? [prop.c[0] + Math.sin(head) * 0.1, prop.c[2] + Math.cos(head) * 0.1] : a.o.at;
			r = lie(st, N, { at, head, floor: ctx.ground(at[0], at[1]) });
		} else { // idle: hold the posture, breathe
			r = { frames: hold(st, N), st };
			r.frames.forEach((B, k) => { B.lean += 0.012 * Math.sin(2 * Math.PI * k / 84) * smoothEdge(k, N); });
		}
		out.push(...r.frames); st = r.st;
	}
	// soften pelvis height and lean so action boundaries have no kinks (the solver still guarantees leg reach)
	const blur = (get, set) => {
		for (let pass = 0; pass < 3; pass++) {
			const v = out.map(get);
			out.forEach((B, f) => set(B, 0.25 * v[Math.max(0, f - 1)] + 0.5 * v[f] + 0.25 * v[Math.min(F - 1, f + 1)]));
		}
	};
	blur(B => B.p[1], (B, v) => { B.p[1] = v; });
	blur(B => B.lean, (B, v) => { B.lean = v; });
	return out;
}
const smoothEdge = (k, N) => clamp(Math.min(k, N - 1 - k) / 12);

function buildUpper(id, acts, props) {
	const keys = { L: [], R: [], footL: [], footR: [], lean: [], twist: [], hipTurn: [], bow: [], hip: [], look: [], aim: [] }, events = [];
	for (const [f, verb, o = {}] of acts) {
		if (BODY.has(verb)) continue;
		const k = { f, over: o.over ?? 12, ease: o.ease ?? "inout", fast: o.fast };
		if (verb === "carry") {
			const half = props[o.prop].size[0] / 2 + PAD, at = o.at;
			keys.L.push({ ...k, pair: true, to: at ? [at[0] + half, at[1], at[2]] : "keep" }); keys.R.push({ ...k, pair: true, to: at ? [at[0] - half, at[1], at[2]] : "keep" });
			events.push({ f, prop: o.prop, holder: id, slide: !!o.slide });
		} else if (verb === "hold") events.push({ f, prop: o.prop, holder: id, hand: o.hand === "L" ? 0 : 1, grip: o.grip });
		else if (verb === "release") events.push({ f, prop: o.prop, holder: null, roll: o.roll });
		else if (verb === "place") {
			keys.L.push({ ...k, pair: true, to: { at: o.at, prop: o.prop } }); keys.R.push({ ...k, pair: true, to: { at: o.at, prop: o.prop } });
			events.push({ f: f + k.over, prop: o.prop, holder: null, at: o.at });
		} else if (verb === "pose") {
			const L = o.L ?? o.hands, R = o.R ?? (Array.isArray(o.hands) ? [-o.hands[0], o.hands[1], o.hands[2]] : o.hands);
			if (L !== undefined) keys.L.push({ ...k, to: L, shake: o.shake });
			if (R !== undefined) keys.R.push({ ...k, to: R, shake: o.shake });
			for (const side of ["footL", "footR"]) if (o[side] !== undefined) {
				const t = o[side];
				keys[side].push({ ...k, to: t === "plant" ? t : { at: Array.isArray(t) ? t : t.at, world: t.world, pitch: rad(t.pitch ?? 0) } });
			}
			if (o.lean !== undefined) keys.lean.push({ ...k, to: rad(o.lean) });
			if (o.twist !== undefined) keys.twist.push({ ...k, to: rad(o.twist) });
			if (o.hipTurn !== undefined) keys.hipTurn.push({ ...k, to: rad(o.hipTurn) });
			if (o.bow !== undefined) keys.bow.push({ ...k, to: rad(o.bow) });
			if (o.aim !== undefined) keys.aim.push({ ...k, to: o.aim });
			if (o.hip !== undefined) keys.hip.push({ ...k, to: o.hip });
			if (o.look !== undefined || o.nod) keys.look.push({ ...k, to: o.look ?? keys.look.at(-1)?.to ?? "fwd", nod: o.nod });
		} else throw new Error(`engine-simple: unknown verb "${verb}"`);
	}
	return { keys, events };
}

/** Builds a clip from a spec. Returns { clip, aux } where aux has the per-frame contact and carry flags for checks.
 *  aux.reach[characterId][frame] = [L hand, R hand, L foot, R foot], each null or { key, d }: d metres between the limb
 *  and the target the action of frame `key` gave it, on the frames after that action's blend has ended. */
export function buildClip(spec, def = DEMOS[spec.demo]) {
	const F = def.frames, clip = createClip({ demo: spec.demo, engine: "simple", frameCount: F });
	const props = Object.fromEntries(def.props.map(p => [p.id, {
		id: p.id, size: p.size, c: p.at.slice(), yaw: 0, q: [0, 0, 0, 1], holder: null, hand: null, moves: !!p.moves, h1: p.at.slice(), h2: p.at.slice(),
		keys: (spec[p.id] ?? []).map(([f, verb, o = {}]) => ({ f, verb, ...o })).sort((a, b) => a.f - b.f),
	}]));
	const ground = (x, z) => Math.max(0, ...Object.values(props).filter(p => !p.moves && p.c[1] + p.size[1] / 2 <= 0.3 && Math.abs(x - p.c[0]) <= p.size[0] / 2 && Math.abs(z - p.c[2]) <= p.size[2] / 2).map(p => p.c[1] + p.size[1] / 2));
	const chars = def.characters.map(c => {
		const acts = (spec[c.id] ?? []).slice().sort((a, b) => a[0] - b[0]);
		return { id: c.id, body: buildBody(c, acts, F, { props, ground }), ...buildUpper(c.id, acts, props), out: addCharacter(clip, c.id), rest: [true, true], up: [0, 0], last: {}, cur: {}, pose: null };
	});
	const byId = Object.fromEntries(chars.map(c => [c.id, c]));
	const outProps = def.props.map(p => ({ p: props[p.id], out: Object.assign(addProp(clip, p.id, p.size, p.moves ? F : 1), p.shape ? { shape: p.shape } : {}) }));
	const aux = { contacts: Object.fromEntries(chars.map(c => [c.id, []])), holders: Object.fromEntries(def.props.map(p => [p.id, []])), placed: [] };
	Object.assign(aux, {
		grips: Object.fromEntries(def.props.map(p => [p.id, []])), keyed: Object.fromEntries(def.props.map(p => [p.id, []])), slid: {},
		rolling: Object.fromEntries(def.props.map(p => [p.id, []])), releases: [], launches: [],
		keyStarts: def.props.filter(p => props[p.id].keys.length).map(p => ({ prop: p.id, f: props[p.id].keys[0].f })),
		reach: Object.fromEntries(chars.map(c => [c.id, []])),
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
				const d = p.c.map((v, a) => v - clamp(v, o.c[a] - o.size[a] / 2, o.c[a] + o.size[a] / 2)), l = len(d);
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
	const follow = (p, pose) => {
		if (p.hand != null) { p.q = pose.quat[HAND[p.hand]]; p.c = add(pose.pos[HAND[p.hand]], qRotate(p.q, p.grip)); return; }
		const h = handLine(pose);
		if (p.slide) { p.c = [h.mid[0] - p.off[0], p.c[1], h.mid[2] - p.off[2]]; return; }
		p.yaw = h.yaw + p.yawOff; p.q = qY(p.yaw); p.c = sub(h.mid, qRotate(p.q, p.off));
	};
	// where hand s of a character at B holds a box centred at c: on its left / right face, a little toward the holder
	const grab = (c, p, B, s) => {
		const d = [B.p[0] - c[0], B.p[2] - c[2]], l = Math.hypot(d[0], d[1]) || 1, dx = d[0] / l, dz = d[1] / l, half = p.size[0] / 2 + PAD;
		return [c[0] - dz * s * half + dx * 0.07, c[1], c[2] + dx * s * half + dz * 0.07];
	};
	const handTarget = (c, i, to, f) => {
		const B = c.body[f], s = i ? -1 : 1;
		if (Array.isArray(to)) return add(B.p, qRotate(qY(B.yaw), to));
		if (to.world) return to.world;
		if (to.face) { // palms on the face of the box that looks at the figure
			const p = props[to.prop], d = [B.p[0] - p.c[0], B.p[2] - p.c[2]], alongX = Math.abs(d[0]) > Math.abs(d[1]);
			const dx = alongX ? Math.sign(d[0]) : 0, dz = alongX ? 0 : Math.sign(d[1]), out = (alongX ? p.size[0] : p.size[2]) / 2 + PAD, w = to.w ?? 0.2;
			return [p.c[0] + dx * out - dz * s * w, to.y ?? p.c[1], p.c[2] + dz * out + dx * s * w];
		}
		if (to.at) return grab(to.at, props[to.prop], B, s);
		if (to.prop) return grab(props[to.prop].c, props[to.prop], B, s);
		const o = byId[to.meet ?? to.chest], oB = o.body[f];
		const d = [oB.p[0] - B.p[0], oB.p[2] - B.p[2]], l = Math.hypot(d[0], d[1]) || 1, dx = d[0] / l, dz = d[1] / l;
		if (to.meet) return [(B.p[0] + oB.p[0]) / 2 - dx * 0.06, to.y ?? 1.1, (B.p[2] + oB.p[2]) / 2 - dz * 0.06];
		const ch = (o.poseNow ?? solve(oB)).pos[J.Spine2]; // palms on the other figure's chest
		return [ch[0] - dx * 0.15 + dz * s * 0.1, ch[1] + 0.03, ch[2] - dz * 0.15 - dx * s * 0.1];
	};
	const active = (list, f) => list.findLast(k => k.f <= f);
	const prog = (k, f) => k.over > 0 ? (f - k.f) / k.over : 1; // over: 0 = at once
	// the key before k, if its blend has ended by frame f: the new key then starts exactly from that key's target
	const ended = (list, k, f) => { const prev = list[list.indexOf(k) - 1]; return prev && f - prev.f >= prev.over ? prev : null; };
	const scalar = (c, name, f, zero) => {
		const k = active(c.keys[name], f);
		if (!k) return zero;
		k.from ??= ended(c.keys[name], k, f)?.to ?? c.last[name] ?? zero;
		const w = EASE[k.ease](prog(k, f));
		return (c.cur[name] = Array.isArray(zero) ? mixV(k.from, k.to, w) : mix(k.from, k.to, w));
	};
	const upper = (c, f, first) => {
		const B = c.body[f], U = { lean: scalar(c, "lean", f, 0), twist: scalar(c, "twist", f, 0), hipTurn: scalar(c, "hipTurn", f, 0), bow: scalar(c, "bow", f, 0), hip: scalar(c, "hip", f, [0, 0, 0]), hands: [], assist: c.pose?.assist };
		[c.keys.L, c.keys.R].forEach((list, i) => {
			const k = active(list, f);
			let h = { from: null, to: null, w: 1 }, upTo = 0;
			if (k) {
				if (k.from === undefined) {
					const prev = ended(list, k, f), toLocal = (p, b) => qRotate(qY(-b.yaw), sub(p, b.p));
					const local = prev ? (prev.to === "rest" ? null : toLocal(handTarget(c, i, prev.to, f), B)) : c.pose ? toLocal(c.pose.pos[HAND[i]], c.prevB) : null;
					k.from = !prev && c.rest[i] ? null : local;
					if (k.to === "keep") { k.to = local ?? "rest"; k.keptUp = c.up[i] > 0.5; }
				}
				const u = clamp(prog(k, f)), w = EASE[k.ease](u);
				h = { from: k.from && add(B.p, qRotate(qY(B.yaw), k.from)), to: k.to === "rest" ? null : handTarget(c, i, k.to, f), w, key: k.f };
				if (k.pair) h.line = true; // two hands on one prop move as a pair, in a straight blend
				if (k.shake) h.offset = [0, 0.035 * Math.sin(2 * Math.PI * k.shake * u), 0];
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
			const at = t => t === "plant" ? bf : t.q ? t : { a: t.world ?? add([B.p[0], 0, B.p[2]], qRotate(qY(B.yaw), t.at)), q: qMul(qY(B.yaw), qX(t.pitch)) };
			if (k.from === undefined) k.from = list.indexOf(k) === 0 ? "plant" : ended(list, k, f)?.to ?? { a: c.feetPrev[i].a, q: c.feetPrev[i].q };
			const a = at(k.from), b = at(k.to);
			return { a: arc(a.a, b.a, w, add(B.p, qRotate(B.q, OFFSET[UPLEG[i]]))), q: qSlerp(a.q, b.q, w), planted: false, to: k.to === "plant" ? null : b.a, w, key: k.f };
		});
		const ka = active(c.keys.aim, f);
		if (ka) {
			const off = ka.to === "off";
			if (ka.from === undefined) {
				const prev = ended(c.keys.aim, ka, f), on = prev && prev.to !== "off";
				ka.from = (on ? prev.to : c.last.aim) ?? (off ? [0, 0, 1] : ka.to); ka.fromW = prev ? (on ? 1 : 0) : c.last.aimW ?? 0;
			}
			const w = EASE[ka.ease](prog(ka, f)), h = U.hands[c.gripHand ?? 1];
			c.cur.aim = off ? ka.from : mixV(ka.from, ka.to, w); c.cur.aimW = mix(ka.fromW, off ? 0 : 1, w);
			h.aim = qRotate(qY(B.yaw), norm(c.cur.aim)); h.aimW = c.cur.aimW;
		}
		// Head: angles relative to the chest, measured from the neck (which the look does not move). With no target
		// the gaze stays level while the chest leans (not when lying down).
		const now = c.poseNow ?? c.pose, chestQ = now?.quat[J.Spine2] ?? B.q, neck = now?.pos[J.Neck] ?? add(B.p, [0, 0.46, 0]);
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
				t = angles(sub(o ? (o.poseNow?.pos[J.Head] ?? add(o.body[f].p, [0, 0.56, 0])) : pr ? add(pr.c, [0, pr.size[1] / 2, 0]) : k.to, neck));
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
		for (const c of chars) for (const e of c.events) if (e.f === f) {
			const p = props[e.prop];
			p.holder = e.holder; p.hand = e.hand ?? null; p.slide = !!e.slide;
			if (e.at) aux.placed.push({ prop: e.prop, f, miss: Math.hypot(...sub(p.c, e.at)) });
			if (e.hand != null) { // a stick lies along the thumb side, anything else sits in front of the palm
				const s = e.hand ? -1 : 1, stick = p.size[2] > 2 * Math.max(p.size[0], p.size[1]);
				p.grip = e.grip ?? (stick ? [s * 0.04, 0, p.size[2] / 2 - 0.15] : [s * (0.02 + p.size[0] / 2), 0, 0]); c.gripHand = e.hand;
			}
			if (e.roll) { p.vel = sub(p.h1, p.h2); p.fly = null; aux.releases.push({ prop: e.prop, f }); }
			else if (e.holder) {
				const h = handLine(byId[e.holder].pose ?? solve(c.body[f]));
				if (e.slide) { p.off = sub(h.mid, p.c); aux.slid[e.prop] = true; }
				else { p.yawOff = p.yaw - h.yaw; p.off = qRotate(qY(-p.yaw), sub(h.mid, p.c)); }
			}
		}
		for (const p of Object.values(props)) { // a free prop follows its own keys
			let k = p.holder ? null : p.keys.findLast(k => k.f <= f);
			if (k?.verb === "launch") { // starts a flight once; the prop then moves by itself
				if (k.f === f) { p.vel = mul(k.vel, 1 / 24); p.fly = { bounce: k.bounce ?? 0.5, friction: (k.friction ?? 1.5) / 576, wait: true }; aux.launches.push({ prop: p.id, f }); }
				k = null;
			} else if (k || p.holder) p.vel = null;
			aux.keyed[p.id].push(!!k || !!p.vel); aux.rolling[p.id].push(!!p.vel);
			if (p.vel && p.fly?.wait) p.fly.wait = false; // the launch frame: still in place
			else if (p.vel && p.fly) fly(p);
			else if (p.vel) { // released with a velocity: it falls to the floor under it and rolls on at that speed
				const floor = ground(p.c[0], p.c[2]) + p.size[1] / 2, sp = Math.hypot(p.vel[0], p.vel[2]);
				p.c = add(p.c, p.vel); p.vel[1] -= 0.017; // gravity, 9.8 m/s2 at 24 fps
				if (p.c[1] <= floor) { p.c[1] = floor; p.vel[1] = 0; }
				if (sp > 1e-6) p.q = qMul(qAxisAngle([p.vel[2] / sp, 0, -p.vel[0] / sp], sp / (p.size[1] / 2)), p.q);
			}
			if (!k) continue;
			if (!k.c0) { k.c0 = p.c.slice(); k.q0 = p.q.slice(); }
			const u = EASE[k.ease ?? "inout"]((f - k.f) / (k.over ?? 12)), r = k.axis ? qAxisAngle(norm(k.axis), rad(k.deg) * u) : [0, 0, 0, 1];
			p.c = k.verb === "tip" ? add(k.pivot, qRotate(r, sub(k.c0, k.pivot))) : k.to ? mixV(k.c0, k.to, u) : k.c0;
			p.q = qMul(r, k.q0);
		}
		for (let pass = 0; pass < 2; pass++) for (const c of chars) { // second pass: targets on other figures and props are current
			c.restNext = [true, true];
			const U = upper(c, f, pass === 0);
			c.bodyNow = U.feet.some(Boolean) ? { ...c.body[f], feet: c.body[f].feet.map((ft, i) => U.feet[i] ?? ft) } : c.body[f];
			c.poseNow = solve(c.bodyNow, U);
			for (const p of Object.values(props)) if (p.holder === c.id) follow(p, c.poseNow);
			if (pass === 1) aux.reach[c.id].push([
				...U.hands.map((h, i) => h.to && h.w >= 1 ? { key: h.key, d: len(sub(c.poseNow.pos[HAND[i]], h.offset ? add(h.to, h.offset) : h.to)) } : null),
				...U.feet.map((ft, i) => ft?.to && ft.w >= 1 ? { key: ft.key, d: len(sub(c.poseNow.pos[FOOT[i]], ft.to)) } : null),
			]);
		}
		for (const c of chars) {
			c.pose = c.poseNow; c.prevB = c.body[f]; c.feetPrev = c.bodyNow.feet; c.rest = c.restNext; c.last = { ...c.last, ...c.cur };
			setPose(c.out, f, c.pose);
			aux.contacts[c.id].push(c.bodyNow.feet.map(ft => ft.planted));
		}
		for (const { p, out } of outProps) {
			p.h2 = p.h1; p.h1 = p.c.slice();
			aux.holders[p.id].push(p.holder); aux.grips[p.id].push(p.holder && p.hand != null ? { c: p.holder, hand: p.hand } : null);
			if (out.pos.length === 3 && f > 0) continue;
			out.pos.set(p.c, out.pos.length === 3 ? 0 : f * 3); out.quat.set(p.q, out.pos.length === 3 ? 0 : f * 4);
		}
	}
	clip.notes.push(...NOTES);
	return { clip, aux };
}
