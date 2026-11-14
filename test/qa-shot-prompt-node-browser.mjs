#!/usr/bin/env node
// Browser contract for the Shot Prompt node (#166). A Scene node that already
// holds a capture (data.lastOutput.meta, preview "render") feeds a shot-prompt
// node; running that node has to turn the stored metadata into the structured
// prompt from src/shot-prompt.js, in the node's own textarea.
//
// Run: `COZYCLAY_LIVE_PORT=5324 npm run dev -- --port 5320` in one shell, then
// `QA_URL=http://127.0.0.1:5320/workflow/ CDP_PORT=9466 node tools/qa-browser.mjs -- node test/qa-shot-prompt-node-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9466);
const out = "/tmp/shot-prompt-qa";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/workflow/")) || targets.find((target) => target.type === "page");
assert.ok(page, "workflow page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const clickSelector = async (selector) => {
	const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
	assert.ok(box, `no element matches ${selector}`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
};

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const meta = {
	focalMm: 35,
	fovDeg: 38,
	aspect: "16:9",
	size: { width: 1920, height: 1080 },
	cameraMove: { dolly: true, crane: false, rail: false },
	keyLight: { intensity: 1 },
	cast: [{ name: "Alpha", model: "y-bot" }],
	frameRange: { start: 0, end: 71 },
	fps: 24,
	shotTitle: "Shot 1",
};
const graph = {
	version: 1,
	nodes: [
		{
			id: "scene-qa",
			type: "scene",
			position: { x: 80, y: 100 },
			// preview "render" shows the captured frame instead of the live
			// Studio iframe, exactly like a Scene node that was already run.
			data: { label: "CozyClay Scene", sceneName: "CozyClay Scene", status: "complete", statusMessage: "Captured framing PNG", preview: "render", lastOutput: { renderUrl: PIXEL, sceneUrl: "/app/", jobId: null, meta }, outputs: [{ value: PIXEL }], resultUrl: PIXEL },
		},
		{ id: "text-qa", type: "text", position: { x: 80, y: 460 }, data: { label: "Text", prompt: "moody rim light, dusk" } },
		{ id: "shot-prompt-qa", type: "shot-prompt", position: { x: 560, y: 200 }, data: { label: "Shot Prompt", target: "image", referenceOwnsCamera: true, prompt: "" } },
	],
	edges: [
		{ id: "e-scene-shot", source: "scene-qa", target: "shot-prompt-qa", sourceHandle: "render", targetHandle: "input" },
		{ id: "e-text-shot", source: "text-qa", target: "shot-prompt-qa", sourceHandle: "output", targetHandle: "input" },
	],
};

await mkdir(out, { recursive: true });
await evaluate(`localStorage.setItem("cozyclay.workflow.v1", ${JSON.stringify(JSON.stringify(graph))}), true`);
await send("Page.reload", { ignoreCache: true });
await waitFor("the Shot Prompt node", () => evaluate("!!document.querySelector('.workflow-node-shot-prompt .workflow-shot-prompt-text')"));
const promptText = () => evaluate("document.querySelector('.workflow-node-shot-prompt .workflow-shot-prompt-text').value");
assert.equal(await promptText(), "", "the seeded node starts without a prompt");
console.log("PASS the seeded Shot Prompt node renders with an empty prompt textarea");

// The node's own Run control is the same store run the Image node's run button
// uses: runWorkflow(nodeId) over the whole graph.
await clickSelector(".workflow-node-shot-prompt .workflow-mini-button");
const prompt = await waitFor("the built prompt", async () => (await promptText()) || null);
assert.match(prompt, /35mm/, `prompt should carry the seeded focal length, got: ${prompt}`);
assert.match(prompt, /^SHOT: Shot 1, 3s, 16:9$/m, "the SHOT line comes from the stored capture metadata");
assert.match(prompt, /^CAST: Alpha$/m, "the cast comes from the stored capture metadata");
assert.match(prompt, /^LOOK: moody rim light, dusk$/m, "the connected Text node supplies the intent");
console.log(`PASS running the node builds the prompt from the Scene capture metadata: ${JSON.stringify(prompt.split("\n")[1])}`);

const stored = await evaluate("(() => { const g = JSON.parse(localStorage.getItem('cozyclay.workflow.v1')); const node = g.nodes.find((n) => n.id === 'shot-prompt-qa'); return { prompt: node?.data?.prompt || '', output: node?.data?.outputs?.[0]?.value || '' }; })()");
assert.ok(stored.prompt.includes("35mm"), "the prompt persists on the node data");
assert.equal(stored.output, stored.prompt, "the node emits the prompt as its output value for downstream Image/Video nodes");
console.log("PASS the prompt persists in the stored graph and is emitted as the node output");

// Target and camera ownership re-shape the prompt on the next run.
await evaluate(`(() => { const select = document.querySelector('.workflow-node-shot-prompt select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, 'video'); select.dispatchEvent(new Event('change', { bubbles: true })); })(), true`);
await evaluate("document.querySelector('.workflow-node-shot-prompt input[type=checkbox]').click(), true");
await clickSelector(".workflow-node-shot-prompt .workflow-mini-button");
const videoPrompt = await waitFor("the video prompt", async () => { const value = await promptText(); return value.includes("MOTION:") ? value : null; });
assert.match(videoPrompt, /^CAMERA: smooth dolly move$/m, "unchecking Reference owns camera describes the captured camera move");
console.log("PASS switching to Video and unchecking Reference owns camera rebuilds the prompt");

await writeFile(`${out}/node.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
console.log(`PASS qa-shot-prompt-node-browser: ${out}/node.png`);
ws.close();
