#!/usr/bin/env node
// Browser QA for a character whose skeleton is not the X Bot. The test builds a .glb from the repo's own X Bot bind
// (src/motion3/rigs/x-bot-tpose.json): every bone renamed to its Unreal Engine 5 name (templates/ue5.json), the
// figure rescaled to 1.1, Z-up centimetres under an armature node that turns it Y-up and scales it 0.01, and each bone
// in an axis convention of its own; a box skinned to each bone gives it a body. The file goes through the Add menu's
// "Import character" file input, the path a user's file takes. Then:
//   - the Rig panel shows the adapter's report (detected ue5, missing bones, floor) and offers a template;
//   - a standIdle + walkTo compiled on the character plays on the file's own bones: at 3 frames the pelvis is within
//     1 cm of the take's hips and both feet and both hands within 2 cm of the compiled joints (fk of the take on the
//     adapted rig, at the take's placement);
//   - after a reload (the autosaved project) the character and its take come back and play the same bones;
//   - an X Bot character compiled and played the same way still puts its Mixamo bones on the compiled joints;
//   - IK refuses it with a sentence of its own and the Pose tab poses the X Bot instead; Manage storage does not list its file as unused;
//   - a project whose imported entries are malformed (a report without Hips, a rig without landmarks) opens and
//     reloads without the crash screen, and the X Bot beside them still compiles.
//
// QA_URL=http://127.0.0.1:5180/app/ npm run qa:browser -- node test/qa-imported-character-browser.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fk } from "../src/motion3/compiler/skeleton.js";
import { buildUe5Glb } from "./fixtures/ue5-character-glb.mjs";
import { add, apply, ry } from "../src/motion3/compiler/math.js";
import { ensureRig } from "../src/motion3/rigs/posted.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(tmpdir(), "cozyclay-imported-character");
await mkdir(out, { recursive: true });

// --- CDP ------------------------------------------------------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map(), pageErrors = [];
ws.onmessage = event => {
	const m = JSON.parse(event.data);
	if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
	if (!m.id || !pending.has(m.id)) return;
	const item = pending.get(m.id); pending.delete(m.id);
	if (m.error) item.reject(new Error(JSON.stringify(m.error))); else item.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expression, ms = 60_000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return true; await sleep(250); }
	return false;
};
await send("Runtime.enable");
await send("Page.enable");

const ready = "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclayProject?.export && document.querySelector('.app'))";
// a cold dev server bundles its dependencies first and reloads the page once
assert.ok(await waitFor(ready, 180_000), "Studio never exposed its QA hooks");
// stable: the same document for 8 s (a dev server that re-bundled reloads it)
for (let tries = 0; tries < 10; tries++) {
	await evaluate("window.__qaStable = true");
	await sleep(8000);
	if (await evaluate("window.__qaStable === true").catch(() => false)) break;
	assert.ok(await waitFor(ready, 180_000), "Studio never came back after a reload");
}
const characters = async () => {
	let doc = await evaluate("window.__cozyclayProject.export('imported-character')");
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = node => { if (!node || typeof node !== "object") return null; if (Array.isArray(node.characters) && node.characters[0]?.model) return node.characters;
		for (const v of Object.values(node)) { const hit = find(v); if (hit) return hit; } return null; };
	return find(doc) ?? [];
};
// the mounted AppContext's command bus, as a UI action runs (origin "ui"): a refusal answers its code and message
const busOf = "(() => { const el = document.querySelector('.app'); let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber'))]; while (f && !f.memoizedProps?.value?.bus) f = f.return; return f.memoizedProps.value.bus; })()";
const act = (id, args) => evaluate(`(async () => { try { const r = await ${busOf}.run(${JSON.stringify(id)}, ${JSON.stringify(args)}, { origin: "ui" }); return { ok: Boolean(r?.ok), message: r?.message ?? null }; } catch (e) { return { ok: false, code: e.code ?? null, message: e.message }; } })()`);
const select = id => act("view.select", { selection: { kind: "character", id } });
/** motion.compile once the character's rig is on stage; a job overtaken by a late write to the character is run again. */
async function compileOn(c, rigBone) {
	assert.ok(await waitFor(`Boolean(window.__cozyclay.rigA?.getObjectByName?.(${JSON.stringify(rigBone)}))`, 60_000), `${c.id}'s rig never became the active rig`);
	await sleep(1500);
	let r = null;
	for (let tries = 0; tries < 3; tries++) {
		r = await act("motion.compile", { characterId: c.id, spec: walkSpec(c), install: true });
		if (r?.ok || !/changed while/.test(r?.message ?? "")) break;
		await sleep(1000);
	}
	assert.ok(r?.ok, `motion.compile refused on ${c.id}: ${JSON.stringify(r)}`);
}
const hasTake = rig => `window.__cozyclay.motion?.schema === 'cozyclay.take.v3' && window.__cozyclay.motion.rig === ${JSON.stringify(rig)}`;
const SPEC = "cozyclay.motion-spec.v1";
const walkSpec = c => ({ schema: SPEC, fps: 24, frames: 150, use: [{ skill: "standIdle", f0: 0, args: { at: [c.x ?? 0, c.z ?? 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [(c.x ?? 0) + 0.5, (c.z ?? 0) + 1.5] } }] });

/** The visible take's arrays (the active character's). */
const takeNow = () => evaluate(`(() => { const m = window.__cozyclay.motion; return { rig: m.rig, bones: m.bones, frameCount: m.frameCount, placement: m.placement, rot: Array.from(m.rot), hips: Array.from(m.hips) }; })()`);
/** World positions (m) the compiled take puts joints at: fk on rig `sk` at the take's placement. */
function compiled(sk, take, f, joints) {
	const B = take.bones.length, quats = sk.names.map(n => { const b = take.bones.indexOf(n), i = (f * B + b) * 4; return b < 0 ? [0, 0, 0, 1] : take.rot.slice(i, i + 4); });
	const s = fk(sk, quats, take.hips.slice(f * 3, f * 3 + 3)), R = ry(take.placement?.yaw ?? 0), at = take.placement?.position ?? [0, 0, 0];
	return Object.fromEntries(joints.map(n => [n, add(at, apply(R, s.P[sk.index[n]]))]));
}
/** World positions (m) of the rendered rig's bones named `names` at frame f. */
async function rendered(f, names) {
	await evaluate(`window.__cozyclay.setFrame(${f})`);
	await waitFor(`window.__cozyclay.tlFrame === ${f}`, 5000);
	await sleep(200);
	return evaluate(`(() => { const rig = window.__cozyclay.rigA, out = {}; rig.updateMatrixWorld(true);
		for (const name of ${JSON.stringify(names)}) { let hit = null; rig.traverse(o => { if (!hit && o.name === name) hit = o; }); out[name] = hit ? hit.getWorldPosition(rig.position.clone()).toArray() : null; }
		return out; })()`);
}
const cm = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100 : Infinity);
const LIMBS = ["LeftFoot", "RightFoot", "LeftHand", "RightHand"];

/** Plays the visible take at 3 frames: the worst pelvis-to-hips and limb-to-joint distances (cm). */
async function check(sk, take, sourceOf, label) {
	const frames = [0, Math.round(take.frameCount / 2), take.frameCount - 1], worst = { hips: 0, limbs: 0 }, R = ry(take.placement?.yaw ?? 0), at = take.placement?.position ?? [0, 0, 0];
	for (const f of frames) {
		const want = compiled(sk, take, f, LIMBS), got = await rendered(f, ["Hips", ...LIMBS].map(sourceOf)), hips = add(at, apply(R, take.hips.slice(f * 3, f * 3 + 3)));
		const dh = cm(got[sourceOf("Hips")], hips), dl = Math.max(...LIMBS.map(n => cm(got[sourceOf(n)], want[n])));
		console.log(`${label} f${f}: pelvis at [${got[sourceOf("Hips")].map(v => v.toFixed(3))}] m, ${(dh * 10).toFixed(4)} mm off the take's hips; worst foot/hand ${(dl * 10).toFixed(4)} mm off its joint`);
		worst.path = [...(worst.path ?? []), got[sourceOf("Hips")]];
		worst.hips = Math.max(worst.hips, dh); worst.limbs = Math.max(worst.limbs, dl);
	}
	// not a standing check: the walk carries the pelvis
	worst.travel = cm(worst.path[0], worst.path[worst.path.length - 1]);
	assert.ok(worst.travel > 50, `${label}: the pelvis travelled only ${worst.travel.toFixed(1)} cm`);
	delete worst.path;
	return worst;
}

// --- 1. an X Bot plays as before ------------------------------------------------------------------------------------
// a QA session opens on an empty stage: cast an X Bot as an agent would
assert.ok((await act("character.add", { character: { id: "qa-xbot", model: "x-bot-tpose", x: -1, z: 0, rot: 0, subject: "a person" } }))?.ok, "character.add refused the X Bot");
const xbot = (await characters()).find(c => c.id === "qa-xbot");
assert.ok(xbot, "the X Bot is not in the cast");
assert.ok((await select(xbot.id))?.ok, "could not select the built-in character");
await compileOn(xbot, "mixamorigHips");
assert.ok(await waitFor(`${hasTake(xbot.model)} && Boolean(window.__cozyclay.rigA?.getObjectByName?.("mixamorigHips"))`, 60_000), "the built-in character's take never became visible on its rig");
const xTake = await takeNow(), xWorst = await check(skeletonFor(xbot.model), xTake, n => `mixamorig${n}`, xbot.model);
assert.ok(xWorst.hips < 1 && xWorst.limbs < 2, `the ${xbot.model} no longer plays its take on its bones (${JSON.stringify(xWorst)})`);

// --- 2. import the ue5 file through the Add menu --------------------------------------------------------------------
const { bytes, names } = buildUe5Glb(), file = join(out, "ue5-xbot.glb");
await writeFile(file, bytes);
console.log(`built ${file}: ${bytes.length} bytes, ${Object.keys(names).length} named bones`);
await evaluate("document.querySelector('[data-testid=viewport-add]').click()");
assert.ok(await waitFor("Boolean(document.querySelector('input[data-import-character]'))", 10_000), "the Add menu has no Import character entry");
const input = await send("Runtime.evaluate", { expression: "document.querySelector('input[data-import-character]')" });
await send("DOM.enable");
await send("DOM.setFileInputFiles", { files: [file], objectId: input.result.objectId });
assert.ok(await waitFor(`Promise.resolve(window.__cozyclayProject.export('x')).then(t => JSON.stringify(t).includes('rigImport'))`, 60_000), "the import never added a character");
const imported = (await characters()).find(c => c.rigImport);
assert.match(imported.model, /^rig-[0-9a-f]{16}-auto$/, "the imported character's model id");
console.log(`imported ${imported.id} as ${imported.model}: detected ${JSON.stringify(imported.rigImport.report.detected)}, missing ${imported.rigImport.report.missing.length}, grounded ${imported.rigImport.report.grounded}, units ${imported.rigImport.raw.units}`);
assert.equal(imported.rigImport.report.detected.id, "ue5", "the adapter should detect the ue5 names");

// --- 3. the Rig panel shows the report and a template choice --------------------------------------------------------
assert.ok((await select(imported.id))?.ok, "could not select the imported character");
const panel = await waitFor(`Boolean(document.querySelector('[data-rig-report=${JSON.stringify(imported.model)}] [data-rig-detected=ue5]') && document.querySelector('select[data-rig-template]'))`, 15_000);
const panelText = await evaluate("document.querySelector('[data-rig-report]')?.innerText ?? null");
console.log(`rig panel: ${JSON.stringify(panelText)}`);
assert.ok(panel, "the Rig panel does not show the adapter's report and template choice");

// --- 3b. Pose mode and IK refuse it; Manage storage keeps its file off the unused list ------------------------------
const ikKey = await act("character.setIkKey", { characterId: imported.id, frame: 0, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } });
console.log(`character.setIkKey on it: ${JSON.stringify(ikKey)}`);
assert.ok(!ikKey.ok && /^Imported characters/.test(ikKey.message ?? ""), "an IK key on the imported character is not refused");
// the Pose tab with it active poses the one posable character, the X Bot (pose-entry.js), never the imported one
const modeIs = mode => `document.querySelector('[data-mode=${JSON.stringify(mode)}]')?.getAttribute('aria-selected') === 'true'`;
await evaluate("document.querySelector('[data-mode=\"pose\"]').click()");
assert.ok(await waitFor(`${modeIs("pose")} && Boolean(window.__cozyclay.rigA?.getObjectByName?.("mixamorigHips"))`, 20_000), "the Pose tab did not pose the X Bot instead of the imported character");
await evaluate("document.querySelector('[data-mode=\"scene\"]').click()");
assert.ok(await waitFor(modeIs("scene"), 10_000) && (await select(imported.id))?.ok, "could not go back to the imported character in Scene mode");
await evaluate("document.querySelector('[data-testid=dock-tab-assets]')?.click()");
assert.ok(await waitFor("Boolean(document.querySelector('[data-testid=content-storage-toggle]'))", 10_000), "the dock's Assets tab has no Manage storage");
await evaluate("document.querySelector('[data-testid=content-storage-toggle]').click()");
// loaded: the list or its empty line (the file in neither list: nothing stored counts as unused)
assert.ok(await waitFor("Boolean(document.querySelector('.asset-storage-manager') && !document.querySelector('.asset-storage-manager [aria-busy=true]'))", 15_000), "Manage storage never finished loading");
await sleep(1500);
const unusedText = await evaluate("document.querySelector('.asset-storage-section.is-unused')?.innerText ?? document.querySelector('.asset-storage-manager').innerText");
console.log(`manage storage, unused: ${JSON.stringify(unusedText)}`);
assert.ok(!unusedText.includes("ue5-xbot"), "Manage storage lists the imported character's file as unused");
await evaluate("document.querySelector('[data-testid=content-storage-toggle]').click(); document.querySelector('[data-testid=dock-tab-animation]')?.click()");

// --- 4. a walk compiled on it plays on its own bones ----------------------------------------------------------------
const sourceOf = canonical => imported.rigImport.report.retarget[canonical].source;
assert.equal(sourceOf("Hips"), names.Hips, "Hips maps to the file's pelvis");
assert.ok(await waitFor(`Boolean(window.__cozyclay.rigA?.getObjectByName?.(${JSON.stringify(sourceOf("Hips"))}))`, 30_000), "the imported character's bones never appeared as the active rig");
await compileOn(imported, sourceOf("Hips"));
assert.ok(await waitFor(hasTake(imported.model), 60_000), "the imported character's take never became visible");
const sk = ensureRig(imported.model, imported.adaptedRig), take = await takeNow();
assert.equal(take.rig, imported.model);
const worst = await check(sk, take, sourceOf, "imported");
assert.ok(worst.hips < 1, `pelvis off the take's hips by ${worst.hips.toFixed(3)} cm`);
assert.ok(worst.limbs < 2, `a foot or hand off its compiled joint by ${worst.limbs.toFixed(3)} cm`);
const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(join(out, "imported-walk.png"), Buffer.from(shot.data, "base64"));

// --- 5. the autosaved project brings it back --------------------------------------------------------------------------
await sleep(2500);
await send("Page.reload");
await sleep(1000);
assert.ok(await waitFor(ready, 60_000), "the reloaded studio never exposed a rig");
assert.ok((await select(imported.id))?.ok, "could not select the imported character after the reload");
assert.ok(await waitFor(`${hasTake(imported.model)} && Boolean(window.__cozyclay.rigA?.getObjectByName?.(${JSON.stringify(sourceOf("Hips"))}))`, 60_000), "the reloaded project has no take on the imported character");
const reWorst = await check(sk, await takeNow(), sourceOf, "reloaded");
assert.ok(reWorst.hips < 1 && reWorst.limbs < 2, `the reloaded character does not play its take on its bones (${JSON.stringify(reWorst)})`);

// --- 6. forcing a naming convention adapts the file again, as a rig of its own ---------------------------------------
await evaluate(`(() => { const select = document.querySelector('select[data-rig-template]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(select, 'ue5'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const forcedModel = imported.model.replace(/-auto$/, "-ue5");
assert.ok(await waitFor(`Boolean(document.querySelector('[data-rig-report=${JSON.stringify(forcedModel)}]'))`, 30_000), "forcing ue5 did not re-adapt the character");
const forced = (await characters()).find(c => c.id === imported.id);
console.log(`forced: ${forced.model}, template ${forced.rigImport.template}; panel ${JSON.stringify(await evaluate("document.querySelector('[data-rig-detected]')?.innerText ?? null"))}`);
assert.equal(forced.rigImport.template, "ue5");
assert.ok(await waitFor(`!(${hasTake(imported.model)})`, 10_000), "the take compiled on the detected rig is still installed after forcing a template");

// --- 7. malformed imported entries in an opened project: no crash screen, the X Bot still compiles -------------------
let doc = await evaluate("window.__cozyclayProject.export('malformed')");
while (typeof doc === "string") doc = JSON.parse(doc);
const damage = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node.characters) && node.characters.some(c => c?.rigImport)) {
	const good = node.characters.find(c => c.rigImport), noLandmarks = structuredClone(good);
	delete good.rigImport.report.retarget.Hips;
	Object.assign(noLandmarks, { id: "qa-bad-landmarks", x: 2, model: good.model.replace(/-[a-z0-9]+$/, "-mixamo") });
	delete noLandmarks.adaptedRig.landmarks;
	node.characters.push(noLandmarks);
	return; } Object.values(node).forEach(damage); };
damage(doc);
const opened = await evaluate(`window.__cozyclayProject.open(${JSON.stringify(JSON.stringify(doc))}).then(r => r.ok)`);
assert.ok(opened, "the malformed project did not open");
await sleep(3000);
assert.ok(await evaluate("!document.querySelector('.crash-screen') && Boolean(document.querySelector('.app'))"), "a malformed imported entry crashed the studio");
const kept = await characters();
console.log(`malformed project: ${kept.map(c => `${c.id} ${c.model}${c.rigImport ? " (imported)" : ""}`).join(", ")}`);
assert.ok(kept.every(c => !c.rigImport), "a malformed imported entry was kept as an imported character");
assert.ok((await select(xbot.id))?.ok, "could not select the X Bot in the malformed project");
await compileOn(xbot, "mixamorigHips");
await sleep(2500);
await send("Page.reload");
await sleep(1000);
assert.ok(await waitFor(ready, 60_000), "the reloaded malformed project never came back");
await sleep(3000);
assert.ok(await evaluate("!document.querySelector('.crash-screen')"), "the reloaded malformed project crashed the studio");

assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(`PASS imported ue5 character plays on its own bones (hips ${worst.hips.toFixed(3)} cm, limbs ${worst.limbs.toFixed(3)} cm; reloaded ${reWorst.hips.toFixed(3)} / ${reWorst.limbs.toFixed(3)} cm); ${xbot.model} hips ${xWorst.hips.toFixed(3)} cm, limbs ${xWorst.limbs.toFixed(3)} cm; malformed project opened and reloaded without the crash screen; page errors 0; screenshot ${out}/imported-walk.png`);
ws.close();
