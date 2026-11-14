#!/usr/bin/env node
// Browser QA for onion-skin ghosts (src/view-ghosts.jsx, src/ghost-set.js, view.setGhosts): in the
// real editor the bat swing (the kit bat on the swing fixture's spec) and a squatting smoker
// (cigarette and lighter kits, smokeCigarette) show translucent ghosts in the viewport, blue
// before and orange after the playhead, the bat ghosting with the body; the shot frame an export
// renders (captureFraming) and capture_frame are pixel for pixel the same with ghosts on; the View
// menu's Ghosts group switches them; a click on a ghost picks nothing; frame time with 6 ghosts;
// with COZYCLAY_LIVE_PORT a views contact sheet with ghosts: true. Captures go to QA_OUT.
//
// Run: `COZYCLAY_LIVE_PORT=6084 node tools/dev-full.mjs --host 127.0.0.1 --port 5244` in one shell,
// then `QA_URL=http://127.0.0.1:5244/app/ CDP_PORT=9404 COZYCLAY_LIVE_PORT=6084 QA_OUT=<dir> node tools/qa-browser.mjs -- node test/qa-view-ghosts-browser.mjs`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SWING_SPEC, SWING_KEYS, SCENE_OBJECTS as BAT_SCENE, BAT } from "./motion3/fixtures/bat-swing.mjs";

const cdpPort = Number(process.env.CDP_PORT || 9222), out = process.env.QA_OUT || "/tmp/cozyclay-ghosts-qa", livePort = process.env.COZYCLAY_LIVE_PORT;
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/app/")) ?? targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map(), pageErrors = [];
ws.onmessage = (event) => {
	const m = JSON.parse(event.data);
	if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
	if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, expression, ms = 60000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return; await sleep(250); }
	throw new Error(`timed out waiting for ${label}`);
};
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await evaluate(`localStorage.setItem("cozyclay.theme.v1", "light"); location.reload()`);
await sleep(1500);
await waitFor("the studio QA hook", "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.captureFraming && window.__cozyclay.rigA)");

const act = (id, args) => evaluate(`(async () => { try {
	const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)});
	if (r?.ok !== true) throw Object.assign(new Error(r?.message ?? "Action returned no receipt."), { code: r?.code ?? "ACTION_REFUSED" });
	return r && { ok: r.ok, status: r.status, affectedIds: r.affectedIds, output: r.output ?? r.receipt?.output, summary: r.summary };
} catch (error) { throw new Error((error.code ?? "STUDIO_ACTION_FAILED") + ": " + (error.message ?? String(error))); } })()`);
const clear = async () => { const ids = await evaluate("window.__cozyclay.objects.map((o) => o.id)"); if (ids.length) assert.ok(await act("object.remove", { ids }), "clear the set"); };
const frames = (n = 2) => evaluate(`new Promise((r) => { let k = ${n}; const tick = () => (--k ? requestAnimationFrame(tick) : setTimeout(r, 60)); requestAnimationFrame(tick); })`);
const aim = (pos, at, fovDeg) => {
	const d = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]];
	return { pos: { x: pos[0], y: pos[1], z: pos[2] }, yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])), fovDeg };
};
const save = (name, url) => writeFile(`${out}/${name}.png`, Buffer.from(url.split(",")[1], "base64"));
const screenshot = async (name) => { const shot = await send("Page.captureScreenshot", { format: "png" }); await writeFile(`${out}/${name}.png`, Buffer.from(shot.result.data, "base64")); };
// The main pane of the live canvas (preserveDrawingBuffer): a hash, and the pixels a ghost colour tints.
const paneStats = (reference = null) => evaluate(`(() => {
	const canvas = document.querySelector("#stage canvas"), pane = window.__cozyclay.mainPane.getBoundingClientRect(), box = canvas.getBoundingClientRect();
	const sx = canvas.width / box.width, x0 = Math.round((pane.left - box.left) * sx), y0 = Math.round((pane.top - box.top) * sx), w = Math.round(pane.width * sx * 0.62), h = Math.round(pane.height * sx);
	const probe = document.createElement("canvas"); probe.width = w; probe.height = h;
	const g = probe.getContext("2d"); g.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
	const { data } = g.getImageData(0, 0, w, h);
	let hash = 2166136261, blue = 0, orange = 0, changed = 0;
	const ref = window.__ghostRef;
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i], gg = data[i + 1], b = data[i + 2];
		hash = Math.imul(hash ^ r ^ (gg << 8) ^ (b << 16), 16777619) >>> 0;
		if (ref) {
			const dr = r - ref[i], dg = gg - ref[i + 1], db = b - ref[i + 2];
			if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 24) { changed += 1; if (db > dr + 12) blue += 1; else if (dr > db + 12) orange += 1; }
		}
	}
	if (${reference === "keep"}) window.__ghostRef = data;
	return { hash, changed, blue, orange, size: [w, h] };
})()`);
const shotHash = (framing) => evaluate(`(async () => {
	const url = window.__cozyclay.captureFraming(${JSON.stringify(framing)});
	const image = new Image(); image.src = url; await image.decode();
	const c = document.createElement("canvas"); c.width = image.width; c.height = image.height; const g = c.getContext("2d"); g.drawImage(image, 0, 0);
	const { data } = g.getImageData(0, 0, c.width, c.height); let hash = 2166136261;
	for (let i = 0; i < data.length; i += 4) hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619) >>> 0;
	return { hash, url, mask: window.__captureCameraMask };
})()`);
const ghosts = () => evaluate(`(() => { const g = window.__cozyclayGhosts; if (!g) return null; return { inScene: !!g.set.object.parent, visible: g.set.slots.filter((s) => s.rig.visible).length,
	frames: g.entries.map((e) => e.f), props: g.set.slots.filter((s) => s.rig.visible).map((s) => s.records.filter((r) => r.group.visible).length), poseMs: g.set.stats.poseMs }; })()`);
const report = {};
const characterId = await evaluate("window.__cozyclay.charA?.id ?? 'char-a'");

// 1. The bat swing (the kits QA's swing: the fixture's spec and keys on the kit bat).
await clear();
const plate = BAT_SCENE.find((o) => o.id !== BAT);
const plateId = (await act("object.add", { kind: "cube", name: "Home Plate", placement: { x: plate.x, z: plate.z } })).affectedIds[0];
assert.ok(await act("object.update", { id: plateId, patch: { scaleX: plate.scaleX, scaleY: plate.scaleY, scaleZ: plate.scaleZ } }), "the plate");
const bat = (await act("object.createKit", { kit: "bat", position: { x: -0.4, z: 0.3 } })).output;
assert.ok(bat?.parts.body, `the bat kit: ${JSON.stringify(bat)}`);
const swingSpec = JSON.parse(JSON.stringify(SWING_SPEC).replaceAll(`"${BAT}"`, `"${bat.rootId}"`).replaceAll(`object:${BAT}`, `object:${bat.rootId}`));
swingSpec.objects = { [bat.rootId]: { ...bat.bind[bat.rootId], keys: SWING_KEYS } };
swingSpec.checks.allow = swingSpec.checks.allow.map((a) => ({ ...a, object: bat.rootId }));
const swing = (await act("motion.compile", { characterId, spec: swingSpec, install: true })).output;
assert.ok(swing?.installed, "the swing installs");
await act("view.select", { selection: { kind: "character", id: characterId } });
await evaluate(`window.__cozyclay.frameEditorCam({ x: -1.7, y: 2.1, z: 3.6 }, { x: 0.05, y: 0.95, z: 0.2 })`);
await evaluate("window.__cozyclay.scrub(47)");
await frames(4);
await paneStats("keep");
assert.equal((await ghosts())?.inScene ?? false, false, "off by default: nothing in the scene");
const on = await act("view.setGhosts", { mode: "step", count: 3, step: 4 });
assert.ok(on?.ok && on.status === "transient", `view.setGhosts is a transient action: ${JSON.stringify(on)}`);
await frames(4);
report.swingGhosts = await ghosts();
report.swingPane = await paneStats();
assert.deepEqual(report.swingGhosts.frames, [43, 51, 39, 55, 35, 59], `3 each side every 4 frames: ${JSON.stringify(report.swingGhosts)}`);
assert.equal(report.swingGhosts.visible, 6);
assert.ok(report.swingGhosts.props.every((n) => n >= 1), `the bat ghosts with the body: ${JSON.stringify(report.swingGhosts.props)}`);
assert.ok(report.swingPane.changed > 3000 && report.swingPane.blue > 500 && report.swingPane.orange > 500, `blue and orange ghosts in the viewport: ${JSON.stringify(report.swingPane)}`);
await screenshot("l4-bat-swing-ghosts");

// 2. Exports never carry them: the shot frame an export renders and capture_frame, ghosts on vs off.
const shotView = aim([1.6, 1.3, 2.6], [0.05, 1.1, 0.35], 46);
const exportOn = await shotHash(shotView);
await save("l4-export-frame-ghosts-on", exportOn.url);
await act("view.setGhosts", { mode: "off" });
await frames(3);
const exportOff = await shotHash(shotView);
report.export = { on: exportOn.hash, off: exportOff.hash, mask: exportOn.mask };
assert.equal(exportOn.hash, exportOff.hash, "the export frame is the same pixels with ghosts on and off");
assert.equal(exportOn.mask & (1 << 5), 0, "the export camera's mask leaves GIZMO_LAYER out");
assert.equal((await paneStats()).changed, 0, "off again: the viewport is back to the no-ghost pixels");
const cli = (...args) => execFileSync(process.execPath, [fileURLToPath(new URL("../bin/cozyclay.mjs", import.meta.url)), "live", ...args, "--live-port", livePort], { encoding: "utf8" });
if (livePort) {
	cli("capture", "--out", `${out}/l4-capture-frame-ghosts-off.png`);
	await act("view.setGhosts", { mode: "step", count: 3, step: 4 });
	await frames(3);
	cli("capture", "--out", `${out}/l4-capture-frame-ghosts-on.png`);
	const bytes = (name) => execFileSync("shasum", [`${out}/${name}.png`], { encoding: "utf8" }).split(" ")[0];
	report.captureFrame = { off: bytes("l4-capture-frame-ghosts-off"), on: bytes("l4-capture-frame-ghosts-on") };
	assert.equal(report.captureFrame.on, report.captureFrame.off, "capture_frame (the agent's frame) is byte for byte the same");
} else await act("view.setGhosts", { mode: "step", count: 3, step: 4 });

// 3. A click on a ghost picks what the same click picks with ghosts off: the farthest earlier bat
//    ghost's barrel, away from the body.
await frames(3);
const point = await evaluate(`(() => {
	const g = window.__cozyclayGhosts, slot = g.set.slots[g.entries.findIndex((e) => e.side === "before" && e.rank === 3)], mesh = slot.records.find((r) => r.group.visible)?.group.children[0];
	mesh.geometry.computeBoundingBox(); const tip = mesh.geometry.boundingBox.max.clone(); tip.x = 0; tip.z = 0; tip.y *= 0.85; tip.applyMatrix4(mesh.matrixWorld);
	const cam = window.__cozyclay.editorCam, p = tip.clone().project(cam), pane = window.__cozyclay.mainPane.getBoundingClientRect();
	return { x: pane.left + (p.x + 1) / 2 * pane.width, y: pane.top + (1 - p.y) / 2 * pane.height };
})()`);
const clickPick = async () => {
	await act("view.select", { selection: { kind: "camera", id: "camera" } });
	await frames(2);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	await frames(3);
	return evaluate(`document.querySelector("[role='treeitem'][aria-selected='true']")?.dataset.nodeId ?? null`);
};
report.pick = { at: point, ghostsOn: await clickPick() };
await act("view.setGhosts", { mode: "off" });
await frames(3);
report.pick.ghostsOff = await clickPick();
assert.equal(report.pick.ghostsOn, report.pick.ghostsOff, `a click on a ghost picks the same as with ghosts off: ${JSON.stringify(report.pick)}`);
assert.ok(![characterId, bat.rootId, ...Object.values(bat.parts)].some((id) => String(report.pick.ghostsOn).includes(id)), `neither the body nor the bat: ${JSON.stringify(report.pick)}`);
await act("view.setGhosts", { mode: "step", count: 3, step: 4 });
await act("view.select", { selection: { kind: "character", id: characterId } });
await frames(3);

// 4. The View menu's Ghosts group: key frames, one more each side, off.
await evaluate(`document.querySelector('[data-testid="view-menu-trigger"]').click()`);
await sleep(200);
await evaluate(`document.querySelector('[data-ghosts="keys"]').click()`);
await frames(3);
report.keys = await ghosts();
assert.deepEqual(report.keys.frames, [44, 53, 40, 57, 34, 62], `keys mode: the spec's key frames around 47: ${JSON.stringify(report.keys)}`);
await evaluate(`document.querySelector('[data-testid="ghost-count"] button[aria-label$="+"]').click()`);
await frames(3);
assert.equal((await ghosts()).frames.length, 8, "one more on each side");
await screenshot("l4-view-menu-ghosts-keys");
await evaluate(`document.querySelector('[data-ghosts="off"]').click()`);
await frames(3);
assert.equal((await ghosts()).inScene, false, "off from the menu");
await evaluate(`document.querySelector('[data-ghosts="step"]').click()`);
await evaluate(`document.querySelector('[data-testid="ghost-count"] button[aria-label$="−"]').click()`);
await evaluate(`document.querySelector('[data-testid="view-menu-trigger"]').click()`);
await frames(3);
assert.equal((await ghosts()).visible, 6, "back to 3 each side every 4 frames");

// 5. Frame time with 6 ghosts: synchronous full-canvas renders through the editor camera, and
//    the frame interval while the timeline plays.
const bench = (visible) => evaluate(`(() => {
	const { set, gl, scene } = window.__cozyclayGhosts, cam = window.__cozyclay.editorCam, ctx = gl.getContext(), px = new Uint8Array(4);
	set.object.visible = ${visible};
	const size = gl.getDrawingBufferSize(new cam.position.constructor()); gl.setScissorTest(false); gl.setViewport(0, 0, size.x / gl.getPixelRatio(), size.y / gl.getPixelRatio());
	for (let i = 0; i < 10; i++) { gl.render(scene, cam); ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px); }
	const times = [];
	for (let i = 0; i < 60; i++) { const t0 = performance.now(); gl.render(scene, cam); ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px); times.push(performance.now() - t0); }
	const calls = gl.info.render.calls; set.object.visible = true; times.sort((a, b) => a - b);
	return { meanMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), drawCalls: calls, size: [size.x, size.y] };
})()`);
const playback = () => evaluate(`new Promise((resolve) => {
	window.__cozyclay.runStudioAction("timeline.play", { playing: true });
	const deltas = []; let last = performance.now(), n = 0;
	const tick = (now) => { deltas.push(now - last); last = now; if (++n < 150) requestAnimationFrame(tick); else { window.__cozyclay.pause(); deltas.sort((a, b) => a - b);
		resolve({ meanMs: +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2), p95Ms: +deltas[Math.floor(deltas.length * 0.95)].toFixed(2), poseMs: window.__cozyclayGhosts.set.stats.poseMs }); } };
	requestAnimationFrame(tick);
})`);
report.perf = { renderOff: await bench(false), renderOn6: await bench(true) };
await act("view.setGhosts", { mode: "off" });
report.perf.playOff = await playback();
await act("view.setGhosts", { mode: "step", count: 3, step: 4 });
report.perf.playOn6 = await playback();
console.log(`frame time: ${JSON.stringify(report.perf)}`);

// 6. A views contact sheet with ghosts: true (verify_result through the live hub).
if (livePort) {
	const verify = (args) => {
		const inspected = JSON.parse(cli("cmd", "inspect_studio", "--args", JSON.stringify({ scope: "selection" })));
		const context = inspected.context ?? inspected;
		const envelope = { name: "verify_result", args, commandId: crypto.randomUUID(), host: Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map((k) => [k, context.host[k]])), expectedRevision: context.revision.scene };
		const value = JSON.parse(cli("cmd", "verify_result", "--args", JSON.stringify(envelope)));
		const ref = value.visualRefs?.[0];
		const image = JSON.parse(cli("cmd", "resolve_studio_image", "--args", JSON.stringify({ imageId: ref.imageId, ...(value.receiptId ? { receiptId: value.receiptId } : {}), revision: value.revision })));
		return { ref, image };
	};
	await act("view.setGhosts", { mode: "off" });
	const sheetArgs = { targets: [characterId], checks: ["motion"], visual: "contact_sheet", frames: [35, 41, 44, 47, 53, 62], views: ["front"], focus: `object:${bat.rootId}` };
	const plain = verify(sheetArgs), ghosted = verify({ ...sheetArgs, ghosts: true });
	await save("l4-contact-sheet-front", plain.image.dataUrl);
	await save("l4-contact-sheet-front-ghosts", ghosted.image.dataUrl);
	report.sheet = { ghosts: ghosted.ref.ghosts, plainBytes: plain.image.dataUrl.length, ghostBytes: ghosted.image.dataUrl.length };
	assert.deepEqual(ghosted.ref.ghosts, { mode: "step", count: 3, step: 4, before: "#4d9cff", after: "#ff8a3d" }, JSON.stringify(ghosted.ref));
	assert.notEqual(ghosted.image.dataUrl, plain.image.dataUrl, "the ghosts change the sheet");
	assert.equal((await ghosts())?.inScene ?? false, false, "the viewport stays off after the sheet");
}

// 7. The squatting smoker (the kits QA's smoke scene) at night, ghosts on.
await clear();
assert.ok(await act("stage.applyLighting", { preset: "night" }), "the night look");
const cig = (await act("object.createKit", { kit: "cigarette", position: { x: 0.45, z: 0.7 } })).output;
const lit = (await act("object.createKit", { kit: "lighter", position: { x: 0.6, z: 0.7 } })).output;
const SQUAT = { root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12, foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] };
const smoke = (await act("motion.compile", { characterId, spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", label: "squat and smoke", keys: [{ f: 0, set: SQUAT }],
	use: [{ skill: "smokeCigarette", f0: 1, args: { kit: { cig: cig.rootId, lighter: lit.rootId } } }] } })).output;
assert.ok(smoke?.installed, "the dressed squat installs");
await act("view.setGhosts", { mode: "step", count: 3, step: 4 });
await act("view.select", { selection: { kind: "character", id: characterId } });
await evaluate(`window.__cozyclay.frameEditorCam({ x: -2.1, y: 1.45, z: 2.5 }, { x: -0.05, y: 0.7, z: 0.2 })`);
// The frame whose ghosts spread the right hand furthest: the arm's busiest moment.
const spread = [];
for (let f = 20; f < 250; f += 10) {
	await evaluate(`window.__cozyclay.scrub(${f})`);
	await frames(2);
	spread.push(await evaluate(`(() => { const g = window.__cozyclayGhosts, hands = g.set.slots.filter((s) => s.rig.visible).map((s) => { let h = null; s.rig.traverse((n) => { if (!h && /RightHand$/.test(n.name)) h = n; }); return h.getWorldPosition(h.position.clone()); });
		let d = 0; for (const a of hands) for (const b of hands) d = Math.max(d, a.distanceTo(b)); return { f: ${f}, d: +d.toFixed(3) }; })()`));
}
const busiest = spread.reduce((a, b) => (b.d > a.d ? b : a));
report.smokeFrame = busiest;
await evaluate(`window.__cozyclay.scrub(${busiest.f})`);
await frames(5);
report.smoke = await ghosts();
assert.equal(report.smoke.visible, 6, JSON.stringify(report.smoke));
assert.ok(report.smoke.props.some((n) => n >= 1), `the cigarette or lighter ghosts with the hand: ${JSON.stringify(report.smoke.props)}`);
await screenshot("l4-squat-smoke-ghosts");
await act("view.setGhosts", { mode: "keys", count: 3 });
await frames(4);
report.smokeKeys = await ghosts();
await screenshot("l4-squat-smoke-ghosts-keys");
await act("view.setGhosts", { mode: "off" });

console.log(JSON.stringify(report, null, 1));
assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
console.log("qa-view-ghosts-browser: all checks PASS");
ws.close();
