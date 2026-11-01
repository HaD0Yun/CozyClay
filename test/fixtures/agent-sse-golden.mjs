// Golden SSE parity fixtures, recorded from the CURRENT agent loops.
// Scenario W is the exact 4-call Workflow script test/verify-agent-routes.mjs
// uses; scenario S drives the frozen Studio envelope through inspect_studio →
// patch_elements → verify_result → final text. normaliseFrame replaces the
// nondeterministic bits (timings, telemetry ids, turn/call ids) with stable
// placeholders while keeping eventSeq — it is part of the replay contract.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../../bin/agent/agent-routes.mjs";
import { createFakeModel } from "./fake-model.mjs";
import { contextFixture, envelopeFixture, receiptFixture } from "../verify-studio-agent-protocol.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function normaliseFrame(frame) {
	const value = JSON.parse(JSON.stringify(frame));
	if (Object.hasOwn(value, "elapsedMs")) value.elapsedMs = "<ms>";
	if (Object.hasOwn(value, "telemetry_id")) value.telemetry_id = "<telemetry>";
	if (Object.hasOwn(value, "turn_id")) value.turn_id = "<turn>";
	if (Object.hasOwn(value, "turnId")) value.turnId = "<turn>";
	if (Object.hasOwn(value, "callId")) value.callId = "<call>";
	if (value.props && Object.hasOwn(value.props, "turn_id")) value.props.turn_id = "<turn>";
	if (value.props && Object.hasOwn(value.props, "duration_bucket")) value.props.duration_bucket = "<bucket>";
	// Token counts are the faux provider's estimate of the prompt text, which
	// differs per caller; the usage shape and the request count are pinned.
	if (value.type === "done" && value.usage) for (const key of ["input", "output", "cacheRead", "cacheWrite"]) value.usage[key] = Number.isFinite(value.usage[key]) ? "<tokens>" : value.usage[key];
	if (value.type === "context" && Number.isFinite(value.tokens)) value.tokens = "<tokens>";
	return value;
}

async function collectTurn(handlerArgs, body) {
	let server;
	const handler = createAgentHandler({ ...handlerArgs, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const text = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) }).then((response) => response.text());
	server.close();
	return [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
}

// Workflow: text "hello" → describe_workflow → add_workflow_node → run_workflow
// → text " done" — the exact 4-call script of test/verify-agent-routes.mjs.
async function recordWorkflow() {
	const fakeLive = { command: async (name) => name === "capture_framing_png" ? { dataUrl: png, width: 1920, height: 1080 } : { assetId: "a1", objectId: "o1" } };
	const fakeModel = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "GPT-6 Astra" });
	fakeModel.script([
		{ type: "text", text: "hello" },
		{ type: "toolCall", id: "c1", name: "describe_workflow", arguments: {} },
		{ type: "toolCall", id: "c2", name: "add_workflow_node", arguments: { type: "image", model: "image-generation", data: { prompt: "render" } } },
		{ type: "text", text: " done" },
		{ type: "toolCall", id: "c3", name: "run_workflow", arguments: {} },
		{ type: "text", text: " done" },
	]);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.e30`;
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const codex = { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }) };
	const turnId = "a".repeat(32);
	return collectTurn(
		{ auth, codex, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, liveHub: fakeLive },
		{ sessionId: "golden-w", text: "Give me a wide two-shot", model: "gpt-6-astra", attachFrame: false, turn_id: turnId },
	);
}

// Studio: the frozen envelope → inspect_studio → patch_elements (stage
// keyLight.warmth 0.3) → verify_result (returns a dataUrl) → final text.
async function recordStudio() {
	const fakeLive = {
		command: async (name) => {
			if (name === "patch_elements") return receiptFixture();
			if (name === "verify_result") return { ok: true, receiptId: "receipt-1", revision: { scene: 42, physics: 9, view: 18 }, visualRefs: [{ imageId: "capture-1" }] };
			if (name === "resolve_studio_image") return { imageId: "capture-1", dataUrl: png, revision: { scene: 42 }, receiptId: "receipt-1" };
			return { ok: true, status: "applied", receiptId: "receipt-1", revision: { before: 41, after: 42 } };
		},
		workspaceId: () => "tab-7",
		resolveWorkspace: () => "handle-12",
		handleForWorkspaceId: () => "handle-12",
		connected: true,
		workspaceHandles: ["handle-12"],
	};
	const fakeModel = createFakeModel();
	fakeModel.script([
		{ type: "toolCall", id: "s1", name: "inspect_studio", arguments: { section: "selection" } },
		{ type: "toolCall", id: "s2", name: "patch_elements", arguments: { ops: [{ target: { kind: "stage" }, set: { "keyLight.warmth": 0.3 } }] } },
		{ type: "toolCall", id: "s3", name: "verify_result", arguments: { targets: ["char-alex"], checks: ["framing"], visual: "frame" } },
		{ type: "text", text: "done" },
	]);
	const auth = { getAccessToken: async () => "token" };
	const codex = { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }) };
	return collectTurn(
		{ auth, codex, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() } },
		{ ...envelopeFixture(), model: "faux/scripted" },
	);
}

async function recordStoryboard() {
	const fakeLive = {
		command: async (name) => ({ ok: true, commandId: `${name}-command`, receiptId: `${name}-receipt`, status: "applied", authored: true, action: name, summary: `Applied ${name}.`, revision: { before: 41, after: 42 }, affectedIds: [], delta: [], checks: {}, undo: { historyEntryId: `${name}-history`, entries: 1, canUndoDirect: true }, warnings: [], ops: [] }),
		workspaceId: () => "tab-7",
		resolveWorkspace: () => "handle-12",
		handleForWorkspaceId: () => "handle-12",
		connected: true,
		workspaceHandles: ["handle-12"],
	};
	const fakeModel = createFakeModel();
	fakeModel.script([
		{ type: "toolCall", id: "b1", name: "run_action", arguments: { action: "shot.createStill", args: { caption: "Two people at a table" } } },
		{ type: "toolCall", id: "b2", name: "run_action", arguments: { action: "character.add", args: { character: { id: "person-a", model: "proxy-figure", posture: "sit", x: -1, z: 0 } } } },
		{ type: "toolCall", id: "b3", name: "run_action", arguments: { action: "character.add", args: { character: { id: "person-b", model: "proxy-figure", posture: "sit", x: 1, z: 0 } } } },
		{ type: "toolCall", id: "b4", name: "frame_shot", arguments: { subjectIds: ["person-a"], framing: { intent: { size: "medium shot", view: "front", level: "eye", side: "right" } } } },
		{ type: "toolCall", id: "b5", name: "verify_result", arguments: { targets: ["person-a", "person-b"], checks: ["placement", "framing"] } },
		{ type: "text", text: "Panel created and verified." },
	]);
	const auth = { getAccessToken: async () => "token" };
	const codex = { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }) };
	const base = contextFixture();
	const storyboard = { ...base, scene: { ...base.scene, previsMode: "storyboard" }, capabilities: { ...base.capabilities, storyboard: true } };
	return collectTurn(
		{ auth, codex, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, liveHub: fakeLive, studioRuntime: { readContext: async () => storyboard } },
		{ ...envelopeFixture(), context: storyboard, text: "two people at a table", model: "faux/scripted" },
	);
}

export async function recordGolden() {
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-sse-golden-"));
	const W = (await recordWorkflow()).map(normaliseFrame);
	const S = (await recordStudio()).map(normaliseFrame);
	const B = (await recordStoryboard()).map(normaliseFrame);
	return { W, S, B };
}
