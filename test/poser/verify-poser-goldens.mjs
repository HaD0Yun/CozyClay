// Regression and property tests of the poser on CozyClay's Y Bot, against the goldens written by
// make-poser-goldens.mjs for the cases in poser-cases.mjs. A recorded network stands in for the model, so everything
// but the last block runs without the model file; with the file present, the real network runs the same cases too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import yBotRig from "../../src/motion3/rigs/y-bot-tpose.json" with { type: "json" };
import { HANDLES } from "../../src/poser/handles.js";
import { createPoser } from "../../src/poser/poser.js";
import { characterFromRigJson, mixamoJointToBone } from "../../src/poser/ybot.js";
import { GOLDENS_PATH, MODEL_PATH, recordedOutput, replayNetwork, rigFacts, wasmNetwork } from "./golden-format.mjs";
import { CASES } from "./poser-cases.mjs";

const GOLDENS = JSON.parse(readFileSync(GOLDENS_PATH, "utf8"));
const character = characterFromRigJson();
const jointOf = new Map(HANDLES.map((h) => [h.id, h.joint]));
const solved = CASES.flatMap((c, i) => (GOLDENS.cases[i].ok ? [[c, GOLDENS.cases[i]]] : []));
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const replaySolve = (c, record, sends = c.sends) => createPoser({ network: replayNetwork(record) }).solve(sends, character, c.options);
const at = (P, j) => [P[3 * j], P[3 * j + 1], P[3 * j + 2]];

function sameAsGolden(result, record, eps) {
	assert.ok(result.ok, `${record.name}: ${result.reason}`);
	assert.deepEqual(result.warnings, record.warnings, `${record.name}: warnings`);
	result.joints.forEach((v, k) => close(v, record.joints[k], eps, `${record.name}: joint ${Math.floor(k / 3)} axis ${k % 3}`));
	assert.deepEqual(result.bones.map((b) => b.name), record.bones.map((b) => b[0]), `${record.name}: written bones`);
	result.bones.forEach((b, i) => [...b.quaternion, ...b.position.map((v) => v / 100)].forEach((v, k) => close(v, k < 4 ? record.bones[i][1 + k] : record.bones[i][1 + k] / 100, eps, `${record.name}: ${b.name} ${k}`)));
}

test("the cases and the goldens line up, and cover every handle and kind", () => {
	assert.deepEqual(GOLDENS.cases.map((g) => g.name), CASES.map((c) => c.name));
	const sent = new Set(CASES.flatMap((c) => c.sends.flatMap((s) => ["position", "rotation", "lookAt"].filter((k) => s[k]).map((k) => `${s.id}:${k}`))));
	for (const h of HANDLES) for (const kind of h.sends) assert.ok(sent.has(`${h.id}:${kind}`), `no case sends ${kind} on ${h.id}`);
	assert.ok(GOLDENS.cases.filter((g) => !g.ok).length >= 3, "reject cases");
	assert.ok(CASES.filter((c) => c.options?.floor === false || c.sends.some((s) => s.position?.[1] < 0)).length >= 2, "floor cases");
});

test("Y Bot rig facts from the repo's rig JSON", () => {
	const rig = createPoser({ network: replayNetwork(solved[0][1]) }).prepare(character), facts = rigFacts(rig), want = GOLDENS.rig;
	assert.deepEqual(facts.written, want.written);
	for (const key of ["measuredLengths", "networkLengths", "restCorrection", "effectiveRest"]) facts[key].forEach((v, k) => close(v, want[key][k], 1e-7, `${key} ${k}`));
	facts.toeTipOffsets.flat().forEach((v, k) => close(v, want.toeTipOffsets.flat()[k], 1e-7, `toe tip ${k}`));
	// independent of the poser: limb lengths straight from the rig file's joint positions (cm -> m)
	const map = mixamoJointToBone(yBotRig.bones.map((b) => b.name)), pos = new Map(yBotRig.bones.map((b) => [b.name, b.worldPos]));
	const sk = createPoser({ network: replayNetwork(solved[0][1]) }).skeleton;
	assert.equal(Object.values(map).filter(Boolean).length, 22, "mapped Mixamo bones");
	for (const name of ["farm_l", "hand_l", "farm_r", "hand_r", "shin_l", "foot_l", "shin_r", "foot_r"]) {
		const j = sk.index[name], a = pos.get(map[name]), b = pos.get(map[sk.names[sk.parents[j]]]);
		close(rig.measured[j - 1], Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 100, 1e-6, `${name} length`);
	}
	rig.network.forEach((v, k) => sk.boneLengthStd[k] < sk.lengthStdFloor || assert.ok(Math.abs(v - sk.boneLengthMean[k]) <= 2.5 * sk.boneLengthStd[k] + 1e-12, `network length ${k} inside the trained range`));
});

test("replaying the recorded network reproduces every golden", async () => {
	for (const [c, record] of solved) sameAsGolden(await replaySolve(c, record), record, 1e-6);
});

test("queries without a position handle are rejected before the network runs", async () => {
	for (const [i, record] of GOLDENS.cases.entries()) {
		if (record.ok) continue;
		const network = { calls: 0, run: async () => { network.calls += 1; throw new Error("unreachable"); } };
		const result = await createPoser({ network }).solve(CASES[i].sends, character);
		assert.deepEqual([result.ok, result.reason, network.calls], [false, record.reason, 0], record.name);
		assert.equal(CASES[i].sends.some((s) => s.position), false, `${record.name} has no position handle`);
	}
});

test("position handles are met within their tolerance; look-at points the head at its target", async () => {
	for (const [c, record] of solved) {
		if (c.met === false) continue;
		const result = await replaySolve(c, record);
		for (const s of c.sends) {
			const j = jointOf.get(s.id), p = at(result.joints, j);
			if (s.position) assert.ok(Math.hypot(p[0] - s.position[0], p[1] - s.position[1], p[2] - s.position[2]) <= (s.tol ?? 0.005) + 0.005, `${c.name}: ${s.id} place`);
			if (s.lookAt) {
				const G = result.G, d = s.lookAt.map((v, a) => v - p[a]), n = Math.hypot(...d);
				assert.ok((G[9 * j + 2] * d[0] + G[9 * j + 5] * d[1] + G[9 * j + 8] * d[2]) / n > Math.cos((1 * Math.PI) / 180), `${c.name}: head aims at the look target`);
			}
		}
	}
});

test("no joint ends below the floor while the floor is on", async () => {
	for (const [c, record] of solved) {
		if (c.options?.floor === false) continue;
		const result = await replaySolve(c, record);
		result.joints.forEach((v, k) => { if (k % 3 === 1) assert.ok(v >= -1e-6, `${c.name}: joint ${(k - 1) / 3} at y = ${v}`); });
	}
	const off = solved.find(([c]) => c.options?.floor === false);
	assert.ok(Math.min(...off[1].joints.filter((_, k) => k % 3 === 1)) < 0, "with the floor off the foot follows its handle below y = 0");
});

test("handle order does not change the result", async () => {
	for (const [c, record] of solved) {
		if (c.sends.length < 2) continue;
		const reversed = await replaySolve(c, record, [...c.sends].reverse()), rotated = await replaySolve(c, record, [...c.sends.slice(1), c.sends[0]]);
		for (const result of [reversed, rotated]) result.joints.forEach((v, k) => close(v, record.joints[k], 1e-6, `${c.name}: joint ${Math.floor(k / 3)}`));
	}
});

// The real network runs on the app's own backend (onnxruntime-web, WASM) when the model file is present locally.
if (!existsSync(MODEL_PATH)) console.log(`SKIP real-network checks: no model at ${MODEL_PATH}`);
else {
	const network = await wasmNetwork();
	test("the real network reproduces the goldens end to end, in any handle order", async () => {
		const poser = createPoser({ network });
		for (const [c, record] of solved) {
			sameAsGolden(await poser.solve(c.sends, character, c.options), record, 1e-4);
			const reversed = await poser.solve([...c.sends].reverse(), character, c.options);
			reversed.joints.forEach((v, k) => close(v, record.joints[k], 1e-4, `${c.name} reversed: joint ${Math.floor(k / 3)}`));
		}
	});
	test("the network gives the recorded output on every case, single-threaded", async () => {
		assert.equal(network.info.threads, 1);
		for (const [c, record] of solved) {
			let out = null;
			await createPoser({ network: { run: async (inputs) => (out = await network.run(inputs)) } }).solve(c.sends, character, c.options);
			const want = recordedOutput(record);
			out.draft.forEach((v, k) => close(v, want.draft[k], 1e-4, `${c.name}: draft ${k}`));
			out.rot6d.forEach((v, k) => close(v, want.rot6d[k], 1e-4, `${c.name}: rot6d ${k}`));
		}
	});
	test("with the real network, a hand reach is met at character scales 0.5, 0.8, 1 and 2", async () => {
		const poser = createPoser({ network }), d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		for (const scale of [0.5, 0.8, 1, 2]) {
			const scaled = characterFromRigJson(undefined, { scale }), m = 0.01 * scale;
			const rest = (name) => scaled.bones.find((b) => b.name === name).head.map((v) => v * m);
			const lf = rest("LeftFoot"), rf = rest("RightFoot"), lh = rest("LeftHand"), target = [lh[0] - 0.3 * scale, lh[1] - 0.25 * scale, lh[2] + 0.3 * scale];
			const pose = await poser.solve([{ id: "hips", position: rest("Hips"), tol: 0.06 }, { id: "leftFoot", position: lf }, { id: "rightFoot", position: rf }, { id: "leftHand", position: target }], scaled);
			const at = (name) => { const b = pose.bones.find((x) => x.name === name); return [b.pose[3] * m, b.pose[7] * m, b.pose[11] * m]; };
			assert.ok(d(at("LeftHand"), target) < 0.01 * scale, `scale ${scale}: hand ${d(at("LeftHand"), target)} m from its handle`);
			for (const [name, p] of [["LeftFoot", lf], ["RightFoot", rf]]) assert.ok(d(at(name), p) < 0.01 * scale, `scale ${scale}: ${name} ${d(at(name), p)} m from its place`);
		}
	});
}
