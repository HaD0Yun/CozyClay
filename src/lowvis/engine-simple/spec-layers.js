// The spec read into layers (moved unchanged from engine.js): the body layer's frames, the upper layer's keys and prop
// events, and the repeats written out. engine.js builds the clip from them.
import { clamp, rad } from "./math.js";
import { hold, home, locomote, shuffle } from "./gait.js";
import { kneel, lie, sit, stand } from "./posture.js";
import { PAD, across } from "./prop-frame.js";

export const BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);

export function buildBody(c, acts, F, ctx) {
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

/** s: the size of the body (size.js): the pad between a wrist and what it holds grows with the hand. */
export function buildUpper(id, acts, props, s = 1) {
	const keys = { L: [], R: [], footL: [], footR: [], elbowL: [], elbowR: [], lean: [], twist: [], hipTurn: [], bow: [], hip: [], look: [], aim: [], tilt: [] }, events = [];
	for (const [f, verb, o = {}] of acts) {
		if (BODY.has(verb)) continue;
		const k = { f, over: o.over ?? 12, ease: o.ease ?? "inout", fast: o.fast };
		if (verb === "carry") {
			const half = across(props[o.prop]) / 2 + PAD * s, at = o.at;
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
			for (const side of ["elbowL", "elbowR"]) if (o[side] !== undefined) keys[side].push({ ...k, to: o[side] });
			if (o.lean !== undefined) keys.lean.push({ ...k, to: rad(o.lean) });
			if (o.twist !== undefined) keys.twist.push({ ...k, to: rad(o.twist) });
			if (o.hipTurn !== undefined) keys.hipTurn.push({ ...k, to: rad(o.hipTurn) });
			if (o.bow !== undefined) keys.bow.push({ ...k, to: rad(o.bow) });
			if (o.aim !== undefined) keys.aim.push({ ...k, to: o.aim });
			if (o.hip !== undefined) keys.hip.push({ ...k, to: o.hip });
			if (o.tilt !== undefined) keys.tilt.push({ ...k, to: [rad(o.tilt[0] ?? 0), rad(o.tilt[1] ?? 0), ...(o.shift ?? [0, 0, 0])], about: o.about ?? "hips" });
			if (o.look !== undefined || o.nod) keys.look.push({ ...k, to: o.look ?? keys.look.at(-1)?.to ?? "fwd", nod: o.nod });
		} else throw new Error(`engine-simple: unknown verb "${verb}"`);
	}
	return { keys, events };
}

/** The spec with its repeat actions written out. [f, "repeat", { len, times }] in the list of an id copies the other
 *  actions of that id with f <= frame < f + len to +len, +2 * len, ... so that the span plays `times` times in all.
 *  Copies at or past `frames` are left out. Returns { spec, added, dropped }. */
export function expandRepeats(spec, frames) {
	const out = {};
	let added = 0, dropped = 0;
	for (const [id, acts] of Object.entries(spec)) {
		if (!Array.isArray(acts) || !acts.some(a => a?.[1] === "repeat")) { out[id] = acts; continue; }
		const plain = acts.filter(a => a[1] !== "repeat"), list = plain.slice();
		for (const [f, , o = {}] of acts.filter(a => a[1] === "repeat")) {
			if (!Number.isInteger(o.len) || o.len < 1 || !Number.isInteger(o.times) || o.times < 1) throw new Error(`engine-simple: repeat wants { len: frames, times: count }, got ${JSON.stringify(o)}`);
			const span = plain.filter(a => a[0] >= f && a[0] < f + o.len);
			for (let k = 1; k < o.times; k++) for (const a of span) { if (a[0] + k * o.len < frames) { list.push([a[0] + k * o.len, ...a.slice(1)]); added++; } else dropped++; }
		}
		out[id] = list;
	}
	return { spec: out, added, dropped };
}
