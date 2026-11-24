#!/usr/bin/env node
/**
 * Object colour, end to end in a real browser (issue #88).
 *
 * The palette, the hex parser and the recent-colour memory are pure and proved
 * in verify-scene-objects.mjs. What only exists in a running page is the part
 * the issue is actually about: that a colour typed into the inspector reaches
 * the prop in the 3D scene, that the popover survives being typed into (a
 * preset click deliberately closes it — an edit in progress must not), that a
 * typo repaints nothing, and that a hand-mixed tint is still on the palette
 * after a reload.
 *
 * Run: `npm run dev:ui` in one shell, then
 * `QA_URL=http://127.0.0.1:5180/app/ npm run qa:browser -- node test/verify-object-colour-browser.mjs`.
 * QA_SCREENSHOT / QA_SUMMARY write the review artifacts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

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
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
/** evaluate that treats a mid-navigation context loss as "not ready", not a crash */
const evaluateSafely = async (expression) => {
	try {
		return await evaluate(expression);
	} catch {
		return undefined;
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** poll the page until expression is truthy or the timeout expires */
const waitFor = async (expression, { timeoutMs = 10000, intervalMs = 100 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluateSafely(expression)) return true;
		await sleep(intervalMs);
	}
	return false;
};

let failures = 0;
const results = [];
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	results.push({ name, pass: !!condition, detail: condition ? "" : String(detail) });
	if (!condition) failures += 1;
};

/** Type into a React-controlled input the way a keyboard would: the native
 * value setter, then the input event React actually listens to. */
const typeInto = (selector, text) =>
	evaluate(`(() => {
		const input = document.querySelector(${JSON.stringify(selector)});
		if (!input) return false;
		input.focus();
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`);

/** The colour the prop is actually rendered with, read off the live three.js
 * material — not the record, not the swatch: the pixel-facing truth. */
const renderedColour = () =>
	evaluate(`(() => {
		let node = window.__cozyclay?.shotCam;
		while (node && !node.isScene) node = node.parent;
		if (!node) return null;
		let hex = null;
		node.traverse((object) => {
			if (hex || !object.userData?.sceneObjectId) return;
			object.traverse((child) => {
				if (hex || !child.isMesh || !child.material?.color) return;
				hex = '#' + child.material.color.getHexString();
			});
		});
		return hex;
	})()`);

/** The colour the scene document was saved with (debounced ~400ms). */
const storedColour = () =>
	evaluate(`(() => {
		const body = JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}') || 'null');
		const scene = body?.scenes?.find((entry) => entry.id === body.activeSceneId) ?? body?.scenes?.[0];
		return scene?.objects?.[0]?.color ?? null;
	})()`);

const detailsOpen = () => evaluate("!!document.querySelector('.object-colors-pop')?.open");
const recentStored = () =>
	evaluate("JSON.parse(localStorage.getItem('cozyclay.objectColors.recent') || '[]')");

const reloadPage = async () => {
	await send("Page.reload");
	await waitFor("!!document.querySelector('canvas')", { timeoutMs: 30000 });
	await waitFor("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0", { timeoutMs: 30000 });
	await sleep(1200);
};

await send("Runtime.enable");

try {
	// Start from empty storage: a scene or a recent list left by an earlier run
	// would boot on the first reload and poison every assertion below.
	await waitFor("location.href.startsWith('http')", { timeoutMs: 30000 });
	await evaluate(`(() => {
		localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
		localStorage.setItem('cozyclay.locale', 'en');
	})()`);
	await reloadPage();
	expect("the studio renders a canvas", await evaluate("!!document.querySelector('canvas')"));

	/* --------------------------------------------------- a cube to paint ---- */

	await evaluate(`(() => {
		const row = document.querySelector('.v2-outliner [data-node-id="light"]');
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(box.left + 28), clientY: Math.round(box.top + 12), button: 2 }));
		return true;
	})()`);
	expect("right-click Create opens from the Outliner", await waitFor("document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item').length > 0"));
	await evaluate("[...document.querySelectorAll('.v2-outliner .hierarchy-context-menu .add-object-item')].find(b => b.textContent.startsWith('Cube')).click()");
	expect("the cube opens in the inspector", await waitFor("!!document.querySelector('.object-colors-pop')"));

	/* ------------------------------------------------------ the palette ---- */

	await evaluate("document.querySelector('.object-colors-pop > summary').click()");
	expect("the colour popover opens", await waitFor("!!document.querySelector('.object-colors-pop')?.open"));
	const swatches = await evaluate(
		"[...document.querySelectorAll('.object-colors .object-color:not(.object-color-free)')].map(b => b.style.background)",
	);
	expect(
		"the palette offers red, blue, yellow and green",
		["rgb(217, 74, 74)", "rgb(74, 123, 217)", "rgb(226, 192, 74)", "rgb(79, 168, 106)"].every((rgb) => swatches.includes(rgb)),
		JSON.stringify(swatches),
	);
	expect("the popover carries a native colour picker", await evaluate("!!document.querySelector('.object-colors input[type=color]')"));
	const hexFieldValue = () => evaluate("document.querySelector('.object-color-hex')?.value ?? null");
	expect("the hex field shows the object's current colour", (await hexFieldValue()) === "#c2c6c8", await hexFieldValue());

	/* ------------------------------------------------ an arbitrary colour --- */

	await typeInto(".object-color-hex", "#ff3366");
	expect(
		"a typed hex repaints the prop in the 3D scene",
		await waitFor(`(() => {
			let node = window.__cozyclay?.shotCam;
			while (node && !node.isScene) node = node.parent;
			if (!node) return false;
			let hit = false;
			node.traverse((object) => {
				if (hit || !object.userData?.sceneObjectId) return;
				object.traverse((child) => { if (child.isMesh && child.material?.color?.getHexString() === 'ff3366') hit = true; });
			});
			return hit;
		})()`),
		await renderedColour(),
	);
	expect("the popover stays open while the hex field is used", await detailsOpen());
	expect("the typed colour reaches the saved scene", await waitFor(`JSON.parse(localStorage.getItem('${SCENES_STORAGE_KEY}') || 'null')?.scenes?.[0]?.objects?.[0]?.color === '#ff3366'`), await storedColour());
	expect("the hex field reads back the value an agent could also have set", (await hexFieldValue()) === "#ff3366", await hexFieldValue());

	/* --------------------------------------------------------- typos --------- */

	await typeInto(".object-color-hex", "zzz");
	await sleep(300);
	expect("a malformed hex repaints nothing", (await renderedColour()) === "#ff3366", await renderedColour());
	expect("a malformed hex leaves the saved scene alone", (await storedColour()) === "#ff3366", await storedColour());
	expect("the popover survives a typo too", await detailsOpen());
	expect("no uncaught page error from the typo", pageErrors.length === 0, pageErrors.join(" | "));
	// Blur puts the field back to what the prop actually is, so a typo never
	// lingers as a value the author might believe.
	await evaluate("document.querySelector('.object-color-hex')?.blur()");
	await sleep(200);
	expect("leaving the field restores the object's real colour", (await hexFieldValue()) === "#ff3366", await hexFieldValue());

	const screenshotPath = process.env.QA_SCREENSHOT;
	if (screenshotPath) {
		mkdirSync(dirname(screenshotPath), { recursive: true });
		const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));
	}

	/* --------------------------------------------------- recent colours ---- */

	expect("the mixed colour is remembered", (await recentStored()).includes("#ff3366"), JSON.stringify(await recentStored()));
	await reloadPage();
	expect("the recent list survives a reload", (await recentStored()).includes("#ff3366"), JSON.stringify(await recentStored()));
	// A reload lands on no selection and a folded Props group: unfold it and
	// pick the cube, which is what an author does coming back to a scene.
	await evaluate(`(() => {
		const props = [...document.querySelectorAll('.hierarchy-row-wrap')].find((row) => row.textContent.includes('Props'));
		if (props?.getAttribute('aria-expanded') === 'false') props.querySelector('.hierarchy-toggle')?.click();
	})()`);
	await waitFor("[...document.querySelectorAll('.hierarchy-label')].some(n => n.textContent === 'Cube')");
	await evaluate("[...document.querySelectorAll('.hierarchy-label')].find(n => n.textContent === 'Cube')?.closest('.hierarchy-row')?.click()");
	expect("the cube can be selected again after the reload", await waitFor("!!document.querySelector('.object-colors-pop')"));
	await evaluate("document.querySelector('.object-colors-pop > summary')?.click()");
	expect("the popover reopens after the reload", await waitFor("!!document.querySelector('.object-colors-pop')?.open"));
	expect(
		"the remembered tint is offered as a swatch after the presets",
		await waitFor("[...document.querySelectorAll('.object-colors .object-color')].some(b => b.style.background === 'rgb(255, 51, 102)')"),
		await evaluate("[...document.querySelectorAll('.object-colors .object-color')].map(b => b.style.background).join(',')"),
	);
	expect("the recent swatches are separated from the palette", await evaluate("!!document.querySelector('.object-colors .object-colors-split')"));

	expect("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

	const summaryPath = process.env.QA_SUMMARY;
	if (summaryPath) {
		mkdirSync(dirname(summaryPath), { recursive: true });
		writeFileSync(
			summaryPath,
			`${JSON.stringify(
				{
					issue: 88,
					url: process.env.QA_URL ?? null,
					when: new Date().toISOString(),
					objectColor: await renderedColour(),
					storedColor: await storedColour(),
					recent: await recentStored(),
					palette: swatches,
					screenshot: screenshotPath ?? null,
					failures,
					checks: results,
				},
				null,
				"\t",
			)}\n`,
		);
	}
} finally {
	ws.close();
}

if (failures) process.exit(1);
console.log("all object colour browser checks PASS");
