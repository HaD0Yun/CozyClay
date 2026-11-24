#!/usr/bin/env node
// Browser contract for placed lights and what verify_result lighting says about them:
//   1. the user selects a light in the Outliner, moves it, switches it to directional, aims it at the character,
//      deletes it and undoes the delete, all through the Studio UI;
//   2. a spot aimed at the character follows it when the character moves;
//   3. verify_result lighting (through the live hub) reports a light behind the subject as back, a roof's cast shadow
//      on it by the roof, and a light out of range as not reaching; the roof's shadow darkens the rendered body;
//   4. the body mask litToShade reads stays on the body: on random cameras and turns, the mask pixels are pixels the
//      character's own render changes (rendered with and without it).
// Run: `COZYCLAY_LIVE_PORT=<hub> node tools/dev-full.mjs --host 127.0.0.1 --port <vite>`, then
// `COZYCLAY_LIVE_PORT=<hub> QA_URL=http://127.0.0.1:<vite>/app/ CDP_PORT=<cdp> node tools/qa-browser.mjs -- node test/qa-light-facts-browser.mjs`
// Never aim it at a studio holding work: it clears localStorage.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";
const livePort = process.env.COZYCLAY_LIVE_PORT;
const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((target) => target.type === "page");
assert.ok(page, "no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map(), runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.exception?.description || "exception");
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "browser evaluation failed");
	return result.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, probe, timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { const value = await probe().catch(() => null); if (value) return value; await sleep(150); }
	throw new Error(`Timed out waiting for ${label}`);
};
let failures = 0;
const expect = (label, value, detail = "") => { console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`); if (!value) failures += 1; };
const frames = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

await send("Runtime.enable");
// a headless page is never the focused window: let focus, typing and key presses land as they do for a user
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
await evaluate(`(() => {
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.theme.v1", "dark");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Light facts QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify({ version: 4, activeSceneId: "scene-lights", scenes: [{ id: "scene-lights", name: "LIGHT FACTS QA", objects: [],
		shotDocument: { version: 4, frameCount: 24, shots: [{ id: "shot-a", name: "A", startFrame: 0, endFrame: 23, cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.3, z: 4.5 }, yaw: 0, pitch: -0.05, fovDeg: 40 } }] }], waypoints: [] },
		stage: { characters: [{ id: "char-a", model: "x-bot-tpose", x: 0, y: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a dancer" }], hasCharSheet: false, shotAspect: "16:9" } }] }));
})()`);
await send("Page.navigate", { url: studioUrl });
await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.rigA && window.__cozyclay.captureFraming)"), 60000);
await sleep(1500);

const act = async (action, args) => {
	const receipt = await evaluate(`(() => { window.__qaObjects = window.__cozyclay.objects; return window.__cozyclay.runStudioAction(${JSON.stringify(action)}, ${JSON.stringify(args)}); })()`);
	if (receipt?.ok && action.startsWith("object")) await waitFor(`${action} committed`, () => evaluate("window.__cozyclay.objects !== window.__qaObjects"), 10000);
	await frames();
	return receipt;
};
const record = (id) => evaluate(`window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(id)}) ?? null`);
const sceneRoot = `(() => { let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent; return node; })()`;
const threeLight = (id) => evaluate(`(() => { let found = null; ${sceneRoot}.traverse((n) => { if (n.isLight && n.userData.sceneObjectId === ${JSON.stringify(id)}) found = n; });
	if (!found) return null; const p = found.getWorldPosition(found.position.clone()), t = found.target ? found.target.getWorldPosition(found.position.clone()) : null;
	return { type: found.type, position: p.toArray(), target: t?.toArray() ?? null, aimFound: found.userData.aimFound ?? null }; })()`);
/** A click on a control: the element's own click (a press the page's layout may cover in a headless window). */
const click = async (selector) => {
	await waitFor(selector, () => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 8000);
	await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus?.(); el.click(); })()`);
	await frames();
};
const key = async (code, keyName, modifiers = 0) => {
	for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, code, key: keyName, modifiers, windowsVirtualKeyCode: keyName === "Delete" ? 46 : keyName.toUpperCase().charCodeAt(0) });
	await frames();
};
/** Pick an option of the light panel's select (the Inspector's DOM control, as a click on it would). */
const choose = (selector, value) => evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); if (!select) return false;
	Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
let workspace = [];
/** verify_result lighting through the live hub; with several editors on the hub, the one showing this scene. */
const verify = () => {
	const run = () => { try { return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../bin/cozyclay.mjs", import.meta.url)), "live", "verify", "--targets", "char-a", "--checks", "lighting", "--live-port", livePort, ...workspace], { encoding: "utf8", timeout: 60000 })); } catch (error) { return JSON.parse(error.stdout); } };
	let answer = run();
	const mine = answer.error?.code === "AMBIGUOUS_WORKSPACE" && answer.error.details.candidates.find((c) => c.scene === "LIGHT FACTS QA");
	if (mine) { workspace = ["--workspace", mine.handle]; answer = run(); }
	return answer.checks?.lighting;
};

// 1. The user operates a light through the UI.
const added = await act("object.add", { kind: "spot-light", name: "Back light", placement: { x: -1, z: -3 } });
assert.equal(added?.ok, true, JSON.stringify(added));
const lightId = added.affectedIds[0];
await evaluate(`window.__cozyclay.runStudioAction("view.setMode", { mode: "scene" })`).catch(() => null);
// open the folded Outliner groups (Props holds the light), then click the light's row
const propsToggle = `.v2-outliner .hierarchy-row-wrap[data-node-id="props"][aria-expanded="false"] .hierarchy-toggle`;
if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(propsToggle)}))`)) await click(propsToggle);
await click(`.v2-outliner .hierarchy-row-wrap[data-node-id="object:${lightId}"] button.hierarchy-row`);
const selected = await waitFor("outliner selects the light", () => evaluate(`document.querySelector(".v2-outliner .hierarchy-row-wrap.selected")?.dataset.nodeId ?? null`).then((id) => (id === `object:${lightId}` ? id : null)), 8000).catch(() => null);
expect("a click on the light's Outliner row selects it", selected === `object:${lightId}`);
const panel = await waitFor("light panel", () => evaluate(`(() => { const t = document.querySelector(".inspector-pane")?.textContent ?? ""; return t.includes("Aim at") && t.includes("Cone angle") ? true : null; })()`), 8000).catch(() => false);
expect("the Inspector shows the light's controls with Aim at", panel === true);
// move: type x 1.5 into the Transform panel's position row
await evaluate(`[...document.querySelectorAll(".inspector-pane .vec3-row")].find((r) => r.textContent.includes("Position") && r.offsetParent !== null).querySelector("input").focus()`);
await frames();
await send("Input.insertText", { text: "1.5" });
await frames();
await key("Enter", "Enter");
await sleep(300);
expect("typing a position in the Transform panel moves the light", (await record(lightId))?.x === 1.5, JSON.stringify((await record(lightId))?.x));
expect("the drawn light moves with it", Math.abs((await threeLight(lightId))?.position[0] - 1.5) < 1e-6, JSON.stringify(await threeLight(lightId)));
expect("the Type select switches it to directional", await choose(`select[data-field="light-type"]`, "directional") && (await waitFor("directional", async () => (await record(lightId))?.light.type === "directional", 5000).catch(() => false)));
expect("the scene draws a directional light", (await waitFor("directional drawn", async () => ((await threeLight(lightId))?.type === "DirectionalLight" ? true : null), 5000).catch(() => false)) === true);
expect("the Aim at select aims it at the character", await choose(`select[data-field="light-aim"]`, "id:char-a") && (await waitFor("aim", async () => (await record(lightId))?.light.aim?.id === "char-a", 5000).catch(() => false)));
await evaluate(`document.activeElement?.blur?.()`);
await key("Delete", "Delete");
expect("Delete removes the selected light", (await waitFor("deleted", async () => ((await record(lightId)) === null ? true : null), 5000).catch(() => false)) === true);
await evaluate(`document.activeElement?.blur?.()`);
await key("KeyZ", "z", 2);
const back = await waitFor("undo", async () => (await record(lightId)), 5000).catch(() => null);
expect("Ctrl+Z brings it back, directional and aimed", back?.light.type === "directional" && back?.light.aim?.id === "char-a", JSON.stringify(back?.light));
await act("object.remove", { ids: [lightId] });

// 2. A spot aimed at the character follows it.
const spot = (await act("object.add", { kind: "spot-light", name: "Follow spot", placement: { x: -1, z: -3 } })).affectedIds[0];
await act("object.set", { id: spot, set: { light: { intensity: 60, angle: 35, aim: { id: "char-a" } } } });
const hips = () => evaluate(`(() => { let h = null; window.__cozyclay.rigA.traverse((n) => { if (!h && n.isBone && /hips/i.test(n.name)) h = n; }); return h.getWorldPosition(h.position.clone()).toArray(); })()`);
/** The angle (degrees) between the spot's axis and the line from it to the character's hips. */
const offAxis = async () => {
	const { position, target } = await threeLight(spot), at = await hips();
	const a = target.map((v, i) => v - position[i]), b = at.map((v, i) => v - position[i]);
	return (Math.acos(a.reduce((s, v, i) => s + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b))) * 180) / Math.PI;
};
expect("the spot points at the character's hips", (await offAxis()) < 0.1, `${(await offAxis()).toFixed(3)} deg`);
await act("character.set", { id: "char-a", set: { position: { x: 1.2, y: 0, z: 0.5 } } });
await sleep(300);
expect("and still does after the character moves", (await offAxis()) < 0.1 && (await hips())[0] > 1, `${(await offAxis()).toFixed(3)} deg, hips ${JSON.stringify(await hips())}`);
await act("character.set", { id: "char-a", set: { position: { x: 0, y: 0, z: 0 } } });

// 3. What verify_result lighting says.
if (livePort) {
	const behind = verify();
	console.log(`verify_result lighting: ${JSON.stringify(behind.subjects)}`);
	const row = (lighting, id) => lighting.subjects?.[0]?.lights?.find((r) => r.id === id);
	expect("a spot behind the subject reports back, reaching it", row(behind, spot)?.side.startsWith("back") && row(behind, spot).reach > 0.8, JSON.stringify(row(behind, spot)));
	expect("the key reports reaching from its side", row(behind, "key")?.reach > 0.8, JSON.stringify(row(behind, "key")));
	const keyLight = await evaluate(`(() => { let k = null; ${sceneRoot}.traverse((n) => { if (n.isDirectionalLight && n.castShadow && !n.userData.sceneLight) k = n; }); return k.position.toArray(); })()`);
	const torso = `(async () => { const dataUrl = window.__cozyclay.captureFraming({ pos: { x: 0, y: 1.3, z: 4.5 }, yaw: 0, pitch: -0.05, fovDeg: 40 }, { width: 640, height: 360 }); const image = new Image(); image.src = dataUrl; await image.decode();
		const c = document.createElement("canvas"); c.width = image.width; c.height = image.height; const x = c.getContext("2d"); x.drawImage(image, 0, 0);
		const d = x.getImageData(Math.round(image.width * 0.47), Math.round(image.height * 0.35), Math.round(image.width * 0.06), Math.round(image.height * 0.2)).data;
		let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return s / (d.length / 4); })()`;
	const open = await evaluate(torso);
	const roof = (await act("object.add", { kind: "cube", name: "Roof", placement: { x: 0, z: 0 } })).affectedIds[0];
	await act("object.set", { id: roof, set: { scale: { x: 6, y: 0.2, z: 6 }, position: { x: 0, y: 2.6, z: 0 } } });
	await sleep(400);
	const shaded = verify();
	const shadedKey = row(shaded, "key");
	expect("under a roof the key's cast shadow is reported, by the roof", shadedKey?.reach < 0.2 && shadedKey?.shadow?.by?.[0] === roof, `${JSON.stringify(shadedKey)} key at ${keyLight}`);
	const covered = await evaluate(torso);
	expect("and the rendered torso is darker under it", covered < open - 5, `${open.toFixed(1)} -> ${covered.toFixed(1)}`);
	await act("object.remove", { ids: [roof] });
	const far = (await act("object.add", { kind: "point-light", name: "Far lamp", placement: { x: 4.5, z: 0 } })).affectedIds[0];
	await act("object.set", { id: far, set: { light: { intensity: 5, range: 2 } } });
	const outOfRange = row(verify(), far);
	expect("a point light 4.5 m away with range 2 does not reach: why range", outOfRange?.reach === 0 && outOfRange.why === "range", JSON.stringify(outOfRange));
	await act("object.remove", { ids: [far] });
} else console.log("SKIP verify_result: set COZYCLAY_LIVE_PORT");

// 4. The litToShade mask stays on the body, over random cameras and turns: the first drawn mesh on the ray through each
// mask pixel (raycast against the visible layer-0 meshes the frame draws) belongs to the character.
let seed = 11;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const leaks = [];
for (let n = 0; n < 16; n++) {
	const yaw = (random() - 0.5) * 2 * Math.PI, distance = 2.2 + random() * 3, height = 0.6 + random() * 1.6, rot = Math.round((random() - 0.5) * 360);
	await act("character.set", { id: "char-a", set: { rot } }).catch(() => null);
	const framing = { pos: { x: Math.sin(yaw) * distance, y: height, z: Math.cos(yaw) * distance }, yaw, pitch: Math.atan2(1 - height, distance), fovDeg: 30 + random() * 20 };
	const leak = await evaluate(`(async () => {
		const { bodyMask } = await import("/src/stage-light-facts.js");
		const { Raycaster, Vector2 } = await import("/node_modules/three/build/three.module.js");
		const W = 480, H = 270, framing = ${JSON.stringify(framing)}, root = ${sceneRoot};
		const image = new Image(); image.src = window.__cozyclay.captureFraming(framing, { width: W, height: H }); await image.decode();
		const cam = window.__cozyclay.shotCam.clone();
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z); cam.rotation.order = "YXZ"; cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg; cam.aspect = W / H; cam.clearViewOffset(); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
		const points = [], index = new Map();
		window.__cozyclay.rigA.updateMatrixWorld(true);
		window.__cozyclay.rigA.traverse((node) => { if (node.isBone) index.set(node, points.push(node.getWorldPosition(node.position.clone())) - 1); });
		const bones = [...index].filter(([node]) => index.has(node.parent)).map(([node, i]) => [index.get(node.parent), i]);
		const mask = bodyMask(bones, points.map((p) => ({ x: p.x, y: p.y, z: p.z })), { camera: cam, width: W, height: H }, []);
		const drawn = []; root.traverseVisible((node) => { if (node.isMesh && (node.layers.mask & 1) && !node.userData?.beautyOnly) drawn.push(node); });
		const mine = (node) => { for (let k = node; k; k = k.parent) if (k.userData?.characterPick === "char-a") return true; return false; };
		const ray = new Raycaster(), canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
		const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
		let on = 0, off = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!mask[y * W + x]) continue;
			on++;
			ray.setFromCamera(new Vector2(((x + 0.5) / W) * 2 - 1, ((y + 0.5) / H) * 2 - 1), cam);
			const hit = ray.intersectObjects(drawn, false)[0];
			const body = hit && mine(hit.object);
			if (!body) off++;
			context.fillStyle = body ? "#00ff78" : "#ff0000"; context.fillRect(x, H - 1 - y, 1, 1);
		}
		return { on, off, overlay: canvas.toDataURL("image/png") };
	})()`);
	if (process.env.QA_OUT) { await mkdir(process.env.QA_OUT, { recursive: true }); await writeFile(`${process.env.QA_OUT}/mask-${n}.png`, Buffer.from(leak.overlay.split(",")[1], "base64")); }
	leaks.push(leak);
}
console.log(`mask pixels per view (on body / off body): ${leaks.map((l) => `${l.on - l.off}/${l.off}`).join(" ")}`);
const on = leaks.reduce((s, l) => s + l.on, 0), off = leaks.reduce((s, l) => s + l.off, 0);
expect("the mask lands on the body: under 2% of its pixels off the body over 16 random views", on > 1000 && off / on < 0.02, `${off}/${on}`);

expect("no runtime errors", runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(" | "));
ws.close();
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log("light facts browser contract: ok");
