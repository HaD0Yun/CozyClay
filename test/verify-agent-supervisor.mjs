#!/usr/bin/env node
// Supervisor v2 (#728): an asynchronous post-turn review that leaves one note
// on the Studio turn and never holds the turn's stream open.
//   (a) the pure digest and verdict parser in bin/agent/supervisor.mjs;
//   (b) the sidecar route: a scripted Studio turn ends with `done` before the
//       review's model call is even issued, then GET /agent/turn/<id>/supervisor
//       and the events replay carry the note; read-only turns, the env switch,
//       a wrong owner and a garbage verdict each answer what they should.
//   (c) fixes (#743): validateFixes keeps only fixes the action index and the
//       schemas admit, the route returns them on the note, and the panel's
//       follow-up asks for exactly those run_action calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { buildSupervisorInput, parseSupervisorVerdict, shouldSupervise, SUPERVISOR_RUBRIC, validateFixes } from "../bin/agent/supervisor.mjs";
import { followUpExchange, isFollowUpAnswer } from "../bin/agent/supervisor-followup.mjs";
import { supervisorFollowUp } from "../src/workflow/agent-client.js";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { contextFixture, envelopeFixture, receiptFixture } from "./verify-studio-agent-protocol.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-supervisor-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
delete process.env.COZYCLAY_SUPERVISOR;
delete process.env.COZYCLAY_SUPERVISOR_EFFORT;
delete process.env.COZYCLAY_SUPERVISOR_AUTOFIX;

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, label = "fixture event") {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 10_000); })]); }
	finally { clearTimeout(timer); }
}

// --- (a) pure digest and parser ---------------------------------------------
{
	const delta = Array.from({ length: 12 }, (_, index) => ({ id: `row-${index}`, after: { position: { x: index, y: 0, z: 0 } } }));
	const warnings = Array.from({ length: 20 }, (_, index) => ({ code: `W_${index}` }));
	const frames = [
		{ type: "tool.start", callId: "c1", name: "inspect_studio", args: { scope: "scene" } },
		{ type: "tool.done", callId: "c1", ok: true, result: { context: { big: true }, entities: [] } },
		{ type: "tool.start", callId: "c2", name: "arrange_objects", args: { ops: [{ op: "create" }] } },
		{ type: "tool.done", callId: "c2", ok: true, result: { ...receiptFixture(), delta, warnings, dataUrl: png, visual: { dataUrl: png } } },
		{ type: "tool.start", callId: "c3", name: "run_action", args: { action: "character.pose" } },
		{ type: "tool.done", callId: "c3", ok: false, error: "TARGET_NOT_READY: Capsule figures cannot pose." },
	];
	const images = Array.from({ length: 7 }, (_, index) => ({ label: `image ${index}`, dataUrl: png, width: 1280, height: 720 }));
	const input = buildSupervisorInput({ request: "put a chair left of her", frames, reply: "x".repeat(5000), geometry: { shots: [], axisConsistent: null }, images });
	assert.ok(!input.text.includes("data:image"), "no image bytes ride in the digest text");
	const line = name => JSON.parse(input.text.split("\n").find(entry => entry.startsWith(`${name}: `)).slice(name.length + 2));
	const [receipt] = line("receipts");
	assert.equal(line("receipts").length, 1, "an inspect result is a call, not a receipt");
	assert.equal(receipt.delta.length, 8, "delta is capped at 8 rows");
	assert.equal(receipt.deltaOmitted, 4);
	assert.equal(receipt.warnings.length, 12, "warnings are capped at 12");
	assert.equal(receipt.dataUrl, undefined);
	assert.deepEqual(line("refusals"), [{ code: "TARGET_NOT_READY", message: "Capsule figures cannot pose.", tool: "run_action" }]);
	assert.equal(line("reply").length, 4000, "the reply is capped at 4000 characters");
	assert.equal(input.images.length, 5, "at most five pictures");
	assert.deepEqual(input.images[0], { type: "image", data: png.split(",")[1], mimeType: "image/png" });
	assert.equal(shouldSupervise(frames.slice(0, 2)), false, "a read-only turn is not reviewed");
	assert.equal(shouldSupervise(frames.slice(4)), true, "a refusal alone is reviewed");

	const verdict = { items: [{ text: "chair", status: "done", evidence: "receipt-1" }], issues: [{ severity: "concern", kind: "framing", text: "tight", evidence: "derivedSize" }], summary: "ok" };
	assert.deepEqual(parseSupervisorVerdict(`Here it is:\n${JSON.stringify(verdict)}\nthanks {}`), verdict, "the first JSON block is the verdict");
	assert.equal(parseSupervisorVerdict("I think it went fine."), null);
	assert.equal(parseSupervisorVerdict("{not json"), null);
	assert.equal(parseSupervisorVerdict(JSON.stringify({ ...verdict, summary: 3 })), null);
	assert.equal(parseSupervisorVerdict(JSON.stringify({ ...verdict, issues: [{ ...verdict.issues[0], severity: "fatal" }] })), null);
	assert.equal(parseSupervisorVerdict(JSON.stringify({ ...verdict, items: [{ ...verdict.items[0], status: "maybe" }] })), null);
	console.log("PASS the digest is bounded and the verdict parser accepts only a valid verdict");
}

// --- (c) fixes: pure validation and the follow-up text --------------------------
const ACTION_INDEX = [{ id: "character.setPose", label: "Set pose" }, { id: "shot.frame", label: "Frame shot" }, { id: "object.update", label: "Update object" }, { id: "scene.rename", label: "Rename scene" }];
const ACTION_SCHEMAS = [
	{ id: "character.setPose", label: "Set pose", input: { type: "object", properties: { characterId: { type: "string" }, posture: { type: "string" } }, required: ["characterId", "posture"], additionalProperties: false } },
	{ id: "shot.frame", label: "Frame shot", input: { type: "object", properties: { shotId: { type: "string" }, subjectIds: { type: "array" }, framing: { type: "object" } }, required: ["shotId"], additionalProperties: false } },
	{ id: "object.update", label: "Update object", input: { type: "object", properties: { id: { type: "string" }, position: { type: "object" } }, required: ["id"], additionalProperties: true } },
];
{
	const issue = (severity, fix) => ({ severity, kind: "framing", text: `${severity} issue`, evidence: "e", ...(fix ? { fix } : {}) });
	const framed = { action: "shot.frame", args: { shotId: "shot-1", subjectIds: ["char-a"], framing: { intent: { size: "medium shot" } } } };
	const checked = validateFixes([issue("blocker", framed), issue("concern", { action: "character.teleport", args: { characterId: "char-a" } }), issue("note")], { index: ACTION_INDEX, schemas: ACTION_SCHEMAS });
	assert.deepEqual(checked.issues[0].fix, framed, "a fix whose action is indexed and whose args satisfy the schema is kept");
	assert.equal(checked.issues[1].fix, undefined, "an unknown action's fix is removed from its issue");
	assert.equal(checked.issues[1].text, "concern issue", "the issue itself stays");
	assert.deepEqual(checked.dropped, [{ issueIndex: 1, action: "character.teleport", reason: "unknown action" }]);
	const missing = validateFixes([issue("blocker", { action: "character.setPose", args: { characterId: "char-b" } })], { index: ACTION_INDEX, schemas: ACTION_SCHEMAS });
	assert.equal(missing.issues[0].fix, undefined);
	assert.equal(missing.dropped.length, 1);
	assert.match(missing.dropped[0].reason, /required key "posture"/, "the reason names the missing key");
	assert.deepEqual(validateFixes([issue("concern", { action: "object.update", args: "table-1" })], { index: ACTION_INDEX }).dropped, [{ issueIndex: 0, action: "object.update", reason: "args is not an object" }]);
	assert.equal(validateFixes([issue("concern", { action: "scene.rename", args: {} })], { index: ACTION_INDEX, schemas: ACTION_SCHEMAS }).dropped.length, 0, "without a schema only the index and the args shape are checked");
	const verdict = parseSupervisorVerdict(JSON.stringify({ items: [], issues: [issue("concern", framed), issue("note")], summary: "s" }));
	assert.deepEqual(verdict.issues[0].fix, framed, "the parser keeps a fix for validation");
	assert.equal(Object.hasOwn(verdict.issues[1], "fix"), false, "and adds none to an issue without one");

	const input = buildSupervisorInput({ request: "r", actions: { index: ACTION_INDEX, schemas: ACTION_SCHEMAS } });
	const block = name => input.text.split("\n").find(entry => entry.startsWith(`${name}: `));
	assert.deepEqual(JSON.parse(block("ACTIONS").slice("ACTIONS: ".length)), ["character.setPose (Set pose)", "shot.frame (Frame shot)", "object.update (Update object)", "scene.rename (Rename scene)"]);
	assert.deepEqual(JSON.parse(block("ACTION SCHEMAS").slice("ACTION SCHEMAS: ".length))["character.setPose"].required, ["characterId", "posture"]);
	const big = Array.from({ length: 12 }, (_, index) => ({ id: `big.${index}`, input: { type: "object", description: "x".repeat(900) } }));
	const bounded = JSON.parse(buildSupervisorInput({ actions: { index: [], schemas: big } }).text.split("\n").find(entry => entry.startsWith("ACTION SCHEMAS: ")).slice("ACTION SCHEMAS: ".length));
	assert.ok(JSON.stringify(bounded).length <= 6000 + 200 && bounded.omitted.length > 0 && Object.keys(bounded).length > 1, "schemas are bounded to 6 KB and the rest named");

	const note = { issues: [issue("blocker", framed), issue("concern"), issue("note")], fixes: [{ issueIndex: 0, severity: "blocker", ...framed }] };
	const text = supervisorFollowUp(note).split("\n");
	assert.equal(text[0], "Supervisor review \u2014 apply these fixes exactly, in order, in ONE script call, then verify_result; do not re-derive them:");
	assert.equal(text[1], `- [blocker] blocker issue -> run_action ${JSON.stringify(framed)}`);
	assert.deepEqual(text.slice(2), ["Also check:", "- [concern] concern issue (e)"], "an unfixed concern follows under its own header, the note does not");
	assert.equal(supervisorFollowUp({ issues: note.issues }), "Supervisor review \u2014 please address:\n- [blocker] blocker issue (e)\n- [concern] concern issue (e)", "without fixes the text is unchanged");
	console.log("PASS fixes are validated against the action index and schemas, and the follow-up runs them verbatim");
}

// --- cast style and the exchange a short answer approves ---------------------
{
	const line = (text, name) => text.split("\n").find(entry => entry.startsWith(`${name}: `));
	assert.equal(JSON.parse(line(buildSupervisorInput({ request: "r", castStyle: "hybrid" }).text, "castStyle").slice("castStyle: ".length)), "hybrid", "a present castStyle rides in the digest");
	assert.equal(line(buildSupervisorInput({ request: "r" }).text, "castStyle"), undefined, "an absent castStyle is omitted");
	for (const answer of ["yes", " Yes! ", "n", "OK.", "sure", "응", "네.", "예", "아니", "아니요?", "좋아"]) assert.ok(isFollowUpAnswer(answer), answer);
	for (const request of ["yes please add a lamp", "put a chair left of her", ""]) assert.equal(isFollowUpAnswer(request), false, request);
	const proposal = "This shot needs three rigs passing a tray. Use capsule figures for this shot instead? (yes = capsules, no = keep the rig)";
	const message = (role, text) => ({ role, content: [{ type: "text", text }] });
	const history = [message("user", "first"), message("assistant", "done"), message("user", "stage the dinner shot"), message("assistant", proposal)];
	const exchange = { user: "stage the dinner shot", assistant: proposal };
	assert.deepEqual(followUpExchange("yes", () => history), exchange, "read before the answer was stored");
	assert.deepEqual(followUpExchange("yes", () => [...history, message("user", "yes"), message("assistant", "Added two capsules.")]), exchange, "the answering turn itself is skipped");
	assert.equal(followUpExchange("put a chair left of her", () => history), null, "a normal request carries no previous exchange");
	assert.equal(followUpExchange("yes", () => []), null, "nothing to answer, nothing carried");
	assert.equal(followUpExchange("yes", () => { throw new Error("unreadable"); }), null, "an unreadable history is skipped");
	const followUp = buildSupervisorInput({ request: "yes", previousExchange: exchange });
	assert.deepEqual(JSON.parse(line(followUp.text, "previousExchange").slice("previousExchange: ".length)), exchange, "a follow-up's digest carries the exchange it answers");
	assert.equal(line(buildSupervisorInput({ request: "put a chair left of her" }).text, "previousExchange"), undefined, "a normal request's digest does not");
	assert.match(SUPERVISOR_RUBRIC, /castStyle hybrid, or no castStyle given[^.]*previousExchange/, "the rubric names what it now receives");
	console.log("PASS the digest carries castStyle when present and, for a short answer, the exchange it approves");
}

// --- (b) the route ------------------------------------------------------------
const VERDICT = { items: [{ text: "의자 배치", status: "done", evidence: "receipt-1 chair" }], issues: [{ severity: "blocker", kind: "honesty", text: "검증 주장", evidence: "no verify_result" }, { severity: "concern", kind: "framing", text: "의자가 잘림", evidence: "clipped true" }], summary: "의자는 놓였지만 보고가 과장됨." };
const isSupervisorCall = context => getCurrentSystemPrompt(context.messages) === SUPERVISOR_RUBRIC;

async function fixture({ readOnly = false, supervisorReply = JSON.stringify(VERDICT), actionIndex } = {}) {
	const log = [], commands = [], modelCalls = [];
	const gate = deferred();
	let reads = 0;
	const base = contextFixture();
	const shot = id => ({ id, name: id === "shot-1" ? "Shot 1" : "Shot 2", range: { startFrame: id === "shot-1" ? 0 : 72, endFrameExclusive: 144 }, keyCount: 1 });
	// The turn is admitted at the submitted context; the scene the review reads
	// afterwards has the shot this turn created.
	const readContext = async () => reads++ === 0 ? { ...contextFixture(), ...(actionIndex ? { actionIndex } : {}) } : { ...base, revision: { ...base.revision, scene: 42 }, view: { ...base.view, frame: 12 }, shot: { ...shot("shot-1"), mode: "keys" }, shots: [shot("shot-1"), shot("shot-2")] };
	const hub = {
		async command(name, args) {
			commands.push({ name, args });
			if (name === "arrange_objects") return { ...receiptFixture(), affectedIds: ["chair", "shot-2"] };
			if (name === "inspect_studio" && args.scope === "actions") return { revision: { scene: 42 }, actions: ACTION_SCHEMAS.filter(row => args.ids.includes(row.id)) };
			if (name === "inspect_studio") return { revision: { scene: 41 }, entities: [] };
			if (name === "verify_result") return { receiptId: null, revision: 42, checks: { coverage: "current-scene-targets" }, visualRefs: [], geometry: { subjects: [], pairs: [], shots: [{ shotId: "shot-2", subjectIds: [], camera: null, cameraSide: null, occluders: [] }], axisConsistent: null } };
			if (name === "capture_framing_png") {
				// The review's first editor read waits until the test has seen the
				// turn's stream end, which makes the ordering below deterministic.
				await gate.promise;
				const wide = args.output?.width ?? 1920;
				return { dataUrl: png, width: wide, height: Math.round(wide * 9 / 16), frame: 12, shotId: "shot-1" };
			}
			if (name === "capture_plan_png") return { dataUrl: png, width: 1280, height: 720 };
			if (name === "operate_studio") return { ok: true, status: "transient", authored: false, revision: { before: 42, after: 42 } };
			return { ok: true, status: "applied", revision: { before: 41, after: 41 } };
		},
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"],
	};
	const fakeModel = createFakeModel();
	const respond = message => async (context, options) => {
		const supervisor = isSupervisorCall(context);
		modelCalls.push({ supervisor, context, options });
		log.push(supervisor ? "supervisor-call" : "turn-call");
		return message;
	};
	fakeModel.fauxProvider.setResponses([
		respond(fauxAssistantMessage([readOnly ? fauxToolCall("inspect_studio", { scope: "scene" }, { id: "t1" }) : fauxToolCall("arrange_objects", { ops: [{ op: "create", source: { kind: "chair" }, name: "Side chair", position: { world: { x: -1.4, y: 0, z: 0 } } }] }, { id: "t1" })])),
		respond(fauxAssistantMessage([fauxText(readOnly ? "There is one character." : "Placed the chair 1.4 m to her left and verified it.")])),
		respond(fauxAssistantMessage([fauxText(supervisorReply)])),
	]);
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, liveHub: hub, studioRuntime: { readContext }, supervisor: true, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const turn = async (text = "선택된 캐릭터 왼쪽 1.4m에 의자 하나 놔줘", extra = {}) => {
		const body = { ...envelopeFixture(), sessionId: randomUUID(), turnId: randomUUID(), text, model: "faux/scripted", ...extra };
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
		const stream = await bounded(response.text(), "turn stream");
		log.push("stream-ended");
		return { turnId: body.turnId, cookie: response.headers.get("set-cookie")?.split(";")[0], frames: [...stream.matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1])) };
	};
	const get = (path, cookie) => fetch(`${origin}${path}`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
	return { log, commands, modelCalls, gate, turn, get, async close() { gate.resolve(); await handler.close(); await new Promise(resolve => server.close(resolve)); } };
}
// The faux provider splits text into a random number of deltas, so a run of
// them reads as one.
const frameTypes = frames => frames.filter(frame => !["execution_telemetry", "execution_tool_started"].includes(frame.type)).map(frame => frame.type)
	.filter((type, index, types) => type !== "text.delta" || types[index - 1] !== "text.delta");

// An authored turn: the stream ends at done, untouched by the review, and the
// review's one model call is issued only after that.
let authoredTypes;
{
	const f = await fixture();
	const { turnId, cookie, frames } = await f.turn(undefined, { supervisor: true });
	authoredTypes = frameTypes(frames);
	assert.equal(authoredTypes.at(-1), "done", "the turn stream still ends with done");
	assert.ok(!authoredTypes.includes("supervisor"), "the turn stream never carries the review");
	assert.deepEqual(f.log, ["turn-call", "turn-call", "stream-ended"], "no review call was issued while the turn streamed");
	const pending = f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie);
	f.gate.resolve();
	const response = await bounded(pending, "supervisor long-poll");
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.deepEqual(f.log, ["turn-call", "turn-call", "stream-ended", "supervisor-call"], "done arrived before the review's model call was issued");
	assert.equal(note.type, "supervisor");
	assert.equal(note.turnId, turnId);
	assert.equal(note.verdict, "reviewed");
	assert.equal(note.model, "faux/scripted");
	assert.equal(note.effort, "high");
	assert.deepEqual(note.counts, { blocker: 1, concern: 1, note: 0, fixes: 0 });
	assert.deepEqual(note.fixes, [], "a verdict without fixes carries none");
	assert.equal(note.autofix, undefined);
	assert.ok(!f.commands.some(command => command.name === "inspect_studio" && command.args.scope === "actions"), "no action index, no schema read");
	assert.deepEqual(note.items, VERDICT.items);
	assert.deepEqual(note.issues, VERDICT.issues);
	assert.equal(note.summary, VERDICT.summary);
	assert.ok(Number.isInteger(note.elapsedMs) && note.elapsedMs >= 0);
	const review = f.modelCalls.find(call => call.supervisor);
	assert.equal(review.options.reasoning, "high", "the review runs at reasoning effort high");
	const parts = review.context.messages.find(message => message.role === "user").content;
	const digest = parts.find(part => part.type === "text").text;
	assert.ok(digest.includes("의자") && digest.includes("receipt-1") && digest.includes("\"shotId\":\"shot-2\""), "the digest carries the request, the receipt and the geometry facts");
	assert.equal(parts.filter(part => part.type === "image").length, 3, "current frame, top view and the created shot's frame");
	const verify = f.commands.find(command => command.name === "verify_result");
	assert.deepEqual(verify.args.args, { targets: ["shot-2"], checks: ["framing"] }, "geometry is read for the shots the turn touched");
	assert.deepEqual(Object.keys(verify.args).sort(), ["args", "commandId", "expectedRevision", "host", "name"], "the review uses the turn's admission envelope");
	assert.deepEqual(f.commands.filter(command => command.name === "operate_studio").map(command => command.args.args.frame), [72, 12], "the created shot is shown at its start frame and the playhead restored");
	assert.ok(f.commands.some(command => command.name === "capture_framing_png" && command.args.output?.width === 1280), "an oversized frame is re-rendered 1280 px wide");
	const replay = await (await f.get(`/agent/turn/${encodeURIComponent(turnId)}/events?after=0`, cookie)).text();
	const replayed = frameTypes([...replay.matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1])));
	assert.ok(replayed.indexOf("supervisor") > replayed.indexOf("done") && replayed.indexOf("done") >= 0, "the events replay carries the note after done");
	assert.equal(replayed.filter(type => type === "supervisor").length, 1, "an explicit supervisor:true turn carries exactly one supervisor event");
	assert.equal(f.modelCalls.filter(call => call.supervisor).length, 1, "exactly one review call");
	const again = await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie);
	assert.equal(again.status, 200, "a finished review answers at once");
	assert.equal((await again.json()).eventSeq, note.eventSeq);
	assert.equal((await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, "studio_owner=intruder")).status, 403, "a wrong owner is refused");
	assert.equal((await f.get(`/agent/turn/${encodeURIComponent(randomUUID())}/supervisor`, cookie)).status, 404, "an unknown turn is 404");
	await f.close();
	console.log("PASS an authored turn ends at done first; the review then lands as one note on the route and in the replay");
}

// The switch: the stream is the same, nothing is reviewed and no provider call is spent.
{
	process.env.COZYCLAY_SUPERVISOR = "off";
	const f = await fixture();
	f.gate.resolve();
	const { turnId, cookie, frames } = await f.turn(undefined, { supervisor: true });
	assert.deepEqual(frameTypes(frames), authoredTypes, "the turn stream is identical with the review off");
	const response = await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie);
	assert.equal(response.status, 204);
	assert.equal(f.modelCalls.length, 2, "no extra provider call");
	assert.ok(!f.commands.some(command => ["verify_result", "capture_framing_png", "capture_plan_png"].includes(command.name)), "no editor reads for a review");
	delete process.env.COZYCLAY_SUPERVISOR;
	await f.close();
	console.log("PASS COZYCLAY_SUPERVISOR=off answers 204 and spends no provider call");
}

// Off by default: a turn that omits the field is not reviewed, from any surface.
{
	const f = await fixture();
	f.gate.resolve();
	const { turnId, cookie, frames } = await f.turn();
	assert.deepEqual(frameTypes(frames), authoredTypes, "the turn stream is identical without the field");
	assert.equal((await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie)).status, 204, "no field, no review");
	assert.equal(f.modelCalls.length, 2, "no extra provider call for a turn that did not ask");
	assert.ok(!f.commands.some(command => ["verify_result", "capture_framing_png", "capture_plan_png"].includes(command.name)), "no editor reads for a review");
	const replay = await (await f.get(`/agent/turn/${encodeURIComponent(turnId)}/events?after=0`, cookie)).text();
	assert.ok(!replay.includes('"type":"supervisor"'), "the replay carries no supervisor event");
	await f.close();
	console.log("PASS a turn without the supervisor field is not reviewed (default off)");
}

// The author's own switch: a turn sent with supervisor:false is accepted and
// skips the review exactly like the env switch.
{
	const f = await fixture();
	f.gate.resolve();
	const { turnId, cookie, frames } = await f.turn(undefined, { supervisor: false });
	assert.deepEqual(frameTypes(frames), authoredTypes, "the turn stream is identical with the per-turn switch off");
	assert.equal((await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie)).status, 204);
	assert.equal(f.modelCalls.length, 2, "no extra provider call for a turn that opted out");
	assert.ok(!f.commands.some(command => ["verify_result", "capture_framing_png", "capture_plan_png"].includes(command.name)), "no editor reads for a review");
	await f.close();
	console.log("PASS a turn sent with supervisor:false answers 204 and spends no provider call");
}

// A read-only turn is not reviewed.
{
	const f = await fixture({ readOnly: true });
	f.gate.resolve();
	const { turnId, cookie } = await f.turn("what is in the scene?", { supervisor: true });
	assert.equal((await f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie)).status, 204);
	assert.equal(f.modelCalls.filter(call => call.supervisor).length, 0);
	await f.close();
	console.log("PASS a read-only turn answers 204 without a review");
}

// A reply that is not a verdict is reported as unavailable, never as a review.
{
	const f = await fixture({ supervisorReply: "Looks good to me!" });
	f.gate.resolve();
	const { turnId, cookie } = await f.turn(undefined, { supervisor: true });
	const response = await bounded(f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie), "supervisor long-poll");
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.equal(note.verdict, "unavailable");
	assert.equal(typeof note.reason, "string");
	assert.deepEqual(note.counts, { blocker: 0, concern: 0, note: 0, fixes: 0 });
	await f.close();
	console.log("PASS a garbage verdict becomes an unavailable note");
}

// A verdict with fixes: the reviewer sees the action index and the pre-selected
// schemas, the valid fix lands on the note, the unknown one is dropped, and the
// autofix switch only marks the note.
{
	process.env.COZYCLAY_SUPERVISOR_AUTOFIX = "blocker";
	process.env.COZYCLAY_MOTION_ENGINE = "old"; // the index here holds character.setPose, which the lowvis engine hides (agent-view.mjs; next block)
	const fix = { action: "object.update", args: { id: "chair", position: { x: -1.4, y: 0, z: 0 } } };
	const reply = { ...VERDICT, issues: [{ ...VERDICT.issues[0], kind: "spatial", fix }, { ...VERDICT.issues[1], fix: { action: "chair.teleport", args: { id: "chair" } } }] };
	const f = await fixture({ supervisorReply: `Verdict:\n${JSON.stringify(reply)}`, actionIndex: ACTION_INDEX });
	f.gate.resolve();
	const { turnId, cookie } = await f.turn(undefined, { supervisor: true });
	const response = await bounded(f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie), "supervisor long-poll");
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.equal(note.verdict, "reviewed");
	assert.equal(note.fixes.length, 1);
	assert.deepEqual(note.fixes[0], { issueIndex: 0, severity: "blocker", ...fix });
	assert.equal(note.counts.fixes, 1);
	assert.deepEqual(note.issues[0].fix, fix);
	assert.equal(note.issues[1].fix, undefined);
	assert.deepEqual(note.droppedFixes, [{ issueIndex: 1, action: "chair.teleport", reason: "unknown action" }]);
	assert.deepEqual(note.autofix, { eligible: true, severity: "blocker" }, "a blocker fix under COZYCLAY_SUPERVISOR_AUTOFIX=blocker is marked eligible");
	assert.equal(f.modelCalls.filter(call => !call.supervisor).length, 2, "the sidecar starts no turn of its own");
	const schemaRead = f.commands.find(command => command.name === "inspect_studio" && command.args.scope === "actions");
	assert.deepEqual(schemaRead.args.ids, ["character.setPose", "shot.frame", "object.update"], "only the pre-selected actions the index declares are read");
	const digest = f.modelCalls.find(call => call.supervisor).context.messages.find(message => message.role === "user").content.find(part => part.type === "text").text;
	assert.ok(digest.includes("\nACTIONS: ") && digest.includes("\nACTION SCHEMAS: "), "the digest carries ACTIONS and ACTION SCHEMAS");
	for (const id of ["character.setPose", "shot.frame", "object.update", "scene.rename"]) assert.ok(digest.includes(id), `the digest lists ${id}`);
	assert.ok(digest.includes("\"required\":[\"characterId\",\"posture\"]"), "the digest carries the pre-selected schemas");
	delete process.env.COZYCLAY_SUPERVISOR_AUTOFIX;
	delete process.env.COZYCLAY_MOTION_ENGINE;
	await f.close();
	console.log("PASS a verdict's valid fix lands on the note, an unknown one is dropped, and autofix only marks the note");
}

// Under the lowvis engine (the default) the reviewer sees the agent's own action view: a hidden body-motion action
// (character.setPose) is neither read nor listed, the others are.
{
	const reply = { ...VERDICT, issues: [{ ...VERDICT.issues[0], kind: "spatial", fix: { action: "object.update", args: { id: "chair", position: { x: -1.4, y: 0, z: 0 } } } }] };
	const f = await fixture({ supervisorReply: `Verdict:\n${JSON.stringify(reply)}`, actionIndex: ACTION_INDEX });
	f.gate.resolve();
	const { turnId, cookie } = await f.turn(undefined, { supervisor: true });
	const response = await bounded(f.get(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`, cookie), "supervisor long-poll");
	assert.equal(response.status, 200);
	const schemaRead = f.commands.find(command => command.name === "inspect_studio" && command.args.scope === "actions");
	assert.deepEqual(schemaRead.args.ids, ["shot.frame", "object.update"], "the hidden character.setPose is not read");
	const digest = f.modelCalls.find(call => call.supervisor).context.messages.find(message => message.role === "user").content.find(part => part.type === "text").text;
	assert.ok(!digest.includes("character.setPose"), "the digest does not list the hidden action");
	for (const id of ["shot.frame", "object.update", "scene.rename"]) assert.ok(digest.includes(id), `the digest lists ${id}`);
	await f.close();
	console.log("PASS under the lowvis engine the reviewer's action index is the agent's view, without hidden actions");
}
