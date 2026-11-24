#!/usr/bin/env node
// Browser contract for a practical light inside an enclosure (session 1e3d1adc: a street lamp's
// shadow-casting light sat inside its pole, and the night set stayed dark at any intensity),
// measured from captured pixels on the export path capture_frame and contact sheets share:
//   1. a shadow-casting point light inside a glowing sphere 3 m above the floor lights the floor:
//      the pool under it is brighter than the floor outside (a glow is self-lit, casts no shadow);
//   2. the same sphere without glow shuts the light in: the receipt that removes the glow says
//      LIGHT_BLOCKED naming the sphere, and the pool goes dark;
//   3. the session's lamp (the light inside its pole) gets the warning on the edit that turns
//      the light's shadow on.
// Captures go to QA_OUT.
//
// Run: `COZYCLAY_LIVE_PORT=6079 node tools/dev-full.mjs --host 127.0.0.1 --port 5239` in one
// shell, then `QA_OUT=/tmp/light-enclosure-qa QA_URL=http://127.0.0.1:5239/app/ CDP_PORT=9389
// node tools/qa-browser.mjs -- node test/qa-light-enclosure-browser.mjs`.
// Never aim it at a studio holding work: it clears localStorage.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9389);
const out = process.env.QA_OUT || "/tmp/light-enclosure-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5239/app/";
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((target) => target.type === "page");
assert.ok(page, "no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map(), runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "exception");
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 60000) => {
	for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
let failures = 0;
const expect = (label, value, detail = "") => {
	console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
	if (!value) failures += 1;
};

await mkdir(out, { recursive: true });
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
await evaluate(`(() => {
	const scene = { version: 4, activeSceneId: "scene-enclosure", scenes: [{ id: "scene-enclosure", name: "ENCLOSURE QA", objects: [],
		shotDocument: { version: 4, frameCount: 48, shots: [{ id: "shot-enclosure", name: "Lamp", startFrame: 0, endFrame: 47, cameraKeys: [] }], waypoints: [] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a smoker" }], hasCharSheet: false, shotAspect: "16:9",
			keyLight: { x: 6, y: 9, z: 4, intensity: 0.02, warmth: 0.5 } } }] };
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.theme.v1", "dark");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Enclosure QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: studioUrl });
await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.shotCam && window.__cozyclay.captureFraming)"));
await new Promise((resolve) => setTimeout(resolve, 1200));

/** Run an action, then wait until React has committed it and a frame has drawn it. */
const act = async (action, args) => {
	const receipt = await evaluate(`(() => { window.__qaObjects = window.__cozyclay.objects; return window.__cozyclay.runStudioAction(${JSON.stringify(action)}, ${JSON.stringify(args)}); })()`);
	assert.equal(receipt?.ok, true, JSON.stringify(receipt));
	if (action.startsWith("object")) await waitFor(`${action} committed`, () => evaluate("window.__cozyclay.objects !== window.__qaObjects"), 10000);
	await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	return receipt;
};
const add = async (kind, name, placement) => (await act("object.add", { kind, name, placement })).affectedIds[0];
const blocked = (receipt) => (receipt.warnings ?? []).filter((warning) => warning.code === "LIGHT_BLOCKED");

const W = 640, H = 360;
/** Capture through the export path; mean sRGB luma (0..255) in floor discs projected with the same camera. */
const capture = (framing, discs) => evaluate(`(async () => {
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	const framing = ${JSON.stringify(framing)};
	const dataUrl = window.__cozyclay.captureFraming(framing, { width: ${W}, height: ${H} });
	const image = new Image();
	image.src = dataUrl;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = ${W}; canvas.height = ${H};
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0);
	const data = context.getImageData(0, 0, ${W}, ${H}).data;
	const cam = window.__cozyclay.shotCam.clone();
	cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
	cam.rotation.order = "YXZ";
	cam.rotation.set(framing.pitch, framing.yaw, 0);
	cam.fov = framing.fovDeg; cam.aspect = ${W} / ${H};
	cam.clearViewOffset(); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
	const V = cam.position.constructor;
	const px = (p) => { const v = new V(p.x, p.y, p.z).project(cam); return { x: (v.x + 1) / 2 * ${W}, y: (1 - v.y) / 2 * ${H} }; };
	const result = { png: dataUrl };
	for (const [name, disc] of Object.entries(${JSON.stringify(discs)})) {
		let sum = 0, count = 0;
		// a floor disc: sample its world points, so perspective squash is measured honestly
		for (let i = 0; i < 400; i += 1) {
			const r = disc.radius * Math.sqrt((i + 0.5) / 400), a = i * 2.39996;
			const p = px({ x: disc.centre.x + r * Math.cos(a), y: disc.centre.y, z: disc.centre.z + r * Math.sin(a) });
			const x = Math.round(p.x), y = Math.round(p.y);
			if (x < 0 || y < 0 || x >= ${W} || y >= ${H}) continue;
			const k = (y * ${W} + x) * 4;
			sum += 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]; count += 1;
		}
		result[name] = count ? Math.round((sum / count) * 10) / 10 : null;
	}
	return result;
})()`);
const savePng = async (name, dataUrl) => {
	await writeFile(`${out}/${name}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
	console.log(`saved ${out}/${name}.png`);
};

const preset = await evaluate(`(() => { try { return Boolean(window.__cozyclay.runStudioAction("stage.applyLighting", { preset: "night" })?.ok); } catch { return false; } })()`);
console.log(`stage: ${preset ? "night preset" : "key light 0.02"}`);
// The lamp stands away from the character: a 30 cm bulb centred 3 m above the floor, its light at the centre.
const L = { x: 2.4, z: -1.2 };
const view = { pos: { x: 0.2, y: 2.6, z: 6.5 }, yaw: 0.12, pitch: -0.3, fovDeg: 45 };
const discs = { pool: { centre: { x: L.x, y: 0, z: L.z }, radius: 0.5 }, outside: { centre: { x: -3, y: 0, z: -1.2 }, radius: 0.5 } };
const dark = await capture(view, discs);
const bulbId = await add("sphere", "Lamp Bulb", { x: L.x, y: 2.85, z: L.z });
await act("object.set", { id: bulbId, set: { scale: { x: 0.3, y: 0.3, z: 0.3 }, color: "#ffd8a0", glow: { color: "#ffb060", intensity: 6, halo: 1.5 } } });
const lightId = await add("point-light", "Lamp Light", { x: L.x, y: 3, z: L.z });
const lit = await act("object.set", { id: lightId, set: { light: { color: "#ffb060", intensity: 40, range: 12, shadow: true } } });
expect("a light inside a glowing bulb draws no LIGHT_BLOCKED warning", blocked(lit).length === 0, JSON.stringify(lit.warnings ?? []));
const glowing = await capture(view, discs);
await savePng("enclosure-glowing-bulb", glowing.png);
console.log(`floor luma: no lamp pool ${dark.pool} / outside ${dark.outside}; glowing bulb pool ${glowing.pool} / outside ${glowing.outside}`);
expect("the light inside the glowing sphere lights the floor under it (pool >= outside + 15)", glowing.pool >= glowing.outside + 15, `${glowing.pool} vs ${glowing.outside}`);
expect("and the pool is brighter than before the lamp (>= +15)", glowing.pool >= dark.pool + 15, `${glowing.pool} vs ${dark.pool}`);

const unglow = await act("object.set", { id: bulbId, set: { glow: null } });
const warning = blocked(unglow)[0];
expect("removing the glow warns LIGHT_BLOCKED on the light, naming the bulb", warning?.id === lightId && warning.message.includes(`Lamp Bulb (${bulbId})`), JSON.stringify(unglow.warnings ?? []));
const shut = await capture(view, discs);
await savePng("enclosure-unglowing-bulb", shut.png);
console.log(`unglowing bulb pool ${shut.pool} / outside ${shut.outside}`);
expect("the unglowing sphere shuts the light in (its pool loses most of the light)", shut.pool - shut.outside < (glowing.pool - glowing.outside) / 3, `${shut.pool} vs ${shut.outside}`);
const off = await act("object.set", { id: lightId, set: { light: { shadow: false } } });
const through = await capture(view, discs);
expect("with shadow false the light passes through the sphere and the warning is gone", blocked(off).length === 0 && through.pool >= through.outside + 15, `${through.pool} vs ${through.outside}; ${JSON.stringify(off.warnings ?? [])}`);
await act("object.remove", { ids: [bulbId, lightId] });

// The session's lamp: the light 30 cm under the top of its 3.2 m pole.
const poleId = await add("cylinder", "Lamp Pole", { x: L.x, y: 0, z: L.z });
await act("object.set", { id: poleId, set: { scale: { x: 0.08, y: 3.2, z: 0.08 }, color: "#2a2c30" } });
const sessionLight = await add("point-light", "Lamp Light", { x: L.x, y: 2.9, z: L.z });
const session = await act("object.set", { id: sessionLight, set: { light: { color: "#ffb060", intensity: 90, range: 12, shadow: true } } });
const poleWarning = blocked(session)[0];
expect("the session's lamp: turning the shadow on warns that the pole blocks the light", poleWarning?.message.includes(`Lamp Pole (${poleId})`), JSON.stringify(session.warnings ?? []));
const pole = await capture(view, discs);
await savePng("enclosure-session-pole", pole.png);
console.log(`light inside the pole: pool ${pole.pool} / outside ${pole.outside} (warning: ${poleWarning?.message})`);

expect("no runtime errors", runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(" | "));
ws.close();
if (failures) {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
console.log("light enclosure browser contract: ok");
