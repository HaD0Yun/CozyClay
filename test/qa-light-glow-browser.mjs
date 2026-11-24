#!/usr/bin/env node
// Browser contract for practical lights and glow, measured from captured
// pixels (the export path capture_frame, contact sheets and video share):
//   1. a warm point light beside a character raises the luminance of the lit
//      side of the torso, and much more than the far side;
//   2. under a dark stage, a glowing sphere is brighter than an unglowing twin,
//      and its halo brightens the dark around it;
//   3. the light's marker never reaches a capture (it is on GIZMO_LAYER), and a
//      halo is never raycast (it cannot occlude).
// It also saves the round's look captures (a lighter-lit face at night, an
// ember, a street lamp's pool) into QA_OUT.
//
// Run: `COZYCLAY_LIVE_PORT=6072 node tools/dev-full.mjs --host 127.0.0.1 --port 5232`
// in one shell, then
// `QA_OUT=/tmp/light-glow-qa QA_URL=http://127.0.0.1:5232/app/ CDP_PORT=9382 node tools/qa-browser.mjs -- node test/qa-light-glow-browser.mjs`
// Never aim it at a studio holding work: it clears localStorage.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9382);
const out = process.env.QA_OUT || "/tmp/light-glow-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5232/app/";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page");
assert.ok(page, "no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const runtimeErrors = [];
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
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const expect = (label, value, detail = "") => {
	console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
	if (!value) failures += 1;
};

// The key the stage opens with: 0.02 is a dark stage (the hemisphere fill still
// shows the set); QA_KEY=1.12 checks the same lights next to the default key.
const KEY = Number(process.env.QA_KEY ?? 0.02);
await mkdir(out, { recursive: true });
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
await evaluate(`(() => {
	const scene = {
		version: 4, activeSceneId: "scene-light-glow",
		scenes: [{
			id: "scene-light-glow", name: "LIGHT GLOW QA", objects: [],
			shotDocument: { version: 4, frameCount: 48, shots: [{ id: "shot-light-glow", name: "Light", startFrame: 0, endFrame: 47, cameraKeys: [] }], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a smoker" }], hasCharSheet: false, shotAspect: "16:9",
				keyLight: { x: 6, y: 9, z: 4, intensity: ${KEY}, warmth: 0.5 } },
		}],
	};
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	// The dark theme's grey stage: the light theme's white deck would saturate every measurement.
	localStorage.setItem("cozyclay.theme.v1", "dark");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Light glow QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: studioUrl });
await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.shotCam && window.__cozyclay.captureFraming && window.__cozyclay.rigA)"));
await sleep(1200);

/** Run an action, then wait until React has committed it (the QA hook's object
 * list is republished on commit) and a frame has drawn it. */
const act = async (action, args) => {
	const receipt = await evaluate(`(() => { window.__qaObjects = window.__cozyclay.objects; return window.__cozyclay.runStudioAction(${JSON.stringify(action)}, ${JSON.stringify(args)}); })()`);
	if (receipt?.ok && action.startsWith("object")) await waitFor(`${action} committed`, () => evaluate("window.__cozyclay.objects !== window.__qaObjects"), 10000);
	await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	return receipt;
};
const addObject = async (kind, name, placement) => {
	const receipt = await act("object.add", { kind, name, placement });
	assert.equal(receipt?.ok, true, JSON.stringify(receipt));
	return receipt.affectedIds[0];
};
const setObject = async (id, set) => {
	const receipt = await act("object.set", { id, set });
	assert.equal(receipt?.ok, true, JSON.stringify(receipt));
	return receipt;
};
/** Dark stage: the night preset when the stage has one, else the seeded key. */
const night = async () => {
	if (KEY > 0.5) return `key light ${KEY}`;
	const lit = await evaluate(`(() => { try { const r = window.__cozyclay.runStudioAction("stage.applyLighting", { preset: "night" }); return Boolean(r?.ok); } catch { return false; } })()`);
	return lit ? "night preset" : `key light ${KEY}`;
};

const W = 640, H = 360;
/** Capture through the export path, then measure mean sRGB luma (0..255) in
 * pixel rects/discs projected from world points with the same camera. */
const capture = (framing, regions = {}, save = null) => evaluate(`(async () => {
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
	const luma = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
	const result = {};
	for (const [name, region] of Object.entries(${JSON.stringify(regions)})) {
		let sum = 0, count = 0;
		if (region.rect) {
			const a = px(region.rect[0]), b = px(region.rect[1]);
			for (let y = Math.round(Math.min(a.y, b.y)); y <= Math.round(Math.max(a.y, b.y)); y += 1)
				for (let x = Math.round(Math.min(a.x, b.x)); x <= Math.round(Math.max(a.x, b.x)); x += 1) { sum += luma((y * ${W} + x) * 4); count += 1; }
			context.strokeStyle = "#00ff88"; context.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
		} else {
			const c = px(region.centre), edge = px({ ...region.centre, x: region.centre.x + region.radius });
			const r = Math.abs(edge.x - c.x), inner = r * (region.from ?? 0), outer = r * (region.to ?? 1);
			for (let y = Math.floor(c.y - outer); y <= Math.ceil(c.y + outer); y += 1)
				for (let x = Math.floor(c.x - outer); x <= Math.ceil(c.x + outer); x += 1) {
					const d = Math.hypot(x - c.x, y - c.y);
					if (d > outer || d < inner || x < 0 || y < 0 || x >= ${W} || y >= ${H}) continue;
					sum += luma((y * ${W} + x) * 4); count += 1;
				}
		}
		result[name] = count ? Math.round((sum / count) * 10) / 10 : null;
	}
	return { ...result, png: ${save ? "dataUrl" : "null"}, overlay: ${save ? "canvas.toDataURL('image/png')" : "null"} };
})()`);
const savePng = async (name, dataUrl) => {
	if (!dataUrl) return;
	await writeFile(`${out}/${name}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
	console.log(`saved ${out}/${name}.png`);
};

// 1. A point light beside the character lights the near side of the torso.
const torso = {
	left: { rect: [{ x: -0.14, y: 1.42, z: 0.12 }, { x: -0.05, y: 1.12, z: 0.12 }] },
	right: { rect: [{ x: 0.05, y: 1.42, z: 0.12 }, { x: 0.14, y: 1.12, z: 0.12 }] },
};
const front = { pos: { x: 0, y: 1.3, z: 2.2 }, yaw: 0, pitch: -0.02, fovDeg: 40 };
const darkness = await night();
const dark = await capture(front, torso);
const lampId = await addObject("point-light", "Side lamp", { x: 0.55, y: 1.3, z: 0.35 });
await setObject(lampId, { light: { color: "#ffb070", intensity: 3, range: 0 } });
const lit = await capture(front, torso, "torso");
const gainNear = lit.right - dark.right, gainFar = lit.left - dark.left;
console.log(`stage: ${darkness}; torso luma near side ${dark.right} -> ${lit.right} (+${gainNear.toFixed(1)}), far side ${dark.left} -> ${lit.left} (+${gainFar.toFixed(1)})`);
expect("the point light raises the lit side's luminance", gainNear >= 15, `+${gainNear.toFixed(1)}`);
expect("the lit side gains far more than the far side", gainNear > 2 * Math.max(gainFar, 1), `near +${gainNear.toFixed(1)} vs far +${gainFar.toFixed(1)}`);
await savePng("qa-torso-overlay", lit.overlay);
const markerFree = await evaluate(`(() => window.__captureCameraMask !== undefined && (window.__captureCameraMask & (1 << 5)) === 0)()`);
expect("the capture camera drops GIZMO_LAYER (no light marker in a recorded frame)", markerFree);

// 2. Under the dark stage a glowing sphere outshines its unglowing twin.
await act("object.remove", { ids: [lampId] });
const plainId = await addObject("sphere", "Plain ball", { x: -0.9, y: 0.5, z: 0.6 });
const glowId = await addObject("sphere", "Ember ball", { x: -0.45, y: 0.5, z: 0.6 });
for (const id of [plainId, glowId]) await setObject(id, { scale: { x: 0.12, y: 0.12, z: 0.12 }, color: "#8a5a44" });
const glowReceipt = await setObject(glowId, { glow: { color: "#ff5a1f", intensity: 6, halo: 2.5 } });
const readback = glowReceipt.delta?.[0]?.after?.patched?.find((row) => row.path === "object.glow");
expect("the receipt reads the glow back", readback?.text === JSON.stringify({ color: "#ff5a1f", intensity: 6, halo: 2.5 }), JSON.stringify(readback));
const ball = (x) => ({ centre: { x, y: 0.56, z: 0.6 }, radius: 0.06 });
const balls = { plain: { ...ball(-0.9), to: 0.8 }, glow: { ...ball(-0.45), to: 0.8 }, plainRing: { ...ball(-0.9), from: 1.3, to: 2.2 }, glowRing: { ...ball(-0.45), from: 1.3, to: 2.2 } };
const ballView = { pos: { x: -0.67, y: 0.75, z: 1.7 }, yaw: 0, pitch: -0.18, fovDeg: 30 };
const glowing = await capture(ballView, balls, "balls");
console.log(`sphere luma plain ${glowing.plain} vs glowing ${glowing.glow}; halo ring plain ${glowing.plainRing} vs glowing ${glowing.glowRing}`);
expect("a glowing sphere is brighter than its unglowing twin under the dark stage", glowing.glow > glowing.plain + 60, `${glowing.glow} vs ${glowing.plain}`);
expect("the halo brightens the dark around the glowing sphere", glowing.glowRing > glowing.plainRing + 10, `${glowing.glowRing} vs ${glowing.plainRing}`);
await savePng("qa-balls-overlay", glowing.overlay);
const picked = await evaluate(`(() => {
	let halo = null;
	window.__cozyclay.shotCam.parent?.traverse?.((node) => { if (node.userData?.glowHalo) halo = node; });
	if (!halo) return "no halo in the scene";
	const hits = [];
	halo.raycast({ camera: window.__cozyclay.shotCam, ray: null }, hits);
	return halo.castShadow === false && halo.material.depthWrite === false && hits.length === 0 ? true : "halo would occlude";
})()`);
expect("the halo writes no depth, casts no shadow and is never raycast", picked === true, String(picked));
for (const intensity of [5, 7, 6]) await setObject(glowId, { glow: { intensity } });
const haloCount = await evaluate(`(() => { let count = 0; window.__cozyclay.shotCam.parent.traverse((node) => { if (node.userData?.glowHalo) count += 1; }); return count; })()`);
expect("re-rendering a glowing record keeps exactly one halo", haloCount === 1, `${haloCount} halos`);
const steady = await capture(ballView, balls);
expect("glow without flicker is identical frame to frame", steady.glow === glowing.glow, `${steady.glow} vs ${glowing.glow}`);
await setObject(glowId, { glow: null });
const off = await capture(ballView, balls);
expect("glow: null restores the plain look", Math.abs(off.glow - glowing.plain) < 12, `${off.glow} vs ${glowing.plain}`);
await act("object.remove", { ids: [plainId, glowId] });

// 3. The round's look captures.
const faceView = { pos: { x: 0.12, y: 1.6, z: 1.15 }, yaw: 0.08, pitch: -0.05, fovDeg: 36 };
const flameId = await addObject("point-light", "Lighter flame", { x: 0.04, y: 1.58, z: 0.22 });
await setObject(flameId, { light: { color: "#ff9c4a", intensity: 0.5, flicker: 0.6, shadow: true }, glow: { color: "#ffb347", intensity: 6, halo: 3 } });
const lighter = await capture(faceView, {}, "lighter");
await savePng(KEY > 0.5 ? "studio-lighter-face" : "night-lighter-face", lighter.png);
await act("object.remove", { ids: [flameId] });

const emberId = await addObject("sphere", "Ember", { x: 0.06, y: 1.5, z: 0.26 });
await setObject(emberId, { scale: { x: 0.009, y: 0.009, z: 0.009 }, color: "#5a2a1a", glow: { color: "#ff4a1a", intensity: 8, halo: 3 } });
const emberView = { pos: { x: 0.12, y: 1.56, z: 0.75 }, yaw: 0.1, pitch: -0.1, fovDeg: 30 };
const ember = await capture(emberView, { ember: { centre: { x: 0.06, y: 1.5045, z: 0.26 }, radius: 0.0045, to: 1 } }, "ember");
await savePng(KEY > 0.5 ? "studio-ember" : "night-ember", ember.png);
console.log(`ember luma ${ember.ember}`);
await act("object.remove", { ids: [emberId] });

const postId = await addObject("cylinder", "Lamp post", { x: 1.6, y: 0, z: -0.6 });
await setObject(postId, { scale: { x: 0.1, y: 4, z: 0.1 }, color: "#3b3f44" });
const headId = await addObject("cube", "Lamp head", { x: 1.25, y: 3.9, z: -0.6 });
await setObject(headId, { scale: { x: 0.8, y: 0.12, z: 0.3 }, color: "#2f3236", glow: { color: "#ffd59a", intensity: 3, halo: 0.6 } });
const streetId = await addObject("spot-light", "Street lamp", { x: 0.95, y: 3.8, z: -0.6 });
await setObject(streetId, { light: { color: "#ffcf8a", intensity: 40, angle: 30, softness: 0.4, shadow: true, aim: { x: 0.5, y: 0, z: 0.2 } } });
const streetView = { pos: { x: 0.1, y: 2.3, z: 7.8 }, yaw: 0.03, pitch: -0.14, fovDeg: 42 };
const street = await capture(streetView, { pool: { centre: { x: 1.4, y: 0, z: 0.9 }, radius: 0.4 }, outside: { centre: { x: -3.4, y: 0, z: 0.9 }, radius: 0.4 } }, "street");
await savePng(KEY > 0.5 ? "studio-street-lamp" : "night-street-lamp", street.png);
console.log(`street lamp pool floor luma ${street.pool} vs outside ${street.outside}`);
if (KEY < 0.5) expect("the street lamp throws a visible pool under the dark stage", street.pool > street.outside + 10, `${street.pool} vs ${street.outside}`);

// 4. The light is an object the user can pick in the viewport, and its
// details show the light controls.
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const selectedRow = () => evaluate(`document.querySelector(".v2-outliner .hierarchy-row-wrap.selected")?.dataset.nodeId ?? null`);
await evaluate(`window.__cozyclay.frameEditorCam({ x: 2.6, y: 4.6, z: 2.6 }, { x: 0.95, y: 3.8, z: -0.6 })`);
await sleep(500);
const at = await evaluate(`(() => {
	const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(true);
	const pane = document.querySelector(".vp-pane.vp-main").getBoundingClientRect();
	const v = cam.position.clone().set(0.95, 3.8, -0.6).project(cam);
	return { x: pane.left + (v.x + 1) / 2 * pane.width, y: pane.top + (1 - v.y) / 2 * pane.height };
})()`);
await click(at.x, at.y);
const lightPicked = await waitFor("viewport click selects the light", async () => ((await selectedRow()) === `object:${streetId}` ? true : null), 8000).catch(() => false);
expect("clicking the light's marker in the viewport selects it", lightPicked === true, String(await selectedRow()));
const panel = await waitFor("light details", () => evaluate(`(() => {
	const text = document.querySelector(".inspector-pane")?.textContent ?? "";
	return text.includes("Intensity (cd)") && text.includes("Cone angle") && text.includes("Flicker") ? { header: document.querySelector("[data-testid=details-selection]")?.textContent ?? "" } : null;
})()`), 8000).catch(() => null);
expect("the details panel shows the light controls", Boolean(panel), JSON.stringify(panel));
expect("the details header names a spot light", /Light\s*·\s*Spot/.test(panel?.header ?? ""), panel?.header ?? "");
const screenshot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(`${out}/viewport-light-selected.png`, Buffer.from(screenshot.data, "base64"));
console.log(`saved ${out}/viewport-light-selected.png`);


expect("no runtime errors", runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(" | "));
ws.close();
if (failures) {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
console.log("light and glow browser contract: ok");
