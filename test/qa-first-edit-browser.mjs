#!/usr/bin/env node
// #269: real editor input and isolated App mounts, observed at the track sink.
// QA_URL=http://127.0.0.1:5249/app/ CDP_PORT=9269 \
//   node tools/qa-browser.mjs -- node test/qa-first-edit-browser.mjs
//
// CDP patches ONLY the dev analytics response: sanitized track arguments are
// captured before its disabled-SDK return. Classifiers, dedupe, React callbacks,
// persistence, and input handlers are untouched. No real SDK/network is enabled.
// The camera harness subscribes before actions to DOM mutations, __cozyclay
// publication and Three's rotation notifications. Timers are failure deadlines,
// never sleeps or polling. Screenshots go outside git in a unique run directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSE } from "../src/poses.js";
import { createProjectDocument } from "../src/project.js";
import { cameraBrowser, assertPose } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const parentDir = process.env.QA_SHOT_DIR || tmpdir();
mkdirSync(parentDir, { recursive: true });
const shotDir = mkdtempSync(join(parentDir, "cozyclay-first-edit-"));
const b = await cameraBrowser();
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA browser has a page target for sink interception");
// Fetch interception belongs to this second CDP session. Never edit the served
// source on disk; the shared harness retains its input/state-observer session.
const interception = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("sink CDP connection timed out")), 10000);
	interception.onopen = () => { clearTimeout(timer); resolve(); };
	interception.onerror = (error) => { clearTimeout(timer); reject(error); };
});
let nextId = 0;
const pending = new Map();
const interceptionErrors = [];
const analyticsRequests = [];
let patchedResponses = 0;
let fixtureProject;
const fixturePath = "/scenes/qa-first-edit.cclayproject";
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`sink CDP timeout: ${method}`)); }, 45000);
	pending.set(id, { resolve, reject, timer });
	interception.send(JSON.stringify({ id, method, params }));
});
const sinkSignature = "export function track(event, props = {}) {";
async function patchSink({ requestId, responseStatusCode, responseHeaders }) {
	assert.equal(responseStatusCode, 200, "analytics module response succeeds");
	const response = await send("Fetch.getResponseBody", { requestId });
	const source = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
	assert.equal(source.split(sinkSignature).length, 2,
		"expected exactly one development track() sink; update QA interception if its signature changes");
	const instrumented = source.replace(sinkSignature, `${sinkSignature}
	globalThis.__qaFirstEditEvents.push({ event, props: sanitizeProps(event, props) });
	globalThis.dispatchEvent(new Event('qa:camera-state'));
`);
	await send("Fetch.fulfillRequest", {
		requestId, responseCode: 200,
		responseHeaders: responseHeaders.filter(({ name }) => !/^(content-length|content-encoding|etag)$/i.test(name)),
		body: Buffer.from(instrumented).toString("base64"),
	});
	patchedResponses += 1;
}
async function interceptResponse(params) {
	const path = new URL(params.request.url).pathname;
	if (path === "/src/analytics.js") return patchSink(params);
	// Stable network fixtures, not editor mocks: a healthy optional sidecar
	// prevents automatic demo motion racing pose-only sessions.
	// Playground uses its real preset parser/boot; it never reads Studio storage.
	assert.ok(path === "/ardy/health" || path === fixturePath, "known fixture boundary");
	const body = path === fixturePath ? fixtureProject
		: { ok: true, host: "qa", device: "cpu" };
	assert.ok(body, "Playground fixture was prepared before navigation");
	return send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200,
		responseHeaders: [{ name: "Content-Type", value: "application/json" }],
		body: Buffer.from(JSON.stringify(body)).toString("base64") });
}
interception.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id) {
		const request = pending.get(message.id);
		if (!request) return;
		clearTimeout(request.timer);
		pending.delete(message.id);
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	} else if (message.method === "Fetch.requestPaused") {
		void interceptResponse(message.params).catch(async (error) => {
			interceptionErrors.push(error.message);
			console.error(`FAIL sink interception: ${error.message}`);
			try { await send("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "Aborted" }); }
			catch (failure) { interceptionErrors.push(failure.message); }
		});
	} else if (message.method === "Network.requestWillBeSent") {
		const host = new URL(message.params.request.url).hostname;
		if (host === "t.cozyclay.org" || /(^|\.)posthog\.com$/.test(host)) analyticsRequests.push(message.params.request.url);
	}
};

const firstEvents = "window.__qaFirstEditEvents.filter(({ event }) => /^(craft|playground):first_edit$/.test(event))";
const legacyEvents = "window.__qaFirstEditEvents.filter(({ event }) => /^(craft|playground):first_action$/.test(event))";
const poseId = "qa-first-edit-pose";
const customPose = { ...DEFAULT_POSE, id: poseId, label: "QA pose", custom: true,
	bones: { ...DEFAULT_POSE.bones, lArm: [0.2, 0.3, -1.1] } };
const sceneId = "qa-first-edit-scene";
const shotId = "qa-first-edit-shot";
const projectScene = async () => JSON.parse(await b.evaluate("window.__cozyclayProject.export()")).scenes.scenes[0];
const currentPose = "window.__cozyclay.characters[0].pose";
const poseBones = `JSON.stringify((() => {
	const bones = [];
	window.__cozyclay.rigA.traverse((bone) => { if (bone.isBone) bones.push([bone.name, ...bone.quaternion.toArray()]); });
	return bones;
})())`;
async function screenshot(name) {
	const { data } = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, "base64"));
}
async function click(selector) {
	// Only DOM positioning, never .click() or a React callback.
	await b.evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error('missing control: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
	})()`);
	await b.click(selector);
}
async function expectEvents(surface, kind, label) {
	const actual = await b.evaluate(firstEvents);
	assert.deepEqual(actual, kind ? [{ event: `${surface}:first_edit`, props: { edit_kind: kind, definition_version: 2 } }] : [], label);
	assert.deepEqual(await b.evaluate(legacyEvents), [], "pose/rail/navigation do not widen legacy first_action");
	assert.equal(await b.evaluate("!!window.__cozyclayAnalytics?.instance"), false, "real analytics SDK stays disabled");
	console.log(`PASS ${surface} ${label}: ${JSON.stringify(actual)}`);
}
async function fresh(surface) {
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`(() => {
		localStorage.clear();
		localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.analyticsOptOut', '1');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'First-edit QA', updatedAt: Date.now() }));
		localStorage.setItem('cozyclay_poses', ${JSON.stringify(JSON.stringify([customPose]))});
		localStorage.setItem('${SCENES_STORAGE_KEY}', JSON.stringify({ version: 4, activeSceneId: ${JSON.stringify(sceneId)}, scenes: [{
			id: ${JSON.stringify(sceneId)}, name: 'First-edit QA', objects: [],
			shotDocument: { version: 4, frameCount: 144, waypoints: [], shots: [{
				id: ${JSON.stringify(shotId)}, name: 'Restored shot', startFrame: 0, endFrame: 143,
				camera: { mode: 'keys' }, cameraKeys: [],
			}] },
			stage: { characters: [{ id: 'qa-character', model: 'y-bot-tpose', x: 0, z: 0, rot: 0, hidden: false,
				pose: ${JSON.stringify(DEFAULT_POSE)}, subject: 'a person' }], hasCharSheet: false, shotAspect: '16:9' },
		}] }));
	})()`);
	fixtureProject = createProjectDocument({
		scenesDocument: await b.evaluate(`JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}'))`),
		customPoses: [customPose], name: "First-edit QA",
	});
	const url = new URL(b.base);
	url.search = "";
	if (surface === "playground") {
		url.searchParams.set("embed", "playground");
		url.searchParams.set("scene", fixturePath);
	}
	const before = patchedResponses;
	await b.navigate(url);
	await b.ready();
	assert.ok(patchedResponses > before, "fresh App mount loaded the intercepted analytics module");
	assert.equal(await b.evaluate("document.querySelector('.app').dataset.embedMode === 'playground'"), surface === "playground");
	assert.deepEqual(interceptionErrors, []);
	const restored = await projectScene();
	assert.equal(restored.id, sceneId, "storage fixture really restored");
	assert.equal(restored.shotDocument.shots[0].id, shotId, "rail/navigation setup restores a shot, never adds one");
	assert.equal(await b.evaluate("!!window.__cozyclay.motion"), false, "pose-only fixture has no motion to clear");
	await expectEvents(surface, null, "restored pose, library and shot are not edits");
}
async function applyPose(id) {
	await b.change("document.querySelector('[data-node-id=\"character:qa-character\"]')?.getAttribute('aria-selected') === 'true'", () =>
		click('[data-node-id="character:qa-character"] .hierarchy-row'));
	await b.change("!!document.querySelector('.pose-studio')", () => click('[aria-label="Open pose studio for Character 1"]'));
	await b.change(`document.querySelector('.pose-studio [data-pose-id="${id}"]')?.classList.contains('active')`, () =>
		click(`.pose-studio [data-pose-id="${id}"]`));
	await b.change("!document.querySelector('.pose-studio')", () => click('.pose-studio [data-pose-apply]'));
}
async function historyKey(redo) {
	await b.evaluate("document.activeElement?.blur()");
	const modifiers = 4 | (redo ? 8 : 0); // Meta (+ Shift) on the QA workstation.
	await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "KeyZ", key: "z", windowsVirtualKeyCode: 90, modifiers });
	await b.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyZ", key: "z", windowsVirtualKeyCode: 90, modifiers });
}
async function poseSession(surface) {
	await fresh(surface);
	const before = await b.evaluate(poseBones);
	await applyPose(poseId);
	assert.equal((await projectScene()).stage.characters[0].pose.id, poseId, "real Apply pose changed the serialized character pose");
	assert.notEqual(await b.evaluate(poseBones), before, "Apply pose changed the rendered rig's bone quaternions");
	await expectEvents(surface, "pose_edit", "pose-only emits once with numeric version 1");
	await b.change(`(${currentPose}).id === 'default'`, () => historyKey(false));
	assert.equal(await b.evaluate(poseBones), before, "Undo restores the actual rig");
	await expectEvents(surface, "pose_edit", "undo does not duplicate");
	await b.change(`(${currentPose}).id === '${poseId}'`, () => historyKey(true));
	await expectEvents(surface, "pose_edit", "redo does not duplicate");
	await applyPose(poseId); // a real repeated Apply callback; same pose is a no-op
	await expectEvents(surface, "pose_edit", "repeated Apply callback does not duplicate");
	await screenshot(`${surface}-pose-only`);
}
async function drawRail(offset = 0) {
	// The card's middle includes the camera-key strip and can be covered by
	// a startup toast. Its visible name is the unambiguous select-only target.
	await b.change("!!document.querySelector('.tl-camera-editor .tl-rail-draw')", () => click('.tl-shot-label b'));
	await b.change("document.querySelector('.app').dataset.railDraw === '1'", () => click('.tl-camera-editor .tl-rail-draw'));
	const box = await b.evaluate(`(() => { const r = document.querySelector('.vp-inset').getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
	assert.ok(box.width > 100 && box.height > 100, "real Top-View drawing surface is visible");
	const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.6 + offset };
	const oldRail = (await projectScene()).shotDocument.shots[0].camera.cameraRail;
	await b.change("document.querySelector('.app').dataset.railDraw !== '1'", async () => {
		await b.mouse("mousePressed", { ...from, button: "left", buttons: 1, clickCount: 1 });
		for (let i = 1; i <= 8; i += 1) {
			await b.mouse("mouseMoved", { x: from.x + box.width * 0.6 * i / 8, y: from.y - i * 2, button: "left", buttons: 1 });
		}
		await b.mouse("mouseReleased", { x: from.x + box.width * 0.6, y: from.y - 16, button: "left", buttons: 0, clickCount: 1 });
	});
	const rail = (await projectScene()).shotDocument.shots[0].camera.cameraRail;
	assert.notDeepEqual(rail, oldRail, "real stroke changes authored rail geometry");
	assert.ok(Array.isArray(rail) && rail.length >= 2, "stroke produces serialized rail geometry");
	assert.notDeepEqual(rail[0], rail.at(-1), "rail endpoints differ, not a click/no-op");
	console.log(`PASS real rail stroke: ${rail.length} control points, endpoints ${JSON.stringify([rail[0], rail.at(-1)])}`);
}
async function railSession(surface) {
	await fresh(surface);
	const poseBefore = await b.evaluate(`JSON.stringify(${currentPose})`);
	await drawRail();
	assert.equal(await b.evaluate(`JSON.stringify(${currentPose})`), poseBefore, "rail-only leaves the character pose untouched");
	await expectEvents(surface, "rail_edit", "rail-only emits once across all stroke callbacks");
	if (await b.evaluate("window.__cozyclay.lookThroughShot")) await b.change("!window.__cozyclay.lookThroughShot", () => b.escape());
	await drawRail(-25);
	await expectEvents(surface, "rail_edit", "a second real rail stroke does not duplicate");
	await screenshot(`${surface}-rail-only`);
}
async function navigationSession(surface) {
	await fresh(surface);
	const authored = await projectScene();
	const recordingCamera = await b.pose();
	const p = await b.centre('.stage canvas');
	let before = await b.pose('editorCam');
	await b.mouse("mouseMoved", { ...p });
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	await b.change(`Math.abs(window.__cozyclay.editorCam.rotation.y - ${before.yaw}) > 0.01`, () =>
		b.mouse("mouseMoved", { x: p.x + 90, y: p.y + 24, button: "right", buttons: 2 }));
	before = await b.pose('editorCam');
	const positionChanged = (pose) => `window.__cozyclay.editorCam.position.distanceTo({ x: ${pose.pos.x}, y: ${pose.pos.y}, z: ${pose.pos.z} }) > 0.01`;
	await b.change(positionChanged(before), () =>
		b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }));
	await b.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
	await b.change("document.pointerLockElement === null", () =>
		b.mouse("mouseReleased", { x: p.x + 90, y: p.y + 24, button: "right", buttons: 0, clickCount: 1 }));
	await expectEvents(surface, null, "right-drag and held-W fly navigation emit no edit");
	before = await b.pose('editorCam');
	await b.change(positionChanged(before), () => b.mouse("mouseWheel", { ...p, deltaX: 0, deltaY: -120 }));
	await expectEvents(surface, null, "wheel dolly emits no edit");
	before = await b.pose('editorCam');
	await b.change(`Math.abs(window.__cozyclay.editorCam.rotation.y - ${before.yaw}) > 0.01`, async () => {
		await b.mouse("mousePressed", { ...p, button: "left", buttons: 1, modifiers: 1, clickCount: 1 });
		await b.mouse("mouseMoved", { x: p.x + 90, y: p.y, button: "left", buttons: 1, modifiers: 1 });
		await b.mouse("mouseReleased", { x: p.x + 90, y: p.y, button: "left", buttons: 0, modifiers: 1, clickCount: 1 });
	});
	await expectEvents(surface, null, "Alt-left orbit emits no edit");
	assertPose(await b.pose(), recordingCamera, "free navigation does not move the shot camera");
	// Studio's glass shell enters shot-look from the Shot Camera card in the
	// dock and hides the preview inset's button (#570); Playground keeps the
	// inset button. Each surface uses the control its user sees.
	const lookThrough = surface === "craft" ? ".dock-shot-card .dock-shot-look" : ".vp-look-through";
	await b.change("window.__cozyclay.lookThroughShot", () => click(lookThrough));
	await b.change("!window.__cozyclay.lookThroughShot", () => b.escape());
	assert.deepEqual(await projectScene(), authored, "navigation and look-through leave authored scene state unchanged");
	await expectEvents(surface, null, "look-through entry/exit emits no edit");
	await screenshot(`${surface}-navigation-only`);
}
let failures = 0;
try {
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
	await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__qaFirstEditEvents = [];" });
	await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Network.setBlockedURLs", { urls: ["*://t.cozyclay.org/*", "*://*.posthog.com/*", "*://posthog.com/*"] });
	await send("Fetch.enable", { patterns: [
		{ urlPattern: `${b.base.origin}/src/analytics.js*`, requestStage: "Response" },
		{ urlPattern: `${b.base.origin}/ardy/health*`, requestStage: "Request" },
		{ urlPattern: `${b.base.origin}${fixturePath}`, requestStage: "Request" },
	] });
	for (const surface of ["craft", "playground"]) {
		// Playground intentionally has no visible pose-authoring UI. Do not
		// unhide it or call an edit hook and mislabel that as real UI coverage.
		const scenarios = [
			...(surface === "craft" ? [["pose-only", poseSession]] : []),
			["rail-only", railSession], ["navigation-only", navigationSession],
		];
		for (const [name, scenario] of scenarios) {
			try { await scenario(surface); }
			catch (error) {
				failures += 1;
				console.error(`FAIL ${surface} ${name}: ${error.stack}`);
				try {
					console.error(`EVENTS ${surface} ${name}: ${JSON.stringify(await b.evaluate('window.__qaFirstEditEvents'))}`);
					await screenshot(`${surface}-${name}-FAIL`);
				} catch (captureError) { console.error(`FAIL evidence capture: ${captureError.message}`); }
			}
		}
	}
	assert.deepEqual(interceptionErrors, [], "every analytics interception succeeded");
	assert.deepEqual(analyticsRequests, [], "no real analytics network requests were attempted");
	console.log(`PASS analytics observation: ${patchedResponses} intercepted modules; no SDK enabled or analytics requests attempted`);
	console.log("COVERAGE NOTE Playground hides pose authoring: pose-only UI is tested in Studio; rail and navigation are tested on both surfaces.");
	console.log(`Screenshots: ${shotDir}`);
	console.log(`qa-first-edit-browser: ${failures ? `${failures} FAILED scenarios` : 'all 5 real-surface scenarios passed'}`);
	if (failures) process.exitCode = 1;
} finally {
	for (const request of pending.values()) clearTimeout(request.timer);
	interception.close();
	b.close();
}
