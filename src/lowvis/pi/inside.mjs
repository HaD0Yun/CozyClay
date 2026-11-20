// One measure of things inside props: on every frame, how deep each solid of each body (the look's solids as drawn,
// at the character's scale; the hands are left out) and each moving prop is inside every other prop. The depth of two
// solids is the least distance one would have to move to be clear of the other (separating axes; a ball by its
// centre's distance). A case is a body or a moving prop with one prop; it is told when its depth passes the limit on
// any frame. Nothing is moved by it.
//
// Not told, from what the spec says is a contact: a body with the prop it sits or lies on (from that action through
// the idles after it and one change of posture), a foot's limb (shin and foot), an elbow's limb (upper arm and forearm)
// and a hand's forearm with the prop of its target (up to that limb's next key), the forearms of a body with the prop
// its hands hold on that frame (aux.holders; the drawn forearm's end can be wider than the pad a wrist keeps off what it
// holds), a prop with the body joint or the prop it rides on (while it rides), and any pair with a prop the scene marks
// hollow (things may be inside it).
import { INDEX as J, JOINTS, JOINT_COUNT } from "../rig17.js";
import { qRotate } from "../engine-simple/math.js";
import { blockSolids } from "../looks/block.js";
import { cubeSolids } from "../looks/cube.js";

const LOOKS = { block: blockSolids, cube: cubeSolids }, cache = {};
/** The look the solids are taken from: the one named (the Studio's launch look) when it states solids, else block. */
const solidsLook = name => LOOKS[name] ? name : "block";
const solidsOf = name => (cache[solidsLook(name)] ??= LOOKS[solidsLook(name)]());

/** The depth limit, metres: 20 mm times the body's scale (two props: 20 mm). The thinnest drawn limb is 50 mm (the block
 *  look's forearm at the wrist; the cube look's 58 mm), so a told part is inside by more than 40% of it; a solid resting on
 *  a surface is 0 deep (the soles of both looks lie on the ankle's floor point). A body through a thin plate is as deep
 *  as it would have to move to be clear of it, not the plate's thickness. */
const LIMIT = 0.02;
const POSTURE = new Set(["sit", "stand", "kneel", "lie"]), BODY = new Set(["idle", "walk", "run", "push", "turn", ...POSTURE]);
const LIMB = { hands: ["LeftForeArm", "RightForeArm"], L: ["LeftForeArm"], R: ["RightForeArm"], footL:["LeftLeg", "LeftFoot"], footR: ["RightLeg", "RightFoot"], elbowL: ["LeftArm", "LeftForeArm"], elbowR: ["RightArm", "RightForeArm"] };
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], FOREARMS = new Set([J.LeftForeArm, J.RightForeArm]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Depth of two oriented boxes { c, ax: [3 unit axes], h: [3 half sizes] } by separating axes; <= 0 when apart. */
function boxBox(a, b) {
	const t = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]], axes = [...a.ax, ...b.ax];
	for (const u of a.ax) for (const v of b.ax) { const n = cross(u, v), l = Math.hypot(...n); if (l > 1e-6) axes.push(n.map(x => x / l)); }
	let depth = Infinity;
	for (const L of axes) {
		const ra = a.h[0] * Math.abs(dot(a.ax[0], L)) + a.h[1] * Math.abs(dot(a.ax[1], L)) + a.h[2] * Math.abs(dot(a.ax[2], L));
		const rb = b.h[0] * Math.abs(dot(b.ax[0], L)) + b.h[1] * Math.abs(dot(b.ax[1], L)) + b.h[2] * Math.abs(dot(b.ax[2], L));
		const o = ra + rb - Math.abs(dot(t, L));
		if (o <= 0) return o;
		depth = Math.min(depth, o);
	}
	return depth;
}
/** Depth of a ball { c, r } in a box: its radius less its centre's signed distance to the box. */
function ballBox(s, b) {
	const d = [s.c[0] - b.c[0], s.c[1] - b.c[1], s.c[2] - b.c[2]], l = b.ax.map((u, k) => Math.abs(dot(d, u)) - b.h[k]);
	return s.r - (Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)));
}
const depthOf = (a, b) => a.r != null ? (b.r != null ? a.r + b.r - Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) : ballBox(a, b)) : b.r != null ? ballBox(b, a) : boxBox(a, b);
const reach = s => s.r ?? Math.hypot(...s.h); // radius of a sphere around the solid
const apart = (a, b) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) > reach(a) + reach(b);

/** The frames on which the spec's words make a body or a prop touch a prop: { <who>|<prop>: [{ a, b, joints? }] }. */
function contacts(spec, aux, F) {
	const out = {}, put = (key, e) => (out[key] ??= []).push(e);
	for (const [id, acts] of Object.entries(spec)) {
		if (!Array.isArray(acts)) continue;
		const list = acts.filter(a => Array.isArray(a) && Number.isInteger(a[0])).slice().sort((x, y) => x[0] - y[0]), body = list.filter(a => BODY.has(a[1]));
		body.forEach((a, i) => {
			if ((a[1] !== "sit" && a[1] !== "lie") || typeof a[2]?.on !== "string") return;
			let k = i + 1; // the posture holds through idle actions; a change of posture after it still leaves from the prop
			while (body[k]?.[1] === "idle") k++;
			if (body[k] && POSTURE.has(body[k][1])) k++;
			put(`${id}|${a[2].on}`, { a: a[0], b: body[k]?.[0] ?? F });
		});
		for (const [field, joints] of Object.entries(LIMB)) {
			const keys = list.filter(a => a[1] === "pose" && a[2]?.[field] !== undefined);
			keys.forEach((a, i) => { const t = a[2][field], on = t?.on ?? t?.prop; if (typeof on === "string") put(`${id}|${on}`, { a: a[0], b: keys[i + 1]?.[0] ?? F, joints: new Set(joints.map(n => J[n])) }); });
		}
	}
	for (const r of aux.rides ?? []) if (r.began != null) {
		const span = { a: r.began, b: r.next ?? F };
		if (r.joint) put(`${r.of}|${r.prop}`, { ...span, joints: new Set([J[r.joint]]) });
		else { put(`${r.prop}|${r.on}`, span); put(`${r.on}|${r.prop}`, span); }
	}
	return out;
}
/** Whether a span of list covers frame f (and the joint, for a span of some joints only; joint null: any span). */
const touching = (list, f, joint) => list?.some(e => f >= e.a && f < e.b && (!e.joints || joint == null || e.joints.has(joint)));

/**
 * The inside rows of a clip. def: the scene as built (props with hollow); spec: as built (repeats written out);
 * look: the look the bodies are drawn in (solidsLook). One row per body or moving prop and prop past the limit:
 * { key: "inside:<who>><prop>", value: depth mm on the worst frame, frame, who (a body), prop, part, frames (over the
 *   limit), first, last, limit (mm) }.
 */
export function insideRows(clip, aux, { def, spec, look }) {
	const F = clip.frameCount, solids = solidsOf(look), hollow = new Set((def?.props ?? []).filter(p => p.hollow === true).map(p => p.id));
	const touch = contacts(spec ?? {}, aux, F), cases = new Map();
	// who holds a prop on a frame: a character id, or "<id>:<side>" joined by "+" for hands of several (share.js)
	const holdersAt = (id, f) => String(aux.holders?.[id]?.[f] ?? "").split("+").filter(Boolean).map(h => h.replace(/:[LR]$/, ""));
	const propBox = (p, f) => {
		const i = p.pos.length === 3 ? 0 : f, c = Array.from(p.pos.slice(i * 3, i * 3 + 3)), q = Array.from(p.quat.slice(i * 4, i * 4 + 4));
		return p.shape === "sphere" ? { c, r: p.size[0] / 2 } : { c, ax: AXES.map(a => qRotate(q, a)), h: p.size.map(v => v / 2) };
	};
	const volume = p => p.size[0] * p.size[1] * p.size[2];
	const note = (key, who, prop, part, d, f, limit) => {
		if (d <= limit) return;
		const e = cases.get(key) ?? cases.set(key, { key, who, prop, part, value: 0, frame: f, frames: 0, first: f, last: -1, limit }).get(key);
		if (e.last !== f) e.frames++;
		e.last = f; e.limit = Math.min(e.limit, limit);
		if (d > e.value) Object.assign(e, { value: d, frame: f, part });
	};
	const props = clip.props.filter(p => !hollow.has(p.id)), movers = props.filter(p => p.pos.length > 3), statics = props.filter(p => p.pos.length === 3).map(p => [p, propBox(p, 0)]);
	for (let f = 0; f < F; f++) {
		const boxes = props.map(p => [p, p.pos.length === 3 ? statics.find(s => s[0] === p)[1] : propBox(p, f)]);
		for (const c of clip.characters) {
			const s = c.scale ?? 1, lim = LIMIT * s;
			const parts = solids.map(o => {
				const i = (f * JOINT_COUNT + o.joint), q = Array.from(c.quat.slice(i * 4, i * 4 + 4)), d = qRotate(q, o.c);
				return { joint: o.joint, c: [c.pos[i * 3] + d[0] * s, c.pos[i * 3 + 1] + d[1] * s, c.pos[i * 3 + 2] + d[2] * s], ax: AXES.map(a => qRotate(q, a)), h: o.h.map(v => v * s) };
			});
			const hip = (f * JOINT_COUNT + J.Hips) * 3, all = { c: [c.pos[hip], c.pos[hip + 1], c.pos[hip + 2]], r: Math.max(...parts.map(o => Math.hypot(o.c[0] - c.pos[hip], o.c[1] - c.pos[hip + 1], o.c[2] - c.pos[hip + 2]) + reach(o))) };
			for (const [p, b] of boxes) {
				if (apart(all, b)) continue;
				const key = `${c.id}|${p.id}`, list = touch[key], held = holdersAt(p.id, f).includes(c.id);
				if (list?.some(e => f >= e.a && f < e.b && !e.joints)) continue; // the whole body touches it
				for (const o of parts) if (!apart(o, b) && !touching(list, f, o.joint) && !(held && FOREARMS.has(o.joint))) note(key, c.id, p.id, JOINTS[o.joint], depthOf(o, b), f, lim);
			}
		}
		for (const m of movers) {
			const a = boxes.find(x => x[0] === m)[1];
			for (const [p, b] of boxes) {
				if (p === m || (p.pos.length > 3 && movers.indexOf(p) < movers.indexOf(m)) || apart(a, b)) continue; // a pair of movers once
				if (touching(touch[`${m.id}|${p.id}`], f, null)) continue;
				const [x, y] = p.pos.length > 3 && volume(p) < volume(m) ? [p, m] : [m, p]; // of two moving props, the smaller is named inside the larger
				note(`${x.id}|${y.id}`, null, y.id, x.id, depthOf(a, b), f, LIMIT);
			}
		}
	}
	return [...cases.values()].map(e => ({ ...e, key: `inside:${e.who ?? e.part}>${e.prop}`, value: e.value * 1000, limit: e.limit * 1000 }));
}
