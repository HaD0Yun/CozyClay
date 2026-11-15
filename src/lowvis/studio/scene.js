// The Studio scene as a lowvis scene (prototype): the objects and rig characters the Studio already has, written
// as the props and characters a lowvis request may use, so a motion can sit on the bench or lift the box that a
// build step (or the user) put there. install.js reads `ids` to move those instead of making them again.
// A lowvis prop is a box: with the turn flag it is the object's own box turned as the object is about Y, without it the
// box square to the axes around its footprint; a tilted object and anything flat as a floor are left out.
// Browser-safe and node-safe.
import { TRACK_RIG } from "./take.js";

const SOLID = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "sculpt", "mesh"]);
/** Rig models whose skeleton the clip can drive at scale 1; any but TRACK_RIG is changed to TRACK_RIG by the install. */
const SWITCHABLE = new Set(["y-bot-tpose"]);
const MAX_PROPS = 40, RAD = Math.PI / 180;
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

/** Why a visible character row cannot be animated by a clip, or null when it can. */
function whyNot(row) {
	if (row.model === "proxy-figure") return "capsule figure";
	if (row.model !== TRACK_RIG && !SWITCHABLE.has(row.model)) return /^rig-/.test(String(row.model ?? "")) ? "imported rig" : `model ${row.model ?? "unknown"}`;
	if (Math.abs(finite(row.scale, 1) - 1) > 1e-6) return `scale ${round(finite(row.scale, 1))}`;
	return null;
}

/**
 * studioScene(describe, { turn }) -> { scene: { characters: [{ id, at, heading }], props: [{ id, size, at, turn?, shape? }], others: [{ id, why }] }, ids }
 * describe: the editor's describe answer ({ characters, objects }). ids: { characters: { <lowvis id>: <Studio id> },
 * props: { <lowvis id>: { id: <Studio id>, x, y, z, rot } }, switch: [<Studio id>] } with each object's base pivot
 * and turn about Y as the Studio holds them. switch: the listed characters whose model the install changes to the
 * clip's rig before it animates them. others: visible characters the clip cannot animate (Studio id and why).
 * turn: a prop is the object's own box [w, h, d] with turn = the object's turn about Y (degrees; left out at 0).
 */
export function studioScene(describe, { turn = false } = {}) {
	const taken = new Set(), ids = { characters: {}, props: {}, switch: [] }, characters = [], props = [], others = [];
	for (const row of Array.isArray(describe?.characters) ? describe.characters : []) {
		if (!row || row.hidden) continue;
		const why = whyNot(row);
		if (why) { others.push({ id: String(row.id), why }); continue; }
		const id = idFor(String(row.id).replace(/^lowvis-/, ""), taken, "person");
		ids.characters[id] = row.id;
		if (row.model !== TRACK_RIG) ids.switch.push(row.id);
		characters.push({ id, at: [round(finite(row.x)), round(finite(row.z))], heading: round(finite(row.rot)) });
	}
	for (const row of Array.isArray(describe?.objects) ? describe.objects : []) {
		if (props.length >= MAX_PROPS) break;
		if (!row || row.hidden || row.attach || !SOLID.has(row.renderer) || finite(row.rotX) || finite(row.rotZ)) continue;
		const w = finite(row.footprint?.width, 1) * finite(row.scaleX, 1), h = finite(row.height, 1) * finite(row.scaleY, 1), d = finite(row.footprint?.depth, 1) * finite(row.scaleZ, 1);
		if (h < 0.03) continue;
		const cs = Math.abs(Math.cos(finite(row.rot) * RAD)), sn = Math.abs(Math.sin(finite(row.rot) * RAD));
		const id = idFor(row.name, taken, "prop");
		ids.props[id] = { id: row.id, x: finite(row.x), y: finite(row.y), z: finite(row.z), rot: finite(row.rot) };
		const sphere = row.renderer === "sphere", own = turn && !sphere, yaw = round(finite(row.rot));
		props.push({ id, size: sphere ? [round(w), round(w), round(w)] : own ? [round(w), round(h), round(d)] : [round(w * cs + d * sn), round(h), round(w * sn + d * cs)],
			at: [round(finite(row.x)), round(finite(row.y) + h / 2), round(finite(row.z))], ...(own && yaw ? { turn: yaw } : {}), ...(sphere ? { shape: "sphere" } : {}) });
	}
	return { scene: { characters, props, others }, ids };
}
