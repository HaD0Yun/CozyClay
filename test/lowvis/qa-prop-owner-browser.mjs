#!/usr/bin/env node
// Browser check in the Studio: a two-character lowvis clip, each character holding its own box, installed as the Studio
// installs one (window.__cozyclay.showLowvisClip -> installClip). A segment speed is set on each character's take in
// turn through the bus (motion.setSegmentSpeed), and on every timeline frame its holder holds it each box, as drawn,
// keeps its place against the holder's drawn right hand at the same moment of the unedited take (verify-prop-owner.mjs
// measures the same in node).
//
// Run: `COZYCLAY_LIVE_PORT=5395 npm run dev -- --port 5195 --strictPort` in one shell, then
// `QA_URL=http://127.0.0.1:5195/app/ CDP_PORT=9342 node tools/qa-browser.mjs -- node test/lowvis/qa-prop-owner-browser.mjs`
// The clip is written to public/lowvis/clips/pi/ (git-ignored, where the motion writer's clips go) and removed after.
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";

const NAME = "qa-prop-owner", FILE = new URL(`../../public/lowvis/clips/pi/${NAME}.json`, import.meta.url);
const F = 120, box = (id, at) => ({ id, size: [0.3, 0.3, 0.3], at, moves: true });
const SCENE = { frames: F, characters: [{ id: "a", at: [-1, 0], heading: 0 }, { id: "b", at: [1, 0], heading: 0 }], props: [box("boxA", [-1.25, 0.85, 0.3]), box("boxB", [0.75, 0.85, 0.3])] };
const SPEC = { demo: NAME, a: [[0, "hold", { prop: "boxA", hand: "R" }], [10, "walk", { to: [-1, 2] }]], b: [[0, "hold", { prop: "boxB", hand: "R" }], [40, "walk", { to: [1, 2.5] }], [100, "release", { prop: "boxB" }]] };
const { clip, aux } = buildClip(structuredClone(SPEC), SCENE);
mkdirSync(new URL(".", FILE), { recursive: true });
writeFileSync(FILE, serializeClip(clip));

const cdpPort = Number(process.env.CDP_PORT || 9342);
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

try {
	await waitFor("window.__cozyclay?.showLowvisClip");
	let shown = false; // the dev server serves a new public file a moment after it is written
	for (let tries = 0; tries < 50 && !shown; tries++) { shown = await evaluate(`window.__cozyclay.showLowvisClip(${JSON.stringify(NAME)})`); if (!shown) await new Promise(r => setTimeout(r, 200)); }
	assert.equal(shown, true, "the clip installs");
	await waitFor("['lowvis-a','lowvis-b'].every(id => window.__cozyclay.rigs?.[id]?.parent) && ['boxA','boxB'].every(n => window.__cozyclay.objects.some(o => o.name === n))");
	await evaluate("window.__cozyclay.pause()");
	// every frame up to `count`: each box's drawn base pivot and each character's drawn right hand, in world metres
	const sample = count => evaluate(`(async () => {
		const qa = window.__cozyclay, raf = () => new Promise(r => requestAnimationFrame(r)), out = [];
		let root = qa.rigs["lowvis-a"]; while (root.parent) root = root.parent;
		const groupOf = name => { const id = qa.objects.find(o => o.name === name).id; let g = null; root.traverse(n => { if (n.userData?.sceneObjectId === id) g = n; }); return g; };
		const handOf = id => { let h = null; qa.rigs[id].traverse(n => { if (n.isBone && /RightHand$/.test(n.name)) h = n; }); return h; };
		const boxes = { boxA: groupOf("boxA"), boxB: groupOf("boxB") }, hands = { a: handOf("lowvis-a"), b: handOf("lowvis-b") };
		const ids = ["boxA", "boxB"].map(name => qa.objects.find(o => o.name === name).id);
		const at = o => { o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
		for (let t = 0; t < ${count}; t++) {
			window.__cozyclay.setFrame(t);
			// drawn: the playhead is on t, both boxes were placed for t (props.jsx stamps the frame), and two reads one
			// animation frame apart are the same (a fixed number of animation frames read a pose of the frame before)
			let row = null, tries = 0;
			for (; tries < 240; tries++) {
				await raf();
				if (window.__cozyclay.tlFrame !== t || !ids.every(id => window.__cclayPropWorld?.[id]?.frame === t)) { row = null; continue; }
				const next = { boxA: at(boxes.boxA), boxB: at(boxes.boxB), a: at(hands.a), b: at(hands.b) };
				if (row && JSON.stringify(row) === JSON.stringify(next)) break;
				row = next;
			}
			if (tries === 240) throw new Error("frame " + t + " was not drawn");
			out.push(row);
		}
		return out;
	})()`);
	const base = await sample(F), sub = (x, y) => x.map((v, k) => v - y[k]);
	const holds = (who, f) => String(aux.holders[`box${who.toUpperCase()}`][f] ?? "").split("+").some(h => h.split(":")[0] === who);
	const results = [];
	for (const edited of ["a", "b"]) {
		await evaluate(`window.__cozyclay.runStudioAction("motion.resetTiming", { characterId: "lowvis-a" })`);
		await evaluate(`window.__cozyclay.runStudioAction("motion.resetTiming", { characterId: "lowvis-b" })`);
		const receipt = await evaluate(`window.__cozyclay.runStudioAction("motion.setSegmentSpeed", { characterId: "lowvis-${edited}", segmentId: "motion-0", speed: 2 })`);
		const D = Math.round(F / 2), frames = await evaluate("window.__cozyclay.frameCount");
		assert.equal(receipt?.ok, true, `${edited}'s segment speed is set (${JSON.stringify(receipt)?.slice(0, 200)})`);
		assert.equal(frames, F, `the timeline keeps the longer take's ${F} frames`);
		const now = await sample(F);
		for (const who of ["a", "b"]) {
			const prop = `box${who.toUpperCase()}`, length = who === edited ? D : F;
			let worst = 0, frames = 0;
			for (let t = 0; t < length; t++) {
				const s = who === edited ? t * (F - 1) / (D - 1) : t, i0 = Math.floor(s), i1 = Math.ceil(s), u = s - i0;
				if (!holds(who, i0) || !holds(who, i1)) continue;
				const ref = sub(base[i0][prop], base[i0][who]).map((v, k) => v + (sub(base[i1][prop], base[i1][who])[k] - v) * u);
				worst = Math.max(worst, Math.hypot(...sub(sub(now[t][prop], now[t][who]), ref)));
				frames++;
			}
			results.push({ edited, who, prop, worst, frames });
			console.log(`${edited} at speed 2: ${prop} against ${who}'s drawn right hand, worst ${(worst * 1000).toFixed(2)} mm over ${frames} held frames`);
		}
	}
	await evaluate(`window.__cozyclay.runStudioAction("motion.resetTiming", { characterId: "lowvis-b" })`);
	for (const r of results) assert.ok(r.frames > 20 && r.worst < 0.003, `${r.edited} sped up: ${r.prop} stays in ${r.who}'s hand as drawn (worst ${(r.worst * 1000).toFixed(2)} mm over ${r.frames} frames)`);
	console.log("PASS qa-prop-owner-browser");
} finally {
	ws.close();
	unlinkSync(FILE);
}
