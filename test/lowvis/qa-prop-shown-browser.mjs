#!/usr/bin/env node
// Browser check in the Studio: the hide / show keys of a lowvis clip reach what the Studio draws. A clip built here hides
// and shows a prop that stands still, one its own keys move, one a bone carries and a Studio effect a bone carries;
// installClip (the Studio's own action runner) installs it, and on frames around every key the drawn object of each prop
// is visible exactly where the clip's `shown` says so; again under a timing edit of the take (twice the speed: timeline
// frame f draws the clip's frame 2f), after it is reset, and after a reload of the page; and the shot capture (the
// export's render) draws the still prop on a frame it is shown and not on one it is hidden.
//
// Run: `COZYCLAY_LIVE_PORT=<hub> node tools/dev-full.mjs --host 127.0.0.1 --port <port>` in one shell, then
// `QA_URL=http://127.0.0.1:<port>/app/ CDP_PORT=<cdp> COZYCLAY_LIVE_PORT=<hub> node tools/qa-browser.mjs -- node test/lowvis/qa-prop-shown-browser.mjs`
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";

const cdpPort = Number(process.env.CDP_PORT || 9344);
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
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); if (r?.ok !== true) throw new Error(${JSON.stringify(id)} + ": " + (r?.code ?? "") + " " + (r?.message ?? "refused")); return r; })()`);
await send("Runtime.enable");
await evaluate("location.reload()");
await new Promise(r => setTimeout(r, 1500));
await waitFor("the Studio QA hook", "window.__cozyclay?.runStudioAction");

try {
	// a clean set with one effect, offered to the clip as a point prop
	const old = await evaluate("window.__cozyclay.objects.map(o => o.id)");
	if (old.length) await act("object.remove", { ids: old });
	for (const id of await evaluate("window.__cozyclay.characters.filter(c => /^lowvis-/.test(c.id)).map(c => c.id)")) await act("character.remove", { characterId: id });
	const smoke = (await act("object.add", { kind: "effect", name: "Tip smoke", placement: { x: 0.3, z: 0.3 } })).affectedIds[0];
	await act("object.update", { id: smoke, patch: { y: 1 } });
	const { scene: studio, ids } = studioScene({ characters: [], objects: await evaluate("window.__cozyclay.objects") }, { turn: true, kinds: true });
	const fx = studio.props[0].id, F = 96;
	const scene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ ...studio.props[0], moves: true },
		{ id: "post", size: [0.3, 0.6, 0.3], at: [0.8, 0.3, 0.6] }, { id: "cart", size: [0.4, 0.3, 0.4], at: [-0.8, 0.15, 0.4], moves: true }, { id: "badge", size: [0.08, 0.08, 0.03], at: [0, 1.5, 0.2], moves: true }] };
	const spec = { demo: "qa", a: [[0, "walk", { to: [0, 1.5] }]], [fx]: [[0, "ride", { joint: "RightHand", of: "a", at: [0, 0, 0.05] }], [0, "hide"], [30, "show"]],
		post: [[12, "hide"], [36, "show"]], cart: [[0, "move", { to: [-0.8, 0.15, 2], over: 90 }], [24, "hide"], [48, "show"]], badge: [[0, "ride", { joint: "Head", of: "a" }], [60, "hide"]] };
	const clip = JSON.parse(serializeClip(buildClip(structuredClone(spec), scene).clip));
	const out = await evaluate(`(async () => {
		const { installClip } = await import("/src/lowvis/studio/install.js");
		const run = async (id, args) => { const r = await window.__cozyclay.runStudioAction(id, args); return r?.ok === true ? r : null; };
		return installClip(${JSON.stringify(clip)}, run, { existing: ${JSON.stringify(ids)}, turn: true, label: "qa shown" });
	})()`);
	assert.equal(out.ok, true, "the clip installs");
	assert.deepEqual(out.attached.map(a => a.id).sort(), [out.placed.badge, smoke].sort(), "the badge and the effect ride their bones");
	assert.deepEqual(out.moving, [out.placed.cart], "a track moves the cart alone");
	await waitFor("the rig", `window.__cozyclay.rigs?.['lowvis-a']?.parent && window.__cozyclay.frameCount >= ${F}`);
	await evaluate("window.__cozyclay.pause()");

	// what the Studio draws on a timeline frame: each scene object's group and everything above it visible
	const drawn = frame => evaluate(`(async () => {
		const qa = window.__cozyclay; qa.scrub(${frame});
		for (let i = 0; i < 240 && qa.tlFrame !== ${frame}; i++) await new Promise(r => requestAnimationFrame(r));
		for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
		let root = qa.rigs["lowvis-a"]; while (root.parent) root = root.parent;
		const seen = {};
		root.traverse(n => { const id = n.userData?.sceneObjectId; if (!id) return; let v = true; for (let p = n; p; p = p.parent) v = v && p.visible; seen[id] = (seen[id] ?? false) || v; });
		return seen;
	})()`);
	const names = { [fx]: smoke, post: out.placed.post, cart: out.placed.cart, badge: out.placed.badge };
	const want = (prop, f) => clip.props.find(p => p.id === prop).shown[Math.min(F - 1, f)] === 1;
	async function check(label, frames, clipFrame = f => f) {
		const rows = [];
		for (const f of frames) {
			const seen = await drawn(f);
			for (const [prop, id] of Object.entries(names)) {
				assert.equal(typeof seen[id], "boolean", `${label} f${f}: ${prop} has a drawn object`);
				assert.equal(seen[id], want(prop, clipFrame(f)), `${label} f${f}: ${prop} is ${want(prop, clipFrame(f)) ? "drawn" : "not drawn"}, as the clip's frame ${clipFrame(f)} says`);
			}
			rows.push(`${f}:${Object.keys(names).map(p => (seen[names[p]] ? 1 : 0)).join("")}`);
		}
		console.log(`${label} (frame: ${Object.keys(names).join(" ")}): ${rows.join(" ")}`);
	}
	await check("installed", [0, 11, 12, 23, 24, 29, 30, 35, 36, 47, 48, 59, 60, 95]);
	// a timing edit: twice the speed, so timeline frame f draws the clip's frame 2f
	await act("motion.setSegmentSpeed", { characterId: "lowvis-a", segmentId: "motion-0", speed: 2 });
	await check("twice the speed", [5, 6, 12, 15, 18, 24, 30], f => 2 * f);
	await act("motion.resetTiming", { characterId: "lowvis-a" });
	await check("timing reset", [11, 12, 36, 60]);
	// the still prop it hides can still be moved by hand (no track holds its place)
	await act("object.update", { id: out.placed.post, patch: { x: 1.1 } });
	assert.ok(Math.abs((await evaluate(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(out.placed.post)}).x`)) - 1.1) < 1e-6, "the still prop moves by hand");
	await check("after a move by hand", [11, 12, 36]);
	// the shot capture (the export's render): the still prop on a frame it is shown against one it is hidden
	const pixels = await evaluate(`(async () => {
		const qa = window.__cozyclay, framing = { pos: { x: 2.6, y: 0.5, z: 0.6 }, yaw: Math.PI / 2, pitch: -0.1, fovDeg: 16 }; // close on the post, from the side away from the figure
		const shot = async f => { qa.scrub(f); for (let i = 0; i < 240 && qa.tlFrame !== f; i++) await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))); return qa.captureFraming(framing); };
		const read = async url => { const i = new Image(); i.src = url; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
		const diff = (p, q) => { let n = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) >= 9) n++; return n; };
		const [a, b, c] = [await read(await shot(11)), await read(await shot(12)), await read(await shot(13))];
		return { hide: diff(a, b), hidden: diff(b, c) };
	})()`);
	// (the figure walks and the cart moves behind the post, so two frames with the post hidden differ too, by far less)
	assert.ok(pixels.hide > 300 && pixels.hidden < pixels.hide / 4, `the shot capture draws the still prop on frame 11 and not on 12 (${pixels.hide} pixels differ between them, ${pixels.hidden} between 12 and 13)`);
	// a reload: the saved take brings the same frames back
	await new Promise(r => setTimeout(r, 1500)); // the autosave
	await evaluate("location.reload()");
	await new Promise(r => setTimeout(r, 1500));
	await waitFor("the Studio after the reload", "window.__cozyclay?.runStudioAction && window.__cozyclay.rigs?.['lowvis-a']?.parent");
	await evaluate("window.__cozyclay.pause()");
	await check("reloaded", [0, 12, 30, 36, 48, 60]);
	console.log(JSON.stringify({ capture: pixels }));
	assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
	console.log("PASS qa-prop-shown-browser");
} finally {
	ws.close();
}
