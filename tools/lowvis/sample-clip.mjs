#!/usr/bin/env node
// Writes public/lowvis/clips/sample/<demo>.json for every demo: the figure slides along a line and swings its limbs
// with plain forward kinematics. It is NOT a motion engine. It exists so the looks, the viewer and the recorder have
// valid clips to draw before an engine has written any, and it shows how to use rig17.js and clip.js.
import { mkdirSync, writeFileSync } from "node:fs";
import { DEMOS } from "../../src/lowvis/demos.js";
import { INDEX, JOINT_COUNT, REST, fk, qAxisAngle, qIdentity, qMul } from "../../src/lowvis/rig17.js";
import { addCharacter, addProp, createClip, serializeClip, setPose, validateClip } from "../../src/lowvis/clip.js";

const X = [1, 0, 0], Y = [0, 1, 0];
const outDir = new URL("../../public/lowvis/clips/sample/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const [demo, def] of Object.entries(DEMOS)) {
	const t0 = performance.now();
	const clip = createClip({ demo, engine: "sample", frameCount: def.frames });
	def.characters.forEach((spec, n) => {
		const c = addCharacter(clip, spec.id), yaw = spec.heading * Math.PI / 180;
		for (let f = 0; f < def.frames; f++) {
			const s = Math.sin(f / 24 * Math.PI * 2 + n), travel = 1.5 * (1 - Math.cos(f / def.frames * Math.PI * 2)) / 2;
			const local = Array.from({ length: JOINT_COUNT }, qIdentity);
			local[INDEX.Hips] = qAxisAngle(Y, yaw);
			// arms down from the T pose (about Z), then swing about X; legs swing about X
			local[INDEX.LeftArm] = qMul(qAxisAngle(X, -0.5 * s), qAxisAngle([0, 0, 1], -1.35));
			local[INDEX.RightArm] = qMul(qAxisAngle(X, 0.5 * s), qAxisAngle([0, 0, 1], 1.35));
			local[INDEX.LeftUpLeg] = qAxisAngle(X, 0.5 * s);
			local[INDEX.RightUpLeg] = qAxisAngle(X, -0.5 * s);
			local[INDEX.LeftLeg] = qAxisAngle(X, 0.4 * Math.max(0, -s));
			local[INDEX.RightLeg] = qAxisAngle(X, 0.4 * Math.max(0, s));
			const hips = [spec.at[0] + Math.sin(yaw) * travel, REST[INDEX.Hips][1], spec.at[1] + Math.cos(yaw) * travel];
			setPose(c, f, fk(hips, local));
		}
	});
	for (const p of def.props) addProp(clip, p.id, p.size).pos.set(p.at);
	clip.stats.buildMs = Math.round((performance.now() - t0) * 100) / 100;
	clip.notes.push("sample clip: forward kinematics only, no engine, feet slide");
	const text = serializeClip(clip), check = validateClip(JSON.parse(text));
	if (!check.ok) { console.error(demo, check.errors); process.exit(1); }
	writeFileSync(new URL(`${demo}.json`, outDir), text);
	console.log(`${demo}: ${def.frames} frames, ${(text.length / 1024).toFixed(0)} KB, stretch ${check.stretch.toExponential(1)} m`);
}
