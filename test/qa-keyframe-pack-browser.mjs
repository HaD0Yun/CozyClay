#!/usr/bin/env node
// Browser QA for the reference exports (#165). Drives the real studio over
// CDP: builds a keyframe pack through the production path, writes the zip to
// disk and hands it to the system `unzip` — if the archive this ships is not
// one a normal tool can open, the check fails. Then takes the depth and normal
// passes and proves each is a DIFFERENT image from the RGB plate, which is the
// only thing that separates a working material override from a silent no-op.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const out = process.env.QA_OUT || "/tmp/keyframe-pack-qa";
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
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 180_000 });
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

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");

// A one-second authored shot with a real camera move: short enough that the
// WebCodecs clip encodes quickly, long enough that first.png and last.png are
// different pictures.
await evaluate(`(() => {
	const shot = {
		id: "pack-qa-shot",
		name: "Pack QA push in",
		startFrame: 0,
		endFrame: 23,
		cameraKeys: [
			{ id: "pack-qa-key-a", frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: -0.08, fovDeg: 45 } },
			{ id: "pack-qa-key-b", frame: 23, framing: { pos: { x: 1.2, y: 1.5, z: 2.2 }, yaw: -0.35, pitch: -0.12, fovDeg: 34 } },
		],
		camera: { mode: "keys" },
	};
	const document = {
		version: 4,
		activeSceneId: "scene-pack-qa",
		scenes: [{
			id: "scene-pack-qa",
			name: "PACK QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 24, shots: [shot], waypoints: [] },
			stage: {
				characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
				hasCharSheet: false,
				shotAspect: "16:9",
			},
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(document));
})()`);
await send("Page.reload");
expect("the studio and its export hooks come up", await waitFor("!!window.__cozyclay?.rigA && typeof window.__cozyclay?.exportKeyframePack === 'function' && typeof window.__cozyclay?.renderPass === 'function' && !!window.__captureFrame", 60_000));

/* --- the keyframe pack ---------------------------------------------------- */

const pack = await evaluate("window.__cozyclay.exportKeyframePack()");
expect("the pack is named after the shot", /^cozyclay-shot-1-[a-z0-9-]+\.zip$/.test(pack?.name ?? ""), String(pack?.name));
const zipPath = `${out}/pack.zip`;
writeFileSync(zipPath, Buffer.from(pack.bytes, "base64"));
expect("the pack has bytes on disk", Buffer.from(pack.bytes, "base64").byteLength === pack.byteLength && pack.byteLength > 1000, `byteLength=${pack.byteLength}`);

const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
console.log(`unzip -l ${zipPath}\n${listing}`);
writeFileSync(`${out}/unzip-l.txt`, listing);
const listed = (name) => new RegExp(`/${name.replace(".", "\\.")}$`, "m").test(listing);
expect("the archive lists first.png", listed("first.png"));
expect("the archive lists last.png", listed("last.png"));
expect("the archive lists a clip", listed("clip.mp4") || listed("clip.webm"), listing);
expect("the archive lists camera.json", listed("camera.json"));
expect("the archive lists prompt.txt", listed("prompt.txt"));
expect(
	"the reported entry names match the archive",
	["first.png", "last.png", "camera.json", "prompt.txt"].every((name) => pack.entries.some((entry) => entry.endsWith(`/${name}`))),
	pack.entries.join(", "),
);

const cameraEntry = pack.entries.find((entry) => entry.endsWith("/camera.json"));
const cameraJson = execFileSync("unzip", ["-p", zipPath, cameraEntry], { encoding: "utf8" });
writeFileSync(`${out}/camera.json`, cameraJson);
let camera = null;
try { camera = JSON.parse(cameraJson); } catch (error) { expect("camera.json parses", false, error.message); }
expect("camera.json parses with a numeric focalMm", Number.isFinite(camera?.focalMm), JSON.stringify({ focalMm: camera?.focalMm }));
expect("camera.json carries the frame range and fps", camera?.startFrame === 0 && camera?.endFrame === 23 && camera?.fps > 0, JSON.stringify({ startFrame: camera?.startFrame, endFrame: camera?.endFrame, fps: camera?.fps }));
expect(
	"camera.json carries the framing at both ends of the shot",
	Number.isFinite(camera?.framing?.start?.pos?.z) && Number.isFinite(camera?.framing?.end?.fovDeg) && camera.framing.start.pos.z !== camera.framing.end.pos.z,
	JSON.stringify(camera?.framing),
);

const promptEntry = pack.entries.find((entry) => entry.endsWith("/prompt.txt"));
const promptText = execFileSync("unzip", ["-p", zipPath, promptEntry], { encoding: "utf8" });
writeFileSync(`${out}/prompt.txt`, promptText);
expect("prompt.txt is a labelled video prompt", /^SHOT: /m.test(promptText) && /^LENS: /m.test(promptText) && /^MOTION: /m.test(promptText), promptText.slice(0, 120));

/* --- the depth and normal passes ------------------------------------------ */

// The RGB reference is the shipped framing capture: the same rig and the same
// framing with no override in place.
const rgbPlate = await evaluate("window.__cozyclay.capturePlate()");
const passes = {
	depth: await evaluate('window.__cozyclay.renderPass("depth")'),
	normal: await evaluate('window.__cozyclay.renderPass("normal")'),
};
expect("the RGB plate renders a PNG", typeof rgbPlate === "string" && rgbPlate.startsWith("data:image/png;base64,"), String(rgbPlate).slice(0, 40));
writeFileSync(`${out}/blocking-frame-rgb.png`, Buffer.from(rgbPlate.split(",")[1], "base64"));
for (const [kind, dataUrl] of Object.entries(passes)) {
	expect(`the ${kind} pass renders a PNG`, typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,"), String(dataUrl).slice(0, 40));
	if (typeof dataUrl === "string") writeFileSync(`${out}/blocking-frame-${kind}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
}
expect("the depth and normal passes are different images", passes.depth !== passes.normal);
expect("the depth pass differs from the RGB capture", passes.depth !== rgbPlate);
expect("the normal pass differs from the RGB capture", passes.normal !== rgbPlate);
expect("the studio still renders in colour after the passes", await waitFor("(() => { const f = window.__captureFrame(); return f && f.pixels > 0; })()", 10_000));

/* --- the depth plate keeps the stage's detail ------------------------------ */

// The plate's greys are made from the pass's own precision (src/depth-plate.js), so the deck and the figure take many
// of the 256 greys; and rain, which has no surface, is in the plate: before, a pass that swapped materials drew none.
const plateStats = () => evaluate(`(async () => {
	const image = new Image();
	image.src = window.__cozyclay.renderPass("depth");
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = image.width; canvas.height = image.height;
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0);
	const data = context.getImageData(0, 0, canvas.width, canvas.height).data, greys = new Set();
	let sum = 0;
	for (let i = 0; i < data.length; i += 4) { greys.add(data[i]); sum += data[i]; }
	return { greys: greys.size, sum };
})()`);
const act = (id, args) => evaluate(`Promise.resolve(window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)})).then((r) => ({ ok: r?.ok === true, ids: r?.affectedIds ?? [], message: r?.message ?? null }))`);
// The dry and the wet plate are taken at one frame, so the rain is the only thing between them (the shot's camera
// moves with the frame), and the dry plate is taken twice: a plate that differed from itself would prove nothing.
const until = async (holds, timeoutMs = 10_000) => { for (const deadline = Date.now() + timeoutMs; ;) { const stats = await plateStats(); if (holds(stats) || Date.now() >= deadline) return stats; } };
await evaluate("Promise.resolve(window.__cozyclay.setFrame(40))");
expect("the studio draws the frame the plates are taken at", await waitFor("(() => { const f = window.__captureFrame(); return f && f.pixels > 0; })()", 10_000));
await plateStats();
const dry = await plateStats(), again = await plateStats();
expect("the depth plate uses more than a hundred greys", dry.greys > 100, JSON.stringify(dry));
expect("one frame gives one depth plate", again.sum === dry.sum, JSON.stringify({ dry, again }));
const rain = await act("object.add", { kind: "effect", name: "QA rain", placement: { x: 0, z: 0 } });
expect("an effect is added for the depth check", rain.ok, JSON.stringify(rain));
expect("the effect is rain over the stage", (await act("object.set", { id: rain.ids[0], set: { effect: { preset: "rain", area: { x: 12, y: 6, z: 12 } } } })).ok);
const wet = await until((stats) => stats.sum !== dry.sum);
expect("rain is in the depth plate", wet.sum !== dry.sum, JSON.stringify({ dry, wet }));
expect("the effect is taken out again", (await act("object.remove", { ids: rain.ids })).ok);
const dried = await until((stats) => stats.sum === dry.sum);
expect("without the rain the plate is the dry plate again", dried.sum === dry.sum, JSON.stringify({ dry, dried }));

expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log(`PASS keyframe pack + render passes — ${pack.entries.length} entries in ${pack.name}, evidence in ${out}`);
