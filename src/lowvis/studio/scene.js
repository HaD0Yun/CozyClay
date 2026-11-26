// The Studio scene as a lowvis scene (prototype): the objects and rig characters the Studio already has, written
// as the props and characters a lowvis request may use, so a motion can sit on the bench or lift the box that a
// build step (or the user) put there. install.js reads `ids` to move those instead of making them again.
// A lowvis prop is a box: with the turn flag it is the object's own box turned as the object is about Y, without it the
// box square to the axes around its footprint; a tilted object and anything flat as a floor are left out, unless a take
// already moves it: a solid with a box that a take moves is always offered, so a motion moves it again instead of making it again.
// With the kinds flag an object with no box of its own (footprint and height 0: an effect, a light, a group's Empty) is a
// prop too: a POINT box centred on its place, hollow, with kind naming what it is, so a motion can move it as any prop
// (a hand holds it, ride puts it on a joint or a prop) and install.js moves the object itself, keeping its kind.
// Browser-safe and node-safe.
import { TRACK_RIG } from "./take.js";
import { qRotate } from "../rig17.js";
import { propParts } from "./parts.js";
import { studioLines } from "./line-objects.js";

const SOLID = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "sculpt", "mesh"]);
/** Rig models whose skeleton the clip can drive at scale 1; any but TRACK_RIG is changed to TRACK_RIG by the install. */
const SWITCHABLE = new Set(["y-bot-tpose"]);
const MAX_PROPS = 40, RAD = Math.PI / 180;
const FLAT = 0.03; // an object under this tall and wider than it lies on the floor as a floor does
/** The side of the box a point object is drawn as in the motion writer's sheets, in metres: a marker the size of a
 *  fingertip, small enough to sit at a mouth, a wrist or the tip of a held prop. */
export const POINT = 0.02;
const round = v => Math.round(v * 1000) / 1000;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** A name the lowvis spec can use as an id, unique among `taken` (which it joins). own: the id the writer of a motion
 *  that plays gave this very thing (takeMoved): it is told back as written, whatever it is made of. */
function idFor(name, taken, fallback, own = null) {
	const base = own ?? (String(name ?? "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback);
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
/** The ids of the objects an installed take moves: the object tracks of each character's raw take (install.js), read
 *  from the open scene's stage, which holds the take the Studio plays now; a cast row's take is the one the scene last
 *  saved or loaded, read only for a character the stage does not list. With them, the ids the writers of those motions
 *  gave, as the Studio keeps them: ids.as: Map(<Studio character id> -> the id its take records, install.js `as`), and
 *  ids.props: the prop ids of the scenes the takes keep (the install names an object it makes by its prop's id). */
function takeMoved(describe) {
	const doc = describe?.document, open = Array.isArray(doc?.scenes) ? doc.scenes.find(scene => scene?.id === doc.activeSceneId) : null, ids = Object.assign(new Set(), { as: new Map(), props: new Set(), lines: new Map() });
	const staged = Array.isArray(open?.stage?.characters) ? open.stage.characters : [], listed = new Set(staged.map(row => row?.id));
	for (const row of [...staged, ...(Array.isArray(describe?.characters) ? describe.characters : []).filter(row => !listed.has(row?.id))]) {
		const objects = row?.motionTake?.spec?.raw?.objects;
		if (objects && typeof objects === "object" && !Array.isArray(objects)) for (const id of Object.keys(objects)) ids.add(id);
		const kept = row?.motionTake?.spec?.lowvis;
		if (typeof kept?.as === "string" && kept.as) ids.as.set(row.id, kept.as);
		for (const prop of Array.isArray(kept?.scene?.props) ? kept.scene.props : []) if (typeof prop?.id === "string") { ids.props.add(prop.id); if (prop.line && Number.isFinite(prop.line.length) && Number.isFinite(prop.line.thick)) ids.lines.set(prop.id, prop); } // a line: its segments (line-objects.js)
	}
	return ids;
}
/** The record's own turn (rotX, rot, rotZ in degrees, the Studio's XYZ order) as a quaternion [x, y, z, w]. */
function quatOf(row) {
	const h = [finite(row.rotX), finite(row.rot), finite(row.rotZ)].map(v => v * RAD / 2), [cx, cy, cz] = h.map(Math.cos), [sx, sy, sz] = h.map(Math.sin);
	return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz].map(v => Math.round(v * 1e6) / 1e6);
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
 * studioScene(describe, { turn, tops, body, kinds }) -> { scene: { characters: [{ id, at, heading, scale?, tint? }], props: [{ id, size, at, turn?, shape?, parts?, kind?, hollow? }], others: [{ id, why }] }, ids }
 * describe: the editor's describe answer ({ characters, objects }). ids: { characters: { <lowvis id>: <Studio id> },
 * props: { <lowvis id>: { id: <Studio id>, x, y, z, rot } }, switch: [<Studio id>] } with each object's base pivot
 * and turn about Y as the Studio holds them. switch: the listed characters whose model the install changes to the
 * clip's rig before it animates them. others: visible characters the clip cannot animate (Studio id and why).
 * turn: a prop is the object's own box [w, h, d] with turn = the object's turn about Y (degrees; left out at 0).
 * tops: describe was asked with { parts: true } (tops.js objectParts): a prop whose object's drawn shape is not its box
 * gets parts: [{ name, at, size, turn? }] (parts.js propParts), its drawn shape in the prop's own frame from
 * its box centre, and ids.shapes: { <prop id>: { h: the box's height, parts: the same parts from its base } }
 * (bin/agent/motion-run.mjs gives them to the motion tool, which sets them on a prop of that id at the height the
 * writer gives it: the install stands the object on the base of that box); ids.unmeasured: the props of which describe
 * measured nothing (their shape is not known: neither parts nor "its box").
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
 * An object an installed take moves (an object track of a character's raw take, read from describe's open scene)
 * is offered whatever the counts, however small (a side under 1 mm is given as 1 mm) and, upright about its centre
 * (with its parts as in its own frame), when it stands tilted; what is offered without the take keeps its id and its place in the counts.
 * scene.studioIds: { <prop or attached id>: <Studio id> } of these and the attached ones, left out when there is none;
 * scene.tilted: the ids of the props given upright that stand tilted in the Studio, left out when there is none.
 */
export function studioScene(describe, { turn = false, tops = false, body = false, kinds = false } = {}) {
	const taken = new Set(), ids = { characters: {}, props: {}, switch: [] }, characters = [], props = [], others = [], attached = [];
	// a thing a motion that plays made or animates is told under the id that motion's writer gave it, as written
	const moved = takeMoved(describe), named = (row, fallback) => idFor(row.name, taken, fallback, moved.props.has(row.name) ? row.name : null);
	for (const row of Array.isArray(describe?.characters) ? describe.characters : []) {
		if (!row || row.hidden) continue;
		const why = whyNot(row) ?? (body ? null : whyScale(row));
		if (why) { others.push({ id: String(row.id), why }); continue; }
		const id = idFor(String(row.id).replace(/^lowvis-/, ""), taken, "person", moved.as.get(row.id));
		ids.characters[id] = row.id;
		if (row.model !== TRACK_RIG) ids.switch.push(row.id);
		const scale = finite(row.scale, 1), tint = typeof row.tint === "string" ? row.tint : null;
		if (body) (ids.bodies ??= {})[row.id] = { scale, tint };
		characters.push({ id, at: [round(finite(row.x)), round(finite(row.z))], heading: round(finite(row.rot)), ...(body && scale !== 1 ? { scale } : {}), ...(body && tint ? { tint } : {}) });
	}
	const all = Array.isArray(describe?.objects) ? describe.objects : [], lines = studioLines(all, moved.lines), rows = all.filter(row => !lines.rows.has(row)), parents = new Set(rows.map(row => row?.parent).filter(Boolean));
	for (const p of lines.props) taken.add(p.id); // a line made of segments is one prop, outside the counts below
	if (lines.props.length) ids.lines = lines.ids;
	// an object a take moves is offered whatever the count, its size or its tilt, beside what is offered without the take:
	// every object keeps the id and the slot of the count it has in describe's order, so an id names the same object on
	// the call before a take moves it and on the call after
	const studioIds = {}, leaning = [];
	// the first MAX_PROPS solids are offered as before; the objects the kinds flag adds have a count of their own, so none takes a solid's place
	let solids = 0, added = 0;
	for (const row of rows) {
		if (!row || row.hidden) continue;
		const w = finite(row.footprint?.width, 1) * finite(row.scaleX, 1), h = finite(row.height, 1) * finite(row.scaleY, 1), d = finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1);
		const point = w === 0 && h === 0 && d === 0, group = parents.has(row.id) ? { group: true } : {}, ours = moved.has(row.id);
		if (row.attach) {
			// it rides a bone of a body the clip may animate: no prop (its place is in the bone's frame), but the install knows it
			const who = Object.entries(ids.characters).find(([, studioId]) => studioId === row.attach.characterId)?.[0];
			if (!who) continue;
			const id = named(row, "object"), what = point ? { kind: kindOf(row, rows) } : { size: row.renderer === "sphere" ? [round(w), round(w), round(w)] : [round(w), round(h), round(d)] };
			ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot), attach: { ...row.attach }, quat: quatOf(row), ...(point ? { point: true, ...what } : {}), ...group };
			attached.push({ id, on: who, bone: row.attach.bone ?? "root", ...what });
			studioIds[id] = row.id;
			continue;
		}
		if (kinds && point && !row.parent) {
			if (added++ >= MAX_PROPS && !ours) continue;
			const id = named(row, "object"), kind = kindOf(row, rows);
			ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot), point: true, kind, quat: quatOf(row), ...group };
			props.push({ id, size: [POINT, POINT, POINT], at: [round(finite(row.x)), round(finite(row.y)), round(finite(row.z))], kind, hollow: true });
			if (ours) studioIds[id] = row.id;
			continue;
		}
		if (!SOLID.has(row.renderer)) continue;
		// offered without a take: upright, not flat as a floor, within its count; one a take moves also when it has a box
		const tilted = Boolean(finite(row.rotX) || finite(row.rotZ)), plain = !tilted && (h >= FLAT || (kinds && h > 0 && w < FLAT && d < FLAT && w > 0 && d > 0));
		if (!(plain && (h < FLAT ? added++ : solids++) < MAX_PROPS) && !(ours && w > 0 && h > 0 && d > 0)) continue;
		const cs = Math.abs(Math.cos(finite(row.rot) * RAD)), sn = Math.abs(Math.sin(finite(row.rot) * RAD));
		const id = named(row, "prop"), side = v => (ours ? Math.max(0.001, round(v)) : round(v));
		// a tilted object a take moves is offered upright about its centre (the take gives its turn on every frame); the base
		// the install compares the prop's with is that upright box's, so a motion that leaves it in place does not move it
		const centre = tilted ? qRotate(quatOf(row), [0, h / 2, 0]).map((v, k) => v + finite([row.x, row.y, row.z][k])) : [finite(row.x), finite(row.y) + h / 2, finite(row.z)];
		ids.props[id] = { id: row.id, ...(tilted ? { x: centre[0], y: centre[1] - h / 2, z: centre[2] } : { x: finite(row.x), y: finite(row.y), z: finite(row.z) }), rot: finite(row.rot), ...group };
		if (ours) studioIds[id] = row.id;
		if (tilted) leaning.push(id);
		const sphere = row.renderer === "sphere", own = turn && !sphere, yaw = round(finite(row.rot));
		props.push({ id, size: sphere ? [side(w), side(w), side(w)] : own ? [side(w), side(h), side(d)] : [side(w * cs + d * sn), side(h), side(w * sn + d * cs)],
			at: centre.map(round), ...(own && yaw ? { turn: yaw } : {}), ...(sphere ? { shape: "sphere" } : {}) });
		// measured in the object's own frame, which is the prop's (a tilted one a take moves: the take gives it its turn on every frame)
		const drawn = tops ? propParts(row.parts, { size: props.at(-1).size, own: own || sphere, yaw: finite(row.rot) }) : null;
		if (drawn) { props.at(-1).parts = drawn.centre; (ids.shapes ??= {})[id] = { h: props.at(-1).size[1], parts: drawn.base }; }
		else if (tops && !row.parts?.length) (ids.unmeasured ??= []).push(id); // nothing of it was measured (not mounted, or it draws no mesh): its shape is not known
	}
	props.push(...lines.props);
	return { scene: { characters, props, others, ...(attached.length ? { attached } : {}), ...(Object.keys(studioIds).length ? { studioIds } : {}), ...(leaning.length ? { tilted: leaning } : {}) }, ids };
}
