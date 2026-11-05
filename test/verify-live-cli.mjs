#!/usr/bin/env node
/**
 * Issue #328: `cclay live` drives the Studio from a terminal.
 *
 * The hub is real (`startLiveHub`), the endpoint file is real (published under
 * a throwaway config home), and the CLI runs as a child process exactly as an
 * operator would run it. Only the editor is a fixture: it answers the live
 * commands the CLI sends and records the frames it received, so the admission
 * envelope, the receipts printed verbatim, the PNG bytes and every exit code
 * are asserted against what actually crossed the socket.
 */
import assert from "node:assert/strict";
import { dispatchLiveFrame } from "../src/live-control.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configHome = mkdtempSync(join(tmpdir(), "cozyclay-live-cli-"));
process.env.XDG_CONFIG_HOME = configHome;
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-live-cli-out-"));
const { publishLiveEndpoint, liveEndpointPath, removeLiveEndpoint } = await import("../bin/live-endpoint.mjs");
const { startLiveHub } = await import("../mcp/live-hub.mjs");

const launcher = fileURLToPath(new URL("../bin/cozyclay.mjs", import.meta.url));
const TOKEN = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IDENTITY = { workspaceId: "cli-tab", documentEpoch: "doc-1", sceneId: "scene-1", sceneEpoch: "epoch-1" };
const EDITOR_COMMANDS = [
	"describe", "inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot",
	"verify_result", "undo_edit", "resolve_studio_image", "reconcile_studio_command",
	"capture_frame", "capture_framing_png", "place_object",
];

const evidence = {};

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => (error ? reject(error) : resolve(address.port)));
	});
});

const withTimeout = (promise, label, milliseconds = 15_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};

/* ------------------------------ fake editor ------------------------------- */

const describeValue = () => ({
	document: { version: 3, activeSceneId: "scene-1", scenes: [{ id: "scene-1", name: "CLI", objects: [], shotDocument: null, stage: { characters: [], hasCharSheet: false, shotAspect: "16:9", sensorId: "super35" } }] },
	sceneName: "CLI",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 1.78 },
	stage: { shotAspect: "16:9", sensorId: "super35", hasCharSheet: false },
	timeline: { currentFrame: 0, frameCount: 240, fps: 24 },
	activeCharacterId: "char-a",
	characters: [{ id: "char-a", model: "y-bot-tpose", subject: "Lead", x: 0, y: 0, z: 0, rot: 0, hidden: false }],
	objects: [{ id: "cube-1", kind: "cube", name: "Cube", x: 1, y: 0, z: 0 }],
});

/** The Studio command args live inside the admission envelope for every verb
 * that produces a receipt, and are the whole payload for a raw `cmd`. */
const studioArgs = (payload) => (payload?.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? payload.args : payload ?? {});

const connectEditor = async (url, workspaceId, meta, controls = { silent: new Set(), failWith: null }) => {
	const state = { revision: 4, receipts: 0, lastReceipt: null };
	const socket = new WebSocket(url);
	const received = [];
	let welcome;
	const workspace = new Promise((resolve) => { welcome = resolve; });

	const entities = () => [
		{ id: "char-a", kind: "character", name: "Lead", token: `char-a@${state.revision}` },
		{ id: "cube-1", kind: "object", name: "Cube", token: `cube-1@${state.revision}` },
	];
	const context = () => ({
		schema: "studio-context-v1",
		host: { surface: "studio", ...IDENTITY, workspaceHandle: workspaceId },
		revision: { scene: state.revision, physics: 1, view: 2 },
		scene: { name: "CLI", aspect: "16:9", floorY: 0, frameCount: 240, objectCount: 1, characterCount: 1 },
		selection: { kind: "object", id: "cube-1" },
		activeCharacterId: "char-a",
		view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: true, autoColor: false },
		shot: null, camera: null,
		entities: entities(),
		entityPage: { returned: 2, total: 2, truncated: false, nextCursor: null },
		shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
	});
	const appliedReceipt = (commandId, affectedIds) => {
		const before = state.revision;
		state.revision += 1;
		state.receipts += 1;
		return {
			ok: true, commandId, receiptId: `receipt-${state.receipts}`, host: IDENTITY, status: "applied", authored: true, mutated: true,
			revision: { before, after: state.revision }, affectedIds,
			delta: affectedIds.map((id) => ({ id, after: { position: { x: 1, y: 0, z: 0 } } })),
			checks: { coverage: "placement", relationSatisfied: true },
			undo: { historyEntryId: `history-${state.receipts}`, entries: 1, canUndoDirect: true },
			warnings: [],
		};
	};
	const failureReceipt = (commandId, code) => ({
		ok: false, commandId, host: IDENTITY, code, phase: "admission", affectedIds: [], expectedTargets: [], currentTargets: [],
		mutated: false, preserved: { authoredState: "unchanged" }, recovery: { action: "inspect", retryAllowed: true },
		message: `The fixture editor refuses with ${code}.`,
	});
	const answer = (frame) => {
		const payload = frame.args ?? {};
		const args = studioArgs(payload);
		switch (frame.name) {
			case "ping": return { pong: true };
			case "describe": return describeValue();
			case "inspect_studio": return { revision: context().revision, host: context().host, entities: entities(), total: 2, nextCursor: null };
			case "arrange_objects":
			case "arrange_characters":
			case "frame_shot": {
				if (controls.failWith) return failureReceipt(payload.commandId, controls.failWith);
				state.lastReceipt = appliedReceipt(payload.commandId, ["cube-1"]);
				return state.lastReceipt;
			}
			case "patch_elements": {
				if (controls.failWith) return failureReceipt(payload.commandId, controls.failWith);
				const op = args.ops[0];
				const id = op.target.kind === "stage" ? IDENTITY.sceneId : op.target.id;
				state.lastReceipt = {
					...appliedReceipt(payload.commandId, [id]),
					delta: [{ id, after: { patched: Object.keys(op.set).map((key) => ({ path: `${op.target.kind}.${key}`, number: Number(op.set[key]) })) } }],
					checks: { coverage: "declared-element-readback" },
					ops: [{ index: 0, status: "applied" }],
				};
				return state.lastReceipt;
			}
			case "operate_studio": {
				state.receipts += 1;
				return {
					ok: true, commandId: payload.commandId, receiptId: `receipt-${state.receipts}`, host: IDENTITY, status: "transient",
					authored: false, mutated: false, revision: { before: state.revision, after: state.revision }, view: { before: 2, after: 3 },
					affectedIds: [IDENTITY.sceneId], delta: [{ id: IDENTITY.sceneId, after: { frame: args.frame ?? 0, view: { mode: args.mode ?? "scene" } } }],
					checks: { coverage: "editor-view-state" }, undo: null, warnings: [],
				};
			}
			case "capture_frame": return {
				width: 640, height: 360, mimeType: "image/png", encoding: "base64",
				byteSize: Buffer.from(PNG_BASE64, "base64").byteLength, data: PNG_BASE64,
				assertions: { renderable: true, blackFrame: false, nonBlackPixels: 1, characters: [] },
			};
			case "capture_framing_png": return { dataUrl: `data:image/png;base64,${PNG_BASE64}`, width: 1920, height: 1080, frame: 0, shotId: "shot-1" };
			case "verify_result": return {
				receiptId: args.receiptId ?? null, revision: state.revision,
				checks: args.targets ? { coverage: "sampled-timeline-subject-bounds-projection", framing: { coverage: "sampled-timeline-subject-bounds-projection", evaluatedFrames: 2, sampledFrames: [0, 11], sampledChecks: [{ frame: 0, screenFraction: 0.4, clipped: false, behindCamera: false, occluded: false }, { frame: 11, screenFraction: 0.1, clipped: true, behindCamera: false, occluded: false }], issueFrames: [{ frame: 11, codes: ["CLIPPED"], screenFraction: 0.1 }] } } : (state.lastReceipt?.checks ?? { coverage: "unavailable" }), verification: null, semanticStatus: "unavailable",
				visualRefs: args.visual && args.visual !== "none" ? [{ imageId: "image-1" }] : [], unsupportedChecks: [],
			};
			case "resolve_studio_image": {
				if (payload.imageId !== "image-1") throw new Error("Image observation does not belong to this receipt.");
				return { dataUrl: `data:image/png;base64,${PNG_BASE64}`, width: 1920, height: 1080, revision: state.revision, receiptId: payload.receiptId ?? null };
			}
			case "undo_edit": {
				const previous = state.lastReceipt;
				const ids = previous?.affectedIds ?? ["cube-1"];
				const before = state.revision;
				state.revision += 1;
				state.receipts += 1;
				return {
					ok: true, commandId: payload.commandId, receiptId: `receipt-${state.receipts}`, host: IDENTITY, status: "undone",
					authored: true, mutated: true, revision: { before, after: state.revision }, affectedIds: ids,
					delta: ids.map((id) => ({ id, after: { token: `${id}@${state.revision}` } })),
					checks: { coverage: "native-history-restoration" },
					undo: { historyEntryId: `history-${state.receipts}`, entries: 1, canUndoDirect: false }, warnings: [],
					undoneReceiptId: previous?.receiptId ?? "receipt-0",
					restoredTargets: ids.map((id) => ({ ...IDENTITY, targetId: id, token: `${id}@${state.revision}` })),
				};
			}
			case "reconcile_studio_command": return state.lastReceipt && state.lastReceipt.commandId === payload.commandId
				? { status: "applied", receipt: state.lastReceipt }
				: { status: "not_applied", receipt: null };
			case "place_object": return { id: "object-2", kind: payload.kind ?? "cube" };
			default: throw new Error(`Unexpected command: ${frame.name}`);
		}
	};

	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data));
		if (frame.type === "workspace") {
			welcome(frame.handle);
			return;
		}
		if (frame.type !== "cmd") return;
		received.push(frame);
		if (controls.silent?.has(frame.name)) return;
		if (controls.hidden && frame.name.startsWith("capture_")) {
			void dispatchLiveFrame(JSON.stringify(frame), { [frame.name]: () => { throw Object.assign(new Error("Bring the Studio tab to the front or run headless Chrome."), { code: "TAB_HIDDEN" }); } }).then(result => socket.send(JSON.stringify(result)));
			return;
		}
		try {
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: answer(frame) }));
		} catch (error) {
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: error.message }));
		}
	});
	await withTimeout(new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	}), `${workspaceId} socket open`);
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId, meta }));
	return { socket, received, state, controls, handle: await withTimeout(workspace, `${workspaceId} workspace frame`) };
};

/* --------------------------------- the CLI -------------------------------- */

const hub = await startLiveHub(0, { token: TOKEN, owner: "mcp" });
assert.ok(hub, "the CLI suite needs its own live hub");
const url = `ws://127.0.0.1:${hub.port}/live`;
publishLiveEndpoint({ port: hub.port, token: TOKEN, owner: "mcp" });
hub.serveTool = (name, args, workspaceHandle) => {
	if (name !== "describe_shot") throw Object.assign(new Error(`Unknown live tool "${name}".`), { code: "UNKNOWN_TOOL" });
	return { content: [{ type: "text", text: `Shot for ${workspaceHandle}: medium shot, front, eye` }], args };
};

const childEnvironment = (extra = {}) => {
	const environment = { ...process.env, XDG_CONFIG_HOME: configHome, COZYCLAY_LIVE_PORT: String(hub.port), ...extra };
	delete environment.COZYCLAY_LIVE_TOKEN;
	return environment;
};

const start = (args, extra = {}) => {
	const child = spawn(process.execPath, [launcher, "live", ...args], { env: childEnvironment(extra), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const watchers = new Set();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		for (const watcher of [...watchers]) {
			if (!watcher.pattern.test(stderr)) continue;
			watchers.delete(watcher);
			watcher.resolve();
		}
	});
	return {
		child,
		done: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stdout, stderr, args }));
		}),
		// Subscribe to a line the CLI has not printed yet, then cause it: no
		// sleeps, and nothing resolves on output that arrived before the call.
		whenStderr: (pattern) => withTimeout(new Promise((resolve) => {
			if (pattern.test(stderr)) return resolve();
			watchers.add({ pattern, resolve });
		}), `stderr matching ${pattern}`),
	};
};

const run = (args, extra = {}) => withTimeout(start(args, extra).done, `cclay live ${args.join(" ")}`, 30_000);

/** stdout is exactly one JSON object, always. */
const only = (result) => {
	const label = `cclay live ${result.args.join(" ")}`;
	const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
	assert.equal(lines.length, 1, `${label} printed ${lines.length} stdout lines: ${JSON.stringify(result.stdout)}`);
	const value = JSON.parse(lines[0]);
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must print one JSON object`);
	return value;
};

const ok = (result) => {
	assert.equal(result.code, 0, `cclay live ${result.args.join(" ")} should succeed: ${result.stdout}${result.stderr}`);
	return only(result);
};

const open = [];
try {
	/* ------------------------- nothing is running -------------------------- */

	const emptyPort = await reservePort();
	const missing = await run(["status", "--live-port", String(emptyPort)]);
	assert.equal(missing.code, 3, `an unpublished port is NO_SERVER: ${missing.stdout}`);
	const missingBody = only(missing);
	assert.equal(missingBody.ok, false);
	assert.equal(missingBody.error.code, "NO_SERVER");
	assert.deepEqual(missingBody.error.recovery, { action: "start", hint: "run `npm run dev` or `cclay`" });

	// A published endpoint whose owner already exited is the same as no hub.
	const deadPort = await reservePort();
	const corpse = spawn(process.execPath, ["-e", ""]);
	const deadPid = corpse.pid;
	await withTimeout(new Promise((resolve) => corpse.once("exit", resolve)), "throwaway process exit");
	writeFileSync(liveEndpointPath(deadPort), `${JSON.stringify({ port: deadPort, token: TOKEN, pid: deadPid, owner: "mcp" })}\n`, { mode: 0o600 });
	const dead = await run(["status", "--live-port", String(deadPort)]);
	assert.equal(dead.code, 3, `a dead owner is NO_SERVER: ${dead.stdout}`);
	assert.equal(only(dead).error.code, "NO_SERVER");
	evidence.noServer = { unpublished: missingBody.error, deadOwner: only(dead).error };

	/* ---------------------------- status --wait ---------------------------- */

	const waiting = start(["status", "--wait", "--timeout", "20000"]);
	await waiting.whenStderr(/waiting for a selectable editor/);
	const alpha = await connectEditor(url, "cli-tab", { project: "Alpha", scene: "CLI", cast: 1, commands: EDITOR_COMMANDS });
	open.push(alpha.socket);
	const waited = ok(await withTimeout(waiting.done, "status --wait", 30_000));
	assert.equal(waited.selected, alpha.handle, "--wait resolves once an editor is selectable");
	assert.equal(waited.editors.length, 1);
	evidence.wait = waited;

	/* --------------------------- read-only verbs --------------------------- */

	const status = ok(await run(["status"]));
	assert.deepEqual(status.server, { port: hub.port, owner: "mcp", pid: process.pid });
	const [listed] = status.editors;
	assert.equal(listed.handle, "cli-tab");
	assert.equal(listed.project, "Alpha");
	assert.equal(listed.scene, "CLI");
	assert.equal(listed.cast, 1);
	assert.equal(listed.embed, false);
	assert.equal(listed.inFlight, 0);
	assert.ok(Number.isInteger(listed.connectedAt) && Number.isInteger(listed.lastSeenMs));
	evidence.status = status;

	const described = ok(await run(["describe"]));
	assert.equal(described.sceneName, "CLI");
	assert.equal(described.objects.length, 1);

	const inspected = ok(await run(["inspect", "--scope", "selection"]));
	assert.equal(inspected.host.workspaceId, IDENTITY.workspaceId);
	assert.equal(inspected.total, 2);
	const inspectedByQuery = ok(await run(["inspect", "--scope", "entities", "--query", "Cube"]));
	assert.ok(inspectedByQuery.entities.length > 0);
	assert.equal(alpha.received.at(-1).args.query, "Cube");
	const inspectedByIds = ok(await run(["inspect", "--scope", "entities", "--ids", "cube-1,char-a"]));
	assert.ok(inspectedByIds.entities.length > 0);
	assert.deepEqual(alpha.received.at(-1).args.ids, ["cube-1", "char-a"]);

	/* -------------------------------- capture ------------------------------ */

	const framePath = join(scratch, "frame.png");
	const captured = ok(await run(["capture", "--out", framePath]));
	assert.equal(captured.path, framePath);
	assert.equal(captured.width, 640);
	assert.equal(captured.height, 360);
	assert.equal(captured.assertions.renderable, true);
	assert.ok(readFileSync(framePath).subarray(0, 8).equals(PNG_MAGIC), "capture must write real PNG bytes");
	assert.equal(readFileSync(framePath).byteLength, captured.bytes);

	const framingPath = join(scratch, "framing.png");
	const framingCaptured = ok(await run(["capture", "--framing", "--out", framingPath]));
	assert.equal(framingCaptured.width, 1920);
	assert.equal(framingCaptured.height, 1080);
	assert.equal(framingCaptured.assertions, undefined, "capture_framing_png carries no assertions");
	assert.ok(readFileSync(framingPath).subarray(0, 8).equals(PNG_MAGIC));
	alpha.controls.hidden = true;
	for (const extra of [[], ["--framing"]]) {
		const before = readFileSync(framePath);
		const refused = await run(["capture", ...extra, "--out", framePath]);
		assert.equal(refused.code, 1);
		assert.equal(only(refused).error.code, "TAB_HIDDEN");
		assert.match(only(refused).error.message, /front.*headless Chrome/);
		assert.deepEqual(readFileSync(framePath), before, "refused capture never overwrites the output");
	}
	alpha.controls.hidden = false;
	evidence.capture = { frame: captured, framing: framingCaptured };

	/* ------------------------------- receipts ------------------------------ */

	const arranged = ok(await run(["arrange-objects", "--op", JSON.stringify({ op: "update", id: "cube-1", position: { world: { x: 2, y: 0, z: 0 } } })]));
	assert.equal(arranged.status, "applied");
	assert.equal(arranged.affectedIds[0], "cube-1");
	assert.equal(arranged.revision.after, arranged.revision.before + 1);
	assert.ok(arranged.undo.historyEntryId);
	assert.deepEqual(arranged.warnings, []);
	const envelope = alpha.received.at(-1).args;
	assert.equal(envelope.name, "arrange_objects");
	assert.deepEqual(envelope.args.ops, [{ op: "update", id: "cube-1", position: { world: { x: 2, y: 0, z: 0 } } }]);
	assert.match(envelope.commandId, /^[0-9a-f-]{36}$/);
	assert.deepEqual(envelope.host, IDENTITY);
	assert.equal(envelope.expectedRevision, arranged.revision.before, "the envelope admits against the revision the inspect reported");
	assert.equal(envelope.expectedTargets, undefined, "the admission envelope carries no per-entity incarnation tokens");
	evidence.receipt = { printed: arranged, envelope };

	const opsFile = join(scratch, "ops.json");
	writeFileSync(opsFile, JSON.stringify([{ op: "update", id: "cube-1", name: "From file" }]));
	const arrangedFromFile = ok(await run(["arrange-objects", "-f", opsFile]));
	assert.equal(arrangedFromFile.status, "applied");
	assert.deepEqual(alpha.received.at(-1).args.args.ops, [{ op: "update", id: "cube-1", name: "From file" }]);

	const cast = ok(await run(["arrange-characters", "--op", JSON.stringify({ op: "update", characterId: "char-a", name: "Lead" })]));
	assert.equal(cast.status, "applied");
	assert.equal(alpha.received.at(-1).name, "arrange_characters");

	// One declared element path, one receipt, one undo entry — admitted exactly
	// like an arrangement, with the target kind and optional id on --target.
	const patched = ok(await run(["patch", "--target", "stage", "--set", JSON.stringify({ "keyLight.intensity": 2.5 })]));
	assert.equal(patched.status, "applied");
	assert.equal(patched.revision.after, patched.revision.before + 1);
	assert.deepEqual(patched.ops, [{ index: 0, status: "applied" }]);
	assert.deepEqual(patched.delta[0].after.patched, [{ path: "stage.keyLight.intensity", number: 2.5 }]);
	const patchEnvelope = alpha.received.at(-1).args;
	assert.equal(alpha.received.at(-1).name, "patch_elements");
	assert.deepEqual(patchEnvelope.args, { ops: [{ target: { kind: "stage" }, set: { "keyLight.intensity": 2.5 } }] });
	assert.equal(patchEnvelope.expectedRevision, patched.revision.before);
	assert.deepEqual(patchEnvelope.host, IDENTITY);
	ok(await run(["patch", "--target", "character:char-a", "--set", JSON.stringify({ scale: 1.5 })]));
	assert.deepEqual(alpha.received.at(-1).args.args.ops[0].target, { kind: "character", id: "char-a" });
	const patchUsage = await run(["patch", "--target", "stage"]);
	assert.equal(patchUsage.code, 2, `${patchUsage.stdout}${patchUsage.stderr}`);
	assert.equal(only(patchUsage).error.code, "USAGE");
	evidence.patch = { printed: patched, envelope: patchEnvelope };

	const framed = ok(await run(["frame-shot", "--subject", "char-a", "--size", "medium shot", "--view", "front", "--level", "eye", "--side", "left", "--focal", "50"]));
	assert.equal(framed.status, "applied");
	assert.deepEqual(alpha.received.at(-1).args.args, {
		subjectIds: ["char-a"],
		framing: { intent: { size: "medium shot", view: "front", level: "eye", side: "left", focalMm: 50 } },
	});

	ok(await run(["frame-shot", "--subject", "char-a", "--exact", "1,1.6,4,0,1.2,0,35"]));
	assert.deepEqual(alpha.received.at(-1).args.args.framing, {
		exact: { position: { x: 1, y: 1.6, z: 4 }, lookAt: { x: 0, y: 1.2, z: 0 }, focalMm: 35 },
	});

	const operated = ok(await run(["operate", "--select", "object:cube-1", "--frame", "12", "--mode", "camera", "--pause"]));
	assert.equal(operated.status, "transient");
	assert.equal(operated.undo, null);
	assert.deepEqual(alpha.received.at(-1).args.args, { selection: { kind: "object", id: "cube-1" }, frame: 12, mode: "camera", playing: false });

	const visualPath = join(scratch, "check.png");
	const verified = ok(await run(["verify", "--receipt", arranged.receiptId, "--checks", "placement,framing", "--visual", "frame", "--out", visualPath]));
	assert.deepEqual(alpha.received.at(-2).args.args, { receiptId: arranged.receiptId, checks: ["placement", "framing"], visual: "frame" });
	assert.equal(verified.visual.length, 1);
	assert.equal(verified.visual[0].path, visualPath);
	assert.ok(readFileSync(visualPath).subarray(0, 8).equals(PNG_MAGIC), "verify --visual must write real PNG bytes");
	assert.equal(alpha.received.at(-1).name, "resolve_studio_image");
	evidence.verify = verified;

	const sampled = ok(await run(["verify", "--targets", "char-a", "--checks", "framing", "--range", "0:12"]));
	assert.deepEqual(alpha.received.at(-1).args.args, { targets: ["char-a"], checks: ["framing"], range: { startFrame: 0, endFrameExclusive: 12 } });
	assert.deepEqual(sampled.checks.framing.issueFrames.map(({ frame }) => frame), [11]);
	const strictSampled = await run(["verify", "--targets", "char-a", "--checks", "framing", "--range", "0:12", "--strict"]);
	assert.equal(strictSampled.code, 1, `${strictSampled.stdout}${strictSampled.stderr}`);
	assert.equal(only(strictSampled).error.code, "VERIFICATION_FAILED");

	const undone = ok(await run(["undo", "--receipt", arranged.receiptId]));
	assert.equal(undone.status, "undone");
	assert.ok(undone.undoneReceiptId);
	assert.equal(alpha.received.at(-1).args.args.receiptId, arranged.receiptId);

	/* ---------------------------- escape hatches --------------------------- */

	const placed = ok(await run(["cmd", "place_object", "--args", JSON.stringify({ kind: "cube" })]));
	assert.deepEqual(placed, { id: "object-2", kind: "cube" });
	assert.deepEqual(alpha.received.at(-1).args, { kind: "cube" }, "a raw command carries no admission envelope");

	const tooled = ok(await run(["tool", "describe_shot", "--args", "{}"]));
	assert.match(tooled.content[0].text, /Shot for cli-tab/);

	const pretty = await run(["describe", "--pretty"]);
	assert.equal(pretty.code, 0);
	assert.ok(pretty.stdout.includes("\n\t"), "--pretty indents the object");
	assert.equal(JSON.parse(pretty.stdout).sceneName, "CLI");

	/* ------------------------------ failures ------------------------------- */

	const rejected = await run(["cmd", "not_a_command"]);
	assert.equal(rejected.code, 1, `an editor rejection exits 1: ${rejected.stdout}`);
	const rejectedBody = only(rejected);
	assert.equal(rejectedBody.ok, false);
	assert.equal(rejectedBody.error.code, "EDITOR_ERROR");
	assert.match(rejectedBody.error.message, /not_a_command/);

	alpha.controls.failWith = "STALE_TARGET";
	const stale = await run(["arrange-objects", "--op", JSON.stringify({ op: "remove", id: "cube-1" })]);
	alpha.controls.failWith = null;
	assert.equal(stale.code, 6, `a stale target exits 6: ${stale.stdout}`);
	const staleBody = only(stale);
	assert.equal(staleBody.error.code, "STALE_TARGET");
	assert.equal(staleBody.error.recovery.action, "inspect", "an ok:false receipt passes its own recovery action through");
	assert.equal(staleBody.error.details.receipt.ok, false);
	evidence.staleTarget = staleBody.error;

	const usage = await run(["inspect"]);
	assert.equal(usage.code, 2, `a missing required flag exits 2: ${usage.stdout}`);
	assert.equal(only(usage).error.code, "USAGE");
	assert.match(usage.stderr, /cclay live - drive a running CozyClay studio/);
	const unknownVerb = await run(["teleport"]);
	assert.equal(unknownVerb.code, 2);
	assert.match(only(unknownVerb).error.message, /unknown verb/);

	/* ------------------------- the uncertain paths ------------------------- */

	// The editor accepts the frame and never answers: the hub can no longer
	// tell an applied mutation from a lost one, so the CLI must not guess.
	alpha.controls.silent = new Set(["arrange_objects"]);
	const uncertain = await run(["arrange-objects", "--op", JSON.stringify({ op: "update", id: "cube-1", name: "Silent" }), "--timeout", "400"]);
	alpha.controls.silent = new Set();
	assert.equal(uncertain.code, 5, `an uncertain mutation exits 5: ${uncertain.stdout}`);
	const uncertainBody = only(uncertain);
	assert.equal(uncertainBody.error.code, "UNCERTAIN_APPLY");
	assert.ok(["applied", "not_applied", "unknown"].includes(uncertainBody.error.details.reconcile.status));
	assert.equal(uncertainBody.error.details.reconcile.status, "not_applied", "the fixture journal never recorded the silent command");
	assert.equal(uncertainBody.error.details.commandId, alpha.received.at(-2).args.commandId);
	assert.equal(alpha.received.at(-1).name, "reconcile_studio_command", "an uncertain receipt verb reconciles itself");
	evidence.uncertainReceipt = uncertainBody.error;

	alpha.controls.silent = new Set(["place_object"]);
	const uncertainRaw = await run(["cmd", "place_object", "--args", JSON.stringify({ kind: "cube" }), "--timeout", "400"]);
	alpha.controls.silent = new Set();
	assert.equal(uncertainRaw.code, 5);
	const uncertainRawBody = only(uncertainRaw);
	assert.equal(uncertainRawBody.error.code, "UNCERTAIN_APPLY");
	assert.deepEqual(uncertainRawBody.error.recovery.hint, { objects: 1, characters: 1, camera: describeValue().camera });
	assert.equal(alpha.received.at(-1).name, "describe", "an uncertain raw command reads the scene back");
	evidence.uncertainRaw = uncertainRawBody.error;

	/* --------------------------- two editors ------------------------------- */

	const beta = await connectEditor(url, "beta-tab", { project: "Beta", scene: "Second", cast: 2, commands: EDITOR_COMMANDS });
	open.push(beta.socket);
	const ambiguous = await run(["describe"]);
	assert.equal(ambiguous.code, 4, `two editors without --workspace exits 4: ${ambiguous.stdout}`);
	const ambiguousBody = only(ambiguous);
	assert.equal(ambiguousBody.error.code, "AMBIGUOUS_WORKSPACE");
	assert.deepEqual(ambiguousBody.error.details.candidates.map((candidate) => candidate.handle).sort(), ["beta-tab", "cli-tab"]);
	evidence.ambiguous = ambiguousBody.error;

	const byHandle = ok(await run(["describe", "--workspace", "beta-tab"]));
	assert.equal(byHandle.sceneName, "CLI");
	assert.equal(beta.received.at(-1).name, "describe", "--workspace routes to the named editor only");
	ok(await run(["describe", "--workspace", "Alpha"]));
	assert.equal(alpha.received.at(-1).name, "describe", "--workspace also accepts a project name");

	// #864: opening a named project relabels the tab under the same handle, so
	// status and --workspace <project> see the opened name, not the stale one.
	const relabeled = withTimeout(new Promise((resolve) => {
		beta.socket.addEventListener("message", (event) => { if (JSON.parse(event.data).type === "pong") resolve(); });
	}), "beta relabel pong");
	beta.socket.send(JSON.stringify({ type: "meta", meta: { project: "Example project", scene: "Opened", cast: 2, commands: EDITOR_COMMANDS } }));
	beta.socket.send(JSON.stringify({ type: "ping" }));
	await relabeled;
	const relabeledStatus = ok(await run(["status"])).editors.find((editor) => editor.handle === "beta-tab");
	assert.equal(relabeledStatus.project, "Example project", "status reports the opened project's name");
	assert.equal(relabeledStatus.scene, "Opened");
	ok(await run(["describe", "--workspace", "Example project"]));
	assert.equal(beta.received.at(-1).name, "describe", "the opened project's name selects its workspace");
	assert.equal(only(await run(["describe", "--workspace", "Beta"])).error.code, "STALE_HANDLE", "the old label no longer matches");
	evidence.relabeled = relabeledStatus;

	const unknownWorkspace = await run(["describe", "--workspace", "no-such-tab"]);
	assert.equal(unknownWorkspace.code, 4);
	assert.equal(only(unknownWorkspace).error.code, "STALE_HANDLE");

	/* --------------------------- the launcher ------------------------------ */

	const help = await withTimeout(new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [launcher, "--help"], { env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout }));
	}), "cozyclay --help", 30_000);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /cclay live status/, "`cclay --help` lists live");
	const liveHelp = await run(["--help"]);
	assert.equal(liveHelp.code, 0);
	assert.match(liveHelp.stdout, /cclay live capture --out/);
} finally {
	for (const socket of open) {
		if (socket.readyState === WebSocket.OPEN) socket.close();
	}
	removeLiveEndpoint(hub.port);
	await new Promise((resolve) => hub.server.close(resolve));
	rmSync(configHome, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify(evidence));
console.log("PASS verify-live-cli: discovery, workspace selection, receipts, capture PNGs, escape hatches, uncertain reconcile, exit codes 0/1/2/3/4/5/6");
