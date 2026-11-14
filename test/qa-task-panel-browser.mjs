#!/usr/bin/env node
// Task mode in a real Studio (parallel tasks, P3): headless Chrome on Vite with this repo's agent routes, the live hub
// and the real bus; only the model is scripted. The server flag is OFF: the panel's Tasks switch opts the session in.
//   node test/qa-task-panel-browser.mjs        (ports: QA_PORT 5322, QA_LIVE_PORT 6162, QA_CDP_PORT 9522; QA_OUT dir)
// Checks: two tasks and a quick edit at once (a third task waits for the first's scope), cards in each state, the
// outliner marks rows in a running scope, cancel through the UI puts the object back, undo task through the UI (newest
// first; the older one is refused while a later task changed its key), the main agent's own report lands in the chat,
// and a reload mid-task: the board comes back and the task's command waits for the Studio to reconnect, then lands
// (the pause on a Studio that stays away is P2's, test/verify-studio-tasks.mjs case 14).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startLiveHub } from "../mcp/live-hub.mjs";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { MAIN_SYSTEM_PROMPT } from "../bin/agent/main-prompt.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.QA_PORT || 5322), livePort = Number(process.env.QA_LIVE_PORT || 6162), cdpPort = Number(process.env.QA_CDP_PORT || 9522);
const out = process.env.QA_OUT || `${tmpdir()}/cozyclay-task-panel`;
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });
const children = [], checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- the scripted model --------------------------------------------------------------------------------------------
const gates = new Map();
const gate = name => { if (!gates.has(name)) { let open; const promise = new Promise(resolve => { open = resolve; }); gates.set(name, { promise, open }); } return gates.get(name); };
const textOf = message => (typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? ""));
const marker = (text, key) => new RegExp(`\\[\\[${key}:([^\\]]+)\\]\\]`).exec(text)?.[1];
const fake = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
const step = async context => {
	const last = context.messages.at(-1), lastText = textOf(last);
	if (getCurrentSystemPrompt(context.messages) === MAIN_SYSTEM_PROMPT) {
		if (last.role !== "user") return fauxAssistantMessage([fauxText("Started.")]);
		if (lastText.includes("Task events arrived")) return fauxAssistantMessage([fauxText("QA main report: the tasks ended.")]);
		const [c1, c2, c3] = ["c1", "c2", "c3"].map(key => marker(lastText, key));
		const task = (title, instructions, scope) => fauxToolCall("dispatch_task", { title, instructions, scope }, { id: `m-${Math.random().toString(16).slice(2)}` });
		if (lastText.includes("[[run]]")) return fauxAssistantMessage([
			task("Move cube one", `Move ${c1} to x 1. GATE:A`, [`object:${c1}`]),
			task("Move cube two", `Move ${c2} to x 2. GATE:B`, [`object:${c2}`]),
			task("Nudge cube one again", `Move ${c1} to x 1.5. GATE:none`, [`object:${c1}`]),
			fauxToolCall("quick_edit", { scope: [`object:${c3}`], tool: "run_action", args: { action: "object.set", args: { id: c3, set: { position: { x: 3, y: 0, z: 0 } } } } }, { id: "m-quick" }),
		]);
		if (lastText.includes("[[second]]")) return fauxAssistantMessage([task("Move cube three", `Move ${c3} to x 4. GATE:C-before`, [`object:${c3}`])]);
		return fauxAssistantMessage([fauxText("QA main: noted.")]);
	}
	const all = JSON.stringify(context.messages), instructions = /Move ([\w-]+) to x ([\d.]+)\. GATE:([A-Za-z-]+)/.exec(all);
	const [, id, x, name] = instructions;
	const toolCall = () => fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id, set: { position: { x: Number(x), y: 0, z: 0 } } } }, { id: `t-${Math.random().toString(16).slice(2)}` })]);
	const okResult = last.role === "toolResult" && !last.isError && !/"ok":false/.test(lastText.slice(0, 300));
	if (!okResult) {
		if (name.endsWith("-before") && !all.includes("Studio reconnected")) await gate(name).promise;
		return toolCall();
	}
	if (name !== "none" && !name.endsWith("-before")) await gate(name).promise;
	return fauxAssistantMessage([fauxText(`Moved ${id} to x ${x}. QA: none.`)]);
};
fake.fauxProvider.setResponses(Array.from({ length: 200 }, () => step));

// --- the sidecar, Vite and Chrome -----------------------------------------------------------------------------------
const hub = await startLiveHub(livePort);
assert.ok(hub, `QA must own live port ${livePort}`);
const agent = createAgentHandler({ auth: { getAccessToken: async () => "qa-token" }, codex: { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: {} }), listModels: async () => ["qa"] },
	models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, sessionStore: createSessionStore(`${out}/sessions-${Date.now()}`), supervisor: false, studioTasks: () => false, taskLimits: { staggerMs: 0 }, port: () => port });
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
own(spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${out}/chrome-${Date.now()}`, "--window-size=1600,1000", "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" }));
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
const waitFor = async (expression, label, ms = 60_000) => {
	for (let t = 0; t < ms; t += 200) { try { const value = await evaluate(expression); if (value) return value; } catch { /* page busy */ } await sleep(200); }
	await shot(`timeout-${label.replace(/\W+/g, "-")}`).catch(() => {});
	const probe = await evaluate(`({ cozy: !!window.__cozyclay, run: !!window.__cozyclay?.runStudioAction, input: !!document.querySelector('.agent-input'), disabled: document.querySelector('.agent-input')?.disabled, rows: document.querySelectorAll('.agent-transcript .task-row').length, statuses: [...document.querySelectorAll('.agent-transcript .task-row')].map(c => c.querySelector('.task-row-title')?.textContent + ':' + c.dataset.status + ':' + (c.querySelector('.task-row-line')?.textContent ?? '')), agent: document.querySelector('[data-agent-card]')?.dataset.agentCard, nodes: [...document.querySelectorAll('[data-node-id]')].map(n => n.dataset.nodeId + (n.dataset.taskScope ? '*' : '')).slice(0, 30), toggles: [...document.querySelectorAll('button')].filter(b => /agent|Agent|에이전트/.test(b.className + b.textContent + (b.getAttribute('aria-label') || ''))).map(b => b.className + '|' + b.textContent.slice(0, 20) + '|' + b.getAttribute('aria-label')).slice(0, 12) })`).catch(error => String(error));
	throw new Error(`Timed out: ${label} ${JSON.stringify(probe)}`);
};
const shot = async name => writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
// A task is one row in the chat; its actions and notices live in the task view a row opens.
const card = title => `[...document.querySelectorAll('.agent-transcript .task-row')].find(el => el.querySelector('.task-row-title')?.textContent === ${JSON.stringify(title)})`;
const statusOf = title => `${card(title)}?.dataset.status`;
const opened = title => `(document.querySelector('.task-detail-title')?.textContent === ${JSON.stringify(title)} ? document.querySelector('.task-detail') : null)`;
const noticeOf = title => `${opened(title)}?.querySelector('.task-detail-notice')?.textContent`;
const clickIn = async (title, label) => {
	await evaluate(`${card(title)}.click(), true`);
	await waitFor(`!!${opened(title)}`, `${title} opened`);
	return evaluate(`(() => { const button = [...${opened(title)}.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!button) throw new Error('no ${label} on ${title}'); button.click(); return true; })()`);
};
const say = async text => {
	await evaluate(`(() => { const input = document.querySelector('.agent-input'); input.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
	await waitFor("document.querySelector('.agent-send') && !document.querySelector('.agent-send').disabled", "send enabled");
	await evaluate("document.querySelector('.agent-send').click(), true");
};
const x = id => evaluate(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(id)})?.x`);

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('cozyclay.locale','en');" });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("window.__cozyclay?.runStudioAction && document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "Studio and the agent panel ready", 120_000);
	await evaluate("document.querySelector('.studio-agent-bar')?.click(), true");
	// the server flag is off: the switch opts this session in
	await evaluate("document.querySelector('.agent-tasks-toggle').getAttribute('aria-checked') === 'true' || document.querySelector('.agent-tasks-toggle').click(), true");
	await waitFor("document.querySelector('.agent-tasks-toggle')?.getAttribute('aria-checked') === 'true'", "Tasks switch on");
	const ids = [];
	for (const name of ["QA1", "QA2", "QA3"]) {
		const receipt = await evaluate(`Promise.resolve(window.__cozyclay.runStudioAction('object.add', { kind: 'cube', name: ${JSON.stringify(name)}, placement: { x: 0, z: ${ids.length * 2} } }))`);
		assert.equal(receipt?.ok, true, JSON.stringify(receipt));
		ids.push(receipt.affectedIds[0]);
	}
	const [c1, c2, c3] = ids;
	await say(`Run them. [[run]] [[c1:${c1}]] [[c2:${c2}]] [[c3:${c3}]]`);
	await waitFor(`${statusOf("Move cube one")} === 'running' && ${statusOf("Move cube two")} === 'running' && ${statusOf("Nudge cube one again")} === 'waiting'`, "two tasks run, the third waits for its scope");
	await waitFor(`${card("Move cube one")}.querySelector('.task-row-line')?.textContent.length > 0`, "a running row shows progress");
	await waitFor(`${card("Nudge cube one again")}.querySelector('.task-row-line')?.textContent.includes('Move cube one')`, "a waiting row names the task it waits for, not its id");
	assert.equal(await x(c3), 3);
	pass("the main agent answered at once: two tasks run, a third waits for the first's scope, and the quick edit landed");
	// what a task runs on (#1165): a running row names its model, a waiting one has none yet
	await waitFor(`${card("Move cube one")}.querySelector('.task-row-model')?.textContent.length > 0`, "a running row names its model");
	assert.equal(await evaluate(`${card("Nudge cube one again")}.querySelector('.task-row-model')`), null);
	pass(`a running row names the model it runs on (${await evaluate(`${card("Move cube one")}.querySelector('.task-row-model').textContent`)}); a waiting row names none`);
	await evaluate(`(() => { const row = document.querySelector('[data-node-id="props"]'); if (row?.getAttribute('aria-expanded') === 'false') row.querySelector('.hierarchy-toggle')?.click(); return true; })()`);
	await waitFor(`document.querySelector('[data-node-id="object:${c1}"]')?.dataset.taskScope === 'Move cube one'`, "outliner row marked");
	pass("the outliner marks a row inside a running task's scope");
	await shot("1-running-waiting");

	await clickIn("Move cube two", "Cancel");
	// the scripted model answers one call at a time: once the cancel reached the server, the held step lets go
	await waitFor(`${noticeOf("Move cube two")}?.length > 0`, "the cancel was answered");
	gate("B").open();
	await waitFor(`${statusOf("Move cube two")} === 'cancelled'`, "cancelled");
	await waitFor(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(c2)})?.x === 0`, "cancel restored the object");
	pass("Cancel on a card stops the task and puts its object back");
	await shot("2-cancelled");

	gate("A").open();
	await waitFor(`${statusOf("Move cube one")} === 'done' && ${statusOf("Nudge cube one again")} === 'done'`, "both done (the third started when the first ended)");
	assert.equal(await x(c1), 1.5);
	await waitFor(`[...document.querySelectorAll('.agent-assistant-text')].some(el => el.textContent.includes('QA main report'))`, "the main agent's own report in the chat");
	pass("the third task ran when the first ended; the main agent reported in the chat on its own");
	await shot("3-done");

	await clickIn("Move cube one", "Undo task");
	await waitFor(`${noticeOf("Move cube one")}?.includes('Changed since')`, "the older undo is refused while a later task changed its key");
	await clickIn("Nudge cube one again", "Undo task");
	await waitFor(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(c1)})?.x === 1`, "newest task undone");
	await clickIn("Move cube one", "Undo task");
	await waitFor(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(c1)})?.x === 0`, "older task undone");
	pass("Undo task through the UI: newest first; the older one is refused (named) until then");
	await shot("4-undone");

	await say(`Next. [[second]] [[c3:${c3}]]`);
	// its model is held before its first step, so the card reads queued until then; the run has begun on the server
	await waitFor(`!!${card("Move cube three")}`, "task C dispatched");
	await sleep(1500);
	// the held step lets go while the page is away: its command meets a Studio that is not there
	await send("Page.reload");
	gate("C-before").open();
	await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled && document.querySelectorAll('.agent-transcript .task-row').length > 0", "panel and task rows back after the reload", 120_000);
	await waitFor(`${statusOf("Move cube three")} === 'done'`, "task C done after the reload");
	await waitFor(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(c3)})?.x === 4`, "task C's edit landed in the reloaded Studio");
	await waitFor(`${card("Move cube one")}?.dataset.status === 'done'`, "the earlier cards are back");
	pass("a reload mid-task: the board comes back with every card, and the task's command waits for the same Studio to reconnect and lands");
	await evaluate("document.querySelector('.studio-agent-bar')?.click(), true");
	await sleep(500);
	await shot("5-after-reload");
	assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
	pass("no page errors");
	await writeFile(`${out}/result.json`, JSON.stringify({ checks }, null, 2));
} finally {
	ws.close();
	for (const child of children) child.kill("SIGTERM");
	for (const client of hub.server.clients) client.terminate();
	await new Promise((resolve) => hub.server.close(resolve));
	sidecar.closeAllConnections();
	sidecar.close();
}
