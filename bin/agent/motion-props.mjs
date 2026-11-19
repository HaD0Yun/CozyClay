// Objects made while a motion is written, and what the install set on each object (rule 6).
// The Studio agent builds the objects while the motion writer works; the writer keeps its freedom over every prop's size
// and place. At the install, a prop the writer added (not one of the scene it read) is taken by an object made since the
// motion started whose name, written as an id, is the prop's id (the same spelling an id gets from a name: scene.js
// idFor, so the next motion reads the object under that id): the object is set to the prop's place and turn
// (install.js made) and keeps its own size. Only geometry and names: no object kinds.
//   idOf(name)                                         the prop id a name is written as
//   takenBy({ props, known, before, rows, building })  { made, twins, idle }: which object takes which prop
//   propsSetOf({ props, placed, done, take, start, now }) the lines the agent reads: what the install set, per object
import { boxRow } from "../../src/lowvis/studio/scene.js";

const PLACE = 0.01, TURN = 0.5; // metres, degrees: smaller differences are not told
const r2 = v => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/** The prop id a name is written as: letters, digits and _ (scene.js idFor), or "" for none. */
export const idOf = name => String(name ?? "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
// a name as building names it: its id in any letter case, or the name itself when it has no id
const keyOf = name => idOf(name).toLowerCase() || String(name ?? "").trim();
/** An object's own size at scale 1: [footprint width, height, footprint depth]. */
const ownSize = row => [finite(row.footprint?.width), finite(row.height), finite(row.footprint?.depth)];
/** A describe row as the Studio draws it: base, size (scaled), turn. */
const shapeOf = row => ({ base: [finite(row.x), finite(row.y), finite(row.z)], size: ownSize(row).map((v, k) => v * finite(row[["scaleX", "scaleY", "scaleZ"][k]], 1)), turn: finite(row.rot) });

/**
 * Which object made since the motion started takes which prop the motion adds. props: the clip's props ([{ id }]);
 * known: studioScene ids.props (the props of the scene the writer read: never taken); before: the ids of every object of
 * that scene; rows: describe objects now; building: the names the agent gave the motion call.
 * -> made: { <prop id>: { id } } (install.js made); twins: { <prop id>: [ids] } when more than one object has the
 * name (none takes it); idle: [{ id, name }] objects made meanwhile, named in building, that take no prop.
 */
export function takenBy({ props = [], known = {}, before = new Set(), rows = [], building = [] }) {
	const meanwhile = rows.filter(row => row && !before.has(row.id));
	const fresh = meanwhile.filter(row => boxRow(row) && !row.parent);
	const made = {}, twins = {}, used = new Set();
	for (const prop of props) {
		if (known[prop.id]) continue;
		const same = fresh.filter(row => idOf(row.name) === prop.id);
		if (same.length === 1) { made[prop.id] = { id: same[0].id }; used.add(same[0].id); }
		else if (same.length > 1) { twins[prop.id] = same.map(row => row.id); for (const row of same) used.add(row.id); }
	}
	const named = new Set(building.map(keyOf).filter(Boolean));
	const idle = meanwhile.filter(row => !used.has(row.id) && named.has(keyOf(row.name))).map(row => ({ id: row.id, name: String(row.name) }));
	return { made, twins, idle };
}

const list = v => `[${v.map(r2).join(", ")}]`;
const box = v => `${v.map(r2).join(" x ")} m`;
/** The differences between an object before and after the install: base, turn, as short texts. */
function changes(was, now) {
	const out = [];
	if (Math.hypot(...now.base.map((v, k) => v - was.base[k])) > PLACE) out.push(`base ${list(now.base)} (was ${list(was.base)})`);
	if (angle(now.turn, was.turn) > TURN) out.push(`turn ${r2(now.turn)}° (was ${r2(was.turn)}°)`);
	return out;
}

/**
 * What the install set, one line per object, every number read from the scene: props (the clip's), placed (install.js
 * placed), done (install.js answer: objectIds, fitted, moved, moving), take (takenBy answer), start (describe rows the
 * motion started from, by id), at (describe rows just before the install, by id), now (describe rows after it, by id).
 * -> [text], or null when the install set nothing on any object and no object made meanwhile was left out.
 */
export function propsSetOf({ props = [], placed = {}, done = {}, take = { twins: {}, idle: [] }, start = new Map(), at = new Map(), now = new Map() }) {
	const out = [], made = new Set(done.objectIds ?? []), fitted = new Set(done.fitted ?? []), moved = new Set(done.moved ?? []), moving = new Set(done.moving ?? []);
	for (const prop of props) {
		const id = placed[prop.id], row = now.get(id);
		if (!id || !row) continue;
		const shape = shapeOf(row), starts = moving.has(id) ? "; the motion moves it from there" : "";
		if (fitted.has(id) && at.get(id)) {
			const differs = changes(shapeOf(at.get(id)), shape);
			out.push(`${row.name ?? prop.id} (${id}), made meanwhile, took the motion's prop ${prop.id}: ${differs.length ? differs.join(", ") : "it already had the prop's place and turn"}${starts}.`);
		} else if (moved.has(id) && start.get(id)) {
			const differs = changes(shapeOf(start.get(id)), shape);
			if (differs.length) out.push(`${row.name ?? prop.id} (${id}): the motion moved it: ${differs.join(", ")}${starts}.`);
		} else if (made.has(id)) {
			const twins = take.twins?.[prop.id];
			out.push(`${prop.id} (${id}): the motion added it as a stand-in, ${box(shape.size)}, base ${list(shape.base)}${shape.turn ? `, turn ${r2(shape.turn)}°` : ""}${starts}; no object made meanwhile took it${twins ? ` (${twins.length} have this name: ${twins.join(", ")})` : ""}.`);
		}
	}
	for (const { id, name } of take.idle ?? []) if (now.has(id)) out.push(`${name} (${id}), made meanwhile: the motion does not use it.`);
	return out.length ? out : null;
}
