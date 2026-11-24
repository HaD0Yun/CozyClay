#!/usr/bin/env node
// The Agent box's queue in a real Studio: headless Chrome on Vite with this repo's agent routes, the live hub and the
// pi runner; only the model is scripted (no model or proxy runs). Driven with real key and pointer events (CDP Input).
//   node test/qa-agent-queue-browser.mjs   (ports: QA_PORT 5196, QA_LIVE_PORT 5396, QA_CDP_PORT 9343; QA_OUT dir;
//   QA_TASKS=on: the same path with the panel's Tasks switch on, the turn going to the main agent)
// The owner's path: start a turn; while it runs type a message and press Enter, three times: three rows above the
// composer, in order; edit one, remove one; Send now on the first while the model is still writing: the row waits, the
// loop puts it in the model's context at its next step (after the tool result) and the row joins the conversation;
// the turn ends and the edited row goes as the next turn by itself. Then Stop holds a queued row until Send now.
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
const out = process.env.QA_OUT || `${tmpdir()}/cozyclay-agent-queue`;
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
	await shot(`queue-timeout-${label.replace(/\W+/g, "-")}`).catch(() => {});
	const probe = await evaluate("({ rows: [...document.querySelectorAll('.agent-queue-row')].map(r => r.dataset.status + ':' + r.textContent), state: document.querySelector('.agent-panel')?.dataset.agentState, input: document.querySelector('.agent-input')?.value, users: [...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent) })").catch(error => String(error));
	throw new Error(`Timed out: ${label} ${JSON.stringify(probe)} calls=${JSON.stringify(calls.map(call => call.words))}`);
};
// real pointer and key events
const click = async selector => {
	const point = await evaluate(`(() => { const element = ${selector.startsWith("[...") ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!element || element.disabled) throw new Error("missing or disabled: " + ${JSON.stringify(selector)}); element.scrollIntoView({ block: "nearest" }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
};
const press = async (key, code = key, keyCode = key === "Enter" ? 13 : key === "End" ? 35 : 0) => {
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
const rowSelector = text => `[...document.querySelectorAll('.agent-queue-row')].find(row => row.querySelector('.agent-queue-text')?.textContent.startsWith(${JSON.stringify(text)}))`;
const rows = () => evaluate("[...document.querySelectorAll('.agent-queue-row')].map(row => row.dataset.status + ':' + (row.querySelector('.agent-queue-text')?.textContent ?? ''))");
const bubbles = () => evaluate("[...document.querySelectorAll('.agent-row.user .agent-bubble')].map(bubble => bubble.textContent)");

try {
	await send("Page.enable"); await send("Runtime.enable");
	// an open project session skips the start page
	// The pane starts folded, as these steps expect: `.studio-agent-bar` (the folded pane's bar) is the ready signal and
	// the way in. Set on every load: opening the pane stores "open" (src/shell/agent-pane.js).
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.shell.agent-pane.v1', 'folded'); localStorage.setItem('cozyclay.agent.tasks', ${JSON.stringify(process.env.QA_TASKS === "on" ? "on" : "off")}); if (!localStorage.getItem('cozyclay.project-session.v1')) localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Queue QA', updatedAt: Date.now() }));` });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("!!window.__cozyclay?.runStudioAction && !!document.querySelector('.studio-agent-bar')", "Studio ready", 120_000);
	if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
	await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "agent composer ready", 60_000);

	// 1. a turn runs; three messages typed with Enter while it runs
	await say("Start the long job [[long]]");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming' && !!document.querySelector('.agent-send.stop')", "the turn runs");
	for (let i = 0; i < 200 && calls.length < 2; i++) await sleep(100); // the first step ran; the model now thinks
	assert.equal(calls.length, 2, "the turn's second model call is under way");
	await say("first queued");
	await say("second queued");
	await say("third queued");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 3", "three rows");
	assert.deepEqual(await rows(), ["queued:first queued", "queued:second queued", "queued:third queued"]);
	assert.equal(await evaluate("document.querySelector('.agent-input').value"), "");
	await shot("queue-1-three-rows");
	await panelShot("queue-1-three-rows-panel");
	const fit = await evaluate("(() => { const composer = document.querySelector('.agent-composer').getBoundingClientRect(); return ['.agent-send.stop', '.agent-queue-add', '.agent-queue-row .agent-queue-remove'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return { s, left: r.left, right: r.right, inside: r.width > 0 && r.left >= composer.left - 1 && r.right <= composer.right + 1 }; }); })()");
	assert.ok(fit.every(entry => entry.inside), `Stop, the queue button and the row buttons are inside the panel: ${JSON.stringify(fit)}`);
	assert.equal(calls.length, 2, `no model call took any of them: ${JSON.stringify(calls.map(call => call.roles))}`);
	pass("Enter while a turn runs: three rows above the composer, in order; the composer empties; nothing reached the model");
	assert.deepEqual(await evaluate("[...document.querySelector('.agent-queue-row').querySelectorAll('button')].map(b => b.textContent || b.getAttribute('aria-label'))"), ["Send now", "Edit", "Remove"]);

	// 2. edit the second, remove the third
	await click(`${rowSelector("second queued")}.querySelector('.agent-queue-edit')`);
	await waitFor("document.activeElement?.classList.contains('agent-queue-input')", "edit box focused");
	await press("End"); await type(", edited");
	await panelShot("queue-2-editing-panel");
	await press("Enter");
	await waitFor(`${rowSelector("second queued, edited")}?.dataset.status === 'queued'`, "edited row saved");
	await click(`${rowSelector("third queued")}.querySelector('.agent-queue-remove')`);
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 2", "third removed");
	assert.deepEqual(await rows(), ["queued:first queued", "queued:second queued, edited"]);
	pass("edit (pencil, type, Enter) changes a row in place; remove (X) takes a row out");

	// 3. Send now on the first while the model still writes its first answer
	await click(`${rowSelector("first queued")}.querySelector('.agent-queue-send')`);
	await waitFor(`${rowSelector("first queued")}?.dataset.status === 'sending'`, "first row sending");
	await panelShot("queue-3-sending-panel");
	assert.equal(calls.length, 2);
	assert.ok(!(await bubbles()).includes("first queued"), "not in the conversation before the model has it");
	pass("Send now mid-turn: the row reads 'Waiting for the agent's next step' and is not shown as said yet");
	gate("A").open();
	await waitFor("!document.querySelector('.agent-queue-row[data-status=\"sending\"]')", "the sent row left the queue");
	await waitFor("[...document.querySelectorAll('.agent-row.user .agent-bubble')].some(b => b.textContent === 'first queued')", "first joins the conversation");
	const steered = calls[2];
	assert.ok(steered, "a third model call ran");
	assert.ok(!calls[1].texts.join("\n").includes("first queued"), "the model call that was thinking did not have it");
	assert.equal(steered.lastRole, "user");
	assert.equal(steered.words, "first queued");
	const toolAt = steered.roles.lastIndexOf("toolResult");
	assert.ok(toolAt !== -1 && toolAt === steered.roles.length - 2, `the steer comes right after the tool result: ${steered.roles.join(",")}`);
	assert.equal(steered.roles.filter(role => role === "toolResult").length, 2, "the work done so far stays: both tool results are in the context");
	pass(`the loop received it at the next step: model call 3 reads [${steered.roles.join(", ")}], the user message "first queued" right after the tool result of the step that was running; both earlier tool results kept`);

	// 4. the turn ends; the edited row goes as the next turn by itself
	await waitFor("[...document.querySelectorAll('.agent-row.user .agent-bubble')].some(b => b.textContent === 'second queued, edited')", "the edited row went as the next turn");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 0 && document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming'", "queue empty, idle");
	const next = calls.find(call => call.words === "second queued, edited");
	assert.ok(next && calls.indexOf(next) === 3, `the fourth model call is the queued turn: ${JSON.stringify(calls.map(call => call.words))}`);
	assert.deepEqual(await bubbles(), ["Start the long job [[long]]", "first queued", "second queued, edited"]);
	pass("the turn ended done: the edited row went by itself as the next turn (model call 4), the conversation reads in order");
	await panelShot("queue-4-after-panel");

	// 5. Stop holds the queue; Send now sends the held row
	await say("A turn I will stop [[hold]]");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "held turn runs");
	await say("after the stop");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 1", "one row");
	await click(".agent-send.stop");
	await waitFor("document.querySelector('.agent-queue')?.dataset.agentQueueHeld === 'true'", "held after Stop");
	gate("B").open();
	await sleep(1500);
	assert.deepEqual(await rows(), ["queued:after the stop"]);
	assert.ok(!calls.some(call => call.words === "after the stop"), "Stop sent nothing by itself");
	await panelShot("queue-5-held-after-stop-panel");
	pass("Stop: the row stays, held, and nothing is sent by itself");
	await click(`${rowSelector("after the stop")}.querySelector('.agent-queue-send')`);
	await waitFor("[...document.querySelectorAll('.agent-row.user .agent-bubble')].some(b => b.textContent === 'after the stop')", "held row sent");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 0", "queue empty");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming'", "idle again");
	assert.ok(calls.some(call => call.words === "after the stop"));
	pass("Send now on a held row (no turn running) starts it as a new turn");

	// 6. a browser that holds no owner cookie yet (a new chat's first turn on a fresh profile): Send now before the turn's
	// first frame waits for the sidecar's answer (which brings the cookie) instead of being refused
	await send("Network.enable"); await send("Network.clearBrowserCookies");
	await click(".agent-new");
	await waitFor("document.querySelectorAll('.agent-row.user').length === 0 && !document.querySelector('.agent-input').disabled", "a new conversation");
	const before = calls.length;
	await say("A new chat's first turn [[slow]]");
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "slow turn runs");
	await say("on the first turn");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 1", "one row on the first turn");
	await click(`${rowSelector("on the first turn")}.querySelector('.agent-queue-send')`);
	await sleep(1500);
	assert.equal(await evaluate("document.querySelector('.agent-steer-notice')?.textContent ?? ''"), "", "Send now is not refused before the first frame");
	assert.deepEqual(await rows(), ["sending:on the first turn"]);
	assert.equal(calls.length, before + 1, "the first model call still thinks");
	gate("C").open();
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 0 && document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming'", "first-turn row delivered, idle");
	const took = calls.slice(before).filter(call => call.lastRole === "user" && call.words === "on the first turn");
	assert.equal(took.length, 1, `the model got it once, in the turn: ${JSON.stringify(calls.slice(before).map(call => [call.roles.join(","), call.words]))}`);
	assert.ok(took[0].roles.includes("toolResult") && took[0].roles.filter(role => role === "user").length === 2, "inside the same turn, after its first step");
	assert.deepEqual(await bubbles(), ["A new chat's first turn [[slow]]", "on the first turn"]);
	pass(`a new chat's first turn with no owner cookie yet: Send now before the first frame waits, then the same turn's loop takes it at a step boundary (call reads [${took[0].roles.join(", ")}]); no refusal shown`);

	assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
	pass("no page errors");
	await writeFile(`${out}/queue-result.json`, JSON.stringify({ checks, calls: calls.map(({ roles, words }) => ({ roles, words })) }, null, 2));
} finally {
	ws.close();
	for (const child of children) child.kill("SIGTERM");
	for (const client of hub.server.clients) client.terminate();
	await new Promise((resolve) => hub.server.close(resolve));
	sidecar.closeAllConnections();
	sidecar.close();
}
