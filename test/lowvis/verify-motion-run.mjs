#!/usr/bin/env node
// runMotion (bin/agent/motion-run.mjs) with the motion writer, the clip file and the install replaced by fakes; the
// Studio scene bridge (src/lowvis/studio/scene.js) is the real one. What the motion writer reads and what reaches the
// caller: a prop's drawn parts in the scene JSON and to the writer's tool, others as a request line, the last scene and spec per conversation (the
// writer's tool starts from them only while the Studio scene still plays them), the switched report line, and the
// three failure codes.
import assert from "node:assert/strict";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { sceneShapes } from "../../src/lowvis/pi/shapes.mjs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { bodiesOf, bodyFitOf } from "../../bin/agent/motion-fit.mjs";
import { lookBody } from "../../src/lowvis/studio/figure.js";

const DESCRIBE = {
	characters: [{ id: "c1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }, { id: "cap", model: "proxy-figure", x: 1, z: 0, rot: 0, scale: 1 }],
	objects: [{ id: "obj-box", name: "box", renderer: "cube", x: 1, y: 0, z: 2, rot: 30, footprint: { width: 1, depth: 0.5 }, height: 0.9,
		tops: [{ y: 0.45, x0: -0.5, z0: -0.25, x1: 0.5, z1: 0.15 }, { y: 0.9, x0: -0.5, z0: 0.15, x1: 0.5, z1: 0.25 }],
		parts: [{ name: "seat", at: [0, 0.225, -0.05], size: [1, 0.45, 0.4] }, { name: "back", at: [0, 0.45, 0.2], size: [1, 0.9, 0.1] }] }],
};
const SCENE = { characters: [{ id: "c1", at: [0, 0] }], props: [] }, SPEC = { c1: [{ verb: "stand" }] };

function harness({ clip = { frameCount: 48, characters: [{ id: "c1" }], props: [{ id: "box" }] }, install = null, record = {} } = {}) {
	const seen = { describe: [], runs: [], installs: [] };
	const hub = { command: async (name, args, handle) => { seen.describe.push({ name, args, handle }); return DESCRIBE; } };
	const deps = {
		studioScene, sceneShapes,
		runScene: async options => { seen.runs.push(options); options.log("  motion 1: ok frames 48"); return { wallMs: 3200, compiles: 1, report: "He walks over.\nMissing: the fingers do not move.", missing: "the fingers do not move.", final: { clip: "clip.json", scene: SCENE, spec: SPEC }, ...record }; },
		readClip: () => clip,
		installClip: install ?? (async (c, run, options) => { seen.installs.push(options); return { characterIds: [], objectIds: [], switched: [], ok: true }; }),
	};
	return { seen, base: { hub, workspaceHandle: "ws-1", invoke: async () => ({ affectedIds: [] }), env: {}, deps } };
}
const sceneJson = request => JSON.parse(request.split("\n").find(line => line.startsWith("{\"characters\"")));

// happy path, parts and others, memory
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
	assert.deepEqual(seen.describe[0], { name: "describe", args: { parts: true }, handle: "ws-1" }, "describe is asked for the drawn parts");
	const run = seen.runs[0];
	assert.deepEqual([run.model, run.effort, run.variant], ["claude-opus-5-5", "medium", "studio"]);
	assert.deepEqual(run.off, []);
	assert.ok(run.request.startsWith("USER'S WORDS (the user's message of this turn, exactly as typed):\nhe walks to the box and sits on it\n\n"), "words alone (the direct key): no note");
	assert.doesNotMatch(run.request, /STUDIO AGENT'S NOTE/);
	assert.doesNotMatch(run.request, /flat heights/, "no heights lines: the parts are in the scene");
	assert.match(run.request, /These characters cannot be animated by the engine and stand as they are: cap \(capsule figure\)\./);
	const scene = sceneJson(run.request);
	assert.deepEqual(Object.keys(scene), ["characters", "props"], "the scene JSON has no others");
	assert.equal(scene.props[0].turn, 30, "the box stands turned");
	assert.deepEqual(scene.props[0].parts, [{ name: "seat", at: [0, -0.225, -0.05], size: [1, 0.45, 0.4] }, { name: "back", at: [0, 0, 0.2], size: [1, 0.9, 0.1] }], "the scene JSON gives the box its drawn parts, from its centre");
	const shapes = { box: { h: 0.9, parts: DESCRIBE.objects[0].parts } };
	assert.deepEqual(run.shapes, shapes, "the writer's tool gets the shapes from the box's base (null for a prop the Studio draws as its box)");
	assert.deepEqual(await run.reshape(), shapes, "and asks the Studio for them again before a call");
	assert.deepEqual(seen.describe.at(-1).args, { parts: true });
	assert.equal(seen.installs[0].turn, true);
	assert.deepEqual(seen.installs[0].existing.characters, { c1: "c1" });
	assert.doesNotMatch(run.request, /Your last scene and spec/);

	assert.deepEqual(seen.installs[0].source, { name: done.name, scene: SCENE, spec: SPEC }, "the writer's scene and spec go with the takes");
	// the sidecar keeps no spec of its own: a Studio whose takes keep none gives the next request nothing to start from
	await runMotion({ ...base, words: "now slower", memoryKey: "conv-1" });
	assert.doesNotMatch(seen.runs[1].request, /Your last scene and spec/, "nothing kept with a take: a first request");
	assert.equal("kept" in seen.runs[1], false);
	console.log("PASS runMotion: report, missing, heights and others lines; the scene and spec go to the install");
}

// the motion before is the one a take of the open scene plays (its scene and spec kept with the take, in the Studio's
// document), whatever conversation made it; its scene only while the Studio scene is still that scene
{
	const final = { clip: "clip.json", scene: { frames: 48, characters: [{ id: "c1", at: [0, 0], heading: 0 }, { id: "guest", at: [1, 1], heading: 0, scale: 0.8 }], props: [{ id: "box", size: [1, 0.9, 0.5], at: [1, 0.45, 2], turn: 30 }, { id: "cup", size: [0.1, 0.1, 0.1], at: [1, 0.95, 2], moves: true }, { id: "mat", size: [1, 0.05, 1], at: [3, 0.025, 3] }] }, spec: { c1: [[0, "idle"]], guest: [[0, "idle"]] } };
	const clip = { frameCount: 48, characters: [{ id: "c1" }, { id: "guest", scale: 0.8 }], props: [{ id: "box" }, { id: "cup" }, { id: "mat" }] };
	const guest = { id: "lowvis-guest", model: "x-bot-tpose", x: 1, z: 1, rot: 0, scale: 0.8 }, mat = { id: "obj-mat", name: "mat", renderer: "cube", x: 3, y: 0, z: 3, rot: 0, footprint: { width: 1, depth: 1 }, height: 0.05, parts: [{ name: "part", at: [0, 0.025, 0], size: [1, 0.05, 1] }] };
	// the Studio: per scene, the source each character's take keeps (motion.v4.install lowvis), as the describe document has it
	// (null: a take that keeps none)
	const kept = { "scene-a": {}, "scene-b": {} };
	const takeOf = (scene, id) => (kept[scene][id] === null ? { motionTake: { spec: {} } } : kept[scene][id] ? { motionTake: { spec: { lowvis: kept[scene][id] } } } : {});
	const docOf = (open, rows) => ({ activeSceneId: open, scenes: Object.keys(kept).map(id => ({ id, stage: { characters: rows.map(r => ({ id: r.id, ...takeOf(id, r.id) })) } })) });
	let refuse = false, open = "scene-a", rows = DESCRIBE.characters, objects = DESCRIBE.objects;
	const { seen, base } = harness({ clip, record: { final }, install: async (c, run, options) => {
		if (refuse) return { characterIds: [], objectIds: [], switched: [], ok: false };
		for (const id of ["c1", "lowvis-guest"]) kept[open][id] = options.source;
		return { characterIds: ["lowvis-guest"], objectIds: [], switched: [], ok: true };
	} });
	base.hub = { command: async () => ({ document: docOf(open, rows), characters: rows, objects }) };
	const ask = async (key = "conv-kept") => { const done = await runMotion({ ...base, words: "x", memoryKey: key }); return { ...seen.runs.at(-1), done }; };
	const first = await ask();
	assert.ok(!("kept" in first) && !("kept" in first.done), "nothing plays yet: a first request");
	rows = [...DESCRIBE.characters, guest]; objects = [...DESCRIBE.objects, mat]; // the scene once the motion is in; the cup moves with a take and is not listed
	let run = await ask();
	assert.deepEqual(run.kept, { scene: final.scene, spec: final.spec }, "the Studio scene is the motion's scene (a moving prop it does not list, a character's place and what it has more are not compared): scene and spec");
	assert.ok(run.request.includes("The motion tool already holds them, as if you had sent them: a call may send only edit, scene or look."));
	assert.deepEqual(run.done.kept, { name: first.done.name, characters: ["c1", "lowvis-guest"] }, "the agent is told which motion it started from");
	// a new conversation starts from the motion that plays, too
	assert.deepEqual((await ask("conv-new")).kept, { scene: final.scene, spec: final.spec }, "another conversation: the motion that plays");
	// a follow-up on a motion whose kept scene holds parts (the tool set them when it compiled it): the request tells each
	// prop's parts once, the Studio's for a prop it lists (the box: drawn as two parts now) and the kept ones for a prop a
	// bone carries (the cup: the Studio lists it as no prop); a kept prop the Studio has no object for (the lamp) has none.
	// The tool gets the same, and null for a prop drawn as its box
	{
		const was = [{ name: "old", at: [0, 0, 0], size: [1, 0.2, 0.5] }], lid = [{ name: "lid", at: [0, 0.04, 0], size: [0.1, 0.02, 0.1] }, { name: "ear", at: [0.06, 0, 0], size: [0.02, 0.05, 0.02] }];
		const withParts = { ...final, scene: { ...final.scene, props: [...final.scene.props.map(p => (p.id === "box" ? { ...p, parts: was } : p.id === "cup" ? { ...p, parts: lid } : p)), { id: "lamp", size: [0.2, 0.2, 0.2], at: [5, 0.1, 5], moves: true, parts: lid }] } };
		kept["scene-a"] = { c1: { name: first.done.name, ...withParts }, "lowvis-guest": { name: first.done.name, ...withParts } };
		objects = [...DESCRIBE.objects, mat, { id: "obj-cup", name: "cup", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, footprint: { width: 0.1, depth: 0.1 }, height: 0.1, attach: { characterId: "c1", bone: "RightHand" } }];
		const again = await ask(), last = JSON.parse(/\nscene: (.*)\n/.exec(again.request)[1]), now = sceneJson(again.request);
		assert.deepEqual(now.props.find(p => p.id === "box").parts.map(b => b.name), ["seat", "back"], "the Studio scene gives the box the parts it draws now");
		assert.equal("parts" in last.props.find(p => p.id === "box"), false, "the last scene does not tell the box's parts again");
		assert.deepEqual(last.props.find(p => p.id === "cup").parts, lid, "it tells the parts of the cup, which a bone carries");
		assert.equal("parts" in last.props.find(p => p.id === "lamp"), false, "and none of the lamp, which the Studio has no object for");
		assert.deepEqual(again.shapes, { cup: { h: 0.1, parts: [{ ...lid[0], at: [0, 0.09, 0] }, { ...lid[1], at: [0.06, 0.05, 0] }] }, box: { h: 0.9, parts: DESCRIBE.objects[0].parts }, mat: null }, "the tool: the cup's kept shape, the box's from the Studio, the mat drawn as its box");
		assert.deepEqual(await again.reshape(), { box: { h: 0.9, parts: DESCRIBE.objects[0].parts }, mat: null }, "before a call: what the Studio lists now");
	// an object of which nothing was measured (not mounted yet) is neither parts nor a box: the tool keeps what it had
		objects = [...DESCRIBE.objects, { ...mat, parts: [] }];
		assert.deepEqual(Object.keys(await again.reshape()), ["box"], "an unmeasured object is left out");
		objects = [...DESCRIBE.objects, mat];
	}
	// a run that failed (the Studio refused its install) leaves the motion that plays as the next request's start
	const playing = kept["scene-a"].c1;
	// (a writer that ends with the motion that plays installs nothing, so this one ends with another spec)
	const same = final.spec;
	final.spec = { ...same, c1: [[0, "wave"]] };
	refuse = true;
	await assert.rejects(ask(), error => error.code === "studio");
	refuse = false;
	final.spec = same;
	assert.equal(kept["scene-a"].c1, playing);
	assert.deepEqual((await ask()).kept, { scene: final.scene, spec: final.spec }, "after a failed run the tool starts from the motion that is installed");
	// an undo in the Studio puts the take before back: its kept spec is the start
	const older = { name: "agent-20200101-000000-aaaa", scene: final.scene, spec: { c1: [[0, "wave"]], guest: [[0, "idle"]] } };
	kept["scene-a"] = { c1: older, "lowvis-guest": older };
	assert.deepEqual((await ask()).kept.spec, older.spec, "after an undo: the spec of the take that plays");
	// a prop resized and turned, a prop moved, a character rescaled and tinted, in the Studio since
	rows = [DESCRIBE.characters[0], { ...guest, scale: 1, tint: "#336699" }]; objects = [{ ...DESCRIBE.objects[0], height: 0.7, rot: 45 }, { ...mat, x: 3.2 }];
	run = await ask();
	assert.deepEqual(run.kept, { spec: final.spec }, "the Studio scene differs (the last ask installed its motion): the tool starts from the spec alone, so the scene must be sent");
	assert.ok(run.request.includes("(the Studio plays them now). The motion tool already holds the spec, as if you had sent it: a call may send edit in place of spec. It does not hold the scene: the Studio scene above differs from it (guest: scale, tint; box: size, turn, place; mat: place). When the request changes"), run.request);
	rows = [...DESCRIBE.characters, guest]; objects = [...DESCRIBE.objects, mat];
	// another scene is open: its takes keep nothing
	open = "scene-b";
	run = await ask();
	assert.ok(!("kept" in run) && !run.request.includes("Your last scene and spec"), "another scene is open: a first request");
	open = "scene-a";
	// a character of the motion plays another take now (a motion of its own): that motion is the one that plays whole
	const solo = { name: "agent-20991231-235959-bbbb", scene: { frames: 10, characters: [{ id: "guest", at: [1, 1], heading: 0, scale: 0.8 }], props: [] }, spec: { guest: [[0, "jump"]] } };
	kept["scene-a"] = { c1: older, "lowvis-guest": solo };
	assert.deepEqual((await ask()).kept, { scene: solo.scene, spec: solo.spec }, "the motion that plays whole: guest's own");
	// takes that keep no spec (an old scene): a first request, and the agent is told
	kept["scene-a"] = { c1: null, "lowvis-guest": null };
	run = await ask();
	assert.ok(!("kept" in run) && !run.request.includes("Your last scene and spec"));
	assert.deepEqual(run.done.keptNone, ["c1", "lowvis-guest"], "the agent is told which takes keep no spec");
	kept["scene-a"] = { c1: older, "lowvis-guest": older };
	rows = [guest]; objects = [DESCRIBE.objects[0]];
	run = await ask();
	assert.ok(run.request.includes("the Studio scene above differs from it (c1: not in it; mat: not in it)."), run.request);
	rows = [DESCRIBE.characters[1]];
	run = await ask();
	assert.ok(!("kept" in run) && !run.request.includes("Your last scene and spec"), "no character of the motion is left: a first request");
	console.log("PASS runMotion: the tool starts from the motion a take plays (any conversation, after a failed run, after an undo), from its scene only while the Studio scene is that scene");
}

// a first turn: the draft's stand-in is given its look, and another name, while the writer works: the shape the tool is
// given before the next call is under the writer's prop id, not under the object's new name
{
	const rows = [], scene = { frames: 48, characters: [{ id: "c1", at: [0, 0], heading: 0 }], props: [{ id: "seat", size: [1, 0.9, 0.5], at: [2, 0.45, 0] }] }, clip = { frameCount: 48, characters: [{ id: "c1" }], props: [{ id: "seat", size: [1, 0.9, 0.5], pos: [2, 0.45, 0], quat: [0, 0, 0, 1] }] };
	const box = { name: "box", at: [0, 0.45, 0], size: [1, 0.9, 0.5] }, look = [{ name: "slat", at: [0, 0.45, 0], size: [1, 0.05, 0.5] }, { name: "back", at: [0, 0.8, 0.2], size: [1, 0.6, 0.05] }];
	let drafted = false, before = null, after = null;
	const deps = {
		studioScene, sceneShapes, readClip: () => clip, standInOf: () => ({ kind: "sculpt", size: [1, 0.9, 0.5] }),
		addStandIn: async prop => { rows.push({ id: "sculpt-9", name: prop.id, renderer: "sculpt", x: 2, y: 0, z: 0, rot: 0, footprint: { width: 1, depth: 0.5 }, height: 0.9, parts: [box] }); return "sculpt-9"; },
		installClip: async () => ({ characterIds: [], objectIds: [], switched: [], ok: true }),
		runScene: async options => {
			options.onCompiled({ n: 1, scene, clip: "clip.json" });
			for (let k = 0; !drafted && k < 200; k++) await new Promise(resolve => setTimeout(resolve, 5));
			before = await options.reshape();
			rows[0] = { ...rows[0], name: "Bench seat", height: 1.1, parts: look }; // object.sculpt { id, name, recipe }
			after = await options.reshape();
			return { wallMs: 10, compiles: 1, report: "Made.\nMissing: nothing.", missing: "nothing.", finished: true, final: { clip: "clip.json", scene, spec: SPEC } };
		},
	};
	await runMotion({ words: "x", memoryKey: "conv-draft", hub: { command: async () => ({ characters: DESCRIBE.characters, objects: rows }) }, workspaceHandle: "ws-1", invoke: async () => ({ affectedIds: [] }), env: {}, deps, drafting: steps => steps(), onDraft: () => { drafted = true; } });
	assert.deepEqual(before, { seat: null }, "the stand-in: drawn as its box");
	assert.deepEqual(after, { seat: { h: 1.1, parts: look } }, "renamed with its look: still the writer's prop seat");
	console.log("PASS runMotion: a draft stand-in renamed with its look gives its shape to the writer's prop");
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

// switches off: no parts asked, no turn, no parts
{
	const { seen, base } = harness();
	await runMotion({ ...base, env: { COZYCLAY_MOTION_OFF: "turn,tops" }, words: "x", memoryKey: null });
	assert.deepEqual(seen.describe[0].args, {});
	assert.deepEqual(seen.runs[0].off, ["turn", "tops"]);
	assert.equal("parts" in sceneJson(seen.runs[0].request).props[0], false, "no parts with tops off");
	assert.deepEqual([seen.runs[0].shapes, seen.runs[0].reshape], [{}, null], "and none for the tool");
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

// a task run (words of the task): a clip with a character and a prop the scene does not have is installed, and the
// answer names the boxes the motion used and the floor the bodies cross; the boxes are kept for the fit lines
{
	const pos = [];
	for (let f = 0; f < 2; f++) for (let j = 0; j < 17; j++) pos.push(f ? 1.5 : -0.5, 0.9, f ? 2 : 0.25);
	const final = { clip: "clip.json", scene: { characters: [{ id: "c1", at: [0, 0] }, { id: "stranger", at: [1, 1] }], props: [{ id: "box", size: [1, 0.9, 0.5], at: [1, 0.45, 2], turn: 30 }, { id: "chair", size: [0.5, 0.45, 0.5], at: [-1, 0.225, 0] }] }, spec: SPEC };
	const { seen, base } = harness({ clip: { frameCount: 2, characters: [{ id: "c1", pos }, { id: "stranger", pos }], props: [{ id: "box" }, { id: "chair" }] }, record: { final },
		install: async (clip, run, options) => { seen.installs.push(options); return { characterIds: ["lowvis-stranger"], objectIds: ["sculpt-1"], switched: [], placed: { box: "obj-box", chair: "sculpt-1" }, ok: true }; } });
	const done = await runMotion({ ...base, words: "x", wordsOf: "task", note: "she sits", memoryKey: "task-conv" });
	assert.equal(seen.installs.length, 1, "installed in a task too");
	assert.doesNotMatch(seen.runs[0].request, /Add no character/);
	assert.ok(seen.runs[0].request.includes("What your scene adds becomes Studio content") && seen.runs[0].request.includes("After you, the Studio agent gives your props a look"), "the writer hears what becomes of its props");
	assert.deepEqual(done.characterIds, ["c1", "lowvis-stranger"]);
	assert.equal(done.used, "The motion uses these objects as boxes (id: width x height x depth m, base [x, y, z], turn): obj-box (box): 1 x 0.9 x 0.5, [1, 0, 2], 30°; sculpt-1 (chair): 0.5 x 0.45 x 0.5, [-1, 0, 0]. The bodies cross the floor within x -0.5 to 1.5, z 0.25 to 2.");
	const { boxesOf } = await import("../../bin/agent/motion-fit.mjs");
	assert.deepEqual([...boxesOf("task-conv").keys()], ["obj-box", "sculpt-1"]);
	assert.deepEqual(boxesOf("task-conv").get("sculpt-1"), { id: "sculpt-1", name: "chair", size: [0.5, 0.45, 0.5], base: [-1, 0, 0], turn: 0, sphere: false });
	console.log("PASS runMotion: a task adds what the scene lacks; used names the boxes and the floor the bodies cross");
}

// while the motion is written: the objects other calls changed or added meanwhile (changed) that differ where the body
// goes are the answer's motionFit
{
	const pos = [];
	for (let f = 0; f < 2; f++) for (let j = 0; j < 17; j++) pos.push(f ? 1 : 0, j ? 0.9 : 0.05, 0);
	const final = { clip: "clip.json", scene: { characters: [{ id: "c1", at: [0, 0] }], props: [{ id: "box", size: [1, 0.9, 0.5], at: [1, 0.45, 2], turn: 30 }] }, spec: SPEC };
	const { seen, base } = harness({ clip: { frameCount: 2, characters: [{ id: "c1", pos }, { id: "guest", pos }], props: [{ id: "box" }] }, record: { final },
		install: async () => ({ characterIds: ["lowvis-guest"], objectIds: [], switched: [], placed: { box: "obj-box" }, ok: true }) });
	const now = { ...DESCRIBE, objects: [{ ...DESCRIBE.objects[0], x: 1.5 }, { id: "stool-1", name: "stool", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, footprint: { width: 0.4, depth: 0.4 }, height: 0.5 },
		{ id: "rug-1", name: "rug", renderer: "cube", x: 0.5, y: 0, z: 0, rot: 0, footprint: { width: 2, depth: 2 }, height: 0.01 }, { id: "shelf-1", name: "shelf", renderer: "cube", x: 3, y: 0, z: 3, rot: 0, footprint: { width: 1, depth: 0.3 }, height: 2 }] };
	let reads = 0;
	const hub = { command: async (name, args, handle) => { seen.describe.push({ name, args, handle }); return reads++ ? now : DESCRIBE; } };
	const clips = [];
	const deps = { ...base.deps, readClip: file => { clips.push(file); return base.deps.readClip(file); } };
	const done = await runMotion({ ...base, hub, deps, words: "he walks", memoryKey: "conv-fit", changed: () => ["obj-box", "stool-1", "rug-1", "shelf-1", "stool-1"] });
	assert.deepEqual(clips, ["clip.json"], "only the final clip is read");
	assert.deepEqual(seen.describe[1].args, { tops: true });
	assert.deepEqual(done.motionFit.objects.map(entry => entry.id), ["obj-box", "stool-1"], "the moved box and the stool on the walk; the flat rug and the far shelf are not named");
	assert.match(done.motionFit.objects[0].differs[0], /^base at \[1\.5, 0, 2\], the box's at \[1, 0, 2\]$/);
	assert.match(done.motionFit.objects[1].differs[0], /^footprint 0\.4 x 0\.4 m, 0\.5 m tall, at \[0, 0\] stands on floor the feet use \(\d+ cells? of 0\.1 m\); the motion was written without it$/);
	const quiet = await runMotion({ ...harness().base, words: "x" });
	assert.equal("motionFit" in quiet, false, "nothing changed meanwhile: no motionFit and no second describe");
	console.log("PASS runMotion: objects changed or added meanwhile answer motionFit");
}

// under a look with a body of its own (cube), the clip holds the engine's size and the answer the character's scale:
// bodies and the remembered body a later edit is measured against (motion-fit.mjs) never hold the look's body
{
	const cube = { ...harness().base.env, COZYCLAY_FIGURE: "cube" }, B = lookBody("cube");
	const at = async (scale, key) => { const { base } = harness({ clip: { frameCount: 48, characters: [{ id: "c1", ...(scale * B === 1 ? {} : { scale: scale * B }) }], props: [] } }); return runMotion({ ...base, env: cube, words: "x", memoryKey: key }); };
	assert.equal("bodies" in await at(1, "conv-cube-1"), false, "a body at scale 1 is not named: its clip size is the look's body");
	assert.deepEqual([...bodiesOf("conv-cube-1").values()], [{ id: "c1", scale: 1, tint: null }]);
	assert.deepEqual(bodyFitOf(bodiesOf("conv-cube-1").get("c1"), { scale: 1 }), [], "an edit of a character at the motion's scale has no size line");
	assert.deepEqual((await at(0.9, "conv-cube-2")).bodies, [{ id: "c1", scale: 0.9, tint: null }], "the character's scale, not 0.9 times the look's body");
	assert.match(bodyFitOf(bodiesOf("conv-cube-2").get("c1"), { scale: 1.2 })[0], /^scale 1\.2, the motion's 0\.9: /);
	const { base } = harness({ clip: { frameCount: 48, characters: [{ id: "c1", scale: 1.2 }], props: [] } });
	assert.deepEqual((await runMotion({ ...base, words: "x", memoryKey: "conv-block" })).bodies, [{ id: "c1", scale: 1.2, tint: null }], "the rig's own body: the clip's scale as it is");
	console.log("PASS runMotion: bodies and the remembered body are in the character's scale under a look with a body of its own");
}

// the direct key (no note): the writer is not told of a later dressing step
{
	const { seen, base } = harness();
	await runMotion({ ...base, words: "x" });
	assert.ok(seen.runs[0].request.includes("What your scene adds becomes Studio content") && !seen.runs[0].request.includes("After you, the Studio agent"));
	console.log("PASS runMotion: the direct key's request has no dressing line");
}
