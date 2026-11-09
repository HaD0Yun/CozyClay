#!/usr/bin/env node
// Motion tasks (#1138): in task mode the coordinator splits a request into building (ordinary tasks, the Studio engine)
// and moving (motion tasks, the v4 engine on the pi loop). Checked here:
//   (a) motion-tasks.mjs: the character a motion task animates, its scope, its header and the coordinator's rules;
//   (b) the board: a motion task may be queued with no scope key, says so in its view and has its own limits;
//   (c) the coordinator's tools: the motion field and design_motion are there only while the engine is available;
//       the design step (motion-design.mjs): a thin design is refused with what is missing, a motion dispatch without
//       a design is refused, and the design a dispatch names reaches the motion task after its instructions;
//   (d) availability: CLIProxyAPI signed in with Opus 5.5, and the COZYCLAY_MOTION_TASKS=off switch;
//   (e) the routes with a scripted model and the real bus: a plan "place her, then animate her" runs the build on the
//       Studio prompt and the motion on the v4 prompt and tools, in that order; the motion task's install carries its
//       task id between task.begin and task.finish and lands as a raw take; undo_task takes it back; a cancel while a
//       motion task runs puts the take back; without the engine the coordinator has its plain prompt.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createTaskBoard, TASK_LIMITS } from "../bin/agent/studio-tasks.mjs";
import { createMainTools } from "../bin/agent/main-agent.mjs";
import { MAIN_SYSTEM_PROMPT } from "../bin/agent/main-prompt.mjs";
import { motionHeader, motionMainPrompt, motionScope, motionSubject, rigIds } from "../bin/agent/motion-tasks.mjs";
import { createDesigns, designProblems, designText } from "../bin/agent/motion-design.mjs";
import { motionTaskModel, V4_PI_MODEL_KEY } from "../bin/agent/v4/models.mjs";
import { V4_SYSTEM_PROMPT } from "../bin/agent/v4/prompt.mjs";
import { skeletonFor } from "../src/motion3/rigs/index.js";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-motion-tasks-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
// A design a coordinator would write for "chop the tree" (motion-design.mjs).
const DESIGN = {
	action: "He chops the tree with the axe: a full two-handed swing into the trunk.",
	start: "He stands 0.9 m from the trunk, left side to it, feet shoulder-width apart with the left foot forward; right hand under the axe head, left hand at the end of the handle.",
	phases: [
		{ name: "wind-up", seconds: 0.8, body: "Knees bend, hips turn away from the trunk, the spine twists and the axe goes up over the right shoulder; the head stays on the cut.", weight: "onto the back (right) foot", contacts: "both feet flat; both hands on the handle" },
		{ name: "strike", seconds: 0.3, body: "The hips turn back first, then the torso, then the arms; the right hand slides down the handle to the left hand as the head comes down and in.", weight: "from the back foot to the front foot", contacts: "the blade hits the trunk at waist height" },
		{ name: "recover", seconds: 0.9, body: "The arms pull the blade free with a small twist, the spine straightens and the knees extend back to the start stance.", contacts: "both feet flat; both hands on the handle" },
	],
	power: "The force starts in the legs and hips, goes through the twisting torso and ends in the arms; the axe head keeps moving a moment after the hit.",
	rhythm: "Slow wind-up, fast strike, short hold on the hit, then recover; four repeats.",
	mustRead: ["both hands on the handle", "the hips lead the arms", "the blade stops on the trunk"],
	avoid: ["arms only", "sliding feet"],
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async (check, what, tries = 400) => { for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail(`timed out: ${what}`); };

// --- (a) the subject, the scope, the header, the rules ---------------------------------------------------------
{
	const rig = id => ({ id, kind: "character", characterKind: "rig" }), capsule = id => ({ id, kind: "character", characterKind: "proxy" });
	const scene = (...entities) => ({ entities: [...entities, { id: "crate", kind: "object" }] });
	assert.deepEqual(motionSubject({ characterId: "a" }, scene(rig("a"), rig("b"))), { id: "a" }, "a named rig character");
	assert.match(motionSubject({ characterId: "x" }, scene(rig("a"))).reason, /no character x.*Rig characters here: a\./, "an unknown id is refused, with the ids there are");
	assert.match(motionSubject({ characterId: "c" }, scene(rig("a"), capsule("c"))).reason, /capsule figure.*rig characters only/, "a capsule figure is refused");
	assert.match(motionSubject({ characterId: "crate" }, scene(rig("a"))).reason, /no character crate/, "an object is not a character");
	// unnamed: the rig character made since the dispatch (known: the rig characters there were then)
	assert.deepEqual(motionSubject({ known: ["a"] }, scene(rig("a"), rig("b")), [{ changed: ["a", "b"] }]), { id: "b" }, "the one rig character made since the dispatch");
	assert.deepEqual(motionSubject({ known: [] }, scene(rig("n"), capsule("c"))), { id: "n" }, "made in an empty scene");
	assert.match(motionSubject({ known: ["a"] }, scene(rig("a"), rig("b"), rig("c"))).reason, /2 rig characters were made since it was dispatched.*motion: \{ characterId \}/, "two made is refused");
	// none made: the one rig character the dependencies changed, else the only rig character
	assert.deepEqual(motionSubject({ known: ["a", "b"] }, scene(rig("a"), rig("b")), [{ changed: ["b", "object:crate"] }]), { id: "b" }, "the one rig character a dependency changed");
	assert.deepEqual(motionSubject({ known: null }, scene(rig("a"), rig("b")), [{ changed: ["character:a:placement"] }]), { id: "a" }, "a dependency's layer key names its character");
	assert.deepEqual(motionSubject({}, scene(rig("a"), capsule("c"))), { id: "a" }, "the scene's only rig character");
	assert.match(motionSubject({ known: ["a", "b"] }, scene(rig("a"), rig("b")), [{ changed: ["a", "b"] }]).reason, /not clear.*motion: \{ characterId \}/, "two candidates are refused");
	assert.match(motionSubject({}, scene(capsule("c"))).reason, /no rig character/, "no rig character at all");
	assert.deepEqual(rigIds(scene(rig("a"), capsule("c"), rig("b"))), ["a", "b"]); assert.equal(rigIds({ entities: [rig("a")], entityPage: { total: 9 } }), null, "rows cut short: no list");
	// rows cut short by a big scene: an id the index still lists goes through (the engine checks it against the editor)
	const paged = { entities: [rig("a")], entityIndex: [{ id: "a", kind: "character" }, { id: "far", kind: "character" }, { id: "crate", kind: "object" }], entityPage: { total: 3 } };
	assert.deepEqual(motionSubject({ characterId: "far" }, paged), { id: "far" });
	assert.match(motionSubject({ characterId: "crate" }, paged).reason, /no character crate/);
	assert.deepEqual(motionScope([], "a"), ["character:a"]);
	assert.deepEqual(motionScope(["object:axe", "character:a"], "a"), ["object:axe", "character:a"], "the character is added once");
	const header = motionHeader({ taskId: "t1", motion: { characterId: "a" }, instructions: "User: \"chop the tree\"" }, { deps: [{ taskId: "t0", title: "build", summary: { reply: "Made the axe." }, changed: ["axe"] }], resume: { note: "x" } });
	assert.match(header, /^<task id="t1">\nYou are the motion task of a larger job: animate a\./);
	assert.match(header, /Earlier task t0 \(build\) is done: Made the axe\. It changed: axe\./);
	assert.match(header, /Studio reconnected after a disconnect\./);
	assert.match(header, /"Unmet criteria: none"/);
	assert.ok(header.endsWith("</task>\n\nUser: \"chop the tree\""), "the instructions come last, as written");
	assert.ok(!/inspect_studio|run_action|verify_result|qa\.blocking/.test(header), "nothing of the Studio engine's tools or stop rule");
	const designed = motionHeader({ taskId: "t2", motion: { characterId: "a", design: designText(DESIGN) }, instructions: "User: \"chop the tree\"" });
	assert.match(designed, /<\/task>\n\nUser: "chop the tree"\n\nMotion design \(how a real person does this action/, "the design comes after the instructions");
	assert.ok(designed.endsWith("say what you changed in your report."), "and the line that says to build it closes the message");
	const prompt = motionMainPrompt(MAIN_SYSTEM_PROMPT);
	const [head, rules] = prompt.split("\n\nMotion tasks (the motion engine is on");
	assert.ok(rules, "the rules come after the prompt");
	assert.equal(head.replace("8. Motion that an ordinary task makes is done", "8. A motion task is done"), MAIN_SYSTEM_PROMPT, "the plain prompt, with rule 8 named for ordinary tasks");
	assert.ok(!head.includes("8. A motion task is done"), "rule 8 no longer says motion task");
	for (const rule of ["M1.", "M2.", "M3.", "M4.", "M5.", "M6.", "M7.", "M8.", "M9.", "M10."]) assert.ok(prompt.includes(`\n${rule} `), rule);
	assert.match(prompt, /M10\. Design before you dispatch\. For every motion task, first call design_motion/);
	console.log("PASS (a) the motion subject (named, made by a dependency, the only rig, refusals), its scope, the header and the rules");
}

// --- (b) the board ------------------------------------------------------------------------------------------------
function boardFixture(limits = {}) {
	let t = 1000;
	const timers = [], runs = [], events = [];
	const board = createTaskBoard({ limits: { staggerMs: 0, ...limits }, now: () => t, emit: event => events.push(event),
		setTimer: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; }, clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
		run: (task, options) => { const run = { task, options, ...deferred() }; runs.push(run); return run.promise; } });
	const advance = ms => { t += ms; for (const timer of timers.filter(timer => timer.at <= t)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
	return { board, runs, events, advance };
}
{
	const { board, runs, advance } = boardFixture();
	assert.throws(() => board.dispatch({ title: "plain", instructions: "do it", scope: [] }), /scope: one or more keys/, "an ordinary task still needs a key");
	const plain = board.dispatch({ title: "plain", instructions: "place her", scope: ["character:a:placement"] });
	const motion = board.dispatch({ title: "wave", instructions: "she waves", scope: [], dependsOn: [plain.taskId], motion: {} });
	assert.equal(motion.motion, true); assert.equal(plain.motion, undefined);
	assert.deepEqual(board.get(motion.taskId).motion, { characterId: null, known: null, design: null }, "an unnamed motion task keeps a null character until it starts");
	assert.equal(board.dispatch({ title: "wave again", instructions: "she waves", scope: [], motion: {} }).duplicateOf, motion.taskId, "the same motion work is not queued twice");
	assert.equal(board.dispatch({ title: "named", instructions: "he bows", scope: [], motion: { characterId: "b" } }).motion, true);
	assert.deepEqual(board.get(board.board().find(task => task.title === "named").taskId).motion, { characterId: "b", known: null, design: null });
	await tick();
	const plainRun = runs.find(run => run.task.title === "plain"), namedRun = runs.find(run => run.task.title === "named");
	// the ordinary task is stopped at 20 minutes; the motion task is still running then, and is stopped at 60
	plainRun.task.onFrame({ type: "tool.start", callId: "p", name: "x" }); namedRun.task.onFrame({ type: "tool.start", callId: "n", name: "js" });
	advance(TASK_LIMITS.maxMs);
	assert.match(plainRun.task.stopReason, /20 min limit/); assert.equal(namedRun.task.stopReason, undefined, "a motion task runs past the ordinary limit");
	advance(TASK_LIMITS.motionMaxMs - TASK_LIMITS.maxMs);
	assert.match(namedRun.task.stopReason, /60 min limit/);
	console.log("PASS (b) the board queues a motion task with no scope key, marks it, and stops it at its own time limit");
}
{
	const { board, runs } = boardFixture();
	board.dispatch({ title: "plain", instructions: "a", scope: ["object:a"] }); board.dispatch({ title: "motion", instructions: "b", scope: [], motion: { characterId: "c" } });
	await tick();
	const [plainRun, motionRun] = runs;
	for (let i = 0; i <= TASK_LIMITS.maxTools; i++) for (const run of [plainRun, motionRun]) { run.task.onFrame({ type: "tool.start", callId: `c${i}`, name: "t" }); run.task.onFrame({ type: "tool.done", callId: `c${i}`, ok: true }); }
	assert.match(plainRun.task.stopReason, /more than 120 tool calls/); assert.equal(motionRun.task.stopReason, undefined, "a motion task has more tool calls");
	for (let i = TASK_LIMITS.maxTools + 1; i <= TASK_LIMITS.motionMaxTools; i++) motionRun.task.onFrame({ type: "tool.start", callId: `c${i}`, name: "t" });
	assert.match(motionRun.task.stopReason, /more than 400 tool calls/);
	console.log("PASS (b) a motion task's tool limit is its own");
}

// --- (c) the coordinator's tools ----------------------------------------------------------------------------------
{
	const studio = [{ name: "inspect_studio", handler: async () => ({}) }], seen = [];
	const board = { dispatch: args => { seen.push(args); return { taskId: "t", status: "queued", timing: {} }; }, dispatchPlan: args => { seen.push(args); return { tasks: [] }; } };
	const context = { entities: [{ id: "a", kind: "character", characterKind: "rig" }] };
	const designs = new Map();
	const make = motion => createMainTools({ board, studio, hub: {}, admission: { snapshot: async () => context }, workspaceHandle: "h", motion, designs });
	const off = make(false), on = make(true), tool = (tools, name) => tools.find(entry => entry.name === name);
	for (const properties of [tool(off, "dispatch_task").parameters.properties, tool(off, "dispatch_plan").parameters.properties.tasks.items.properties]) {
		assert.equal("motion" in properties, false, "without the engine a dispatch has no motion field"); assert.equal(properties.scope.minItems, 1);
	}
	assert.equal(JSON.stringify(off).includes("MOTION") || JSON.stringify(off).includes("motion task"), false, "and no tool speaks of motion tasks");
	assert.equal(JSON.stringify(make()), JSON.stringify(off), "the default is the engine off");
	for (const properties of [tool(on, "dispatch_task").parameters.properties, tool(on, "dispatch_plan").parameters.properties.tasks.items.properties]) {
		assert.equal(properties.motion.type, "object"); assert.equal(properties.motion.additionalProperties, false);
		assert.deepEqual(properties.motion.required, ["designId"], "a motion dispatch names its design");
		assert.equal(properties.scope.minItems, 0, "a motion task may send scope []"); assert.match(properties.scope.description, /send \[\]/);
	}
	// the design step: design_motion exists only with the engine, refuses a thin design, and answers an id
	assert.equal(tool(off, "design_motion"), undefined, "no design tool without the engine");
	const design = tool(on, "design_motion");
	assert.deepEqual(design.parameters.required, ["action", "start", "phases", "power", "rhythm", "mustRead"]);
	await assert.rejects(async () => design.handler({ ...DESIGN, phases: DESIGN.phases.slice(0, 2) }), /not concrete enough yet.*phases: 2 is too few/s, "two phases are refused");
	await assert.rejects(async () => design.handler({ ...DESIGN, phases: DESIGN.phases.map(phase => ({ ...phase, body: "he swings" })) }), /phases\[0\] \(wind-up\): body is too thin/, "a thin body line is refused, by phase");
	await assert.rejects(async () => design.handler({ ...DESIGN, start: "by the tree", power: "" }), /start: say where the person stands.*power: say where the force starts/s);
	const made = await design.handler(DESIGN);
	assert.match(made.designId, /^design-[0-9a-f]{8}$/); assert.equal(made.seconds, 2); assert.equal(made.frames, 48); assert.equal(made.phases, 3);
	assert.equal(designs.size, 1, "the design is kept with the main session");
	// a motion dispatch must name a design that exists
	const count = seen.length;
	await assert.rejects(tool(on, "dispatch_task").handler({ title: "wave", instructions: "x", scope: [], motion: { characterId: "a" } }), /no such design\. Design the motion first: call design_motion/, "a motion dispatch without a design is refused");
	await assert.rejects(tool(on, "dispatch_plan").handler({ tasks: [{ ref: "m", title: "bow", instructions: "x", scope: [], motion: { designId: "design-00000000" } }] }), /motion\.designId design-00000000: no such design/, "and with an unknown design");
	assert.equal(seen.length, count, "a refused dispatch queues nothing");
	await tool(on, "dispatch_task").handler({ title: "wave", instructions: "she waves", scope: [], motion: { designId: made.designId, characterId: "a" } });
	assert.equal(seen.at(-1).motion.characterId, "a"); assert.equal(seen.at(-1).motion.design, designText(DESIGN), "the design's text reaches the board with the task");
	await tool(on, "dispatch_plan").handler({ tasks: [{ ref: "b", title: "build", instructions: "make him", scope: ["stage"] }, { ref: "m", title: "bow", instructions: "he bows", scope: [], dependsOn: ["b"], motion: { designId: made.designId } }] });
	assert.deepEqual(seen.at(-1).tasks.map(step => step.motion && { ...step.motion, design: Boolean(step.motion.design) }), [undefined, { known: ["a"], design: true }], "an unnamed motion step remembers the rig characters there are at dispatch");
	// the text a motion task reads: time and frame ranges per phase
	const said = designText(DESIGN);
	assert.match(said, /Phases \(2\.0 s in all, about 48 frames at 24 fps\):\n1\. wind-up: 0\.0-0\.8 s \(frames 0-18\)\. Body: Knees bend/);
	assert.match(said, /2\. strike: 0\.8-1\.1 s \(frames 19-25\)\..*Weight: from the back foot to the front foot\. Contacts: the blade hits the trunk at waist height\./);
	assert.match(said, /The viewer must read: both hands on the handle; the hips lead the arms; the blade stops on the trunk\.\nAvoid: arms only; sliding feet\.$/);
	assert.deepEqual(designProblems(DESIGN), []); assert.equal(createDesigns().text("nope"), null);
	await assert.rejects(tool(on, "dispatch_task").handler({ title: "wave", instructions: "x", scope: [], motion: { designId: made.designId, characterId: "ghost" } }), /character:ghost names nothing in this scene/, "an invented character id is refused at dispatch");
	console.log("PASS (c) the motion field and design_motion are on the coordinator only while the engine is available; a motion dispatch needs a concrete design");
}

// --- (d) availability ---------------------------------------------------------------------------------------------
{
	const listing = (signedIn, ids) => ({ providers: [{ id: "openai-codex", signedIn: true, models: [{ id: "gpt-6-astra" }] }, { id: "cliproxy", signedIn, models: ids.map(id => ({ id })) }] });
	assert.equal(motionTaskModel(listing(true, ["claude-opus-5-5", "claude-opus-5"]), {}), V4_PI_MODEL_KEY);
	assert.equal(motionTaskModel(listing(false, ["claude-opus-5-5"]), {}), null, "not signed in");
	assert.equal(motionTaskModel(listing(true, ["claude-opus-5"]), {}), null, "signed in, but Opus 5.5 is not listed");
	assert.equal(motionTaskModel({ providers: [] }, {}), null); assert.equal(motionTaskModel(null, {}), null);
	assert.equal(motionTaskModel(listing(true, ["claude-opus-5-5"]), { COZYCLAY_MOTION_TASKS: "off" }), null, "the off switch");
	console.log("PASS (d) the motion engine is available with CLIProxyAPI signed in and Opus 5.5 listed, unless switched off");
}

// --- (e) the routes, a scripted model and the real bus ---------------------------------------------------------
const { motionFixture } = await import("./bus/motion-fixture.mjs");
const { dispatchLiveFrame } = await import("../src/live-control.js");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const MOTION_PROMPT = motionMainPrompt(MAIN_SYSTEM_PROMPT), B = skeletonFor("y-bot-tpose").names.length, F = 2;
const TRACK = { op: "set", frames: F, rot: Array.from({ length: F * B * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)), hips: Array.from({ length: F }, () => [1, 0.95, 0]).flat() };
const said = (context, text) => JSON.stringify(context.messages.filter(message => message.role !== "system")).includes(text);
const toolResults = context => context.messages.filter(message => message.role === "toolResult").length;
// The coordinator's two steps: design_motion first, then the dispatch that names the design id it answered.
const designCall = () => fauxToolCall("design_motion", DESIGN, { id: `m-${randomUUID()}` });
const designIdOf = context => /design-[0-9a-f]{8}/.exec(JSON.stringify(context.messages.filter(message => message.role === "toolResult").at(-1)))?.[0];
const justDesigned = context => context.messages.at(-1).role === "toolResult" && context.messages.at(-1).toolName === "design_motion";
// A turn's frames: did the call of tool `name` end ok?
const toolOk = (frames, name) => { const start = frames.find(frame => frame.type === "tool.start" && frame.name === name); return Boolean(start && frames.find(frame => frame.type === "tool.done" && frame.callId === start.callId)?.ok); };

/** A handler over the motion fixture (two Y Bot characters, actor-a and actor-b) with a scripted model. */
async function routesFixture({ motion = true, main, studio, v4 }) {
	const f = motionFixture(), commands = [], seenPrompts = new Set();
	const read = () => { const context = f.binding.handlers.read_studio_context({ host: f.host() }); return { ...context, host: { ...context.host, workspaceHandle: "handle-1" } }; };
	const hub = {
		async command(name, payload) {
			commands.push({ name, taskId: payload?.taskId, action: payload?.args?.action });
			// the editor's describe live query: the cast as the v4 engine reads it
			if (name === "describe") return { characters: f.cast.read().map(c => ({ id: c.id, model: c.model, x: c.x, y: c.y, z: c.z, rot: c.rot, scale: c.scale })), activeCharacterId: null, objects: [] };
			const response = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name, args: payload }), f.binding.handlers);
			if (!response.ok) throw Object.assign(new Error(response.error), { code: String(response.error).split(":")[0] });
			return response.value;
		},
		workspaceId: () => f.host().workspaceId, resolveWorkspace: () => "handle-1", connected: true, workspaceHandles: ["handle-1"],
	};
	const fakeModel = createFakeModel();
	const step = async context => {
		const prompt = getCurrentSystemPrompt(context.messages);
		seenPrompts.add(prompt);
		if (prompt === MOTION_PROMPT || prompt === MAIN_SYSTEM_PROMPT) return main(context);
		return prompt === V4_SYSTEM_PROMPT ? v4(context) : studio(context);
	};
	fakeModel.fauxProvider.setResponses(Array.from({ length: 60 }, () => step));
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider,
		liveHub: hub, studioRuntime: { readContext: async () => read() }, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0 }, port: () => server.address().port,
		...(motion ? { motionModel: async () => V4_PI_MODEL_KEY } : {}) });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`, sessionId = randomUUID();
	let cookie = null;
	const post = async text => {
		const response = await fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ surface: "studio", sessionId, turnId: randomUUID(), text, context: read(), model: "faux/scripted" }) });
		cookie ??= response.headers.get("set-cookie")?.split(";")[0] ?? null;
		return [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
	};
	const board = async () => (await (await fetch(`${origin}/agent/main/${sessionId}/board`, { headers: { origin, cookie } })).json()).tasks;
	const cancel = taskId => fetch(`${origin}/agent/task/${taskId}/cancel`, { method: "POST", headers: { origin, cookie } });
	const take = () => f.snapshot(), hasRaw = () => JSON.stringify(take()).includes("\"raw\"");
	const close = async () => { server.closeAllConnections?.(); server.close(); await handler.close?.(); f.dispose(); };
	return { f, commands, seenPrompts, post, board, cancel, hasRaw, close, x: id => f.cast.read().find(row => row.id === id).x };
}

// The coordinator's plan: place her (an ordinary task), then animate her (a motion task).
const planCall = designId => fauxToolCall("dispatch_plan", { tasks: [
	{ ref: "build", title: "place her", instructions: "Move actor-a to x 1.", scope: ["character:actor-a:placement"] },
	{ ref: "move", title: "she waves", instructions: "User: \"make her wave\". Visible criteria: the right hand goes above the head.", scope: [], dependsOn: ["build"], motion: { designId, characterId: "actor-a" } },
] }, { id: `m-${randomUUID()}` });
const buildStep = context => (toolResults(context) === 0
	? fauxAssistantMessage([fauxToolCall("run_action", { action: "character.move", args: { characterId: "actor-a", x: 1, z: 0, rot: 0 } }, { id: `b-${randomUUID()}` })])
	: fauxAssistantMessage([fauxText("Moved actor-a to x 1. Unmet criteria: none")]));

{
	let undo = null;
	const v4Contexts = [];
	const fixture = await routesFixture({
		main: context => {
			const last = context.messages.at(-1);
			if (last.role === "user" && said({ messages: [last] }, "Task events arrived")) return fauxAssistantMessage([fauxText("끝났어요.")]);
			if (last.role === "user" && undo) return fauxAssistantMessage([fauxToolCall("undo_task", { taskId: undo }, { id: `m-${randomUUID()}` })]);
			if (last.role === "user") return fauxAssistantMessage([designCall()]);
			if (justDesigned(context)) return fauxAssistantMessage([planCall(designIdOf(context))]);
			return fauxAssistantMessage([fauxText("배치하고, 이어서 동작을 만들게요.")]);
		},
		studio: buildStep,
		v4: context => {
			v4Contexts.push(context);
			const done = toolResults(context);
			if (done === 0) return fauxAssistantMessage([fauxToolCall("track", TRACK, { id: `v-${randomUUID()}` })]);
			if (done === 1) return fauxAssistantMessage([fauxToolCall("track", { op: "commit", label: "wave" }, { id: `v-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("Made a two-frame wave for actor-a.\nUnmet criteria: none")]);
		},
	});
	try {
		const { commands, post, board, hasRaw, x, seenPrompts } = fixture;
		assert.equal(hasRaw(), false, "no raw take before");
		const frames = await post("그녀를 x 1에 세우고 손을 흔들게 해줘");
		assert.equal(frames.at(-1).type, "done");
		assert.ok(toolOk(frames, "design_motion") && toolOk(frames, "dispatch_plan"), JSON.stringify(frames.filter(frame => frame.type === "tool.done")));
		const called = frames.filter(frame => frame.type === "tool.start").map(frame => frame.name);
		assert.deepEqual(called, ["design_motion", "dispatch_plan"], "the coordinator designs first, then dispatches");
		await until(async () => (await board()).every(task => ["done", "failed", "incomplete", "cancelled"].includes(task.status)), "both tasks end");
		const tasks = await board(), build = tasks.find(task => task.title === "place her"), move = tasks.find(task => task.title === "she waves");
		assert.equal(build.status, "done", JSON.stringify(build)); assert.equal(move.status, "done", JSON.stringify(move));
		assert.ok(seenPrompts.has(MOTION_PROMPT) && !seenPrompts.has(MAIN_SYSTEM_PROMPT), "the coordinator ran under the motion rules");
		assert.ok(seenPrompts.has(V4_SYSTEM_PROMPT), "the motion task ran under the v4 prompt");
		assert.equal(x("actor-a"), 1, "the build task placed her");
		assert.equal(hasRaw(), true, "the motion task installed a raw take");
		assert.equal(move.motion, true); assert.equal(build.motion, undefined);
		assert.deepEqual(move.scope, ["character:actor-a"], "the named character joined the motion task's scope");
		assert.ok(move.changed.includes("character:actor-a"), JSON.stringify(move.changed));
		assert.match(move.summary.reply, /two-frame wave/);
		// the v4 run: the task header and the scene brief, the engine's five tools, none of the Studio engine's
		const first = v4Contexts[0], firstUser = JSON.stringify(first.messages.find(message => message.role === "user"));
		assert.ok(firstUser.includes(`<task id=\\"${move.taskId}\\">`) && firstUser.includes("animate actor-a") && firstUser.includes("make her wave"), firstUser.slice(0, 400));
		assert.ok(firstUser.includes("Subject: actor-a") && firstUser.includes("Earlier task") && firstUser.includes("Moved actor-a to x 1"), "the scene brief and the build's summary");
		// the coordinator's design reached the motion task: after the instructions, with frame ranges, and the line that says to build it
		assert.ok(firstUser.indexOf("make her wave") < firstUser.indexOf("Motion design (how a real person does this action"), "the design follows the instructions");
		assert.ok(firstUser.includes("2. strike: 0.8-1.1 s (frames 19-25)") && firstUser.includes("The viewer must read: both hands on the handle") && firstUser.includes("Start from this design"), firstUser.slice(-900));
		const names = first.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded ?? []).map(tool => tool.name).sort();
		assert.deepEqual(names, ["js", "measure", "qa", "render", "track"], JSON.stringify(names));
		// the editor saw: the build task whole, then the motion task: begin with her scope, the install under its id, finish
		const of = taskId => commands.filter(command => command.taskId === taskId && command.name === "run_action").map(command => command.action);
		assert.deepEqual(of(build.taskId), ["task.begin", "character.move", "task.finish"]);
		assert.deepEqual(of(move.taskId), ["task.begin", "motion.v4.install", "task.finish"]);
		const at = (taskId, action) => commands.findIndex(command => command.taskId === taskId && command.action === action);
		assert.ok(at(build.taskId, "task.finish") < at(move.taskId, "task.begin"), "the motion task starts after the build ends");
		console.log("PASS (e) design, build, motion: the coordinator designs first; the build runs on the Studio engine, the motion on the v4 prompt and tools with the design, inside its own task");

		// undo_task on the motion task: the take goes back, her place stays
		undo = move.taskId;
		const undone = await post("동작 되돌려줘");
		assert.ok(toolOk(undone, "undo_task"), JSON.stringify(undone.filter(frame => frame.type === "tool.done")));
		assert.equal(hasRaw(), false, "undo_task took the raw take back");
		assert.equal(x("actor-a"), 1, "the build task's edit stays");
		console.log("PASS (e) undo_task on a motion task takes its take back and keeps the build");
	} finally { await fixture.close(); }
}

{
	// The build step makes the character; the motion step names none and takes the rig character made since the dispatch.
	const fixture = await routesFixture({
		main: context => {
			const last = context.messages.at(-1);
			if (last.role === "user" && said({ messages: [last] }, "Task events arrived")) return fauxAssistantMessage([fauxText("끝났어요.")]);
			if (last.role === "user") return fauxAssistantMessage([designCall()]);
			if (justDesigned(context)) return fauxAssistantMessage([fauxToolCall("dispatch_plan", { tasks: [
				{ ref: "build", title: "make the woodcutter", instructions: "Add a rig character by the tree.", scope: ["stage"] },
				{ ref: "chop", title: "he chops", instructions: "User: \"he chops the tree\".", scope: [], dependsOn: ["build"], motion: { designId: designIdOf(context) } },
			] }, { id: `m-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("나무꾼을 만들고, 이어서 동작을 만들게요.")]);
		},
		studio: context => (toolResults(context) === 0
			? fauxAssistantMessage([fauxToolCall("run_action", { action: "character.add", args: { character: { id: "woodcutter", model: "y-bot-tpose", x: 0.4, z: 0.4, subject: "a woodcutter" } } }, { id: `b-${randomUUID()}` })])
			: fauxAssistantMessage([fauxText("Added the woodcutter. Unmet criteria: none")])),
		v4: context => {
			const done = toolResults(context);
			if (done === 0) return fauxAssistantMessage([fauxToolCall("track", TRACK, { id: `v-${randomUUID()}` })]);
			if (done === 1) return fauxAssistantMessage([fauxToolCall("track", { op: "commit" }, { id: `v-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("He swings the axe.\nUnmet criteria: none")]);
		},
	});
	try {
		const { f, commands, post, board } = fixture;
		await post("나무를 베는 사람을 만들어줘");
		await until(async () => (await board()).every(task => ["done", "failed", "incomplete", "cancelled"].includes(task.status)), "both tasks end");
		const tasks = await board(), chop = tasks.find(task => task.title === "he chops");
		assert.deepEqual(tasks.map(task => task.status), ["done", "done"], JSON.stringify(tasks.map(task => [task.title, task.status, task.reason])));
		assert.ok(f.cast.read().some(row => row.id === "woodcutter"), "the build task made him");
		assert.deepEqual(chop.scope, ["character:woodcutter"], "the character made since the dispatch is the motion task's");
		assert.deepEqual(commands.filter(command => command.taskId === chop.taskId && command.name === "run_action").map(command => command.action), ["task.begin", "motion.v4.install", "task.finish"]);
		console.log("PASS (e) a motion step that names no character animates the rig character its build step made");
	} finally { await fixture.close(); }
}

{
	// A cancel while the motion task runs: the model has installed a take and is still working.
	const gate = deferred(), installed = deferred();
	const fixture = await routesFixture({
		main: context => {
			const last = context.messages.at(-1);
			if (last.role === "user" && said({ messages: [last] }, "Task events arrived")) return fauxAssistantMessage([fauxText("취소됐어요.")]);
			if (last.role === "user") return fauxAssistantMessage([designCall()]);
			if (justDesigned(context)) return fauxAssistantMessage([fauxToolCall("dispatch_task", { title: "he bows", instructions: "User: \"make him bow\".", scope: [], motion: { designId: designIdOf(context), characterId: "actor-b" } }, { id: `m-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("동작을 만들게요.")]);
		},
		studio: () => fauxAssistantMessage([fauxText("unused")]),
		v4: async context => {
			const done = toolResults(context);
			if (done === 0) return fauxAssistantMessage([fauxToolCall("track", TRACK, { id: `v-${randomUUID()}` })]);
			if (done === 1) return fauxAssistantMessage([fauxToolCall("track", { op: "commit" }, { id: `v-${randomUUID()}` })]);
			installed.resolve(); await gate.promise;
			return fauxAssistantMessage([fauxText("late")]);
		},
	});
	try {
		const { commands, post, board, cancel, hasRaw } = fixture;
		await post("그가 인사하게 해줘");
		await installed.promise;
		assert.equal(hasRaw(), true, "the take is installed while the task still runs");
		const [task] = await board();
		assert.deepEqual(task.scope, ["character:actor-b"], "the named character is the scope");
		assert.equal((await cancel(task.taskId)).status, 200);
		gate.resolve(); // the scripted model does not hear the abort: its pending answer is let go, and the stopped run drops it
		await until(async () => (await board())[0].status === "cancelled", "the motion task is cancelled");
		const ended = (await board())[0];
		assert.equal(ended.edits, "reverted", JSON.stringify(ended)); assert.match(ended.reason, /cancelled by the user; its edits were reverted/);
		assert.equal(hasRaw(), false, "the cancel put the take back");
		assert.deepEqual(commands.filter(command => command.taskId === task.taskId && command.name === "run_action").map(command => command.action), ["task.begin", "motion.v4.install", "task.cancel"]);
		console.log("PASS (e) a cancel while a motion task runs reverts its take (task.cancel)");
	} finally { gate.resolve(); await fixture.close(); }
}

{
	// Without the motion engine: the coordinator has its plain prompt, and a build task runs as before.
	const fixture = await routesFixture({ motion: false,
		main: context => {
			const last = context.messages.at(-1);
			if (last.role === "user" && said({ messages: [last] }, "Task events arrived")) return fauxAssistantMessage([fauxText("끝났어요.")]);
			if (last.role === "user") return fauxAssistantMessage([fauxToolCall("dispatch_task", { title: "place her", instructions: "Move actor-a to x 1.", scope: ["character:actor-a:placement"] }, { id: `m-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("옮길게요.")]);
		},
		studio: buildStep, v4: () => assert.fail("no v4 run without the engine"),
	});
	try {
		const { post, board, seenPrompts, x } = fixture;
		await post("그녀를 x 1로");
		await until(async () => (await board()).every(task => task.status === "done"), "the task ends");
		assert.ok(seenPrompts.has(MAIN_SYSTEM_PROMPT) && !seenPrompts.has(MOTION_PROMPT) && !seenPrompts.has(V4_SYSTEM_PROMPT), "the plain coordinator prompt, no v4 run");
		assert.equal(x("actor-a"), 1);
		console.log("PASS (e) without the motion engine the coordinator and its tasks run as before");
	} finally { await fixture.close(); }
}

console.log("motion tasks: all checks passed");
process.exit(0);
