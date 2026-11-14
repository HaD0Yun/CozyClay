#!/usr/bin/env node
// Browser contract for the Image node's version history (#164). Versions live
// in node.data, so a seeded workflow draft plus a reload proves both halves at
// once: the stored versions survive the round trip through localStorage, and
// the rendered toolbar drives prev/next and the A/B toggle.
//
// Run: `COZYCLAY_LIVE_PORT=5304 npm run dev -- --port 5300` in one shell, then
// `QA_URL=http://127.0.0.1:5300/workflow/ CDP_PORT=9464 node tools/qa-browser.mjs -- node test/qa-image-versions-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9464);
const out = "/tmp/image-versions-qa";
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
const waitFor = async (label, probe, timeoutMs = 20000) => {
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

// Two distinct tiny PNGs, so a swapped preview is both visible on the
// screenshot and assertable by src.
const FIRST = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SECOND = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const graph = {
	version: 1,
	nodes: [{
		id: "image-qa",
		type: "image",
		position: { x: 120, y: 120 },
		data: {
			label: "Image",
			model: "image-generation",
			prompt: "QA version history",
			cost: 0,
			outputHistory: [],
			isLoading: false,
			errorMsg: null,
			versions: [
				{ dataUrl: FIRST, prompt: "take one", referenceDataUrl: null, frameDataUrl: FIRST, at: 1700000000001 },
				{ dataUrl: SECOND, prompt: "take two", referenceDataUrl: null, frameDataUrl: SECOND, at: 1700000000002 },
			],
			versionIndex: 1,
			outputs: [{ value: SECOND }],
			resultUrl: SECOND,
		},
	}],
	edges: [],
};

await mkdir(out, { recursive: true });
await evaluate(`localStorage.setItem("cozyclay.workflow.v1", ${JSON.stringify(JSON.stringify(graph))}), true`);
await send("Page.reload", { ignoreCache: true });
await waitFor("the Image node with a version toolbar", () => evaluate("!!document.querySelector('.workflow-node-image .workflow-version-count')"));

const label = await evaluate("document.querySelector('.workflow-version-count').textContent.trim()");
assert.ok(label.includes("2/2"), `toolbar should read the seeded count after reload, got ${label}`);
console.log(`PASS seeded versions survive the reload: toolbar reads ${label}`);

const shownSrc = () => evaluate("document.querySelector('.workflow-node-image .workflow-image-preview').getAttribute('src')");
assert.equal(await shownSrc(), SECOND, "the node opens on the stored versionIndex");

await clickSelector('[aria-label="Previous version"]');
await waitFor("prev to show the earlier version", async () => (await shownSrc()) === FIRST);
assert.equal(await evaluate("document.querySelector('.workflow-version-count').textContent.trim()"), "v1/2", "prev moves the counter back");
console.log("PASS prev shows versions[0] and moves the counter to v1/2");

const stored = await evaluate("JSON.parse(localStorage.getItem('cozyclay.workflow.v1')).nodes[0].data.outputs[0].value");
assert.equal(stored, FIRST, "selecting a version rewrites the persisted output");
console.log("PASS selecting a version rewrites outputs[0] in the stored graph");

await clickSelector(".workflow-version-ab");
await waitFor("A/B to arm the preview", () => evaluate("!!document.querySelector('.workflow-node-image .workflow-ab-toggle')"));
const armed = await shownSrc();
await clickSelector(".workflow-ab-toggle");
const compared = await waitFor("the A/B click to swap the image", async () => { const src = await shownSrc(); return src !== armed ? src : null; });
assert.equal(compared, SECOND, "A/B alternates to the compare version");
await clickSelector(".workflow-ab-toggle");
await waitFor("the second A/B click to swap back", async () => (await shownSrc()) === armed);
console.log("PASS the A/B toggle alternates the preview between the two versions on click");

await evaluate("document.querySelector('.workflow-version-pin input').click(), true");
await waitFor("Pin refs to persist", () => evaluate("JSON.parse(localStorage.getItem('cozyclay.workflow.v1')).nodes[0].data.pinReferences === true"));
console.log("PASS Pin refs persists on the node data");

await clickSelector(".workflow-ab-toggle");
await writeFile(`${out}/ab.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// "Use as reference" branches the picked take into an Upload node feeding a
// fresh Image node, with the edge between them.
const baseline = await evaluate("document.querySelectorAll('.react-flow__node').length");
await clickSelector(".workflow-version-reuse");
await waitFor("the reference branch nodes", () => evaluate(`document.querySelectorAll('.react-flow__node').length === ${baseline + 2}`));
await waitFor("the Upload -> Image edge", () => evaluate("document.querySelectorAll('.react-flow__edge').length >= 1"));
const branch = await evaluate("(() => { const g = JSON.parse(localStorage.getItem('cozyclay.workflow.v1')); const upload = g.nodes.find((n) => n.type === 'upload'); const image = g.nodes.find((n) => n.id !== 'image-qa' && n.type === 'image'); return { uploadName: upload?.data?.uploadName, thumb: upload?.data?.thumbnail === upload?.data?.image_url, output: upload?.data?.outputs?.[0]?.value === upload?.data?.image_url, dx: Math.round((upload?.position?.x ?? 0) - 120), model: image?.data?.model, edge: g.edges.some((e) => e.source === upload?.id && e.target === image?.id) }; })()");
assert.equal(branch.uploadName, "version-1.png", "the Upload node is named after the version it holds");
assert.ok(branch.thumb && branch.output, "the Upload node carries the version as image_url, thumbnail, and output");
assert.equal(branch.dx, 320, "the Upload node lands 320px to the right of the source node");
assert.equal(branch.model, "image-generation", "the branch ends in a new image-generation node");
assert.ok(branch.edge, "the Upload node feeds the new Image node");
console.log("PASS Use as reference creates Upload -> Image 320px to the right");

await writeFile(`${out}/reference-branch.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
console.log(`PASS qa-image-versions-browser: ${out}/ab.png, ${out}/reference-branch.png`);
ws.close();
