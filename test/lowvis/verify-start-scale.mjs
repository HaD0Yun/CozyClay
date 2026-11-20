#!/usr/bin/env node
// The scale a new character starts at (the compile tool's bodies["*"], src/lowvis/studio/figure.js through
// bin/agent/motion-run.mjs) in what the motion writer reads before its first spec.
//  1. start 1, not given or not a number: the manual of every variant and every set of switched-off names is the one of
//     before, byte for byte
//  2. another start: only a variant with the body step says more, in two places: the sizes at that scale after the
//     sizes at scale 1 (CONVENTIONS), and the start in place of "1 unless the tool's bodies line says otherwise"
//  3. the numbers of that sentence: each is the start times the number at scale 1 (to the rounding), and the engine's
//     own bodies at the two scales are that many times apart (this test's arithmetic on the compiled clips)
//  4. the compile tool builds a character the scene gives no scale at the start, one the scene gives a scale at that
//     scale, a known one at its own; runScene hands the start to the manual
//  5. runMotion: at a start other than 1 each listed character states its scale in the request, 1 too; at 1 the request
//     is the one of before
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFF, VARIANTS, features, systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { runScene } from "../../src/lowvis/pi/harness.mjs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { INDEX as J } from "../../src/lowvis/rig17.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";

const STARTS = [0.2, 0.5, 0.81, 0.9, 1.25, 2, 3];
const subsets = list => list.reduce((all, x) => [...all, ...all.map(s => [...s, x])], [[]]);
const SAID = / It stands ([\d.]+) m tall, Hips joint ([\d.]+) m and shoulders ([\d.]+) m over the floor, ([\d.]+) m from shoulder to wrist\.(.*)$/m;
const START = / That is the figure at scale 1\. A new character starts at scale ([\d.]+) here, every length of its figure ([\d.]+) times that: Hips joint ([\d.]+) m and shoulders ([\d.]+) m over the floor, ([\d.]+) m from shoulder to wrist\./;
const tmp = mkdtempSync(join(tmpdir(), "start-scale-"));

// --- 1 and 2: the manual, every variant and every set of switched-off names ---
{
	let same = 0, more = 0;
	for (const variant of VARIANTS) for (const off of subsets(OFF)) {
		const plain = systemPrompt(variant, off);
		for (const start of [1, undefined, Number.NaN, "0.81", null]) assert.equal(systemPrompt(variant, off, start), plain, `${variant} -${off.join(",")} start ${start}: the manual of before`);
		for (const s of STARTS) {
			const text = systemPrompt(variant, off, s);
			if (!features(variant, off).body) { assert.equal(text, plain, `${variant} -${off.join(",")}: no body step, no word of the start`); same++; continue; }
			const said = START.exec(text);
			assert.ok(said, `${variant} -${off.join(",")} start ${s}: the sizes at the start`);
			assert.equal(SAID.exec(text)[5], said[0], "right after the sizes at scale 1, on the same line");
			assert.deepEqual([Number(said[1]), Number(said[2])], [s, s], "the start, twice");
			const back = text.replace(said[0], "").replace(`(${s}, as CONVENTIONS says)`, "(1 unless the tool's bodies line says otherwise)");
			assert.equal(back, plain, `${variant} -${off.join(",")} start ${s}: nothing else differs`);
			more++;
		}
	}
	console.log(`ok manual: start 1 or none is the manual of before for ${VARIANTS.length} variants x ${subsets(OFF).length} sets of names; at ${STARTS.length} other starts ${more} manuals say it in two places, ${same} without the body step say nothing`);
}

// --- 3: the numbers, against the rounding and against the engine's own bodies ---
{
	const one = SAID.exec(systemPrompt("studio")).slice(1, 5).map(Number); // tall, hips, shoulders, arm at scale 1
	const idle = s => buildClip({ demo: "x", a: [[0, "idle"]] }, { frames: 4, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }], props: [] }).clip.characters[0];
	const at = (c, j) => [0, 1, 2].map(k => c.pos[j * 3 + k]), dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const sizes = c => [at(c, J.Hips)[1], at(c, J.LeftArm)[1], dist(at(c, J.LeftArm), at(c, J.LeftForeArm)) + dist(at(c, J.LeftForeArm), at(c, J.LeftHand)), at(c, J.Head)[1], dist(at(c, J.LeftUpLeg), at(c, J.LeftLeg)) + dist(at(c, J.LeftLeg), at(c, J.LeftFoot))];
	const unit = sizes(idle(1));
	assert.equal(unit[2].toFixed(2), one[3].toFixed(2), `the engine's arm at scale 1 is the manual's (${unit[2].toFixed(4)} m)`);
	for (const s of STARTS) {
		const said = START.exec(systemPrompt("studio", [], s)).slice(3, 6).map(Number); // hips, shoulders, arm at s
		[one[1], one[2], one[3]].forEach((v, k) => assert.ok(Math.abs(said[k] - v * s) <= 0.005 + 0.005 * s + 1e-9, `start ${s}: ${said[k]} is ${s} x ${v} to the rounding`));
		const got = sizes(idle(s));
		got.forEach((v, k) => assert.ok(Math.abs(v - unit[k] * s) < 1e-6, `start ${s}: the engine's length ${k} is ${s} times the one at scale 1 (${v.toFixed(4)} = ${s} x ${unit[k].toFixed(4)})`));
		assert.ok(Math.abs(said[2] - got[2]) <= 0.005 + 1e-9 + Math.abs(one[3] - unit[2]) * s, `start ${s}: the arm said (${said[2]}) is the engine's (${got[2].toFixed(4)})`);
	}
	console.log(`ok numbers: at ${STARTS.length} starts each size said is the start times the size at scale 1, and the engine's hips, shoulders, arm, head and leg are that many times the ones at scale 1`);
}

// --- 4: the compile tool and runScene ---
{
	const scene = { frames: 24, characters: [{ id: "n", at: [0, 0], heading: 0 }, { id: "w", at: [1, 0], heading: 0, scale: 1.1 }, { id: "k", at: [2, 0], heading: 0 }], props: [] };
	const spec = { n: [[0, "idle"]], w: [[0, "idle"]], k: [[0, "idle"]] };
	for (const s of STARTS) {
		const tool = createCompileTool({ name: `start-${s}`, outDir: join(tmp, `sheets-${s}`), clipFile: join(tmp, `clip-${s}.json`), variant: "studio", bodies: { "*": { scale: s }, k: { scale: 0.7 } } });
		const r = tool.call({ scene, spec });
		assert.equal(r.status, "ok");
		assert.deepEqual(tool.state.last.scene.characters.map(c => c.scale ?? 1), [s, 1.1, 0.7], `start ${s}: a new one at the start, a written scale as written, a known one at its own`);
		const tall = Number(new RegExp(`n: scale ${s} = ([\\d.]+) m tall`).exec(r.text)?.[1]), one = Number(SAID.exec(systemPrompt("studio"))[1]);
		assert.ok(Math.abs(tall - one * s) <= 0.005 + 0.005 * s + 1e-9, `start ${s}: the bodies line says the start too (${tall} m)`);
	}
	for (const [bodies, start] of [[{ "*": { scale: 0.81 } }, 0.81], [{ "*": { scale: 2 }, a: { scale: 0.5 } }, 2], [{ a: { scale: 0.5 } }, 1], [{}, 1]]) {
		const record = await runScene({ name: "start-scale", request: "x", variant: "studio", bodies, env: {}, outDir: join(tmp, "run") });
		assert.equal(record.infraError?.at, "setup", "no proxy in this test: the run stops before a model call");
		assert.equal(record.prompt.systemChars, systemPrompt("studio", [], start).length, `bodies ${JSON.stringify(bodies)}: the manual of start ${start}`);
	}
	console.log("ok compile tool and runScene: a new character is built at the start the manual states; runScene states the start of bodies[\"*\"]");
}

// --- 5: runMotion's request ---
{
	const DESCRIBE = { characters: [{ id: "c1", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale: 0.8, tint: "#aa3311" }, { id: "c2", model: TRACK_RIG, x: 1, z: 0, rot: 90, scale: 1, tint: null }], objects: [] };
	const CLIP = JSON.parse(JSON.stringify(buildClip({ demo: "x", c1: [[0, "idle"]], c2: [[0, "idle"]] }, { frames: 4, characters: [{ id: "c1", at: [0, 0], heading: 0, scale: 0.8, tint: "#aa3311" }, { id: "c2", at: [1, 0], heading: 90 }], props: [] }).clip));
	const go = async env => {
		const runs = [], deps = { studioScene, installClip, readClip: () => CLIP, runScene: async options => { runs.push(options); return { wallMs: 1000, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "clip.json", scene: { characters: [], props: [] }, spec: {} } }; } };
		await runMotion({ words: "they wave", memoryKey: null, hub: { command: async () => DESCRIBE }, workspaceHandle: "ws", invoke: async () => ({ affectedIds: [] }), env, deps });
		return runs[0];
	};
	const sceneOf = request => JSON.parse(request.split("\n").find(line => line.startsWith("{\"characters\"")));
	const plain = await go({}), cube = await go({ COZYCLAY_FIGURE: "cube" }), off = await go({ COZYCLAY_FIGURE: "cube", COZYCLAY_MOTION_OFF: "body" });
	assert.deepEqual(sceneOf(plain.request).characters, [{ id: "c1", at: [0, 0], heading: 0, scale: 0.8, tint: "#aa3311" }, { id: "c2", at: [1, 0], heading: 90 }], "start 1: a character at scale 1 has no scale field, as before");
	assert.equal(plain.bodies["*"], undefined);
	const start = cube.bodies["*"].scale;
	assert.ok(start !== 1, "the cube look starts new figures at another scale than 1");
	assert.equal(JSON.stringify(sceneOf(cube.request).characters), JSON.stringify([{ id: "c1", at: [0, 0], heading: 0, scale: 0.8, tint: "#aa3311" }, { id: "c2", at: [1, 0], heading: 90, scale: 1 }]), "another start: each listed character states its own scale, 1 too, in the order of the scene fields");
	assert.equal(cube.request.replace(JSON.stringify(sceneOf(cube.request)), JSON.stringify(sceneOf(plain.request))), plain.request, "and nothing else in the request differs");
	assert.equal(off.bodies, undefined, "the body step off: no start");
	assert.equal(off.request, (await go({ COZYCLAY_MOTION_OFF: "body" })).request, "and the request of the body step off, whatever the look");
	console.log(`ok runMotion: at start ${start} the request states the scale of every listed character, at 1 it is the request of before`);
}
rmSync(tmp, { recursive: true, force: true });
console.log("PASS verify-start-scale");
