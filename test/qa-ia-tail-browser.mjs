#!/usr/bin/env node
// Browser QA for the last controls docs/studio-ui-ia.md budgets against
// (§1 R6, #189): the scene ROOT has no fold caret and the Characters GROUP row
// is gone (the cast sits directly under the root). CozyClay 3 removed prompt
// generation, so Motion mode carries no Prompt Blocks panel and the top bar no
// Generate Motion. Drives the real studio over CDP and screenshots the tree,
// because "the count went down" and "the panel still reads right" are two claims.
//
//   QA_URL=http://127.0.0.1:5196/app/ CDP_PORT=9256 node tools/qa-browser.mjs \
//     -- node test/qa-ia-tail-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createSceneDocument, SCENES_STORAGE_KEY, serializeSceneDocument } from "../src/scenes.js";
import { characterRowId } from "../src/hierarchy-model.js";

const fixture = createSceneDocument({ seedCharacter: true });
const characterId = fixture.scenes[0].stage.characters[0].id;
const rowId = characterRowId(characterId);

const out = process.env.QA_OUT || "/tmp/ia-tail-qa";
mkdirSync(out, { recursive: true });

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 120_000 });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
// Observe DOM commits and the app's published QA state, never a polling delay.
const waitFor = (expression, timeoutMs = 20_000) => evaluate(`new Promise((resolve, reject) => {
	let timer;
	const cleanup = () => { observer.disconnect(); clearTimeout(timer); window.removeEventListener("qa:state", check); };
	const check = () => { if (${expression}) { cleanup(); resolve(true); } };
	const observer = new MutationObserver(check);
	observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	window.addEventListener("qa:state", check);
	timer = setTimeout(() => { cleanup(); reject(new Error("QA prerequisite missing: " + ${JSON.stringify(expression)})); }, ${timeoutMs});
	check();
})`);

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Screenshots the element an EXPRESSION returns, so a card found by its
// heading can be framed as precisely as one found by class.
const shotOf = async (name, elementExpression) => {
	const clip = await evaluate(`(() => {
		const node = ${elementExpression};
		if (!node) return null;
		node.scrollIntoView({ block: "nearest" });
		const box = node.getBoundingClientRect();
		return { x: Math.max(0, Math.round(box.x - 8)), y: Math.max(0, Math.round(box.y - 8)), width: Math.round(box.width + 16), height: Math.round(box.height + 16) };
	})()`);
	if (!clip) return 0;
	const image = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
	writeFileSync(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
	return Buffer.from(image.data, "base64").byteLength;
};

const rowDepth = (id) => evaluate(`(() => {
	const row = document.querySelector("[data-node-id='${id}']");
	return row ? Number(getComputedStyle(row).getPropertyValue("--hierarchy-depth")) : null;
})()`);
const rowLabels = () => evaluate(`[...document.querySelectorAll(".hierarchy-tree .hierarchy-row")].map((node) => (node.getAttribute("aria-label") ?? node.textContent).trim())`);
// G1 mode keys: 1 Stage, 2 Pose, 3 Camera, 4 Motion.
const MODE_KEYS = { Scene: "1", Stage: "1", Pose: "2", Camera: "3", Motion: "4" };
const clickMode = async (label) => {
	const key = MODE_KEYS[label];
	await evaluate(`document.querySelector('[data-mode-key="${key}"]')?.click()`);
	return waitFor(`document.querySelector('[data-mode-key="${key}"]')?.getAttribute("aria-selected") === "true"`);
};
// The Prompt Blocks card, found by its heading rather than by index: the
// inspector column reorders as foldouts show and hide.
const PROMPT_CARD = `[...document.querySelectorAll(".card.foldout")].find((card) => !card.hidden && card.querySelector(".foldout-title")?.textContent.trim() === "Prompt Blocks")`;

/* --- a QA project with one character ----------------------------------------- */

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(serializeSceneDocument(fixture))});
})()`);
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
	let state;
	Object.defineProperty(window, "__cozyclay", {
		configurable: true, get: () => state,
		set: value => { state = value; window.dispatchEvent(new Event("qa:state")); },
	});
})()` });
await send("Page.reload");
expect("the studio comes up with the fixture rig", await waitFor(`!!window.__cozyclay?.rigs?.[${JSON.stringify(characterId)}]`, 60_000));
expect("the tree is rendered", await waitFor(`!!document.querySelector("[data-node-id='shot']")`));

/* --- (a) the scene root does not fold ---------------------------------------- */

expect(
	"the root row carries no fold caret",
	await evaluate(`!document.querySelector("[data-node-id='shot'] .hierarchy-toggle")`),
);
expect(
	"the root keeps the caret column, so its icon still lines up",
	await evaluate(`!!document.querySelector("[data-node-id='shot'] .hierarchy-fold-space")`),
);

/* --- (b) the cast sits directly under the root ------------------------------- */

const labels = await rowLabels();
expect("no Characters group row is rendered", !labels.includes("Characters"), JSON.stringify(labels));
expect("the group node itself has no row", await evaluate(`!document.querySelector("[data-node-id='characters']")`));
expect("Character 1 is still a row", await evaluate(`!!document.querySelector("[data-node-id='${rowId}']")`));
const cameraDepth = await rowDepth("camera");
const characterDepth = await rowDepth(rowId);
expect("Character 1 sits at the same indent as Camera", characterDepth === cameraDepth && cameraDepth === 1, `camera=${cameraDepth} ${rowId}=${characterDepth}`);
expect(
	"the character keeps its own caret and rig subtree",
	await evaluate(`!!document.querySelector("[data-node-id='${rowId}'] .hierarchy-toggle") && !!document.querySelector("[data-node-id='${rowId}.rig']")`),
);
await evaluate(`document.querySelector("[data-node-id='${rowId}'] .hierarchy-row").click()`);
expect(
	"clicking Character 1 still selects it",
	await waitFor(`document.querySelector("[data-node-id='${rowId}']")?.classList.contains("selected")`),
);
expect("the hierarchy screenshot has bytes", (await shotOf("hierarchy-scene-mode", `document.querySelector(".hierarchy-tree")`)) > 2000);

/* --- (c) Motion mode has no generation surface ------------------------------ */

expect("Motion mode opens", await clickMode("Motion"));
// #201: entering Motion selects the active character's ROW, so the character
// panels are the ones on screen.
expect("Motion lands on the fixture character row, not the vanished group", await waitFor(`document.querySelector("[data-node-id='${rowId}']")?.classList.contains("selected")`));
expect("there is no Prompt Blocks panel", await evaluate(`!(${PROMPT_CARD})`));
expect("the top bar has no Generate Motion", await evaluate(`!document.querySelector("[data-testid=topbar-generate], [data-testid=topbar-generate-menu]")`));
expect("the Motion-mode details screenshot has bytes", (await shotOf("motion-details", `document.querySelector(".hierarchy-sidebar") ?? document.body`)) > 2000);

writeFileSync(`${out}/summary.json`, JSON.stringify({ labels, cameraDepth, characterDepth }, null, 2));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log(`PASS IA tail — no root caret, no Characters group row, no generation surface in Motion; evidence in ${out}`);
