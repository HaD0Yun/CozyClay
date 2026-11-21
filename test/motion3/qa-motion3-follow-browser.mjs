#!/usr/bin/env node
// Browser QA for follow entries (C16, docs/motion-api-v3.1.md): in the real editor, the night look,
// the cigarette, lighter and exhale kits, and the squat of session da8760fa ("밤에 쪼그려 앉아 담배피는
// 장면") compiled once with smokeCigarette args.kit { cig, lighter, exhale }. The exhale kit is created
// anywhere and never placed: its root follows the mouth. The shot render (captureFraming, the
// picture capture_frame and contact sheets use) shows the puff leaving the mouth on two frames of an
// exhale: the puff's pixels (a capture with the puff hidden is the reference) start at the projected
// mouth, and the effect readback (src/effects/state.js effectStateAt) puts the emitter on the mouth
// the compile probes; a wider framing (shot distance) still shows the breath. Captures go to QA_OUT.
//
// Run: `COZYCLAY_LIVE_PORT=6076 node tools/dev-full.mjs --host 127.0.0.1 --port 5236` in one shell,
// then `QA_URL=http://127.0.0.1:5236/app/ CDP_PORT=9386 QA_OUT=<dir> node tools/qa-browser.mjs -- node test/motion3/qa-motion3-follow-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9222), out = process.env.QA_OUT || "/tmp/cozyclay-follow-qa";
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
/** A framing record looking from pos at `at` (the editor's YXZ yaw/pitch), and the projection of a world point into its W x H picture. */
const aim = (pos, at, fovDeg) => {
	const d = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]];
	return { pos: { x: pos[0], y: pos[1], z: pos[2] }, yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])), fovDeg };
};
const project = (framing, p, W, H) => {
	const d = [p[0] - framing.pos.x, p[1] - framing.pos.y, p[2] - framing.pos.z], cy = Math.cos(framing.yaw), sy = Math.sin(framing.yaw), cp = Math.cos(framing.pitch), sp = Math.sin(framing.pitch);
	const x1 = cy * d[0] - sy * d[2], z1 = sy * d[0] + cy * d[2], y2 = cp * d[1] + sp * z1, z2 = cp * z1 - sp * d[1], t = Math.tan((framing.fovDeg * Math.PI) / 360);
	return [((x1 / -z2) / (t * (W / H)) + 1) / 2 * W, (1 - (y2 / -z2) / t) / 2 * H];
};
const capture = (frame, framing) => evaluate(`(async () => {
	window.__cozyclay.scrub(${frame});
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))));
	return window.__cozyclay.captureFraming(${JSON.stringify(framing)});
})()`);
const save = (name, url) => writeFile(`${out}/${name}.png`, Buffer.from(url.split(",")[1], "base64"));
/** The pixels `ids` add to the shot at `frame` (a capture with them hidden is the reference): count, box, and the one nearest `to` [x, y]. */
async function measure(ids, frame, framing, shown, to) {
	for (const id of ids) await act("object.update", { id, patch: { hidden: true } });
	const hidden = await capture(frame, framing);
	for (const id of ids) await act("object.update", { id, patch: { hidden: false } });
	return evaluate(`(async () => {
		const pixels = async (url) => { const image = new Image(); image.src = url; await image.decode(); const c = document.createElement("canvas"); c.width = image.width; c.height = image.height;
			const g = c.getContext("2d"); g.drawImage(image, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
		const [a, b] = await Promise.all([pixels(${JSON.stringify(shown)}), pixels(${JSON.stringify(hidden)})]), to = ${JSON.stringify(to)};
		let count = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, near = Infinity, sx = 0, sy = 0;
		for (let i = 0; i < a.data.length; i += 4) {
			const d = (a.data[i] - b.data[i]) + (a.data[i + 1] - b.data[i + 1]) + (a.data[i + 2] - b.data[i + 2]);
			if (Math.abs(d) < 12) continue;
			const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
			count += 1; sx += x; sy += y; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
			near = Math.min(near, Math.hypot(x - to[0], y - to[1]));
		}
		return { size: [a.width, a.height], count, box: count ? [minX, minY, maxX, maxY] : null, centroid: count ? [Math.round(sx / count), Math.round(sy / count)] : null, nearestToMouthPx: count ? +near.toFixed(1) : null };
	})()`);
}
const report = {};
const characterId = await evaluate("window.__cozyclay.charA?.id ?? window.__cozyclay.rigA?.userData?.characterId ?? 'char-a'");
assert.ok(await act("stage.applyLighting", { preset: "night" }), "the night look");
await clear();
const cig = (await act("object.createKit", { kit: "cigarette", position: { x: 0.6, z: 0.6 } })).output;
const lit = (await act("object.createKit", { kit: "lighter", position: { x: 0.75, z: 0.6 } })).output;
const ex = (await act("object.createKit", { kit: "exhale" })).output;
assert.ok(cig?.rootId && lit?.rootId && ex?.rootId && ex.parts.puff, `the kits: ${JSON.stringify([cig, lit, ex])}`);
assert.deepEqual(ex.bind[ex.rootId], { follow: "landmark:mouth", aim: "face", visible: "exhale" }, "the exhale kit's bind is the follow entry");
// a street lamp off to the side, as the session built it
const lamp = (await act("object.add", { kind: "spot-light", name: "Lamp Light", placement: { x: 1.0, z: 0.4 } })).affectedIds[0];
assert.ok(await act("object.update", { id: lamp, patch: { y: 3.1 } }), "the lamp height");
assert.ok(await act("object.set", { id: lamp, set: { light: { type: "spot", color: "#ffb36b", intensity: 40, range: 10, angle: 40, softness: 0.6, shadow: true, aim: { x: 0.1, y: 0, z: 0.1 } } } }), "the lamp");

// the session's squat and smoke, after its repair round (fix.retime); the exhale kit is never placed
const SQUAT = { root: [0, 0.5, -0.08], foot_l: [0.17, 0.087, 0.12], foot_r: [-0.17, 0.087, 0.12], knee_l: [0.5, 0.2, 1], knee_r: [-0.5, 0.2, 1], fyaw_l: 15, fyaw_r: -15, fpitch_l: 10, fpitch_r: 10,
	pitch: 28, spine_pitch: 5, head_pitch: -18, yaw: 0 };
const spec = { schema: "cozyclay.motion-spec.v1", frames: 265, label: "squat smoke night", fix: { retime: true }, keys: [{ f: 0, set: SQUAT }],
	use: [{ skill: "smokeCigarette", f0: 0, args: { kit: { cig: cig.rootId, lighter: lit.rootId, exhale: ex.rootId } } }] };
const first = (await act("motion.compile", { characterId, spec, install: true })).output;
const shows = first.timeline.flatMap((b) => b.events).filter((e) => e.object === ex.rootId);
const on = shows.find((e) => e.event === "show")?.f, off = shows.find((e) => e.event === "hide")?.f;
assert.ok(first.installed && first.qa.ok && on > 0 && off > on, `installs clean, the exhale shows and hides: ${JSON.stringify({ qa: first.qa.groups?.slice(0, 2), shows })}`);
const frames = [on + 6, on + 16];
const probed = (await act("motion.compile", { characterId, spec, install: false, probes: frames.map((f) => ({ name: `mouth${f}`, position: "landmark:mouth", frames: [f, f] })) })).output;
report.smoke = { qa: first.qa.total, exhale: [on, off], frames };

const shot = aim([-1.5, 1.05, 1.55], [0.0, 0.75, 0.2], 36);
for (const f of frames) {
	const mouth = probed.probes[`mouth${f}`].at[0].p;
	const url = await capture(f, shot);
	await save(`k6-night-squat-exhale-f${f}`, url);
	const [W, H] = await evaluate(`(async () => { const i = new Image(); i.src = ${JSON.stringify(url)}; await i.decode(); return [i.width, i.height]; })()`);
	const at = project(shot, mouth, W, H);
	const puff = await measure([ex.parts.puff], f, shot, url, at);
	// the app's own instance of the module (a dev server serves an edited module under a ?t= query)
	const emitter = await evaluate(`(async () => { const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/effects/state.js")) ?? "/src/effects/state.js";
		const m = await import(url); return m.effectStateAt(${JSON.stringify(ex.parts.puff)}, ${f}); })()`);
	report[`f${f}`] = { mouth, mouthPx: at.map(Math.round), puff, emitter, emitterToMouthMm: emitter ? +(Math.hypot(...emitter.emitter.map((v, i) => v - mouth[i])) * 1000).toFixed(1) : null };
	console.log(JSON.stringify(report[`f${f}`]));
	assert.ok(puff.count > 300, `f${f}: the puff draws: ${JSON.stringify(puff)}`);
	assert.ok(puff.nearestToMouthPx <= 12, `f${f}: the puff starts at the mouth (nearest puff pixel ${puff.nearestToMouthPx} px from the projected mouth)`);
	assert.ok(emitter && report[`f${f}`].emitterToMouthMm <= 1, `f${f}: the effect readback puts the emitter on the mouth: ${JSON.stringify(report[`f${f}`])}`);
}
// at shot distance (a medium-wide 3/4 front, about 4 m away) the breath still reads
const wide = aim([-2.2, 1.35, 3.4], [0.0, 0.6, 0.2], 40), wf = frames[1], wideUrl = await capture(wf, wide);
await save(`k6-night-squat-exhale-wide-f${wf}`, wideUrl);
report.wide = await measure([ex.parts.puff], wf, wide, wideUrl, project(wide, probed.probes[`mouth${wf}`].at[0].p, ...report[`f${wf}`].puff.size));
assert.ok(report.wide.count > 1500 && report.wide.nearestToMouthPx <= 6, `the breath reads at shot distance: ${JSON.stringify(report.wide)}`);
// QA_LOOK=1: more frames of the breath, for judging the look (not asserted)
if (process.env.QA_LOOK) for (const f of [on + 2, on + 30, on + 45]) await save(`k6-look-f${f}`, await capture(f, shot));
const idle = await capture(on - 10, shot);
report.idle = await measure([ex.parts.puff], on - 10, shot, idle, [0, 0]);
assert.equal(report.idle.count, 0, "no puff before the exhale");

assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(JSON.stringify(report, null, 1));
console.log(`follow browser QA: PASS, captures in ${out}`);
ws.close();
