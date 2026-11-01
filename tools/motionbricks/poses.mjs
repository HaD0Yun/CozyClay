#!/usr/bin/env node
// Experiment: the MotionBricks Smart Primitive target poses (jump 0.5 m, vault 0.75 m, sit, duck under) as CozyClay pose-library
// entries for the Y Bot. Reads the SOMA Smart Primitive documents and their BVH clips from NVlabs/motionbricks at a pinned commit
// (cached under ~/.cache/cozyclay/motionbricks/soma-clips), samples each target's first pose, retargets it through the motion3
// channels and compiler, and writes { id, label, prompt, bones, rootY } entries.
// The sample clips are under the NVIDIA Sample Data Evaluation License (evaluation and testing only): the output is a local file,
// never committed or shipped. usage: node tools/motionbricks/poses.mjs [out.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { somaFK, toCozyPoint } from "../../src/motion3/bricks/soma.js";
import { frameChannels, roundChannels } from "../../src/motion3/bricks/forward.js";
import { mul, T, quatFromMat, ry, apply } from "../../src/motion3/compiler/math.js";
import { RAW, MEDIA, resolve, cached, parseBvh, bvhPose } from "./bvh.mjs";

const DOCS = { jump_0_5m: "Jump 0.5 m", jump_0_75m: "Vault 0.75 m", sit: "Sit", avoidance: "Duck under" };
const out = process.argv[2] ?? join(homedir(), ".cache", "cozyclay", "motionbricks", "mb-poses.json");

const qToEuler = ([x, y, z, w]) => {
	const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
	const yy = Math.asin(Math.max(-1, Math.min(1, m13)));
	return Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), yy, Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), yy, 0];
};
const POSE_BONES = { hips: "Hips", spine: "Spine", chest: "Spine1", upperChest: "Spine2", neck: "Neck", head: "Head", lShoulder: "LeftShoulder", rShoulder: "RightShoulder",
	lArm: "LeftArm", rArm: "RightArm", lForeArm: "LeftForeArm", rForeArm: "RightForeArm", lHand: "LeftHand", rHand: "RightHand", lUpLeg: "LeftUpLeg", rUpLeg: "RightUpLeg",
	lLeg: "LeftLeg", rLeg: "RightLeg", lFoot: "LeftFoot", rFoot: "RightFoot" };
const r4 = v => Math.round(v * 1e4) / 1e4;

const sk = skeletonFor("y-bot-tpose"), scene = motionScene([]);
const entries = [];
for (const [doc, label] of Object.entries(DOCS)) {
	const docPath = `assets/smart_primitives/soma/${doc}.smart_primitive.json`;
	const d = JSON.parse(await cached(RAW + docPath, `${doc}.smart_primitive.json`));
	const nodes = new Map();
	const walk = n => { for (const c of n.components ?? []) if (c.type === "target_pose") nodes.set(n.id, { name: n.name, c }); (n.children ?? []).forEach(walk); };
	walk(d.root);
	for (const seq of d.sequences) {
		for (const [step, id] of seq.node_ids.entries()) {
			const { name, c } = nodes.get(id);
			const clipPath = resolve(docPath, c.clip), clipName = clipPath.split("/").pop();
			const bvh = parseBvh(await cached(MEDIA + clipPath, clipName));
			const t = c.playback_mode === "frames" ? c.frame_index * bvh.dt : c.sample_time_seconds;
			const soma = bvhPose(bvh, t);
			// face +Z with the hips over the origin, then the motion3 channels of that SOMA pose, compiled on the Y Bot
			let P = somaFK(soma.root, soma.R).map(toCozyPoint);
			const yaw = frameChannels(P).yaw, hip = P[0], Ry = ry(-yaw);
			P = P.map(p => { const v = apply(Ry, [p[0] - hip[0], p[1], p[2] - hip[2]]); return v; });
			const set = roundChannels(frameChannels(P));
			const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 2, flow: false, fix: false, keys: [{ f: 0, set: { ...set, armw_l: 1, armw_r: 1 } }] }, { sk, scene });
			const s = r.out.frames[0].s;
			const bones = {};
			for (const [pid, bone] of Object.entries(POSE_BONES)) {
				const j = sk.index[bone], parent = sk.parent[j];
				const local = parent < 0 ? s.R[j] : mul(T(s.R[parent]), s.R[j]);
				bones[pid] = qToEuler(quatFromMat(mul(local, T(sk.restLocalRot[j])))).map(r4);
			}
			const rootY = r4((s.P[sk.index.Hips][1] - sk.restWorldPos[sk.index.Hips][1]) * 100);
			const tag = `${label} · ${seq.name} ${step + 1}/${seq.node_ids.length} · ${name}`;
			entries.push({ id: `mb-${doc}-${seq.name}-${name}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), label: tag, prompt: `MotionBricks ${doc} target pose ${name} (${clipName} @ ${t.toFixed(2)} s), evaluation sample`, bones, rootY });
			console.log(tag, "rootY", rootY, "yaw", yaw.toFixed(1));
		}
	}
}
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(entries, null, 1));
console.log(entries.length, "poses ->", out);
