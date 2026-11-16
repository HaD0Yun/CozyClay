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
	const done = await runMotion({ ...base, words: "he walks to the box and sits on it", memoryKey: "conv-1", onCompile: c => compiles.push(c) });
	assert.equal(done.report, "He walks over.\nMissing: the fingers do not move.");
	assert.equal(done.missing, "the fingers do not move.");
	assert.deepEqual([done.frames, done.clipSeconds, done.tookSeconds, done.compiles], [48, 2, 3, 1]); // 48 frames at 24 fps; making it took 3 s
	assert.deepEqual(done.characterIds, ["c1"]);
	assert.deepEqual(done.objectIds, ["obj-box"]);
	assert.deepEqual(compiles.map(c => [c.n, c.ok]), [[1, true]]);
	assert.deepEqual(seen.describe[0], { name: "describe", args: { tops: true }, handle: "ws-1" }, "describe is asked for tops");
	const run = seen.runs[0];
	assert.deepEqual([run.model, run.effort, run.variant], ["claude-opus-5-5", "medium", "studio"]);
	assert.deepEqual(run.off, []);
	assert.ok(run.request.startsWith("USER'S WORDS (the user's message of this turn, exactly as typed):\nhe walks to the box and sits on it\n\n"), "words alone (the direct key): no note");
	assert.doesNotMatch(run.request, /STUDIO AGENT'S NOTE/);
	assert.match(run.request, /\nbox offers these flat heights \(world\): \[\{"y":0\.45,/);
	assert.match(run.request, /These characters cannot be animated by the engine and stand as they are: cap \(capsule figure\)\./);
	const scene = sceneJson(run.request);
	assert.deepEqual(Object.keys(scene), ["characters", "props"], "the scene JSON has no others");
	assert.equal(scene.props[0].turn, 30, "the box stands turned");
	assert.equal("heights" in scene.props[0], false, "the scene JSON has no heights");
	assert.equal(seen.installs[0].turn, true);
	assert.deepEqual(seen.installs[0].existing.characters, { c1: "c1" });
	assert.doesNotMatch(run.request, /Your last scene and spec/);

	await runMotion({ ...base, words: "now slower", memoryKey: "conv-1" });
	const second = seen.runs[1].request;
	assert.ok(second.includes(`scene: ${JSON.stringify(SCENE)}`) && second.includes(`spec: ${JSON.stringify(SPEC)}`), "the second call carries the last scene and spec");
	await runMotion({ ...base, words: "another", memoryKey: "conv-2" });
	assert.doesNotMatch(seen.runs[2].request, /Your last scene and spec/, "another conversation does not");
	console.log("PASS runMotion: report, missing, heights and others lines, memory per conversation");
}

// the user's words verbatim, then the agent's note, each under its own label; a task's words say they came from the coordinator's message
{
	const { seen, base } = harness();
	const words = "그 다음 낮은 계단을 비스듬히 올라가서 꼭대기에서 환호해  (two spaces kept)\nsecond line";
	await runMotion({ ...base, words, note: "c1 climbs the steps [obj-box] and cheers at the top. Keep the wave.", images: [{ data: "AAAA", mimeType: "image/png" }] });
	await runMotion({ ...base, words, wordsOf: "task", note: "c1 climbs the steps." });
	await runMotion({ ...base, note: "only a note" });
	const [turn, task, noteOnly] = seen.runs.map(run => run.request);
	assert.ok(turn.startsWith(`USER'S WORDS (the user's message of this turn, exactly as typed):\n${words}\n\nSTUDIO AGENT'S NOTE (the Studio agent's own text: which characters and objects, what to keep):\nc1 climbs the steps [obj-box] and cheers at the top. Keep the wave.\n\nThe user attached 1 picture.\n\n`), turn);
	assert.ok(task.startsWith(`USER'S WORDS (the user's last message to the Studio, exactly as typed; this task may do only part of it):\n${words}\n\nSTUDIO AGENT'S NOTE`), task);
	assert.ok(noteOnly.startsWith("STUDIO AGENT'S NOTE (the Studio agent's own text: which characters and objects, what to keep):\nonly a note\n\n"), "no words: no words label");
	assert.equal(seen.installs[0].label, "c1 climbs the steps [obj-box] and cheers at the top. Keep the wave.", "the take label stays the agent's request");
	console.log("PASS runMotion: the user's words verbatim and the agent's note, each labelled");
}

// switches off: no tops asked, no turn, no heights
{
	const { seen, base } = harness();
	await runMotion({ ...base, env: { COZYCLAY_MOTION_OFF: "turn,tops" }, words: "x", memoryKey: null });
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
	const done = await runMotion({ ...base, words: "x" });
	assert.ok(done.report.endsWith("Missing: the fingers do not move.\n\nChanged to the block figure: c1."), done.report);
	assert.deepEqual(done.switched, ["c1"]);
	assert.equal(done.missing, "the fingers do not move.", "missing stays the motion writer's");
	console.log("PASS runMotion: switched report line");
}

// a refused install
{
	const { base } = harness({ install: async (clip, run) => (await run("character.add", {})) ? { ok: true, characterIds: [], objectIds: [], switched: [] } : { ok: false, characterIds: [], objectIds: [], switched: [] } });
	await assert.rejects(runMotion({ ...base, words: "x", invoke: async () => { throw Object.assign(new Error("nope"), { code: "SCOPE_DENIED" }); } }),
		error => error.code === "studio" && /SCOPE_DENIED: nope/.test(error.message));
	console.log("PASS runMotion: a refused install throws code studio");
}

// aborted
{
	const { seen, base } = harness();
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runMotion({ ...base, words: "x", signal: controller.signal }), error => error.code === "aborted");
	assert.equal(seen.runs.length, 0);
	console.log("PASS runMotion: an aborted signal throws code aborted");
}

// a task run: the clip needs a character the scene does not have
{
	const { seen, base } = harness({ clip: { frameCount: 48, characters: [{ id: "c1" }, { id: "stranger" }], props: [{ id: "box" }, { id: "chair" }] } });
	await assert.rejects(runMotion({ ...base, words: "x", allowAdd: false }),
		error => error.code === "studio" && error.message === "The motion needs stranger, chair that the scene does not have. Build them first, then call motion again.");
	assert.equal(seen.installs.length, 0, "nothing is installed");
	assert.match(seen.runs[0].request, /Add no character and no prop: use the listed ones only\./);
	console.log("PASS runMotion: allowAdd false refuses unknown ids before the install");
}
