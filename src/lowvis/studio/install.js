// A lowvis clip as Studio scene content (prototype): its new props become Studio objects (a box: a sculpt of that one
// box, which object.sculpt can re-sculpt in place; a sphere or a box under 0.05 m tall: a sphere or a cube), its
// characters X Bot cast members whose take is the clip's motion (take.js), and a prop that moves rides a track of
// the take of the character that handles it (ownerOf), as any object a Studio take moves, so a timing edit of that
// take moves it with that character. Everything goes through editor actions, so the Studio's undo, save, selection,
// cameras and export see ordinary scene content.
// A clip character's scale and tint (clip.js) are the cast member's own scale and tint fields: set when it is added, or
// with character.update when the Studio holds other values; its take is of a body of that scale (take.js).
// installClip(clip, run, options) is the same for the Studio page (run = its own action runner) and for the agent
// sidecar (run = the turn's run_action). Browser-safe and node-safe: no three.js, no node:* import.
import { encodeRawTrack } from "../../motion-v4/track/codec.js";
import { qMul, qRotate } from "../rig17.js";
import { TRACK_RIG, clipTrack } from "./take.js";

/** Ids of the cast members a clip made: "lowvis-<clip character id>". */
export const LOWVIS_ID = /^lowvis-/;
const DEG = 180 / Math.PI, EPS = 1e-4;
const safe = id => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

/** The start of clip character `index` as a Studio placement: { x, z, rot (degrees about Y, 0 faces +Z) }. */
export function clipStart(clip, index) {
	const c = clip.characters[index], forward = qRotate([c.quat[0], c.quat[1], c.quat[2], c.quat[3]], [0, 0, 1]); // the Hips joint at frame 0
	return { x: c.pos[0], z: c.pos[2], rot: Math.round(Math.atan2(forward[0], forward[2]) * DEG * 10) / 10 };
}

/** A clip prop's pose at frame f as a Studio object's: the base pivot (the middle of its underside) and its rotation. */
function pivot(prop, f) {
	const n = prop.pos.length / 3, k = Math.min(f, n - 1), q = [prop.quat[k * 4], prop.quat[k * 4 + 1], prop.quat[k * 4 + 2], prop.quat[k * 4 + 3]];
	const height = prop.shape === "sphere" ? prop.size[0] : prop.size[1], down = qRotate(q, [0, -height / 2, 0]);
	return { pos: [prop.pos[k * 3] + down[0], prop.pos[k * 3 + 1] + down[1], prop.pos[k * 3 + 2] + down[2]], quat: q };
}

/** The turn about Y (degrees, 2 decimals) of an upright rotation. */
const yawOf = q => Math.round(2 * Math.atan2(q[1], q[3]) * DEG * 100) / 100;

// A sculpt measures at least 0.05 m tall (sculpt-recipe.js MIN_HEIGHT), so a thinner box stays a scaled cube.
const STAND_IN_MIN_HEIGHT = 0.05;
/** The recipe of a stand-in box [w, h, d]: one sharp box standing on the object's base, centred on it. */
const standInRecipe = size => ({ version: 1, parts: [{ id: "box", shape: "box", size: [...size], position: [0, size[1] / 2, 0], roundness: 0 }] });

/** The stand-in of a clip prop at frame 0: { kind: "sculpt" | "sphere" | "cube", size: [w, h, d], placement, upright }. */
export function standInOf(prop) {
	const at = pivot(prop, 0), upright = Math.abs(at.quat[0]) < EPS && Math.abs(at.quat[2]) < EPS;
	const size = prop.shape === "sphere" ? [prop.size[0], prop.size[0], prop.size[0]] : prop.size;
	const kind = prop.shape === "sphere" ? "sphere" : size[1] >= STAND_IN_MIN_HEIGHT ? "sculpt" : "cube";
	return { kind, size, placement: { x: at.pos[0], y: at.pos[1], z: at.pos[2], rot: upright ? yawOf(at.quat) : 0 }, upright };
}
const scaled = size => ({ scaleX: size[0], scaleY: size[1], scaleZ: size[2] });

/**
 * Adds the stand-in of one clip prop, named by its id: a box is a sculpt of that one box at scale 1, so object.sculpt
 * { id, recipe } can give it a look in place; a sphere or a box under 0.05 m tall is a sphere or a cube scaled to it.
 * -> its Studio id, or null when the Studio refused a step.
 */
export async function addStandIn(prop, run) {
	const { kind, size, placement } = standInOf(prop);
	const added = kind === "sculpt" ? await run("object.sculpt", { name: String(prop.id), placement, recipe: standInRecipe(size) })
		: await run("object.add", { kind, name: String(prop.id), placement });
	const id = added?.affectedIds?.[0];
	if (!id || (kind !== "sculpt" && !await run("object.update", { id, patch: scaled(size) }))) return null;
	return id;
}

/** True when the prop changes place or turns during the clip. */
function moves(prop) {
	const n = prop.pos.length / 3;
	for (let f = 1; f < n; f++) {
		for (let k = 0; k < 3; k++) if (Math.abs(prop.pos[f * 3 + k] - prop.pos[k]) > EPS) return true;
		for (let k = 0; k < 4; k++) if (Math.abs(prop.quat[f * 4 + k] - prop.quat[k]) > EPS) return true;
	}
	return false;
}

/**
 * The index of the clip character whose take draws moving prop `prop`: the one that handles it on the most frames it
 * moves. On a frame it is handled by what carries it (prop.by, clip.js: holding hands, the body it rides, and through a
 * prop it rides whatever carries that one); a prop nothing carries stays with the characters that last handled it until
 * another takes it (let go, thrown, dropped, rolling on). Ties: the one that carries it on more frames, then the earlier
 * character. 0 when no character handles it or the clip does not say (a clip without `by`).
 */
function ownerOf(clip, prop) {
	const index = new Map(clip.characters.map((c, i) => [c.id, i])), props = new Map((clip.props ?? []).map(p => [p.id, p]));
	const carriers = (p, f, seen) => (p.by?.[f] ?? []).flatMap(id => index.has(id) ? [index.get(id)] : props.has(id) && !seen.has(id) ? carriers(props.get(id), f, new Set([...seen, id])) : []);
	const moved = new Array(clip.characters.length).fill(0), held = moved.slice(), n = prop.pos.length / 3;
	let last = [];
	for (let f = 0; f < n; f++) {
		const now = [...new Set(carriers(prop, f, new Set([prop.id])))];
		if (now.length) last = now;
		for (const i of now) held[i]++;
		const step = f > 0 && ([0, 1, 2].some(k => Math.abs(prop.pos[f * 3 + k] - prop.pos[f * 3 - 3 + k]) > EPS) || [0, 1, 2, 3].some(k => Math.abs(prop.quat[f * 4 + k] - prop.quat[f * 4 - 4 + k]) > EPS));
		if (step) for (const i of last) moved[i]++;
	}
	let best = 0;
	for (let i = 1; i < moved.length; i++) if (moved[i] > moved[best] || (moved[i] === moved[best] && held[i] > held[best])) best = i;
	return best;
}

/**
 * installClip(clip, run, { label, remove, existing, drafted }) -> { characterIds, objectIds, switched, placed, ok, bodies?,
 * moved?, moving? }: what it made, the Studio ids of the cast members whose model it changed and placed:
 * { <clip prop id>: <Studio object id> } for every prop, made, known or drafted; ok false when the Studio refused a step.
 * bodies (only when there is one): [{ id, scale?, tint? }], the cast members whose scale or tint it set, with the fields
 * it set. moved: the listed objects it moved or turned; moving: the objects a track moves (each only when there is one).
 * drafted: { <clip prop id>: { id, untouched, size, place? } }, the stand-in an earlier compile of the same motion added
 * for that prop (addStandIn, of the kind this prop's stand-in has): it is set to the prop's place and turn, and to its
 * size when untouched (its record is still what the draft made); place { x, y, z, rot }: where it stands now (no step
 * when that is the prop's and the size stays).
 * run(action, args) -> the action's receipt ({ affectedIds }) or a falsy value when it was refused; it may be async.
 * remove: { characterIds, objectIds } of an earlier install, taken out first.
 * existing: the `ids` of scene.js studioScene, when the clip was written over the Studio's own scene: a clip prop or
 * character with a listed id IS that Studio object or cast member, so it is moved or animated, not made again. Such a
 * cast member loses its root path before its take goes in (the take holds the whole motion), and one listed in
 * existing.switch is changed to the clip's rig first. Characters the clip does not animate keep everything.
 * existing.bodies: { <Studio id>: { scale, tint } } as the Studio holds them (1 and none when it is not listed).
 * existing.start: the scale the Studio gives a new character it is not told one for (src/lowvis/studio/figure.js; 1). 
 * turn: the clip was written over studioScene(describe, { turn: true }), so a listed object's box stands turned as the
 * object does and the clip's rotation already holds that turn (it is not added again; a turn the model changed is set).
 */
export async function installClip(clip, run, { label = "lowvis", remove = null, existing = null, turn: turned = false, drafted = null } = {}) {
	for (const characterId of remove?.characterIds ?? []) await run("character.remove", { characterId });
	if (remove?.objectIds?.length) await run("object.remove", { ids: remove.objectIds });
	const objectIds = [], characterIds = [], switched = [], bodies = [], moved = [], placed = {}, tracks = {}, owners = {}, F = clip.frameCount, stop = () => ({ characterIds, objectIds, switched, placed, ok: false });
	for (const prop of clip.props ?? []) {
		const at = pivot(prop, 0), upright = Math.abs(at.quat[0]) < EPS && Math.abs(at.quat[2]) < EPS, known = existing?.props?.[prop.id];
		const own = turned && prop.shape !== "sphere"; // the clip box is the object's own, turned as it is
		const draft = known ? null : drafted?.[prop.id];
		let id = known?.id ?? draft?.id, turn = null;
		if (known) {
			// the scene the model wrote is where the motion happens: an object it stood elsewhere (or turned otherwise) goes there
			const patch = Math.hypot(at.pos[0] - known.x, at.pos[1] - known.y, at.pos[2] - known.z) > 0.005 ? { x: at.pos[0], y: at.pos[1], z: at.pos[2] } : {};
			if (own && upright) { const rot = yawOf(at.quat); if (Math.abs(((rot - known.rot) % 360 + 540) % 360 - 180) > 0.05) patch.rot = rot; }
			if (Object.keys(patch).length && !await run("object.update", { id, patch })) return stop();
			if (Object.keys(patch).length) moved.push(id);
			if (known.rot && !own) turn = [0, Math.sin(known.rot / DEG / 2), 0, Math.cos(known.rot / DEG / 2)]; // the object's own turn about Y, which the clip's box does not have
		} else if (draft) {
			// the draft's stand-in of this prop: the final place and turn, and the final size while it is as the draft made it
			const { kind, size, placement } = standInOf(prop), resize = draft.untouched && size.some((v, k) => Math.abs(v - draft.size[k]) > 1e-6);
			const still = !resize && draft.place && ["x", "y", "z"].every(k => Math.abs(placement[k] - draft.place[k]) < EPS) && Math.abs(((placement.rot - draft.place.rot) % 360 + 540) % 360 - 180) < 0.05;
			const done = still || (resize && kind === "sculpt" ? await run("object.sculpt", { id, placement, recipe: standInRecipe(size) })
				: await run("object.update", { id, patch: { ...placement, ...(resize ? scaled(size) : {}) } }));
			if (!done) return stop();
		} else {
			id = await addStandIn(prop, run);
			if (!id) return stop();
			objectIds.push(id);
		}
		placed[prop.id] = id;
		// a prop that moves, or a new one that stands tilted (an object's own fields hold a turn about Y only here), follows a track
		if (moves(prop) || (!known && !upright)) {
			const pos = new Float32Array(F * 3), quat = new Float32Array(F * 4);
			for (let f = 0; f < F; f++) { const p = pivot(prop, f); pos.set(p.pos, f * 3); quat.set(turn ? qMul(p.quat, turn) : p.quat, f * 4); }
			tracks[id] = { pos, quat };
			owners[id] = ownerOf(clip, prop);
		}
	}

	for (const [index, figure] of clip.characters.entries()) {
		const known = existing?.characters?.[figure.id], characterId = known ?? `lowvis-${safe(figure.id ?? index)}`;
		// the body the clip is of, against the one the Studio holds: only what differs is set
		const has = (known && existing?.bodies?.[known]) || { scale: existing?.start ?? 1, tint: null }, scale = figure.scale ?? 1, body = {};
		if (Math.abs(scale - (has.scale ?? 1)) > 1e-6) body.scale = scale;
		if (figure.tint && figure.tint.toLowerCase() !== String(has.tint ?? "").toLowerCase()) body.tint = figure.tint;
		const sized = Object.keys(body).length > 0;
		if (sized) bodies.push({ id: characterId, ...body });
		if (!known) {
			if (!await run("character.add", { character: { id: characterId, model: TRACK_RIG, ...clipStart(clip, index), ...body } })) return stop();
			characterIds.push(characterId);
		} else {
			if (existing?.switch?.includes(known)) {
				if (!await run("character.update", { characterId, patch: { model: TRACK_RIG } })) return stop();
				switched.push(characterId);
			}
			if (sized && !await run("character.update", { characterId, patch: body })) return stop();
			if (!await run("character.clearWaypoints", { characterId })) return stop();
		}
		const raw = clipTrack(clip, index);
		raw.objects = Object.fromEntries(Object.entries(tracks).filter(([id]) => owners[id] === index)); // this character's take draws the props it handles
		if (!await run("motion.v4.install", { characterId, raw: encodeRawTrack(raw), label: String(label).slice(0, 80) })) return stop();
	}
	const moving = Object.keys(tracks);
	return { characterIds, objectIds, switched, placed, ok: true, ...(bodies.length ? { bodies } : {}), ...(moved.length ? { moved } : {}), ...(moving.length ? { moving } : {}) };
}
