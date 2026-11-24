#!/usr/bin/env node
// Browser QA for the reference slots (#167). Drives the real studio over CDP:
// sets an identity image on a cast member and an environment reference on the
// stage, then takes the SAME capture the live capture_framing_png command
// returns and proves both pictures rode along with it. The inspector is
// screenshotted with the identity thumbnail on screen, because "the data is
// there" and "the operator can see it" are two different claims.
import { mkdirSync, writeFileSync } from "node:fs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const out = process.env.QA_OUT || "/tmp/reference-slots-qa";
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
const waitFor = async (expression, timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await evaluate(expression).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Two visibly different 1x1 PNGs, so a mixed-up slot cannot pass by accident.
const IDENTITY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ENVIRONMENT_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");

// A one-shot scene with a named cast member: the reference entry has to carry
// the subject description as its name, which is what the prompt then says.
await evaluate(`(() => {
	const document = {
		version: 4,
		activeSceneId: "scene-ref-qa",
		scenes: [{
			id: "scene-ref-qa",
			name: "REF QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 24, shots: [{ id: "ref-qa-shot", name: "Ref QA", startFrame: 0, endFrame: 23, cameraKeys: [], camera: { mode: "keys" } }], waypoints: [] },
			stage: {
				characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "Alpha in a tan coat" }],
				hasCharSheet: false,
				shotAspect: "16:9",
			},
		}],
	};
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(document));
})()`);
await send("Page.reload");
expect(
	"the studio comes up with the reference-slot hooks",
	await waitFor("!!window.__cozyclay?.rigA && typeof window.__cozyclay?.setCharacterIdentityImage === 'function' && typeof window.__cozyclay?.setEnvironmentImage === 'function' && typeof window.__cozyclay?.captureWithReferences === 'function'", 60_000),
);

/* --- set both slots -------------------------------------------------------- */

await evaluate(`window.__cozyclay.setCharacterIdentityImage(0, ${JSON.stringify(IDENTITY_PNG)})`);
await evaluate(`window.__cozyclay.setEnvironmentImage(${JSON.stringify(ENVIRONMENT_PNG)})`);
expect("a non-image value is refused by the slot", await evaluate(`(() => {
	window.__cozyclay.setEnvironmentImage("https://example.com/set.png");
	const rejected = !window.__cozyclay.captureWithReferences().references.some((entry) => entry.role === "environment");
	window.__cozyclay.setEnvironmentImage(${JSON.stringify(ENVIRONMENT_PNG)});
	return rejected;
})()`));
expect("the slots survive a React commit", await waitFor(`window.__cozyclay.captureWithReferences().references.length === 2`, 10_000));

/* --- the capture ----------------------------------------------------------- */

const capture = await evaluate("window.__cozyclay.captureWithReferences()");
writeFileSync(`${out}/capture.json`, JSON.stringify({
	width: capture?.width,
	height: capture?.height,
	frame: capture?.frame,
	meta: capture?.meta,
	references: capture?.references,
	dataUrlPrefix: String(capture?.dataUrl ?? "").slice(0, 32),
}, null, 2));

expect("the capture is a PNG with the shot's delivery size", typeof capture?.dataUrl === "string" && capture.dataUrl.startsWith("data:image/png;base64,") && capture.width > 0 && capture.height > 0, JSON.stringify({ width: capture?.width, height: capture?.height }));
expect("the capture still carries its shot metadata", capture?.meta && typeof capture.meta.aspect === "string", JSON.stringify(capture?.meta ?? null).slice(0, 120));

const references = Array.isArray(capture?.references) ? capture.references : [];
const character = references.find((entry) => entry.role === "character");
const environment = references.find((entry) => entry.role === "environment");
expect("the capture carries a character reference", Boolean(character), JSON.stringify(references));
expect("the character reference is named after the subject", character?.name === "Alpha in a tan coat", String(character?.name));
expect("the character reference carries the identity picture", character?.dataUrl === IDENTITY_PNG, String(character?.dataUrl).slice(0, 48));
expect("the capture carries an environment reference", Boolean(environment), JSON.stringify(references));
expect("the environment reference carries the environment picture", environment?.dataUrl === ENVIRONMENT_PNG, String(environment?.dataUrl).slice(0, 48));
expect("the two slots hold different pictures", character?.dataUrl !== environment?.dataUrl);

// Clearing a slot removes its entry rather than leaving a hole in the list.
await evaluate("window.__cozyclay.setCharacterIdentityImage(0, null)");
const clearedOk = await waitFor(`(() => { const list = window.__cozyclay.captureWithReferences().references; return list.length === 1 && list[0].role === "environment"; })()`, 10_000);
expect("clearing the identity slot drops its reference", clearedOk, JSON.stringify(await evaluate("window.__cozyclay.captureWithReferences().references")));
await evaluate(`window.__cozyclay.setCharacterIdentityImage(0, ${JSON.stringify(IDENTITY_PNG)})`);
await waitFor("window.__cozyclay.captureWithReferences().references.length === 2", 10_000);

/* --- the inspector on screen ----------------------------------------------- */

// The Identity image slot lives in the character's Pose panel; open it and put
// the thumbnail on screen, so the screenshot shows the control, not the theory.
const opened = await evaluate(`(() => {
	const pose = [...document.querySelectorAll(".foldout-title")].find((node) => /^(Pose|포즈)$/.test(node.textContent.trim()));
	const head = pose?.closest(".foldout-head");
	if (head && head.getAttribute("aria-expanded") !== "true") head.click();
	return Boolean(head);
})()`);
expect("the character's Pose panel opens", opened);
await waitFor(`[...document.querySelectorAll(".reference-slot")].some((node) => /Identity image/.test(node.textContent))`, 10_000);
await evaluate(`[...document.querySelectorAll(".reference-slot")].find((node) => /Identity image/.test(node.textContent))?.scrollIntoView({ block: "center" })`);
expect("the Identity image slot is in the character inspector", await evaluate(`[...document.querySelectorAll(".reference-slot")].some((node) => /Identity image/.test(node.textContent))`));
expect(
	"the slot shows the picked picture as a thumbnail",
	await waitFor(`(() => { const img = [...document.querySelectorAll(".reference-slot img")].find((node) => node.src === ${JSON.stringify(IDENTITY_PNG)}); return !!img && img.getBoundingClientRect().width > 0; })()`, 10_000),
);
expect(
	"the slot offers Replace and Clear once it holds a picture",
	await evaluate(`(() => { const slot = [...document.querySelectorAll(".reference-slot")].find((node) => /Identity image/.test(node.textContent)); const labels = [...slot.querySelectorAll("button")].map((node) => node.textContent.trim()); return labels.includes("Clear") && labels.includes("Replace"); })()`),
);

/* --- the real file path ----------------------------------------------------- */

// Everything above sets the slot through the QA hook. This drives the actual
// <input type=file> with a 2048 px picture, which is the only way to prove the
// FileReader read and the 1024 px cap the stored data URL depends on.
const picked = await evaluate(`(async () => {
	const canvas = document.createElement("canvas");
	canvas.width = 2048; canvas.height = 1024;
	const context = canvas.getContext("2d");
	context.fillStyle = "#2d5c8a"; context.fillRect(0, 0, 2048, 1024);
	context.fillStyle = "#ef759d"; context.fillRect(64, 64, 640, 512);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	const file = new File([blob], "identity.png", { type: "image/png" });
	const input = document.querySelector("input[data-identity-image-input]");
	if (!input) return { error: "no identity input" };
	const transfer = new DataTransfer();
	transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
	for (let i = 0; i < 100; i += 1) {
		const entry = window.__cozyclay.captureWithReferences().references.find((r) => r.role === "character");
		if (entry && entry.dataUrl !== ${JSON.stringify(IDENTITY_PNG)}) {
			const decoded = await createImageBitmap(await (await fetch(entry.dataUrl)).blob());
			return { width: decoded.width, height: decoded.height, prefix: entry.dataUrl.slice(0, 22), bytes: entry.dataUrl.length };
		}
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
	return { error: "the picked file never reached the slot" };
})()`);
expect("a picked file reaches the slot as a PNG data URL", picked?.prefix === "data:image/png;base64,", JSON.stringify(picked));
expect("the stored picture is capped at 1024 px on the long side", picked?.width === 1024 && picked?.height === 512, JSON.stringify(picked));
writeFileSync(`${out}/picked-reference.json`, JSON.stringify(picked, null, 2));

const pane = await evaluate(`(() => { const node = document.querySelector(".inspector-pane"); if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
const shot = await send("Page.captureScreenshot", pane ? { format: "png", clip: { ...pane, scale: 2 } } : { format: "png" });
writeFileSync(`${out}/inspector.png`, Buffer.from(shot.data, "base64"));
expect("the inspector screenshot has bytes", Buffer.from(shot.data, "base64").byteLength > 2000);

expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log(`PASS reference slots — ${references.length} references on the capture, evidence in ${out}`);
