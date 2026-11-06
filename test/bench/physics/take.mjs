// take.json v0 of the physical motion bench (docs/qa/physics-bench.md): one file per run, the same shape for both
// tools, and the landmarks the scorer reads from it.
//   { version: 0, fps: 24, frames: F,
//     rig: { name: "y-bot-tpose", bones: ["mixamorig:Hips", ...] },         // the 65 Y Bot bones, CozyClay rig order
//     characters: { "char-a": { bones: [[m16 per bone] per frame] } },
//     objects: { id: { shape, size, fixed, mass, parent, matrix: [m16 per frame] } },   // one entry: it never moves
//     source: { tool: "cozyclay" | "blender", set, commit, model, effort, run } }
// Every m16 is a row-major 4x4 world matrix in set axes (metres, +Y up, the character faces +Z). A bone matrix has
// the CozyClay rig's bone frame (src/motion3/rigs/y-bot-tpose.json, the frames the motion compiler solves), so the
// Blender exporter maps its own bone frames onto these (blender/take_io.py). An object matrix sits at the body's
// centre (a group: its root) with the set's axes as its rest axes, so a still object is a pure translation.
// Landmarks are fixed points on bones, measured once on the rig at rest: the same code then reads both tools.
import { readFileSync, writeFileSync } from "node:fs";
import { solePoints } from "../../../src/motion3/qa/geometry.js";
import { skeletonFor } from "../../../src/motion3/rigs/index.js";

const sk = skeletonFor("y-bot-tpose");
export const RIG = { name: "y-bot-tpose", bones: sk.names.map(n => `mixamorig:${n}`) };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const apply = (R, v) => [0, 1, 2].map(i => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
const T = R => [0, 1, 2].map(i => [R[0][i], R[1][i], R[2][i]]);
const round = v => Math.round(v * 1e7) / 1e7;

/** Row-major 4x4 from a 3x3 rotation and a position. */
export const mat4 = (R, p) => [...R[0], p[0], ...R[1], p[1], ...R[2], p[2], 0, 0, 0, 1].map(round);
/** { R, p } of a row-major 4x4. */
export const unmat4 = m => ({ R: [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]], p: [m[3], m[7], m[11]] });

// [name, bone, rest world point] -> the point in that bone's frame. Starting values (plan 2.1): the palm is midway
// from the wrist to the middle knuckle, soles are the QA sole points (qa/geometry.js), the buttocks sit 8 cm below
// and 11 cm behind the hips joint, the chest 5 cm above and 11 cm ahead of Spine2.
const rest = { P: sk.restWorldPos, R: sk.restWorldRot }, I = sk.index, P0 = sk.restWorldPos;
const at = name => P0[I[name]];
const DEFS = [];
for (const [k, side] of [["l", "Left"], ["r", "Right"]]) {
	DEFS.push([`palm_${k}`, `${side}Hand`, mid(at(`${side}Hand`), at(`${side}HandMiddle1`))]);
	for (const f of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) DEFS.push([`${f.toLowerCase()}_tip_${k}`, `${side}Hand${f}4`, at(`${side}Hand${f}4`)]);
	const sole = solePoints(sk, rest, side);
	DEFS.push([`heel_${k}`, `${side}Foot`, sole.heel], [`ball_${k}`, `${side}ToeBase`, sole.ball], [`toe_tip_${k}`, `${side}Toe_End`, sole.tip]);
	DEFS.push([`knee_${k}`, `${side}Leg`, at(`${side}Leg`)], [`elbow_${k}`, `${side}ForeArm`, at(`${side}ForeArm`)]);
}
DEFS.push(["hips", "Hips", at("Hips")], ["buttocks", "Hips", add(at("Hips"), [0, -0.08, -0.11])],
	["spine_1", "Spine", at("Spine")], ["spine_2", "Spine1", at("Spine1")], ["spine_3", "Spine2", at("Spine2")],
	["chest", "Spine2", add(at("Spine2"), [0, 0.05, 0.11])], ["head_top", "HeadTop_End", at("HeadTop_End")]);
const LANDMARKS = DEFS.map(([name, bone, p]) => ({ name, bone: I[bone], local: apply(T(sk.restWorldRot[I[bone]]), sub(p, P0[I[bone]])) }));

/** Every landmark of character `id` at frame f: { name: [x, y, z] }. */
export function landmarksAt(take, id, f) {
	const bones = take.characters[id].bones[f], out = {};
	for (const l of LANDMARKS) { const { R, p } = unmat4(bones[l.bone]); out[l.name] = add(p, apply(R, l.local)); }
	return out;
}

/** The matrix of object `id` at frame f (a still object stores one). */
export const objectMatrixAt = (take, id, f) => { const m = take.objects[id].matrix; return m[Math.min(f, m.length - 1)]; };

function checkTake(take) {
	if (take?.version !== 0 || take.fps !== 24) throw new Error("take.json: version 0 at 24 fps expected");
	if (take.rig?.bones?.length !== RIG.bones.length || take.rig.bones.some((b, i) => b !== RIG.bones[i])) throw new Error("take.json: bone list differs from the Y Bot rig");
	for (const [id, c] of Object.entries(take.characters)) if (c.bones.length !== take.frames || c.bones.some(fr => fr.length !== RIG.bones.length)) throw new Error(`take.json: ${id} needs ${take.frames} frames of ${RIG.bones.length} bones`);
	return take;
}

export const readTake = path => checkTake(JSON.parse(readFileSync(path, "utf8")));
export const writeTake = (path, take) => writeFileSync(path, JSON.stringify(checkTake(take)));
