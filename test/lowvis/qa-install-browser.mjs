#!/usr/bin/env node
// What the motion tool installs, when, and what survives it, in a real Studio: headless Chrome on Vite with this repo's
// agent routes, the live hub, the pi runner, the real motion door, writer harness, engine and install. Only the two
// models are scripted: the Studio agent's (a faux provider) and the motion writer's (a local server that speaks the
// proxy's wire format), so no model or proxy runs. Driven with real key and pointer events (CDP Input).
//   node test/lowvis/qa-install-browser.mjs   (ports: QA_PORT 5196, QA_LIVE_PORT 5396, QA_CDP_PORT 9343; QA_OUT dir;
//   QA_LOCALE en | ko; COZYCLAY_FIGURE as the Studio is launched; QA_PROBE contacts | contact-frames | worn: that probe instead)
// Every scene and spec here is made up for this check.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startLiveHub } from "../../mcp/live-hub.mjs";
import { createAgentHandler } from "../../bin/agent/agent-routes.mjs";
import { createFakeModel } from "../fixtures/fake-model.mjs";
import { createSessionStore } from "../../bin/agent/session-store.mjs";
import { scenarios } from "./qa-install-scenarios.mjs";
import { scenarios as contactScenarios } from "./qa-contacts-scenarios.mjs";
import { scenarios as contactFrameScenarios } from "./qa-contact-frames-scenarios.mjs";
import { scenarios as wornScenarios } from "./qa-worn-scenarios.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.QA_PORT || 5196), livePort = Number(process.env.QA_LIVE_PORT || 5396), cdpPort = Number(process.env.QA_CDP_PORT || 9343);
const out = process.env.QA_OUT || `${tmpdir()}/cozyclay-install-qa`, locale = process.env.QA_LOCALE || "en";
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });
const children = [], checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gates = new Map();
const gate = name => { if (!gates.has(name)) { let open; const promise = new Promise(resolve => { open = resolve; }); gates.set(name, { promise, open }); } return gates.get(name); };

// --- the scripted motion writer: a server in the proxy's place --------------------------------------------------------
// writer.plan: { end: "report" | "no" | "cut" | "same", variant, hand, extra (a prop the scene lacks), gate0, gate1 } of
// the next run; requests: what each got. QA_WRITER=real leaves the proxy of the environment in place (a real writer).
const writer = { plan: { end: "report", variant: 0 }, requests: [], runs: 0, steps: 0, closed: 0 }; // steps: the model calls after a compile; closed: the calls cut by the caller
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); };
const reply = (res, block, stop) => sse(res, [
	{ type: "message_start", message: { id: `msg-${Date.now()}`, type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: "motion", input: {} } },
	{ type: "content_block_delta", index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
]);
const proxy = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const path = new URL(req.url, "http://local").pathname;
	if (path === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "claude-opus-5-5", object: "model", owned_by: "anthropic" }] })); return; }
	if (path !== "/v1/messages") { res.writeHead(404).end(); return; }
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8")), text = m => (typeof m.content === "string" ? m.content : m.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
	const request = text(body.messages[0]), step = body.messages.filter(m => m.role === "assistant").length;
	if (step === 0) { writer.runs++; writer.requests.push(request); writer.now = { ...writer.plan }; } else writer.steps++;
	res.on("close", () => { if (!res.writableEnded) writer.closed++; });
	const plan = writer.now;
	try {
		if (step === 0) {
			if (plan.gate0) await gate(plan.gate0).promise;
			if (plan.end === "same") { reply(res, { type: "tool", id: `w${writer.runs}-1`, input: {} }, "tool_use"); return; }
			// the scene the request shows (the Studio's characters and props), with a cup the first character holds and a crate on the floor
			const line = request.split("\n").find(l => l.startsWith("{\"characters\":")), shown = line ? JSON.parse(line) : { characters: [], props: [] };
			const who = shown.characters[0] ?? { id: "a", at: [0, 0], heading: 0 };
			const props = [...shown.props.filter(p => !["cup", "crate"].includes(p.id)), { id: "cup", size: [0.08, 0.1, 0.08], at: [who.at[0] + 0.2, 0.85, who.at[1] + 0.25], moves: true }, { id: "crate", size: [0.4, 0.4, 0.4], at: [who.at[0] + 1.2, 0.2, who.at[1] + 0.4 + 0.1 * (plan.variant ?? 0)] }, ...(plan.extra && !shown.props.some(p => p.id === plan.extra) ? [{ id: plan.extra, size: [0.4, 0.45, 0.4], at: [who.at[0] - 1, 0.225, who.at[1] + 0.5] }] : [])];
			const scene = { frames: 72, characters: [{ id: who.id, at: who.at, heading: who.heading ?? 0, ...(plan.scale ? { scale: plan.scale } : {}) }], props };
			const hand = plan.hand ?? "R", spec = { [who.id]: [[0, "hold", { prop: "cup", hand }], [20, "pose", { [hand]: [hand === "R" ? 0.1 : -0.1, 0.45, 0.35], over: 18 }], [50, "pose", { [hand === "R" ? "L" : "R"]: [hand === "R" ? -0.1 : 0.1, 0.4 + 0.02 * (plan.variant ?? 0), 0.3], over: 10 }]] };
			reply(res, { type: "tool", id: `w${writer.runs}-1`, input: plan.make ? plan.make(who, shown) : { scene, spec } }, "tool_use"); // make: a probe's own scene and spec
			return;
		}
		if (plan.gate1) await gate(plan.gate1).promise;
		if (plan.end === "cut") { reply(res, { type: "text", text: "The hand is not on the cup yet, I will" }, "max_tokens"); return; }
		reply(res, { type: "text", text: plan.end === "no" ? "The grip is not fixed yet.\nInstall: no (the hand slips)\nMissing: none" : plan.end === "same" ? "Nothing was changed.\nMissing: none" : `The cup is lifted (variant ${plan.variant ?? 0}).\nMissing: none` }, "end_turn");
	} catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
if (process.env.QA_WRITER !== "real") {
	process.env.CLIPROXY_BASE_URL = `http://127.0.0.1:${proxy.address().port}`;
	process.env.CLIPROXY_API_KEY = "qa-key-not-a-secret";
}

// --- the scripted Studio agent: agent.program holds the steps of the next turn ----------------------------------------
// a step: ["motion", args] | ["result", args] | ["undo"] (undo_edit of every receipt of the last answer's undo, in order)
// | ["gate", name] (the model thinks until the gate opens) | ["call", tool, args]
const agent = { program: [], results: [], contexts: [], calls: 0, epoch: 0 };
const textOf = message => (typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n"));
const fake = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
fake.fauxProvider.setResponses(Array.from({ length: 400 }, () => async context => {
	const messages = context.messages, lastMessage = messages.at(-1), n = ++agent.calls, epoch = agent.epoch;
	if (lastMessage?.role === "user") agent.contexts.push(messages.filter(m => m.role === "user").map(textOf).at(-1));
	if (lastMessage?.role === "toolResult") { const raw = textOf(lastMessage); let value = raw; try { value = JSON.parse(raw); } catch { /* an error text */ } agent.results.push({ name: lastMessage.toolName, isError: Boolean(lastMessage.isError), value }); }
	for (;;) {
		const step = agent.program.shift();
		if (!step) return fauxAssistantMessage([fauxText("QA: done.")]);
		if (step[0] === "gate") { await gate(step[1]).promise; if (agent.epoch !== epoch) return fauxAssistantMessage([fauxText("QA: a stopped turn.")]); continue; }
		if (step[0] === "undo") { const ids = agent.results.findLast(r => Array.isArray(r.value?.undo))?.value.undo ?? []; agent.program.unshift(...ids.map(receiptId => ["call", "undo_edit", { receiptId }])); continue; }
		if (step[0] === "motion") return fauxAssistantMessage([fauxToolCall("motion", step[1] ?? { request: "qa note" }, { id: `qa-${n}` })]);
		if (step[0] === "result") return fauxAssistantMessage([fauxToolCall("motion_result", step[1] ?? {}, { id: `qa-${n}` })]);
		return fauxAssistantMessage([fauxToolCall(step[1], step[2] ?? {}, { id: `qa-${n}` })]);
	}
}));

// --- the sidecar, Vite and Chrome -----------------------------------------------------------------------------------
const hub = await startLiveHub(livePort);
assert.ok(hub, `QA must own live port ${livePort}`);
const handler = createAgentHandler({ auth: { getAccessToken: async () => "qa-token" }, codex: { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: {} }), listModels: async () => ["qa"] },
	models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, sessionStore: createSessionStore(`${out}/sessions-${Date.now()}`), supervisor: false, studioTasks: () => false, port: () => port });
const sidecar = createServer(async (req, res) => {
	const path = (req.url || "").split("?")[0];
	try {
		if (path === "/oauth/status") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedIn: true, email: "qa@example.invalid", plan: "Plus" })); return; }
		if (!(await handler(req, res, path)) && !res.writableEnded) res.writeHead(404).end();
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
const panelShot = async name => {
	const r = await evaluate("(() => { const r = document.querySelector('.agent-panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
	await writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 2 } })).data, "base64"));
};
const waitFor = async (expression, label, ms = 60_000) => {
	for (let t = 0; t < ms; t += 150) { try { const value = typeof expression === "function" ? await expression() : await evaluate(expression); if (value) return value; } catch { /* page busy */ } await sleep(150); }
	await shot(`timeout-${label.replace(/\W+/g, "-")}`).catch(() => {});
	throw new Error(`Timed out: ${label}; results=${JSON.stringify(agent.results.slice(-3)).slice(0, 1500)} errors=${JSON.stringify(errors.slice(-3))}`);
};
const click = async selector => {
	const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error("missing or disabled: " + ${JSON.stringify(selector)}); element.scrollIntoView({ block: "nearest" }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
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
const idle = () => waitFor("document.querySelector('.agent-panel')?.dataset.agentState !== 'streaming' && !document.querySelector('.agent-send.stop')", "the turn ended", 120_000);
const running = () => waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming' && !!document.querySelector('.agent-send.stop')", "the turn runs");
// one turn of the scripted agent: the user's message, the agent's steps, to its end; -> the tool results of the turn
const turn = async (words, program, { wait = true } = {}) => {
	const from = agent.results.length;
	agent.epoch++;
	agent.program = program.map(step => [...step]);
	await say(words);
	if (!wait) { await running(); return null; }
	await running().catch(() => {});
	await idle();
	return agent.results.slice(from);
};
// the user's Stop of the running turn
const stop = async () => { await click(".agent-send.stop"); await idle(); };
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); if (r?.ok !== true) throw new Error(${JSON.stringify(id)} + ": " + (r?.code ?? "") + " " + (r?.message ?? "refused")); return { affectedIds: r.affectedIds }; })()`);
const describe = () => hub.command("describe", {});
// the scene as the user has it: the cast, the objects and each take with what it keeps
const sceneOf = read => {
	const open = read.document.scenes.find(scene => scene.id === read.document.activeSceneId);
	return { sceneId: open.id, characters: open.stage.characters.map(({ motionTake, ...row }) => ({ ...row, take: motionTake ? { name: motionTake.spec?.lowvis?.name ?? null, lowvis: motionTake.spec?.lowvis ?? null, chars: JSON.stringify(motionTake).length } : null })), objects: open.stage.objects ?? read.objects };
};
const snapshot = async () => sceneOf(await describe());
const last = (results, name) => results.findLast(r => r.name === name);

const report = { locale, figure: process.env.COZYCLAY_FIGURE ?? null };
const only = (process.env.QA_ONLY || "").split(",").filter(Boolean), wants = name => !only.length || only.includes(name);
try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('cozyclay.locale',${JSON.stringify(locale)}); localStorage.setItem('cozyclay.agent.tasks','off'); if (!localStorage.getItem('cozyclay.project-session.v1')) localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Install QA', updatedAt: Date.now() }));` });
	await send("Page.navigate", { url: `${origin}/app/` });
	await waitFor("!!window.__cozyclay?.runStudioAction && !!document.querySelector('.studio-agent-bar')", "Studio ready", 120_000);
	if (!(await evaluate("!!document.querySelector('.agent-input') && document.querySelector('.agent-input').offsetParent !== null"))) await click(".studio-agent-bar");
	await waitFor("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "agent composer ready", 60_000);
	const ID = (await act("character.add", { character: { x: 0, z: 0 } })).affectedIds[0];
	await waitFor(`!!window.__cozyclay.rigs?.[${JSON.stringify(ID)}]?.parent`, "the character's rig");
	const start = await snapshot();
	report.start = { characters: start.characters.map(c => c.id), objects: start.objects.length };

	// QA_PROBE: one of this folder's probes in place of this check's scenarios; QA_SCENARIOS: another module's scenarios(t)
	const probes = { contacts: contactScenarios, "contact-frames": contactFrameScenarios, worn: wornScenarios };
	await (probes[process.env.QA_PROBE] ?? (process.env.QA_SCENARIOS ? (await import(process.env.QA_SCENARIOS)).scenarios : scenarios))({ ID, hub, turn, stop, act, snapshot, last, writer, agent, gate, sleep, click, say, idle, waitFor, evaluate, shot, panelShot, pass, report, wants, assert, send, locale, press });
	assert.deepEqual(errors, [], "no page error");
	report.checks = checks;
	await writeFile(`${out}/install-qa-${locale}.json`, JSON.stringify(report, null, "\t"));
	console.log(`ok install QA: ${checks.length} checks; report ${out}/install-qa-${locale}.json`);
} catch (error) {
	report.failed = String(error?.stack ?? error); report.checks = checks;
	await writeFile(`${out}/install-qa-${locale}.json`, JSON.stringify(report, null, "\t")).catch(() => {});
	console.error(error);
	process.exitCode = 1;
} finally {
	for (const entry of gates.values()) entry.open();
	ws.close();
	for (const child of children) child.kill("SIGTERM");
	await new Promise(resolve => hub.server.close(resolve)).catch(() => {});
	sidecar.closeAllConnections(); sidecar.close();
	proxy.closeAllConnections(); proxy.close();
	setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
