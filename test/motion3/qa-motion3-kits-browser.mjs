#!/usr/bin/env node
// Browser QA for kits (C15, docs/motion-api-v3.1.md): in the real editor, object.createKit makes the
// cigarette, the lighter and the bat, one motion.compile with smokeCigarette args.kit dresses a
// squatting smoker (the squat of session d51e2c8d keyed before f0), and the shot render
// (captureFraming, the picture capture_frame and contact sheets use) shows the props in the hand:
// the flame and its light while lighting, the ember glow and the tip smoke on a drag, the exhale
// puff; then the bat kit swings with its trail (the swing fixture's spec and keys, the kit root in
// place of the session's cylinder). Every check measures pixels against a capture with the part
// hidden. Captures go to QA_OUT.
//
// Run: `COZYCLAY_LIVE_PORT=6074 node tools/dev-full.mjs --host 127.0.0.1 --port 5234` in one shell,
// then `QA_URL=http://127.0.0.1:5234/app/ CDP_PORT=9384 QA_OUT=<dir> node tools/qa-browser.mjs -- node test/motion3/qa-motion3-kits-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SWING_SPEC, SWING_KEYS, SCENE_OBJECTS as BAT_SCENE, BAT } from "./fixtures/bat-swing.mjs";

const cdpPort = Number(process.env.CDP_PORT || 9222), out = process.env.QA_OUT || "/tmp/cozyclay-kits-qa";
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
const waitFor = async (label, expression, ms = 60000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return; await new Promise((r) => setTimeout(r, 250)); }
	throw new Error(`timed out waiting for ${label}`);
};
await send("Runtime.enable");
await evaluate(`localStorage.setItem("cozyclay.theme.v1", "light"); location.reload()`);
await new Promise((r) => setTimeout(r, 1500));
await waitFor("the studio QA hook", "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.captureFraming && window.__cozyclay.rigA)");

const act = (id, args) => evaluate(`(async () => { try {
	const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)});
	if (r?.ok !== true) throw Object.assign(new Error(r?.message ?? "Action returned no receipt."), { code: r?.code ?? "ACTION_REFUSED" });
	return r && { affectedIds: r.affectedIds, output: r.output ?? r.receipt?.output, summary: r.summary };
} catch (error) { throw new Error((error.code ?? "STUDIO_ACTION_FAILED") + ": " + (error.message ?? String(error))); } })()`);
const clear = async () => { const ids = await evaluate("window.__cozyclay.objects.map((o) => o.id)"); if (ids.length) assert.ok(await act("object.remove", { ids }), "clear the set"); };
const aim = (pos, at, fovDeg) => {
	const d = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]];
	return { pos: { x: pos[0], y: pos[1], z: pos[2] }, yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])), fovDeg };
};
const capture = (frame, framing) => evaluate(`(async () => {
	window.__cozyclay.scrub(${frame});
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))));
	return window.__cozyclay.captureFraming(${JSON.stringify(framing)});
})()`);
const save = (name, url) => writeFile(`${out}/${name}.png`, Buffer.from(url.split(",")[1], "base64"));
/** The pixels `ids` add to the shot at `frame` (a capture with them hidden is the reference), and their mean brightness. */
async function measure(ids, frame, framing, shown) {
	for (const id of ids) await act("object.update", { id, patch: { hidden: true } });
	const hidden = await capture(frame, framing);
	for (const id of ids) await act("object.update", { id, patch: { hidden: false } });
	return evaluate(`(async () => {
		const pixels = async (url) => { const image = new Image(); image.src = url; await image.decode(); const c = document.createElement("canvas"); c.width = image.width; c.height = image.height;
			const g = c.getContext("2d"); g.drawImage(image, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
		const [a, b] = await Promise.all([pixels(${JSON.stringify(shown)}), pixels(${JSON.stringify(hidden)})]);
		let count = 0, lift = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
		for (let i = 0; i < a.data.length; i += 4) {
			const d = (a.data[i] - b.data[i]) + (a.data[i + 1] - b.data[i + 1]) + (a.data[i + 2] - b.data[i + 2]);
			if (Math.abs(d) < 12) continue;
			const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
			count += 1; lift += d / 3; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
		}
		return { count, meanLift: count ? +(lift / count).toFixed(1) : 0, box: count ? [minX, minY, maxX, maxY] : null };
	})()`);
}
const report = {};
const characterId = await evaluate("window.__cozyclay.charA?.id ?? window.__cozyclay.rigA?.userData?.characterId ?? 'char-a'");
// Night: the lit parts are what the shot is about.
assert.ok(await act("stage.applyLighting", { preset: "night" }), "the night look");

// 1. The smoker: two kits, an exhale emitter at the mouth, one compile.
await clear();
const cig = (await act("object.createKit", { kit: "cigarette", position: { x: 0.45, z: 0.7 } })).output;
const lit = (await act("object.createKit", { kit: "lighter", position: { x: 0.6, z: 0.7 } })).output;
assert.ok(cig?.rootId && lit?.rootId && cig.parts.ember && cig.parts.smoke && cig.parts.light && lit.parts.flame && lit.parts.light, `the kits answer their parts: ${JSON.stringify([cig, lit])}`);
const SQUAT = { root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12, foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] };
const f0 = 1, smokeSpec = (kit) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", label: "squat and smoke", keys: [{ f: 0, set: SQUAT }],
	use: [{ skill: "smokeCigarette", f0, args: { kit } }] });
// where the mouth is while she breathes out: the exhale emitter stands there (a squat barely moves)
const probe = (await act("motion.compile", { characterId, spec: smokeSpec({ cig: cig.rootId, lighter: lit.rootId }), install: false,
	probes: [{ name: "mouth", position: "landmark:mouth", frames: [f0 + 124, f0 + 124] }] })).output;
const mouth = probe.probes.mouth.at[0].p;
const exhale = (await act("object.add", { kind: "effect", name: "Exhale", placement: { x: mouth[0], z: mouth[2] + 0.02 } })).affectedIds[0];
assert.ok(await act("object.update", { id: exhale, patch: { y: mouth[1] - 0.01, rotX: 60 } }), "the exhale emitter at the mouth");
assert.ok(await act("object.set", { id: exhale, set: { effect: { preset: "exhale" } } }), "an exhale preset");
const probes = [
	{ name: "filterToLips", distance: ["landmark:mouth", `object:${cig.parts.body}`], frames: [f0 + 59, f0 + 91] },
	{ name: "filterPointToLips", distance: ["landmark:mouth", "prop:cig.filter"], frames: [f0 + 59, f0 + 91] },
	{ name: "flameTopToTip", distance: [`object:${lit.parts.flame}.top`, "prop:cig.tip"], frames: [f0 + 63, f0 + 78] },
];
const smoke = (await act("motion.compile", { characterId, spec: smokeSpec({ cig: cig.rootId, lighter: lit.rootId, exhale }), probes })).output;
report.smoke = { qa: smoke.qa.total, installed: smoke.installed, probes: smoke.probes, events: smoke.timeline.flatMap((b) => b.events).length };
assert.ok(smoke.installed && smoke.qa.ok, `the dressed squat installs clean: ${JSON.stringify(smoke.qa.groups?.slice(0, 3))}`);
assert.ok(smoke.probes.filterToLips.max <= 0.01 && smoke.probes.filterPointToLips.max <= 0.01 && smoke.probes.flameTopToTip.max <= 0.01, `in the fingers: ${JSON.stringify(smoke.probes)}`);

const side = aim([-1.35, 1.0, 1.75], [-0.05, 0.7, 0.2], 40);
const lighting = await capture(f0 + 70, side);
await save("k4-squat-lighting", lighting);
report.flame = await measure([lit.parts.flame, lit.parts.light], f0 + 70, side, lighting);
assert.ok(report.flame.count > 400 && report.flame.meanLift > 0, `the flame and its light brighten the shot while lighting: ${JSON.stringify(report.flame)}`);
const drag = await capture(f0 + 206, side);
await save("k4-squat-drag", drag);
report.ember = await measure([cig.parts.ember, cig.parts.light], f0 + 206, side, drag);
report.tipSmoke = await measure([cig.parts.smoke], f0 + 206, side, drag);
assert.ok(report.ember.count > 100 && report.ember.meanLift > 0, `the ember glows on the drag: ${JSON.stringify(report.ember)}`);
assert.ok(report.tipSmoke.count > 300, `smoke from the tip: ${JSON.stringify(report.tipSmoke)}`);
const idle = await capture(f0 + 150, side);
report.emberIdle = await measure([cig.parts.ember, cig.parts.light], f0 + 150, side, idle);
assert.ok(report.emberIdle.meanLift < report.ember.meanLift, `the ember is brighter on a drag than at rest: ${report.ember.meanLift} > ${report.emberIdle.meanLift}`);
const puff = await capture(f0 + 130, side);
await save("k4-squat-exhale", puff);
report.exhale = await measure([exhale], f0 + 130, side, puff);
assert.ok(report.exhale.count > 300, `the exhale leaves the mouth: ${JSON.stringify(report.exhale)}`);
const before = await capture(f0 + 20, side);
report.pocket = await measure([cig.rootId, ...Object.values(cig.parts), lit.rootId, ...Object.values(lit.parts)], f0 + 20, side, before);
assert.equal(report.pocket.count, 0, "before they come out of the pockets the kits draw nothing");

// 2. The bat swing: the fixture's spec and keys, the kit root in place of its cylinder.
await clear();
const plate = BAT_SCENE.find((o) => o.id !== BAT);
const plateId = (await act("object.add", { kind: "cube", name: "Home Plate", placement: { x: plate.x, z: plate.z } })).affectedIds[0];
assert.ok(await act("object.update", { id: plateId, patch: { scaleX: plate.scaleX, scaleY: plate.scaleY, scaleZ: plate.scaleZ } }), "the plate");
const bat = (await act("object.createKit", { kit: "bat", position: { x: -0.4, z: 0.3 } })).output;
assert.ok(bat?.parts.body && bat.parts.trail, `the bat kit: ${JSON.stringify(bat)}`);
const swingSpec = JSON.parse(JSON.stringify(SWING_SPEC).replaceAll(`"${BAT}"`, `"${bat.rootId}"`).replaceAll(`object:${BAT}`, `object:${bat.rootId}`));
swingSpec.objects = { [bat.rootId]: { ...bat.bind[bat.rootId], keys: SWING_KEYS } };
swingSpec.checks.allow = swingSpec.checks.allow.map((a) => ({ ...a, object: bat.rootId }));
const swing = (await act("motion.compile", { characterId, spec: swingSpec, install: true })).output;
report.swing = { qa: swing.qa.total, installed: swing.installed, groups: swing.qa.groups?.slice(0, 3).map((g) => g.subject) };
assert.ok(swing.installed, "the swing installs");
const front = aim([1.6, 1.3, 2.6], [0.05, 1.1, 0.35], 46);
const contact = await capture(47, front);
await save("k4-bat-swing-trail", contact);
report.trail = await measure([bat.parts.trail], 47, front, contact);
report.batBody = await measure([bat.parts.body], 47, front, contact);
assert.ok(report.trail.count > 2000, `the swing draws a trail: ${JSON.stringify(report.trail)}`);
assert.ok(report.batBody.count > 1500, `the bat is drawn: ${JSON.stringify(report.batBody)}`);
const still = await capture(10, front);
report.trailStill = await measure([bat.parts.trail], 10, front, still);
assert.equal(report.trailStill.count, 0, "no trail while the bat stays still in the stance");

assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(JSON.stringify(report, null, 1));
console.log(`kits browser QA: PASS, captures in ${out}`);
ws.close();
