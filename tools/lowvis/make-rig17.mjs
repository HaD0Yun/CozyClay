#!/usr/bin/env node
// Builds src/lowvis/rig17.json: the 17 joints of the low-vis figure, taken from the X Bot bind skeleton
// (src/motion3/rigs/x-bot-tpose.json) and re-parented onto each other. Same shape as x-bot-tpose.json
// (bones with parent/localPos/localQuat/worldPos/worldQuat, centimetres) so registerRig can take it, plus
// `tips`: the rest world position (cm) of the end of the head, hands and feet.
import { readFileSync, writeFileSync } from "node:fs";

const src = JSON.parse(readFileSync(new URL("../../src/motion3/rigs/x-bot-tpose.json", import.meta.url), "utf8"));
const KEEP = [
	"Hips", "Spine", "Spine2", "Neck", "Head",
	"LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
	"LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot",
];
const TIPS = { Head: "HeadTop_End", LeftHand: "LeftHandMiddle4", RightHand: "RightHandMiddle4", LeftFoot: "LeftToe_End", RightFoot: "RightToe_End" };

const conj = q => [-q[0], -q[1], -q[2], q[3]];
const qmul = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
	a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
	a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q, v) => { const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), conj(q)); return [r[0], r[1], r[2]]; };

const byName = Object.fromEntries(src.bones.map((b, i) => [b.name, i]));
const keptAncestor = i => { for (let p = src.bones[i].parent; p >= 0; p = src.bones[p].parent) if (KEEP.includes(src.bones[p].name)) return KEEP.indexOf(src.bones[p].name); return -1; };
const bones = KEEP.map(name => {
	const b = src.bones[byName[name]], parent = keptAncestor(byName[name]);
	if (parent < 0) return { name, parent, localPos: b.worldPos, localQuat: b.worldQuat, worldPos: b.worldPos, worldQuat: b.worldQuat };
	const p = src.bones[byName[KEEP[parent]]], inv = conj(p.worldQuat);
	return {
		name, parent,
		localPos: qrot(inv, b.worldPos.map((v, k) => v - p.worldPos[k])),
		localQuat: qmul(inv, b.worldQuat),
		worldPos: b.worldPos, worldQuat: b.worldQuat,
	};
});
const tips = Object.fromEntries(Object.entries(TIPS).map(([joint, end]) => [joint, src.bones[byName[end]].worldPos]));
const out = { model: "lowvis-17", units: "cm", source: "x-bot-tpose", bones, tips, landmarks: src.landmarks };
writeFileSync(new URL("../../src/lowvis/rig17.json", import.meta.url), JSON.stringify(out, null, "\t") + "\n");
console.log(`rig17.json: ${bones.length} joints`, bones.map(b => `${b.name}<-${b.parent < 0 ? "root" : KEEP[b.parent]}`).join(" "));
