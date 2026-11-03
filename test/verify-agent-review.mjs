#!/usr/bin/env node
// The verify -> repair loop of a Studio turn (bin/agent/studio-review.mjs, #1030): the units, then a whole turn through the real route,
// runner and tools with a scripted model and a fake editor.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-review-sessions-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
delete process.env.CLIPROXY_API_KEY; delete process.env.CLIPROXY_BASE_URL; delete process.env.COZYCLAY_AGENT_REVIEW;
const { createTurnReview, reviewContent, reviewedStart, reviewFindings, turnEdits } = await import("../bin/agent/studio-review.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { transcriptFromHistory } = await import("../bin/agent/session-store.mjs");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
const silent = console.warn; console.warn = () => {};

// ---- what a run edited ----
const tool = (callId, result, args = {}, ok = true) => [{ type: "tool.start", callId, name: "run_action", args }, { type: "tool.done", callId, ok, result }];
assert.equal(turnEdits([...tool("a", { revision: 3 }, { scope: "entities" })]).edited, false, "a read edits nothing");
assert.deepEqual(turnEdits(tool("a", { authored: true, affectedIds: ["cube-1"] })).ids, ["cube-1"], "an authored receipt names its ids");
assert.equal(turnEdits(tool("a", { revision: { before: 4, after: 4 } })).edited, false, "a revision that stayed is no edit");
assert.equal(turnEdits(tool("a", { authored: true }, {}, false)).edited, false, "a refused call is no edit");
const scripted = turnEdits(tool("a", { calls: [{ ok: true, revision: { before: 1, after: 2 }, affectedIds: ["cube-2"] }, { ok: false, revision: { before: 2, after: 3 }, affectedIds: ["cube-3"] }] }));
assert.deepEqual([scripted.edited, scripted.ids], [true, ["cube-2"]], "a script's nested edits count, its refused ones do not");
assert.deepEqual(turnEdits(tool("a", { authored: true }, { action: "motion.compile", args: { characterId: "char-a" } })).motionIds, ["char-a"], "a motion action names its character");
assert.equal(turnEdits(tool("a", { authored: true }, { action: "stage.set" })).stage, true, "a stage action asks for the lighting check");
const nested = turnEdits(tool("a", { calls: [{ ok: true, action: "motion.compile", authored: true, affectedIds: ["char-b"] }, { ok: true, action: "stage.set", authored: true, affectedIds: [] }] }, { code: "..." }));
assert.deepEqual([nested.motionIds, nested.stage], [["char-b"], true], "a script's nested actions ask for their checks too");
assert.deepEqual(turnEdits(tool("a", { calls: [{ ok: false, action: "motion.compile", authored: true, affectedIds: ["char-b"] }] })).motionIds, [], "a refused nested action asks for nothing");

// ---- failing numbers ----
assert.deepEqual(reviewFindings({}), [], "nothing measured, nothing to say");
assert.deepEqual(reviewFindings({ placement: { checks: { placement: { overlapIds: [], unsupportedIds: [] } } }, framing: { checks: { framing: { issueFrames: [] } } }, motion: [{ id: "a", qa: { total: 0 } }] }), [], "what passed is not listed");
const lines = reviewFindings({ placement: { checks: { placement: { overlapIds: ["a", "b"], maximumFootprintOverlapM: 0.2, unsupportedIds: ["c"] } } }, framing: { checks: { framing: { issueFrames: [{ frame: 40, codes: ["OCCLUDED"] }] } } },
	motion: [{ id: "hero", qa: { total: 31, groups: [{ kind: "SLIDE", subject: "foot_l", count: 31 }] } }], lighting: { checks: { lighting: { clippedPct: 40, crushedPct: 1 } } } });
assert.deepEqual(lines, ["placement: footprints overlap for a, b (deepest 0.2 m)", "placement: floating over 1 cm: c", "framing: OCCLUDED at frame 40", "motion hero: QA 31 frame issues: SLIDE foot_l x31", "lighting: 40% of the frame clipped"]);
assert.deepEqual(reviewFindings({ framing: { checks: { framing: { occluded: true } } } }), ["framing: occluded at the current frame"], "a one-frame framing check counts too");

// ---- the message ----
const passed = reviewContent({ findings: [], relations: ["a ON b"], images: [{ type: "image", data: "x", mimeType: "image/png" }], revision: 9 });
assert.match(passed[0].text, /^Studio frame observation\b/, "the label a transcript does not show as the user's words");
assert.match(passed[0].text, /checks that ran passed[\s\S]*a ON b/);
assert.equal(passed[1].type, "image");
assert.match(reviewContent({ findings: ["placement: x"] })[0].text, /checks failed:\n- placement: x\n[\s\S]*say why in one line/);

// ---- the checks ----
const asked = [], png = name => ({ dataUrl: `data:image/png;base64,${name}` });
const hubOf = over => ({ async command(name) { asked.push(name); if (over?.[name]) return over[name](); if (name === "inspect_studio") return { revision: { scene: 7 }, relations: ["r"], characters: [{ id: "hero" }], camera: {} }; return png(name); } });
const invoked = [], invoke = async (name, args) => { invoked.push([name, args]); return name === "run_action" ? { output: { qa: { total: 2, groups: [] } } } : { checks: { placement: { overlapIds: ["cube-1"] }, framing: { issueFrames: [] } } }; };
const seen = await createTurnReview({ invoke, hub: hubOf(), workspaceHandle: "w" })({ edited: true, ids: ["cube-1"], motionIds: ["hero"], stage: false });
assert.deepEqual(invoked.map(([, a]) => a.checks?.[0] ?? a.action), ["placement", "framing", "motion.qa"], "placement of what changed, framing of the cast, QA of the moved character");
assert.deepEqual(invoked[0][1].targets, ["cube-1"]); assert.deepEqual(invoked[1][1].targets, ["hero"]); assert.equal(invoked[1][1].range, "whole_clip");
assert.equal(seen.images, 2, "the shot frame and the top view");
assert.deepEqual(seen.content.slice(1).map(part => part.data), ["capture_framing_png", "capture_plan_png"]);
assert.ok(seen.findings.some(line => line.includes("cube-1")) && seen.findings.some(line => line.startsWith("motion hero")));
// the pictures go through verify_result when they can, so the panel's progress card shows them
const shown = [], viaVerify = await createTurnReview({ invoke: async (name, args) => { if (args.visual) shown.push(args.visual); return { receiptId: "r", revision: 3, checks: {}, visualRefs: args.visual ? [{ imageId: `id-${args.visual}` }] : [] }; }, resolveImage: async id => png(id), hub: hubOf(), workspaceHandle: "w" })({ edited: true, ids: ["cube-1"], motionIds: [], stage: false });
assert.deepEqual([shown, viaVerify.content.slice(1).map(p => p.data)], [["frame", "plan"], ["id-frame", "id-plan"]]);
const targeted = [];
await createTurnReview({ invoke: async (name, args) => { targeted.push(args.targets); return {}; }, resolveImage: async () => null, hub: hubOf({ inspect_studio: () => ({ relations: [], entityIds: ["cube-1", "hero"], characters: [{ id: "hero" }], camera: {} }) }), workspaceHandle: "w" })({ edited: true, ids: ["shot-3", "cube-1", "camera-key-4"], motionIds: [], stage: false });
assert.deepEqual(targeted[0], ["cube-1"], "shots and camera keys are not sent as targets");
const framedOnly = [];
await createTurnReview({ invoke: async (name, args) => { framedOnly.push(args); return {}; }, resolveImage: async () => null, hub: hubOf({ inspect_studio: () => ({ relations: [], entityIds: ["hero"], characters: [{ id: "hero" }], camera: {} }) }), workspaceHandle: "w" })({ edited: true, ids: ["shot-3"], motionIds: [], stage: false });
assert.ok(!framedOnly.some(a => a.targets.includes("shot-3")) && framedOnly.some(a => a.visual === "frame" && a.targets[0] === "hero"), "a shot-only edit still looks through the cast");
const broken = await createTurnReview({ invoke: async () => { throw new Error("refused"); }, hub: hubOf({ capture_framing_png() { throw new Error("no editor"); } }), workspaceHandle: "w" })({ edited: true, ids: ["x"], motionIds: [], stage: true });
assert.deepEqual([broken.findings, broken.images], [[], 1], "a check or capture that cannot run is left out, and the review still answers");

const gone = await createTurnReview({ invoke: async () => { throw new Error("refused"); }, hub: { async command() { throw new Error("no editor"); } }, workspaceHandle: "w" })({ edited: true, ids: ["x"], motionIds: [], stage: false });
assert.equal(gone, null, "an editor that went away gets no review message");

// ---- a task's run: only what its scope names, plus what it edited ----
const cast = hubOf({ inspect_studio: () => ({ revision: { scene: 7 }, relations: [], entityIds: ["mine", "theirs", "cup-1"], characters: [{ id: "mine" }, { id: "theirs" }], camera: {} }) });
const scopedArgs = [], scopedInvoke = async (name, args) => { scopedArgs.push(args); return { checks: { placement: { overlapIds: ["theirs", "lamp-2"], unsupportedIds: ["theirs", "cup-1"] }, framing: { issueFrames: [{ frame: 3, codes: ["CLIPPED"] }] }, lighting: {} } }; };
const scoped = await createTurnReview({ invoke: scopedInvoke, hub: cast, workspaceHandle: "w", scope: ["character:mine", "shot:s1"] })({ edited: true, ids: ["cup-1"], motionIds: ["mine"], stage: true });
const framed = scopedArgs.find(a => a.checks?.[0] === "framing"), lit = scopedArgs.find(a => a.checks?.[0] === "lighting");
assert.deepEqual([framed.targets, lit.targets], [["mine"], ["mine"]], "framing and lighting look only at the task's own characters, not another task's");
assert.deepEqual(scopedArgs.filter(a => a.action === "motion.qa").map(a => a.args.characterId), ["mine"], "motion QA of the character the task animated");
assert.ok(!scoped.findings.some(line => line.includes("theirs") || line.includes("lamp-2")), `a finding about another task's ids is dropped: ${scoped.findings}`);
assert.ok(scoped.findings.includes("placement: floating over 1 cm: cup-1"), "an id the run edited stays in");
assert.deepEqual(reviewFindings({ placement: { checks: { placement: { overlapIds: ["cup-1", "theirs"] } } }, owned: new Set(["cup-1"]) }), ["placement: footprints overlap for cup-1, theirs (deepest ? m)"], "an overlap that touches the task's id stays whole");
assert.deepEqual(reviewFindings({ motion: [{ id: "theirs", qa: { total: 4, groups: [] } }], owned: new Set(["mine"]) }), [], "another character's motion QA is dropped");
const mainArgs = [];
await createTurnReview({ invoke: async (name, args) => { mainArgs.push(args); return {}; }, hub: cast, workspaceHandle: "w" })({ edited: true, ids: ["cup-1"], motionIds: [], stage: false });
assert.deepEqual(mainArgs.find(a => a.checks?.[0] === "framing").targets, ["mine", "theirs"], "a turn that is not a task still frames the whole cast");

// ---- the loop ----
const edit = id => [{ type: "tool.start", callId: id, name: "arrange_objects", args: {} }, { type: "tool.done", callId: id, ok: true, result: { authored: true, affectedIds: ["cube-1"] } }];
const run = async (runs, { review = async () => ({ findings: [], content: [{ type: "text", text: "look" }], images: 0 }), signal } = {}) => {
	const inputs = [], reviews = [], frames = [];
	const start = async function* (input) { inputs.push(input); yield* runs[inputs.length - 1] ?? [{ type: "done" }]; };
	for await (const frame of reviewedStart({ start, signal, now: () => 0, review: async e => { reviews.push(e); return review(e); } })({ text: "go", attachments: ["a"], frameObservation: { data: "f" } })) frames.push(frame);
	return { inputs, reviews, frames, done: frames.filter(f => f.type === "done") };
};
const quiet = await run([[{ type: "text.delta", text: "hi" }, { type: "done" }]]);
assert.deepEqual([quiet.inputs.length, quiet.reviews.length, quiet.done.length], [1, 0, 1], "a turn that edited nothing is not reviewed");
const once1 = await run([[...edit("a"), { type: "done", usage: { input: 2 }, cost: 1 }], [{ type: "text.delta", text: "fine" }, { type: "done", usage: { input: 3 }, cost: 2 }]]);
assert.deepEqual([once1.inputs.length, once1.reviews.length, once1.done.length], [2, 1, 1], "an edit gets one review, and the turn one done frame");
assert.deepEqual([once1.done[0].usage.input, once1.done[0].cost], [5, 3], "the done frame adds up both runs");
assert.equal(once1.frames.at(-1).type, "done", "done comes last");
assert.deepEqual(once1.inputs[1].review, [{ type: "text", text: "look" }]);
assert.deepEqual([once1.inputs[1].text, once1.inputs[1].attachments, once1.inputs[1].frameObservation], ["", [], undefined], "the review does not resend the user's message");
assert.deepEqual(once1.frames.filter(f => f.callId === "review-1").map(f => f.type), ["tool.start", "tool.done"], "the review shows as a tool row");
const repaired = await run([[...edit("a"), { type: "done" }], [...edit("b"), { type: "done" }], [{ type: "done" }]]);
assert.equal(repaired.reviews.length, 2, "a repair is checked again");
const forever = await run(Array.from({ length: 9 }, (_, i) => [...edit(`e${i}`), { type: "done" }]));
assert.deepEqual([forever.reviews.length, forever.inputs.length], [3, 4], "at most 3 reviews a turn");
const failed = await run([[...edit("a"), { type: "error", code: "x" }, { type: "done" }]]);
assert.equal(failed.reviews.length, 0, "a failed run is not reviewed");
const stopped = new AbortController(); stopped.abort();
assert.equal((await run([[...edit("a"), { type: "done" }]], { signal: stopped.signal })).reviews.length, 0, "a stopped run is not reviewed");
const noEditor = await run([[...edit("a"), { type: "done" }]], { review: async () => null });
assert.deepEqual([noEditor.inputs.length, noEditor.done.length], [1, 1], "no review to send ends the turn");
const toolFailed = await run([[...edit("a"), { type: "tool.start", callId: "b", name: "arrange_objects" }, { type: "tool.done", callId: "b", ok: false, error: "INVALID_ARGUMENT: x" }, { type: "done" }], [{ type: "done" }]]);
assert.equal(toolFailed.reviews.length, 1, "a refused call the model has answered does not hide its earlier edits from the review");
const threw = await run([[...edit("a"), { type: "done" }]], { review: async () => { throw new Error("gone"); } });
assert.deepEqual([threw.inputs.length, threw.done.length, threw.frames.find(f => f.type === "tool.done" && f.callId === "review-1").ok], [1, 1, false], "a review that cannot run ends the turn cleanly");

assert.equal(once1.frames.find(f => f.type === "tool.start" && f.callId === "review-1").review, true, "the row says it is not the model's call");

// ---- what the panel shows ----
const { stepResult } = await import("../src/workflow/agent-turn.js");
const row = result => stepResult({ kind: "tool", name: "verify_result", status: "done", args: { review: 1 }, result });
assert.equal(row({ findings: [], images: 2 }), "checks passed · looked at the frame and top view");
assert.equal(row({ findings: ["placement: x", "framing: y"], images: 0 }), "2 checks failed: placement: x");

// ---- a whole turn: real route, runner and tools ----
const world = { revision: 41 }, hostOf = () => contextFixture().host, commands = [];
const context = () => { const c = contextFixture(); c.revision = { scene: world.revision, physics: 9, view: 18 }; return c; };
const hub = {
	async command(name, payload) {
		commands.push(name);
		if (name === "read_studio_context") return context();
		if (name === "inspect_studio") return { revision: context().revision, host: hostOf(), relations: ["Lamp#cube-2 ON Table#cube-5"], characters: [{ id: "char-alex" }], camera: {}, entities: [], total: 0 };
		if (name === "capture_framing_png" || name === "capture_plan_png") return png("AAAA");
		if (name === "verify_result") return { receiptId: null, revision: world.revision, evidenceRevision: world.revision, stale: false, ok: true, checks: { coverage: "fixture", placement: { overlapIds: ["char-alex"] } }, visualRefs: [] };
		world.revision += 1;
		return { ok: true, commandId: payload.commandId, receiptId: `receipt-${world.revision}`, host: hostOf(), status: "applied", authored: true, mutated: true, revision: { before: world.revision - 1, after: world.revision }, affectedIds: ["char-alex"], delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `h-${world.revision}`, entries: 1, canUndoDirect: true }, warnings: [] };
	},
	workspaceId: () => hostOf().workspaceId, resolveWorkspace: () => hostOf().workspaceHandle, handleForWorkspaceId: () => hostOf().workspaceHandle, connected: true, workspaceHandles: [hostOf().workspaceHandle],
};
const fake = createFakeModel();
fake.script([{ type: "toolCall", name: "arrange_objects", arguments: { ops: [{ op: "update", id: "char-alex", position: { world: { x: 1, y: 0, z: 0 } } }] } }, [{ type: "text", text: "moved" }], [{ type: "text", text: "overlap is intended" }]]);
fake.fauxProvider.review = true;
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { listModels: async () => ["gpt-5"], parseQuotaHeaders: () => ({}) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, studioRuntime: { readContext: async () => context() }, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ ...envelopeFixture(), context: context(), model: "faux/scripted", turnId: "00000000-0000-4000-8000-000000000301", text: "move alex" }) });
const body = await response.text();
server.close();
assert.equal(response.status, 200, body.slice(0, 300));
assert.ok(!body.includes('"type":"error"'), body.slice(0, 500));
assert.equal((body.match(/"type":"done"/g) ?? []).length, 1, "the client sees one done frame");
assert.equal(fake.calls.length, 3, "edit, its answer, and the answer to the review");
const first = fake.calls[0].messages.filter(m => m.role === "user").flatMap(m => m.content).find(p => p.text?.startsWith("<studio-context>"));
assert.match(first.text, /"relations":\{"rows":\["Lamp#cube-2 ON Table#cube-5"\]/, "the turn's context carries the relation rows");
const last = fake.calls[2].messages.at(-1);
assert.equal(last.role, "user");
assert.match(last.content[0].text, /^Studio frame observation[\s\S]*placement: footprints overlap for char-alex[\s\S]*Lamp#cube-2 ON Table#cube-5/, "the model is told the failing number and the relations");
assert.deepEqual(last.content.slice(1).map(p => p.type), ["image", "image"], "and is shown the frame and the plan");
assert.ok(commands.includes("capture_framing_png") && commands.includes("capture_plan_png") && commands.includes("verify_result"));
assert.equal(transcriptFromHistory(fake.calls[2].messages).filter(e => e.kind === "user" && e.text?.includes("footprints")).length, 0, "the review is never shown as the user's words");
console.warn = silent;
rmSync(sessionDir, { recursive: true, force: true });
console.log("PASS studio turn review");
process.exit(0);
