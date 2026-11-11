#!/usr/bin/env node
// pose() on the WebAssembly module (src/motion3/compiler/pose-wasm.js, native/pose-rs) is the JS pose bit for bit: random
// channels and hooks (the self repair's FK arm angles among them) on both rigs give the same bone positions, rotations and diag as poseJs, and a compiled take is the
// same whichever path ran (a child process with CCLAY_POSE_WASM=0 compiles the JS reference).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pose, poseJs } from "../../src/motion3/compiler/pose.js";
import { poseWasmReady } from "../../src/motion3/compiler/pose-wasm.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";

const FIXTURES = ["bench-parkour-spec.json", "bench-sit-spec.json", "h-sit-spec.json"];

/** The take of a fixture's spec compiled once (no repair): its frames' bone positions and its QA, hashed. */
function takeHash(name) {
	const doc = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
	const r = compileSpec({ fps: 24, ...doc.spec }, { sk: skeletonFor(doc.model ?? "x-bot-tpose"), scene: motionScene(doc.objects ?? []) }, {});
	const hash = createHash("sha256");
	for (const fr of r.out.frames) for (const p of fr.s.P) hash.update(new Float64Array(p));
	return hash.update(JSON.stringify(r.qa)).digest("hex");
}

if (process.argv[2] === "--hash") {
	console.log(JSON.stringify({ wasm: poseWasmReady(), takes: Object.fromEntries(FIXTURES.map(name => [name, takeHash(name)])) }));
	process.exit(0);
}

assert.ok(poseWasmReady(), "the WebAssembly pose loads in Node");

let seed = 20261106;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const range = (lo, hi) => lo + (hi - lo) * rnd();
const vec = (c, r) => c.map(v => v + range(-r, r));
const maybe = (p, v) => (rnd() < p ? v() : undefined);
const PRESETS = ["relaxed", "fist", "grip", "cigarette", "point", "spherical", "flat", "hook"];

function channels(sk) {
	const foot = side => sk.restWorldPos[sk.index[`${side}Foot`]];
	const c = {
		arm_rest: maybe(0.7, () => range(30, 90)), arm_hang: maybe(0.5, () => range(0, 1)),
		yaw: range(-180, 180), pitch: maybe(0.3, () => range(-150, 150)), roll: maybe(0.3, () => range(-150, 150)),
		root: maybe(0.8, () => vec([0, 0.95, 0], 0.3)),
		head_yaw: range(-60, 60), head_pitch: range(-40, 40), head_roll: range(-30, 30),
		spine_yaw: range(-40, 40), spine_pitch: range(-30, 60), spine_roll: range(-20, 20),
		chest_yaw: maybe(0.3, () => range(-30, 30)), chest_pitch: maybe(0.3, () => range(-30, 30)),
	};
	for (const [k, side] of [["l", "Left"], ["r", "Right"]]) {
		Object.assign(c, {
			[`armw_${k}`]: maybe(0.7, () => (rnd() < 0.2 ? 1 : range(0, 1))), [`hangoff_${k}`]: maybe(0.3, () => range(0, 1)),
			[`abend_${k}`]: maybe(0.6, () => range(0, 175)), [`aswing_${k}`]: maybe(0.6, () => range(-70, 70)),
			[`foot_${k}`]: maybe(0.8, () => vec(foot(side), 0.35)), [`knee_${k}`]: maybe(0.5, () => vec([0, 0, 1], 0.8)),
			[`fyaw_${k}`]: maybe(0.5, () => range(-60, 60)), [`fpitch_${k}`]: maybe(0.6, () => range(-25, 45)),
			[`elbow_${k}`]: maybe(0.5, () => vec([0, -1, -0.3], 0.9)),
			[`wtwist_${k}`]: maybe(0.6, () => range(-110, 110)), [`wflex_${k}`]: maybe(0.6, () => range(-95, 95)),
			[`fingers_${k}`]: maybe(0.8, () => Object.fromEntries(PRESETS.filter(() => rnd() < 0.3).map(p => [p, range(0, 1.2)]))),
		});
	}
	return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
}

function hooks(sk) {
	if (rnd() < 0.25) return {};
	const reach = Object.fromEntries(["l", "r"].map(k => [k, vec([0, 0, 0], 0.7)]));
	const turns = Object.fromEntries(["l", "r"].map(k => [k, maybe(0.4, () => range(-60, 60))]));
	// the self repair's FK angles (fix/self-moves.js): the arm out from its arm_rest and the elbow bent, deg
	const fk = Object.fromEntries(["l", "r"].map(k => [k, maybe(0.5, () => ({ out: range(-10, 45), bend: range(-60, 60) }))]));
	return {
		armOrder: rnd() < 0.5 ? ["l", "r"] : undefined,
		handTarget: (k, s) => { const a = s.P[sk.index[`${k === "l" ? "Left" : "Right"}Arm`]]; return [a[0] + reach[k][0], a[1] + reach[k][1], a[2] + reach[k][2]]; },
		push: maybe(0.3, () => k => (k === "l" ? [0.01, -0.02, 0.03] : undefined)),
		softReach: rnd() < 0.5, foldFree: rnd() < 0.2,
		swivel: k => turns[k],
		fkArm: k => fk[k],
		fingerWeights: maybe(0.3, () => k => (k === "r" ? { fist: 0.7, grip: 0.6 } : undefined)),
		afterArm: (k, s, diag) => { diag[`hand_${k}`] = s.P[sk.index[`${k === "l" ? "Left" : "Right"}Hand`]].slice(); },
	};
}

const sameBits = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
for (const rig of ["x-bot-tpose", "y-bot-tpose"]) {
	const sk = skeletonFor(rig);
	for (let t = 0; t < 400; t++) {
		const c = channels(sk), state = seed, h = hooks(sk);
		const a = pose(sk, c, h);
		seed = state;
		const b = poseJs(sk, c, hooks(sk));
		sk.names.forEach((name, j) => {
			assert.ok(sameBits(a.s.P[j], b.s.P[j]), `${rig} case ${t}: ${name} position ${a.s.P[j]} vs ${b.s.P[j]}`);
			assert.ok(a.s.R[j].every((row, i) => sameBits(row, b.s.R[j][i])), `${rig} case ${t}: ${name} rotation`);
		});
		assert.deepEqual(a.diag, b.diag, `${rig} case ${t}: diag`);
	}
	console.log(`PASS ${rig}: 400 random poses (channels, hand targets, soft reach, swivels, FK arm angles, finger presets) are bit for bit the JS pose`);
}

const takes = Object.fromEntries(FIXTURES.map(name => [name, takeHash(name)]));
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--hash"], { env: { ...process.env, CCLAY_POSE_WASM: "0" }, encoding: "utf8" });
assert.equal(child.status, 0, child.stderr);
const js = JSON.parse(child.stdout);
assert.equal(js.wasm, false, "CCLAY_POSE_WASM=0 keeps the child on the JS pose");
assert.deepEqual(takes, js.takes, "a compiled take is the same on the WebAssembly and the JS pose");
console.log(`PASS ${FIXTURES.length} bench specs compile to the same take (frames and QA) on the WebAssembly and the JS pose`);
