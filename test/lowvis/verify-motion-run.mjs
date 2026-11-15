#!/usr/bin/env node
// runMotion (bin/agent/motion-run.mjs) with the motion writer, the clip file and the install replaced by fakes; the
// Studio scene bridge (src/lowvis/studio/scene.js) is the real one. What the motion writer reads and what reaches the
// caller: heights and others as request lines (not in the scene JSON), the last scene and spec per conversation, the
// switched report line, and the three failure codes.
import assert from "node:assert/strict";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";

const DESCRIBE = {
	characters: [{ id: "c1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }, { id: "cap", model: "proxy-figure", x: 1, z: 0, rot: 0, scale: 1 }],
	objects: [{ id: "obj-box", name: "box", renderer: "cube", x: 1, y: 0, z: 2, rot: 30, footprint: { width: 1, depth: 0.5 }, height: 0.9,
		tops: [{ y: 0.45, x0: -0.5, z0: -0.25, x1: 0.5, z1: 0.15 }, { y: 0.9, x0: -0.5, z0: 0.15, x1: 0.5, z1: 0.25 }] }],
};
const SCENE = { characters: [{ id: "c1", at: [0, 0] }], props: [] }, SPEC = { c1: [{ verb: "stand" }] };

function harness({ clip = { frameCount: 48, characters: [{ id: "c1" }], props: [{ id: "box" }] }, install = null, record = {} } = {}) {
	const seen = { describe: [], runs: [], installs: [] };
	const hub = { command: async (name, args, handle) => { seen.describe.push({ name, args, handle }); return DESCRIBE; } };
	const deps = {
		studioScene,
		runScene: async options => { seen.runs.push(options); options.log("  motion 1: ok frames 48"); return { wallMs: 3200, compiles: 1, report: "He walks over.\nMissing: the fingers do not move.", missing: "the fingers do not move.", final: { clip: "clip.json", scene: SCENE, spec: SPEC }, ...record }; },
		readClip: () => clip,
		installClip: install ?? (async (c, run, options) => { seen.installs.push(options); return { characterIds: [], objectIds: [], switched: [], ok: true }; }),
	};
	return { seen, base: { hub, workspaceHandle: "ws-1", invoke: async () => ({ affectedIds: [] }), env: {}, deps } };
}
const sceneJson = request => JSON.parse(request.split("\n").find(line => line.startsWith("{\"characters\"")));

// happy path, heights and others, memory
{
	const { seen, base } = harness();
	const compiles = [];
	const done = await runMotion({ ...base, text: "he walks to the box and sits on it", memoryKey: "conv-1", onCompile: c => compiles.push(c) });
	assert.equal(done.report, "He walks over.\nMissing: the fingers do not move.");
	assert.equal(done.missing, "the fingers do not move.");
	assert.deepEqual([done.frames, done.seconds, done.compiles], [48, 3, 1]);
	assert.deepEqual(done.characterIds, ["c1"]);
	assert.deepEqual(done.objectIds, ["obj-box"]);
	assert.deepEqual(compiles.map(c => [c.n, c.ok]), [[1, true]]);
	assert.deepEqual(seen.describe[0], { name: "describe", args: { tops: true }, handle: "ws-1" }, "describe is asked for tops");
	const run = seen.runs[0];
	assert.deepEqual([run.model, run.effort, run.variant], ["claude-opus-5-5", "medium", "studio"]);
	assert.deepEqual(run.off, []);
	assert.match(run.request, /^he walks to the box and sits on it\n\n/);
	assert.match(run.request, /\nbox offers these flat heights \(world\): \[\{"y":0\.45,/);
	assert.match(run.request, /These characters cannot be animated by the engine and stand as they are: cap \(capsule figure\)\./);
	const scene = sceneJson(run.request);
	assert.deepEqual(Object.keys(scene), ["characters", "props"], "the scene JSON has no others");
	assert.equal(scene.props[0].turn, 30, "the box stands turned");
	assert.equal("heights" in scene.props[0], false, "the scene JSON has no heights");
	assert.equal(seen.installs[0].turn, true);
	assert.deepEqual(seen.installs[0].existing.characters, { c1: "c1" });
	assert.doesNotMatch(run.request, /Your last scene and spec/);

	await runMotion({ ...base, text: "now slower", memoryKey: "conv-1" });
	const second = seen.runs[1].request;
	assert.ok(second.includes(`scene: ${JSON.stringify(SCENE)}`) && second.includes(`spec: ${JSON.stringify(SPEC)}`), "the second call carries the last scene and spec");
	await runMotion({ ...base, text: "another", memoryKey: "conv-2" });
	assert.doesNotMatch(seen.runs[2].request, /Your last scene and spec/, "another conversation does not");
	console.log("PASS runMotion: report, missing, heights and others lines, memory per conversation");
}

// switches off: no tops asked, no turn, no heights
{
	const { seen, base } = harness();
	await runMotion({ ...base, env: { COZYCLAY_MOTION_OFF: "turn,tops" }, text: "x", memoryKey: null });
	assert.deepEqual(seen.describe[0].args, {});
	assert.deepEqual(seen.runs[0].off, ["turn", "tops"]);
	assert.doesNotMatch(seen.runs[0].request, /flat heights/);
	assert.equal("turn" in sceneJson(seen.runs[0].request).props[0], false);
	assert.equal(seen.installs[0].turn, false);
	console.log("PASS runMotion: COZYCLAY_MOTION_OFF turn,tops");
}

// switched characters end the report
{
	const { base } = harness({ install: async () => ({ characterIds: [], objectIds: [], switched: ["c1"], ok: true }) });
	const done = await runMotion({ ...base, text: "x" });
	assert.ok(done.report.endsWith("Missing: the fingers do not move.\n\nChanged to the block figure: c1."), done.report);
	assert.deepEqual(done.switched, ["c1"]);
	assert.equal(done.missing, "the fingers do not move.", "missing stays the motion writer's");
	console.log("PASS runMotion: switched report line");
}

// a refused install
{
	const { base } = harness({ install: async (clip, run) => (await run("character.add", {})) ? { ok: true, characterIds: [], objectIds: [], switched: [] } : { ok: false, characterIds: [], objectIds: [], switched: [] } });
	await assert.rejects(runMotion({ ...base, text: "x", invoke: async () => { throw Object.assign(new Error("nope"), { code: "SCOPE_DENIED" }); } }),
		error => error.code === "studio" && /SCOPE_DENIED: nope/.test(error.message));
	console.log("PASS runMotion: a refused install throws code studio");
}

// aborted
{
	const { seen, base } = harness();
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runMotion({ ...base, text: "x", signal: controller.signal }), error => error.code === "aborted");
	assert.equal(seen.runs.length, 0);
	console.log("PASS runMotion: an aborted signal throws code aborted");
}

// a task run: the clip needs a character the scene does not have
{
	const { seen, base } = harness({ clip: { frameCount: 48, characters: [{ id: "c1" }, { id: "stranger" }], props: [{ id: "box" }, { id: "chair" }] } });
	await assert.rejects(runMotion({ ...base, text: "x", allowAdd: false }),
		error => error.code === "studio" && error.message === "The motion needs stranger, chair that the scene does not have. Build them first, then call motion again.");
	assert.equal(seen.installs.length, 0, "nothing is installed");
	assert.match(seen.runs[0].request, /Add no character and no prop: use the listed ones only\./);
	console.log("PASS runMotion: allowAdd false refuses unknown ids before the install");
}
