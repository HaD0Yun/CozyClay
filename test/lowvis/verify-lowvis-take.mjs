#!/usr/bin/env node
// src/lowvis/studio/take.js: a lowvis clip character as a raw track of the Studio's X Bot skeleton. The track,
// encoded and decoded as the editor does, placed for a character standing somewhere else and played by forward
// kinematics, puts each of the 17 joints where the clip has them, on every frame.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRACK_RIG, clipTrack } from "../../src/lowvis/studio/take.js";
import { encodeRawTrack, decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { placedTake } from "../../src/motion-v4/track/literal.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fk } from "../../src/motion3/compiler/skeleton.js";
import { JOINTS, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const clip = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/simple/sit.json", import.meta.url), "utf8"));
const sk = skeletonFor(TRACK_RIG);
assert.equal(JOINT_COUNT, 17);
assert.ok(clip.characters.length >= 1 && clip.frameCount > 100, "the clip has a character and frames");

for (const [ci, c] of clip.characters.entries()) {
	const raw = decodeRawTrack(encodeRawTrack(clipTrack(clip, ci)), sk);
	assert.equal(raw.frameCount, clip.frameCount, "one track frame per clip frame");
	// placement: yaw in degrees about Y, then the position (the take is in the character's frame)
	const yawDeg = 40, yaw = yawDeg * Math.PI / 180, at = [1.5, 0, -2], cs = Math.cos(yaw), sn = Math.sin(yaw);
	const take = placedTake(raw, { position: at, yaw: yawDeg }), B = take.bones.length;
	let worst = 0, where = null;
	for (let f = 0; f < take.frameCount; f++) {
		const quats = take.bones.map((_, b) => Array.from(take.rot.slice((f * B + b) * 4, (f * B + b) * 4 + 4)));
		const pose = fk(sk, quats, Array.from(take.hips.slice(f * 3, f * 3 + 3)));
		JOINTS.forEach((joint, j) => {
			const p = pose.P[sk.index[joint]], w = [cs * p[0] + sn * p[2] + at[0], p[1] + at[1], -sn * p[0] + cs * p[2] + at[2]];
			const q = c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3);
			const d = Math.hypot(w[0] - q[0], w[1] - q[1], w[2] - q[2]);
			if (d > worst) { worst = d; where = `${joint} @f${f}`; }
		});
	}
	assert.ok(worst < 0.00005, `character ${c.id}: every joint within 0.05 mm of the clip on every frame (worst ${(worst * 1000).toFixed(4)} mm at ${where})`);
	console.log(`ok character ${c.id}: ${take.frameCount} frames, worst joint offset ${(worst * 1000).toFixed(4)} mm`);
}
console.log("PASS verify-lowvis-take");
