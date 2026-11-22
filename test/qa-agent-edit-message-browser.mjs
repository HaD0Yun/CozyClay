#!/usr/bin/env node
// The edit on the user's last message in a real Studio: headless Chrome on Vite with this repo's agent routes, the live
// hub and the pi runner; only the model is scripted (no model or proxy runs). Driven with real key and pointer events.
//   node test/qa-agent-edit-message-browser.mjs   (ports: QA_PORT 5196, QA_LIVE_PORT 5396, QA_CDP_PORT 9343; QA_OUT dir)
// The owner's path: send a message; send one with a typo; while it runs open its edit and press Esc (nothing changes,
// the turn goes on); Stop it (the aborted card); open the edit from the keyboard, correct the text, Enter: the old
// message, its turn and the aborted card leave the panel, the corrected message goes as one turn, and the model's
// context holds the first exchange and the corrected message only. Then a turn that changed the scene (a chair), edited
// while it still runs with a message waiting in the queue: the turn is stopped, the corrected message goes as one turn,
// the model is told the scene's revision moved and is given the scene with the chair, the queued message stays held.
// A reload shows the same conversation, and an edit after it never says "nothing changed" (the editor counts revisions
// from the start again). With Tasks on, the pencil says why the message cannot be edited and stops nothing; a message
// sent with Tasks off in that conversation is edited as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
// every tool call of a request has its result behind it, and every result its call before it
const pairProblems = messages => {
	const open = new Set(), problems = [];
	for (const message of messages) {
		if (message.role === "assistant") for (const part of message.content ?? []) if (part.type === "toolCall") open.add(part.id);
		if (message.role === "toolResult" && !open.delete(message.toolCallId)) problems.push(`result without call ${message.toolCallId}`);
	}
	return [...problems, ...[...open].map(id => `call without result ${id}`)];
};
const calls = [];
const fake = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
fake.fauxProvider.setResponses(Array.from({ length: 60 }, () => async context => {
	const messages = context.messages, words = lastUserWords(messages);
	calls.push({ roles: messages.map(message => message.role), words, lastRole: messages.at(-1)?.role, texts: messages.map(textOf), pairs: pairProblems(messages) });
	// [[chair]]: one step that changes the scene (a chair is added), then a model call that thinks until gate K opens
	if (words.includes("[[chair]]")) {
		if (messages.at(-1)?.role === "toolResult") { await gate("K").promise; return fauxAssistantMessage([fauxText("QA: the chair turn ended.")]); }
		return fauxAssistantMessage([fauxToolCall("arrange_objects", { ops: [{ op: "create", source: { kind: "cube" }, name: "Chair", position: { world: { x: -1.4, y: 0, z: 0 } } }] }, { id: `qa-chair-${calls.length}` })]);
	}
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
const sessionsDir = `${out}/sessions-${Date.now()}`;
// what is on disk of the conversations: every session and meta file with its text
const disk = () => readdirSync(sessionsDir).filter(name => !name.endsWith(".tmp")).sort().map(name => `${name}\n${readFileSync(`${sessionsDir}/${name}`, "utf8")}`).join("\n");
const diskMessages = () => readdirSync(sessionsDir).filter(name => name.endsWith(".jsonl")).flatMap(name => readFileSync(`${sessionsDir}/${name}`, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.kind === "message").map(entry => entry.message));
const agent = createAgentHandler({ auth: { getAccessToken: async () => "qa-token" }, codex: { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: {} }), listModels: async () => ["qa"] },
	models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, sessionStore: createSessionStore(sessionsDir), supervisor: false, studioTasks: () => false, port: () => port });
const rewinds = []; // each edit request's answer, for a timeout's report
const sidecar = createServer(async (req, res) => {
	const path = (req.url || "").split("?")[0];
	if (path.endsWith("/rewind")) res.on("finish", () => rewinds.push(res.statusCode));
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
	const probe = await evaluate("({ rows: [...document.querySelectorAll('.agent-queue-row')].map(r => r.dataset.status + ':' + r.textContent), state: document.querySelector('.agent-panel')?.dataset.agentState, input: document.querySelector('.agent-input')?.value, users: [...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent), notice: document.querySelector('.agent-steer-notice')?.textContent, pencils: document.querySelectorAll('.agent-edit-open').length, editing: !!document.querySelector('.agent-edit-input') })").catch(error => String(error));
	throw new Error(`Timed out: ${label} ${JSON.stringify(probe)} rewinds=${JSON.stringify(rewinds)} calls=${JSON.stringify(calls.map(call => call.words))}`);
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
// the same over whatever the composer holds
const sayOver = async text => {
	for (let i = 0; i < 20 && !(await evaluate("document.activeElement?.classList.contains('agent-input')")); i++) { await click(".agent-input"); await sleep(150); }
	await evaluate("document.activeElement.select()");
	await type(text);
	await waitFor(`document.querySelector('.agent-input')?.value === ${JSON.stringify(text)}`, `typed ${text}`);
	await press("Enter");
};
const idle = "document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming'";
// A pointer press on the pencil. With no turn running, the panel's status line ("Done", "Stopped") folds away a few
// seconds after a turn ends and moves the transcript by its height (as before this change): the press waits for that.
const openEdit = async () => {
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming' || document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'idle'", "the status line settled");
	await hover(lastBubble); await click(`${lastBubble}.querySelector('.agent-edit-open')`);
	await waitFor("document.activeElement?.classList.contains('agent-edit-input')", "edit box focused");
};
const correct = async text => { await evaluate("document.activeElement.select()"); await type(text); await waitFor(`document.activeElement?.value === ${JSON.stringify(text)}`, "corrected text typed"); };
const objects = text => Number(/"objectCount":(\d+)/.exec(text)?.[1] ?? NaN); // of the studio context in a request's last user message
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
	const onDisk = disk();
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
	assert.equal(disk(), onDisk, "Esc left the session files as they were");
	pass("Esc closes the edit and leaves everything as it was: the message, the running turn, the model calls, the draft, the session files on disk");

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
	assert.match(users.at(-1), /the same as when that message was sent: nothing was changed in it since/);
	assert.deepEqual(resent[0].pairs, [], "no tool call without its result in the request");
	pass(`the model received one corrected request: [${resent[0].roles.join(", ")}], no typo, and the note that it replaces the earlier message and that the scene is at the same revision`);

	// 5. a turn that changed the scene (a chair), edited while it still runs, with a message waiting in the queue
	const CHAIR = "Put a chiar by the door [[chair]]", WINDOW = "Put a chair by the window";
	await sayOver(CHAIR);
	for (let i = 0; i < 300 && !calls.some(call => call.words === CHAIR && call.lastRole === "toolResult"); i++) await sleep(100);
	const chairCalls = calls.filter(call => call.words === CHAIR);
	assert.equal(chairCalls.length, 2, `the chair turn made its step and thinks: ${JSON.stringify(calls.map(call => call.words))}`);
	assert.ok(!/"isError":true|NOT_AVAILABLE|INVALID/.test(chairCalls[1].texts.at(-1)), `the chair was added: ${chairCalls[1].texts.at(-1).slice(0, 300)}`);
	const objectsBefore = objects(chairCalls[0].texts.at(-1));
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "the chair turn runs");
	await sayOver("a message that waits");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 1", "one queued row");
	await openEdit();
	assert.match(await evaluate("document.querySelector('.agent-edit-hint').textContent"), /^Sending stops the running turn and replaces this message/);
	await correct(WINDOW);
	const beforeRunning = calls.length;
	await press("Enter");
	await sleep(500); gate("K").open(); // the scripted model lets go of the stopped request, as a provider does on an abort
	await waitFor(`[...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent).at(-1) === ${JSON.stringify(WINDOW)}`, "the corrected message replaced the running one");
	await waitFor(`${idle} && document.querySelectorAll('.agent-assistant-text').length === 3`, "reply to the corrected message");
	await panelShot("edit-5-edited-while-running-panel");
	assert.deepEqual(await bubbles(), ["Hello there", FIXED, WINDOW]);
	assert.equal(await evaluate("document.querySelectorAll('.agent-failure-card').length"), 0, "no aborted card is left of the stopped turn");
	const rerun = calls.slice(beforeRunning);
	assert.equal(rerun.length, 1, `one model request for the correction: ${JSON.stringify(rerun.map(call => call.words))}`);
	assert.equal(rerun[0].words, WINDOW);
	assert.ok(!rerun[0].texts.join("\n").includes("chiar"), "no trace of the old text");
	assert.deepEqual(rerun[0].roles.filter(role => role !== "system"), ["user", "assistant", "user", "assistant", "user"], "two exchanges, then the corrected message: none of the stopped turn's call or result");
	assert.deepEqual(rerun[0].pairs, []);
	const moved = /its content was at revision (\d+) when that message was sent and is at revision (\d+) now, so it was changed since \(by the removed turn, whose tool calls and results you no longer have, or by the user in the editor\) and this edit undid none of that\./.exec(rerun[0].texts.at(-1));
	assert.ok(moved && Number(moved[2]) > Number(moved[1]), `the note names both revisions: ${rerun[0].texts.at(-1).slice(0, 700)}`);
	assert.equal(objects(rerun[0].texts.at(-1)), objectsBefore + 1, "the chair the removed turn added is in the scene the model is given");
	assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-queue-row')].map(row => row.dataset.status + ':' + row.querySelector('.agent-queue-text')?.textContent)"), ["queued:a message that waits"]);
	assert.equal(await evaluate("document.querySelector('.agent-queue')?.dataset.agentQueueHeld"), "true", "the queued message is held, not sent by itself");
	assert.ok(!JSON.stringify(diskMessages()).includes("chiar"), "the session file holds no trace of the removed turn");
	assert.deepEqual(pairProblems(diskMessages()), [], "the session file has every call with its result");
	pass(`edited while it ran: the turn stopped, one corrected request [${rerun[0].roles.join(", ")}], the note says revision ${moved[1]} -> ${moved[2]} and the scene given has the chair (${objectsBefore} -> ${objectsBefore + 1} objects), the queued message stays held`);
	await click("[...document.querySelectorAll('.agent-queue-row .agent-queue-remove')].at(-1)");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 0", "queue empty");

	// 5b. a turn that took a Send now message: the edit says that message leaves with the turn, and it does
	const DORR = "Stroll to the dorr [[long]]", DOOR = "Stroll to the door";
	await sayOver(DORR);
	for (let i = 0; i < 300 && !calls.some(call => call.words === DORR && call.lastRole === "toolResult"); i++) await sleep(100);
	await sayOver("and wave");
	await waitFor("document.querySelectorAll('.agent-queue-row').length === 1", "one queued row");
	await click(".agent-queue-row .agent-queue-send");
	await waitFor("document.querySelector('.agent-queue-row')?.dataset.status === 'sending'", "Send now waits for the next step");
	gate("A").open();
	await waitFor(`${idle} && document.querySelectorAll('.agent-queue-row').length === 0 && document.querySelectorAll('.agent-assistant-text').length === 4`, "the turn took the message and ended");
	assert.deepEqual(await bubbles(), ["Hello there", FIXED, WINDOW, DORR, "and wave"]);
	const editable = "[...document.querySelectorAll('.agent-row.user')].find(row => row.querySelector('.agent-edit-open'))";
	assert.equal(await evaluate(`${editable}.querySelector('.agent-bubble').textContent`), DORR, "the edit is on the message that started the turn, not on the one sent into it");
	await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'idle'", "the status line settled");
	await hover(editable); await click(".agent-edit-open");
	await waitFor("document.activeElement?.classList.contains('agent-edit-input')", "edit box focused");
	assert.match(await evaluate("document.querySelector('.agent-edit-hint').textContent"), /^Sending replaces this message: .* The messages you sent into this turn \(Send now\) leave with it\.$/);
	await panelShot("edit-5b-steered-hint-panel");
	await correct(DOOR);
	const beforeSteered = calls.length;
	await press("Enter");
	await waitFor(`${idle} && [...document.querySelectorAll('.agent-assistant-text')].some(node => node.textContent.includes(${JSON.stringify(`QA heard: ${DOOR}`)}))`, "reply to the corrected message");
	assert.deepEqual(await bubbles(), ["Hello there", FIXED, WINDOW, DOOR]);
	const unsteered = calls.slice(beforeSteered);
	assert.equal(unsteered.length, 1);
	assert.ok(!/dorr|and wave/.test(unsteered[0].texts.join("\n")), "neither the old message nor the one sent into its turn is in the model's context");
	assert.deepEqual(unsteered[0].pairs, []);
	assert.ok(!/dorr|and wave/.test(JSON.stringify(diskMessages())), "nor in the session file");
	pass("a turn that took a Send now message: the edit box says that message leaves too; after the edit neither is in the panel, the model's context or the session file");

	// 6. a reload brings the same conversation back; an edit after it tells no revision comparison
	await evaluate("window.__qaBeforeReload = true");
	await send("Page.reload");
	await waitFor("!window.__qaBeforeReload && !!window.__cozyclay?.runStudioAction && document.querySelectorAll('.agent-row.user').length === 4", "restored after reload", 120_000);
	assert.deepEqual(await bubbles(), ["Hello there", FIXED, WINDOW, DOOR]);
	assert.equal(await evaluate("document.querySelectorAll('.agent-row.user .agent-edit-open').length"), 1);
	assert.equal(await evaluate(`!!${lastBubble}.querySelector('.agent-edit-open')`), true);
	if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
	await waitFor("document.querySelector('.agent-input')?.offsetParent && !document.querySelector('.agent-input').disabled", "agent composer ready after reload", 60_000);
	const AFTER = "Set the chair at the window, facing in";
	await openEdit();
	await correct(AFTER);
	const beforeReloaded = calls.length;
	await press("Enter");
	await waitFor(`${idle} && [...document.querySelectorAll('.agent-row.user .agent-bubble')].map(b => b.textContent).at(-1) === ${JSON.stringify(AFTER)} && document.querySelectorAll('.agent-assistant-text').length === 4`, "reply after the reload's edit");
	const reloaded = calls.slice(beforeReloaded);
	assert.equal(reloaded.length, 1);
	assert.match(reloaded[0].texts.at(-1), /The editor was reloaded or went to another scene or document since that message was sent, so its revision then \(\d+\) and now \(\d+\) do not compare: the scene may hold changes the removed turn made\./);
	assert.ok(!/nothing was changed/.test(reloaded[0].texts.at(-1)));
	assert.ok(!reloaded[0].texts.join("\n").includes(DOOR), "the edited message left the model's context");
	assert.deepEqual(reloaded[0].texts.filter((_, index) => reloaded[0].roles[index] === "user").map(text => text.split("\n").at(-1)), await bubbles(), "the model holds the messages the panel shows");
	assert.deepEqual(await bubbles(), ["Hello there", FIXED, WINDOW, AFTER]);
	pass("after a reload: the same messages, the last one editable; its edit says the revisions do not compare, never that nothing changed");

	// 7. Tasks on: the pencil says why the message cannot be edited and stops nothing; a message sent with Tasks off is edited
	await click(".agent-tasks-toggle");
	await waitFor("document.querySelector('.agent-tasks-toggle')?.getAttribute('aria-checked') === 'true'", "Tasks on");
	const TASKED = "Plan the scene [[hold]]";
	await sayOver(TASKED);
	for (let i = 0; i < 300 && !calls.some(call => call.words.includes("[[hold]]")); i++) await sleep(100);
	await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'", "the task-mode turn runs");
	await hover(lastBubble); await click(`${lastBubble}.querySelector('.agent-edit-open')`);
	await waitFor("/sent with Tasks on cannot be edited/.test(document.querySelector('.agent-steer-notice')?.textContent ?? '')", "the notice says why");
	await panelShot("edit-6-tasks-on-notice-panel");
	assert.equal(await evaluate("!!document.querySelector('.agent-edit-input')"), false, "the edit stays shut");
	assert.equal(await evaluate("document.querySelector('.agent-panel').dataset.agentState"), "streaming", "the task-mode turn was not stopped");
	gate("B").open();
	await waitFor(idle, "the task-mode turn ended");
	await click(".agent-tasks-toggle");
	await waitFor("document.querySelector('.agent-tasks-toggle')?.getAttribute('aria-checked') === 'false'", "Tasks off");
	const PLAIN = "Add a lmap", LAMP = "Add a lamp";
	await sayOver(PLAIN);
	await waitFor(`${idle} && [...document.querySelectorAll('.agent-assistant-text')].some(node => node.textContent.includes(${JSON.stringify(`QA heard: ${PLAIN}`)}))`, "reply to the plain message");
	await openEdit();
	await correct(LAMP);
	const beforePlain = calls.length;
	await press("Enter");
	await waitFor(`${idle} && [...document.querySelectorAll('.agent-assistant-text')].some(node => node.textContent.includes(${JSON.stringify(`QA heard: ${LAMP}`)}))`, "reply to the corrected plain message");
	const plain = calls.slice(beforePlain);
	assert.equal(plain.length, 1);
	assert.ok(!plain[0].texts.join("\n").includes("lmap"), "the typo left the model's context");
	assert.ok(plain[0].texts.join("\n").includes(TASKED), "the task-mode exchange stays");
	assert.equal((await bubbles()).at(-1), LAMP);
	pass("Tasks on: the pencil answers 'A message sent with Tasks on cannot be edited.' and the turn runs on; a message sent with Tasks off in the same conversation is edited");

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
