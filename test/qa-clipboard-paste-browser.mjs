#!/usr/bin/env node
// Browser QA for pasting a clipboard picture into the studio, driven over CDP
// through tools/qa-browser.mjs. The clipboard is the QA browser's own (written
// with navigator.clipboard) and Cmd+V is a real key event carrying the "paste"
// editing command, so the browser builds the ClipboardEvent itself.
//
// Two surfaces take a picture. The Agent composer attaches it to the message;
// the stage turns it into a cutout prop. Opening the Studio Agent panel used to
// leave the composer unfocused, so the first Cmd+V after opening it landed on
// the stage and a prop appeared instead of an attachment.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5912 npm run dev -- --port 5812`
// in one shell, then
// `QA_URL=http://127.0.0.1:5812/app/ CDP_PORT=9812 node tools/qa-browser.mjs -- node test/qa-clipboard-paste-browser.mjs`
import assert from "node:assert/strict";

const cdpPort = Number(process.env.CDP_PORT || 9812);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) || targets.find((target) => target.type === "page");
assert.ok(page, "studio page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id) events.push(message);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, probe, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await sleep(120);
	}
	throw new Error(`Timed out waiting for ${label}`);
};
let failures = 0;
const expect = (label, value, detail = "") => {
	console.log(`${value ? "PASS" : "FAIL"} ${label}${value || !detail ? "" : ` - ${detail}`}`);
	if (!value) failures += 1;
};

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.bringToFront");
await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(page.url).origin });
await waitFor("the studio shell", () => evaluate("!!document.querySelector('[data-testid=studio-agent-bar]')"), 30000);

const writePicture = (colour) => evaluate(`(async () => {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 48;
	const context = canvas.getContext("2d");
	context.fillStyle = ${JSON.stringify(colour)};
	context.fillRect(0, 0, 48, 48);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
	return true;
})()`);
const writeText = (text) => evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
const pressPaste = async () => {
	const key = { modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86 };
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["paste"] });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	await sleep(900);
};
const cutouts = () => evaluate("[...document.querySelectorAll('.hierarchy-row')].filter((row) => /^pasted-/.test(row.innerText.trim())).length");
const attachments = () => evaluate("document.querySelectorAll('.agent-attachment').length");
const active = () => evaluate("(() => { const el = document.activeElement; return `${el.tagName}.${String(el.className)}`; })()");
const click = async (selector) => {
	const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	assert.ok(point, `${selector} is not on screen`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
	await sleep(500);
};

// --- the Studio Agent composer ------------------------------------------
// The composer stays disabled until GET /agent/models answers, and a disabled
// textarea ignores focus(). On a fast machine the list lands before anyone
// looks, so hold the answer back to make the slow path happen every time.
const MODEL_LIST_DELAY_MS = 1800;
await send("Fetch.enable", { patterns: [{ urlPattern: "*/agent/models*", requestStage: "Request" }] });
let heldModelRequests = 0;
const release = (requestId) => setTimeout(() => { send("Fetch.continueRequest", { requestId }).catch(() => {}); }, MODEL_LIST_DELAY_MS);
const holdModels = setInterval(() => {
	while (events.length) {
		const message = events.shift();
		if (message.method !== "Fetch.requestPaused") continue;
		heldModelRequests += 1;
		release(message.params.requestId);
	}
}, 20);
await send("Page.reload");
await sleep(500);
await waitFor("the studio shell after reload", () => evaluate("!!document.querySelector('[data-testid=studio-agent-bar]')"), 30000);
await click("[data-testid=studio-agent-bar]");
const openedAt = Date.now();
await waitFor("the composer textarea", () => evaluate("!!document.querySelector('.agent-input')"));
expect("the model list is still pending when the panel opens (delay took effect)", await evaluate("document.querySelector('.agent-input').disabled"), `held=${heldModelRequests}`);
await waitFor("the composer", () => evaluate("!!document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled && document.querySelector('.agent-input').offsetParent !== null"));
clearInterval(holdModels);
await send("Fetch.disable");
expect("the delayed model list really arrived late", heldModelRequests > 0 && Date.now() - openedAt > 500, `held=${heldModelRequests}`);
expect("opening the Agent panel focuses the composer", (await active()).startsWith("TEXTAREA.agent-input"), await active());

const stageBefore = await cutouts();
await writePicture("#cc3333");
await pressPaste();
expect("Cmd+V in the composer attaches the picture", (await attachments()) === 1, `attachments=${await attachments()}`);
expect("and does not also land on the stage", (await cutouts()) === stageBefore, `cutouts ${stageBefore} -> ${await cutouts()}`);

await evaluate("document.querySelector('.agent-attach-chip').focus()");
await writePicture("#33cc33");
await pressPaste();
expect("a paste with focus on a composer button attaches too", (await attachments()) === 2, `attachments=${await attachments()}`);
expect("that paste did not reach the stage either", (await cutouts()) === stageBefore, `cutouts ${stageBefore} -> ${await cutouts()}`);

await evaluate("document.querySelector('.agent-input').focus()");
await writeText("steady text");
await pressPaste();
expect("a text paste stays in the composer as text", (await evaluate("document.querySelector('.agent-input').value")).includes("steady text"));
expect("and attaches nothing", (await attachments()) === 2);

for (const colour of ["#3333cc", "#cccc33", "#33cccc"]) {
	await writePicture(colour);
	await pressPaste();
}
expect("a message carries at most four pictures", (await attachments()) === 4, `attachments=${await attachments()}`);
expect("the fifth is refused out loud", /Up to 4/.test((await evaluate("document.querySelector('.agent-attachment-notice')?.textContent")) ?? ""));

// --- the stage ----------------------------------------------------------
await click(".studio-agent-collapse");
await evaluate("document.activeElement?.blur()");
await writePicture("#cc33cc");
await pressPaste();
await waitFor("the pasted cutout", async () => (await cutouts()) === stageBefore + 1, 8000).catch(() => null);
expect("with the panel closed, Cmd+V on the stage adds a cutout prop", (await cutouts()) === stageBefore + 1, `cutouts ${stageBefore} -> ${await cutouts()}`);
expect("the stage paste is selected for placing", await evaluate("/^pasted-/.test(document.querySelector('.hierarchy-row-wrap.selected .hierarchy-row')?.innerText.trim() ?? '')"));

ws.close();
if (failures) {
	console.error(`${failures} clipboard paste check(s) failed`);
	process.exit(1);
}
console.log("PASS clipboard paste: composer attaches, stage cutouts");
