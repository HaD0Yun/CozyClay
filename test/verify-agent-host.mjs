#!/usr/bin/env node
// Host contract for the shared Agent chat (#292).
//
// test/verify-agent-panel.mjs pins the dock's source/layout contract. This
// suite drives the ACTUAL transport and chat store: real SSE bytes through
// createHttpTransport, the frozen task-1 Studio envelope/receipt validators,
// job progress, reconnect-by-cursor, acknowledged image actions and the
// explicit acceptance of an unverified motion candidate.
//
//   node test/verify-agent-host.mjs --case embedded-session-and-receipts
//   node test/verify-agent-host.mjs --case failed-action-and-reconnect
import { readFileSync } from "node:fs";
// Namespace import on purpose: this suite must still run, and fail for the
// behaviour it checks, against a client that has not grown the host API yet.
import * as client from "../src/workflow/agent-client.js";
import {
	isUuid,
	validateReceipt,
	validateStudioStopEnvelope,
	validateStudioTurnEnvelope,
} from "../src/studio-agent-protocol.js";

const CASES = ["embedded-session-and-receipts", "failed-action-and-reconnect"];
const index = process.argv.indexOf("--case");
const requested = index === -1 ? null : process.argv[index + 1];
// No --case runs every case (the suite runner takes no arguments); an unknown
// case is an error, never a silent empty pass.
if (index !== -1 && !CASES.includes(requested)) {
	console.error(`usage: node test/verify-agent-host.mjs [--case <${CASES.join("|")}>]`);
	process.exit(2);
}
const selectedCases = requested ? [requested] : CASES;
const selected = requested ?? CASES.join(" + ");
const runs = (name) => selectedCases.includes(name);

const panelSource = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
const panelCss = readFileSync(new URL("../src/workflow/agent-panel.css", import.meta.url), "utf8");

const { createHttpTransport } = client;
const createStudioSessionId = (...args) => {
	if (typeof client.createStudioSessionId !== "function") throw new Error("agent-client.js exposes no createStudioSessionId(); the chat has no UUID session identity");
	return client.createStudioSessionId(...args);
};
const createAgentChatStore = (options) => {
	if (typeof client.createAgentChatStore !== "function") throw new Error("agent-client.js exposes no createAgentChatStore(); the panel still owns chat/session/job state privately");
	return client.createAgentChatStore(options);
};

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
async function group(name, run) {
	try {
		await run();
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} threw — ${error?.stack || error}`);
	}
}

// --- fixtures ---------------------------------------------------------------

const HOST = { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" };

function studioContext(sceneRevision = 41) {
	return {
		schema: "studio-context-v1",
		host: { surface: "studio", ...HOST, workspaceHandle: "handle-12" },
		revision: { scene: sceneRevision, physics: 9, view: 18 },
		units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
		scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 1, characterCount: 1 },
		selection: { kind: "character", id: "char-alex" },
		activeCharacterId: "char-alex",
		view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false },
		shot: { id: "shot-1", name: "Wide", range: { startFrame: 0, endFrameExclusive: 144 }, mode: "keys" },
		camera: { position: { x: 0, y: 1.6, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35, sensorId: "sensor-super35", slate: "wide shot" },
		entities: [
			{ id: "char-alex", kind: "character", token: "ct-11", name: "Alex", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1 },
			{ id: "chair", kind: "object", token: "ot-4", name: "Chair", position: { x: 1, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
		],
		entityPage: { returned: 2, total: 2, truncated: false, nextCursor: null },
		shots: [{ id: "shot-1", name: "Wide", range: { startFrame: 0, endFrameExclusive: 144 }, keyCount: 1 }],
		shotsTruncated: false,
		assets: [],
		recentReceipts: [],
		jobs: [],
		capabilities: { profile: "studio-slice-1", tools: ["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "verify_result", "undo_edit"] },
	};
}

const installedReceipt = (overrides = {}) => ({
	ok: true,
	commandId: "cmd-1",
	receiptId: "receipt-1",
	host: { ...HOST },
	status: "installed",
	authored: true,
	revision: { before: 41, after: 42 },
	affectedIds: ["char-alex"],
	delta: [{ id: "char-alex", after: { takeId: "take-9" } }],
	checks: { coverage: "whole-clip" },
	undo: { historyEntryId: "h-42", entries: 1, canUndoDirect: true },
	warnings: [],
	jobId: "job-1",
	artifactId: "artifact-1",
	installed: { characterId: "char-alex", beforeTakeId: "take-old", takeId: "take-9", targetToken: "ct-11", frameCount: 96, fps: 24, durationSeconds: 4, blocks: [{ sourceBeat: 0, startFrame: 0, endFrameExclusive: 96 }], selectionChanged: false },
	verification: { id: "ver-1", status: "verified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 96 }, evaluatedFrames: 96, physicsRevision: 9, limitations: [] },
	...overrides,
});

const unverifiedReceipt = () => installedReceipt({
	receiptId: "receipt-2",
	explicitUnverifiedAcceptance: true,
	verification: { id: "ver-2", status: "unverified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 96 }, evaluatedFrames: 96, physicsRevision: 9, limitations: ["elevated support is not certifiable"] },
});

const failureReceipt = () => ({
	ok: false,
	commandId: "cmd-9",
	host: { ...HOST },
	code: "STALE_TARGET",
	phase: "commit",
	affectedIds: ["char-alex"],
	expectedTargets: [{ ...HOST, targetId: "char-alex", token: "ct-11" }],
	currentTargets: [{ ...HOST, targetId: "char-alex", token: "ct-12" }],
	mutated: false,
	preserved: { authoredState: "unchanged" },
	recovery: { action: "new_intent", retryAllowed: false },
	message: "The target changed while the job was running.",
});

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

/** A real streamed body: chunk list in, ReadableStream-like reader out. */
function sseBody(chunks, { drop = false } = {}) {
	const encoder = new TextEncoder();
	let at = 0;
	return {
		getReader() {
			return {
				async read() {
					if (at < chunks.length) return { value: encoder.encode(chunks[at++]), done: false };
					if (drop) throw new Error("stream dropped before the terminal event");
					return { value: undefined, done: true };
				},
				releaseLock() {},
			};
		},
	};
}

/** A stream that delivers its chunks and then STAYS OPEN until it is released:
 * a turn that is still running is the only state a steer is allowed in. */
function heldSseBody(chunks) {
	const encoder = new TextEncoder();
	let at = 0;
	let release;
	const open = new Promise((resolve) => { release = resolve; });
	return {
		release: () => release(),
		body: {
			getReader() {
				return {
					async read() {
						if (at < chunks.length) return { value: encoder.encode(await chunks[at++]), done: false }; // a chunk may be a promise the test settles
						await open;
						return { value: undefined, done: true };
					},
					releaseLock() {},
				};
			},
		},
	};
}

/** Loopback sidecar double. Every call is recorded with its parsed body. */
function fakeSidecar(routes) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const path = String(url);
		const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
		calls.push({ path, method: init.method || "GET", body });
		const route = Object.keys(routes).find((pattern) => new RegExp(pattern).test(path));
		if (!route) throw new Error(`unrouted sidecar call ${path}`);
		return routes[route]({ path, body, calls });
	};
	return { fetchImpl, calls };
}

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, clone: () => ({ json: async () => payload }) });
const streamResponse = (chunks, options) => ({ ok: true, status: 200, body: sseBody(chunks, options) });

const settled = (store, predicate) => new Promise((resolve, reject) => {
	if (predicate(store.getState())) { resolve(store.getState()); return; }
	const unsubscribe = store.subscribe((state) => {
		if (!predicate(state)) return;
		unsubscribe();
		resolve(state);
	});
	// A store that never reaches the state is a defect, not a slow test.
	setTimeout(() => { unsubscribe(); reject(new Error("store never reached the expected state")); }, 5000).unref?.();
});

const items = (store, kind) => store.getState().items.filter((item) => item.kind === kind);

// --- case: embedded-session-and-receipts ------------------------------------

if (runs("embedded-session-and-receipts")) {
	await group("studio session identity", () => {
		const id = createStudioSessionId();
		expect("the client mints canonical UUID session identities", isUuid(id), String(id));
		expect("every minted session identity is distinct", createStudioSessionId() !== id);
	});

	await group("studio send", async () => {
		let revision = 41;
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "text.delta", text: "Framing the shot." }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(revision) });
		expect("the store opens with a UUID session", isUuid(store.getState().sessionId), store.getState().sessionId);
		await store.send("frame a wide two-shot", { attachFrame: false, model: "gpt-5.1-codex" });
		const body = sidecar.calls.find((call) => call.path === "/agent/turn").body;
		let accepted = true;
		try { validateStudioTurnEnvelope(body); } catch (error) { accepted = false; expect("the Studio turn body satisfies the frozen task-1 envelope", false, `${error.code} ${error.message} ${JSON.stringify(error.details)} body=${JSON.stringify(Object.keys(body || {}))}`); }
		if (accepted) expect("the Studio turn body satisfies the frozen task-1 envelope", true);
		expect("the Studio turn carries a UUID turnId, not an analytics id", isUuid(body?.turnId) && !Object.hasOwn(body || {}, "turn_id"), JSON.stringify(Object.keys(body || {})));
		expect("the Studio turn carries the session UUID", body?.sessionId === store.getState().sessionId);
		revision = 42;
		await store.send("now key it", { attachFrame: false });
		const second = sidecar.calls.filter((call) => call.path === "/agent/turn").at(-1).body;
		expect("context is rebuilt at send, not cached from the first turn", second?.context?.revision?.scene === 42, JSON.stringify(second?.context?.revision));
		expect("each turn mints a fresh turnId", second?.turnId !== body?.turnId && isUuid(second?.turnId));
	});

	await group("pasted images ride with the turn and clear after send (#367)", async () => {
		const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const sidecar = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "text.delta", text: "A chair." }), frame({ type: "done" })]) });
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		const accepted = store.addAttachments([{ dataUrl: png, name: "probe.png" }, { dataUrl: png, name: "second.png" }]);
		expect("pasted pictures are pending until the turn is sent", store.getState().pendingAttachments.length === 2 && accepted.rejected === 0, JSON.stringify(accepted));
		expect("each pending picture is addressable for removal", store.getState().pendingAttachments.every((entry) => typeof entry.id === "string" && entry.id.length > 0));
		store.removeAttachment(store.getState().pendingAttachments[1].id);
		expect("removing a thumbnail drops exactly that picture", store.getState().pendingAttachments.length === 1 && store.getState().pendingAttachments[0].name === "probe.png");
		const overflow = store.addAttachments([{ dataUrl: png }, { dataUrl: png }, { dataUrl: png }, { dataUrl: png }]);
		expect("a fifth picture is refused rather than silently dropped", store.getState().pendingAttachments.length === 4 && overflow.rejected === 1, JSON.stringify(overflow));
		store.clearAttachments();
		store.addAttachments([{ dataUrl: png, name: "probe.png" }]);
		await store.send("what is in the attached image?", { attachFrame: false, model: "gpt-5.1-codex" });
		const body = sidecar.calls.filter((call) => call.path === "/agent/turn").at(-1).body;
		expect("the turn body carries the pasted picture", body?.attachments?.[0]?.dataUrl === png && body.attachments[0].name === "probe.png", JSON.stringify(Object.keys(body?.attachments?.[0] ?? {})));
		let accepts = true;
		try { validateStudioTurnEnvelope(body); } catch (error) { accepts = false; expect("a turn with an attachment still satisfies the frozen envelope", false, `${error.code} ${error.message} ${JSON.stringify(error.details)}`); }
		if (accepts) expect("a turn with an attachment still satisfies the frozen envelope", true);
		expect("the composer is emptied of its attachments after send", store.getState().pendingAttachments.length === 0, JSON.stringify(store.getState().pendingAttachments));
		const bubble = store.getState().items.find((item) => item.kind === "user");
		expect("the user bubble keeps the picture it was sent with", bubble?.attachments?.[0]?.dataUrl === png, JSON.stringify(bubble?.attachments?.length));
		await store.send("and now?", { attachFrame: false, model: "gpt-5.1-codex" });
		const second = sidecar.calls.filter((call) => call.path === "/agent/turn").at(-1).body;
		expect("the next turn does not re-send the same picture", second?.attachments === undefined, JSON.stringify(second?.attachments));

		const dock = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "done" })]) });
		const dockStore = createAgentChatStore({ transport: createHttpTransport({ fetchImpl: dock.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 }), surface: "workflow" });
		await dockStore.send("describe this", { attachments: [{ dataUrl: png, name: "probe.png" }] });
		const dockBody = dock.calls.find((call) => call.path === "/agent/turn").body;
		expect("the Workflow dock sends the same top-level field", dockBody?.attachments?.[0]?.dataUrl === png && !Object.hasOwn(dockBody, "surface"), JSON.stringify(Object.keys(dockBody)));
	});

	await group("synchronous receipts inside tool.done reach the host", async () => {
		// #362: arrange_*/frame_shot/patch_elements/undo_edit return their receipt
		// as the tool result, not as a `receipt` frame — the host highlight must
		// still fire for them, and must not fire for a plain inspect result.
		const applied = { ok: true, commandId: "cmd-p", receiptId: "receipt-p-1", status: "applied", authored: true, revision: { before: 1, after: 2 }, affectedIds: ["char-a"], delta: [], checks: { coverage: "declared-element-readback" }, undo: { historyEntryId: "h-1", entries: 1, canUndoDirect: true }, warnings: [] };
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "tool.start", callId: "c-1", name: "inspect_studio", label: "Read the scene", args: {} }),
				frame({ type: "tool.done", callId: "c-1", ok: true, elapsedMs: 2, result: { context: {}, entities: [] } }),
				frame({ type: "tool.start", callId: "c-2", name: "patch_elements", label: "Edit properties", args: {} }),
				frame({ type: "tool.done", callId: "c-2", ok: true, elapsedMs: 3, result: applied }),
				frame({ type: "done" }),
			]),
		});
		const seen = [];
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(7), onReceipt: (receipt) => seen.push(receipt) });
		await store.send("tint her teal", { attachFrame: false, model: "gpt-5.1-codex" });
		expect("an applied receipt returned by tool.done is handed to the host exactly once", seen.length === 1 && seen[0]?.receiptId === "receipt-p-1", JSON.stringify(seen.map((r) => r?.receiptId)));
		expect("the host receipt carries the affected ids the rows are looked up by", JSON.stringify(seen[0]?.affectedIds) === JSON.stringify(["char-a"]));
		expect("a plain tool result does not masquerade as a receipt", !seen.some((r) => r && r.receiptId === undefined));
		expect("the transcript keeps the tool card and adds no duplicate receipt card", store.getState().items.filter((item) => item.kind === "receipt").length === 0, JSON.stringify(store.getState().items.map((item) => item.kind)));
	});

	await group("the grouped model list (#379)", async () => {
		const catalogue = {
			providers: [
				{ id: "openai-codex", label: "ChatGPT (OpenAI Codex)", signedIn: true, authSource: "chatgpt", models: [{ id: "astra", key: "openai-codex/astra", label: "astra", efforts: ["none", "medium"], defaultEffort: "medium" }] },
				{ id: "anthropic", label: "Anthropic", signedIn: false, authSource: null, models: [{ id: "claude", key: "anthropic/claude", label: "Claude", efforts: ["none"], defaultEffort: "none" }] },
				{ id: "broken", label: "Broken", signedIn: false, authSource: null },
			],
			models: [
				{ id: "openai-codex/astra", key: "openai-codex/astra", label: "astra", efforts: ["none", "medium"], defaultEffort: "medium" },
				{ id: "anthropic/claude", key: "anthropic/claude", label: "Claude", efforts: ["none"], defaultEffort: "none" },
			],
		};
		const grouped = fakeSidecar({ "/agent/models$": () => jsonResponse(catalogue) });
		const list = await createHttpTransport({ fetchImpl: grouped.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 }).models();
		expect("the transport parses the providers beside the flat list", list.providers.length === 2 && list.models.length === 2, JSON.stringify(list.providers.map((provider) => provider.id)));
		expect("a provider entry without models is not offered as a group", !list.providers.some((provider) => provider.id === "broken"));
		expect("the flat list stays key-addressed and keeps its efforts", list.models.every((entry) => entry.id === entry.key && entry.efforts.includes(entry.defaultEffort)));
		expect("each provider keeps the sign-in state the dropdown disables by", list.providers[0].signedIn === true && list.providers[1].signedIn === false);

		const flatOnly = fakeSidecar({ "/agent/models$": () => jsonResponse({ models: [{ id: "legacy", label: "Legacy" }] }) });
		const fallback = await createHttpTransport({ fetchImpl: flatOnly.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 }).models();
		expect("a sidecar that answers with models alone still advertises them", fallback.models.length === 1 && fallback.providers.length === 0, JSON.stringify(fallback));
	});

	await group("steering a running Workflow turn (#379)", async () => {
		// The stream's next chunk is held until the test hands it over: the turn's steer.received for the steer's id.
		let received;
		const later = new Promise((resolve) => { received = resolve; });
		const held = heldSseBody([frame({ type: "text.delta", text: "Framing the shot." }), later]);
		const sidecar = fakeSidecar({
			"/agent/turn$": () => ({ ok: true, status: 200, body: held.body }),
			"/steer$": () => jsonResponse({ ok: true, queued: true }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 });
		const heard = [];
		const store = createAgentChatStore({ transport, surface: "workflow", onSteer: (event) => heard.push(event) });
		const turn = store.send("block the two-shot", { model: "anthropic/claude" });
		await settled(store, (state) => state.items.some((item) => item.kind === "assistant"));
		store.setDraft("actually, make it wider");
		const result = await store.steer(store.getState().draft);
		const steer = sidecar.calls.find((call) => /\/steer$/.test(call.path));
		const turnBody = sidecar.calls.find((call) => call.path === "/agent/turn").body;
		expect("the steer is accepted while the turn is still streaming", result.ok === true && typeof result.id === "string", JSON.stringify(result));
		expect("the steer posts the composer text and its id to the running turn", steer?.method === "POST" && steer.body?.text === "actually, make it wider" && steer.body?.id === result.id, JSON.stringify(steer));
		expect("the steer is keyed by the id the browser minted for THIS turn", steer?.path === `/agent/turn/${turnBody.turn_id}/steer`, `${steer?.path} vs turn_id=${turnBody?.turn_id}`);
		expect("an accepted steer empties the composer but is not shown as said to the model yet", store.getState().draft === "" && store.getState().items.filter((item) => item.kind === "user").length === 1,
			JSON.stringify(store.getState().items.map((item) => item.kind)));
		received(frame({ type: "steer.received", id: result.id }));
		await settled(store, (state) => state.items.filter((item) => item.kind === "user").length === 2);
		expect("once the turn says the model's context took it, the steer joins the transcript", store.getState().items.at(-1)?.steered === true && store.getState().items.at(-1)?.text === "actually, make it wider"
			&& heard.length === 1 && heard[0].type === "steer.received" && heard[0].id === result.id, JSON.stringify(heard));
		expect("steering never starts a second turn", sidecar.calls.filter((call) => call.path === "/agent/turn").length === 1);
		expect("the turn is still streaming after the steer", store.getState().streaming === true);
		held.release();
		await turn;
		expect("the steered turn settles like any other", store.getState().streaming === false);
		const late = await store.steer("one more thing");
		expect("a steer after the turn ended never reaches the sidecar", late.ok === false && late.code === "NO_ACTIVE_TURN"
			&& sidecar.calls.filter((call) => /\/steer$/.test(call.path)).length === 1, JSON.stringify(late));
	});

	await group("dock defaults are unchanged", async () => {
		const sidecar = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "done" })]) });
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "workflow" });
		await store.send("add a node", { attachFrame: false, model: "gpt-5.1" });
		const body = sidecar.calls.find((call) => call.path === "/agent/turn").body;
		expect("the Workflow dock keeps the legacy turn body", ["sessionId", "text", "attachFrame", "model"].every((key) => Object.hasOwn(body, key)) && !Object.hasOwn(body, "surface") && !Object.hasOwn(body, "context"), JSON.stringify(Object.keys(body)));
		expect("the Workflow dock keeps its separate turn_id telemetry identifier", /^[a-f0-9]{32}$/.test(String(body.turn_id)));
	});

	await group("job progress, stop and installed receipt", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "queued", progress: null, phase: "queued" }),
				frame({ type: "job.state", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" }),
				frame({ type: "job.progress", eventSeq: 3, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.4, phase: "generating" }),
				frame({ type: "receipt", eventSeq: 4, receipt: installedReceipt() }),
				frame({ type: "receipt", eventSeq: 5, receipt: installedReceipt() }),
				frame({ type: "done" }),
			]),
			"/agent/stop$": () => jsonResponse({ ok: true }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("walk to the chair and sit", {});
		const jobs = items(store, "job");
		expect("one job card tracks the whole generation", jobs.length === 1, JSON.stringify(jobs.map((job) => job.jobId)));
		expect("the job card reports the actual forwarded progress", jobs[0]?.progress === 0.4, String(jobs[0]?.progress));
		expect("the job card ends in its terminal installed state", jobs[0]?.state === "installed", String(jobs[0]?.state));
		const receipts = items(store, "receipt");
		expect("the installed receipt renders exactly one card", receipts.length === 1, String(receipts.length));
		expect("a duplicate receipt does not create a second card", items(store, "receipt").filter((item) => item.receiptId === "receipt-1").length === 1, JSON.stringify(store.getState().items.map((item) => item.kind)));
		expect("the rendered receipt is the validated task-1 receipt", (() => { try { validateReceipt(receipts[0]?.receipt); return true; } catch { return false; } })());
		expect("the store stops streaming at the terminal event", store.getState().streaming === false);
	});

	await group("Stop identifies the turn and the job", async () => {
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-7", commandId: "cmd-7", state: "generating", progress: null, phase: "generating" }),
			], { drop: false }),
			"/agent/stop$": () => { release(); return jsonResponse({ ok: true }); },
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		const turn = store.send("generate a walk", {});
		await settled(store, (state) => state.items.some((item) => item.kind === "job" && item.jobId === "job-7"));
		store.stop();
		await held;
		await turn.catch(() => {});
		const stop = sidecar.calls.find((call) => call.path === "/agent/stop");
		let valid = true;
		try { validateStudioStopEnvelope(stop?.body); } catch (error) { valid = false; expect("Stop sends the frozen task-1 stop envelope", false, `${error.code} ${error.message} body=${JSON.stringify(stop?.body)}`); }
		if (valid) expect("Stop sends the frozen task-1 stop envelope", true);
		expect("Stop names the running job", stop?.body?.jobId === "job-7", JSON.stringify(stop?.body));
		expect("Stop leaves the panel idle", store.getState().streaming === false);
	});

	await group("explicit acceptance of an unverified candidate", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "verifying", progress: null, phase: "verifying" }),
				frame({ type: "job.state", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "review_required", progress: null, phase: "contact verification failed" }),
				frame({ type: "done" }),
			]),
			"/agent/jobs/.*/accept$": () => jsonResponse({ ok: true, receipt: unverifiedReceipt() }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const job = items(store, "job")[0];
		expect("a soft failure stops at review_required", job?.state === "review_required", String(job?.state));
		expect("the candidate is never labelled verified", job?.verified !== true && job?.acceptance?.status === "required", JSON.stringify(job?.acceptance));
		await store.acceptJob("job-1");
		const accept = sidecar.calls.find((call) => /\/accept$/.test(call.path));
		expect("Apply with warnings posts the job accept route", accept?.path === "/agent/jobs/job-1/accept" && accept.method === "POST", JSON.stringify(accept?.path));
		expect("acceptance is explicit in the request body", accept?.body?.explicitUnverifiedAcceptance === true && accept?.body?.surface === "studio" && isUuid(accept?.body?.sessionId), JSON.stringify(accept?.body));
		const accepted = items(store, "job")[0];
		expect("the accepted job installs with its unverified label intact", accepted?.state === "installed" && accepted?.verification?.status === "unverified", JSON.stringify({ state: accepted?.state, verification: accepted?.verification?.status }));
		expect("the acceptance receipt is recorded once", items(store, "receipt").filter((item) => item.receiptId === "receipt-2").length === 1);
	});

	await group("restore rebuilds the transcript and preserves identity", async () => {
		const store = createAgentChatStore({ transport: { turn: async () => {} }, surface: "studio" });
		store.restore([
			{ kind: "user", text: "frame a wide shot", attachments: [{ name: "ref.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }] },
			{ kind: "assistant", text: "I will frame it." },
			{ kind: "tool", name: "frame_shot", label: "Frame the shot", ok: true, elapsedMs: 12 },
			{ kind: "receipt", receiptId: "receipt-restore", summary: "Applied to the scene" },
		], "restored-session");
		expect("restore rebuilds user, assistant, tool and receipt items", store.getState().items.map((item) => item.kind).join(",") === "user,assistant,tool,receipt");
		expect("restore keeps the server session id", store.getState().sessionId === "restored-session");
		expect("restore keeps pasted attachments on the user item", store.getState().items[0].attachments?.length === 1 && store.getState().items[0].attachments[0].name === "ref.png");
		const before = store.getState().sessionId;
		store.newSession();
		expect("New mints a different UUID after restore", store.getState().sessionId !== before && isUuid(store.getState().sessionId));
	});

	await group("coherent Clear / New and a persistent draft", async () => {
		const sidecar = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "text.delta", text: "ok" }), frame({ type: "done" })]) });
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		const first = store.getState().sessionId;
		await store.send("hello", {});
		store.setDraft("half written instruction");
		store.clearContext();
		expect("Clear context empties the transcript", store.getState().items.length === 0, String(store.getState().items.length));
		expect("Clear context also starts a new server session", isUuid(store.getState().sessionId) && store.getState().sessionId !== first, store.getState().sessionId);
		expect("Clear context keeps the unsent draft", store.getState().draft === "half written instruction", store.getState().draft);
		const cleared = store.getState().sessionId;
		await store.send("again", {});
		expect("sending consumes the draft", store.getState().draft === "", store.getState().draft);
		store.setDraft("half written instruction");
		store.newSession();
		expect("New starts another session", store.getState().sessionId !== cleared && isUuid(store.getState().sessionId));
		expect("New empties the transcript", store.getState().items.length === 0);
		expect("New keeps the unsent draft", store.getState().draft === "half written instruction");
	});

	await group("provider keys reach the sidecar and nothing else (#379)", async () => {
		const KEY = "sk-test-123";
		const stored = new Set();
		const sidecar = fakeSidecar({
			"/agent/providers$": () => jsonResponse({ providers: [
				{ id: "openai-codex", label: "ChatGPT (OpenAI Codex)", authSource: "chatgpt", signedIn: true },
				{ id: "anthropic", label: "Anthropic", authSource: stored.has("anthropic") ? "file" : null, signedIn: stored.has("anthropic") },
				{ id: "openai", label: "OpenAI", authSource: null, signedIn: false },
				{ id: "google", label: "Google Gemini", authSource: "env", signedIn: true },
				{ id: "openrouter", label: "OpenRouter", authSource: null, signedIn: false },
			] }),
			"/agent/providers/anthropic$": ({ body, path }) => {
				if (body?.key) stored.add("anthropic"); else stored.delete("anthropic");
				return jsonResponse({ ok: true, path });
			},
			"/agent/providers/openai-codex$": () => ({ ok: false, status: 400, clone: () => ({ json: async () => ({ error: "Use ChatGPT sign-in for OpenAI Codex." }) }) }),
			"/agent/models$": () => jsonResponse({ models: [{ id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" }] }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 });
		const listed = await transport.providers();
		expect("the panel reads the provider list from GET /agent/providers", sidecar.calls.at(-1).method === "GET" && sidecar.calls.at(-1).path === "/agent/providers"
			&& listed.length === 5 && listed.every((entry) => !Object.hasOwn(entry, "key")), JSON.stringify(sidecar.calls.at(-1)));
		await transport.setProviderKey("anthropic", KEY);
		const put = sidecar.calls.at(-1);
		expect("saving a key PUTs it to that provider, as the whole body", put.method === "PUT" && put.path === "/agent/providers/anthropic"
			&& JSON.stringify(Object.keys(put.body)) === '["key"]' && put.body.key === KEY, JSON.stringify({ ...put, body: Object.keys(put.body || {}) }));
		expect("the key never travels in the URL", !put.path.includes(KEY) && !sidecar.calls.some((call) => call.path.includes(KEY)));
		expect("the sidecar reports the saved provider as file-backed, without echoing a key", (await transport.providers()).find((entry) => entry.id === "anthropic")?.authSource === "file");
		// Nothing that outlives the call may carry the key: not the transport, not
		// the chat store that shares it, not the store's serialised state.
		const store = createAgentChatStore({ transport, surface: "workflow" });
		const leaked = (value) => { try { return JSON.stringify(value)?.includes(KEY) ?? false; } catch { return true; } };
		expect("the transport keeps no copy of the key after the save", !leaked(transport) && !Object.values(transport).some((value) => typeof value === "string" && value.includes(KEY)));
		expect("the chat store never sees the key at all", !leaked(store.getState()) && !leaked(sidecar.calls.filter((call) => call.method === "GET")));
		await transport.removeProviderKey("anthropic");
		const del = sidecar.calls.at(-1);
		expect("Remove DELETEs the provider and sends no body", del.method === "DELETE" && del.path === "/agent/providers/anthropic" && del.body === null, JSON.stringify(del));
		expect("a removed key leaves the provider unconfigured", (await transport.providers()).find((entry) => entry.id === "anthropic")?.signedIn === false);
		let refused = null;
		try { await transport.setProviderKey("openai-codex", KEY); } catch (error) { refused = error; }
		expect("a 400 from the sidecar is raised with its status and its own message", refused?.status === 400 && /ChatGPT sign-in/.test(refused.message) && !refused.message.includes(KEY), String(refused?.message));
	});

	await group("embedded host contract", () => {
		expect("the panel accepts an embedded host mode", /embedded\s*=\s*false/.test(panelSource));
		expect("embedded mode relinquishes the width and the resize handle to the host", /embedded \?[^\n]*undefined|!embedded && <div[^\n]*agent-resize|embedded \? null : <div/.test(panelSource) && /!embedded/.test(panelSource));
		expect("embedded mode relinquishes the global Cmd/Ctrl+B shortcut", /if \(embedded\) return;[\s\S]{0,400}metaKey \|\| event\.ctrlKey/.test(panelSource) || /embedded[^\n]*keydown/.test(panelSource));
		expect("a hidden embedded panel stays mounted and keeps its chat", /hidden=\{hidden\}|hidden=\{embedded && hidden\}/.test(panelSource));
		expect("the panel never renders a collapsed rail for an embedded host", /embedded[\s\S]{0,200}collapsed/.test(panelSource));
		expect("the chat state lives in the shared store, not a second emitter", panelSource.includes("createAgentChatStore") && panelSource.includes("useSyncExternalStore"));
	});
}

// --- case: failed-action-and-reconnect --------------------------------------

if (runs("failed-action-and-reconnect")) {
	await group("a refused image action stays unapplied", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "image", imageId: "img-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 8, height: 8, prompt: "wide two-shot" }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const requests = [];
		const store = createAgentChatStore({
			transport,
			surface: "studio",
			buildContext: () => studioContext(),
			requestImageAction: async (request) => { requests.push(request); return { ok: false, error: "The scene refused the image." }; },
		});
		await store.send("render it", {});
		const image = items(store, "image")[0];
		expect("the image result renders one card", Boolean(image), JSON.stringify(items(store, "image").length));
		await store.applyImage(image.id);
		const applied = items(store, "image")[0];
		expect("the host is asked to apply the image with a request identity", requests.length === 1 && Boolean(requests[0].requestId), JSON.stringify(requests));
		expect("a refused apply is NOT reported as placed", applied.placed === false, JSON.stringify({ placed: applied.placed, apply: applied.apply }));
		expect("the refusal is visible on the card", applied.apply?.status === "failed" && /refused/.test(applied.apply?.error || ""), JSON.stringify(applied.apply));
		store.acknowledgeImageAction({ requestId: requests[0].requestId, ok: true });
		expect("a late duplicate acknowledgement cannot flip a settled card", items(store, "image")[0].placed === false, JSON.stringify(items(store, "image")[0].apply));
	});

	await group("an unclaimed image action fails honestly", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "image", imageId: "img-2", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 8, height: 8 }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(), requestImageAction: null });
		await store.send("render it", {});
		await store.applyImage(items(store, "image")[0].id);
		const image = items(store, "image")[0];
		expect("no host means no placement", image.placed === false && image.apply?.status === "failed", JSON.stringify(image.apply));
	});

	await group("reconnect resumes from the event cursor", async () => {
		let turns = 0;
		let resumes = 0;
		const sidecar = fakeSidecar({
			"/agent/turn$": () => {
				turns += 1;
				return streamResponse([
					frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" }),
					frame({ type: "job.progress", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.25, phase: "generating" }),
				], { drop: true });
			},
			"/agent/turn/.*/events": ({ path }) => {
				resumes += 1;
				const after = Number(new URL(path, "http://127.0.0.1").searchParams.get("after"));
				const replay = [
					{ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" },
					{ type: "job.progress", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.25, phase: "generating" },
					{ type: "job.progress", eventSeq: 3, jobId: "job-1", commandId: "cmd-1", state: "committing", progress: 0.9, phase: "committing" },
					{ type: "receipt", eventSeq: 4, receipt: installedReceipt() },
					{ type: "done", eventSeq: 5 },
				];
				return { ok: true, status: 200, body: sseBody(replay.map(frame)), resumeAfter: after };
			},
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const resume = sidecar.calls.find((call) => /\/agent\/turn\/.*\/events/.test(call.path));
		expect("a dropped stream resumes through the events cursor route", Boolean(resume), JSON.stringify(sidecar.calls.map((call) => call.path)));
		expect("the cursor is the last event actually delivered", /after=2$/.test(resume?.path || ""), resume?.path);
		expect("resuming never re-runs the generation", turns === 1 && resumes === 1, JSON.stringify({ turns, resumes }));
		const jobs = items(store, "job");
		expect("replayed events do not duplicate the job card", jobs.length === 1, JSON.stringify(jobs.map((job) => job.jobId)));
		expect("the job finishes on the replayed terminal receipt", jobs[0]?.state === "installed", String(jobs[0]?.state));
		expect("the replayed receipt is recorded exactly once", items(store, "receipt").length === 1, String(items(store, "receipt").length));
		expect("the turn is settled after the resume", store.getState().streaming === false);
	});

	await group("a failure receipt keeps its structured recovery", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-9", state: "committing", progress: null, phase: "committing" }),
				frame({ type: "receipt", eventSeq: 2, receipt: failureReceipt() }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const failure = items(store, "failure")[0];
		expect("the failure is shown as a structured failure, not 'upstream failed'", failure?.failure?.code === "STALE_TARGET", JSON.stringify(failure?.failure?.code));
		expect("the failure keeps its recovery action", failure?.failure?.recovery?.action === "new_intent");
		expect("a failed command reports no authored change", failure?.failure?.preserved?.authoredState === "unchanged");
		expect("the job card follows the failure", items(store, "job")[0]?.state === "failed", String(items(store, "job")[0]?.state));
	});

	await group("a refused steer keeps the draft (#379)", async () => {
		const refusal = (code, message) => ({
			ok: false,
			status: 409,
			json: async () => ({ error: { code, message } }),
			clone: () => ({ json: async () => ({ error: { code, message } }) }),
		});
		const held = heldSseBody([frame({ type: "text.delta", text: "Framing the shot." })]);
		const sidecar = fakeSidecar({
			"/agent/turn$": () => ({ ok: true, status: 200, body: held.body }),
			"/steer$": () => refusal("NO_ACTIVE_TURN", "409 \u2014 This turn already ended."),
			"/agent/stop$": () => jsonResponse({ ok: true }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "workflow" });
		const turn = store.send("block the two-shot", { model: "anthropic/claude" });
		await settled(store, (state) => state.items.some((item) => item.kind === "assistant"));
		store.setDraft("actually, make it wider");
		const result = await store.steer(store.getState().draft);
		expect("the refusal is reported by the code the sidecar answered with", result.ok === false && result.code === "NO_ACTIVE_TURN", JSON.stringify(result));
		expect("the refusal explains itself in the panel's own words", result.message === client.STEER_ERROR_COPY.NO_ACTIVE_TURN, result.message);
		expect("a refused steer leaves the draft exactly where it was", store.getState().draft === "actually, make it wider", store.getState().draft);
		expect("a refused steer adds nothing to the transcript", store.getState().items.filter((item) => item.kind === "user").length === 1);
		store.stop();
		held.release();
		await turn.catch(() => {});

		// A Studio turn is steered like the Workflow one. A steer the turn never
		// answered (Stop cut the stream) is reported dropped, never shown as said.
		const studioHeld = heldSseBody([frame({ type: "text.delta", text: "Reading the scene." })]);
		const studioSidecar = fakeSidecar({
			"/agent/turn$": () => ({ ok: true, status: 200, body: studioHeld.body }),
			"/steer$": () => jsonResponse({ ok: true, queued: true }),
			"/agent/stop$": () => jsonResponse({ ok: true }),
		});
		const heard = [];
		const studioStore = createAgentChatStore({
			transport: createHttpTransport({ fetchImpl: studioSidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 }),
			surface: "studio",
			buildContext: () => studioContext(),
			onSteer: (event) => heard.push(event),
		});
		const studioTurn = studioStore.send("frame the shot", {});
		await settled(studioStore, (state) => state.items.some((item) => item.kind === "assistant"));
		const studioResult = await studioStore.steer("nudge it left", { id: "row-1" });
		const studioSteer = studioSidecar.calls.find((call) => /\/steer$/.test(call.path));
		expect("a Studio steer reaches the running Studio turn by its envelope id", studioResult.ok === true && studioSteer?.path === `/agent/turn/${studioSidecar.calls.find((call) => call.path === "/agent/turn").body.turnId}/steer` && studioSteer.body.id === "row-1", JSON.stringify(studioSteer));
		studioStore.stop();
		studioHeld.release();
		await studioTurn.catch(() => {});
		expect("a steer the stopped turn never answered is reported dropped and not shown as said", heard.length === 1 && heard[0].type === "steer.dropped" && heard[0].id === "row-1"
			&& !studioStore.getState().items.some((item) => item.steered), JSON.stringify(heard));
	});

	await group("the composer states what the button will do (#379)", () => {
		expect("Send is the idle label", /className="agent-send" aria-label="Send"[^>]*disabled=\{composerDisabled \|\| !draft\.trim\(\)\}/.test(panelSource));
		expect("a running turn keeps Stop and Send queues", /\{streaming[\s\S]{0,200}agent-send stop agent-stop"[\s\S]{0,40}>Stop<[\s\S]{0,120}agent-send agent-queue-add"[\s\S]{0,400}disabled=\{composerDisabled \|\| !draft\.trim\(\)\} onClick=\{queueDraft\}/.test(panelSource));
		expect("the refusal is shown to the author, not swallowed", panelSource.includes("setSteerNotice(result.message") && panelSource.includes('className="agent-toast alert agent-steer-notice"'));
		expect("no surface switch decides it: every surface queues", !panelSource.includes("presentation.steer"));
	});

	await group("hidden embedded chat keeps state and refuses focus", () => {
		expect("the hidden panel keeps its draft and transcript mounted", /hidden=\{/.test(panelSource) && !/if \(hidden\) return null/.test(panelSource));
		expect("focus never moves to a hidden composer, and leaves one that is hidden", /if \(hidden\) \{[\s\S]{0,320}composerRef\.current\.blur\(\);[\s\S]{0,40}return;\s*\}\s*\n\s*if \(!\(embedded \|\| !collapsed\)\) return;\s*composerRef\.current\?\.focus\(\)/.test(panelSource));
		expect("the hidden panel is inert for assistive technology and the focus order", /hidden=\{embedded && hidden\}/.test(panelSource) && /\.agent-panel\[hidden\]\s*\{[^}]*display:\s*none/.test(panelCss));
	});
}

if (failures) {
	console.error(`${failures} FAILURES in --case ${selected}`);
	process.exitCode = 1;
} else {
	console.log(`all agent host checks PASS (--case ${selected})`);
}
