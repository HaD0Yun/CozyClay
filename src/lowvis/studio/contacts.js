// Where a motion's bodies meet the objects it uses, read from the clip and the engine's per-frame facts (aux), and how far
// each of those places is from what the Studio draws (rule 6). Only geometry and ids: no object kinds or names.
// A body part meets a prop's box on a frame when
//   - the engine ties it there: a hand that holds the prop (aux.grips, aux.holders), a hand or a foot whose target is on
//     the prop (aux.reach entries with on), a joint the prop rides (aux.rides: once it is at its place, until a hand
//     takes it off or its next key);
//   - or it lies on or in the box for MIN_SPAN frames in a row: a hand (wrist to finger tip), a foot (its sole), the seat
//     (the Hips joint less the engine's seat height, with the Hips over the box's footprint).
// A contact row is one body part on one prop over frames, at one place in the prop's own frame: from the middle of its
// underside, x along its width, y up, z along its depth (the frame an object.sculpt recipe of it is written in). A row of
// a joint that carries the prop has that body part as the look draws it (carried.js; look: the look the bodies are drawn
// in): its size and the box it spans in that frame, and its gap is how far the drawn look is from that drawn part or
// sunk into it (a look round the part is at it).
// A free row (free: true) is no contact: while a body's seat meets a prop, a hand or a foot the engine holds at a target
// (an aux.reach entry) that is on no prop and no body, near no box (a foot: nor the floor), and keeps its place in that
// prop's frame for FREE_SPAN frames. It names where the motion holds that limb beside the object the body is on.
// Node and browser safe: no three.js. The page measures the probes (gaps.js); this module tells them.
//   contactsOf(clip, aux, look)         Map(prop id -> [row]) for every prop a body meets
//   frameOf(p, f)                       a clip prop's own frame on a frame
//   auxOf(scene, spec, clip)            the engine's aux of a compiled clip, built again (null when it is not the same clip)
//   probesOf(clip, pid, rows, look)     the points (and drawn parts) a gap measure reads for one prop's rows, in its frame and the world
//   gapsOf(rows, probes, measured)      the rows' gaps from the drawn look, worst first (gap times frames)
//   contactLine(label, rows)            one line: where the bodies meet one object
//   gapLine(label, found)               one line: the contacts a drawn look misses, worst first
import { buildClip } from "../engine-simple/engine.js";
import { INDEX as J, REST, TIPS, qConj, qRotate } from "../rig17.js";
import { drawnPart, partSolids, posed } from "./carried.js";

const NJ = 17;
const TOUCH = 0.03; // m (times the body's size): a part this near a box, or in it, meets it
const MIN_SPAN = 3; // frames: a part only near a box is a contact from this many frames in a row
const FREE_SPAN = 12; // frames (half a second): a limb held at a target on no object is told when it keeps its place this long
const MOVE = 0.1; // m (times the body's size when larger): a contact whose place moves farther from its row's mean place starts a new row
const SEAT_UP = 0.13; // m at body size 1: the Hips joint over a seat top (engine-simple/posture.js SEAT_UP)
const GAP = 0.03; // m: a contact farther than this from the drawn look, or deeper in it, is told
const ROWS = 6, SAMPLES = 5, GAPS = 3, FREE = 4;
const TURNED = 5; // degrees: a drawn part turned more than this against the prop's axes says so (its span is then larger than it)
const PARTS = ["left hand", "right hand", "left foot", "right foot", "seat"];
// bone segments read for a body inside a drawn part (the hands are their own contacts)
const SEGMENTS = { legs: [["LeftUpLeg", "LeftLeg"], ["LeftLeg", "LeftFoot"], ["RightUpLeg", "RightLeg"], ["RightLeg", "RightFoot"]], hips: [["Hips", "LeftUpLeg"], ["Hips", "RightUpLeg"], ["Hips", "Spine"], ["Spine", "Spine2"]], arms: [["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"], ["RightArm", "RightForeArm"], ["RightForeArm", "RightHand"]] };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const r2 = v => Math.round(v * 100) / 100, mm = v => Math.round(v * 1000);
const median = list => { const s = list.slice().sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : NaN; };

/** The pose of clip prop p at frame f: its base pivot (the middle of its underside) and turn, { o, q }. */
export function frameOf(p, f) {
	const k = p.pos.length > 3 ? f : 0, q = p.quat.slice(k * 4, k * 4 + 4), h = p.shape === "sphere" ? p.size[0] : p.size[1];
	return { o: add(p.pos.slice(k * 3, k * 3 + 3), qRotate(q, [0, -h / 2, 0])), q };
}
const toLocal = (fr, x) => qRotate(qConj(fr.q), sub(x, fr.o));
const sizeOf = p => (p.shape === "sphere" ? [p.size[0], p.size[0], p.size[0]] : p.size);
/** Signed distance (m) of local point l from the box [w, h, d] standing on y = 0: negative inside. */
function toBox(l, [w, h, d]) {
	const e = [Math.abs(l[0]) - w / 2, Math.abs(l[1] - h / 2) - h / 2, Math.abs(l[2]) - d / 2];
	return Math.hypot(...e.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...e));
}

/** A body's points on frame f: joint j, a hand's five points (wrist to finger tip), a foot's sole (heel, middle, toe). */
function bodyOf(c) {
	const s = c.scale ?? 1, at = (f, j) => c.pos.slice((f * NJ + j) * 3, (f * NJ + j) * 3 + 3), turn = (f, j) => c.quat.slice((f * NJ + j) * 4, (f * NJ + j) * 4 + 4);
	const from = (f, name, rest) => add(at(f, J[name]), qRotate(turn(f, J[name]), mul(sub(rest, REST[J[name]]), s)));
	return {
		s, at,
		hand: (f, side) => { const w = at(f, J[`${side}Hand`]), t = from(f, `${side}Hand`, TIPS[`${side}Hand`]); return [0, 1, 2, 3, 4].map(i => add(w, mul(sub(t, w), i / 4))); },
		foot: (f, side) => { const a = REST[J[`${side}Foot`]], heel = from(f, `${side}Foot`, [a[0], 0, a[2]]), toe = from(f, `${side}Foot`, TIPS[`${side}Foot`]); return [heel, mul(add(heel, toe), 0.5), toe]; },
		seat: f => sub(at(f, J.Hips), [0, SEAT_UP * s, 0]),
	};
}
/** The points of part k (PARTS) of body b on frame f; a joint's name is its own part. */
const pointsOf = (b, part, f) => (part === "seat" ? [b.seat(f)] : part.endsWith("hand") ? b.hand(f, part.startsWith("left") ? "Left" : "Right") : part.endsWith("foot") ? b.foot(f, part.startsWith("left") ? "Left" : "Right") : [b.at(f, J[part])]);
/** The point a row's place is read from: a hand's middle, a foot's sole middle, the seat, the joint. */
const placeOf = (b, part, f) => { const pts = pointsOf(b, part, f); return pts[pts.length >> 1]; };

/** The ties the engine made on frame f: Map(prop id -> Set(part)) per character id. */
function tiesAt(aux, clip, f) {
	const out = new Map(), tie = (cid, pid, part) => { const of = out.get(cid) ?? out.set(cid, new Map()).get(cid); (of.get(pid) ?? of.set(pid, new Set()).get(pid)).add(part); };
	if (!aux) return out;
	const props = new Set(clip.props.map(p => p.id));
	for (const c of clip.characters) (aux.reach?.[c.id]?.[f] ?? []).slice(0, 4).forEach((e, k) => { if (e?.on != null && props.has(e.on)) tie(c.id, e.on, PARTS[k]); });
	for (const p of clip.props) {
		const grip = aux.grips?.[p.id]?.[f], holder = aux.holders?.[p.id]?.[f];
		if (grip?.c != null && (grip.hand === 0 || grip.hand === 1)) tie(grip.c, p.id, PARTS[grip.hand]);
		else if (holder != null) { tie(holder, p.id, PARTS[0]); tie(holder, p.id, PARTS[1]); }
	}
	// a joint carries the prop on the frames its ride has it in its place: from the frame it got there (the ride's over,
	// ride.js) until a hand takes it off (the ride is over then) or the prop's next key
	for (const r of aux.rides ?? []) if (J[r.joint] !== undefined && r.of != null && r.began != null && f >= r.began + Math.max(0, (r.over ?? 0) - 1) && f < (r.off ?? r.next ?? clip.frameCount)) tie(r.of, r.prop, r.joint);
	return out;
}

/**
 * contactsOf(clip, aux, look) -> Map(prop id -> [{ who, part, from, to, at: [x, y, z], frames: [f], tied, free?, drawn? }]):
 * the clip's contacts and free rows (see the head of this file), longest first per prop. aux: the engine's (auxOf), or
 * null: only the parts on or in a box count then, and there are no free rows. A prop hidden on a frame (shown 0) has no
 * contact on it. drawn: of a joint that carries the prop, its drawn part { size, lo, hi, turn } (carried.js drawnPart).
 */
export function contactsOf(clip, aux = null, look = null) {
	const F = clip.frameCount, bodies = new Map(clip.characters.map(c => [c.id, bodyOf(c)])), hits = new Map(); // `${prop}|${who}|${part}|${free}` -> { pid, cid, part, free, frames: Map(f -> tied) }
	const hit = (pid, cid, part, f, tied, free = false) => { const key = `${pid}|${cid}|${part}|${free}`, m = (hits.get(key) ?? hits.set(key, { pid, cid, part, free, frames: new Map() }).get(key)).frames; m.set(f, m.get(f) || tied); };
	for (let f = 0; f < F; f++) {
		const ties = tiesAt(aux, clip, f), busy = new Set(), seated = []; // busy: `${who}|${part}` on or tied to a prop; seated: [prop id, who]
		for (const p of clip.props) {
			if (p.shown && !p.shown[f]) continue;
			const fr = frameOf(p, f), size = sizeOf(p);
			for (const c of clip.characters) {
				const b = bodies.get(c.id), near = part => Math.min(...pointsOf(b, part, f).map(x => toBox(toLocal(fr, x), size))) <= TOUCH * b.s;
				for (const part of ties.get(c.id)?.get(p.id) ?? []) { hit(p.id, c.id, part, f, true); busy.add(`${c.id}|${part}`); }
				for (const part of PARTS.slice(0, 4)) if (near(part)) { hit(p.id, c.id, part, f, false); busy.add(`${c.id}|${part}`); }
				const hips = toLocal(fr, b.at(f, J.Hips));
				if (Math.abs(hips[0]) <= size[0] / 2 && Math.abs(hips[2]) <= size[2] / 2 && near("seat")) { hit(p.id, c.id, "seat", f, false); seated.push([p.id, c.id]); }
			}
		}
		// free rows: the limbs of a seated body that the engine holds at a target on nothing
		for (const [pid, cid] of seated) PARTS.slice(0, 4).forEach((part, k) => {
			const aim = aux?.reach?.[cid]?.[f]?.[k], b = bodies.get(cid);
			if (!aim || aim.on != null || busy.has(`${cid}|${part}`) || (k > 1 && Math.min(...pointsOf(b, part, f).map(x => x[1])) <= TOUCH * b.s)) return;
			hit(pid, cid, part, f, false, true);
		});
	}
	const out = new Map();
	for (const { pid, cid, part, free, frames } of hits.values()) {
		const p = clip.props.find(x => x.id === pid), b = bodies.get(cid), fs = [...frames.keys()].sort((x, y) => x - y);
		// runs of frames (a gap of up to 2 frames joins), split where the place moves; a run only near the box needs MIN_SPAN frames
		const runs = [];
		for (const f of fs) {
			const l = toLocal(frameOf(p, f), placeOf(b, part, f)), last = runs.at(-1);
			if (last && f - last.frames.at(-1) <= 3 && Math.hypot(...sub(l, mul(last.sum, 1 / last.frames.length))) <= MOVE * Math.max(1, b.s)) { last.frames.push(f); last.places.push(l); last.sum = add(last.sum, l); last.tied ||= frames.get(f); } else runs.push({ sum: l, frames: [f], places: [l], tied: frames.get(f) });
		}
		for (const run of runs) {
			if (free ? run.frames.length < FREE_SPAN : !run.tied && run.frames.length < MIN_SPAN) continue;
			const row = { who: cid, part, from: run.frames[0], to: run.frames.at(-1), at: [0, 1, 2].map(k => r2(median(run.places.map(l => l[k])))), frames: run.frames, tied: run.tied, ...(free ? { free: true } : {}) };
			const drawn = !PARTS.includes(part) && drawnPart(partSolids(look, part), clip.characters.find(c => c.id === cid), part, run.frames, (f, x) => toLocal(frameOf(p, f), x), f => frameOf(p, f).q); // a joint that carries the prop
			if (drawn) row.drawn = drawn;
			(out.get(pid) ?? out.set(pid, []).get(pid)).push(row);
		}
	}
	// a prop with free rows only is met by no body: it has no row
	for (const [pid, rows] of out) if (rows.every(row => row.free)) out.delete(pid);
	for (const rows of out.values()) rows.sort((a, b) => b.frames.length - a.frames.length || a.from - b.from);
	return out;
}

/** The engine's aux of a clip compiled from scene (the motion writer's, as the compile read it) and spec, built again;
 *  null when the build fails or its bodies are not the clip's (the engine changed since, another body size). */
export function auxOf(scene, spec, clip) {
	if (!scene?.characters?.length || !spec || !clip?.characters?.length) return null;
	try {
		const one = scene.characters.find(c => c.id === clip.characters[0].id), body = (clip.characters[0].scale ?? 1) / (one?.scale ?? 1);
		const world = { ...structuredClone(scene), characters: scene.characters.map(c => ({ ...structuredClone(c), scale: (c.scale ?? 1) * body })) };
		const built = buildClip(structuredClone({ ...spec, demo: "contacts" }), world), again = built.clip;
		if (again.frameCount !== clip.frameCount || again.characters.length !== clip.characters.length) return null;
		const off = (a, b, f) => Math.hypot(...[0, 1, 2].map(k => a.pos[f * NJ * 3 + k] - b.pos[f * NJ * 3 + k]));
		return clip.characters.every((c, i) => again.characters[i].id === c.id && off(c, again.characters[i], 0) < 0.002 && off(c, again.characters[i], clip.frameCount - 1) < 0.002) ? built.aux : null;
	} catch { return null; }
}

/** Up to n frames spread over a list. */
const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]));

/**
 * The points a gap measure reads for one prop's rows: { parts: [{ row, f, local: [[x, y, z]], world: [[x, y, z]] }],
 * seats: [{ row, f, local, world, up }] (the Hips, up: the seat height), inside: [{ who, group, f, local, world }] (bone
 * points of the bodies on their contact frames), solids: [{ row, f, local, world, t }] (the drawn part of a joint that
 * carries the prop: each solid's corners and triangles, carried.js; look: the look the bodies are drawn in) }, at
 * SAMPLES frames per row. local: in the prop's frame on that frame (a
 * tracked or attached object is drawn there); world: for an object that stands still, read against where it stands.
 */
export function probesOf(clip, pid, rows, look = null) {
	const p = clip.props.find(x => x.id === pid), parts = [], seats = [], inside = [], solids = [], bodies = new Map(clip.characters.map(c => [c.id, bodyOf(c)]));
	if (!p) return { parts, seats, inside, solids };
	const both = (f, pts) => { const fr = frameOf(p, f); return { local: pts.map(x => toLocal(fr, x)), world: pts }; };
	rows.forEach((row, k) => {
		const b = bodies.get(row.who), drawn = row.drawn ? partSolids(look, row.part) : null;
		for (const f of spread(row.frames, SAMPLES)) {
			if (row.part === "seat") { const at = both(f, [b.at(f, J.Hips)]); seats.push({ row: k, f, local: at.local[0], world: at.world[0], up: SEAT_UP * b.s }); } else if (PARTS.includes(row.part)) parts.push({ row: k, f, ...both(f, pointsOf(b, row.part, f)) });
			else if (drawn) solids.push({ row: k, f, t: drawn.map(o => o.t), ...posed(drawn, clip.characters.find(c => c.id === row.who), row.part, f).reduce((m, pts) => { const at = both(f, pts); m.local.push(at.local); m.world.push(at.world); return m; }, { local: [], world: [] }) });
		}
	});
	for (const who of new Set(rows.map(row => row.who))) {
		const b = bodies.get(who), frames = [...new Set(rows.filter(row => row.who === who).flatMap(row => row.frames))].sort((x, y) => x - y);
		for (const f of spread(frames, SAMPLES)) for (const [group, segs] of Object.entries(SEGMENTS)) {
			// a forearm up to its wrist, not on it: the hand is a contact of its own
			const pts = segs.flatMap(([a, z]) => [0, 1, 2, 3, 4].filter(i => i < 4 || !z.endsWith("Hand")).map(i => add(b.at(f, J[a]), mul(sub(b.at(f, J[z]), b.at(f, J[a])), i / 4))));
			inside.push({ who, group, f, ...both(f, pts) });
		}
	}
	return { parts, seats, inside, solids };
}

const span = row => (row.from === row.to ? `f${row.from}` : `f${row.from}-${row.to}`);
const named = row => `${row.who} ${row.part}`;
const list = v => `[${v.join(", ")}]`;

const cut = (texts, n) => [...texts.slice(0, n), ...(texts.length > n ? [`${texts.length - n} more`] : [])];
const FREE_HEAD = "aimed at no object while the seat meets it: ";

/** One line for the agent: where the bodies meet one object, at most ROWS rows, the longest first (a joint that carries
 *  it: its drawn part's size and span, turned when more than TURNED against the object's axes); then its free rows, at most FREE. */
export function contactLine(label, rows) {
	const part = d => `its drawn part ${d.size.join(" x ")} m spans ${list(d.lo)} to ${list(d.hi)}${d.turn > TURNED ? ` (turned ${d.turn}° to these axes)` : ""}`;
	const text = row => (row.drawn ? `${named(row)} ${span(row)}: ${part(row.drawn)}` : `${named(row)} at ${list(row.at)} ${span(row)}`), free = rows.filter(row => row.free);
	return `${label}, where bodies meet it: ${cut(rows.filter(row => !row.free).map(text), ROWS).join("; ")}${free.length ? `; ${FREE_HEAD}${cut(free.map(text), FREE).join("; ")}` : ""}`;
}

/**
 * The gaps of one object's rows from its drawn look: { gaps: [{ text, size, frames }] worst first (the larger gap times
 * its frames; sizes in m), within: the count of contact rows measured within GAP, free: the same for the free rows
 * farther than GAP from the drawn look }. measured: { parts: [d] per probes parts entry (each its points' signed
 * distances: negative inside), seats: [top | null] per seats entry (the drawn surface's height under the Hips, local),
 * inside: [d] per inside entry, solids: [g] per solids entry (the drawn part against the drawn look: their least
 * distance, 0 with the look round the part, or minus how deep the look's surface is in the part) } in the order
 * probesOf gave them.
 * A body group inside a drawn part weighs with the share of the sampled frames it is inside on.
 */
export function gapsOf(rows, probes, measured) {
	const out = [], free = [];
	let count = 0;
	rows.forEach((row, k) => {
		if (row.part === "seat") {
			const ds = probes.seats.map((s, i) => [s, measured.seats?.[i]]).filter(([s]) => s.row === k), tops = ds.filter(([, t]) => Number.isFinite(t));
			if (!ds.length) return;
			count++;
			if (tops.length * 2 < ds.length) { out.push({ size: median(ds.map(([s]) => s.local[1] - s.up)), frames: row.frames.length, text: `${named(row)} at ${list(row.at)} ${span(row)}: nothing drawn under it` }); return; } // ranked by the seat's height over the base
			const g = median(tops.map(([s, t]) => s.local[1] - t - s.up));
			if (Math.abs(g) > GAP) out.push({ size: Math.abs(g), frames: row.frames.length, text: `${named(row)} at ${list(row.at)} ${span(row)}: ${g > 0 ? `floats ${mm(g)} mm over the drawn surface under it` : `sinks ${mm(-g)} mm below the drawn surface`}` });
			return;
		}
		if (row.drawn) { // a joint that carries it: the gap between its drawn part and the drawn look (negative: the look is that deep in the part)
			const gs = (probes.solids ?? []).map((s, i) => [s, measured.solids?.[i]]).filter(([s, d]) => s.row === k && Number.isFinite(d)).map(([, d]) => d);
			if (!gs.length) return;
			count++;
			const g = median(gs), text = `${named(row)}'s drawn part ${span(row)}: ${g > 0 ? `${mm(g)} mm from the drawn look` : `the drawn look ${mm(-g)} mm inside it`}`;
			if (Math.abs(g) > GAP) out.push({ size: Math.abs(g), frames: row.frames.length, text });
			return;
		}
		const ds = probes.parts.map((s, i) => [s, measured.parts?.[i]]).filter(([s, d]) => s.row === k && Array.isArray(d) && d.length);
		if (!ds.length) return;
		if (!row.free) count++;
		const off = median(ds.map(([, d]) => Math.max(0, Math.min(...d)))), deep = median(ds.map(([, d]) => -Math.max(...d))), to = row.free ? free : out;
		if (off > GAP) to.push({ size: off, frames: row.frames.length, text: `${named(row)} at ${list(row.at)} ${span(row)}: ${mm(off)} mm from the drawn look` });
		else if (deep > GAP) to.push({ size: deep, frames: row.frames.length, text: `${named(row)} at ${list(row.at)} ${span(row)}: ${mm(deep)} mm inside the drawn look` });
	});
	const within = count - out.length, deepest = new Map(); // `${who} ${group}` -> { d, f, who, n: the sampled frames it is inside on, of: the sampled frames }
	probes.inside.forEach((s, i) => {
		const d = -Math.min(0, ...(measured.inside?.[i] ?? [])), key = `${s.who} ${s.group}`, e = deepest.get(key) ?? deepest.set(key, { d: 0, n: 0, of: 0, who: s.who }).get(key);
		e.of++;
		if (d > GAP) e.n++;
		if (d > e.d) { e.d = d; e.f = s.f; }
	});
	const met = who => new Set(rows.filter(row => row.who === who && !row.free).flatMap(row => row.frames)).size;
	for (const [key, e] of deepest) if (e.d > GAP) out.push({ size: e.d, frames: (met(e.who) * e.n) / e.of, text: `${key} ${mm(e.d)} mm inside the drawn look at f${e.f}` });
	const worst = (a, b) => b.size * b.frames - a.size * a.frames;
	return { gaps: out.sort(worst), within, free: free.sort(worst) };
}

/** One line for the agent: the gaps of one object ({ gaps, within, free }: gapsOf), at most GAPS, with the count of the
 *  rest and of the contacts within GAP, then at most FREE of its free rows off the look; null when none is off. */
export function gapLine(label, { gaps, within, free = [] }) {
	if (!gaps.length && !free.length) return null;
	const told = gaps.length ? [...cut(gaps.map(g => g.text), GAPS), ...(within > 0 ? [`${within} contact${within === 1 ? "" : "s"} within ${GAP} m`] : [])] : [];
	return `${label}, off the drawn look: ${[...told, ...(free.length ? [`${FREE_HEAD}${cut(free.map(g => g.text), FREE).join("; ")}`] : [])].join("; ")}`;
}
