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
//   - an X Bot character compiled and played the same way still puts its Mixamo bones on the compiled joints.
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

const ready = "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclayProject?.export)";
assert.ok(await waitFor(ready), "Studio never exposed its QA hooks");
const characters = async () => {
	let doc = await evaluate("window.__cozyclayProject.export('imported-character')");
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = node => { if (!node || typeof node !== "object") return null; if (Array.isArray(node.characters) && node.characters[0]?.model) return node.characters;
		for (const v of Object.values(node)) { const hit = find(v); if (hit) return hit; } return null; };
	return find(doc) ?? [];
};
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); return r && { ok: r.ok, error: r.error?.message ?? null }; })()`);
const select = id => act("view.select", { selection: { kind: "character", id } });
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
		console.log(`${label} f${f}: hips ${dh.toFixed(3)} cm, worst foot/hand ${dl.toFixed(3)} cm`);
		worst.hips = Math.max(worst.hips, dh); worst.limbs = Math.max(worst.limbs, dl);
	}
	return worst;
}

// --- 1. an X Bot plays as before ------------------------------------------------------------------------------------
// a QA session opens on an empty stage: cast an X Bot as an agent would
assert.ok((await act("character.add", { character: { id: "qa-xbot", model: "x-bot-tpose", x: -1, z: 0, rot: 0, subject: "a person" } }))?.ok, "character.add refused the X Bot");
const xbot = (await characters()).find(c => c.id === "qa-xbot");
assert.ok(xbot, "the X Bot is not in the cast");
assert.ok((await select(xbot.id))?.ok, "could not select the built-in character");
assert.ok((await act("motion.compile", { characterId: xbot.id, spec: walkSpec(xbot) }))?.ok, "motion.compile refused on the built-in character");
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

// --- 4. a walk compiled on it plays on its own bones ----------------------------------------------------------------
const sourceOf = canonical => imported.rigImport.report.retarget[canonical].source;
assert.equal(sourceOf("Hips"), names.Hips, "Hips maps to the file's pelvis");
assert.ok(await waitFor(`Boolean(window.__cozyclay.rigA?.getObjectByName?.(${JSON.stringify(sourceOf("Hips"))}))`, 30_000), "the imported character's bones never appeared as the active rig");
assert.ok((await act("motion.compile", { characterId: imported.id, spec: walkSpec(imported) }))?.ok, "motion.compile refused on the imported character");
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

assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(`PASS imported ue5 character plays on its own bones (hips ${worst.hips.toFixed(3)} cm, limbs ${worst.limbs.toFixed(3)} cm; reloaded ${reWorst.hips.toFixed(3)} / ${reWorst.limbs.toFixed(3)} cm); ${xbot.model} hips ${xWorst.hips.toFixed(3)} cm, limbs ${xWorst.limbs.toFixed(3)} cm; page errors 0; screenshot ${out}/imported-walk.png`);
ws.close();
