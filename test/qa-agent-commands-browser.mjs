#!/usr/bin/env node
/** Real-editor issue #398 acceptance. Build, start dev with an isolated config
 * and live port, then run through tools/qa-browser.mjs. QA_OWN_BROWSER=1 instead
 * launches owned headless Chrome with SwiftShader (the wrapper has no GPU flags).
 * Defaults: dev 5197, LiveHub 5497, CDP 9247. No model or fixture editor is used.
 * --legacy retains issue #123 capture/import/native-Undo acceptance.
 * Output is self-contained JSON/DOM evidence; this probe creates no artifacts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { connectController, discoverEndpoint } from "../bin/live/client.mjs";
import { spawnOwned, terminateOwned } from "../tools/process-supervisor.mjs";
import { createSceneStage, SCENES_STORAGE_KEY } from "../src/scenes.js";
import { normalizeSceneObject } from "../src/scene-objects.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";
import { createStudioTools, studioToolSchemas } from "../bin/agent/studio-tools.mjs";

const legacy = process.argv.includes("--legacy");
assert(process.argv.slice(2).every(arg => arg === "--legacy"), "only --legacy is supported");
process.env.QA_URL ||= "http://127.0.0.1:5197/app/";
process.env.CDP_PORT ||= "9247";
process.env.COZYCLAY_LIVE_PORT ||= "5497";
const evidenceDirectory = new URL("../.omo/evidence/issue-398/", import.meta.url);
const log = (name, value) => console.log(`${name} ${JSON.stringify(value)}`);
const results = [];
let browser, profile, b, controller;

async function assertion(number, name, action) {
	try {
		await action(); results.push({ number, name, status: "PASS" });
		console.log(`PASS ${number}: ${name}`);
	} catch (error) {
		results.push({ number, name, status: "FAIL", error: error.stack });
		console.error(`FAIL ${number}: ${name}\n${error.stack}`);
	}
}

// Chrome readiness is its exact DevTools announcement, not a timer probe.
async function launchChrome() {
	profile = await mkdtemp(join(tmpdir(), "cozyclay-398-chrome-"));
	browser = spawnOwned(process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
		"--headless=new", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
		`--remote-debugging-port=${process.env.CDP_PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1600,1000", "about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	await new Promise((resolve, reject) => {
		let output = "";
		const cleanup = () => { clearTimeout(timer); browser.stderr.off("data", onData); browser.off("exit", onExit); browser.off("error", onError); };
		const onData = data => { output += data; if (output.includes("DevTools listening on")) { cleanup(); resolve(); } };
		const onExit = code => { cleanup(); reject(Error(`Chrome exited ${code}: ${output}`)); };
		const onError = error => { cleanup(); reject(error); };
		const timer = setTimeout(() => { cleanup(); reject(Error(`Chrome DevTools deadline: ${output}`)); }, 45000);
		browser.stderr.on("data", onData); browser.once("exit", onExit); browser.once("error", onError);
	});
	log("CHROME", { pid: browser.pid, profile, swiftShader: true });
}

async function command(name, args = {}, handle) {
	const reply = await controller.request({ type: "cmd", name, args, workspaceHandle: handle, timeoutMs: 30000 }, { timeoutMs: 30000 });
	assert.equal(reply.ok, true, JSON.stringify(reply.error));
	return reply.value;
}
// The wire identity is exactly the four document fields; `surface` and
// `workspaceHandle` belong to the context host, not to an admission envelope.
const identity = context => Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map(key => [key, context.host[key]]));
const inspect = async handle => (await command("inspect_studio", { scope: "scene" }, handle)).context;
const mutate = (name, args, context) => command(name, {
	name, args, commandId: randomUUID(), host: identity(context), expectedRevision: context.revision.scene,
}, context.host.workspaceHandle);
const describe = handle => command("describe", {}, handle);
const object = (description, id) => description.objects.find(row => row.id === id);
const key = async (name, code, modifiers = 0) => {
	for (const type of ["keyDown", "keyUp"]) await b.send("Input.dispatchKeyEvent", { type, key: name, code, modifiers });
};
const nativeUndo = async () => {
	await b.evaluate("document.activeElement?.blur()");
	await key("z", "KeyZ", process.platform === "darwin" ? 4 : 2);
};
const history = () => b.evaluate("window.__sceneHistory()");
const dom = async label => log(`DOM ${label}`, await b.evaluate(`({
	url: location.href, visibility: document.visibilityState,
	stage: document.querySelector('.stage')?.outerHTML.slice(0, 500),
	selection: document.querySelector('.hierarchy-row-wrap.selected')?.outerHTML,
	toast: [...document.querySelectorAll('[role="status"], .toast')].map(node => node.outerHTML),
	history: window.__sceneHistory(), rigReady: !!window.__cozyclay?.rigA,
})`));
const admitted = (receipt, context) => {
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
	assert.equal(receipt.status, "applied", JSON.stringify(receipt));
	assert.equal(receipt.authored, true);
	assert.equal(receipt.revision.before, context.revision.scene);
	assert.equal(receipt.revision.after, receipt.revision.before + 1);
};

async function seedReconstruction() {
	const snapshot = JSON.parse(await readFile(process.env.QA_SCENE_SNAPSHOT || new URL("failed-session-scene-snapshot.json", evidenceDirectory), "utf8"));
	const { meta } = snapshot, camera = meta.camera;
	const dx = camera.lookAt.x - camera.position.x, dy = camera.lookAt.y - camera.position.y, dz = camera.lookAt.z - camera.position.z;
	const framing = { pos: camera.position, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), fovDeg: 45 };
	const sceneId = "scene-failed-session-reconstruction";
	const document = { version: 4, activeSceneId: sceneId, scenes: [{
		id: sceneId, name: meta.scene.name,
		objects: snapshot.objects.map(row => normalizeSceneObject({
			id: row.id, name: row.name, renderer: row.renderer ?? "cube",
			x: row.position?.x ?? 0, y: row.position?.y ?? 0, z: row.position?.z ?? 0,
			rot: row.rotationDeg?.y ?? row.yawDeg ?? 0, rotX: row.rotationDeg?.x ?? 0, rotZ: row.rotationDeg?.z ?? 0,
			scaleX: row.scale?.x ?? 1, scaleY: row.scale?.y ?? 1, scaleZ: row.scale?.z ?? 1, parent: row.parentId ?? null,
		})),
		stage: createSceneStage({ shotAspect: meta.scene.aspect, characters: snapshot.characters.map(row => ({
			id: row.id, model: "y-bot-tpose", subject: row.name, ...row.position, rot: row.yawDeg, scale: row.scale,
		})) }),
		shotDocument: createShotAuthoringDocument({ frameCount: meta.scene.frameCount, shots: [{
			id: meta.shot.id, name: meta.shot.name, startFrame: meta.shot.range.startFrame, endFrame: meta.shot.range.endFrameExclusive - 1,
			camera: { mode: "keys" }, cameraKeys: [0, 186].map(frame => ({ id: `reconstruction-key-${frame}`, frame, framing })),
		}] }),
	}] };
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`localStorage.clear(); localStorage.setItem('${SCENES_STORAGE_KEY}', ${JSON.stringify(JSON.stringify(document))});
		localStorage.setItem('cozyclay.locale', 'en'); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({name:'Issue 398 QA', updatedAt:1}));`);
	log("RECONSTRUCTION", { objects: snapshot.objects.length, missingObjects: meta.scene.objectCount - snapshot.objects.length,
		nameOnlyRows: snapshot.objects.filter(row => !row.renderer).length, frameCount: meta.scene.frameCount, aspect: meta.scene.aspect,
		cameraKeys: "approximated at 0/186 with 45-degree FOV, as in the diagnostic", model: "y-bot-tpose" });
}

async function issue398(handle) {
	const initial = await inspect(handle);
	log("INITIAL", { host: initial.host, revision: initial.revision, scene: initial.scene, shot: initial.shot, rigReady: initial.capabilities.rigReady });
	assert.equal(initial.scene.objectCount, 36); assert.equal(initial.scene.frameCount, 432);
	assert.equal(initial.scene.aspect, "9:16"); assert.equal(initial.capabilities.rigReady, true);
	await dom("seeded-editor");

	await assertion(1, "published transform schema and catalogue per-axis ranges", async () => {
		const catalogue = await command("inspect_studio", { scope: "catalogue" }, handle);
		// This is the actual model-facing schema supplier, not a test-built schema.
		const schema = studioToolSchemas().find(tool => tool.name === "patch_elements").parameters;
		const branches = schema.properties.ops.items.oneOf;
		const expected = {
			"character.position": [[-240, 0, -240], [240, 240, 240]],
			"object.position": [[-240, 0, -240], [240, 240, 240]],
			"object.rotation": [[-180, -180, -180], [180, 180, 180]],
			"object.scale": [[0.01, 0.01, 0.01], [100, 100, 100]],
		};
		const evidence = [];
		for (const [path, [min, max]] of Object.entries(expected)) {
			const [kind, field] = path.split(".");
			const descriptor = catalogue.patchable[kind].find(row => row.path === path);
			const value = branches.find(branch => branch.properties.target.properties.kind.const === kind).properties.set.properties[field];
			evidence.push({ path, descriptor, schema: value });
			log("RANGE", evidence.at(-1));
			assert.equal(descriptor?.type, "vec3"); assert.equal(value.additionalProperties, false);
			assert.deepEqual(value.required, ["x", "y", "z"]);
			for (const [i, axis] of ["x", "y", "z"].entries()) {
				assert.equal(descriptor.min[axis], min[i], `${path}.${axis} catalogue min`);
				assert.equal(descriptor.max[axis], max[i], `${path}.${axis} catalogue max`);
				assert.equal(value.properties[axis].minimum, min[i], `${path}.${axis} schema min`);
				assert.equal(value.properties[axis].maximum, max[i], `${path}.${axis} schema max`);
			}
		}
	});

	await assertion(2, "13-op patch rejects without authoring or silent clamp", async () => {
		const rows = (await readFile(process.env.QA_FAILED_SESSION || new URL("failed-session-91f3774c.jsonl", evidenceDirectory), "utf8")).trim().split("\n").map(JSON.parse);
		const patch = rows.flatMap(row => row.message?.content ?? []).find(item => item.type === "toolCall" && item.name === "patch_elements").arguments;
		assert.equal(patch.ops.length, 13);
		assert.equal(patch.ops.filter(op => op.set.scale?.y === 0.06).length, 7);
		const before = await inspect(handle), original = await describe(handle), depth = await history();
		for (const op of patch.ops) assert(object(original, op.target.id), `reconstructed target ${op.target.id}`);
		const receipt = await mutate("patch_elements", patch, before);
		const after = await inspect(handle), actual = await describe(handle);
		log("REJECTION", { args: patch, receipt, before: before.revision, after: after.revision, historyBefore: depth, historyAfter: await history() });
		assert.equal(receipt.ok, false); assert.equal(receipt.code, "INVALID_ARGUMENT");
		assert.equal(receipt.mutated, false); assert.equal(receipt.preserved.authoredState, "unchanged");
		assert.equal(after.revision.scene, before.revision.scene);
		assert.deepEqual(actual.objects, original.objects, "none of the 13 targets or other objects change");
		assert.deepEqual(await history(), depth);
	});

	await assertion(3, "native editor Undo changes revision; fresh-context mutation succeeds exactly once", async () => {
		const before = await inspect(handle), original = object(await describe(handle), "cube-27"), depth = await history();
		const firstArgs = { ops: [{ target: { kind: "object", id: original.id }, set: { position: { x: original.x + 0.1, y: original.y, z: original.z } } }] };
		let first;
		await b.change(`window.__sceneHistory().past === ${depth.past + 1}`, async () => { first = await mutate("patch_elements", firstArgs, before); });
		log("FIRST_MUTATION", first); admitted(first, before);
		assert.equal((await inspect(handle)).revision.scene, first.revision.after);
		// Real platform keyboard input reaches App's native history handler.
		await b.change(`window.__sceneHistory().past === ${depth.past} && window.__sceneHistory().future === 1`, nativeUndo);
		const fresh = await inspect(handle), undone = object(await describe(handle), original.id);
		log("INTERACTIVE_UNDO", { before: first.revision.after, fresh: fresh.revision, original, undone });
		await dom("after-native-undo");
		assert.equal(fresh.revision.scene, first.revision.after + 1);
		assert.deepEqual(undone, original, "native Undo restores actual authored transform");
		const nextArgs = { ops: [{ target: { kind: "object", id: original.id }, set: { position: { x: original.x + 0.2, y: original.y, z: original.z } } }] };
		// Prove strict admission survives; this knowingly stale request must not mutate.
		const stale = await mutate("patch_elements", nextArgs, { ...fresh, revision: { ...fresh.revision, scene: first.revision.after } });
		assert.equal(stale.code, "STALE_SCENE"); assert.equal(stale.mutated, false);
		let next;
		await b.change(`window.__sceneHistory().past === ${depth.past + 1}`, async () => { next = await mutate("patch_elements", nextArgs, fresh); });
		const after = await inspect(handle), actual = object(await describe(handle), original.id);
		log("FRESH_MUTATION", { staleControl: stale, freshRevision: fresh.revision, receipt: next, after: after.revision, actual });
		admitted(next, fresh); assert.notEqual(next.code, "STALE_SCENE");
		assert.equal(after.revision.scene, next.revision.after); assert.equal(actual.x, original.x + 0.2);
	});

	await assertion(4, "#405 inspect re-admits after an editor-side change and entity inspect returns transforms", async () => {
		const before = await inspect(handle), original = object(await describe(handle), "cube-27"), initialDepth = await history();
		const args = { ops: [{ op: "update", id: original.id, position: { world: { x: original.x + 0.1, y: original.y, z: original.z } } }] };
		const admission = { host: identity(before), revision: before.revision.scene, commandId: () => randomUUID(),
			async refresh() { this.revision = (await inspect(handle)).revision.scene; } };
		const sent = [];
		const tools = createStudioTools({ workspaceHandle: handle, session: { admission },
			liveHub: { command(name, payload, workspace) { sent.push({ name, payload }); return command(name, payload, workspace); } } });
		const invoke = tools.internal.invoke;
		let first;
		await b.change(`window.__sceneHistory().past === ${initialDepth.past + 1}`, async () => { first = await invoke("arrange_objects", args); });
		admitted(first, before);
		await b.change(`window.__sceneHistory().past === ${initialDepth.past} && window.__sceneHistory().future === 1`, nativeUndo);
		assert.equal(admission.revision, first.revision.after, "native Undo is outside the agent turn");
		const fresh = (await invoke("inspect_studio", { scope: "scene" })).context;
		assert.equal(fresh.revision.scene, first.revision.after + 1);
		let second;
		await b.change(`window.__sceneHistory().past === ${initialDepth.past + 1}`, async () => { second = await invoke("arrange_objects", args); });
		admitted(second, fresh);
		assert.equal(sent.at(-1).payload.expectedRevision, fresh.revision.scene);
		assert.deepEqual(sent.at(-1).payload.args.ops, args.ops);
		const entity = await invoke("inspect_studio", { scope: "entities", ids: [original.id] });
		const row = entity.entities.find(item => item.id === original.id);
		log("ISSUE_405_RE_ADMIT", { first, freshRevision: fresh.revision, second, entity: row });
		assert.deepEqual(row.position, { x: original.x + 0.1, y: original.y, z: original.z });
	});

	await assertion(5, "applied receipt stays truthful through 60 seconds of real editor idle", async () => {
		const before = await inspect(handle), original = object(await describe(handle), "cube-27"), depth = await history();
		assert.equal(before.view.playing, false);
		let receipt;
		// Subscribe to App's real post-render history publication BEFORE mutation.
		await b.change(`window.__sceneHistory().past === ${depth.past + 1}`, async () => {
			receipt = await mutate("patch_elements", { ops: [{ target: { kind: "object", id: original.id }, set: { position: { x: original.x + 0.1, y: original.y, z: original.z } } }] }, before);
		});
		admitted(receipt, before);
		const immediate = await inspect(handle), poststate = await describe(handle), receiptBytes = JSON.stringify(receipt);
		assert.equal(immediate.revision.scene, receipt.revision.after);
		assert.equal(await b.evaluate("document.visibilityState"), "visible");
		log("IDLE_BEGIN", { receipt, revision: immediate.revision, history: await history() });
		const started = performance.now();
		// The sole fixed wait: elapsed idle time itself is the required behavior.
		await new Promise(resolve => setTimeout(resolve, 60000));
		const elapsedMs = performance.now() - started, after = await inspect(handle);
		const reconciled = await command("reconcile_studio_command", { commandId: receipt.commandId, host: identity(after) }, handle);
		log("IDLE_END", { elapsedMs, before: before.revision, immediate: immediate.revision, after: after.revision, reconciled });
		await dom("after-idle-60s");
		assert(elapsedMs >= 60000); assert.equal(after.view.playing, false);
		assert.equal(after.revision.scene, immediate.revision.scene);
		assert.equal(after.revision.physics, immediate.revision.physics);
		assert.deepEqual((await describe(handle)).objects, poststate.objects);
		assert.equal(JSON.stringify(receipt), receiptBytes);
		assert.equal(reconciled.status, "applied"); assert.deepEqual(reconciled.receipt, receipt);
		assert.equal(receipt.revision.before, before.revision.scene); assert.equal(receipt.revision.after, after.revision.scene);
	});
}

// Legacy #123 acceptance still uses genuine decoded PNG bytes, the real asset
// importer and native Undo; asynchronous completion uses state events, not polls.
function tinyPngDataUrl() {
	const crc32 = buffer => {
		let crc = 0xffffffff;
		for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
		return (crc ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]), head = Buffer.alloc(4), crc = Buffer.alloc(4);
		head.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, crc]);
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
	const raw = Buffer.alloc(16 * 49);
	for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) raw.set([0xd8, 0x3a, 0x2c], y * 49 + 1 + x * 3);
	return `data:image/png;base64,${Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}
async function legacy123(handle) {
	const shot = await command("capture_framing_png", {}, handle), png = Buffer.from(shot.dataUrl.split(",")[1], "base64");
	assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
	assert.equal(png.readUInt32BE(8), 13); assert.equal(png.toString("ascii", 12, 16), "IHDR");
	assert.equal(png.readUInt32BE(16), shot.width); assert.equal(png.readUInt32BE(20), shot.height);
	assert.equal(shot.width, 1920); assert.equal(shot.height, 1080); assert.equal(typeof shot.frame, "number");
	assert(shot.shotId === null || typeof shot.shotId === "string");
	log("LEGACY_CAPTURE", { width: shot.width, height: shot.height, frame: shot.frame, shotId: shot.shotId });
	for (const placeAs of ["cutout", "backdrop"]) {
		const before = await describe(handle), depth = await history(); let placed;
		await b.change(`window.__sceneHistory().past === ${depth.past + 1}`, async () => {
			placed = await command("import_asset", { name: "QA Red Card.png", mimeType: "image/png", dataUrl: tinyPngDataUrl(), placeAs }, handle);
		});
		assert.match(placed.assetId, /^img-[0-9a-f]{32}$/); assert(placed.objectId);
		const scene = await describe(handle), actual = object(scene, placed.objectId); assert.equal(actual.renderer, "cutout");
		if (placeAs === "backdrop") {
			const dx = actual.x - scene.camera.x, dz = actual.z - scene.camera.z, distance = Math.hypot(dx, dz), yaw = actual.rot * Math.PI / 180;
			assert(distance > 8); assert(Math.abs((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / distance + 1) < 0.05);
		}
		await b.change(`window.__sceneHistory().past === ${depth.past}`, nativeUndo);
		assert.deepEqual((await describe(handle)).objects, before.objects);
		log("LEGACY_IMPORT_UNDO", { placeAs, placed, restoredCount: before.objects.length });
	}
	console.log("PASS qa-agent-commands-browser legacy #123");
}

try {
	if (process.env.QA_OWN_BROWSER === "1") await launchChrome();
	b = await cameraBrowser();
	controller = await connectController(discoverEndpoint(Number(process.env.COZYCLAY_LIVE_PORT)));
	log("LIVE_SERVER", controller.server);
	await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
		let state;
		Object.defineProperty(window, '__sceneHistory', { configurable: true, get: () => state, set: value => {
			state = value; window.dispatchEvent(new Event('qa:camera-state'));
		} });
	})()` });
	if (legacy) await b.seed(); else await seedReconstruction();
	// A fresh page connection, subscribed before navigation; never select an
	// arbitrary workspace belonging to some other browser or the owner session.
	const since = controller.eventCount();
	const connected = controller.nextEvent("editor_connected", { since, timeoutMs: 45000 });
	connected.catch(() => {}); // The promise is explicitly awaited below.
	await b.navigate(process.env.QA_URL);
	const connection = await connected, handle = connection.payload.handle;
	await b.ready();
	await b.arm("typeof window.__sceneHistory === 'function'"); await b.settled();
	if (legacy) await legacy123(handle); else await issue398(handle);
} catch (error) {
	console.error("PROBE_SETUP_OR_RUN_FAILURE", error.stack);
	process.exitCode = 1;
	if (!legacy) for (let number = 1; number <= 5; number++) if (!results.some(row => row.number === number)) {
		results.push({ number, status: "FAIL", error: `Blocked by setup/run failure: ${error.message}` });
		console.error(`FAIL ${number}: blocked by setup/run failure`);
	}
} finally {
	controller?.close(); b?.close();
	if (browser) { await terminateOwned(browser); log("CHROME_CLOSED", { pid: browser.pid, exitCode: browser.exitCode, signalCode: browser.signalCode }); }
	if (profile) { await rm(profile, { recursive: true, force: true }); log("PROFILE_REMOVED", profile); }
	if (!legacy) {
		log("ASSERTIONS", results);
		console.log(`qa-agent-commands-browser issue-405: ${results.filter(row => row.status === "PASS").length}/5 PASS`);
		if (results.some(row => row.status !== "PASS")) process.exitCode = 1;
	}
}
