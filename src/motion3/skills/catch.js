// catchObject: a hand meets a flying thing where it can reach and gives with it (#816). The thing flies as a free entry
// does, objects.<id>.fall { at, v } from its pose at `at` (flight.js); the skill samples that flight and picks the first
// frame its point is in front of the chest (FRONT m ahead, between the hips and the head) and SHELL m from the catching
// shoulder, no earlier than the hand can get there from f0 (REACH frames). The open hand arrives ARRIVE frames before it,
// the finger middles on the point (a fit on a world anchor there); the fingers close and the carry takes it at
// that frame (fills: prop, grab, grasp), so it rests in the hand (seat.js) and the fingers close on it (finger-close.js).
// Then the hand gives with it: along the incoming velocity by clamp(0.08 + 0.02 x mass x speed, 0.08, 0.15) m over ABSORB
// frames, slowing to a stop, and eases back. side "both", or a thing over HEAVY kg, adds the left hand on its left side
// along the same path (world anchors: the right hand holds the carry, the left meets it). A flight that never comes within
// reach is refused, naming its nearest frame and point; a hand that comes too late (f0 past the reach) misses: QA CATCH.
import { add, sub, scale, apply, ry, len, norm, dot, clamp } from "../compiler/math.js";
import { freePoseAt } from "../free-motion.js";
import { massOf } from "../mass.js";
import { skillError } from "./book.js";
import { transportKeys } from "./reach-human.js";

const SHELL = [0.35, 0.65], FRONT = 0.15, REACH = 10, LONG = 20, ARRIVE = 2, ABSORB = 6, BACK = 8, HEAVY = 1;
const r3 = v => v.map(x => Math.round(x * 1000) / 1000);

/** The shoulder of side S and the body's forward on the keyed root and yaw of state. */
function bodyAt(sk, state, S) {
	const P = sk.restWorldPos, hips = state.root ?? P[sk.index.Hips], R = ry(state.yaw ?? 0);
	return { hips, shoulder: add(hips, apply(R, sub(P[sk.index[`${S}Arm`]], P[sk.index.Hips]))), head: add(hips, apply(R, sub(P[sk.index.Head], P[sk.index.Hips]))), fwd: apply(R, [0, 0, 1]) };
}

export function catchObject(ctx) {
	const { args, state, sk, scene, tag } = ctx, id = args.object, side = args.side ?? "r", o = ctx.objects?.[id], fps = ctx.fps ?? 24;
	if (side !== "r" && side !== "both") skillError(tag, `args.side must be "r" or "both", got ${JSON.stringify(side)}`);
	const fall = Array.isArray(o?.fall) ? o.fall[0] : o?.fall;
	if (!Array.isArray(fall?.v)) skillError(tag, `args.object "${id}" must fly: objects.${id}.fall { at, v: [vx, vy, vz] }`);
	const body = bodyAt(sk, state, "Right"), flight = { spec: { objects: { [id]: { fall: o.fall } }, fps }, scene, timeMap: null };
	const at = f => freePoseAt(flight, id, f)?.pos;
	// the first frame of the flight in front of the chest within the shell around the shoulder; else the nearest one
	let pick = null, near = null;
	for (let f = fall.at + 1; f < ctx.frames; f++) {
		const p = at(f), d = len(sub(p, body.shoulder)), ahead = dot(sub(p, body.hips), body.fwd), off = Math.max(0, SHELL[0] - d, d - SHELL[1], FRONT - ahead, body.hips[1] - 0.1 - p[1], p[1] - body.head[1]);
		if (!near || off < near.off) near = { f, p, off };
		if (off === 0) { pick = { f, p }; break; }
	}
	if (!pick) skillError(tag, `${id} never comes within reach of the right hand (in front of the chest, ${SHELL[0]}-${SHELL[1]} m from the shoulder): nearest at f${near.f}, [${r3(near.p).join(", ")}], ${near.off.toFixed(2)} m out; move the body (standIdle at) or the throw`);
	// the hand needs REACH frames from f0: a later pick it would get to in time; else it comes late to where the thing was
	const contact = Math.max(pick.f, ctx.f0 + REACH + ARRIVE), p = pick.p;
	const incoming = scale(sub(at(pick.f), at(pick.f - 1)), fps), speed = len(incoming), mass = massOf({ objects: ctx.objects }, scene, id);
	// the give's first frame takes 24% of it (1 - (5/6)^1.5): a cubic's 42% of a 3 kg ball's 0.15 m jolted the hands, POP (#819)
	const give = clamp(0.08 + 0.02 * mass * speed, 0.08, 0.15), u = norm(incoming), ease = t => 1 - (1 - t) ** 1.5;
	const path = [p, ...Array.from({ length: ABSORB }, (_, i) => add(p, scale(u, give * ease((i + 1) / ABSORB)))), add(p, scale(u, give * 0.4))];
	const start = Math.max(ctx.f0, contact - ARRIVE - LONG), both = side === "both" || mass > HEAVY;
	// the left hand (both hands, or a heavy thing) on its left side, its finger middles across the thing from the right's
	const radius = Math.max(0, ...Object.values(scene.objects).filter(e => e === scene.objects[id] || e.ancestors?.includes(id)).map(e => Math.max(...e.half)));
	const left = apply(ry(state.yaw ?? 0), [1, 0, 0]), part = { keys: [], end: contact + ABSORB + BACK, props: {}, anchors: {}, fits: [], channels: [],
		fills: { [id]: { prop: `${id}Catch`, grab: contact, grasp: "spherical" } }, catch: { contact, point: r3(p), speed: Math.round(speed * 100) / 100, give: Math.round(give * 1000) / 1000, hands: both ? 2 : 1 } };
	for (const k of both ? ["r", "l"] : ["r"]) {
		const S = k === "l" ? "Left" : "Right", prop = k === "r" ? `${id}Catch` : `${id}CatchL`, off = k === "r" ? [0, 0, 0] : scale(left, 2 * radius + 0.04);
		const armw = `armw_${k}`, fg = `fingers_${k}`, open = { ...state[fg], spherical: 0 }, shut = { ...state[fg], spherical: 1 };
		// the finger middles (the prop's origin) on the point at the catch, then on each point of the give: world anchors
		// with a fit each, the weight handed from one to the next frame by frame (the fits solve the hand onto them exactly)
		const names = path.map((_, i) => `${prop}${i}`), w = i => `w_${names[i]}_${k}`;
		part.keys.push(
			// the elbow down and out (body axes), so it swings out round the side, not in across the body
			{ f: start, set: { [armw]: state[armw] ?? 0, [w(0)]: 0, [fg]: open, [`elbow_${k}`]: k === "r" ? [-1, -0.5, -0.5] : [1, -0.5, -0.5] } },
			// the reach's early-peaked transport, the arm's weight ahead of the aim's (reach-human.js; as reachGrip)
			...transportKeys(contact - ARRIVE - start).map(([f, t, ta]) => ({ f: start + f, set: { [w(0)]: t, [armw]: (state[armw] ?? 0) + (1 - (state[armw] ?? 0)) * ta } })),
			{ f: contact - ARRIVE, set: { [armw]: 1, [w(0)]: 1, [fg]: open } },
			{ f: contact, set: { [w(0)]: 1, [fg]: shut } },
			...path.slice(1).flatMap((_, j) => { const i = j + 1, f = i <= ABSORB ? contact + i : contact + ABSORB + BACK; return [{ f: i <= ABSORB ? f - 1 : contact + ABSORB, set: { [w(i - 1)]: 1, [w(i)]: 0 } }, { f, set: { [w(i - 1)]: 0, [w(i)]: 1 } }]; }),
		);
		part.props[prop] = { hand: k, origin: [`${S}HandIndex2`, `${S}HandMiddle2`], points: { fingers: [0, 0, 0] } };
		names.forEach((n, i) => { part.anchors[n] = { kind: "world", p: r3(add(path[i], off)) }; part.fits.push({ side: k, anchor: n, effector: { prop, point: "fingers" } }); part.channels.push(w(i)); });
	}
	return part;
}
