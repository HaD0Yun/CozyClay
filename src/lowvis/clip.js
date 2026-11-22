// lowvis.clip.v1: what an engine writes and the viewer plays. One file per engine per demo:
//   public/lowvis/clips/<engine>/<demo>.json
//
// {
//   schema: "lowvis.clip.v1", demo, engine, fps: 24, frameCount: F,
//   joints: [17 names]                               // rig17.js JOINTS, in this order
//   characters: [{ id, pos: [F*17*3], quat: [F*17*4] }]   // WORLD space, metres, Y up; quat = rotation from rest (rig17.js)
//                                                    // optional scale: the body's size (1 when left out): every rest
//                                                    // length of rig17.js times it; optional tint: its colour "#rrggbb"
//   props: [{ id, size: [w,h,d], pos: [N*3], quat: [N*4] }] // boxes, pos = box CENTRE; N is F (animated) or 1 (static)
//                                                    // optional shape: "sphere" draws a ball of diameter size[0]
//                                                    // optional by (an animated prop): per frame, the ids of what
//                                                    // carries it as that frame ends: the characters whose hands hold
//                                                    // it, else the character (a joint) or the prop it rides; [] none
//                                                    // optional shown (a prop with hide / show keys): per frame of the
//                                                    // clip (F entries, also for a static prop), 1 drawn, 0 hidden
//   stats: { buildMs, ... }                          // free form; buildMs = time to compute the clip
//   notes: [strings]                                 // what the engine could not do, in plain words
// }
import { JOINTS, JOINT_COUNT, PARENT, REST } from "./rig17.js";

export const CLIP_SCHEMA = "lowvis.clip.v1";
export const CLIP_FPS = 24;

export function createClip({ demo, engine, frameCount, fps = CLIP_FPS }) {
	return { schema: CLIP_SCHEMA, demo, engine, fps, frameCount, joints: JOINTS.slice(), characters: [], props: [], stats: {}, notes: [] };
}

/** Adds a character and returns it; fill it with setPose. */
export function addCharacter(clip, id) {
	const c = { id, pos: new Float32Array(clip.frameCount * JOINT_COUNT * 3), quat: new Float32Array(clip.frameCount * JOINT_COUNT * 4) };
	for (let i = 3; i < c.quat.length; i += 4) c.quat[i] = 1;
	clip.characters.push(c);
	return c;
}

/** Writes frame f of a character from { pos: [17][3], quat: [17][4] } (rig17.js fk's result). */
export function setPose(character, f, pose) {
	for (let j = 0; j < JOINT_COUNT; j++) {
		character.pos.set(pose.pos[j], (f * JOINT_COUNT + j) * 3);
		character.quat.set(pose.quat[j], (f * JOINT_COUNT + j) * 4);
	}
}

/** Adds a box prop. `frames` is 1 for a static prop, clip.frameCount for a moving one. */
export function addProp(clip, id, size, frames = 1) {
	const p = { id, size: size.slice(), pos: new Float32Array(frames * 3), quat: new Float32Array(frames * 4) };
	for (let i = 3; i < p.quat.length; i += 4) p.quat[i] = 1;
	clip.props.push(p);
	return p;
}

const round = a => Array.from(a, v => Math.round(v * 1e5) / 1e5);

/** JSON text of a clip (typed arrays become plain arrays, 5 decimals). */
export function serializeClip(clip) {
	return JSON.stringify({
		...clip,
		characters: clip.characters.map(c => ({ id: c.id, ...((c.scale ?? 1) === 1 ? {} : { scale: c.scale }), ...(c.tint ? { tint: c.tint } : {}), pos: round(c.pos), quat: round(c.quat) })),
		props: clip.props.map(p => ({ id: p.id, size: p.size, ...(p.shape ? { shape: p.shape } : {}), pos: round(p.pos), quat: round(p.quat), ...(p.by ? { by: p.by } : {}), ...(p.shown ? { shown: Array.from(p.shown) } : {}) })),
	});
}

/**
 * Checks a parsed clip. Returns { ok, errors: [strings], stretch } where stretch is the largest change of a
 * joint-to-parent distance from rest (m; the rest of a character's own scale) over all frames: a rigid 17-joint figure
 * keeps it near 0.
 */
export function validateClip(clip, { maxStretch = 0.005 } = {}) {
	const errors = [];
	if (clip?.schema !== CLIP_SCHEMA) errors.push(`schema is ${clip?.schema}, want ${CLIP_SCHEMA}`);
	const F = clip?.frameCount;
	if (!Number.isInteger(F) || F < 1) errors.push(`frameCount ${F}`);
	if (clip?.joints?.join() !== JOINTS.join()) errors.push("joints differ from rig17.js JOINTS");
	if (!clip?.characters?.length) errors.push("no characters");
	let stretch = 0;
	for (const c of clip?.characters ?? []) {
		if (c.pos?.length !== F * JOINT_COUNT * 3) { errors.push(`${c.id}: pos length ${c.pos?.length}, want ${F * JOINT_COUNT * 3}`); continue; }
		if (c.quat?.length !== F * JOINT_COUNT * 4) { errors.push(`${c.id}: quat length ${c.quat?.length}, want ${F * JOINT_COUNT * 4}`); continue; }
		if (!c.pos.every(Number.isFinite) || !c.quat.every(Number.isFinite)) { errors.push(`${c.id}: non-finite value`); continue; }
		if (c.scale !== undefined && !(Number.isFinite(c.scale) && c.scale > 0)) { errors.push(`${c.id}: scale ${c.scale}`); continue; }
		for (let i = 0; i < c.quat.length; i += 4) {
			const n = Math.hypot(c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]);
			if (Math.abs(n - 1) > 1e-3) { errors.push(`${c.id}: quaternion ${i / 4} has length ${n.toFixed(4)}`); break; }
		}
		for (let f = 0; f < F; f++) for (let j = 1; j < JOINT_COUNT; j++) {
			const a = (f * JOINT_COUNT + j) * 3, b = (f * JOINT_COUNT + PARENT[j]) * 3;
			const d = Math.hypot(c.pos[a] - c.pos[b], c.pos[a + 1] - c.pos[b + 1], c.pos[a + 2] - c.pos[b + 2]);
			const rest = Math.hypot(...REST[j].map((v, k) => v - REST[PARENT[j]][k])) * (c.scale ?? 1);
			stretch = Math.max(stretch, Math.abs(d - rest));
		}
	}
	if (stretch > maxStretch) errors.push(`bone stretch ${stretch.toFixed(4)} m is over ${maxStretch} m`);
	for (const p of clip?.props ?? []) {
		const n = p.pos?.length / 3;
		if (p.size?.length !== 3 || (n !== 1 && n !== F) || p.quat?.length !== n * 4 || (p.by !== undefined && (!Array.isArray(p.by) || p.by.length !== n))) errors.push(`prop ${p.id}: size/pos/quat/by lengths`);
		if (p.shown !== undefined && (p.shown?.length !== F || !Array.from(p.shown).every(v => v === 0 || v === 1))) errors.push(`prop ${p.id}: shown wants ${F} entries of 0 or 1`);
	}
	return { ok: errors.length === 0, errors, stretch };
}
