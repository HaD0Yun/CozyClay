// The spec read into layers (moved unchanged from engine.js): the body layer's frames, the upper layer's keys and prop
// events, and the repeats written out. engine.js builds the clip from them.
import { clamp, rad } from "./math.js";
import { hold, home, locomote, shuffle } from "./gait.js";
import { kneel, lie, sit, stand } from "./posture.js";
import { PAD, across, offBox } from "./prop-frame.js";

export const BODY = new Set(["idle", "walk", "run", "push", "turn", "sit", "stand", "kneel", "lie"]);

export function buildBody(c, acts, F, ctx) {
	const yaw = rad(c.heading), list = acts.filter(a => BODY.has(a[1])).map(([f, verb, o = {}]) => ({ f, verb, o }));
	if (!list.length || list[0].f > 0) list.unshift({ f: 0, verb: "idle", o: {} });
	let st = { p: c.at.slice(), yaw, feet: [1, -1].map(s => ({ g: home(c.at, yaw, s), yaw })) };
	const out = [], end = i => list[i + 1]?.f ?? F, moving = a => a && (a.verb === "walk" || a.verb === "run" || a.verb === "push");
	const seg = (a, N) => ({ kind: a.verb, to: a.o.to, N, steps: a.o.steps, burst: a.o.burst, first: a.o.first, end: a.o.end, stepFrames: a.o.stepFrames, ease: a.o.ease, heading: a.o.heading == null ? null : rad(a.o.heading), facing: a.o.facing == null ? null : rad(a.o.facing) });
	if (moving(list[0])) st.full = true; // gait.js: a move that begins the clip
	const special = a => a.o.steps != null || a.o.facing != null || a.o.end != null || a.o.first != null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i], N = end(i) - a.f, prop = ctx.props[a.o.on];
		let r;
		if (moving(a)) {
			const segs = [seg(a, N)];
			while (moving(list[i + 1]) && !special(list[i]) && !special(list[i + 1])) { i++; segs.push(seg(list[i], end(i) - list[i].f)); }
			r = locomote(st, segs);
			if (r.told) ctx.walked?.({ f: a.f, verb: a.verb, to: segs.at(-1).to, ...r.told }); // a written count or stepFrames that was not walked as written
		} else if (a.verb === "turn") r = shuffle(st, N, { yaw: rad(a.o.heading) });
		else if (POSTURE.has(a.verb)) { // over: frames of the change (default: the whole span), then the posture holds; 0 = at once
			if (a.o.on != null && !prop) throw new Error(`engine-simple: ${c.id} ${a.verb} at frame ${a.f}: no prop "${a.o.on}" in the scene`);
			if (a.o.over != null && !(Number.isFinite(a.o.over) && a.o.over >= 0)) throw new Error(`engine-simple: ${c.id} ${a.verb} at frame ${a.f}: over wants a number of frames >= 0, got ${JSON.stringify(a.o.over)}`);
			const T = a.o.over == null ? N : Math.min(N, Math.round(a.o.over));
			r = posture(c, a, st, a.o.over == null ? N : Math.max(1, T), prop, ctx);
			if (a.o.over != null) r.frames = [...r.frames.slice(0, T), ...hold(r.st, N - T)];
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
const POSTURE = new Set(["sit", "stand", "kneel", "lie"]);
const flat = (p, x, z) => { const d = offBox(p, [x, p.c[1], z]); return Math.hypot(d[0], d[2]); }; // floor-plane distance to a prop's footprint

/** One posture change of n frames from state st. A sit on a prop tells ctx.note how far its hips end from the seat's
 *  top and how many feet stand inside the prop's footprint. */
function posture(c, a, st, n, prop, ctx) {
	if (a.verb === "sit") {
		if (!prop && !Number.isFinite(a.o.height)) throw new Error(`engine-simple: ${c.id} sit at frame ${a.f}: wants {on: propId} or {height}`);
		const top = prop ? prop.c[1] + prop.size[1] / 2 : a.o.height, d = prop ? Math.hypot(prop.c[0] - st.p[0], prop.c[2] - st.p[1]) : 0.33;
		const r = sit(st, n, { y: top, back: Math.min(0.35, d) }), h = r.frames.at(-1)?.p;
		if (prop && h) ctx.note?.({ f: a.f, verb: "sit", prop: prop.id, off: flat(prop, h[0], h[2]), feetIn: st.feet.filter(ft => flat(prop, ft.g[0], ft.g[1]) === 0).length });
		return r;
	}
	if (a.verb === "stand") return st.seat ? stand(st, n) : { frames: hold(st, n), st };
	if (a.verb === "kneel") return kneel(st, n, ctx.ground);
	if (!prop && !Array.isArray(a.o.at)) throw new Error(`engine-simple: ${c.id} lie at frame ${a.f}: wants {on: propId} or {at: [x, z]}`);
	const head = rad(a.o.head ?? c.heading), at = prop ? [prop.c[0] + Math.sin(head) * 0.1, prop.c[2] + Math.cos(head) * 0.1] : a.o.at;
	return lie(st, n, { at, head, floor: ctx.ground(at[0], at[1]) });
}

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
		} else if (verb === "hold" && (o.hand === "both" || o.at !== undefined)) holdShared(id, f, k, o, keys, events);
		else if (verb === "hold") events.push({ f, prop: o.prop, holder: id, hand: o.hand === "L" ? 0 : 1, grip: o.grip });
		else if (verb === "release") events.push({ f, prop: o.prop, holder: null, roll: o.roll, lets: o.hand === "L" ? 0 : o.hand === "R" ? 1 : undefined });
		else if (verb === "place") {
			keys.L.push({ ...k, pair: true, to: { at: o.at, prop: o.prop } }); keys.R.push({ ...k, pair: true, to: { at: o.at, prop: o.prop } });
			events.push({ f: f + k.over, prop: o.prop, holder: null, at: o.at });
		} else if (verb === "pose") {
			const L = o.L ?? o.hands, R = o.R ?? (Array.isArray(o.hands) ? [-o.hands[0], o.hands[1], o.hands[2]] : o.hands);
			if (L !== undefined) keys.L.push({ ...k, to: L, shake: o.shake });
			if (R !== undefined) keys.R.push({ ...k, to: R, shake: o.shake });
			for (const side of ["footL", "footR"]) if (o[side] !== undefined) {
				const t = o[side];
				keys[side].push({ ...k, to: t === "plant" ? t : t.joint ? { place: { joint: t.joint, at: t.at, of: t.of }, pitch: rad(t.pitch ?? 0) } : { at: Array.isArray(t) ? t : t.at, world: t.world, pitch: rad(t.pitch ?? 0) } });
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
	for (const list of Object.values(keys)) list.sort((a, b) => a.f - b.f || (a.auto ? 0 : 1) - (b.auto ? 0 : 1)); // a key the engine adds comes before the spec's own at the same frame
	return { keys, events };
}

/** A hold that can share the prop (share.js): with `at` the hands go to their places on the prop over `over` frames
 *  and take hold when they arrive; without it they take hold where they are. From then on each hand is held where it
 *  is in the body frame (a "keep" key, at its place when it has one) until a later pose of that hand. */
function holdShared(id, f, k, o, keys, events) {
	const hands = o.hand === "both" ? [0, 1] : [o.hand === "L" ? 0 : 1], at = [null, null], name = ["L", "R"];
	const point = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
	for (const i of hands) {
		at[i] = o.at === undefined ? null : Array.isArray(o.at) && hands.length === 1 ? o.at : o.at?.[name[i]];
		if (o.at !== undefined && !point(at[i])) throw new Error(`engine-simple: ${id} hold at frame ${f}: at wants [x, y, z] for one hand or {L: [x, y, z], R: [x, y, z]} for the hands named, got ${JSON.stringify(o.at)}`);
	}
	const take = o.at === undefined ? f : f + k.over;
	for (const i of hands) { // the keep key is held at the place itself (over: 0 = there at once, with no blend key)
		const place = at[i] ? { on: o.prop, at: at[i] } : undefined;
		if (place && k.over > 0) keys[name[i]].push({ ...k, to: place });
		keys[name[i]].push({ f: take, over: 0, ease: "inout", fast: k.fast, to: "keep", place, auto: true, by: f }); // by: the spec's action that added it
	}
	events.push({ f: take, prop: o.prop, holder: id, hands, at, share: true, key: f });
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
