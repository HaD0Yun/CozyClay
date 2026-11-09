// Bench take.json v0 (the physics bench format, test/bench/physics/take.mjs on the bench branch) from a saved
// document whose character carries a v4 raw take (motionTake.spec.raw). The raw track is in the world frame, so the
// bone matrices are its fk and the placement plays no part. Objects follow the bench export's rules
// (export-cozyclay.mjs): a group sits at its root pose, a body at its box centre with the set's axes (a cylinder
// along x or z loses the turn the bench builder gave it). Lives in src/ with no import from test/: the bench branch
// calls it.
import { skeletonFor } from "../../motion3/rigs/index.js";
import { fk } from "../../motion3/compiler/skeleton.js";
import { add, apply, mul, T } from "../../motion3/compiler/math.js";
import { groupsOf } from "../../motion3/scene.js";
import { trackPose } from "../../motion3/physics-frames.js";
import { decodeRawTrack } from "./codec.js";
import { rawOut } from "./literal.js";

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// the turn the bench builder gives a cylinder along X (rotZ -90) or Z (rotX 90)
const ALIGN = { x: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], z: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] };
const round = v => Math.round(v * 1e7) / 1e7;
const mat4 = (R, p) => [...R[0], p[0], ...R[1], p[1], ...R[2], p[2], 0, 0, 0, 1].map(round);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/** The open scene of a project document (version 4/5 { scenes: { activeSceneId, scenes } }). */
function activeScene(doc) {
	const holder = doc?.scenes?.scenes ? doc.scenes : doc;
	const list = holder?.scenes ?? [];
	return list.find(s => s.id === holder.activeSceneId) ?? list[0] ?? null;
}

/** One set object's matrices over F frames; a still one keeps a single matrix. */
function objectMatrices(out, raw, groups, o, F) {
	const still = mat4(I3, o.center ?? [0, 0, 0]), align = o.shape === "cylinder" ? ALIGN[o.axis] : null, ms = [];
	for (let f = 0; f < F; f++) {
		if (o.shape === "group") { const r = trackPose(raw.objects[o.id], f) ?? groups[o.id]; ms.push(r ? mat4(r.R, r.pos) : still); continue; }
		const box = out.objectsAt(f)[o.id];
		ms.push(box?.half ? mat4(align ? mul(box.R, T(align)) : box.R, add(box.pos, apply(box.R, [0, box.half[1], 0]))) : still);
	}
	return ms.every(m => same(m, ms[0])) ? [ms[0]] : ms;
}

/**
 * rawTakeJson(doc, { characterId, objects, source }) -> take.json v0. objects is the bench set's object list
 * ([{ id, shape, size?, axis?, fixed?, mass?, parent? }]). Throws when the character has no raw take.
 */
export function rawTakeJson(doc, { characterId, objects = [], source = {} } = {}) {
	const scene = activeScene(doc), character = (scene?.stage?.characters ?? []).find(c => c?.id === characterId);
	const encoded = character?.motionTake?.spec?.raw;
	if (!encoded) throw new Error(`${characterId} has no raw take (motionTake.spec.raw)`);
	const sk = skeletonFor(character.motionTake.rig ?? character.model);
	if (!sk) throw new Error(`${characterId} is ${character.model}, which has no motion rig`);
	const raw = decodeRawTrack(encoded, sk), F = raw.frameCount, B = sk.names.length, bones = [];
	for (let f = 0; f < F; f++) {
		const quats = sk.names.map((_, b) => Array.from(raw.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4)));
		const s = fk(sk, quats, Array.from(raw.hips.subarray(f * 3, f * 3 + 3)));
		bones.push(sk.names.map((_, b) => mat4(s.R[b], s.P[b])));
	}
	const out = rawOut(raw, scene.objects ?? []), groups = groupsOf(out.ctx.scene), tracks = {};
	for (const o of objects) {
		tracks[o.id] = { shape: o.shape, size: o.size ?? null, fixed: Boolean(o.fixed), mass: o.mass ?? null, parent: o.parent ?? null, matrix: objectMatrices(out, raw, groups, o, F) };
	}
	return { version: 0, fps: 24, frames: F, rig: { name: sk.model, bones: sk.names.map(n => `mixamorig:${n}`) },
		characters: { [characterId]: { bones } }, objects: tracks, source: { tool: "cozyclay", raw: true, f0: 0, qa: null, ...source } };
}
