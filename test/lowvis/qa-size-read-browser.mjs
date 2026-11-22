#!/usr/bin/env node
// Browser check in the Studio: a lowvis clip of three bodies, at scale 0.81, 0.95 and 0.88, installed as the Studio installs
// one (window.__cozyclay.showLowvisClip -> installClip). On several frames motion.sample answers, for every one of the 17
// clip joints of each body, the world place of that bone as drawn (the rig's bone, read from the page) within 1 mm
// (verify-size-read.mjs measures the same against the clip in node); then the third is set to scale 1, and the first is
// moved, turned and lifted (a character carries its take), and each is read again.
//
// Run: `COZYCLAY_FIGURE=cube COZYCLAY_LIVE_PORT=5390 npm run dev -- --port 5190 --strictPort` in one shell, then
// `QA_URL=http://127.0.0.1:5190/app/ CDP_PORT=9346 node tools/qa-browser.mjs -- node test/lowvis/qa-size-read-browser.mjs`
// The clip is written to public/lowvis/clips/pi/ (git-ignored, where the motion writer's clips go) and removed after.
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { JOINTS } from "../../src/lowvis/rig17.js";
import { scaleOf } from "../../src/lowvis/studio/figure.js";

const NAME = "qa-size-read", FILE = new URL(`../../public/lowvis/clips/pi/${NAME}.json`, import.meta.url);
const F = 72, FRAMES = [0, 17, 35, 52, 71], SCALES = { a: 0.81, b: 0.95, c: 0.88 };
const SCENE = { frames: F, characters: [{ id: "a", at: [-1.5, 0], heading: 30, scale: 0.81 }, { id: "b", at: [0, 1], heading: -60, scale: 0.95 }, { id: "c", at: [1.5, -0.5], heading: 180, scale: 0.88 }], props: [] };
const SPEC = { demo: NAME, a: [[0, "walk", { to: [-1, 1.5] }]], b: [[0, "walk", { to: [0.8, 2] }], [50, "pose", { R: [-0.1, 0.3, 0.2] }]], c: [[0, "idle"], [20, "turn", { heading: 90 }]] };
const { clip } = buildClip(structuredClone(SPEC), SCENE);
mkdirSync(new URL(".", FILE), { recursive: true });
writeFileSync(FILE, serializeClip(clip));

const cdpPort = Number(process.env.CDP_PORT || 9346);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.includes("/app/")) ?? targets.find(t => t.type === "page");
assert.ok(page, "the Studio page is open");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = event => { const m = JSON.parse(event.data); const p = m.id && pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluation failed");
	return r.result?.value;
};
const waitFor = async (expression, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(r => setTimeout(r, 200)); } throw new Error(`timed out: ${expression}`); };
const IDS = Object.keys(SCALES).map(id => `lowvis-${id}`);

try {
	await waitFor("window.__cozyclay?.showLowvisClip");
	let shown = false; // the dev server serves a new public file a moment after it is written
	for (let tries = 0; tries < 50 && !shown; tries++) { shown = await evaluate(`window.__cozyclay.showLowvisClip(${JSON.stringify(NAME)})`); if (!shown) await new Promise(r => setTimeout(r, 200)); }
	assert.equal(shown, true, "the clip installs");
	await waitFor(`${JSON.stringify(IDS)}.every(id => window.__cozyclay.rigs?.[id]?.parent)`);
	// the Studio plays a clip it has just installed, and the playhead the page reports stays where it was while it plays:
	// the drawn pose is the playhead's only once playback has stopped
	await evaluate("window.__cozyclay.pause()");
	await waitFor("window.__cozyclay.playing === false");
	const scalesNow = () => evaluate(`Object.fromEntries(window.__cozyclay.characters.filter(c => ${JSON.stringify(IDS)}.includes(c.id)).map(c => [c.id, c.scale ?? 1]))`);
	const scales = await scalesNow();
	// a clip's scale is the size the engine built; the Studio character's is that over the body of the page's look (figure.js)
	const body = await evaluate(`import("/src/lowvis/studio/figure.js").then(m => m.lookBody())`);
	assert.deepEqual(IDS.map(id => scales[id]), Object.values(SCALES).map(s => scaleOf(s, body)), "the Studio holds the clip's sizes as its characters' scales");
	/** The worst distance (m) per character between motion.sample and its drawn bones, over FRAMES. */
	const measure = async ids => {
		const worst = Object.fromEntries(ids.map(id => [id, 0]));
		for (const f of FRAMES) {
			// drawn: playback is stopped, the playhead is on f and two reads one animation frame apart are the same
			const drawn = await evaluate(`(async () => {
				const qa = window.__cozyclay, raf = () => new Promise(r => requestAnimationFrame(r)), joints = ${JSON.stringify(JOINTS)};
				qa.pause(); qa.setFrame(${f});
				const read = () => Object.fromEntries(${JSON.stringify(ids)}.map(id => { const out = {}; window.__cozyclay.rigs[id].traverse(n => { const name = n.isBone && n.name.replace(/^mixamorig:?/, ""); if (name && joints.includes(name)) { n.updateWorldMatrix(true, false); const e = n.matrixWorld.elements; out[name] = [e[12], e[13], e[14]]; } }); return [id, out]; }));
				let row = null;
				for (let tries = 0; tries < 240; tries++) {
					await raf();
					if (window.__cozyclay.playing || window.__cozyclay.tlFrame !== ${f}) { row = null; continue; }
					const next = read();
					if (row && JSON.stringify(row) === JSON.stringify(next)) return row;
					row = next;
				}
				throw new Error("frame ${f} was not drawn: playhead " + window.__cozyclay.tlFrame + ", last read " + JSON.stringify(row)?.slice(0, 200));
			})()`);
			for (const id of ids) {
				const receipt = await evaluate(`window.__cozyclay.runStudioAction("motion.sample", { characterId: ${JSON.stringify(id)}, frames: [${f}], bones: ${JSON.stringify(JOINTS)} })`);
				assert.equal(receipt?.ok, true, `${id}: motion.sample answers (${receipt?.code} ${receipt?.message ?? JSON.stringify(receipt?.error ?? receipt)?.slice(-400)})`);
				const sampled = receipt.output.frames[0].bones;
				for (const joint of JOINTS) worst[id] = Math.max(worst[id], Math.hypot(...sampled[joint].map((v, k) => v - drawn[id][joint][k])));
			}
		}
		return worst;
	};
	const check = (worst, at) => {
		for (const [id, w] of Object.entries(worst)) {
			console.log(`${id} at scale ${at[id]}: motion.sample against the drawn bones, ${JOINTS.length} bones on ${FRAMES.length} frames, worst ${(w * 1000).toFixed(3)} mm`);
			assert.ok(w < 1e-3, `${id}: motion.sample is the drawn skeleton within 1 mm`);
		}
	};
	check(await measure(IDS), scales);
	// the third body at scale 1, set by the user after the install (its take is of a body of 0.88): read as drawn
	const set = await evaluate(`window.__cozyclay.runStudioAction("character.update", { characterId: "lowvis-c", patch: { scale: 1 } })`);
	assert.equal(set?.ok, true, `the scale is set (${JSON.stringify(set)?.slice(0, 200)})`);
	await waitFor(`window.__cozyclay.characters.find(c => c.id === "lowvis-c")?.scale === 1`);
	check(await measure(["lowvis-c"]), await scalesNow());
	// the first body moved, turned and lifted after the install: the stage draws its take there, and so reads motion.sample
	const moved = await evaluate(`window.__cozyclay.runStudioAction("character.update", { characterId: "lowvis-a", patch: { x: -2.4, y: 0.3, z: 1.1, rot: -140 } })`);
	assert.equal(moved?.ok, true, `the character is moved (${JSON.stringify(moved)?.slice(0, 200)})`);
	await waitFor(`window.__cozyclay.characters.find(c => c.id === "lowvis-a")?.rot === -140`);
	check(await measure(["lowvis-a"]), await scalesNow());
	console.log("PASS qa-size-read-browser");
} finally {
	ws.close();
	unlinkSync(FILE);
}
