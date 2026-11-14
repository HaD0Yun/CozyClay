#!/usr/bin/env node
// Pocket departure on the posed body: a clear wrist must not leave the hand inside the thigh.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bodyFor, limbDepth } from "../../src/motion3/body.js";
import { motionScene } from "../../src/motion3/scene.js";
import { buildKit } from "../../src/kits/index.js";

const cig = buildKit("cigarette", [], { position: { x: 0.6, z: 0.6 } });
const lighter = buildKit("lighter", cig.records, { position: { x: 0.75, z: 0.6 } });
const scene = motionScene([...cig.records, ...lighter.records]);
const starts = [
	["follow", 0, {
		root: [0, 0.5, -0.08], foot_l: [0.17, 0.087, 0.12], foot_r: [-0.17, 0.087, 0.12],
		knee_l: [0.5, 0.2, 1], knee_r: [-0.5, 0.2, 1], fyaw_l: 15, fyaw_r: -15, fpitch_l: 10, fpitch_r: 10,
		pitch: 28, spine_pitch: 5, head_pitch: -18, yaw: 0,
	}],
	["kits", 1, {
		root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12,
		foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15,
		knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1],
	}],
];
let failures = 0;
for (const rig of ["y-bot-tpose", "x-bot-tpose"]) for (const [label, f0, start] of starts) for (const turned of [false, true]) {
	const sk = skeletonFor(rig), body = bodyFor(sk);
	const set = structuredClone(start);
	if (turned) {
		for (const key of ["root", "foot_l", "foot_r"]) {
			const [x, y, z] = set[key];
			set[key] = [z + 1.3, y, -x - 0.7];
		}
		set.yaw += 90; set.fyaw_l += 90; set.fyaw_r += 90;
	}
	const spec = {
		schema: "cozyclay.motion-spec.v1", fps: 24, frames: 265 + f0,
		keys: [{ f: 0, set }], fix: { retime: true },
		use: [{ skill: "smokeCigarette", f0, args: { kit: { cig: cig.rootId, lighter: lighter.rootId } } }],
	};
	const result = compileSpec(spec, { sk, scene });
	const expanded = { ...result.expanded, ...(result.fixed.retime?.kept === false ? { fix: { ...result.expanded.fix, retime: false } } : {}) };
	const before = compileMotion(expanded, { sk, scene }, { selfRepair: false });
	const depths = result.out.frames.slice(f0 + 12, f0 + 61).map(({ s }) => limbDepth(body, sk, s, sk.index.LeftHand));
	const worst = Math.max(...depths.filter(h => h.into === sk.index.LeftUpLeg).map(h => h.depth), 0);
	const moved = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
	try {
		assert.ok(worst <= 0.04, `${rig} ${label}: pocket departure hand/thigh depth ${worst} exceeds 0.04 m`);
		for (const f of [f0 + 35, f0 + 44, f0 + 60]) {
			assert.ok(moved(result.out.frames[f].s.P[sk.index.LeftHand], before.frames[f].s.P[sk.index.LeftHand]) < 1e-6,
				`${rig} ${label}: repair moved a held pocket or lighting endpoint at f${f}`);
		}
		if (rig === "y-bot-tpose" && label === "kits" && !turned) {
			const f = f0 + 46, point = before.frames[f].s.P[sk.index.LeftHand];
			const held = compileSpec({ ...spec, anchors: { mark: { kind: "world", p: point } },
				checks: { contacts: [{ name: "hand held during travel", point: "joint:LeftHand", target: "anchor:mark", tol: 0.001, when: [f, f] }] } }, { sk, scene });
			assert.ok(moved(held.out.frames[f].s.P[sk.index.LeftHand], point) < 1e-6, "an explicit contact pins the travelling hand");
			assert.ok(!held.qa.groups.some(g => g.kind === "CONTACT"), "the declared travel contact still holds");
		}
		console.log(`PASS ${rig} ${label}${turned ? " turned and translated" : ""}: pocket departure ${worst.toFixed(4)} m, held contacts unchanged`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${error.message}`);
	}
}
assert.equal(failures, 0, `${failures} pocket departure checks failed`);
console.log("motion3 pocket: all checks passed");
