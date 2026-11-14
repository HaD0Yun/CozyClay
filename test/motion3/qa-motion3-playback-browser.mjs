#!/usr/bin/env node
// Browser QA for take v3 playback: compile a walk through the real Studio action, then check
// that the rendered rig's bones sit where motion.sample says, frame by frame, and save frames.
//
// QA_URL=http://127.0.0.1:5190/app/ npm run qa:browser -- node test/motion3/qa-motion3-playback-browser.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay3-playback";
await mkdir(out, { recursive: true });
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
	if (r.exceptionDetails) {
		const exception = r.exceptionDetails.exception;
		const details = exception?.objectId ? (await send("Runtime.callFunctionOn", {
			objectId: exception.objectId, returnByValue: true,
			functionDeclaration: "function(){return {name:this.name,message:this.message,code:this.code,details:this.details}}",
		})).result?.value : null;
		throw Object.assign(new Error(details?.message || exception?.description || r.exceptionDetails.text), details);
	}
	return r.result?.value;
};
const waitFor = async (expression, ms = 60_000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return true; await new Promise(r => setTimeout(r, 250)); }
	return false;
};
await send("Runtime.enable");

// A new project starts on an empty stage: cast the Y Bot these checks drive.
assert.ok(await waitFor("Boolean(window.__cozyclay?.runStudioAction)"), "Studio never exposed its actions");
await evaluate(`(async () => { if (!window.__cozyclay.characters?.length) await window.__cozyclay.runStudioAction("character.add", { character: { id: "char-a", model: "y-bot-tpose" } }); })()`);
assert.ok(await waitFor("Boolean(window.__cozyclay?.rigA && window.__cozyclay.runStudioAction)"), "Studio never exposed a rig");
// The first cast member of the open scene, read from the project export.
const first = await evaluate(`(async () => {
	let doc = await window.__cozyclayProject.export();
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = node => { if (!node || typeof node !== "object") return null; if (Array.isArray(node.characters) && node.characters[0]?.model) return node.characters[0];
		for (const v of Object.values(node)) { const hit = find(v); if (hit) return hit; } return null; };
	const c = find(doc); return c && { id: c.id, model: c.model };
})()`);
assert.ok(first, "no character in the open scene");
const charId = first.id;
const sk = skeletonFor(first.model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 150,
	keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], fyaw_l: 0, fyaw_r: 0, armw_r: 0 } }],
	generators: [{ type: "walk", f0: 6, steps: 5, heading: [0, 35] }] };
const receipt = await evaluate(`window.__cozyclay.runStudioAction('motion.compile', { characterId: ${JSON.stringify(charId)}, spec: ${JSON.stringify(spec)} })`);
console.log("compile receipt", JSON.stringify(receipt).slice(0, 400));
if (!receipt?.ok) console.error("motion.compile refusal", JSON.stringify(receipt));
assert.ok(receipt?.ok, "motion.compile was refused");
assert.ok(await waitFor("window.__cozyclay.motion?.schema === 'cozyclay.take.v3'", 20_000), "the take never became the visible motion");

const bones = ["Hips", "LeftFoot", "RightHand", "Head", "LeftHandIndex3"];
let worst = 0;
for (const f of [0, 40, 80, 120, 149]) {
	await evaluate(`window.__cozyclay.setFrame(${f})`);
	await waitFor(`window.__cozyclay.tlFrame === ${f}`, 5000);
	await new Promise(r => setTimeout(r, 150));
	const sampled = await evaluate(`(() => window.__cozyclay.runStudioAction('motion.sample', { characterId: ${JSON.stringify(charId)}, frames: [${f}], bones: ${JSON.stringify(bones)} }))()`);
	const outOf = r => r?.output ?? r?.receipt?.output ?? r?.result?.output ?? r?.value?.output;
	if (!outOf(sampled)) console.log('sample receipt keys', JSON.stringify(sampled).slice(0, 600));
	const want = outOf(sampled).frames[0].bones;
	const got = await evaluate(`(() => { const rig = window.__cozyclay.rigA, out = {}, v = rig.position.clone();
		for (const name of ${JSON.stringify(bones)}) { let hit = null; rig.traverse(o => { if (!hit && o.isBone && o.name.replace(/^mixamorig:?/, '') === name) hit = o; }); out[name] = hit ? hit.getWorldPosition(v.clone()).toArray() : null; }
		return out; })()`);
	for (const b of bones) {
		const e = Math.hypot(...want[b].map((x, i) => x - got[b][i]));
		worst = Math.max(worst, e);
		if (e > 0.01) console.log(`frame ${f} ${b}: rendered ${got[b].map(x => x.toFixed(3))} vs compiled ${want[b].map(x => x.toFixed(3))} (${(e * 100).toFixed(1)} cm)`);
	}
	const shot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/frame-${String(f).padStart(3, "0")}.png`, Buffer.from(shot.data, "base64"));
}
console.log(`rendered vs compiled bones: worst ${(worst * 100).toFixed(2)} cm; page errors ${pageErrors.length}`);
assert.ok(worst < 0.01, "rendered bones drift from the compiled take");
assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(`PASS take v3 plays on the live rig (screens in ${out})`);
ws.close();
