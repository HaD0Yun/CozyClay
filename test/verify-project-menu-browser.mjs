#!/usr/bin/env node
// Browser contract for the topbar project menu's dismissal affordances. The
// menu is plain state in App.jsx, so only a real page can prove the document
// -level listeners: Escape closes it, a pointerdown outside .project-menu-wrap
// closes it, and presses inside the wrap keep working (the trigger still
// toggles, menu items still fire). Mirrors the inspector-actions dismissal
// contract.
//
// Run: `npm run dev:ui` in one shell, then `npm run test:project-menu`, which
// launches the headless QA browser against QA_URL (default 127.0.0.1:5180).

import { mkdir, writeFile } from "node:fs/promises";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-project-menu-qa";
await mkdir(`${out}/shots`, { recursive: true });
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
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
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
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
	const path = `${out}/shots/${name}.png`;
	await writeFile(path, Buffer.from(result.data, "base64"));
	return path;
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const rectCentre = async (selector) => {
	const centre = await evaluate(
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;` +
			` const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
	);
	// Fail by name: destructuring null a few frames later blames the wrong line.
	if (!centre) throw new Error(`no element matches ${selector} — is the QA browser on the studio page (/app/)?`);
	return centre;
};
const mouse = (type, x, y) =>
	send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
const clickAt = async ({ x, y }) => {
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
};
const pressEscape = async () => {
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};

// Subscribe to the exact DOM change BEFORE acting, then await it (bounded).
// The observer resolves "closed"/"open" on the mutation, "timeout" otherwise.
const armMenuGone = () =>
	evaluate(`window.__menuGone = new Promise((resolve) => {
		if (!document.querySelector('.project-menu')) { resolve('already-closed'); return; }
		const obs = new MutationObserver(() => {
			if (!document.querySelector('.project-menu')) { obs.disconnect(); clearTimeout(t); resolve('closed'); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 4000);
	}), true`);
const armMenuShown = () =>
	evaluate(`window.__menuShown = new Promise((resolve) => {
		if (document.querySelector('.project-menu')) { resolve('already-open'); return; }
		const obs = new MutationObserver(() => {
			if (document.querySelector('.project-menu')) { obs.disconnect(); clearTimeout(t); resolve('open'); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 4000);
	}), true`);
const menuGone = () => evaluate("window.__menuGone");
const menuShown = () => evaluate("window.__menuShown");
const menuOpen = () => evaluate("!!document.querySelector('.project-menu')");
const openMenu = async () => {
	await armMenuShown();
	await clickAt(await rectCentre(".project-menu-trigger"));
	return menuShown();
};

// Boot: wait for the studio topbar; the app document may still be loading.
expect("the topbar renders the project menu trigger", await waitFor("!!document.querySelector('.project-menu-trigger')", 30000));
// #523 (G7): Save and Export moved into the top bar's File menu.
await clickAt(await rectCentre("[data-testid=menu-file]"));
expect("File › Save is the direct Save action", await waitFor("!!document.querySelector('.menubar-menu [data-testid=topbar-save]')"));
// #193: the Export action is the Export ▸ menu trigger. It keeps the
// data-testid and carries the menu handle as an id, and — R3 — it is never
// disabled: a project without shots simply gets a shorter menu.
expect("File renders the Export menu trigger", await waitFor("!!document.querySelector('[data-testid=topbar-export]#export-menu-trigger')"));
expect(
	"the Export trigger is enabled in a fresh project",
	(await evaluate("document.querySelector('[data-testid=topbar-export]').disabled")) === false,
);
await clickAt(await rectCentre("[data-testid=menu-file]"));
expect("clicking File again closes it", await waitFor("!document.querySelector('.menubar-menu')"));
expect(
	"the status bar exposes an understandable save status",
	Boolean(await evaluate("document.querySelector('[data-testid=project-save-status]')?.textContent.trim()")),
);
expect("the menu starts closed", !(await menuOpen()));

/* ------------------------------------------------ Escape closes ------ */
expect("clicking the trigger opens the menu", (await openMenu()) === "open");
await armMenuGone();
await pressEscape();
expect("Escape closes the menu", (await menuGone()) === "closed");

/* -------------------------------------- outside pointerdown closes --- */
expect("the menu reopens after Escape", (await openMenu()) === "open");
await armMenuGone();
const outside = await rectCentre("[data-testid=project-save-status]");
await mouse("mousePressed", outside.x, outside.y);
expect("a pointerdown outside .project-menu-wrap closes the menu", (await menuGone()) === "closed");
await mouse("mouseReleased", outside.x, outside.y);

/* ------------------------- presses inside the wrap keep working ------ */
expect("the menu reopens after the outside press", (await openMenu()) === "open");
const trigger = await rectCentre(".project-menu-trigger");
await mouse("mousePressed", trigger.x, trigger.y);
expect("a pointerdown inside the wrap does NOT close the menu", await menuOpen());
await armMenuGone();
await mouse("mouseReleased", trigger.x, trigger.y);
expect("completing the trigger click still toggles the menu closed", (await menuGone()) === "closed");
expect(
	"the trigger reports the collapsed state",
	(await evaluate("document.querySelector('.project-menu-trigger').getAttribute('aria-expanded')")) === "false",
);

/* -------------------------------------- menu items still function ---- */
expect("the menu reopens after the toggle", (await openMenu()) === "open");
await clickAt(await rectCentre('.project-menu [role="menuitem"]:nth-of-type(2)'));
expect("the Open Project… item still opens the project browser", await waitFor("!!document.querySelector('.project-browser')"));
expect("selecting an item closes the menu", !(await menuOpen()));
await clickAt(await rectCentre(".project-browser .x"));
expect("the project browser closes again", await waitFor("!document.querySelector('.project-browser')"));

/* ---- Create with the sample card selected opens the sample scene ---- */
const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
})()`);
expect("the menu reopens for the sample check", (await openMenu()) === "open");
await clickAt(await rectCentre('.project-menu [role="menuitem"]:nth-of-type(2)'));
expect("the start screen opens for the sample check", await waitFor("!!document.querySelector('.project-browser')"));
await evaluate("[...document.querySelectorAll('.v2-start-nav-item')].find((node) => /New Project|새 프로젝트/.test(node.textContent))?.click()");
expect("no bundled sample card is offered, the + card is", await waitFor("!document.querySelector('[data-template-id^=sample-]') && !!document.querySelector('[data-testid=start-new-project-card]')"));
await evaluate("document.querySelector('[data-testid=start-new-project-card]').click()");
await setInput('[data-testid="start-project-name"]', "sample_create_check");
expect("the typed name enables Create", await waitFor("document.querySelector('[data-testid=start-create]')?.disabled === false"));
// A dirty project asks before the new one replaces it; answer yes either way.
await evaluate("window.confirm = () => true");
await evaluate("document.querySelector('[data-testid=start-create]').click()");
expect(
	"Create with the + card opens the editor under the typed name",
	await waitFor("!document.querySelector('.project-browser') && (document.querySelector('.project-menu-trigger')?.textContent || '').includes('sample_create_check')"),
);

/* ------------------------ storyboard animation export ------------------ */
await evaluate(`(() => {
	const original = URL.createObjectURL.bind(URL);
	const blobs = new Map();
	URL.createObjectURL = blob => { const href = original(blob); blobs.set(href, blob); return href; };
	window.__animationDownload = null;
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (this.download) window.__animationDownload = { name: this.download, blob: blobs.get(this.href) };
		else click.call(this);
	};
	return true;
})()`);
await evaluate(`(async () => {
	const project = JSON.parse(await window.__cozyclayProject.export("Storyboard QA"));
	project.name = "Storyboard QA";
	project.previsMode = "storyboard";
	const scene = project.scenes.scenes[0];
	scene.objects = [];
	project.resources = { assets: [], motions: [] };
	scene.shotDocument = {
		version: 5,
		frameCount: 144,
		waypoints: [],
		shots: [0, 1, 2].map(index => ({
			id: "still-" + index,
			name: "Panel " + (index + 1),
			startFrame: index * 48,
			endFrame: index * 48 + 47,
			cameraKeys: [],
			camera: null,
			kind: "still",
			caption: "Panel " + (index + 1),
			cast: { hero: { x: index, z: index + 1, rot: index * 10 } },
			stylizedAssetId: null,
		})),
	};
	await window.__cozyclayProject.open(JSON.stringify(project));
	return true;
})()`);
expect(
	"the storyboard fixture opens with three still shots",
	await waitFor(`(async () => {
		const project = JSON.parse(await window.__cozyclayProject.export());
		const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId) || project.scenes.scenes[0];
		return project.previsMode === "storyboard" && scene.shotDocument.shots.length === 3 && scene.shotDocument.shots.every(shot => shot.kind === "still");
	})()`),
);
await clickAt(await rectCentre("[data-testid=menu-file]"));
expect("storyboard File menu shows Export as Animation project", await waitFor("!!document.querySelector('[data-testid=export-animation-project]')"));
const happyShot = await screenshot("task-17-previs-modes");
console.log(`QA_SCREENSHOT ${happyShot}`);
await evaluate("window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined; true");
await evaluate("document.querySelector('[data-testid=export-animation-project]')?.click()");
await evaluate("(async () => { await window.__cozyclay.runStudioAction('project.exportAsAnimation'); return true; })()");
expect("animation project export downloads the suffixed project", await waitFor("!!window.__animationDownload"));
const exported = await evaluate(`(async () => {
	const download = window.__animationDownload;
	return { name: download?.name, project: download?.blob ? JSON.parse(await download.blob.text()) : null };
})()`);
expect("download filename is <name> - Animation.cclayproject", exported?.name === "Storyboard QA - Animation.cclayproject");
expect("download contains three clip shots and keeps the storyboard open", exported?.project?.previsMode === "animation" && exported.project.scenes.scenes[0].shotDocument.shots.length === 3 && exported.project.scenes.scenes[0].shotDocument.shots.every(shot => shot.kind === "clip"));
expect("the source tab remains a clean storyboard", await evaluate(`(async () => {
	const project = JSON.parse(await window.__cozyclayProject.export());
	return project.previsMode === "storyboard" && !document.querySelector('[data-testid=project-save-status]')?.textContent.includes("Unsaved");
})()`));

await evaluate(`(async () => {
	const project = JSON.parse(await window.__cozyclayProject.export("Animation QA"));
	project.name = "Animation QA";
	project.previsMode = "animation";
	await window.__cozyclayProject.open(JSON.stringify(project));
	return true;
})()`);
await clickAt(await rectCentre("[data-testid=menu-file]"));
expect("animation File menu hides Export as Animation project", !(await evaluate("!!document.querySelector('[data-testid=export-animation-project]')")));
const failureShot = await screenshot("task-17-animation-menu-absent");
console.log(`QA_SCREENSHOT ${failureShot}`);

ws.close();
if (failures > 0) {
	console.error(`\n${failures} project-menu browser check(s) failed`);
	process.exit(1);
}
console.log("\nAll project-menu browser checks passed");
