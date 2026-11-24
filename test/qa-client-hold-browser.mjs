#!/usr/bin/env node
// The Studio page while an agent turn holds the scene, and after a turn removed what the user had selected: headless
// Chrome on Vite with this repo's agent routes, the live hub and the pi runner; only the model is scripted. The user's
// own moves are real pointer events (CDP Input).
//   node test/qa-client-hold-browser.mjs   (ports: QA_PORT 5197, QA_LIVE_PORT 5397, QA_CDP_PORT 9344; QA_OUT dir)
// 1. The user selects a crate; a turn removes it; the turn's next inspect_studio reads the scene (no refusal for the
//    selection the removal left behind), and so does the next turn.
// 2. A turn has authored and waits: the user flies the shot camera (right drag, looking through it). The bus refuses
//    the framing once for the whole drag and the camera stands where the drag began (the scene's framing), not where
//    the hand left it; after the turn the same drag moves the camera and is kept.
// 3. In the same held turn the user draws a rail stroke in the Top-View: no page error, no rail written, the draw
//    mode stays on; after the turn the same stroke draws the rail.
// 4. A second held turn, the rail now drawn: Delete rail throws no page error and deletes nothing; a value typed into
//    the camera's Transform (no press: keys only) is refused and the camera goes back to where it stood at the key,
//    not to where an older press began; after the turn Delete rail deletes.
// Each refused move tells the user why in a notice (the page's locale: QA_LOCALE en or ko).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startLiveHub } from "../mcp/live-hub.mjs";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.QA_PORT || 5197), livePort = Number(process.env.QA_LIVE_PORT || 5397), cdpPort = Number(process.env.QA_CDP_PORT || 9344);
const out = process.env.QA_OUT || `${tmpdir()}/cozyclay-client-hold`;
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });
const children = [], checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
// each part is told on its own, so a run shows every part that fails
const failed = [];
const part = async (name, check) => { try { await check(); pass(name); } catch (error) { failed.push(name); console.log(`FAIL ${name}: ${error.message.slice(0, 400)}`); } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- the scripted model ---------------------------------------------------------------------------------------------
const gates = new Map();
const gate = name => { if (!gates.has(name)) { let open; const promise = new Promise(resolve => { open = resolve; }); gates.set(name, { promise, open }); } return gates.get(name); };
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
// the owner's last words (a Studio observation may follow them as a user message of its own)
const lastUserWords = messages => messages.filter(message => message.role === "user").map(textOf).findLast(text => text.includes("[[")) ?? "";
const calls = [];
let crate = null; // the id the page gives the crate
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `qa-${name}-${calls.length}` })]);
const fake = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
fake.fauxProvider.setResponses(Array.from({ length: 40 }, () => async context => {
	const messages = context.messages, words = lastUserWords(messages), last = messages.at(-1);
	const sinceUser = messages.slice(messages.findLastIndex(message => message.role === "user" && textOf(message).includes("[[")) + 1).filter(message => message.role === "toolResult");
	// the selection the turn's Studio context carries (the last one the model was given)
	const selection = [...JSON.stringify([context.systemPrompt ?? "", messages]).matchAll(/\\"selection\\":(null|\{[^}]*\})/g)].at(-1)?.[1].replaceAll("\\", "") ?? "none";
	calls.push({ words, selection, lastRole: last?.role, result: last?.role === "toolResult" ? textOf(last) : null, error: last?.role === "toolResult" ? Boolean(last.isError) : null });
	if (words.includes("[[remove]]")) {
		if (sinceUser.length === 0) return call("run_action", { action: "object.remove", args: { ids: [crate] } });
		if (sinceUser.length === 1) return call("inspect_studio", { scope: "scene" });
		return fauxAssistantMessage([fauxText("QA: the crate is gone.")]);
	}
	if (words.includes("[[look]]")) {
		if (sinceUser.length === 0) return call("inspect_studio", { scope: "scene" });
		return fauxAssistantMessage([fauxText("QA: looked.")]);
	}
	for (const [marker, name] of [["[[hold]]", "H"], ["[[hold again]]", "H2"]]) if (words.includes(marker)) {
		if (sinceUser.length === 0) return call("run_action", { action: "object.add", args: { kind: "cube", name: `Held box ${name}`, placement: { x: 3, y: 0, z: -3 } } });
		await gate(name).promise;
		return fauxAssistantMessage([fauxText("QA: the held turn ended.")]);
	}
	return fauxAssistantMessage([fauxText(`QA heard: ${words}`)]);
}));

// --- the sidecar, Vite and Chrome -----------------------------------------------------------------------------------
const hub = await startLiveHub(livePort);
assert.ok(hub, `QA must own live port ${livePort}`);
const agent = createAgentHandler({ auth: { getAccessToken: async () => "qa-token" }, codex: { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: {} }), listModels: async () => ["qa"] },
	models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, sessionStore: createSessionStore(`${out}/sessions-${Date.now()}`), supervisor: false, studioTasks: () => false, port: () => port });
const sidecar = createServer(async (req, res) => {
	const path = (req.url || "").split("?")[0];
	try {
		if (path === "/oauth/status") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedIn: true, email: "qa@example.invalid", plan: "Plus" })); return; }
		if (!(await agent(req, res, path)) && !res.writableEnded) res.writeHead(404).end();
	} catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error?.stack ?? error)); }
});
await new Promise(resolve => sidecar.listen(0, "127.0.0.1", resolve));
const own = child => { children.push(child); return child; };
own(spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: REPO, env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort), COZYCLAY_OAUTH_PORT: String(sidecar.address().port) }, stdio: "ignore" }));
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/app/`)).ok) break; } catch { /* not yet */ } await sleep(500); }
own(spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${out}/chrome-${Date.now()}`, "--window-size=1438,979", "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" }));
let target;
for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(entry => entry.type === "page"); } catch { /* not yet */ } if (!target) await sleep(250); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map(), errors = [], warnings = [];
let sequence = 0;
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(message.params.type)) warnings.push(message.params.args.map(arg => arg.value ?? arg.description ?? "").join(" "));
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const shot = async name => writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const waitFor = async (expression, label, ms = 30_000) => {
	for (let t = 0; t < ms; t += 150) { try { const value = await evaluate(expression); if (value) return value; } catch { /* page busy */ } await sleep(150); }
	await shot(`hold-timeout-${label.replace(/\W+/g, "-")}`).catch(() => {});
	throw new Error(`Timed out: ${label} calls=${JSON.stringify(calls.map(entry => [entry.words.slice(-40), entry.lastRole]))}`);
};
const mouse = (type, x, y, button = "left", buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 });
const click = async selector => {
	const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error("missing: " + ${JSON.stringify(selector)}); element.scrollIntoView({ block: "nearest" }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await mouse("mouseMoved", point.x, point.y, "none", 0); await mouse("mousePressed", point.x, point.y); await mouse("mouseReleased", point.x, point.y, "left", 0);
};
const press = async (key, code = key, keyCode = key === "Enter" ? 13 : 0) => {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
	if (key === "Enter") await send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", windowsVirtualKeyCode: 13 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
};
const say = async text => {
	for (let i = 0; i < 20 && !(await evaluate("document.activeElement?.classList.contains('agent-input')")); i++) { await click(".agent-input"); await sleep(150); }
	await send("Input.insertText", { text });
	await waitFor(`document.querySelector('.agent-input')?.value === ${JSON.stringify(text)}`, `typed ${text}`);
	await press("Enter");
};
const ended = async (marker, steps, label) => {
	for (let i = 0; i < 600 && calls.filter(entry => entry.words.includes(marker)).length < steps; i++) await sleep(100);
	return idle(label);
};
const idle = label => waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming' && !document.querySelector('.agent-send.stop')", label, 60_000);
// the shot camera as the page holds it, and the shot's stored framing
const camera = () => evaluate("(() => { const c = window.__cozyclay.shotCam; return { x: c.position.x, y: c.position.y, z: c.position.z, yaw: c.rotation.y, pitch: c.rotation.x }; })()");
const near = (a, b) => ["x", "y", "z", "yaw", "pitch"].every(key => Math.abs(a[key] - b[key]) < 1e-4);
const framingWarnings = () => warnings.filter(line => line.includes("the camera framing was not captured")).length;
// the notices shown since the last ask, and the one that names the agent's hold (agent-turn-hold.js) in the page's locale
const locale = process.env.QA_LOCALE === "ko" ? "ko" : "en";
const notices = () => evaluate("window.__qaToasts.splice(0)");
const quiet = async () => { await waitFor("!document.querySelector('.toast')?.textContent.trim()", "the last notice is gone"); await notices(); };
const namesHold = text => locale === "en" ? text === "The agent is editing the scene: wait for it, or press Stop to take over." : /[\uAC00-\uD7A3]/.test(text) && text.includes("Stop");
// a right-button fly drag across the main pane, as a hand looks around through the shot camera
async function fly() {
	const r = await evaluate("(() => { const r = window.__cozyclay.mainPane.getBoundingClientRect(); return { x: r.x + r.width * 0.45, y: r.y + r.height * 0.45 }; })()");
	await mouse("mouseMoved", r.x, r.y, "none", 0);
	await mouse("mousePressed", r.x, r.y, "right", 2);
	for (let i = 1; i <= 24; i++) { await mouse("mouseMoved", r.x + i * 6, r.y + i * 2, "right", 2); await sleep(20); }
	await mouse("mouseReleased", r.x + 144, r.y + 48, "right", 0);
	await sleep(400);
}
const scene = async () => JSON.parse(await evaluate("window.__cozyclayProject.export()")).scenes.scenes[0];
const rail = async () => JSON.stringify((await scene()).shotDocument.shots[0].camera.cameraRail ?? null);
// Delete rail sits under the camera editor's Advanced fold. At this window size the open fold's row is clipped by the
// one-line editor (the button lies under the timeline's head, out of a pointer's reach), so the button is pressed
// through its own click(), as test/verify-camera-rail-browser.mjs presses it.
async function deleteRail() {
	await waitFor("!!document.querySelector('.tl-camera-advanced .tl-camera-tool.danger')", "Delete rail shown");
	await evaluate("document.querySelector('.tl-camera-advanced .tl-camera-tool.danger').click()");
}
async function stroke() {
	const box = await evaluate("(() => { const r = document.querySelector('.vp-inset').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
	const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.6 };
	await mouse("mouseMoved", from.x, from.y, "none", 0);
	await mouse("mousePressed", from.x, from.y);
	for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + box.width * 0.6 * i / 8, from.y - i * 2);
	await mouse("mouseReleased", from.x + box.width * 0.6, from.y - 16, "left", 0);
	await sleep(400);
}

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Page.navigate", { url: `${origin}/favicon.ico` });
	await waitFor("document.readyState === 'complete'", "seed page");
	// a keys shot with one camera key, a crate the user selects, one character
	await evaluate(`(() => {
		const shot = { id: "hold-shot", name: "Hold", startFrame: 0, endFrame: 239,
			cameraKeys: [{ frame: 0, framing: { pos: { x: 0.5, y: 1.6, z: 5 }, yaw: 0, pitch: -0.1, fovDeg: 40 } }], camera: { mode: "keys" } };
		const scene = { version: 4, activeSceneId: "scene-hold", scenes: [{ id: "scene-hold", name: "HOLD QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 240, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a man" }], hasCharSheet: false, shotAspect: "16:9" } }] };
		localStorage.clear();
		localStorage.setItem("cozyclay.locale", ${JSON.stringify(locale)}); localStorage.setItem("cozyclay.agent.tasks", "off");
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Hold QA", updatedAt: Date.now() }));
		// the Agent pane starts folded: its bar (.studio-agent-bar) is this suite's ready signal and its way in
		localStorage.setItem("cozyclay.shell.agent-pane.v1", "folded");
		localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
	})()`);
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("!!window.__cozyclay?.runStudioAction && !!window.__cozyclay.shotCam && !!document.querySelector('.studio-agent-bar')", "Studio ready", 120_000);
	crate = await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', name: 'Crate', x: 1.5, y: 0, z: 0 }).id");
	await evaluate(`(() => { window.__qaToasts = []; let last = "";
		new MutationObserver(() => { const text = document.querySelector(".toast")?.textContent.trim() ?? ""; if (text && text !== last) window.__qaToasts.push(text); last = text; }).observe(document.body, { childList: true, subtree: true, characterData: true }); })()`);
	if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
	await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "agent composer ready", 60_000);

	// 1. the selected crate removed by a turn
	const row = `[data-node-id="object:${crate}"]`;
	await waitFor(`(() => { if (document.querySelector(${JSON.stringify(row)})) return true; const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (fold && fold.textContent.trim() === "▸") fold.click(); return false; })()`, "crate row shown");
	await click(row);
	await waitFor(`document.querySelector(${JSON.stringify(row)})?.getAttribute('aria-selected') === 'true'`, "crate selected");
	await say("Take the crate away [[remove]]");
	await ended("[[remove]]", 3, "remove turn ends");
	await shot("hold-after-remove");
	const read = calls.findLast(entry => entry.words.includes("[[remove]]"));
	await say("Look again [[look]]");
	await ended("[[look]]", 2, "look turn ends");
	const again = calls.findLast(entry => entry.words.includes("[[look]]"));
	await part("a turn removes the selected crate: its next inspect_studio and the next turn's read the scene, no TARGET_NOT_READY", async () => {
		assert.ok(read?.result !== null, "the turn's last step saw a tool result");
		assert.ok(!read.error && !read.result.includes("TARGET_NOT_READY"), `inspect_studio after the removal reads the scene: ${read.result.slice(0, 160)}`);
		assert.ok(!(await evaluate(`window.__cozyclay.objects.some(o => o.id === ${JSON.stringify(crate)})`)), "the crate is gone");
		assert.ok(again.result !== null && !again.error && !again.result.includes("TARGET_NOT_READY"), `the next turn reads the scene too: ${String(again.result).slice(0, 160)}`);
		assert.equal(again.selection, "null", "the next turn's context carries no selection");
	});
	// undo brings the crate back: the Outliner still names it, so the selection is the crate again
	await evaluate("window.__cozyclay.runStudioAction('edit.undo', {})");
	await waitFor(`window.__cozyclay.objects.some(o => o.id === ${JSON.stringify(crate)})`, "undo brings the crate back");
	await say("Look once more [[look]] [[back]]");
	await ended("[[back]]", 2, "third look turn ends");
	const back = calls.findLast(entry => entry.words.includes("[[back]]"));
	await part("undo brings the removed crate back: it is the selection again, and the turn reads the scene", async () => {
		assert.ok(back.result !== null && !back.error, `the turn reads the scene: ${String(back.result).slice(0, 160)}`);
		assert.ok(back.selection.includes(`"id":"${crate}"`) && back.selection.includes(`"kind":"object"`), `the context selects the crate again: ${back.selection}`);
		assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)})?.getAttribute('aria-selected')`), "true", "the Outliner shows the crate selected");
	});
	await click('[data-node-id="camera"]'); // off the crate: the timeline shows the shot strip the next parts use

	// 2 and 3. a held turn: fly the shot camera, draw a rail
	await evaluate("window.__cozyclay.setLookThrough(true)");
	await waitFor("window.__cozyclay.lookThroughShot === true", "looking through the shot camera");
	await sleep(500);
	await waitFor("!!document.querySelector('.tl-shot-label b')", "shot strip shown");
	await click(".tl-shot-label b");
	await waitFor("!!document.querySelector('.tl-camera-editor .tl-rail-draw')", "rail button shown");
	await click(".tl-camera-editor .tl-rail-draw");
	await waitFor("document.querySelector('.app').dataset.railDraw === '1'", "rail draw on");
	const railBefore = await rail();
	await say("Build and wait [[hold]]");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "held turn runs");
	for (let i = 0; i < 300 && !calls.some(entry => entry.words.includes("[[hold]]") && entry.lastRole === "toolResult"); i++) await sleep(100);
	const added = calls.find(entry => entry.words.includes("[[hold]]") && entry.lastRole === "toolResult");
	assert.ok(added && !added.error, `the turn authored first: ${added?.result?.slice(0, 200)}`);

	const pageErrorsBefore = errors.length;
	await quiet();
	await stroke();
	const strokeNotices = await notices();
	await part("a rail stroke while a turn holds the scene: no page error, no rail written, draw mode still on, the user is told why", async () => {
		assert.equal(errors.length, pageErrorsBefore, `a stroke during the turn throws no page error: ${errors.slice(pageErrorsBefore).join("\n").slice(0, 300)}`);
		assert.equal(await rail(), railBefore, "no rail is written while the turn holds the scene");
		assert.equal(await evaluate("document.querySelector('.app').dataset.railDraw"), "1", "the draw mode stays on");
		assert.ok(strokeNotices.some(namesHold), `a notice names the agent's hold: ${JSON.stringify(strokeNotices)}`);
	});
	errors.length = pageErrorsBefore;
	if (await evaluate("document.querySelector('.app').dataset.railDraw === '1'")) {
		await click(".tl-camera-editor .tl-rail-draw");
		await waitFor("document.querySelector('.app').dataset.railDraw !== '1'", "rail draw off", 5_000).catch(() => {});
	}
	errors.length = pageErrorsBefore;

	await quiet();
	const before = await camera(), warned = framingWarnings();
	await fly();
	const held = await camera(), refusals = framingWarnings() - warned, flyNotices = await notices();
	await shot("hold-fly-during-turn");
	await part(`a fly drag (24 moves) while a turn holds the scene: one refusal (seen ${refusals}), the camera stays on the scene's framing, the user is told why`, async () => {
		assert.equal(refusals, 1, `one refusal for the whole drag, not one per move: ${refusals}`);
		assert.ok(near(held, before), `the shot camera stands where the drag began: ${JSON.stringify({ before, held })}`);
		assert.ok(flyNotices.some(namesHold), `a notice names the agent's hold: ${JSON.stringify(flyNotices)}`);
	});
	// a wheel notch (a dolly) is a framing of its own: refused once, back to where the notch began, told
	await quiet();
	const pane = await evaluate("(() => { const r = window.__cozyclay.mainPane.getBoundingClientRect(); return { x: r.x + r.width * 0.45, y: r.y + r.height * 0.45 }; })()");
	const warnedNotch = framingWarnings();
	await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pane.x, y: pane.y, deltaX: 0, deltaY: -240 });
	await sleep(400);
	const notched = await camera(), notchRefusals = framingWarnings() - warnedNotch, notchNotices = await notices();
	// the two wordings of the same refusal in the console: with a press armed, and without one (a notch)
	console.log(`refusal lines: ${JSON.stringify([...new Set(warnings.filter(line => line.includes("the camera framing was not captured")).map(line => line.slice(0, 140)))])}`);
	await part(`a wheel notch while a turn holds the scene: one refusal (seen ${notchRefusals}), the camera stays, the user is told why`, async () => {
		assert.equal(notchRefusals, 1, `one refusal for the notch: ${notchRefusals}`);
		assert.ok(near(notched, before), `the shot camera stands where the notch began: ${JSON.stringify({ before, notched })}`);
		assert.ok(notchNotices.some(namesHold), `a notice names the agent's hold: ${JSON.stringify(notchNotices)}`);
	});

	gate("H").open();
	await idle("held turn ends");
	const free = await camera(), warnedAfter = framingWarnings();
	await fly();
	const moved = await camera();
	assert.equal(framingWarnings(), warnedAfter, "after the turn the drag is not refused");
	assert.ok(!near(moved, free), "after the turn the drag moves the camera");
	pass("after the turn the same drag moves the shot camera, with no refusal");

	await click(".tl-camera-editor .tl-rail-draw");
	await waitFor("document.querySelector('.app').dataset.railDraw === '1'", "rail draw on again");
	await stroke();
	await waitFor("document.querySelector('.app').dataset.railDraw !== '1'", "the stroke ends the draw mode");
	assert.notEqual(await rail(), railBefore, "after the turn the stroke draws the rail");
	pass("after the turn the same stroke draws the rail");

	// 4. a second held turn with the rail drawn
	const railDrawn = await rail();
	await say("Build and wait once more [[hold again]]");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "second held turn runs");
	for (let i = 0; i < 300 && !calls.some(entry => entry.words.includes("[[hold again]]") && entry.lastRole === "toolResult"); i++) await sleep(100);
	assert.ok(calls.some(entry => entry.words.includes("[[hold again]]") && entry.lastRole === "toolResult" && !entry.error), "the second turn authored first");
	await quiet();
	const errorsBeforeDelete = errors.length;
	await deleteRail();
	await sleep(300);
	const deleteNotices = await notices();
	await part("Delete rail while a turn holds the scene: no page error, the rail stays, the user is told why", async () => {
		assert.equal(errors.length, errorsBeforeDelete, `no page error: ${errors.slice(errorsBeforeDelete).join("\n").slice(0, 300)}`);
		assert.equal(await rail(), railDrawn, "the rail is still there");
		assert.ok(deleteNotices.some(namesHold), `a notice names the agent's hold: ${JSON.stringify(deleteNotices)}`);
	});
	errors.length = errorsBeforeDelete;
	// keys only: the camera has moved since the last press (as a turn's own camera edit or a follow camera moves it)
	await evaluate("window.__cozyclay.setLookThrough(false)");
	await click('[data-node-id="camera"]');
	await waitFor("!!document.querySelector('[data-testid=\"camera-transform\"] input')", "the camera's Transform shown");
	await evaluate("window.__cozyclay.shotCam.position.x += 0.5");
	const atKey = await camera(), warnedKey = framingWarnings();
	await quiet();
	await evaluate("(() => { const field = document.querySelector('[data-testid=\"camera-transform\"] input'); field.focus(); field.select(); })()");
	await send("Input.insertText", { text: "7" });
	await press("Enter");
	await sleep(300);
	const afterKey = await camera(), keyRefusals = framingWarnings() - warnedKey, keyNotices = await notices();
	await part(`a typed camera position while a turn holds the scene: refused (seen ${keyRefusals}), the camera stands where it stood at the key, the user is told why`, async () => {
		assert.ok(keyRefusals >= 1, `the typed value was refused: ${keyRefusals}`);
		assert.ok(near(afterKey, atKey), `the shot camera stands where it stood when the key was pressed: ${JSON.stringify({ atKey, afterKey })}`);
		assert.ok(keyNotices.some(namesHold), `a notice names the agent's hold: ${JSON.stringify(keyNotices)}`);
	});
	gate("H2").open();
	await idle("second held turn ends");
	await click(".tl-shot-label b");
	await waitFor("!!document.querySelector('.tl-camera-advanced')", "the camera editor shown again");
	await deleteRail();
	for (let i = 0; i < 50 && (await rail()) !== "null"; i++) await sleep(100);
	assert.equal(await rail(), "null", "after the turn Delete rail deletes the rail");
	pass("after the second turn Delete rail deletes the rail");

	const depth = warnings.filter(line => line.includes("Maximum update depth"));
	assert.deepEqual(depth, [], "no update loop");
	assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
	pass("no page errors, no update loop warning");
	await writeFile(`${out}/hold-result.json`, JSON.stringify({ checks, failed }, null, 2));
	assert.deepEqual(failed, [], "every part passes");
} finally {
	ws.close();
	for (const child of children) child.kill("SIGTERM");
	for (const client of hub.server.clients) client.terminate();
	await new Promise((resolve) => hub.server.close(resolve));
	sidecar.closeAllConnections();
	sidecar.close();
}
