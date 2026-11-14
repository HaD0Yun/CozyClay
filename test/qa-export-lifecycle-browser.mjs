#!/usr/bin/env node
// #272: real WebGL/WebCodecs exports, download handoffs, and sanitized analytics.
// Start Vite separately; this runner neither starts a server nor owns Chrome.
// QA_URL=http://127.0.0.1:5252/app/ CDP_PORT=9522 node tools/qa-browser.mjs -- node test/qa-export-lifecycle-browser.mjs
// QA_OUT defaults to /tmp/export-lifecycle-qa. Requires a DEV server, not preview.
// The CDP analytics-module route changes only environment() and the SDK import:
// production track(), startExportAttempt(), sanitizeProps() and before_send stay
// real. This is a sanitized SDK-boundary spy, NOT proof of PostHog wire delivery.
// No event assertions use lastTrack, and no fixture adds production failure hooks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5252/app/").origin;
const port = Number(process.env.CDP_PORT || 9522);
const out = process.env.QA_OUT || "/tmp/export-lifecycle-qa";
const timeoutMs = 180_000;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const listeners = new Map();
const telemetry = [];
const pageErrors = [];
const routeErrors = [];
const checks = [];
let routedModules = 0;

ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id);
		pending.delete(message.id);
		clearTimeout(item.timer);
		if (message.error) item.reject(new Error(JSON.stringify(message.error)));
		else item.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	}
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaExportRecord") {
		telemetry.push(JSON.parse(message.params.payload));
	}
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, timeoutMs + 10_000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
function once(method) {
	return new Promise((resolve, reject) => {
		const group = listeners.get(method) || new Set();
		listeners.set(method, group);
		const timer = setTimeout(() => { group.delete(onEvent); reject(new Error(`Missing CDP event: ${method}`)); }, timeoutMs);
		const onEvent = (params) => { group.delete(onEvent); clearTimeout(timer); resolve(params); };
		group.add(onEvent);
	});
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function navigate(path) {
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url: `${origin}${path}` });
	await loaded;
}
const waitState = (expression, label) => evaluate(`window.__qaExport.wait(() => (${expression}), ${JSON.stringify(label)})`);
async function click(selector, modifiers = 0) {
	const box = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({ block: 'center', inline: 'center' });
		const rect = element.getBoundingClientRect();
		if (!rect.width || !rect.height) throw new Error('Control is not visible');
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await send("Input.dispatchMouseEvent", { type, ...box, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, modifiers });
	}
}
async function changeAndWait(expression, action, label) {
	// Install the observer before dispatching the input, not after a fast commit.
	await evaluate(`window.__qaExport.pendingState = window.__qaExport.wait(() => (${expression}), ${JSON.stringify(label)}); window.__qaExport.pendingState.catch(() => {}); true`);
	await action();
	await evaluate("window.__qaExport.pendingState");
}
async function exportMenu(testId, modifiers = 0) {
	// #523: Export is File › Export ▸.
	if (!await evaluate("!!document.querySelector('#export-menu-trigger')")) {
		await changeAndWait("!!document.querySelector('#export-menu-trigger')", () => click("[data-testid=menu-file]"), "File menu open");
	}
	if (!await evaluate("!!document.querySelector('.export-menu')")) {
		await changeAndWait("!!document.querySelector('.export-menu')", () => click("#export-menu-trigger"), "Export menu open");
	}
	await click(`[data-testid='${testId}']`, modifiers);
}
async function screenshot(name) {
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
}
function pass(label, detail = {}) {
	checks.push({ label, ...detail });
	console.log(`PASS ${label}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

const framing = (x, z) => ({ pos: { x, y: 1.6, z }, yaw: -x / 4, pitch: -0.08, fovDeg: 45 });
const scene = {
	version: 4, activeSceneId: "qa-export-scene",
	scenes: [{
		id: "qa-export-scene", name: "PRIVATE_SCENE_272", objects: [],
		shotDocument: { version: 4, frameCount: 8, waypoints: [], shots: [
			{ id: "qa-single", name: "PRIVATE_SINGLE_272", startFrame: 0, endFrame: 3, camera: { mode: "keys" }, cameraKeys: [{ id: "qa-key-0", frame: 0, framing: framing(0, 4) }] },
			{ id: "qa-pair", name: "PRIVATE_PAIR_272", startFrame: 4, endFrame: 7, camera: { mode: "keys" }, cameraKeys: [{ id: "qa-key-4", frame: 4, framing: framing(0, 4) }, { id: "qa-key-7", frame: 7, framing: framing(1.2, 2.2) }] },
		] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "PRIVATE_SUBJECT_272" }], hasCharSheet: false, shotAspect: "16:9" },
	}],
};
const graph = { version: 1, nodes: [{ id: "qa-scene", type: "scene", position: { x: 40, y: 40 }, data: { label: "CozyClay Scene", sceneName: "CozyClay Scene", status: "idle", preview: "scene" } }], edges: [] };

// Runs in every same-origin document, including Workflow's actual iframe.
function installBrowserFixture(sceneDocument, workflowGraph, deadline, scenesKey) {
	if (window === window.top) {
		localStorage.clear();
		localStorage.setItem("cozyclay.locale", "en");
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
		localStorage.setItem(scenesKey, JSON.stringify(sceneDocument));
		localStorage.setItem("cozyclay.workflow.v1", JSON.stringify(workflowGraph));
		const bus = new EventTarget();
		window.__qaExport = {
			events: [], downloads: [], messages: [], throwCapture: false,
			signal: () => bus.dispatchEvent(new Event("change")),
			wait(predicate, label) {
				return new Promise((resolve, reject) => {
					const finish = (error, value) => {
						clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check);
						if (error) reject(error); else resolve(value);
					};
					const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
					const observer = new MutationObserver(check);
					const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), deadline);
					observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
					bus.addEventListener("change", check);
					check();
				});
			},
		};
		window.addEventListener("message", (event) => {
			if (event.data?.type !== "cozyclay:export-keyframe-pack-result") return;
			const frame = document.querySelector(".cozy-scene-node iframe");
			if (event.source !== frame?.contentWindow) return;
			window.__qaExport.messages.push({ type: event.data.type, entries: event.data.entries?.length, byteLength: event.data.bytes?.byteLength, error: event.data.error || null });
			window.__qaExport.signal();
		});
	}
	const qa = window.top.__qaExport;
	let cozyclay;
	Object.defineProperty(window, "__cozyclay", {
		configurable: true,
		get: () => cozyclay,
		set(value) { cozyclay = value; qa.signal(); },
	});
	const context = window !== window.top ? "embed" : location.pathname.startsWith("/workflow") ? "workflow" : "studio";
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-272",
		capture(event, properties = {}) {
			if (qa.throwCapture) throw new Error("PRIVATE_ANALYTICS_FAILURE_272");
			const payload = beforeSend({ event, properties: { ...properties } });
			if (!payload) return;
			const record = { ...payload, context };
			qa.events.push(record);
			window.__qaExportRecord(JSON.stringify(record));
			qa.signal();
		},
	};
	const blobs = new Map();
	const createObjectURL = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (blob) => { const url = createObjectURL(blob); blobs.set(url, blob); return url; };
	const anchorClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (!this.download) return anchorClick.apply(this, arguments);
		qa.downloads.push({ name: this.download, href: this.href, blob: blobs.get(this.href) || null });
		qa.signal();
	};
}

// Fulfill Vite's transformed analytics module so relative dependency URLs stay
// intact. Fail closed if the expected environment/SDK seam changes upstream.
listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
		assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam changed");
		source = source.replace("return import.meta.env ?? {};", `return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-272', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };`);
		const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
		assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam changed");
		source = source.replace(sdkImport, "await Promise.resolve({ default: window.__qaPosthog })");
		await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
		routedModules += 1;
	})().catch(async (error) => {
		routeErrors.push(error.message);
		try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); } catch (failure) { routeErrors.push(failure.message); }
	});
}]));

const lifecycle = (events) => events.filter(({ event }) => event.startsWith("export:attempt_"));
const durations = new Set(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]);
function assertAttempt(events, { kind, format, surface = "studio", terminal = "succeeded", failure, legacy = null }) {
	const attempts = lifecycle(events);
	assert.equal(attempts.length, 2, `one started and exactly one terminal: ${JSON.stringify(attempts)}`);
	const [start, end] = attempts;
	assert.equal(start.event, "export:attempt_started");
	assert.equal(end.event, `export:attempt_${terminal}`);
	assert.match(start.properties.attempt_id, /^[a-f0-9]{32}$/);
	assert.equal(end.properties.attempt_id, start.properties.attempt_id);
	for (const record of attempts) {
		assert.equal(record.properties.export_kind, kind);
		assert.equal(record.properties.format, format);
		assert.equal(record.properties.surface, surface);
		// objects rides only where the caller knows the scene; retry_of only on a retry.
		const expectedKeys = ["attempt_id", "export_kind", "format", "surface", "is_retry",
			...(Object.hasOwn(record.properties, "objects") ? ["objects"] : []), ...(record.properties.is_retry ? ["retry_of"] : [])];
		if (record === end) expectedKeys.push("duration_bucket", ...(failure ? ["failure_code", "stage", "progress"] : []));
		assert.deepEqual(Object.keys(record.properties).sort(), expectedKeys.sort(), "exact sanitized property allowlist");
	}
	assert.ok(durations.has(end.properties.duration_bucket), "terminal has bucketMs duration");
	if (failure) assert.equal(end.properties.failure_code, failure);
	const compatibility = events.filter(({ event }) => ["export:video_succeeded", "export:blocking_frame_succeeded", "export:keyframe_pack"].includes(event));
	assert.equal(compatibility.length, legacy ? 1 : 0, "compatibility event count, including no nested video success");
	if (legacy) {
		assert.equal(compatibility[0].event, legacy);
		if (legacy !== "export:keyframe_pack") assert.deepEqual(compatibility[0].properties, { format });
	}
	return { attempt_id: start.properties.attempt_id, terminal, duration_bucket: end.properties.duration_bucket };
}
async function saveDownloads(label, from, count, extension) {
	const files = await evaluate(`Promise.all(window.__qaExport.downloads.slice(${from}).map(async ({name, href, blob}) => {
		const bytes = new Uint8Array(await (blob || await (await fetch(href)).blob()).arrayBuffer());
		let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
		return { name, bytes: btoa(binary), byteLength: bytes.length };
	}))`);
	assert.equal(files.length, count, `${label}: download handoff count`);
	for (const [index, file] of files.entries()) {
		assert.ok(file.name.endsWith(`.${extension}`));
		assert.ok(file.byteLength > 0, "handoff has nonempty bytes");
		const bytes = Buffer.from(file.bytes, "base64");
		const path = `${out}/${label}-${index}.${extension}`;
		await writeFile(path, bytes);
		if (extension === "png") assert.equal(bytes.subarray(1, 4).toString(), "PNG");
		if (extension === "mp4") assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
		if (extension === "zip") {
			const entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
			for (const suffix of ["/first.png", "/clip.mp4", "/camera.json", "/prompt.txt"]) assert.ok(entries.some((entry) => entry.endsWith(suffix)), `real archive contains ${suffix}`);
		}
	}
	return files.map(({ name, byteLength }) => ({ name, byteLength }));
}
async function runAttempt(label, contract, action, { downloads = 0, extension = contract.format } = {}) {
	const offset = telemetry.length;
	const from = await evaluate("window.__qaExport.downloads.length");
	await evaluate(`(() => {
		const from = window.__qaExport.events.length;
		window.__qaExport.terminal = window.__qaExport.wait(() => window.__qaExport.events.slice(from).some(({event}) => /^export:attempt_(succeeded|failed|cancelled)$/.test(event)), ${JSON.stringify(label)});
		window.__qaExport.terminal.catch(() => {});
	})()`);
	await action();
	await evaluate("window.__qaExport.terminal");
	await waitState("document.querySelector('.topbar')?.dataset.recState !== 'recording'", "export renderer returned idle");
	const proof = assertAttempt(telemetry.slice(offset), contract);
	const files = await saveDownloads(label, from, downloads, extension);
	pass(label, { ...proof, files });
}
async function scrub(frame) {
	await changeAndWait(`window.__cozyclay.tlFrame === ${frame}`, () => evaluate(`window.__cozyclay.scrub(${frame})`), `playhead at ${frame}`);
}

try {
	await mkdir(out, { recursive: true });
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Runtime.addBinding", { name: "__qaExportRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBrowserFixture.toString()})(${JSON.stringify(scene)}, ${JSON.stringify(graph)}, ${timeoutMs}, ${JSON.stringify(SCENES_STORAGE_KEY)});` });
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await navigate("/app/");
	await waitState("!!window.__cozyclay?.rigA && !!window.__cozyclay?.shotCam && typeof window.__cozyclay.exportShotVideo === 'function' && window.__qaExport.events.some(({event}) => event === '$pageview')", "Studio rig and sanitized analytics ready");
	assert.ok(await evaluate("typeof VideoEncoder === 'function'"), "Chrome must support real WebCodecs");
	pass("Studio and real analytics sanitizer ready");

	// A real editor selection before exporting, rather than hooks-only QA.
	await changeAndWait("document.querySelector('[data-node-id=\"character:char-a\"]')?.getAttribute('aria-selected') === 'true'", () => click('[data-node-id="character:char-a"] .hierarchy-row'), "character selected through editor");
	await screenshot("studio-desktop");
	await runAttempt("studio-video", { kind: "video", format: "mp4", legacy: "export:video_succeeded" }, () => exportMenu("export-video"), { downloads: 1 });

	// Native API fixtures preserve the real application, renderer, and lifecycle.
	await evaluate("window.__qaEncoderSupport = VideoEncoder.isConfigSupported; VideoEncoder.isConfigSupported = async config => ({supported:false, config}); true");
	try {
		await runAttempt("unsupported-codec", { kind: "video", format: "mp4", terminal: "failed", failure: "unsupported_codec" }, () => exportMenu("export-video"));
	} finally { await evaluate("VideoEncoder.isConfigSupported = window.__qaEncoderSupport; true"); }
	await evaluate("window.__qaEncode = VideoEncoder.prototype.encode; VideoEncoder.prototype.encode = function () { throw new DOMException('PRIVATE_ENCODER_PATH_272', 'EncodingError'); }; true");
	try {
		await runAttempt("encode-failure", { kind: "video", format: "mp4", terminal: "failed", failure: "encode_failed" }, () => exportMenu("export-video"));
	} finally { await evaluate("VideoEncoder.prototype.encode = window.__qaEncode; true"); }

	// Suspend the exact support-check promise. Abort through the explicit Cancel
	// action while recRef is owned; duplicate Video clicks are guarded (#276).
	await evaluate(`(() => {
		window.__qaExport.encoderEntered = new Promise(resolve => {
			VideoEncoder.isConfigSupported = config => new Promise((resume, reject) => {
				window.__qaExport.releaseEncoder = () => window.__qaEncoderSupport.call(VideoEncoder, config).then(resume, reject);
				resolve(true);
			});
		});
	})()`);
	try {
		await runAttempt("cancelled-video", { kind: "video", format: "mp4", terminal: "cancelled", failure: "aborted" }, async () => {
			await exportMenu("export-video");
			await evaluate("window.__qaExport.encoderEntered");
			await exportMenu("export-cancel");
			await evaluate("VideoEncoder.isConfigSupported = window.__qaEncoderSupport; window.__qaExport.releaseEncoder(); true");
		});
	} finally { await evaluate("VideoEncoder.isConfigSupported = window.__qaEncoderSupport; true"); }

	await runAttempt("studio-depth", { kind: "depth_video", format: "mp4" }, () => exportMenu("export-depth-video"), { downloads: 1 });
	await runAttempt("studio-pack", { kind: "keyframe_pack", format: "zip" }, () => exportMenu("export-keyframe-pack"), { downloads: 1 });
	await runAttempt("studio-all-packs", { kind: "keyframe_pack", format: "zip" }, () => exportMenu("export-keyframe-pack", 8), { downloads: 2 });
	// The QA seam is a reference export, not a user attempt: it must add no
	// export:attempt_* event (the UI cases above cover the keyframe lifecycle).
	{
		const offset = telemetry.length;
		const eventsFrom = await evaluate("window.__qaExport.events.length");
		const pack = await evaluate("window.__cozyclay.exportKeyframePack('qa-pair')");
		assert.ok(pack.byteLength > 0 && pack.entries.some((entry) => entry.endsWith('/last.png')));
		const bytes = Buffer.from(pack.bytes, "base64");
		assert.equal(bytes.length, pack.byteLength);
		await writeFile(`${out}/studio-pack-api.zip`, bytes);
		execFileSync("unzip", ["-t", `${out}/studio-pack-api.zip`]);
		const pageAttempts = await evaluate(`window.__qaExport.events.slice(${eventsFrom}).map(({event}) => event).filter((event) => event.startsWith("export:attempt_"))`);
		const recordedAttempts = telemetry.slice(offset).map(({ event }) => event).filter((event) => event.startsWith("export:attempt_"));
		assert.deepEqual(pageAttempts, [], "QA seam emits no export attempt in the page");
		assert.deepEqual(recordedAttempts, [], "QA seam records no export attempt");
		pass("studio-pack-api", { byteLength: pack.byteLength, attempts: 0 });
	}

	assert.ok(await evaluate("typeof window.__cozyclay.prepareFrameExport === 'function'"), "App QA surface must delegate prepareFrameExport() to live generate()");
	for (const [label, frame, count] of [["single-frame", 0, 1], ["paired-frames", 4, 2]]) {
		await scrub(frame);
		await changeAndWait("!!document.querySelector('.result-modal .modal-actions button:nth-child(2)')", () => evaluate("window.__cozyclay.prepareFrameExport()"), "real frame result modal");
		assert.equal(await evaluate("document.querySelectorAll('.result-modal img.preview').length"), count);
		await runAttempt(label, { kind: "frame", format: "png", legacy: "export:blocking_frame_succeeded" }, () => click(".result-modal .modal-actions button:nth-child(2)"), { downloads: count });
		await screenshot(label);
		await changeAndWait("!document.querySelector('.result-modal')", () => click(".result-modal .modal-head .x"), "result modal closed");
	}

	// A transport exception must not suppress the actual downloadable result.
	const beforeBrokenTransport = telemetry.length;
	const beforeDownloads = await evaluate("window.__qaExport.downloads.length");
	await evaluate("window.__qaExport.throwCapture = true; true");
	try {
		const result = await evaluate("window.__cozyclay.exportShotVideo().then(result => result && ({frames:result.frameCount, bytes:result.blob.size}))");
		assert.ok(result?.frames > 0 && result.bytes > 0, "analytics capture failure leaves real video export intact");
	} finally { await evaluate("window.__qaExport.throwCapture = false; true"); }
	assert.equal(telemetry.length, beforeBrokenTransport, "broken SDK does not falsely record delivery");
	await saveDownloads("analytics-unavailable", beforeDownloads, 1, "mp4");
	pass("analytics transport exception does not break export");

	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await runAttempt("mobile-video", { kind: "video", format: "mp4", legacy: "export:video_succeeded" }, () => exportMenu("export-video"), { downloads: 1 });
	await screenshot("studio-mobile");
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

	await navigate("/workflow/");
	await waitState("!!document.querySelector('.cozy-scene-send') && !!document.querySelector('.cozy-scene-node iframe')?.contentWindow.__cozyclay?.rigA && window.__qaExport.events.filter(({event}) => event === '$pageview').length === 2", "Workflow and embedded Studio ready");
	await runAttempt("workflow-send-to-ai", { kind: "keyframe_pack", format: "zip", surface: "workflow", legacy: "export:keyframe_pack" }, async () => {
		await changeAndWait("!!document.querySelector('.cozy-scene-send:disabled')", () => click(".cozy-scene-send"), "Send to AI pending state");
		await waitState("!document.querySelector('.cozy-scene-send').disabled && !!document.querySelector('.cozy-scene-node-status.status-complete.has-pack')", "Workflow pack complete");
	}, { downloads: 1 });
	const messages = await evaluate("window.__qaExport.messages");
	assert.equal(messages.length, 1, "exactly one actual iframe pack reply");
	assert.ok(messages[0].byteLength > 0 && messages[0].entries > 0 && !messages[0].error);
	const workflowEvent = telemetry.find(({ event }) => event === "export:keyframe_pack");
	assert.deepEqual(workflowEvent.properties, { entries: messages[0].entries, source: "workflow" }, "legacy Workflow payload survives real sanitizeProps");
	assert.equal(workflowEvent.context, "workflow");
	assert.equal(lifecycle(await evaluate("window.__qaExport.events")).filter(({ context }) => context === "embed").length, 0, "iframe internal video/pack has no second lifecycle");
	await screenshot("workflow-desktop");
	pass("Workflow parent owns one lifecycle across the real iframe boundary", { entries: messages[0].entries });

	// With no Workflow owner marker, the actual embed message entry point owns
	// its own lifecycle. requestKeyframePack subscribes before posting the action.
	await runAttempt("direct-embed-pack", { kind: "keyframe_pack", format: "zip", surface: "embed" }, async () => {
		const result = await evaluate(`(async () => {
			const {requestKeyframePack} = await import('/src/workflow/keyframe-pack-request.js');
			const pack = await requestKeyframePack(document.querySelector('.cozy-scene-node iframe').contentWindow);
			return {bytes:pack.bytes.byteLength, entries:pack.entries.length};
		})()`);
		assert.ok(result.bytes > 0 && result.entries > 0, "direct embed hands real archive bytes to requester");
	});

	await evaluate(`(() => {
		const frame = document.querySelector('.cozy-scene-node iframe').contentWindow;
		frame.__qaEncoderSupport = frame.VideoEncoder.isConfigSupported;
		frame.VideoEncoder.isConfigSupported = async config => ({supported:false, config});
	})()`);
	try {
		await runAttempt("workflow-unsupported-codec", { kind: "keyframe_pack", format: "zip", surface: "workflow", terminal: "failed", failure: "unsupported_codec" }, async () => {
			await click(".cozy-scene-send");
			await waitState("!document.querySelector('.cozy-scene-send').disabled && !!document.querySelector('.cozy-scene-node-status.status-error')", "Workflow displays iframe failure");
		});
	} finally {
		await evaluate(`(() => {
			const frame = document.querySelector('.cozy-scene-node iframe').contentWindow;
			frame.VideoEncoder.isConfigSupported = frame.__qaEncoderSupport;
		})()`);
	}
	pass("Workflow iframe encoder failure retains its normalized code without double counting");

	const allAttempts = lifecycle(telemetry);
	const started = allAttempts.filter(({ event }) => event === "export:attempt_started");
	assert.equal(new Set(started.map(({ properties }) => properties.attempt_id)).size, started.length, "random attempt IDs are unique across clicks and documents");
	for (const start of started) {
		const paired = allAttempts.filter(({ properties }) => properties.attempt_id === start.properties.attempt_id);
		assert.equal(paired.length, 2, "no unresolved or duplicate terminal event after the full suite");
	}
	assert.ok(!JSON.stringify(telemetry).includes("PRIVATE_"), "scene names, subjects and raw encoder/transport errors never leave the sanitizer");
	assert.ok(routedModules >= 3, "SDK spy was installed independently in Studio, Workflow and iframe");
	assert.deepEqual(routeErrors, [], "module routing has no errors");
	assert.deepEqual(pageErrors, [], "browser has no uncaught page errors");
	pass("all attempts paired once, unique IDs, no private content or uncaught errors", { attempts: started.length, routedModules });
} finally {
	await mkdir(out, { recursive: true });
	await writeFile(`${out}/report.json`, JSON.stringify({ proof: "real export pipeline; sanitized SDK-boundary spy, not live PostHog delivery", checks, telemetry, routeErrors, pageErrors }, null, 2));
	for (const item of pending.values()) clearTimeout(item.timer);
	ws.close();
}
console.log(`PASS export lifecycle browser QA; evidence: ${out}`);
