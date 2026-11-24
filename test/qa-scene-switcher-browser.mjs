#!/usr/bin/env node
// Browser QA for the scene switcher on the tree root row (#192). Drives the
// real studio over CDP through the whole scene-document life cycle from the
// row itself: create two more scenes from the pill, switch between the three,
// rename the active one with F2, duplicate it from the root-row context menu,
// delete back down to one, and prove Delete is not offered when one scene is
// all that is left. Screenshots the pill list and the root menu, because "the
// state is right" and "the operator can see the control" are two claims.
//
//   QA_URL=http://127.0.0.1:5180/app/ CDP_PORT=9254 node tools/qa-browser.mjs \
//     -- node test/qa-scene-switcher-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/tmp/scene-switcher-qa";
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
// Every wait is on the state the step produces, never on a fixed delay: React
// commits when it commits, and a sleep would only decide how flaky this is.
const waitFor = async (expression, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await evaluate(expression).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/* --- helpers that speak in the panel's own controls -------------------------- */

const PILL = ".hierarchy-scene-pill .trigger";
const ROOT_ROW = "[data-node-id='shot']";

const pillLabel = () => evaluate(`document.querySelector("${PILL}")?.querySelector("span")?.textContent.trim() ?? null`);
// The root row hands its name to the pill, so the row button carries the name
// as its accessible label instead of a second copy of the text.
const rootLabel = () => evaluate(`document.querySelector("${ROOT_ROW} .hierarchy-row")?.getAttribute("aria-label") ?? null`);
const rootRowNameCount = (name) => evaluate(`(document.querySelector("${ROOT_ROW}").innerText.match(/${name}/g) ?? []).length`);
// The list ends with "+ New scene", which is an action rather than a document:
// the scene names are everything before it.
const sceneNames = () => evaluate(`[...document.querySelectorAll(".dropdown-menu [role=option]")].map((node) => node.textContent.trim()).filter((label) => !label.includes("New scene"))`);
const menuItems = () => evaluate(`[...document.querySelectorAll(".hierarchy-context-menu [role=menuitem]")].map((node) => node.textContent.trim())`);

const openPill = async () => {
	await evaluate(`document.querySelector("${PILL}").click()`);
	return waitFor(`!!document.querySelector(".dropdown-menu [role=option]")`);
};
const closePopovers = async () => {
	await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
	return waitFor(`!document.querySelector(".dropdown-menu") && !document.querySelector(".hierarchy-context-menu")`);
};
const pickPillItem = async (pattern) => {
	await evaluate(`[...document.querySelectorAll(".dropdown-menu [role=option]")].find((node) => /${pattern}/.test(node.textContent))?.click()`);
	return waitFor(`!document.querySelector(".dropdown-menu")`);
};
const openRootMenu = async () => {
	await evaluate(`(() => {
		const row = document.querySelector("${ROOT_ROW}");
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: Math.round(box.x + 40), clientY: Math.round(box.y + 12) }));
	})()`);
	return waitFor(`!!document.querySelector(".hierarchy-context-menu")`);
};
const clickMenuItem = async (pattern) => evaluate(`[...document.querySelectorAll(".hierarchy-context-menu [role=menuitem]")].find((node) => /${pattern}/.test(node.textContent))?.click()`);
const shot = async (name) => {
	const clip = await evaluate(`(() => { const node = document.querySelector(".hierarchy-left"); const box = node.getBoundingClientRect(); return { x: 0, y: 0, width: Math.round(box.right + 220), height: 640 }; })()`);
	const image = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
	writeFileSync(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
	return Buffer.from(image.data, "base64").byteLength;
};

/* --- a one-scene project to start from -------------------------------------- */

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
})()`);
await send("Page.reload");
expect("the studio comes up", await waitFor("!!window.__cozyclay?.rigA", 60_000));
expect("the hierarchy column carries no second Projects… button", await evaluate(`![...document.querySelectorAll(".hierarchy-left button")].some((button) => /Projects/.test(button.textContent))`));
expect("the tree root row carries the scene pill", await waitFor(`!!document.querySelector("${PILL}")`));
expect("the pill says which scene is open", await pillLabel() === "SCENE 01", String(await pillLabel()));
expect("the pill announces itself as the scene selector", await evaluate(`document.querySelector("${PILL}").getAttribute("aria-label")`) === "Select scene");
// The pill's caret is the row's ONLY caret: the root lost its fold toggle,
// because folding the root hid the whole scene (docs/studio-ui-ia.md R6).
expect("the pill carries the row's only caret", await evaluate(`!!document.querySelector(".hierarchy-scene-pill .dd-caret") && !document.querySelector("${ROOT_ROW} .hierarchy-toggle")`));
expect("the root row prints the scene name once, in the pill", await rootRowNameCount("SCENE 01") === 1 && await evaluate(`!document.querySelector("${ROOT_ROW} .hierarchy-label")`), String(await rootRowNameCount("SCENE 01")));
expect("the row still names itself for assistive tech", await rootLabel() === "SCENE 01", String(await rootLabel()));

/* --- create two more scenes from the pill ------------------------------------ */

for (const expected of ["SCENE 02", "SCENE 03"]) {
	expect(`the pill opens before creating ${expected}`, await openPill());
	await pickPillItem("New scene");
	expect(`+ New scene opens ${expected}`, await waitFor(`document.querySelector("${PILL}").textContent.includes("${expected}")`), String(await pillLabel()));
}
expect("the root row name follows the active scene", await rootLabel() === "SCENE 03", String(await rootLabel()));
expect("the new scene name is still printed once", await rootRowNameCount("SCENE 03") === 1);

expect("the pill lists every scene", await openPill());
const listed = await sceneNames();
expect("all three scenes are listed", listed.length === 3, JSON.stringify(listed));
expect("the active scene is marked in the list", await evaluate(`[...document.querySelectorAll('.dropdown-menu [role=option]')].filter((node) => node.getAttribute("aria-selected") === "true").map((node) => node.textContent.trim()).join()`) === "SCENE 03");
expect("the list offers a create item after the scenes", await evaluate(`/New scene/.test([...document.querySelectorAll(".dropdown-menu [role=option]")].at(-1).textContent)`));
expect("the pill list is portaled clear of the panel that clips it", await evaluate(`document.querySelector(".dropdown-menu")?.parentElement === document.body`));
// Nothing can fold the root any more, so the proof is the scene's own rows:
// they are still on screen behind the open pill.
expect("opening the pill does not fold the tree", await evaluate(`!!document.querySelector("[data-node-id='camera']") && !!document.querySelector("[data-node-id='characterA']")`));
expect("the pill screenshot has bytes", (await shot("pill-open-three-scenes")) > 2000);

/* --- switch between the three ------------------------------------------------ */

await pickPillItem("SCENE 01");
expect("picking a scene from the pill switches document", await waitFor(`document.querySelector("${PILL}").textContent.includes("SCENE 01")`), String(await pillLabel()));
expect("the tree root follows the switch", await rootLabel() === "SCENE 01", String(await rootLabel()));
await openPill();
await pickPillItem("SCENE 02");
expect("switching again lands on the third scene", await waitFor(`document.querySelector("${PILL}").textContent.includes("SCENE 02")`), String(await pillLabel()));

/* --- rename the active scene with F2 ----------------------------------------- */

await evaluate(`document.querySelector("${ROOT_ROW} .hierarchy-row").click()`);
await evaluate(`document.querySelector("${ROOT_ROW}").dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }))`);
expect("F2 on the root row opens an inline rename", await waitFor(`!!document.querySelector("${ROOT_ROW} .hierarchy-rename-input")`));
await evaluate(`(() => {
	const input = document.querySelector("${ROOT_ROW} .hierarchy-rename-input");
	input.value = "REHEARSAL";
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
})()`);
expect("the rename reaches the scene document", await waitFor(`document.querySelector("${PILL}").textContent.includes("REHEARSAL")`), String(await pillLabel()));
expect("the renamed scene is what the tree root shows", await rootLabel() === "REHEARSAL", String(await rootLabel()));
await openPill();
expect("the renamed scene keeps its place in the list", (await sceneNames()).includes("REHEARSAL"), JSON.stringify(await sceneNames()));
await closePopovers();

// The pill carries the name, so it answers the double-click that used to land
// on the row label; the input takes the pill's place while editing.
await evaluate(`(() => {
	const pill = document.querySelector("${PILL}");
	for (const type of ["click", "click", "dblclick"]) pill.dispatchEvent(new MouseEvent(type, { bubbles: true, detail: type === "dblclick" ? 2 : 1 }));
})()`);
expect("double-clicking the pill opens the inline rename in its place", await waitFor(`!!document.querySelector("${ROOT_ROW} .hierarchy-rename-input") && !document.querySelector("${PILL}")`));
await evaluate(`document.querySelector("${ROOT_ROW} .hierarchy-rename-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
expect("Escape puts the pill back, name unchanged", await waitFor(`!!document.querySelector("${PILL}")`) && (await rootLabel()) === "REHEARSAL", String(await rootLabel()));

/* --- the root-row context menu ------------------------------------------------ */

expect("right-clicking the root row opens the scene menu", await openRootMenu());
const sceneMenu = await menuItems();
expect("the root menu offers the scene verbs", sceneMenu.join("|") === "Rename|Duplicate|Delete|+ New scene", JSON.stringify(sceneMenu));
expect("the root menu is not the Add-Object catalogue", await evaluate(`!document.querySelector(".hierarchy-context-menu .catalogue-entry, .hierarchy-context-menu .object-catalogue")`));
expect("the root menu screenshot has bytes", (await shot("root-context-menu")) > 2000);

await clickMenuItem("Duplicate");
expect("Duplicate opens the copy", await waitFor(`document.querySelector("${PILL}").textContent.includes("REHEARSAL 2")`), String(await pillLabel()));
await openPill();
expect("the duplicate joins the list", (await sceneNames()).length === 4, JSON.stringify(await sceneNames()));
await closePopovers();

/* --- delete back down to one -------------------------------------------------- */

for (let remaining = 4; remaining > 1; remaining -= 1) {
	expect(`the root menu opens with ${remaining} scenes`, await openRootMenu());
	await clickMenuItem("^Delete$");
	expect("Delete arms before it commits", await waitFor(`[...document.querySelectorAll(".hierarchy-context-menu [role=menuitem]")].some((node) => node.textContent.trim() === "Confirm delete")`));
	await clickMenuItem("Confirm delete");
	await waitFor(`!document.querySelector(".hierarchy-context-menu")`);
	await openPill();
	expect(`deleting leaves ${remaining - 1} scenes`, (await sceneNames()).length === remaining - 1, JSON.stringify(await sceneNames()));
	await closePopovers();
}

expect("the last scene still opens its menu", await openRootMenu());
const lastMenu = await menuItems();
expect("Delete is not offered when one scene is all there is", !lastMenu.includes("Delete"), JSON.stringify(lastMenu));
expect("the other scene verbs stay available", lastMenu.join("|") === "Rename|Duplicate|+ New scene", JSON.stringify(lastMenu));
await closePopovers();
await openPill();
const finalScenes = await sceneNames();
expect("one scene is left, and the pill names it", finalScenes.length === 1 && (await pillLabel()) === finalScenes[0], JSON.stringify(finalScenes));
await closePopovers();

writeFileSync(`${out}/summary.json`, JSON.stringify({ finalScenes, lastMenu, sceneMenu }, null, 2));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log(`PASS scene switcher — created, switched, renamed, duplicated and deleted from the tree root row; evidence in ${out}`);
