#!/usr/bin/env node
// Browser check in the Studio of the cube look (COZYCLAY_FIGURE=cube): a character at scale 1 is the 1.70 m body; a
// scene stored by an earlier build (a cube figure of world size 0.81 with a lowvis take of that size, a cup on its hand, a
// tracked box) opens at the same world size and playing as before (the same picture while the look's head is the same); the writer's scene and spec go with the take (reload, undo,
// duplicate, the describe answer the sidecar reads); a scale change is refit without a model (bin/agent/motion-refit.mjs).
// Two stages, one per build of the page at the same address:
//   QA_STAGE=before on the build before the change: installs the stored scene's motion as that build did, and writes
//     the scene document, the drawn bones and props and a picture per frame to QA_OUT
//   QA_STAGE=after on this build: opens that document and measures the same frames against them, then the rest
// Run: `COZYCLAY_FIGURE=cube COZYCLAY_LIVE_PORT=5395 node tools/dev-full.mjs --host 127.0.0.1 --port 5195` in one shell, then
// `QA_STAGE=after QA_OUT=<dir> QA_URL=http://127.0.0.1:5195/app/ CDP_PORT=9342 COZYCLAY_LIVE_PORT=5395 node tools/qa-browser.mjs -- node test/lowvis/qa-size-body-browser.mjs`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { lookBody } from "../../src/lowvis/studio/figure.js";
import { keptTakes } from "../../bin/agent/motion-kept.mjs";

const STAGE = process.env.QA_STAGE, OUT = process.env.QA_OUT, cdpPort = Number(process.env.CDP_PORT || 9342), livePort = process.env.COZYCLAY_LIVE_PORT;
assert.ok(STAGE === "before" || STAGE === "after", "QA_STAGE is before or after");
assert.ok(OUT && livePort, "QA_OUT and COZYCLAY_LIVE_PORT are given");
mkdirSync(OUT, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.includes("/app/")) ?? targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = event => { const m = JSON.parse(event.data); const p = m.id && pending.get(m.id); if (!p) return; pending.delete(m.id); p(m); };
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
	if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r?.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (label, expression, ms = 60000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(`Boolean(${expression})`).catch(() => false)) return; await sleep(250); } throw new Error(`timed out: ${label}`); };
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); if (r?.ok !== true) throw new Error(${JSON.stringify(id)} + ": " + (r?.code ?? "") + " " + (r?.message ?? "refused")); return { affectedIds: r.affectedIds }; })()`);
const describe = () => JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", "describe", "--live-port", livePort], { encoding: "utf8", maxBuffer: 1 << 28 }));
const KEY = "cozyclay.scenes.v5", FRAMES = [0, 30, 60, 90, 119], ID = "lowvis-a";
await send("Runtime.enable");
await send("Page.enable");
const ready = async () => { await sleep(1500); await waitFor("the Studio QA hook", "window.__cozyclay?.runStudioAction"); };
const install = (clip, options) => evaluate(`(async () => {
	const { installClip } = await import("/src/lowvis/studio/install.js");
	const run = async (id, args) => { const r = await window.__cozyclay.runStudioAction(id, args); return r?.ok === true ? r : null; };
	return installClip(${JSON.stringify(clip)}, run, ${JSON.stringify(options)});
})()`);

/** On each frame: the 17 joints' bones of the character, the props' drawn places (world), and a picture of the view. */
async function look(tag, frames = FRAMES, id = ID) {
	await evaluate("window.__cozyclay.pause()");
	await act("selection.set", { ids: [] }).catch(() => null);
	const out = [];
	for (const f of frames) {
		const state = await evaluate(`(async () => {
			const qa = window.__cozyclay; qa.scrub(${f});
			for (let i = 0; i < 240 && window.__cozyclay.tlFrame !== ${f}; i++) await new Promise(r => requestAnimationFrame(r));
			for (let i = 0; i < 6; i++) await new Promise(r => requestAnimationFrame(r));
			const { jointBones } = await import("/src/lowvis/studio/skin-pose.js");
			const rig = qa.rigs[${JSON.stringify(id)}]; let root = rig; while (root.parent) root = root.parent;
			root.updateMatrixWorld(true);
			const bones = jointBones(rig).map(b => b.getWorldPosition(new (b.position.constructor)()).toArray());
			const props = {}; root.traverse(n => { const o = n.userData?.sceneObjectId; if (typeof o === "string" && !n.userData.ghost && !(o in props)) props[o] = n.getWorldPosition(new (n.position.constructor)()).toArray(); });
			let skin = null; root.traverse(n => { if (!skin && n.userData?.characterPick === ${JSON.stringify(id)}) skin = n; });
			let mesh = null; skin?.traverse(n => { if (!mesh && n.isMesh) mesh = n; });
			if (mesh && !mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
			const box = mesh ? new (mesh.geometry.boundingBox.constructor)().setFromObject(skin) : null; // three's Box3, from the page's own three
			const canvas = document.elementFromPoint(innerWidth * 0.45, innerHeight * 0.4), r = canvas.getBoundingClientRect(); // the stage view
			return { frame: window.__cozyclay.tlFrame, bones, props, skinTop: box?.max.y ?? null, skinBottom: box?.min.y ?? null, rect: [r.x, r.y, r.width, r.height] };
		})()`);
		const [x, y, width, height] = state.rect, shot = await send("Page.captureScreenshot", { format: "png", clip: { x, y, width, height, scale: 1 } });
		writeFileSync(join(OUT, `${tag}-f${f}.png`), Buffer.from(shot.result.data, "base64"));
		out.push(state);
	}
	return out;
}
/** Pixels that differ between two pictures of this run's folder (decoded by the page). */
const differ = (a, b) => evaluate(`(async () => {
	const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = "data:image/png;base64," + src; });
	const [x, y] = await Promise.all([load(${JSON.stringify(readFileSync(join(OUT, a)).toString("base64"))}), load(${JSON.stringify(readFileSync(join(OUT, b)).toString("base64"))})]);
	const px = img => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
	if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] };
	const p = px(x), q = px(y); let n = 0; for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) n++;
	return { differ: n, of: p.length / 4 };
})()`);
const mm = (a, b) => Math.hypot(...a.map((v, k) => v - b[k])) * 1000;
/** The page's look body (figure.js lookBody: 1 in a build before it) and the cube look's head (cube.js CUBE_SHAPE.head). */
const pageBody = () => evaluate(`import("/src/lowvis/studio/figure.js").then(m => m.lookBody?.() ?? 1)`);
const head = () => evaluate(`import("/src/lowvis/looks/cube.js").then(m => m.CUBE_SHAPE?.head ?? null)`);
/** Opens a stored scene document as a fresh page load does. */
async function openStored(document) {
	await evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(document)}); location.reload()`);
	await ready();
	await waitFor("the rig", `window.__cozyclay.rigs?.[${JSON.stringify(ID)}]?.parent && window.__cozyclay.frameCount >= ${F}`);
	await sleep(1000);
}

// the stored scene's motion: a body of the cube's old start size 0.81 holds a cup the whole clip (attached to its hand)
// and takes a box in the other hand later (a track); built at that size, as the engine of before built it
const OLD = 0.81, F = 120;
const scene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0, scale: OLD }], props: [{ id: "cup", size: [0.08, 0.1, 0.08], at: [-0.2, 0.7, 0.3], moves: true }, { id: "box", size: [0.15, 0.15, 0.15], at: [0.25, 0.65, 1.5], moves: true }] };
const spec = { demo: "qa", a: [[0, "hold", { prop: "cup", hand: "R" }], [10, "walk", { to: [0, 1.2] }], [55, "hold", { prop: "box", hand: "L", over: 15 }], [80, "pose", { L: [0.2, 0.3, 0.3], over: 15 }]] };
const clip = JSON.parse(serializeClip(buildClip(structuredClone(spec), scene).clip));

await evaluate("location.reload()");
await ready();
if (STAGE === "before") {
	const old = await evaluate("window.__cozyclay.objects.map(o => o.id)");
	if (old.length) await act("object.remove", { ids: old });
	for (const c of await evaluate("window.__cozyclay.characters.map(c => c.id)")) await act("character.remove", { characterId: c });
	const body = await pageBody(), out = await install(clip, { label: "qa size", body });
	assert.equal(out.ok, true, "the clip installs");
	await waitFor("the rig", `window.__cozyclay.rigs?.[${JSON.stringify(ID)}]?.parent && window.__cozyclay.frameCount >= ${F}`);
	const scale = await evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(ID)}).scale`);
	assert.ok(Math.abs(scale * body - OLD) < 1e-6, `the build of before stores the body's size as the scale over its look's body (${scale} x ${body})`);
	await sleep(1500);
	// the stored document, opened fresh as the after stage opens it
	const document = await evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`);
	await openStored(document);
	const drawn = await look("before");
	writeFileSync(join(OUT, "before.json"), JSON.stringify({ document, drawn, placed: out.placed, body, scale, head: await head() }));
	console.log(`before: stored; skin ${drawn[0].skinBottom.toFixed(3)} to ${drawn[0].skinTop.toFixed(3)} m at f0`);
	process.exit(0);
}

// --- after: the stored scene opens as before ---
const before = JSON.parse(readFileSync(join(OUT, "before.json"), "utf8"));
await openStored(before.document);
const report = {};
{
	const row = await evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(ID)})`), body = await pageBody(), sameHead = JSON.stringify(await head()) === JSON.stringify(before.head);
	assert.ok(Math.abs(row.scale * body - before.scale * before.body) < 1e-9, `carried over: the cube figure stands as large as it was stored (scale ${row.scale} x ${body})`);
	report.scale = { before: [before.scale, before.body], after: [row.scale, body], head: [before.head, await head()] };
	const drawn = await look("after");
	report.carried = drawn.map((d, k) => {
		const was = before.drawn[k], bone = Math.max(...d.bones.map((p, j) => mm(p, was.bones[j])));
		const prop = Math.max(...Object.keys(was.props).filter(id => d.props[id]).map(id => mm(d.props[id], was.props[id])));
		return { frame: d.frame, bone, prop, top: [was.skinTop, d.skinTop] };
	});
	for (const [k, r] of report.carried.entries()) {
		assert.ok(r.bone < 1 && r.prop < 1, `f${r.frame}: the bones and the props stand where they stood (${r.bone.toFixed(3)} mm, ${r.prop.toFixed(3)} mm)`);
		r.pixels = await differ(`before-f${FRAMES[k]}.png`, `after-f${FRAMES[k]}.png`);
	}
	console.log(`carried over: ${report.carried.map(r => `f${r.frame} bones ${r.bone.toFixed(3)} mm, props ${r.prop.toFixed(3)} mm, ${r.pixels.differ} of ${r.pixels.of} px differ`).join("; ")}`);
	// the look's head is the look's shape, not the scene's: a build with another head draws it (a meant difference)
	if (sameHead) for (const r of report.carried) assert.equal(r.pixels.differ, 0, `f${r.frame}: the same pixels`);
	else console.log(`the look's head ${JSON.stringify(report.scale.head[0])} -> ${JSON.stringify(report.scale.head[1])}: the pixels differ there; skin top ${report.carried.map(r => `${r.top[0].toFixed(3)} -> ${r.top[1].toFixed(3)}`).join(", ")} m`);
	await sleep(1500);
	const saved = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`)), stage = saved.scenes.find(s => s.id === saved.activeSceneId).stage;
	assert.equal(stage.figureBody, lookBody("cube"), "the saved stage names the body its scales are of");
	assert.equal(stage.characters.find(c => c.id === ID).scale, row.scale);
	const read = describe();
	assert.deepEqual(keptTakes(read), { kept: {}, bare: [ID] }, "an old take keeps no spec: the sidecar tells the agent so");
	report.saved = { figureBody: stage.figureBody };
}

// --- a new character at scale 1 is the 1.70 m body ---
{
	const had = await evaluate("window.__cozyclay.characters.map(c => c.id)"), added = (await act("character.add", { character: { x: 2, z: 0 } })).affectedIds;
	const id = added.find(a => !had.includes(a)); // the receipt names the cast it touched, the new one among them
	await waitFor("its rig", `window.__cozyclay.rigs?.[${JSON.stringify(id)}]?.parent`);
	const row = await evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(id)})`);
	assert.equal(row.scale, 1, "a new figure starts at scale 1");
	const [d] = await look("new", [0], id);
	report.newFigure = { top: d.skinTop, bottom: d.skinBottom };
	// with no take it stands in the rig's T-pose, which the cube look draws 6 mm over its 1.70 m with the arms down (verify-look-body)
	assert.ok(Math.abs(d.skinTop - d.skinBottom - 1.706) < 0.005, `in the T-pose it is 1.706 m tall (${(d.skinTop - d.skinBottom).toFixed(3)} m)`);
	console.log(`new figure at scale 1: ${(d.skinTop - d.skinBottom).toFixed(3)} m in the T-pose`);
	// the scale knob of its gizmo reads and writes the character's scale: a small pull outwards makes it a little larger
	await act("view.select", { selection: { kind: "character", id } });
	const key = (type, code, k) => send("Input.dispatchKeyEvent", { type, code, key: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
	await key("keyDown", "KeyR", "r"); await key("keyUp", "KeyR", "r");
	await sleep(800);
	const knobs = await evaluate(`(async () => {
		const { HANDLE_PROXY_FLAG } = await import("/src/gizmo-claim.js"), qa = window.__cozyclay;
		let root = qa.rigs[${JSON.stringify(id)}]; while (root.parent) root = root.parent; root.updateMatrixWorld(true);
		const r = document.elementFromPoint(innerWidth * 0.45, innerHeight * 0.4).getBoundingClientRect(), out = [];
		root.traverse(n => { if (n.isMesh && n.userData?.[HANDLE_PROXY_FLAG]) { const at = n.getWorldPosition(new (n.position.constructor)()).project(qa.activeCam); out.push([r.x + (at.x + 1) / 2 * r.width, r.y + (1 - at.y) / 2 * r.height]); } });
		return out;
	})()`);
	assert.ok(knobs.length > 0, "the scale gizmo is shown");
	const scaleNow = () => evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(id)}).scale`);
	for (const [x, y] of knobs) {
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		for (let k = 1; k <= 3; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + k, y: y - k, button: "left" });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 3, y: y - 3, button: "left", clickCount: 1 });
		await sleep(400);
		if (await scaleNow() !== 1) break;
	}
	report.knob = await scaleNow();
	assert.ok(report.knob > 1 && report.knob <= 1.2, `a 3 px pull of the scale knob: scale 1 -> ${report.knob}`);
	await key("keyDown", "KeyW", "w"); await key("keyUp", "KeyW", "w");
	await act("character.remove", { characterId: id });
	console.log(`scale knob: a 3 px pull takes scale 1 to ${report.knob}`);
}

// --- the spec kept with the take: install, reload, undo, duplicate, the describe answer ---
const studio = () => studioScene(describe(), { turn: true, kinds: true, body: true, tops: false });
const writerScene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] };
const motionOf = (spec2, name) => ({ clip: JSON.parse(serializeClip(buildClip(structuredClone({ demo: "qa", ...spec2 }), { ...writerScene, characters: [{ ...writerScene.characters[0], scale: lookBody("cube") }] }).clip)), source: { name, scene: writerScene, spec: spec2 } });
{
	const one = motionOf({ a: [[10, "walk", { to: [0, 1] }]] }, "agent-20261123-000001-aaaa"), two = motionOf({ a: [[10, "walk", { to: [1, 1] }]] }, "agent-20261123-000002-bbbb");
	const keptNow = () => keptTakes(describe()).kept[ID]?.name ?? null;
	let s = studio();
	assert.equal((await install(one.clip, { existing: s.ids, turn: true, label: "qa one", body: lookBody("cube"), source: one.source })).ok, true);
	assert.equal(keptNow(), one.source.name, "the describe answer holds the spec of the take that plays");
	assert.deepEqual(keptTakes(describe()).kept[ID].spec, one.source.spec);
	assert.equal(await evaluate(`window.__cozyclay.characters.find(c => c.id === ${JSON.stringify(ID)}).scale`), 1, "a clip of the cube's scale 1 sets no scale");
	await sleep(1500);
	await evaluate("location.reload()");
	await ready();
	await waitFor("the rig", `window.__cozyclay.rigs?.[${JSON.stringify(ID)}]?.parent`);
	assert.equal(keptNow(), one.source.name, "after a reload");
	s = studio();
	assert.equal((await install(two.clip, { existing: s.ids, turn: true, label: "qa two", body: lookBody("cube"), source: two.source })).ok, true);
	assert.equal(keptNow(), two.source.name);
	await act("edit.undo", {});
	assert.equal(keptNow(), one.source.name, "an undo of the install brings back the spec of the take that plays again");
	const from = describe().document.activeSceneId;
	await act("scene.duplicate", { sceneId: from });
	await ready();
	await waitFor("the duplicate open", `window.__cozyclay.rigs?.[${JSON.stringify(ID)}]?.parent`);
	const to = describe().document.activeSceneId;
	assert.notEqual(to, from, "the duplicate is the open scene");
	assert.equal(keptNow(), one.source.name, "a duplicate of the scene keeps it");
	report.kept = { from, to };
	console.log("spec kept with the take: install, reload, undo, duplicate: the describe answer holds the spec of the take that plays");
}

// --- a scale change is refit with no model ---
{
	await act("character.update", { characterId: ID, patch: { scale: 0.9 } });
	const { refitMotion } = await import("../../bin/agent/motion-refit.mjs");
	const out = await refitMotion({ hub: { command: async () => describe() }, workspaceHandle: null, invoke: (action, args) => act(action, args), env: { COZYCLAY_FIGURE: "cube" } });
	assert.equal(out.refit.length, 1, JSON.stringify(out));
	const kept = keptTakes(describe()).kept[ID];
	assert.equal(kept.scene.characters[0].scale, 0.9, "the kept scene has the new scale");
	await waitFor("the take", `window.__cozyclay.frameCount >= ${F}`);
	const clip2 = JSON.parse(readFileSync(`public/lowvis/clips/pi/${out.refit[0].name}.json`, "utf8")), pos = (f, j) => clip2.characters[0].pos.slice((f * 17 + j) * 3, (f * 17 + j) * 3 + 3);
	const drawn = await look("refit", [0, 60, 110]);
	const off = drawn.map(d => Math.max(...d.bones.map((p, j) => mm(p, pos(d.frame, j)))));
	report.refit = { rows: out.refit[0].rows, off };
	for (const [k, v] of off.entries()) assert.ok(v < 1, `f${drawn[k].frame}: the drawn bones are the refit clip's (${v.toFixed(3)} mm)`);
	console.log(`refit at 0.9: rows ${JSON.stringify(out.refit[0].rows)}; drawn bones against the clip ${off.map(v => v.toFixed(3)).join(", ")} mm`);
}
writeFileSync(join(OUT, "after.json"), JSON.stringify(report, null, "\t"));
console.log("PASS qa-size-body-browser");
process.exit(0);
