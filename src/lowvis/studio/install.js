// A lowvis clip as Studio scene content (prototype): its props become Studio objects (cubes and spheres), its
// characters X Bot cast members whose take is the clip's motion (take.js), and a prop that moves rides a track of
// the first character's take, as any object a Studio take moves. Everything goes through editor actions, so the
// Studio's undo, save, selection, cameras and export see ordinary scene content.
// installClip(clip, run, options) is the same for the Studio page (run = its own action runner) and for the agent
// sidecar (run = the turn's run_action). Browser-safe and node-safe: no three.js, no node:* import.
import { encodeRawTrack } from "../../motion-v4/track/codec.js";
import { qRotate } from "../rig17.js";
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
 * installClip(clip, run, { label, remove }) -> { characterIds, objectIds, ok }: what it made; ok false when the Studio refused a step.
 * run(action, args) -> the action's receipt ({ affectedIds }) or a falsy value when it was refused; it may be async.
 * remove: { characterIds, objectIds } of an earlier install, taken out first.
 */
export async function installClip(clip, run, { label = "lowvis", remove = null } = {}) {
	for (const characterId of remove?.characterIds ?? []) await run("character.remove", { characterId });
	if (remove?.objectIds?.length) await run("object.remove", { ids: remove.objectIds });
	const objectIds = [], characterIds = [], tracks = {}, F = clip.frameCount, stop = () => ({ characterIds, objectIds, ok: false });
	for (const prop of clip.props ?? []) {
		const at = pivot(prop, 0), upright = Math.abs(at.quat[0]) < EPS && Math.abs(at.quat[2]) < EPS;
		const size = prop.shape === "sphere" ? [prop.size[0], prop.size[0], prop.size[0]] : prop.size;
		const added = await run("object.add", { kind: prop.shape === "sphere" ? "sphere" : "cube", name: String(prop.id),
			placement: { x: at.pos[0], y: at.pos[1], z: at.pos[2], rot: upright ? Math.round(2 * Math.atan2(at.quat[1], at.quat[3]) * DEG * 100) / 100 : 0 } });
		const id = added?.affectedIds?.[0];
		if (!id) return stop();
		objectIds.push(id);
		if (!await run("object.update", { id, patch: { scaleX: size[0], scaleY: size[1], scaleZ: size[2] } })) return stop();
		// a prop that moves, or stands tilted (an object's own fields hold a turn about Y only here), follows a track
		if (moves(prop) || !upright) {
			const pos = new Float32Array(F * 3), quat = new Float32Array(F * 4);
			for (let f = 0; f < F; f++) { const p = pivot(prop, f); pos.set(p.pos, f * 3); quat.set(p.quat, f * 4); }
			tracks[id] = { pos, quat };
		}
	}

	for (const [index, figure] of clip.characters.entries()) {
		const characterId = `lowvis-${safe(figure.id ?? index)}`;
		if (!await run("character.add", { character: { id: characterId, model: TRACK_RIG, ...clipStart(clip, index) } })) return stop();
		characterIds.push(characterId);
		const raw = clipTrack(clip, index);
		if (index === 0) raw.objects = tracks; // one take draws the props that move
		if (!await run("motion.v4.install", { characterId, raw: encodeRawTrack(raw), label: String(label).slice(0, 80) })) return stop();
	}
	return { characterIds, objectIds, ok: true };
}
