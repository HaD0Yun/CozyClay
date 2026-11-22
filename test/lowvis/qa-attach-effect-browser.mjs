#!/usr/bin/env node
// Browser check in the Studio: a figure with an installed lowvis clip carries effect emitters on its bones. Two effects
// are made in the Studio (a smoke and an exhale), offered to the clip as point props (scene.js kinds), and a clip built
// here rides the smoke on a held cigarette's tip and the exhale on the head; installClip (the Studio's own action runner)
// attaches the cigarette and both effects to their bones (object.attach with their place in the bone's frame). Then, on
// several frames, inspect_studio's effect.emitter (the point the particles are born at) is read and measured against the
// drawn bone (its attach frame times the attached place) and against the engine's own prop pose, and particles are alive
// next to it; with the playhead on one frame, the emitter the effects use for other frames (where a particle born then
// starts, src/effects/attach-history.js) is where the bone was drawn on those frames; again after a timing edit of the take, a scale change of the character, a duplicate, and a reload; and a
// shot capture (the export's render) draws the exhale's particles at the mouth.
//
// Run: `COZYCLAY_LIVE_PORT=5397 node tools/dev-full.mjs --host 127.0.0.1 --port 5197` in one shell, then
// `QA_URL=http://127.0.0.1:5197/app/ CDP_PORT=9344 COZYCLAY_LIVE_PORT=5397 node tools/qa-browser.mjs -- node test/lowvis/qa-attach-effect-browser.mjs`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";

const cdpPort = Number(process.env.CDP_PORT || 9344), livePort = process.env.COZYCLAY_LIVE_PORT;
assert.ok(livePort, "COZYCLAY_LIVE_PORT names the live hub (inspect_studio)");
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.includes("/app/")) ?? targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map(), pageErrors = [];
ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); const p = m.id && pending.get(m.id); if (!p) return; pending.delete(m.id); p(m); };
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
	if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r?.result?.value;
};
const waitFor = async (label, expression, ms = 60000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(`Boolean(${expression})`).catch(() => false)) return; await new Promise(r => setTimeout(r, 250)); } throw new Error(`timed out: ${label}`); };
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); if (r?.ok !== true) throw new Error(${JSON.stringify(id)} + ": " + (r?.code ?? "") + " " + (r?.message ?? "refused")); return { affectedIds: r.affectedIds }; })()`);
const cli = (...args) => JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", ...args, "--live-port", livePort], { encoding: "utf8" }));
await send("Runtime.enable");
// a fresh load, so a module the check imports (/src/effects/state.js) is the instance the page runs
await evaluate("location.reload()");
await new Promise(r => setTimeout(r, 1500));
await waitFor("the Studio QA hook", "window.__cozyclay?.runStudioAction");

// 1. a clean set with two effects: a smoke and an exhale tilted to blow forward
const old = await evaluate("window.__cozyclay.objects.map(o => o.id)");
if (old.length) await act("object.remove", { ids: old });
for (const id of await evaluate("window.__cozyclay.characters.filter(c => /^lowvis-/.test(c.id)).map(c => c.id)")) await act("character.remove", { characterId: id });
const smoke = (await act("object.add", { kind: "effect", name: "Tip smoke", placement: { x: 0.3, z: 0.3 } })).affectedIds[0];
const exhale = (await act("object.add", { kind: "effect", name: "Exhale", placement: { x: 0, z: 0.1 } })).affectedIds[0];
await act("object.set", { id: exhale, set: { effect: { preset: "exhale" } } });
await act("object.update", { id: exhale, patch: { y: 1.6, rotX: 70 } });
await act("object.update", { id: smoke, patch: { y: 1 } });

// 2. the clip, written over the Studio's own scene as the motion writer would get it
const describe = { characters: [], objects: await evaluate("window.__cozyclay.objects") };
const { scene: studio, ids } = studioScene(describe, { turn: true, kinds: true });
assert.deepEqual(studio.props.map(p => p.kind), ["effect smoke", "effect exhale"], "the effects are offered with their kind");
// QA_SCALE: the body's scale (0.81 is the cube look's start size: open the page with ?figure=cube for that look)
const S = Number(process.env.QA_SCALE || 1), F = 96;
const scene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0, ...(S === 1 ? {} : { scale: S }) }], props: [...studio.props.map(p => ({ ...p, moves: true })), { id: "cig", size: [0.0078, 0.0078, 0.084], at: [0.2 * S, 0.85 * S, 0.25 * S], moves: true }] };
const spec = { demo: "qa", a: [[0, "hold", { prop: "cig", hand: "R" }], [12, "walk", { to: [0, 1.5] }], [60, "pose", { R: [0.1, 0.45, 0.35], over: 18 }]],
	Tip_smoke: [[0, "ride", { on: "cig", at: [0, 0, 0.042] }]], Exhale: [[0, "ride", { joint: "Head", of: "a", at: [0, -0.06, 0.11] }]] };
const clip = JSON.parse(serializeClip(buildClip(structuredClone(spec), scene).clip));
const out = await evaluate(`(async () => {
	const { installClip } = await import("/src/lowvis/studio/install.js");
	const run = async (id, args) => { const r = await window.__cozyclay.runStudioAction(id, args); return r?.ok === true ? r : null; };
	return installClip(${JSON.stringify(clip)}, run, { existing: ${JSON.stringify(ids)}, turn: true, label: "qa attach" });
})()`);
assert.equal(out.ok, true, "the clip installs");
const bones = Object.fromEntries(out.attached.map(a => [a.id, a.bone]));
assert.deepEqual([bones[smoke], bones[exhale], bones[out.placed.cig]], ["rightHand", "head", "rightHand"], "the effects and the held cigarette ride their bones");
assert.equal(out.moving, undefined, "nothing is moved by a track");
await waitFor("the rig", "window.__cozyclay.rigs?.['lowvis-a']?.parent && window.__cozyclay.frameCount >= " + F);
await evaluate("window.__cozyclay.pause()");

// where the drawn bone puts an attached object: its attach frame (place and turn, unscaled) times the record's numbers
const MIXAMO = { head: "Head", rightHand: "RightHand" };
async function expected(id, frame) {
	return evaluate(`(async () => {
		const qa = window.__cozyclay; qa.scrub(${frame});
		for (let i = 0; i < 240 && qa.tlFrame !== ${frame}; i++) await new Promise(r => requestAnimationFrame(r));
		for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
		const o = qa.objects.find(x => x.id === ${JSON.stringify(id)}), name = ${JSON.stringify(MIXAMO)}[o.attach.bone];
		let bone = null; qa.rigs[o.attach.characterId].traverse(n => { if (!bone && n.isBone && n.name.endsWith(name)) bone = n; });
		bone.updateWorldMatrix(true, false);
		const e = bone.matrixWorld.elements, col = k => { const v = [e[k], e[k + 1], e[k + 2]], l = Math.hypot(...v); return v.map(x => x / l); };
		const [c0, c1, c2] = [col(0), col(4), col(8)];
		return { frame: qa.tlFrame, at: [0, 1, 2].map(k => e[12 + k] + c0[k] * o.x + c1[k] * o.y + c2[k] * o.z), local: [o.x, o.y, o.z, o.rotX, o.rot, o.rotZ], attach: o.attach };
	})()`);
}
const emitterAt = id => cli("inspect", "--scope", "entities", "--ids", id).entities[0].effect;
const mm = (a, b) => Math.hypot(...a.map((v, k) => v - b[k])) * 1000;
const enginePoint = (prop, f) => [0, 1, 2].map(k => clip.props.find(p => p.id === prop).pos[f * 3 + k]);
const FRAMES = [0, 24, 48, 72, 95];
async function measure(label, frames = FRAMES, withEngine = true) {
	const rows = [];
	for (const f of frames) for (const [id, prop] of [[smoke, "Tip_smoke"], [exhale, "Exhale"]]) {
		const want = await expected(id, f), effect = emitterAt(id);
		assert.equal(effect.frame, f, `${label}: inspect reads frame ${f}`);
		const row = { label, f, id, toBone: mm(effect.emitter, want.at), ...(withEngine ? { toEngine: mm(effect.emitter, enginePoint(prop, f)) } : {}), alive: effect.alive, bounds: effect.bounds };
		rows.push(row);
		assert.ok(row.toBone < 2, `${label} f${f}: ${prop}'s particles are born at the drawn bone's point (${row.toBone.toFixed(2)} mm off)`);
		if (f > 0) {
			assert.ok(effect.alive > 0, `${label} f${f}: ${prop} has live particles (${effect.alive})`);
			const nearest = [0, 1, 2].map(k => Math.min(Math.max(effect.emitter[k], effect.bounds.min[k]), effect.bounds.max[k]));
			// the newest particles were born up to a frame ago on the line the emitter swept (simulate.js), so within its travel of one frame
			row.reach = mm(nearest, effect.emitter);
			assert.ok(row.reach < 100, `${label} f${f}: ${prop}'s particles reach back to the emitter (${row.reach.toFixed(1)} mm)`);
		}
	}
	console.log(`${label}: ${rows.map(r => `${r.id} f${r.f} ${r.toBone.toFixed(2)} mm from the bone point${r.toEngine === undefined ? "" : `, ${r.toEngine.toFixed(1)} mm from the engine's`}, ${r.alive} alive`).join("; ")}`);
	return rows;
}
// a particle is born where its emitter was at its birth frame: with the playhead on `at`, the emitter the effects
// evaluate for each other frame (effect-state at that frame, attach-history.js) against the bone as drawn on that frame
async function history(label, at, frames) {
	const drawn = {};
	for (const f of frames) for (const id of [smoke, exhale]) drawn[`${id}@${f}`] = (await expected(id, f)).at;
	await expected(smoke, at);
	const read = await evaluate(`(async () => { const { effectStateAt } = await import("/src/effects/state.js"); return ${JSON.stringify(frames)}.flatMap(f => [${JSON.stringify(smoke)}, ${JSON.stringify(exhale)}].map(id => ({ id, f, emitter: effectStateAt(id, f).emitter }))); })()`);
	const rows = read.map(r => ({ ...r, off: mm(r.emitter, drawn[`${r.id}@${r.f}`]) }));
	console.log(`${label} (playhead at ${at}): ${rows.map(r => `${r.id} f${r.f} ${r.off.toFixed(2)} mm`).join("; ")}`);
	for (const r of rows) assert.ok(r.off < 2, `${label}: with the playhead at ${at}, ${r.id} at frame ${r.f} is where the bone was drawn then (${r.off.toFixed(2)} mm)`);
	return rows;
}
const report = {};
try {
	report.installed = await measure("installed");
	report.history = await history("birth places", 0, [10, 30, 60, 90]);
	// 3. a timing edit of the take: the emitters stay on the drawn bones (the engine's frame no longer matches the timeline)
	const receipt = await evaluate(`window.__cozyclay.runStudioAction("motion.setSegmentSpeed", { characterId: "lowvis-a", segmentId: "motion-0", speed: 2 })`);
	assert.equal(receipt?.ok, true, "the take's speed is set");
	report.timing = await measure("timing edit", [0, 12, 30, 46], false);
	report.timingHistory = await history("birth places, timing edit", 46, [6, 20, 40]);
	await act("motion.resetTiming", { characterId: "lowvis-a" });
	// 4. a scale change of the character
	await act("character.update", { characterId: "lowvis-a", patch: { scale: 0.85 } });
	report.scale = await measure("scale 0.85", [0, 48, 95], false);
	report.scaleHistory = await history("birth places, scale 0.85", 95, [20, 70]);
	await act("character.update", { characterId: "lowvis-a", patch: { scale: S } });
	// 5. a duplicate keeps the attachment, and its place on the bone but for the duplicate's own step aside along x
	const copy = (await act("object.duplicate", { objectId: exhale })).affectedIds.find(id => id !== exhale);
	const [a, b] = [await expected(exhale, 48), await expected(copy, 48)];
	assert.deepEqual(b.attach, a.attach, "the duplicate rides the same bone");
	assert.deepEqual(b.local.slice(1), a.local.slice(1), "at the same height, depth and turn on it");
	report.duplicateStep = +(b.local[0] - a.local[0]).toFixed(3);
	await act("object.remove", { ids: [copy] });
	// 6. a reload: the scene comes back with the attachments and their numbers
	const before = await evaluate(`window.__cozyclay.objects.filter(o => o.attach).map(o => ({ id: o.id, attach: o.attach, at: [o.x, o.y, o.z, o.rotX, o.rot, o.rotZ] }))`);
	await new Promise(r => setTimeout(r, 1500)); // the autosave
	await evaluate("location.reload()");
	await new Promise(r => setTimeout(r, 1500));
	await waitFor("the Studio after the reload", "window.__cozyclay?.runStudioAction && window.__cozyclay.rigs?.['lowvis-a']?.parent");
	const after = await evaluate(`window.__cozyclay.objects.filter(o => o.attach).map(o => ({ id: o.id, attach: o.attach, at: [o.x, o.y, o.z, o.rotX, o.rot, o.rotZ] }))`);
	assert.deepEqual(after, before, "after a reload the attached objects ride the same bones at the same numbers");
	await evaluate("window.__cozyclay.pause()");
	report.reloaded = await measure("reloaded", [0, 48]);
	// 7. the shot render the export draws: the exhale's particles show at the mouth (a capture against one with it hidden)
	const pixels = await evaluate(`(async () => {
		const qa = window.__cozyclay, framing = { pos: { x: -1.2, y: 1.6, z: 1.6 }, yaw: -0.9, pitch: -0.05, fovDeg: 40 };
		const shot = async () => { qa.scrub(48); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))); return qa.captureFraming(framing); };
		const shown = await shot();
		await qa.runStudioAction("object.update", { id: ${JSON.stringify(exhale)}, patch: { hidden: true } });
		const hidden = await shot();
		await qa.runStudioAction("object.update", { id: ${JSON.stringify(exhale)}, patch: { hidden: false } });
		const read = async url => { const i = new Image(); i.src = url; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
		const [p, q] = await Promise.all([read(shown), read(hidden)]);
		let n = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) >= 9) n++;
		return n;
	})()`);
	report.capturePixels = pixels;
	assert.ok(pixels > 300, `the shot capture draws the exhale's particles (${pixels} pixels differ with it hidden)`);
	const worst = rows => Math.max(...rows.map(r => r.toBone ?? r.off));
	console.log(JSON.stringify({ worstToBone: Object.fromEntries(Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, +worst(v).toFixed(2)])),
		toEngine: report.installed.map(r => [r.id, r.f, +r.toEngine.toFixed(1)]), capturePixels: pixels }));
	assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
	console.log("PASS qa-attach-effect-browser");
} finally {
	ws.close();
}
