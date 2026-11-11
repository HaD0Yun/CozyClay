// object.duplicate's `copies` form: many varied copies of one object (a group root brings its whole subtree)
// placed in ONE write, so one undo takes them all back. Pure: the command reads and writes the objects store.
import { descendantsOf, updateSceneObject, objectSize, EMPTY_KIND, wrapAngle } from "./scene-objects.js";
import { normalizeObjectColor } from "./object-colors.js";
import { elementByPath } from "./studio-elements.js";
import { LIGHT_KIND } from "./object-look.js";
import { EFFECT_KIND } from "./effects/effect-record.js";

const COPIES_MAX = 64;
// A mutation receipt names at most 100 affected ids (studio-agent-protocol.js), and every copied record is one.
const COPY_RECORDS_MAX = 100;
const FACTOR = { min: 0.1, max: 10 };
const POSITION = elementByPath("object.position"), SCALE = elementByPath("object.scale");
// Records that draw nothing a colour could tint (a light's colour is its light, not its body).
const UNTINTED = new Set([EMPTY_KIND, LIGHT_KIND, EFFECT_KIND]);
const round = value => Math.round(value * 1000) / 1000;

function refuse(message, path) {
	const error = new Error(message);
	Object.assign(error, { code: "INVALID_ARGUMENT", path });
	throw error;
}

function inRange(value, min, max, path, unit) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) refuse(`${path}: ${JSON.stringify(value)} is outside ${min}..${max}${unit}.`, path);
	return value;
}

function factorOf(scale, path, group) {
	if (scale === undefined) return [1, 1, 1];
	const list = Array.isArray(scale) ? scale : [scale, scale, scale];
	if (list.length !== 3) refuse(`${path}: give one number or [x, y, z] factors, each ${FACTOR.min}..${FACTOR.max}.`, path);
	list.forEach((value, axis) => inRange(value, FACTOR.min, FACTOR.max, Array.isArray(scale) ? `${path}[${axis}]` : path, " (a factor of the source's size)"));
	// Members of a group sit at offsets from its pivot and turn their own way; only a uniform factor resizes them together.
	if (group && (list[0] !== list[1] || list[1] !== list[2])) refuse(`${path}: a group copy scales uniformly; give one number ${FACTOR.min}..${FACTOR.max}.`, path);
	return list;
}

function checkCopy(copy, index, group) {
	const path = `$.args.copies[${index}]`;
	inRange(copy.x, POSITION.min.x, POSITION.max.x, `${path}.x`, " m");
	inRange(copy.z, POSITION.min.z, POSITION.max.z, `${path}.z`, " m");
	if (copy.y !== undefined) inRange(copy.y, POSITION.min.y, POSITION.max.y, `${path}.y`, " m");
	if (copy.rot !== undefined) inRange(copy.rot, -360, 360, `${path}.rot`, " degrees of yaw");
	const color = copy.color === undefined ? null : normalizeObjectColor(copy.color);
	if (copy.color !== undefined && !color) refuse(`${path}.color: ${JSON.stringify(copy.color)} is not a colour; use #rrggbb or #rgb.`, `${path}.color`);
	return { factor: factorOf(copy.scale, `${path}.scale`, group), color };
}

// Unique against everything already in the scene and everything minted so far in this call.
function minter(objects) {
	const ids = new Set(objects.map(row => row.id)), names = new Set(objects.map(row => row.name));
	const next = (taken, base, join) => { let value = base; for (let n = 2; taken.has(value); n += 1) value = `${base}${join}${n}`; taken.add(value); return value; };
	return row => ({ id: next(ids, String(row.id).replace(/-\d+$/, ""), "-"), name: next(names, String(row.name || row.renderer).replace(/ \d+$/, ""), " ") });
}

/**
 * The scene with `copies` of `sourceId` appended, or a thrown INVALID_ARGUMENT naming the allowed values.
 * Each copy's root lands with its base pivot at x, z (y: the source's unless given), yawed to rot (the source's
 * unless given) and its scale multiplied by `scale`; a group's members are scaled about the root's pivot and
 * carried rigidly by the move and turn. `color` tints every copied record that draws.
 */
export function placeObjectCopies(objects, sourceId, copies) {
	const source = objects.find(row => row.id === sourceId);
	if (!source) refuse(`Object ${sourceId} is not in this scene.`, "$.args.objectId");
	if (source.attach) refuse(`${source.name || sourceId} rides a character; its numbers are bone-local. Detach it first, then copy it.`, "$.args.objectId");
	if (!Array.isArray(copies) || copies.length < 1 || copies.length > COPIES_MAX) refuse(`$.args.copies: give 1..${COPIES_MAX} copies.`, "$.args.copies");
	const members = descendantsOf(objects, sourceId), size = 1 + members.length;
	if (copies.length * size > COPY_RECORDS_MAX) refuse(`$.args.copies: ${source.name || sourceId} is a group of ${size} objects, so one call makes at most ${Math.floor(COPY_RECORDS_MAX / size)} copies of it (${COPY_RECORDS_MAX} new objects per call); split the rest into another call.`, "$.args.copies");
	const checked = copies.map((copy, index) => checkCopy(copy, index, members.length > 0));
	const mint = minter(objects), made = [], added = [];
	copies.forEach((copy, index) => {
		const { factor, color } = checked[index], f = factor[0];
		const fresh = new Map([source, ...members].map(row => [row.id, mint(row)]));
		const subtree = [source, ...members].map(row => {
			const { id, name } = fresh.get(row.id);
			const next = { ...row, id, name, parent: row === source ? row.parent ?? null : fresh.get(row.parent)?.id ?? null };
			// Members are scaled about the source's pivot here; the move and turn below carry them.
			if (row !== source) Object.assign(next, { x: source.x + (row.x - source.x) * f, y: (source.y ?? 0) + ((row.y ?? 0) - (source.y ?? 0)) * f, z: source.z + (row.z - source.z) * f });
			const scaled = row === source ? factor : [f, f, f];
			for (const [axis, key] of ["scaleX", "scaleY", "scaleZ"].entries()) next[key] = (row[key] ?? 1) * scaled[axis];
			return next;
		});
		for (const row of subtree) for (const key of ["scaleX", "scaleY", "scaleZ"]) {
			if (row[key] < SCALE.min.x || row[key] > SCALE.max.x) refuse(`$.args.copies[${index}].scale: ${row.name}'s ${key} would be ${round(row[key])}, outside ${SCALE.min.x}..${SCALE.max.x}; pick a factor nearer 1.`, `$.args.copies[${index}].scale`);
		}
		const rootId = subtree[0].id;
		let placed = updateSceneObject(subtree, rootId, { x: copy.x, z: copy.z, ...(copy.y === undefined ? {} : { y: copy.y }), ...(copy.rot === undefined ? {} : { rot: wrapAngle(copy.rot) }) });
		if (color) placed = placed.map(row => UNTINTED.has(row.renderer) ? row : { ...row, color });
		const root = placed[0], measured = objectSize(root);
		made.push({ id: rootId, size: { width: round(measured.width), height: round(measured.height), depth: round(measured.depth) },
			scale: [round(root.scaleX), round(root.scaleY), round(root.scaleZ)], ...(members.length ? { memberIds: placed.slice(1).map(row => row.id) } : {}) });
		added.push(...placed);
	});
	return { objects: [...objects, ...added], made, ids: added.map(row => row.id) };
}
