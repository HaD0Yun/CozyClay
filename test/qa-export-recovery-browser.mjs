#!/usr/bin/env node
// #276: real-browser export recovery. Start Vite separately; Chrome is owned by
// tools/qa-browser.mjs, never this script. DEV server required, not preview.
// QA_URL=http://127.0.0.1:5256/app/ CDP_PORT=9526 QA_OUT=/tmp/export-recovery-qa \
//   node tools/qa-browser.mjs -- node test/qa-export-recovery-browser.mjs
// The only module interception is #272's environment/SDK seam. The optional
// hosted-demo clip is blocked so this authored static-cut fixture stays static.
// Lifecycle,
// sanitizer, renderer, encoder and muxer remain production implementations.
// Native API wrappers observe real inputs and hold exact support/flush promises;
// no fixed sleeps, polling, synthetic export results or production failure hooks.
// Evidence proves pipeline/download handoff, NOT an OS save or PostHog delivery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const url = process.env.QA_URL || "http://127.0.0.1:5256/app/";
const port = Number(process.env.CDP_PORT || 9526);
const out = process.env.QA_OUT || "/tmp/export-recovery-qa";
const timeout = 180_000;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
assert.ok(target, "QA Chrome must expose a page target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const listeners = new Map();
const telemetry = [];
const checks = [];
const screenshots = [];
const pageErrors = [];
const routeErrors = [];
let routedModules = 0;
let failure = null;

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
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaExportRecord") telemetry.push(JSON.parse(message.params.payload));
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, timeout + 10_000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
function once(method) {
	return new Promise((resolve, reject) => {
		const group = listeners.get(method) || new Set();
		listeners.set(method, group);
		const timer = setTimeout(() => { group.delete(onEvent); reject(new Error(`Missing CDP event: ${method}`)); }, timeout);
		const onEvent = (params) => { group.delete(onEvent); clearTimeout(timer); resolve(params); };
		group.add(onEvent);
	});
}
async function evaluate(expression) {
	const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
	if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
	return response.result?.value;
}
const wait = (expression, label, milliseconds = timeout) => evaluate(`window.__qaRecovery.wait(() => (${expression}), ${JSON.stringify(label)}, ${milliseconds})`);
async function changeAndWait(expression, action, label) {
	await evaluate(`window.__qaRecovery.pendingState = window.__qaRecovery.wait(() => (${expression}), ${JSON.stringify(label)}); window.__qaRecovery.pendingState.catch(() => {}); true`);
	await action();
	await evaluate("window.__qaRecovery.pendingState");
}
async function click(selector, { modifiers = 0, disabled = false } = {}) {
	const box = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || (element.disabled && !${disabled})) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({ block: 'center', inline: 'center' });
		const rect = element.getBoundingClientRect();
		if (!rect.width || !rect.height) throw new Error('Invisible control: ' + ${JSON.stringify(selector)});
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...box, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, modifiers });
}
// #523: Export is File › Export ▸. Opening walks File then Export; closing
// clicks File again, which dismisses File and its Export flyout together.
async function menu(open = true) {
	if (await evaluate("!!document.querySelector('.export-menu')") === open) return;
	if (!open) {
		await changeAndWait("!document.querySelector('.menubar-menu')", () => click("[data-testid=menu-file]"), "File menu closed");
		return;
	}
	if (!await evaluate("!!document.querySelector('#export-menu-trigger')")) {
		await changeAndWait("!!document.querySelector('#export-menu-trigger')", () => click("[data-testid=menu-file]"), "File menu open");
	}
	await changeAndWait("!!document.querySelector('.export-menu')", () => click("#export-menu-trigger"), "Export menu open");
}
async function exportMenu(testid, modifiers = 0) {
	await menu();
	await click(`[data-testid='${testid}']`, { modifiers });
}
function pass(label, detail = {}) {
	checks.push({ label, ...detail });
	console.log(`PASS ${label}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

const framing = (x, z) => ({ pos: { x, y: 1.6, z }, yaw: x === 0 ? 0 : -x / 4, pitch: -0.08, fovDeg: 45 });
const scene = {
	version: 4, activeSceneId: "qa-recovery-scene",
	scenes: [{
		id: "qa-recovery-scene", name: "PRIVATE_SCENE_276", objects: [],
		shotDocument: { version: 4, frameCount: 8, waypoints: [], shots: [
			{ id: "qa-single", name: "PRIVATE_SINGLE_276", startFrame: 0, endFrame: 3, camera: { mode: "keys" }, cameraKeys: [{ id: "qa-key-0", frame: 0, framing: framing(-0.6, 5) }] },
			{ id: "qa-pair", name: "PRIVATE_PAIR_276", startFrame: 4, endFrame: 7, camera: { mode: "keys" }, cameraKeys: [{ id: "qa-key-4", frame: 4, framing: framing(0, 4) }, { id: "qa-key-7", frame: 7, framing: framing(1.2, 2.2) }] },
		] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "PRIVATE_SUBJECT_276" }], hasCharSheet: false, shotAspect: "16:9" },
	}],
};

function installBrowserFixture(sceneDocument, deadline, scenesKey) {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem(scenesKey, JSON.stringify(sceneDocument));
	const bus = new EventTarget();
	const qa = window.__qaRecovery = {
		events: [], downloads: [], native: null,
		signal: () => bus.dispatchEvent(new Event("change")),
		wait(predicate, label, milliseconds = deadline) {
			return new Promise((resolve, reject) => {
				const finish = (error, value) => {
					clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check);
					if (error) reject(error); else resolve(value);
				};
				const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
				const observer = new MutationObserver(check);
				const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), milliseconds);
				observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
				bus.addEventListener("change", check);
				check();
			});
		},
	};
	let cozyclay;
	const observedCameras = new WeakSet();
	Object.defineProperty(window, "__cozyclay", { configurable: true, get: () => cozyclay, set(value) {
		cozyclay = value;
		const camera = value?.shotCam;
		if (camera && !observedCameras.has(camera)) {
			observedCameras.add(camera);
			const update = camera.updateProjectionMatrix;
			camera.updateProjectionMatrix = function (...args) {
				const result = update.apply(this, args);
				qa.signal();
				return result;
			};
		}
		qa.signal();
	} });
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-276",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (!payload) return;
			qa.events.push(payload);
			window.__qaExportRecord(JSON.stringify(payload));
			qa.signal();
		},
	};
	const blobs = new Map();
	const createObjectURL = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (blob) => { const href = createObjectURL(blob); blobs.set(href, blob); return href; };
	const anchorClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (!this.download) return anchorClick.apply(this, arguments);
		qa.downloads.push({ name: this.download, href: this.href, blob: blobs.get(this.href) || null });
		qa.signal();
	};
	qa.camera = () => {
		const camera = window.__cozyclay.shotCam;
		return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect };
	};
	qa.editing = () => {
		const live = window.__cozyclay;
		const bones = [];
		live.rigA.traverse((node) => { if (node.isBone) bones.push({ name: node.name, position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray() }); });
		return {
			frame: live.tlFrame, playing: live.playing, meta: live.captureMeta(), camera: qa.camera(),
			character: live.characters[0], scale: live.characterScale, bones,
			selected: [...document.querySelectorAll('[aria-selected="true"][data-node-id]')].map((node) => node.dataset.nodeId),
			history: window.__sceneHistory(),
		};
	};
	qa.installNative = (options = {}) => {
		if (qa.native) throw new Error("Native fixture must be restored between scenarios");
		const Encoder = window.VideoEncoder;
		const Frame = window.VideoFrame;
		const original = { support: Encoder.isConfigSupported, configure: Encoder.prototype.configure, encode: Encoder.prototype.encode, flush: Encoder.prototype.flush, encoderClose: Encoder.prototype.close, frameClose: Frame.prototype.close, digest: crypto.subtle.digest };
		const state = qa.native = {
			configs: [], supportConfigs: [], frames: [], reads: [], createdEncoders: 0, closedEncoders: 0,
			createdFrames: 0, closedFrames: 0, supportEntered: false, flushEntered: false, hashEntered: false,
			activeEncoders: new Set(), activeFrames: new Set(), captureFramebuffers: new Set(), releasedFramebuffers: new Set(), digests: [], restored: false,
		};
		let supportHeld = Boolean(options.holdSupport);
		let flushHeld = Boolean(options.holdFlush);
		let hashHeld = Boolean(options.holdHash);
		const supportGate = new Promise((resolve) => { state.releaseSupport = () => { supportHeld = false; resolve(); }; });
		const flushGate = new Promise((resolve) => { state.releaseFlush = () => { flushHeld = false; resolve(); }; });
		const hashGate = new Promise((resolve) => { state.releaseHash = () => { hashHeld = false; resolve(); }; });
		crypto.subtle.digest = async function (...args) {
			const digest = await original.digest.apply(this, args);
			// Hold the second production pixel hash after one real frame has
			// completed, so the encoding screenshot includes truthful progress.
			if (hashHeld && state.createdFrames === 1) {
				state.hashEntered = true; qa.signal();
				await hashGate;
			}
			return digest;
		};
		Encoder.isConfigSupported = async function (config) {
			state.supportConfigs.push(structuredClone(config)); state.supportEntered = true; qa.signal();
			if (supportHeld) await supportGate;
			if (options.unsupported) return { supported: false, config };
			return original.support.call(Encoder, config);
		};
		window.VideoEncoder = new Proxy(Encoder, { construct(Target, args) {
			const encoder = new Target(...args);
			state.createdEncoders++; state.activeEncoders.add(encoder); qa.signal();
			return encoder;
		} });
		Encoder.prototype.configure = function (config) { state.configs.push(structuredClone(config)); return original.configure.call(this, config); };
		Encoder.prototype.encode = function (frame, config) {
			if (options.failEncodeAt === state.createdFrames) throw new DOMException("PRIVATE_ENCODER_PATH_276", "EncodingError");
			return original.encode.call(this, frame, config);
		};
		Encoder.prototype.flush = async function () {
			// Real codec completion happens first, then the application awaits this
			// exact gate. Cancel must release/close the encoder without our release.
			await original.flush.call(this);
			state.flushEntered = true; qa.signal();
			if (flushHeld) await flushGate;
		};
		Encoder.prototype.close = function () {
			const result = original.encoderClose.call(this);
			if (state.activeEncoders.delete(this)) state.closedEncoders++;
			qa.signal(); return result;
		};
		window.VideoFrame = new Proxy(Frame, { construct(Target, args) {
			const frame = new Target(...args);
			state.createdFrames++; state.activeFrames.add(frame);
			const input = args[1];
			const record = { width: input.codedWidth, height: input.codedHeight, timestamp: input.timestamp, duration: input.duration, camera: state.reads.at(-1)?.camera, hash: null };
			state.frames.push(record);
			const bytes = new Uint8Array(args[0].buffer, args[0].byteOffset, args[0].byteLength).slice();
			state.digests.push(crypto.subtle.digest("SHA-256", bytes).then((digest) => {
				record.hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); qa.signal();
			}));
			return frame;
		} });
		Frame.prototype.close = function () {
			const result = original.frameClose.call(this);
			if (state.activeFrames.delete(this)) state.closedFrames++;
			qa.signal(); return result;
		};
		const readPatches = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean).map((Type) => {
			const readPixels = Type.prototype.readPixels;
			const deleteFramebuffer = Type.prototype.deleteFramebuffer;
			Type.prototype.deleteFramebuffer = function (framebuffer) {
				const result = deleteFramebuffer.call(this, framebuffer);
				if (state.captureFramebuffers.has(framebuffer)) state.releasedFramebuffers.add(framebuffer);
				qa.signal(); return result;
			};
			Type.prototype.readPixels = function (...args) {
				if (state.activeEncoders.size) {
					const framebuffer = this.getParameter(this.READ_FRAMEBUFFER_BINDING ?? this.FRAMEBUFFER_BINDING);
					if (framebuffer) state.captureFramebuffers.add(framebuffer);
					// The capture camera clone uses the target dimensions, not the
					// editor camera aspect. Sample transform synchronously at readback.
					state.reads.push({ width: args[2], height: args[3], camera: { ...qa.camera(), aspect: args[2] / args[3] } });
					if (options.failRender && !state.renderFailed) { state.renderFailed = true; throw new Error("PRIVATE_RENDER_PATH_276"); }
				}
				return readPixels.apply(this, args);
			};
			return { Type, readPixels, deleteFramebuffer };
		});
		state.restore = () => {
			state.releaseSupport(); state.releaseFlush(); state.releaseHash();
			window.VideoEncoder = Encoder; window.VideoFrame = Frame;
			Encoder.isConfigSupported = original.support;
			Encoder.prototype.configure = original.configure; Encoder.prototype.encode = original.encode;
			Encoder.prototype.flush = original.flush; Encoder.prototype.close = original.encoderClose;
			Frame.prototype.close = original.frameClose;
			crypto.subtle.digest = original.digest;
			for (const { Type, readPixels, deleteFramebuffer } of readPatches) {
				Type.prototype.readPixels = readPixels; Type.prototype.deleteFramebuffer = deleteFramebuffer;
			}
			state.restored = true; qa.native = null; qa.signal();
		};
		state.proof = async () => {
			await Promise.all(state.digests);
			return { configs: state.configs, supportConfigs: state.supportConfigs, frames: state.frames, reads: state.reads,
				createdEncoders: state.createdEncoders, closedEncoders: state.closedEncoders, createdFrames: state.createdFrames, closedFrames: state.closedFrames,
				liveEncoders: state.activeEncoders.size, liveFrames: state.activeFrames.size,
				capturedFramebuffers: state.captureFramebuffers.size, releasedFramebuffers: state.releasedFramebuffers.size };
		};
	};
}

listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		if (new URL(request.request.url).pathname === "/demo/walk-then-stop.npz") {
			await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Aborted" });
			return;
		}
		const response = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
		assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam changed");
		source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-276', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
		const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
		assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam changed");
		source = source.replace(sdkImport, "await Promise.resolve({ default: window.__qaPosthog })");
		await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
		routedModules++;
	})().catch(async (error) => {
		routeErrors.push(error.message);
		try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); } catch (routeError) { routeErrors.push(routeError.message); }
	});
}]));

const lifecycle = (events) => events.filter(({ event }) => event.startsWith("export:attempt_"));
const durations = new Set(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]);
function assertAttempt(events, { kind, format, terminal = "succeeded", code }) {
	const attempts = lifecycle(events);
	assert.equal(attempts.length, 2, `one start + one terminal per attempt: ${JSON.stringify(attempts)}`);
	const [start, end] = attempts;
	assert.equal(start.event, "export:attempt_started");
	assert.equal(end.event, `export:attempt_${terminal}`);
	assert.match(start.properties.attempt_id, /^[a-f0-9]{32}$/);
	assert.equal(end.properties.attempt_id, start.properties.attempt_id);
	for (const record of attempts) {
		assert.equal(record.properties.export_kind, kind);
		assert.equal(record.properties.format, format);
		assert.equal(record.properties.surface, "studio");
		const keys = ["attempt_id", "export_kind", "format", "surface"];
		if (record === end) keys.push("duration_bucket", ...(code ? ["failure_code"] : []));
		assert.deepEqual(Object.keys(record.properties).sort(), keys.sort(), "exact sanitized allowlist; no retry/content properties");
	}
	assert.ok(durations.has(end.properties.duration_bucket));
	if (code) assert.equal(end.properties.failure_code, code);
	const legacy = events.filter(({ event }) => ["export:video_succeeded", "export:blocking_frame_succeeded", "export:keyframe_pack"].includes(event));
	const expected = terminal === "succeeded" ? { video: "export:video_succeeded", frame: "export:blocking_frame_succeeded" }[kind] : null;
	assert.equal(legacy.length, expected ? 1 : 0, "one legacy success only at its owning surface; no internal pack video event");
	if (expected) { assert.equal(legacy[0].event, expected); assert.deepEqual(legacy[0].properties, { format }); }
	return { attempt_id: start.properties.attempt_id, terminal, duration_bucket: end.properties.duration_bucket };
}
async function handoffs(label, offset, count, extension) {
	const files = await evaluate(`Promise.all(window.__qaRecovery.downloads.slice(${offset}).map(async ({name, href, blob}) => {
		const bytes = new Uint8Array(await (blob || await (await fetch(href)).blob()).arrayBuffer());
		let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
		return { name, bytes: btoa(binary), byteLength: bytes.length };
	}))`);
	assert.equal(files.length, count, `${label}: exact download handoff count`);
	const evidence = [];
	for (const [index, file] of files.entries()) {
		assert.ok(file.name.endsWith(`.${extension}`));
		const bytes = Buffer.from(file.bytes, "base64");
		assert.ok(bytes.length > 0);
		const path = `${out}/${label}-${index}.${extension}`;
		await writeFile(path, bytes);
		const detail = { name: file.name, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), path };
		if (extension === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		if (extension === "mp4") assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
		if (extension === "zip") {
			execFileSync("unzip", ["-t", path]);
			const entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
			assert.equal(entries.length, 6, "pack contains exactly first/last PNG, clip, camera, prompt and README");
			for (const suffix of ["/first.png", "/last.png", "/clip.mp4", "/camera.json", "/prompt.txt"]) assert.equal(entries.filter((entry) => entry.endsWith(suffix)).length, 1);
			const cameraEntry = entries.find((entry) => entry.endsWith("/camera.json"));
			detail.camera = JSON.parse(execFileSync("unzip", ["-p", path, cameraEntry], { encoding: "utf8" }));
			detail.entries = entries;
			for (const suffix of ["/first.png", "/last.png", "/clip.mp4"]) {
				const content = execFileSync("unzip", ["-p", path, entries.find((entry) => entry.endsWith(suffix))], { maxBuffer: 16 * 1024 * 1024 });
				assert.equal(content.subarray(suffix.endsWith("png") ? 1 : 4, suffix.endsWith("png") ? 4 : 8).toString(), suffix.endsWith("png") ? "PNG" : "ftyp");
			}
		}
		evidence.push(detail);
	}
	return evidence;
}
async function arm(label) {
	const eventOffset = telemetry.length;
	const downloadOffset = await evaluate("window.__qaRecovery.downloads.length");
	await evaluate(`(() => {
		const offset = window.__qaRecovery.events.length;
		window.__qaRecovery.terminal = window.__qaRecovery.wait(() => window.__qaRecovery.events.slice(offset).some(({event}) => /^export:attempt_(succeeded|failed|cancelled)$/.test(event)), ${JSON.stringify(label)});
		window.__qaRecovery.terminal.catch(() => {});
	})()`);
	return { label, eventOffset, downloadOffset };
}
async function finish(attempt, contract, count = 0) {
	await evaluate("window.__qaRecovery.terminal");
	await wait("document.querySelector('.topbar')?.dataset.recState !== 'recording'", "export renderer returned idle");
	const result = assertAttempt(telemetry.slice(attempt.eventOffset), contract);
	const files = await handoffs(attempt.label, attempt.downloadOffset, count, contract.format);
	pass(attempt.label, { ...result, files });
	return { ...result, files };
}
async function nativeScenario(options, action) {
	await evaluate(`window.__qaRecovery.installNative(${JSON.stringify(options)}); true`);
	let primaryError;
	try { return await action(); }
	catch (error) { primaryError = error; throw error; }
	finally {
		try {
			await evaluate("if (!window.__qaRecovery?.native) throw new Error('Native fixture was replaced by a navigation/HMR reload'); window.__qaRecovery.native.restore(); true");
		} catch (error) {
			if (!primaryError) throw error;
			routeErrors.push(`Native cleanup after ${primaryError.message}: ${error.message}`);
		}
	}
}
async function nativeProof(label, expectedFrames) {
	const proof = await evaluate("window.__qaRecovery.native.proof()");
	assert.equal(proof.liveEncoders, 0, `${label}: no live encoders`);
	assert.equal(proof.liveFrames, 0, `${label}: no live VideoFrames`);
	assert.equal(proof.capturedFramebuffers, proof.releasedFramebuffers, `${label}: every observed offscreen capture framebuffer released`);
	if (expectedFrames > 0) assert.ok(proof.capturedFramebuffers > 0, `${label}: real offscreen framebuffer observed`);
	assert.equal(proof.createdEncoders, proof.closedEncoders, `${label}: all created encoders closed`);
	assert.equal(proof.createdFrames, proof.closedFrames, `${label}: every VideoFrame closed`);
	if (expectedFrames != null) assert.equal(proof.frames.length, expectedFrames, `${label}: exact addressed input frame count`);
	await writeFile(`${out}/${label}-native.json`, JSON.stringify(proof, null, 2));
	return proof;
}
async function status(phase, kind) {
	await menu();
	await wait(`document.querySelector('[data-testid="export-status"]')?.dataset.phase === ${JSON.stringify(phase)} && document.querySelector('[data-testid="export-status"]')?.dataset.kind === ${JSON.stringify(kind)}`, `${kind} ${phase} status`, 12_000);
}
async function captureStatus(phase, kind, label = phase) {
	for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
		await menu(false);
		await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: device === "mobile" });
		await status(phase, kind);
		const controls = await evaluate(`(() => {
			return ['export-status', 'export-retry', 'export-cancel'].flatMap((id) => [...document.querySelectorAll('[data-testid="' + id + '"]')].map(element => {
				const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
				return { id, text: element.innerText, disabled: !!element.disabled, fontSize: parseFloat(style.fontSize), rect: { x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom, width:rect.width, height:rect.height }, overflow: element.scrollWidth > element.clientWidth + 1 };
			}));
		})()`);
		console.log("QA_RECOVERY_CONTROLS", JSON.stringify({ device, phase, kind, controls }));
		assert.ok(controls.some((control) => control.id === "export-status"));
		if (["preparing", "encoding", "finalizing"].includes(phase)) assert.ok(controls.some((control) => control.id === "export-cancel" && !control.disabled), "cancellable video exposes its enabled cancel control");
		if (phase === "failed" && label !== "unsupported-codec") assert.ok(controls.some((control) => control.id === "export-retry" && !control.disabled), "recoverable failure exposes enabled retry");
		for (const control of controls) {
			assert.ok(control.text.trim(), `${control.id} has readable content`);
			assert.ok(control.rect.width > 0 && control.rect.height > 0 && control.fontSize >= 11, `${control.id} rendered at readable size`);
			assert.ok(control.rect.x >= 0 && control.rect.y >= 0 && control.rect.right <= width + 1 && control.rect.bottom <= height + 1, `${control.id} remains inside ${width}px viewport`);
			assert.equal(control.overflow, false, `${control.id} does not overflow horizontally`);
		}
		const name = `${label}-${device}.png`;
		const image = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(`${out}/${name}`, Buffer.from(image.data, "base64"));
		screenshots.push({ name, phase, kind, width, height, controls });
	}
	await menu(false);
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await menu();
}
async function scrub(frame) {
	await menu(false);
	await changeAndWait(`window.__cozyclay.tlFrame === ${frame}`, () => evaluate(`window.__cozyclay.scrub(${frame})`), `playhead ${frame}`);
}
async function aspect(value) {
	// The output ratio is the Camera mode value in the G1 toolbar; its list
	// popover holds one item per aspect preset.
	const trigger = '[data-testid="ratio-value"]';
	const item = `[data-aspect="${value}"]`;
	await menu(false);
	if (!await evaluate(`!!document.querySelector(${JSON.stringify(trigger)})`)) {
		await changeAndWait(`!!document.querySelector(${JSON.stringify(trigger)})`,
			() => click('[data-mode-key="3"]'), "camera toolbar visible");
	}
	await changeAndWait(`!!document.querySelector(${JSON.stringify(item)})`, () => click(trigger), "output aspect list open");
	await changeAndWait(`window.__cozyclay.captureMeta().aspect === ${JSON.stringify(value)}`, () => click(item), `output aspect ${value}`);
}
const video = { kind: "video", format: "mp4" };
const failedVideo = (code) => ({ ...video, terminal: "failed", code });

try {
	await mkdir(out, { recursive: true });
	await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Runtime.addBinding", { name: "__qaExportRecord" });
	await send("Fetch.enable", { patterns: [
		{ urlPattern: "*/src/analytics.js*", requestStage: "Response" },
		{ urlPattern: "*/demo/walk-then-stop.npz", requestStage: "Request" },
	] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBrowserFixture.toString()})(${JSON.stringify(scene)}, ${timeout}, ${JSON.stringify(SCENES_STORAGE_KEY)});` });
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url }); await loaded;
	await wait("!!window.__cozyclay?.rigA && !!window.__cozyclay?.shotCam && typeof window.__cozyclay.captureMeta === 'function' && window.__qaRecovery.events.some(({event}) => event === '$pageview')", "Studio WebGL rig and real analytics sanitizer ready");
	assert.equal(await evaluate("typeof VideoEncoder"), "function", "real Chrome WebCodecs is required");
	assert.equal(await evaluate("window.__cozyclay.motion"), null, "authored static-cut fixture has no auto-seeded demo motion");
	await changeAndWait("document.querySelector('[data-node-id=\"character:char-a\"]')?.getAttribute('aria-selected') === 'true'", () => click('[data-node-id="character:char-a"] .hierarchy-row'), "ordinary editor selection");
	await scrub(4);
	pass("Studio, real WebGL/WebCodecs and sanitized analytics ready");

	const originalRequest = await evaluate("({ meta: window.__cozyclay.captureMeta(), editing: window.__qaRecovery.editing() })");
	assert.deepEqual(originalRequest.meta.frameRange, { start: 4, end: 7 });
	assert.equal(originalRequest.meta.shotIndex, 1);
	await writeFile(`${out}/original-request.json`, JSON.stringify({ ...originalRequest, authoredShot: scene.scenes[0].shotDocument.shots[1] }, null, 2));
	let baseline;
	// This fixture addresses the selected four-frame shot, not the timeline.
	// PR #747 made MenuBar's primary Video item explicitly export the timeline.
	await nativeScenario({ holdSupport: true, holdHash: true, holdFlush: true }, async () => {
		const attempt = await arm("video-success");
		await exportMenu("export-video-shot");
		await wait("window.__qaRecovery.native.supportEntered", "real codec support reached");
		await status("preparing", "video"); // Initial baseline red: missing #276 status seam.
		await captureStatus("preparing", "video");
		await evaluate("window.__qaRecovery.native.releaseSupport(); true");
		await wait("window.__qaRecovery.native.hashEntered", "second real frame hash reached");
		await captureStatus("encoding", "video");
		await evaluate("window.__qaRecovery.native.releaseHash(); true");
		await wait("window.__qaRecovery.native.flushEntered", "real encoder flush reached");
		await captureStatus("finalizing", "video");
		await evaluate("window.__qaRecovery.native.releaseFlush(); true");
		await finish(attempt, video, 1);
		await captureStatus("completed", "video");
		baseline = await nativeProof("video-success", 4);
		assert.equal(baseline.configs.length, 1);
		assert.equal(baseline.configs[0].width, originalRequest.meta.size.width);
		assert.equal(baseline.configs[0].height, originalRequest.meta.size.height);
		assert.equal(baseline.configs[0].framerate, originalRequest.meta.fps);
		assert.deepEqual(baseline.frames.map(({ timestamp }) => timestamp), [0, 1, 2, 3].map((index) => Math.round(index * 1_000_000 / originalRequest.meta.fps)));
		assert.deepEqual(baseline.reads[0].camera.position, [0, 1.6, 4], "actual WebGL capture starts at authored frame-4 camera");
		assert.deepEqual(baseline.reads.at(-1).camera.position, [1.2, 1.6, 2.2], "actual WebGL capture ends at authored frame-7 camera");
		assert.notEqual(baseline.frames[0].hash, baseline.frames.at(-1).hash, "camera move changes actual encoded pixels");
	});

	await nativeScenario({ unsupported: true }, async () => {
		const attempt = await arm("unsupported-codec");
		await exportMenu("export-video-shot");
		await finish(attempt, failedVideo("unsupported_codec"));
		await captureStatus("failed", "video", "unsupported-codec");
		const proof = await nativeProof("unsupported-codec", 0);
		assert.equal(proof.createdEncoders, 0, "unsupported encoding allocates no encoder");
	});

	await nativeScenario({ failRender: true }, async () => {
		const attempt = await arm("render-failure");
		await exportMenu("export-video-shot");
		await finish(attempt, failedVideo("render_failed"));
		await captureStatus("failed", "video", "render-failure");
		const proof = await nativeProof("render-failure", 0);
		assert.equal(proof.createdEncoders, 1, "render failure happened inside the real offscreen capture");
	});
	await nativeScenario({}, async () => {
		const attempt = await arm("render-retry");
		await menu(); await click('[data-testid="export-retry"]');
		await finish(attempt, video, 1);
		const proof = await nativeProof("render-retry", 4);
		assert.deepEqual(proof.frames, baseline.frames, "render retry uses the original pixels/camera/range/settings");
	});

	let failedId;
	await nativeScenario({ failEncodeAt: 4 }, async () => {
		const attempt = await arm("encode-failure");
		await exportMenu("export-video-shot");
		failedId = (await finish(attempt, failedVideo("encode_failed"))).attempt_id;
		await captureStatus("failed", "video", "encode-failure");
		const proof = await nativeProof("encode-failure", 4);
		assert.deepEqual(proof.frames, baseline.frames, "failed request encoded original frame range and camera before native encode failure");
	});

	// Change the actual editor between failure and retry: select another shot
	// with a different camera, change delivery resolution/aspect and cast scale.
	// Retry must use immutable old content yet leave these newer edits untouched.
	await scrub(0);
	await aspect("1:1");
	await changeAndWait("window.__cozyclay.characterScale === 1.2", () => evaluate("window.__cozyclay.setCharacterScale(1.2)"), "cast scale edited after failure");
	// React commits metadata before DualView applies the requested aspect.
	// Observe the actual projection update, not a delay or an intermediate
	// R3F canvas-aspect value, before taking the editing-state snapshot.
	await wait("window.__cozyclay.shotCam.aspect === 1", "edited square camera projection rendered");
	const beforeRetry = await evaluate("window.__qaRecovery.editing()");
	assert.notDeepEqual(beforeRetry.meta, originalRequest.meta);
	assert.equal(beforeRetry.meta.shotIndex, 0);
	assert.equal(beforeRetry.meta.aspect, "1:1");
	await nativeScenario({ holdSupport: true }, async () => {
		const attempt = await arm("immutable-retry");
		await menu(); await click('[data-testid="export-retry"]');
		await wait("window.__qaRecovery.native.supportEntered", "retry owns codec support gate");
		await status("preparing", "video");
		// Ordinary repeated UI clicks, plus same-turn calls through the EXISTING
		// live menu delegate, exercise both disabled UI and the synchronous lock.
		for (const id of ["export-video", "export-depth-video", "export-keyframe-pack"]) {
			await menu();
			assert.equal(await evaluate(`document.querySelector('[data-testid="${id}"]').disabled`), true, `${id} disabled while retry owns work`);
			await click(`[data-testid="${id}"]`, { disabled: true });
		}
		if (await evaluate("!!document.querySelector('[data-testid=export-retry]')")) {
			assert.equal(await evaluate("document.querySelector('[data-testid=export-retry]').disabled"), true);
			await click('[data-testid="export-retry"]', { disabled: true });
		}
		await evaluate("Promise.all([window.__cozyclay.exportShotVideo(), window.__cozyclay.exportShotVideo()])");
		assert.equal(lifecycle(telemetry.slice(attempt.eventOffset)).length, 1, "duplicate/cross-kind requests add no attempts or premature cancellation");
		assert.equal(await evaluate("window.__qaRecovery.downloads.length"), attempt.downloadOffset);
		await evaluate("window.__qaRecovery.native.releaseSupport(); true");
		const retried = await finish(attempt, video, 1);
		assert.notEqual(retried.attempt_id, failedId, "retry gets a fresh random attempt ID");
		const proof = await nativeProof("immutable-retry", 4);
		assert.deepEqual(proof.configs, baseline.configs, "retry encoder uses original resolution, fps, bitrate and codec, not edited settings");
		assert.deepEqual(proof.frames, baseline.frames, "retry pixels and per-frame camera exactly match original shot despite changed shot/aspect/cast");
	});
	const afterRetry = await evaluate("window.__qaRecovery.editing()");
	await writeFile(`${out}/retry-editing-state.json`, JSON.stringify({ beforeRetry, afterRetry }, null, 2));
	assert.deepEqual(afterRetry, beforeRetry, "retry preserves new editing state, camera, bones, selection, playhead and history");
	pass("immutable retry preserves original request and newer editing state; duplicate/cross-kind guards hold");

	await aspect("16:9");
	await changeAndWait("window.__cozyclay.characterScale === 1", () => evaluate("window.__cozyclay.setCharacterScale(1)"), "restore authored scale");
	await scrub(4);
	// Cancel at BOTH allocations boundaries. In flush, an actual configured
	// encoder and four VideoFrames have existed; zero-resource support cancel
	// alone would not demonstrate encoder cleanup. Gates remain held until after
	// terminal + closure assertions, so releasing the fixture cannot fake cleanup.
	for (const gate of ["support", "flush"]) {
		await nativeScenario(gate === "support" ? { holdSupport: true } : { holdFlush: true }, async () => {
			const attempt = await arm(`cancel-${gate}`);
			await exportMenu("export-video-shot");
			await wait(`window.__qaRecovery.native.${gate}Entered`, `cancel ${gate} gate entered`);
			await status(gate === "support" ? "preparing" : "finalizing", "video");
			await click('[data-testid="export-cancel"]');
			await finish(attempt, { ...video, terminal: "cancelled", code: "aborted" });
			const proof = await nativeProof(`cancel-${gate}`, gate === "support" ? 0 : 4);
			assert.equal(proof.createdEncoders, gate === "support" ? 0 : 1);
		});
	}
	await nativeScenario({}, async () => {
		const attempt = await arm("post-cancel-success");
		await exportMenu("export-video-shot"); await finish(attempt, video, 1);
		await nativeProof("post-cancel-success", 4);
	});

	await nativeScenario({}, async () => {
		const attempt = await arm("depth-success");
		await exportMenu("export-depth-video");
		await finish(attempt, { kind: "depth_video", format: "mp4" }, 1);
		await status("completed", "depth_video");
		await nativeProof("depth-success", 4);
	});
	for (const all of [false, true]) {
		await nativeScenario({}, async () => {
			const label = all ? "all-keyframe-packs" : "keyframe-pack";
			const attempt = await arm(label);
			await exportMenu("export-keyframe-pack", all ? 8 : 0);
			const result = await finish(attempt, { kind: "keyframe_pack", format: "zip" }, all ? 2 : 1);
			await status("completed", "keyframe_pack");
			await nativeProof(label, all ? 8 : 4);
			assert.deepEqual(result.files.map(({ camera }) => camera.frameRange), all ? [{ start: 0, end: 3 }, { start: 4, end: 7 }] : [{ start: 4, end: 7 }]);
			const pair = result.files.at(-1).camera;
			assert.deepEqual(pair.framing.start, framing(0, 4));
			assert.deepEqual(pair.framing.end, framing(1.2, 2.2));
		});
	}
	for (const [label, frame, count] of [["single-frame", 0, 1], ["paired-frames", 4, 2]]) {
		await scrub(frame);
		await changeAndWait("!!document.querySelector('.result-modal .modal-actions button:nth-child(2)')", () => evaluate("window.__cozyclay.prepareFrameExport()"), "real frame result modal");
		assert.equal(await evaluate("document.querySelectorAll('.result-modal img.preview').length"), count);
		if (count === 1) {
			await nativeScenario({ holdSupport: true }, async () => {
				const blocked = await arm("frame-cross-kind-guard");
				// Modal overlays the Export menu; use its existing live delegate to
				// start a real video, then ordinary coordinate-click the frame UI.
				await evaluate("window.__qaRecovery.liveVideo = window.__cozyclay.exportShotVideo(); window.__qaRecovery.liveVideo.catch(() => {}); true");
				await wait("window.__qaRecovery.native.supportEntered", "frame cross-kind support gate");
				assert.equal(await evaluate("document.querySelector('.result-modal .modal-actions button:nth-child(2)').disabled"), true, "frame handoff disabled while video owns export");
				await click(".result-modal .modal-actions button:nth-child(2)", { disabled: true });
				assert.equal(lifecycle(telemetry.slice(blocked.eventOffset)).length, 1);
				assert.equal(await evaluate("window.__qaRecovery.downloads.length"), blocked.downloadOffset);
				await evaluate("window.__qaRecovery.native.releaseSupport(); true");
				await evaluate("window.__qaRecovery.liveVideo");
				await finish(blocked, video, 1);
				await nativeProof("frame-cross-kind-guard", 4);
			});
		}
		const previews = await evaluate(`Promise.all([...document.querySelectorAll('.result-modal img.preview')].map(async image => {
			const bytes = await (await fetch(image.src)).arrayBuffer();
			return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
		}))`);
		const attempt = await arm(label);
		await click(".result-modal .modal-actions button:nth-child(2)");
		const result = await finish(attempt, { kind: "frame", format: "png" }, count);
		assert.deepEqual(result.files.map(({ sha256 }) => sha256), previews, "handed-off PNG bytes exactly match real rendered preview(s)");
		await changeAndWait("!document.querySelector('.result-modal')", () => click(".result-modal .modal-head .x"), "frame modal closed");
		await status("completed", "frame");
	}

	const attempts = lifecycle(telemetry);
	const starts = attempts.filter(({ event }) => event === "export:attempt_started");
	assert.equal(new Set(starts.map(({ properties }) => properties.attempt_id)).size, starts.length);
	for (const start of starts) assert.equal(attempts.filter(({ properties }) => properties.attempt_id === start.properties.attempt_id).length, 2, "no unresolved/orphan/duplicate terminal across all scenarios");
	assert.equal(attempts.length, starts.length * 2);
	assert.equal(JSON.stringify(telemetry).includes("PRIVATE_"), false, "private scene/subject names and native error text never leave real sanitizer");
	assert.equal(routedModules, 1, "one real Studio sanitizer module routed");
	assert.deepEqual(routeErrors, []);
	assert.deepEqual(pageErrors, []);
	pass("all sanitized attempts paired exactly once with unique IDs and no private content or uncaught errors", { attempts: starts.length });
} catch (error) {
	failure = error.stack || String(error);
	console.error(failure);
	process.exitCode = 1;
	try {
		const image = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(`${out}/failure.png`, Buffer.from(image.data, "base64"));
	} catch (screenshotError) { pageErrors.push(`Failure screenshot: ${screenshotError.message}`); }
} finally {
	await mkdir(out, { recursive: true });
	await writeFile(`${out}/report.json`, JSON.stringify({ proof: "real WebGL/WebCodecs; native input/config/resource observations; sanitized SDK boundary, not OS save or live PostHog delivery", url, checks, screenshots, telemetry, routeErrors, pageErrors, failure }, null, 2));
	for (const item of pending.values()) clearTimeout(item.timer);
	ws.close();
}
if (!failure) console.log(`PASS export recovery browser QA; evidence: ${out}`);
