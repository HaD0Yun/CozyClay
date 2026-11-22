#!/usr/bin/env node
// The edit on the user's last message in a real Studio: headless Chrome on Vite with this repo's agent routes, the live
// hub and the pi runner; only the model is scripted (no model or proxy runs). Driven with real key and pointer events.
//   node test/qa-agent-edit-message-browser.mjs   (ports: QA_PORT 5196, QA_LIVE_PORT 5396, QA_CDP_PORT 9343; QA_OUT dir)
// The owner's path: send a message; send one with a typo; while it runs open its edit and press Esc (nothing changes,
// the turn goes on); Stop it (the aborted card); open the edit from the keyboard, correct the text, Enter: the old
// message, its turn and the aborted card leave the panel, the corrected message goes as one turn, and the model's
// context holds the first exchange and the corrected message only. A reload shows the same conversation.
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

const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.QA_PORT || 5196), livePort = Number(process.env.QA_LIVE_PORT || 5396), cdpPort = Number(process.env.QA_CDP_PORT || 9343);
const out = process.env.QA_OUT || `${tmpdir()}/cozyclay-agent-edit`;
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });
const children = [], checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- the scripted model: every call is recorded with what it was given ------------------------------------------------
const gates = new Map();
const gate = name => { if (!gates.has(name)) { let open; const promise = new Promise(resolve => { open = resolve; }); gates.set(name, { promise, open }); } return gates.get(name); };
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const lastUserWords = messages => { const user = messages.findLast(message => message.role === "user"); const parts = (user?.content ?? []).filter(part => part.type === "text"); return parts.at(-1)?.text ?? ""; };
const calls = [];
const fake = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
fake.fauxProvider.setResponses(Array.from({ length: 60 }, () => async context => {
	const messages = context.messages, words = lastUserWords(messages);
	calls.push({ roles: messages.map(message => message.role), words, lastRole: messages.at(-1)?.role, texts: messages.map(textOf) });
	// [[long]]: a first step at once (its frames reach the panel), then a model call that thinks until gate A opens
	if (words.includes("[[long]]")) {
		if (messages.at(-1)?.role === "toolResult") await gate("A").promise;
		return fauxAssistantMessage([fauxToolCall("inspect_studio", { scope: "scene" }, { id: `qa-inspect-${calls.length}` })]);
	}
	// [[slow]]: the first model call waits on gate C, then one step; nothing reaches the browser before it
	if (words.includes("[[slow]]")) {
		if (messages.at(-1)?.role === "user") { await gate("C").promise; return fauxAssistantMessage([fauxToolCall("inspect_studio", { scope: "scene" }, { id: `qa-inspect-${calls.length}` })]); }
		return fauxAssistantMessage([fauxText("QA: the slow turn ended.")]);
	}
	if (words.includes("[[hold]]")) { await gate("B").promise; return fauxAssistantMessage([fauxText("QA: the held turn ended.")]); }
	// [[typo]]: one step at once (a tool call: the scene is read), then a model call that thinks until gate T opens
	if (words.includes("[[typo]]")) {
		if (messages.at(-1)?.role === "toolResult") { await gate("T").promise; return fauxAssistantMessage([fauxText("QA: the typo turn ended.")]); }
		return fauxAssistantMessage([fauxToolCall("inspect_studio", { scope: "scene" }, { id: `qa-inspect-${calls.length}` })]);
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
const pending = new Map(), errors = [];
let sequence = 0;
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const shot = async name => writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
// the Agent box alone, at twice the scale
const panelShot = async name => {
	const r = await evaluate("(() => { const r = document.querySelector('.agent-panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
	await writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } })).data, "base64"));
};
const waitFor = async (expression, label, ms = 30_000) => {
	for (let t = 0; t < ms; t += 150) { try { const value = await evaluate(expression); if (value) return value; } catch { /* page busy */ } await sleep(150); }
	await shot(`edit-timeout-${label.replace(/\W+/g, "-")}`).catch(() => {});
	const probe = await evaluate("({ rows: [...document.querySelectorAll('.agent-queue-row')].map(r => r.dataset.status + ':' + r.textContent), state: document.querySelector('.agent-panel')?.dataset.agentState, input: document.querySelector('.agent-input')?.value, users: [...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent) })").catch(error => String(error));
	throw new Error(`Timed out: ${label} ${JSON.stringify(probe)} calls=${JSON.stringify(calls.map(call => call.words))}`);
};
// real pointer and key events
const click = async selector => {
	const point = await evaluate(`(() => { const element = ${selector.startsWith("[...") ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!element || element.disabled) throw new Error("missing or disabled: " + ${JSON.stringify(selector)}); element.scrollIntoView({ block: "nearest" }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
};
const press = async (key, code = key, keyCode = key === "Enter" ? 13 : key === "End" ? 35 : key === "Escape" ? 27 : 0) => {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
	if (key === "Enter") await send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", windowsVirtualKeyCode: 13 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
};
const type = async text => send("Input.insertText", { text });
// the panel may still be sliding open: click until the composer has the caret, and press Enter once React has the text
const say = async text => {
	for (let i = 0; i < 20 && !(await evaluate("document.activeElement?.classList.contains('agent-input')")); i++) { await click(".agent-input"); await sleep(150); }
	await type(text);
	await waitFor(`document.querySelector('.agent-input')?.value === ${JSON.stringify(text)}`, `typed ${text}`);
	await press("Enter");
};
const bubbles = () => evaluate("[...document.querySelectorAll('.agent-row.user .agent-bubble')].map(bubble => bubble.textContent)");

const lastBubble = "[...document.querySelectorAll('.agent-row.user')].at(-1)";
const hover = async (expression) => {
	const point = await evaluate(`(() => { const r = (${expression.startsWith("[...") ? expression : `document.querySelector(${JSON.stringify(expression)})`}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
};
const pencilOpacity = () => evaluate(`(() => { const b = ${lastBubble}.querySelector('.agent-edit-open'); return b ? Number(getComputedStyle(b).opacity) : -1; })()`);
const TYPO = "Make the boy wlak to the door [[typo]]", FIXED = "Make the boy walk to the door slowly";

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.agent.tasks', 'off'); if (!localStorage.getItem('cozyclay.project-session.v1')) localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Edit QA', updatedAt: Date.now() }));" });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("!!window.__cozyclay?.runStudioAction && !!document.querySelector('.studio-agent-bar')", "Studio ready", 120_000);
	if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
	await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "agent composer ready", 60_000);

	// 1. a first exchange, then the message with the typo; its turn reads the scene, then thinks
	await say("Hello there");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming' && document.querySelectorAll('.agent-assistant-text').length === 1", "first reply");
	await say(TYPO);
	for (let i = 0; i < 200 && calls.length < 3; i++) await sleep(100);
	assert.equal(calls.length, 3, "the typo turn's second model call thinks");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "the typo turn runs");
	assert.equal(await evaluate("document.querySelectorAll('.agent-row.user .agent-edit-open').length"), 1, "one edit control, on the last message only");
	assert.equal(await evaluate(`!!${lastBubble}.querySelector('.agent-edit-open')`), true);
	await hover(lastBubble);
	for (let i = 0; i < 20 && (await pencilOpacity()) !== 1; i++) await sleep(100);
	assert.equal(await pencilOpacity(), 1, "pencil shown on hover");
	await panelShot("edit-0-hover-pencil-panel");
	await hover(".agent-input");
	for (let i = 0; i < 20 && (await pencilOpacity()) !== 0; i++) await sleep(100);
	assert.equal(await pencilOpacity(), 0, "pencil hidden without hover");
	pass("only the last message has the edit control; it shows on hover (opacity 1) and hides otherwise (opacity 0)");

	// 2. a draft in the composer, then the edit opened and closed with Esc while the turn runs: nothing changes
	await click(".agent-input"); await type("a draft I keep");
	await hover(lastBubble); await click(`${lastBubble}.querySelector('.agent-edit-open')`);
	await waitFor("document.activeElement?.classList.contains('agent-edit-input')", "edit box focused");
	assert.equal(await evaluate("document.activeElement.value"), TYPO);
	assert.match(await evaluate("document.querySelector('.agent-edit-hint').textContent"), /stops the running turn/);
	await panelShot("edit-1-open-while-running-panel");
	await type(" more");
	await press("Escape");
	await waitFor("!document.querySelector('.agent-edit-input')", "edit closed");
	assert.equal(await evaluate(`${lastBubble}.querySelector('.agent-bubble').textContent`), TYPO);
	assert.equal(await evaluate("document.querySelector('.agent-panel').dataset.agentState"), "streaming", "Esc did not stop the turn");
	assert.equal(calls.length, 3);
	assert.equal(await evaluate("document.querySelector('.agent-input').value"), "a draft I keep");
	pass("Esc closes the edit and leaves everything as it was: the message, the running turn, the model calls, the draft");

	// 3. the owner's case: Stop; the aborted card under the message
	await click(".agent-send.stop");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming'", "stopped");
	gate("T").open();
	await sleep(1000);
	await panelShot("edit-2-stopped-panel");
	const stopped = await evaluate("document.querySelector('.agent-transcript').textContent");

	// 4. the edit from the keyboard: the pencil takes focus, Enter opens it; the text corrected; Enter sends
	await evaluate(`${lastBubble}.querySelector('.agent-edit-open').focus()`);
	for (let i = 0; i < 20 && (await pencilOpacity()) !== 1; i++) await sleep(100);
	assert.equal(await pencilOpacity(), 1, "the pencil shows when the keyboard reaches it");
	await press("Enter");
	await waitFor("document.activeElement?.classList.contains('agent-edit-input')", "edit box focused by keyboard");
	assert.match(await evaluate("document.querySelector('.agent-edit-hint').textContent"), /^Sending replaces this message/);
	await evaluate("document.activeElement.select()");
	await type(FIXED);
	await waitFor(`document.activeElement?.value === ${JSON.stringify(FIXED)}`, "corrected text typed");
	await panelShot("edit-3-correcting-panel");
	const before = calls.length;
	await press("Enter");
	await waitFor(`[...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent).at(-1) === ${JSON.stringify(FIXED)}`, "corrected message in the panel");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming' && document.querySelectorAll('.agent-assistant-text').length === 2", "corrected reply");
	await panelShot("edit-4-resent-panel");
	assert.deepEqual(await bubbles(), ["Hello there", FIXED]);
	assert.ok(!(await evaluate("document.querySelector('.agent-transcript').textContent")).includes("wlak"), "the typo left the panel");
	assert.equal(await evaluate("document.querySelectorAll('.agent-failure-card').length"), 0, `the aborted card left with its turn (before: ${stopped.slice(-200)})`);
	assert.equal(await evaluate("document.querySelector('.agent-input').value"), "a draft I keep", "the composer's draft is untouched");
	pass("Enter sends the correction: the typo message, its turn and the aborted card leave the panel; the corrected message and its reply follow the first exchange; the draft stays");

	const resent = calls.slice(before);
	assert.equal(resent.length, 1, `one model request for the correction: ${JSON.stringify(resent.map(call => call.words))}`);
	const users = resent[0].texts.filter((_, index) => resent[0].roles[index] === "user");
	assert.deepEqual(resent[0].roles.filter(role => role !== "system"), ["user", "assistant", "user"], "the first exchange, then the corrected message");
	assert.ok(!resent[0].texts.join("\n").includes("wlak"), "the model never sees the typo again");
	assert.equal(resent[0].words, FIXED);
	assert.match(users.at(-1), /<edited-message>The user edited their last message after sending it, and this message replaces it\./);
	assert.match(users.at(-1), /the same as when that message was sent: nothing in it changed since/);
	pass(`the model received one corrected request: [${resent[0].roles.join(", ")}], no typo, and the note that it replaces the earlier message and that the scene is at the same revision`);

	// 5. a reload brings the same conversation back, the edit on the corrected message
	await send("Page.reload");
	await waitFor("document.querySelectorAll('.agent-row.user').length === 2", "restored after reload", 120_000);
	assert.deepEqual(await bubbles(), ["Hello there", FIXED]);
	assert.equal(await evaluate("document.querySelectorAll('.agent-row.user .agent-edit-open').length"), 1);
	assert.equal(await evaluate(`!!${lastBubble}.querySelector('.agent-edit-open')`), true);
	pass("after a reload: the same two messages, the corrected one editable, the typo gone");

	assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
	pass("no page errors");
	await writeFile(`${out}/edit-result.json`, JSON.stringify({ checks, calls: calls.map(({ roles, words }) => ({ roles, words })) }, null, 2));
} finally {
	ws.close();
	for (const child of children) child.kill("SIGTERM");
	for (const client of hub.server.clients) client.terminate();
	await new Promise((resolve) => hub.server.close(resolve));
	sidecar.closeAllConnections();
	sidecar.close();
}
