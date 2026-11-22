// The Studio scene as a lowvis scene (prototype): the objects and rig characters the Studio already has, written
// as the props and characters a lowvis request may use, so a motion can sit on the bench or lift the box that a
// build step (or the user) put there. install.js reads `ids` to move those instead of making them again.
// A lowvis prop is a box: with the turn flag it is the object's own box turned as the object is about Y, without it the
// box square to the axes around its footprint; a tilted object and anything flat as a floor are left out.
// With the kinds flag an object with no box of its own (footprint and height 0: an effect, a light, a group's Empty) is a
// prop too: a POINT box centred on its place, hollow, with kind naming what it is, so a motion can move it as any prop
// (a hand holds it, ride puts it on a joint or a prop) and install.js moves the object itself, keeping its kind.
// Browser-safe and node-safe.
import { TRACK_RIG } from "./take.js";

const SOLID = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "sculpt", "mesh"]);
/** Rig models whose skeleton the clip can drive at scale 1; any but TRACK_RIG is changed to TRACK_RIG by the install. */
const SWITCHABLE = new Set(["y-bot-tpose"]);
const MAX_PROPS = 40, RAD = Math.PI / 180, BAND = 0.03; // BAND: a top this far under the box's top is lower than it
const FLAT = 0.03; // an object under this tall and wider than it lies on the floor as a floor does
/** The side of the box a point object is drawn as in the motion writer's sheets, in metres: a marker the size of a
 *  fingertip, small enough to sit at a mouth, a wrist or the tip of a held prop. */
export const POINT = 0.02;
const round = v => Math.round(v * 1000) / 1000;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** A name the lowvis spec can use as an id, unique among `taken` (which it joins). */
function idFor(name, taken, fallback) {
	const base = String(name ?? "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
	taken.add(id);
	return id;
}

/** What a point object is, in words: an effect with its preset, a light with its type, a group with its parts' kinds. */
function kindOf(row, rows) {
	if (row.renderer === "effect") return `effect ${row.effect?.preset ?? "smoke"}`;
	if (row.renderer === "light") return `${row.light?.type ?? "point"} light`;
	const parts = rows.filter(other => other?.parent === row.id && !other.hidden).map(other => other.renderer === "effect" ? `effect ${other.effect?.preset ?? "smoke"}` : other.renderer === "light" ? `${other.light?.type ?? "point"} light` : String(other.renderer));
	return parts.length ? `group of ${parts.join(", ")}` : String(row.renderer ?? "object");
}
/** The record's own turn (rotX, rot, rotZ in degrees, the Studio's XYZ order) as a quaternion [x, y, z, w]. */
function quatOf(row) {
	const h = [finite(row.rotX), finite(row.rot), finite(row.rotZ)].map(v => v * RAD / 2), [cx, cy, cz] = h.map(Math.cos), [sx, sy, sz] = h.map(Math.sin);
	return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz].map(v => Math.round(v * 1e6) / 1e6);
}

/** A flat rectangle of tops.js (the object's own frame) in the world, as a prop's heights entry. */
function heightOf(t, row, own) {
	const a = finite(row.rot) * RAD, cs = Math.cos(a), sn = Math.sin(a), cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2, w = t.x1 - t.x0, d = t.z1 - t.z0;
	return { y: round(finite(row.y) + t.y), at: [round(finite(row.x) + cx * cs + cz * sn), round(finite(row.z) - cx * sn + cz * cs)],
		size: own ? [round(w), round(d)] : [round(w * Math.abs(cs) + d * Math.abs(sn)), round(w * Math.abs(sn) + d * Math.abs(cs))] };
}

/** Why a visible character row cannot be animated by a clip, or null when it can. */
function whyNot(row) {
	if (row.model === "proxy-figure") return "capsule figure";
	if (row.model !== TRACK_RIG && !SWITCHABLE.has(row.model)) return /^rig-/.test(String(row.model ?? "")) ? "imported rig" : `model ${row.model ?? "unknown"}`;
	return null;
}
/** Why a row's scale keeps a clip from it when a clip is of a body at scale 1 only (the body step off), or null at scale 1. */
const whyScale = row => (Math.abs(finite(row.scale, 1) - 1) > 1e-6 ? `scale ${round(finite(row.scale, 1))}` : null);

/**
 * studioScene(describe, { turn, tops, body, kinds }) -> { scene: { characters: [{ id, at, heading, scale?, tint? }], props: [{ id, size, at, turn?, shape?, heights?, kind?, hollow? }], others: [{ id, why }] }, ids }
 * describe: the editor's describe answer ({ characters, objects }). ids: { characters: { <lowvis id>: <Studio id> },
 * props: { <lowvis id>: { id: <Studio id>, x, y, z, rot } }, switch: [<Studio id>] } with each object's base pivot
 * and turn about Y as the Studio holds them. switch: the listed characters whose model the install changes to the
 * clip's rig before it animates them. others: visible characters the clip cannot animate (Studio id and why).
 * turn: a prop is the object's own box [w, h, d] with turn = the object's turn about Y (degrees; left out at 0).
 * tops: describe was asked with { tops: true } (tops.js): a prop whose object offers more than one flat height, or one
 * lower than its top, gets heights: [{ y, at: [x, z], size: [w, d] }], each a flat rectangle in the world: y over the
 * floor, at its centre; size along the prop's own sides when the prop has its turn, else the square box around it.
 * body: a character at any scale is offered, with its scale (left out at 1) and its tint (left out when it has none), the
 * character's own fields; ids.bodies: { <Studio id>: { scale, tint } } as the Studio holds them. Without it a
 * character at another scale than 1 is one of the others, as before.
 * kinds: a visible, unattached object with no box of its own that is grouped under no other object (an effect, a light,
 * a group's Empty: its parts ride it) is a prop { id, size: [POINT, POINT, POINT], at: its place, kind, hollow: true },
 * and an object small in every side (under 0.03 m) is an ordinary prop instead of being left out as flat: the first 40
 * of these two, beside the first 40 solids at least 0.03 m tall, which are the ones offered without it. Its ids.props
 * entry has point: true, kind, and quat: the object's own turn, which it keeps against the prop's box (install.js).
 * Without it neither is offered, as before.
 * An object attached to a bone of an offered character (object.attach; a motion's install attaches a prop one bone
 * carries throughout, install.js) is no prop: scene.attached lists it { id, on: <character id>, bone, size | kind } (its
 * own box, or what it is when it has none) and ids.props has it with attach and quat (its turn in that bone's frame;
 * point and kind when it has no box), so a clip prop of that id is that object (re-attached, or detached and moved by a
 * track). group: true in ids.props marks an object other objects are grouped under: they go with it when a track moves
 * it and stay behind when it is attached to a bone, so the install keeps it on a track.
 */
export function studioScene(describe, { turn = false, tops = false, body = false, kinds = false } = {}) {
	const taken = new Set(), ids = { characters: {}, props: {}, switch: [] }, characters = [], props = [], others = [], attached = [];
	for (const row of Array.isArray(describe?.characters) ? describe.characters : []) {
		if (!row || row.hidden) continue;
		const why = whyNot(row) ?? (body ? null : whyScale(row));
		if (why) { others.push({ id: String(row.id), why }); continue; }
		const id = idFor(String(row.id).replace(/^lowvis-/, ""), taken, "person");
		ids.characters[id] = row.id;
		if (row.model !== TRACK_RIG) ids.switch.push(row.id);
		const scale = finite(row.scale, 1), tint = typeof row.tint === "string" ? row.tint : null;
		if (body) (ids.bodies ??= {})[row.id] = { scale, tint };
		characters.push({ id, at: [round(finite(row.x)), round(finite(row.z))], heading: round(finite(row.rot)), ...(body && scale !== 1 ? { scale } : {}), ...(body && tint ? { tint } : {}) });
	}
	const rows = Array.isArray(describe?.objects) ? describe.objects : [], parents = new Set(rows.map(row => row?.parent).filter(Boolean));
	// the first MAX_PROPS solids are offered as before; the objects the kinds flag adds have a count of their own, so none takes a solid's place
	let solids = 0, added = 0;
	for (const row of rows) {
		if (!row || row.hidden) continue;
		const w = finite(row.footprint?.width, 1) * finite(row.scaleX, 1), h = finite(row.height, 1) * finite(row.scaleY, 1), d = finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1);
		const point = w === 0 && h === 0 && d === 0, group = parents.has(row.id) ? { group: true } : {};
		if (row.attach) {
			// it rides a bone of a body the clip may animate: no prop (its place is in the bone's frame), but the install knows it
			const who = Object.entries(ids.characters).find(([, studioId]) => studioId === row.attach.characterId)?.[0];
			if (!who) continue;
			const id = idFor(row.name, taken, "object"), what = point ? { kind: kindOf(row, rows) } : { size: row.renderer === "sphere" ? [round(w), round(w), round(w)] : [round(w), round(h), round(d)] };
			ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot), attach: { ...row.attach }, quat: quatOf(row), ...(point ? { point: true, ...what } : {}), ...group };
			attached.push({ id, on: who, bone: row.attach.bone ?? "root", ...what });
			continue;
		}
		if (kinds && point && !row.parent) {
			if (added++ >= MAX_PROPS) continue;
			const id = idFor(row.name, taken, "object"), kind = kindOf(row, rows);
			ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot), point: true, kind, quat: quatOf(row), ...group };
			props.push({ id, size: [POINT, POINT, POINT], at: [round(finite(row.x)), round(finite(row.y)), round(finite(row.z))], kind, hollow: true });
			continue;
		}
		if (!SOLID.has(row.renderer) || finite(row.rotX) || finite(row.rotZ)) continue;
		if (h < FLAT && !(kinds && h > 0 && w < FLAT && d < FLAT && w > 0 && d > 0)) continue;
		if ((h < FLAT ? added++ : solids++) >= MAX_PROPS) continue;
		const cs = Math.abs(Math.cos(finite(row.rot) * RAD)), sn = Math.abs(Math.sin(finite(row.rot) * RAD));
		const id = idFor(row.name, taken, "prop");
		ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot), ...group };
		const sphere = row.renderer === "sphere", own = turn && !sphere, yaw = round(finite(row.rot));
		props.push({ id, size: sphere ? [round(w), round(w), round(w)] : own ? [round(w), round(h), round(d)] : [round(w * cs + d * sn), round(h), round(w * sn + d * cs)],
			at: [round(finite(row.x)), round(finite(row.y) + h / 2), round(finite(row.z))], ...(own && yaw ? { turn: yaw } : {}), ...(sphere ? { shape: "sphere" } : {}) });
		const flat = tops && Array.isArray(row.tops) ? row.tops : [];
		if (flat.length > 1 || (flat.length === 1 && flat[0].y < h - BAND)) props.at(-1).heights = flat.map(t => heightOf(t, row, own));
	}
	return { scene: { characters, props, others, ...(attached.length ? { attached } : {}) }, ids };
}
