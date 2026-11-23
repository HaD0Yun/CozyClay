#!/usr/bin/env node
// Browser QA for the stage look (stage.lighting): apply the night recipe to a
// character with a box and a chair, then read the shot frame the export path
// renders (the frame capture_frame, contact sheets and video export draw) and
// the live viewport canvas. Night must be dark with a blue-black sky; one undo
// must give back the studio frame pixel for pixel. Evidence script; not in the
// manifest. Run:
//   QA_URL=http://127.0.0.1:<vite>/app/ CDP_PORT=<cdp> node tools/qa-browser.mjs -- node test/qa-stage-lighting-browser.mjs
// With COZYCLAY_LIVE_PORT set it also asks verify_result for checks ["lighting"].
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(150);
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// The shot frame through the export path, summarised in the page: mean Rec.709
// luma (0..1), the top-centre (zenith side) and the horizon-row colour, and a
// hash so two frames can be compared pixel for pixel.
const shotFrame = `(async () => {
	const { dataUrl } = window.__cozyclay.captureWithReferences();
	const image = new Image(); image.src = dataUrl; await image.decode();
	const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
	const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
	const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
	let sum = 0, hash = 2166136261;
	for (let i = 0; i < data.length; i += 4) { sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619) >>> 0; }
	const at = (x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
	return { meanLuma: sum / (width * height) / 255, top: at(Math.round(width * 0.1), 4), hash, width, height };
})()`;
const sceneRoot = `(() => { let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent; return node; })()`;
// The live viewport canvas (preserveDrawingBuffer), sampled near its top-left: the editor camera's sky.
const viewportSky = `(() => { const canvas = document.querySelector("#stage canvas"); const probe = document.createElement("canvas"); probe.width = canvas.width; probe.height = canvas.height;
	const context = probe.getContext("2d"); context.drawImage(canvas, 0, 0); return Array.from(context.getImageData(Math.round(canvas.width * 0.3), Math.round(canvas.height * 0.08), 1, 1).data.slice(0, 3)); })()`;

expect("the studio is ready", await waitFor("!!window.__cozyclay?.runStudioAction && !!window.__cozyclay?.rigA", 60000));
await sleep(1200);
await evaluate(`(() => { const c = window.__cozyclay; c.runStudioAction("object.add", { kind: "cylinder", placement: { x: 0.85, z: -0.35, rot: -30 } }); c.runStudioAction("object.add", { kind: "cube", placement: { x: -0.75, z: -0.5 } }); return true; })()`);
await sleep(800);
const studio = await evaluate(shotFrame);
// the default look since the toon finish is on by default and the key light is 0.9 (stage-finish-view.jsx,
// stage-lighting.js DEFAULT_KEY_LIGHT): a mean luma near 0.28, against 0.3 and more before
expect("the studio frame is the bright workbench", studio.meanLuma > 0.25, JSON.stringify(studio));

const receipt = await evaluate(`(() => { const r = window.__cozyclay.runStudioAction("stage.applyLighting", { preset: "night" }); return { ok: r?.ok, status: r?.status, entries: r?.undo?.entries, receiptId: r?.receiptId }; })()`);
expect("stage.applyLighting night is one undoable receipt", receipt.ok === true && receipt.status === "applied" && receipt.entries === 1, JSON.stringify(receipt));
expect("the scene takes the night fog colour", await waitFor(`${sceneRoot}.fog?.color.getHexString() === "0b1426"`, 8000));
const scene = await evaluate(`(() => { const s = ${sceneRoot}; let key; s.traverse((o) => { if (o.isDirectionalLight && o.castShadow) key = o; });
	// The background is chosen per camera as each render starts: ask for the shot camera's and the plan's.
	const sky = (camera) => { s.onBeforeRender(null, s, camera); return s.background?.isTexture ? "gradient" : s.background?.getHexString(); };
	return { fog: [s.fog.near, s.fog.far], shotSky: sky(window.__cozyclay.shotCam), planSky: sky(window.__cozyclay.planCam), key: key && { color: key.color.getHexString(), intensity: key.intensity, radius: key.shadow.radius } }; })()`);
// night's haze 0.45 pulls a sky look's 55..95 m horizon in evenly (stage-lighting.js hazeRange): 2 + 53 x 0.55, 14 + 81 x 0.55
expect("the haze pulls the fog in", Math.abs(scene.fog[0] - 31.15) < 0.01 && Math.abs(scene.fog[1] - 58.55) < 0.01, JSON.stringify(scene.fog));
expect("perspective views draw the gradient sky; the plan keeps the flat horizon colour", scene.shotSky === "gradient" && scene.planSky === "0b1426", `${scene.shotSky} / ${scene.planSky}`);
expect("the key is the dim cool moon with a soft shadow", scene.key?.color === "9db6e6" && scene.key.intensity < 0.7 && scene.key.radius > 4, JSON.stringify(scene.key));
await sleep(500);

const night = await evaluate(shotFrame);
expect("the night shot frame is dark", night.meanLuma < 0.2 && night.meanLuma < studio.meanLuma * 0.35, `night ${night.meanLuma.toFixed(3)} studio ${studio.meanLuma.toFixed(3)}`);
const [r, g, b] = night.top;
expect("the exported sky is blue-black", b > r && b >= g && Math.max(r, g, b) < 40, JSON.stringify(night.top));
const sky = await evaluate(viewportSky);
expect("the viewport sky is blue-black too", sky[2] > sky[0] && Math.max(...sky) < 60, JSON.stringify(sky));

const livePort = process.env.COZYCLAY_LIVE_PORT;
if (livePort) {
	const cli = fileURLToPath(new URL("../bin/cozyclay.mjs", import.meta.url));
	const verified = JSON.parse(execFileSync(process.execPath, [cli, "live", "verify", "--targets", "char-a", "--checks", "lighting", "--live-port", livePort], { encoding: "utf8" }));
	const lighting = verified.checks?.lighting;
	console.log(`verify_result lighting (night): ${JSON.stringify(lighting)}`);
	expect("verify_result measures the night frame", lighting?.meanLuma < 0.2 && lighting.subjects?.[0]?.id === "char-a" && lighting.subjects[0].meanLuma > lighting.meanLuma, JSON.stringify(lighting));
}

const undone = await evaluate(`window.__cozyclay.runStudioAction("edit.undo", { receiptId: ${JSON.stringify(receipt.receiptId)} })?.status ?? null`);
expect("one undo takes the whole look back", undone === "undone", String(undone));
expect("the fog is the studio grey again", await waitFor(`${sceneRoot}.fog?.near === 18 && ${sceneRoot}.fog?.far === 54 && !${sceneRoot}.background?.isTexture`, 8000));
await sleep(500);
const back = await evaluate(shotFrame);
expect("after undo the studio frame is pixel-identical", back.hash === studio.hash && back.meanLuma === studio.meanLuma, `${back.hash} vs ${studio.hash}`);

ws.close();
if (failures) {
	console.log(`qa-stage-lighting: ${failures} failure(s)`);
	process.exit(1);
}
console.log("qa-stage-lighting: all checks passed");
