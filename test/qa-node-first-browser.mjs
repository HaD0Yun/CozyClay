#!/usr/bin/env node
// Real browser QA for issue #152. Run through tools/qa-browser.mjs.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { WebSocket } = createRequire(fileURLToPath(new URL("../mcp/package.json", import.meta.url)))("ws");

const cdpPort = Number(process.env.CDP_PORT || 9430);
const out = "/tmp/node-first-qa";
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes("/workflow/")) || targets.find((entry) => entry.type === "page");
assert.ok(target, "no workflow page target on the QA browser");
const cdp = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = reject; });
let sequence = 0;
const pending = new Map();
const consoleErrors = [];
cdp.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") || message.params.type);
  }
  if (!message.id || !pending.has(message.id)) return;
  const item = pending.get(message.id); pending.delete(message.id);
  message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
  return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const screenshot = async (name) => {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = `${out}/${name}.png`; await writeFile(path, Buffer.from(result.data, "base64")); return path;
};
const dataImage = (src) => Buffer.from(src.slice(src.indexOf(",") + 1), "base64");

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await waitFor("Agent panel ready", () => evaluate("!!document.querySelector('.agent-panel .agent-input') && !!document.querySelector('.agent-model-select')"), 30000);
const before = await evaluate("({ nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length })");
await screenshot("01-before");

const MODEL = process.env.QA_MODEL || "gpt-6-astra";
await waitFor("model list", () => evaluate("[...document.querySelectorAll('.agent-model-select option')].some((option) => option.value === '" + MODEL + "')"), 20000);
await evaluate("(() => { const select = document.querySelector('.agent-model-select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, '" + MODEL + "'); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
await waitFor("model selection", () => evaluate("document.querySelector('.agent-model-select')?.value === '" + MODEL + "'"), 5000);
await evaluate("document.querySelector('.agent-attach-chip').click()");
await waitFor("frame attachment", () => evaluate("document.querySelector('.agent-attach-chip')?.getAttribute('aria-pressed') === 'true'"), 5000);
await evaluate("(() => { const input = document.querySelector('.agent-input'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, 'Regenerate the attached reference in the current scene framing, photoreal golden hour'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
await waitFor("enabled Send", () => evaluate("document.querySelector('.agent-send:not(.stop)')?.disabled === false"), 5000);
await evaluate("document.querySelector('.agent-send:not(.stop)').click()");
// The UI may briefly render the running state between CDP evaluations; wait for
// the observable terminal state rather than relying on a Stop-button race.
await waitFor("turn end", () => evaluate("!document.querySelector('.agent-send.stop') && !!document.querySelector('.agent-row.user')"), 360000);
const labels = await evaluate("[...document.querySelectorAll('.agent-panel .agent-step[data-step-kind=\"tool\"] .agent-step-label')].map((node) => node.textContent.trim())");
// Bring every node into view: the agent places new nodes to the right of the graph.
await evaluate("(() => { const fit = document.querySelector('.react-flow__controls-fitview'); fit?.click(); return !!fit; })()");
await new Promise((resolve) => setTimeout(resolve, 800));
const dump = await evaluate("[...document.querySelectorAll('.react-flow__node')].map((entry) => ({ type: entry.getAttribute('data-id'), selects: [...entry.querySelectorAll('select')].map((s) => s.value), img: !!entry.querySelector('img.workflow-image-preview'), status: (entry.textContent.match(/Sign in|error|failed|Generating|responded \\d+/) || [])[0] || null }))");
console.log("node dump:", JSON.stringify(dump));
const after = await evaluate("(() => { const generated = [...document.querySelectorAll('.react-flow__node')].filter((entry) => [...entry.querySelectorAll('select')].some((select) => select.value === 'image-generation')); const node = generated.find((entry) => entry.querySelector('img.workflow-image-preview')) || generated.at(-1); return { nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length, imageNodeText: node?.textContent || '', preview: node?.querySelector('img.workflow-image-preview')?.src || null }; })()");
const imageNodeText = after.imageNodeText || "";
const imagePreview = after.preview;
if (imagePreview?.startsWith("data:image/png")) await writeFile(`${out}/generated.png`, dataImage(imagePreview));
await screenshot("02-after-turn");
console.log(`tool labels: ${JSON.stringify(labels)}`);
console.log(`node counts: before=${before.nodes}, after=${after.nodes}`);
console.log(`edge counts: before=${before.edges}, after=${after.edges}`);
console.log(`console errors/warnings: ${JSON.stringify(consoleErrors)}`);
assert.ok(after.nodes > before.nodes, `no new canvas node (before=${before.nodes}, after=${after.nodes}); tool labels=${JSON.stringify(labels)}`);
assert.ok(after.edges >= before.edges + 1, `edge count did not increase (before=${before.edges}, after=${after.edges}); tool labels=${JSON.stringify(labels)}`);
assert.ok(imageNodeText.includes("Image") && imageNodeText.includes("Image Generation"), `no Image/Image Generation node on canvas; tool labels=${JSON.stringify(labels)}`);
assert.ok(imagePreview?.startsWith("data:image/png"), `no generated PNG preview inside Image node; tool labels=${JSON.stringify(labels)}`);
assert.ok(await import("node:fs").then(({ existsSync }) => existsSync(`${out}/generated.png`)), "generated PNG evidence was not written");
console.log(`evidence: ${out}/01-before.png, ${out}/02-after-turn.png, ${out}/generated.png`);
console.log("PASS qa-node-first-browser");
cdp.close();
