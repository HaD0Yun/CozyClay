#!/usr/bin/env node
// Browser QA for effects (src/effects/): every picture here is the shot render the agent's
// capture_frame and verify_result contact sheets use (CaptureRig through the shot camera).
// - Smoke from the tip of a cigarette carried by a compiled smokeCigarette take shows in a
//   captured frame next to the tip, and only there (a capture with the emitter hidden is the
//   reference, so the measured pixels are the smoke's own).
// - An exhale puff (shown for frames 116..128 through the take's visible channel) is drawn after
//   its emitter is hidden again, and its centroid rises across frames.
// - A routed stick draws a swoosh while it swings and nothing while it stands still.
// - Fire, sparks and rain render; with COZYCLAY_LIVE_PORT set, inspect_studio reports the
//   particles and verify_result renders a contact sheet through the recorder path.
//
// Run: `COZYCLAY_LIVE_PORT=6073 node tools/dev-full.mjs --host 127.0.0.1 --port 5233` in one
// shell, then `QA_URL=http://127.0.0.1:5233/app/ CDP_PORT=9383 COZYCLAY_LIVE_PORT=6073
// QA_THEME=light node tools/qa-browser.mjs -- node test/qa-effects-browser.mjs`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9222), theme = process.env.QA_THEME || "light";
const out = process.env.QA_OUT || "/tmp/cozyclay-effects-qa", livePort = process.env.COZYCLAY_LIVE_PORT;
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
await evaluate(`localStorage.setItem("cozyclay.theme.v1", ${JSON.stringify(theme)}); location.reload()`);
await new Promise((r) => setTimeout(r, 1500));
await waitFor("the studio QA hook", "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclay.captureFraming && window.__cozyclay.rigA)");

const act = (id, args) => evaluate(`(async () => { try {
	const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)});
	if (r?.ok !== true) throw Object.assign(new Error(r?.message ?? "Action returned no receipt."), { code: r?.code ?? "ACTION_REFUSED" });
	return r && { affectedIds: r.affectedIds };
} catch (error) { throw new Error((error.code ?? "STUDIO_ACTION_FAILED") + ": " + (error.message ?? String(error))); } })()`);
/** Clears the set, then adds each { kind, name, parent?, placement, update?, set? }; answers name -> id. */
async function build(specs) {
	const ids = await evaluate("window.__cozyclay.objects.map((o) => o.id)");
	if (ids.length) assert.ok(await act("object.remove", { ids }), "clear the set");
	const made = {};
	for (const spec of specs) {
		const added = await act("object.add", { kind: spec.kind, name: spec.name, placement: spec.placement ?? {}, ...(spec.parent ? { parent: made[spec.parent] } : {}) });
		assert.ok(added, `add ${spec.name}`);
		made[spec.name] = added.affectedIds[0];
		if (spec.update) assert.ok(await act("object.update", { id: made[spec.name], patch: spec.update }), `place ${spec.name}`);
		if (spec.set) assert.ok(await act("object.set", { id: made[spec.name], set: spec.set }), `set ${spec.name}`);
	}
	return made;
}
const aim = (pos, at, fovDeg) => {
	const d = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]];
	return { pos: { x: pos[0], y: pos[1], z: pos[2] }, yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])), fovDeg };
};
/** Pixel (x, y) of world point p in a 1920x1080 capture through `framing`. */
const project = (framing, p) => {
	const { yaw, pitch } = framing, c = framing.pos, v = [p[0] - c.x, p[1] - c.y, p[2] - c.z];
	const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)], r = [Math.cos(yaw), 0, -Math.sin(yaw)];
	const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const t = Math.tan((framing.fovDeg * Math.PI) / 360), z = dot(v, f);
	return { x: ((dot(v, r) / (z * t * (16 / 9)) + 1) / 2) * 1920, y: ((1 - dot(v, u) / (z * t)) / 2) * 1080 };
};
/** Scrub to `frame`, wait for the set to be placed, capture the shot render (a PNG data URL). */
const capture = (frame, framing) => evaluate(`(async () => {
	window.__cozyclay.scrub(${frame});
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))));
	return window.__cozyclay.captureFraming(${JSON.stringify(framing)});
})()`);
/** What `id` alone adds to the picture at `frame`: the capture against one with it hidden. */
async function measure(name, id, frame, framing) {
	const shown = await capture(frame, framing);
	await act("object.update", { id, patch: { hidden: true } });
	const hidden = await capture(frame, framing);
	await act("object.update", { id, patch: { hidden: false } });
	await writeFile(`${out}/${name}.png`, Buffer.from(shown.split(",")[1], "base64"));
	return evaluate(`(async () => {
		const pixels = async (url) => { const image = new Image(); image.src = url; await image.decode(); const c = document.createElement("canvas"); c.width = image.width; c.height = image.height;
			const g = c.getContext("2d"); g.drawImage(image, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
		const [a, b] = await Promise.all([pixels(${JSON.stringify(shown)}), pixels(${JSON.stringify(hidden)})]);
		let count = 0, sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
		for (let i = 0; i < a.data.length; i += 4) {
			if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) < 9) continue;
			const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
			count += 1; sx += x; sy += y; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
		}
		return { count, centroid: count ? [Math.round(sx / count), Math.round(sy / count)] : null, box: count ? [minX, minY, maxX, maxY] : null };
	})()`);
}
const world = async (id, frame) => {
	await evaluate(`window.__cozyclay.scrub(${frame})`);
	await waitFor(`${id} placed at ${frame}`, `window.__cclayPropWorld?.[${JSON.stringify(id)}]?.frame === ${frame}`, 10000);
	return evaluate(`(({ x, y, z }) => [x, y, z])(window.__cclayPropWorld[${JSON.stringify(id)}])`);
};
const report = { theme };

// 1. A smoking take: the cigarette rides the right hand (prop "cig"), its tip smoke is a child
// at the tip, and an exhale emitter at the mouth is shown by "puff_vis" (a carried, never-moving
// carrier: the shape a switch entry bakes).
const characterId = await evaluate("window.__cozyclay.charA?.id ?? window.__cozyclay.rigA?.userData?.characterId ?? 'char-a'");
const ids = await build([
	{ kind: "cylinder", name: "Cig", placement: { x: -0.3, z: 0.3 }, update: { y: 1, scaleX: 0.0078, scaleY: 0.084, scaleZ: 0.0078, color: "#f2efe6" } },
	{ kind: "effect", name: "Tip smoke", parent: "Cig", placement: { x: -0.3, z: 0.3 }, update: { y: 1.084 } },
	{ kind: "sphere", name: "Puff carrier", placement: { x: 0, z: 0 }, update: { y: 1.64, scaleX: 0.005, scaleY: 0.005, scaleZ: 0.005 } },
	{ kind: "effect", name: "Exhale", parent: "Puff carrier", placement: { x: 0, z: 0.11 }, update: { y: 1.62, rotX: 70 }, set: { effect: { preset: "exhale" } } },
]);
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 300,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "smokeCigarette", f0: 10 }],
	keys: [{ f: 0, set: { puff_vis: 0 } }, { f: 115, set: { puff_vis: 0 } }, { f: 116, set: { puff_vis: 1 } }, { f: 128, set: { puff_vis: 1 } }, { f: 129, set: { puff_vis: 0 } }],
	objects: { [ids.Cig]: { prop: "cig", at: [0, 0, -0.026], along: [0, 0, 1], visible: "cig_vis" }, [ids["Puff carrier"]]: { prop: "cig", grab: 0, release: 1, visible: "puff_vis" } } };
assert.ok(await act("motion.compile", { characterId, spec }), "the smoking take compiles");
await waitFor("the take's object tracks", `Boolean(window.__cozyclay.motion?.objects?.[${JSON.stringify(ids.Cig)}])`);

const side = aim([-1.5, 1.25, 0.3], [-0.15, 1.2, 0.25], 42);
report.smoke = [];
for (const frame of [150, 185, 200]) {
	const tip = await world(ids["Tip smoke"], frame), at = project(side, tip);
	const m = await measure(`smoke-held-${theme}-f${frame}`, ids["Tip smoke"], frame, side);
	report.smoke.push({ frame, tip: tip.map((v) => +v.toFixed(3)), tipPx: [Math.round(at.x), Math.round(at.y)], ...m });
	assert.ok(m.count > 1500, `frame ${frame}: the smoke covers ${m.count} pixels of the capture`);
	assert.ok(at.x >= m.box[0] - 40 && at.x <= m.box[2] + 40 && at.y >= m.box[1] - 40 && at.y <= m.box[3] + 40, `frame ${frame}: the smoke is drawn at the tip ${JSON.stringify(at)} (box ${m.box})`);
	// At 150 the hand rests at the hip: the stream stands above the tip. At 185 and 200 the hand
	// rises to the mouth, so the smoke it laid on the way is below it.
	if (frame === 150) assert.ok(m.centroid[1] < at.y, `frame ${frame}: the smoke rises from the tip (centroid ${m.centroid}, tip ${Math.round(at.y)})`);
}
const face = aim([-1.6, 1.55, 0.6], [0, 1.55, 0.45], 36);
report.exhale = [];
for (const frame of [124, 136, 150]) report.exhale.push({ frame, ...(await measure(`exhale-${theme}-f${frame}`, ids.Exhale, frame, face)) });
assert.ok(report.exhale.every((m) => m.count > 800), `the puff is in every frame: ${JSON.stringify(report.exhale.map((m) => m.count))}`);
assert.ok(report.exhale[0].centroid[1] > report.exhale[1].centroid[1] && report.exhale[1].centroid[1] > report.exhale[2].centroid[1], `the puff rises: ${JSON.stringify(report.exhale.map((m) => m.centroid))}`);
if (livePort) {
	const cli = (...args) => execFileSync("node", ["bin/cozyclay.mjs", "live", ...args, "--live-port", livePort], { encoding: "utf8" });
	await evaluate("window.__cozyclay.scrub(150)");
	const row = JSON.parse(cli("inspect", "--scope", "entities", "--ids", ids["Tip smoke"])).entities[0];
	report.inspect = row.effect;
	assert.ok(row.effect?.frame === 150 && row.effect.alive > 50 && row.effect.bounds.max[1] > row.effect.emitter[1] + 0.2, `inspect_studio reads the smoke: ${JSON.stringify(row.effect)}`);
	cli("verify", "--targets", characterId, "--checks", "placement", "--range", "110:236", "--visual", "contact_sheet", "--frames", "even", "--out", `${out}/contact-sheet-${theme}.png`);
	report.contactSheet = `${out}/contact-sheet-${theme}.png`;
}
await act("motion.clear", { characterId });

// 2. Fire and sparks; 3. rain over the set.
const fireIds = await build([
	{ kind: "effect", name: "Fire", placement: { x: 1.6, z: 0.6 }, set: { effect: { preset: "fire" } } },
	{ kind: "effect", name: "Sparks", placement: { x: -1.6, z: 0.6 }, update: { y: 0.15 }, set: { effect: { preset: "sparks" } } },
]);
report.fire = await measure(`fire-${theme}`, fireIds.Fire, 40, aim([1.6, 0.5, 1.9], [1.6, 0.3, 0.6], 40));
report.sparks = [];
for (const frame of [30, 34]) report.sparks.push({ frame, ...(await measure(`sparks-${theme}-f${frame}`, fireIds.Sparks, frame, aim([-1.6, 0.7, 2.4], [-1.6, 0.5, 0.6], 45))) });
assert.ok(report.fire.count > 4000 && report.sparks.every((m) => m.count > 100), `fire and sparks render: ${report.fire.count}, ${report.sparks.map((m) => m.count)}`);
const rainIds = await build([{ kind: "effect", name: "Rain", placement: { x: 0, z: 2 }, set: { effect: { preset: "rain" } } }]);
report.rain = await measure(`rain-${theme}`, rainIds.Rain, 40, aim([0.5, 1.5, 5.5], [0, 1.1, 0], 45));
assert.ok(report.rain.count > 5000, `rain renders: ${report.rain.count}`);

// 4. A stick routed through a fast arc draws a swoosh, and none before it moves.
const arc = Array.from({ length: 9 }, (_, i) => { const a = ((200 - i * 27.5) * Math.PI) / 180; return { x: +(0.3 * Math.cos(a)).toFixed(4), y: 1.15, z: +(0.6 + 0.3 * Math.sin(a)).toFixed(4) }; });
const swing = await build([
	{ kind: "cylinder", name: "Stick", placement: { x: arc[0].x, z: arc[0].z }, update: { y: 1.15, scaleX: 0.045, scaleY: 0.84, scaleZ: 0.045, rotZ: 90, color: "#b8875a", path: { points: arc, speed: 5 } } },
	{ kind: "effect", name: "Swoosh", parent: "Stick", placement: { x: arc[0].x - 0.58, z: arc[0].z }, update: { y: 1.15, rotZ: 90 }, set: { effect: { preset: "trail", width: 0.5 } } },
]);
const front = aim([0, 1.9, 2.6], [0, 1.1, 0.5], 50);
report.trail = [];
for (const frame of [0, 2, 4, 9]) report.trail.push({ frame, ...(await measure(`trail-${theme}-f${frame}`, swing.Swoosh, frame, front)) });
assert.equal(report.trail[0].count, 0, "a stick that has not moved yet draws no trail");
assert.ok(report.trail[1].count > 5000 && report.trail[2].count > report.trail[1].count, `the swoosh grows through the swing: ${report.trail.map((m) => m.count)}`);
assert.ok(report.trail[3].count < report.trail[2].count, "and fades once the stick stops");
assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log(JSON.stringify(report, null, 1));
console.log(`effects browser QA (${theme}): PASS, captures in ${out}`);
ws.close();
