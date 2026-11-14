#!/usr/bin/env node
// Browser contract for the prop speed graph in the v2 sequencer, pixels
// included. Seeds the vintage car, selects the chassis (a 15 s route) and gives
// it a timing with three cuts and two spikes — the shape that once turned the
// whole graph solid: the cut pin was an SVG path inside the graph's 1×1
// viewBox, stretched to the lane's width, and the theme put a stroke on it.
// In both themes:
//   1. The body is mostly background: pixels in the accent colour (the line,
//      the cut lines, the pins) stay under a few percent of the area.
//   2. The area fill is a tint, not the accent.
//   3. Each cut wears one pin head the size of a handle, standing on the cut.
//   4. The graph's clock is the ruler's: the sequencer playhead crosses the
//      body at frame / (frameCount - 1) of its width, and the graph draws no
//      second playhead of its own.
//   5. Pressing a pin selects the cut; Delete removes it.
//   6. The three scale marks share the left edge.
//   7. The Shot box's dolly curve, which is the same component, wears the
//      same handle-sized pins on its cuts.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5945 npm run dev -- --port 5841` in
// one shell, then
// `QA_OUT=/tmp/sg QA_URL=http://127.0.0.1:5841/app/ CDP_PORT=9841 node tools/qa-browser.mjs -- node test/qa-speed-graph-browser.mjs`
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const doc = readFileSync(process.env.SEED_DOC || new URL("./fixtures/vintage-car-scene.json", import.meta.url), "utf8");
const cdpPort = Number(process.env.CDP_PORT || 9841);
const OUT = process.env.QA_OUT;
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/app/")) || targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, probe, timeoutMs = 60000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const v = await probe().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`timeout: ${label}`); };
const navigate = async (url) => { await send("Page.enable"); const loaded = new Promise((resolve) => { const on = (e) => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", on); resolve(); } }; ws.addEventListener("message", on); }); await send("Page.navigate", { url }); await loaded; };
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const key = async (name, code) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: code === "Delete" ? 46 : 0 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: code === "Delete" ? 46 : 0 }); };
const rect = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
const rects = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, selected: e.classList.contains('selected') }; })`);
const center = async (selector) => { const r = await rect(selector); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };

/** Chrome's screenshots are 8-bit, non-interlaced PNGs: enough of a decoder for a pixel count. */
function decodePng(buffer) {
	assert.equal(buffer.readUInt32BE(12 + 4 - 4), 0x49484452, "IHDR first");
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	const depth = buffer[24];
	const colorType = buffer[25];
	const interlace = buffer[28];
	assert.equal(depth, 8, "8-bit png");
	assert.equal(interlace, 0, "non-interlaced png");
	const channels = { 2: 3, 6: 4 }[colorType];
	assert.ok(channels, `rgb or rgba png (colour type ${colorType})`);
	const idat = [];
	for (let at = 8; at < buffer.length;) {
		const length = buffer.readUInt32BE(at);
		const type = buffer.toString("ascii", at + 4, at + 8);
		if (type === "IDAT") idat.push(buffer.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
		const line = out.subarray(y * stride, (y + 1) * stride);
		for (let i = 0; i < stride; i += 1) {
			const a = i >= channels ? line[i - channels] : 0;
			const b = prior ? prior[i] : 0;
			const c = prior && i >= channels ? prior[i - channels] : 0;
			let value = row[i];
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			line[i] = value & 255;
		}
	}
	return { width, height, channels, data: out };
}

const parseColor = (text) => {
	const m = String(text).trim().match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
	if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
	const hex = String(text).trim().match(/^#([0-9a-f]{6})$/i);
	if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
	throw new Error(`colour: ${text}`);
};

/** Share of the body's pixels within `tolerance` of the accent colour. */
const accentShare = async (accent) => {
	const r = await rect(".objmo .sg-body");
	const s = await send("Page.captureScreenshot", { format: "png", clip: { x: r.x + 1, y: r.y + 1, width: r.width - 2, height: r.height - 2, scale: 1 } });
	const png = decodePng(Buffer.from(s.data, "base64"));
	let hits = 0;
	for (let i = 0; i < png.width * png.height; i += 1) {
		const at = i * png.channels;
		const d = Math.abs(png.data[at] - accent.r) + Math.abs(png.data[at + 1] - accent.g) + Math.abs(png.data[at + 2] - accent.b);
		if (d < 90) hits += 1;
	}
	return { share: hits / (png.width * png.height), width: png.width, height: png.height };
};

const stripShot = async (name) => {
	if (!OUT) return;
	const r = await rect(".tl-track.objmo.sg-row");
	const s = await send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y - 2, width: r.width, height: r.height + 4, scale: 2 } });
	writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, "base64"));
};

const trap = (v) => { let a = 0; for (let i = 0; i < v.length - 1; i += 1) a += (v[i] + v[i + 1]) / 2; return a / (v.length - 1); };
const norm = (v) => { const m = trap(v); return v.map((x) => x / m); };
const spike = norm(Array.from({ length: 24 }, (_, i) => (i >= 8 && i <= 11 ? 5 : 0.5)));
const ramp = norm(Array.from({ length: 24 }, (_, i) => 0.3 + (i / 23) * 2));
const hump = norm(Array.from({ length: 24 }, (_, i) => 1 + 0.9 * Math.sin((Math.PI * i) / 23)));
const timing = { cuts: [{ t: 0.07, d: 0.05 }, { t: 0.4, d: 0.3 }, { t: 0.7, d: 0.75 }], envelopes: [ramp, spike, hump, spike] };
// The fixture's one shot rides a four-point camera rail; give its dolly two cuts.
const dollyTiming = { cuts: [{ t: 0.3, d: 0.2 }, { t: 0.65, d: 0.7 }], envelopes: [hump, spike, ramp] };
const seeded = (() => {
	const parsed = JSON.parse(doc);
	const shot = parsed.scenes[0].shotDocument.shots[0];
	assert.equal(shot.camera?.mode, "rail", "the fixture's shot is on a rail");
	shot.camera.dollyTiming = dollyTiming;
	return JSON.stringify(parsed);
})();

const base = new URL(page.url);
for (const theme of ["light", "dark"]) {
	await navigate(`${base.origin}/favicon.ico`);
	await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.theme.v1', ${JSON.stringify(theme)}); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Speed Graph QA', updatedAt: Date.now() })); localStorage.setItem('cozyclay.scenes.v4', ${JSON.stringify(seeded)}); return true; })()`);
	await navigate(`${base.origin}/app/`);
	await waitFor("hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject) && (window.__cozyclay.objects||[]).length > 100"));
	await waitFor("stage", () => evaluate("Boolean(window.__cclayPropWorld?.['cube'])"));
	await sleep(600);
	assert.equal(await evaluate("document.documentElement.dataset.theme"), theme, `the ${theme} theme is on`);

	/* ---------------------------------------------------------------- 7. */
	await waitFor("shot box dolly curve", () => evaluate("Boolean(document.querySelector('.tl-shot-block .sg-shot .sg-body svg'))"));
	const shotBody = await rect(".tl-shot-block .sg-shot .sg-body");
	const shotPins = await rects(".tl-shot-block .sg-shot .sg-cut-pin");
	assert.equal(shotPins.length, 2, "the dolly curve shows one pin per cut");
	shotPins.forEach((pin, index) => {
		assert.ok(pin.width <= 16 && pin.height <= 16 && pin.width >= 6, `dolly pin ${index} is handle-sized: ${pin.width.toFixed(1)}x${pin.height.toFixed(1)}`);
		const expected = shotBody.x + dollyTiming.cuts[index].t * shotBody.width;
		assert.ok(Math.abs(pin.x + pin.width / 2 - expected) < 1.5, `dolly pin ${index} stands on its cut: ${(pin.x + pin.width / 2).toFixed(1)} vs ${expected.toFixed(1)}`);
	});
	assert.equal(await evaluate("document.querySelectorAll('.tl-shot-block .sg-shot svg path').length"), 0, "no path inside the shot box's stretched viewBox");
	const shotAccent = parseColor(await evaluate("getComputedStyle(document.querySelector('.tl-shot-block .sg-shot .sg-line')).stroke"));
	const shotPainted = await (async () => {
		const s = await send("Page.captureScreenshot", { format: "png", clip: { x: shotBody.x, y: shotBody.y, width: shotBody.width, height: shotBody.height, scale: 1 } });
		const png = decodePng(Buffer.from(s.data, "base64"));
		let hits = 0;
		for (let i = 0; i < png.width * png.height; i += 1) { const at = i * png.channels; if (Math.abs(png.data[at] - shotAccent.r) + Math.abs(png.data[at + 1] - shotAccent.g) + Math.abs(png.data[at + 2] - shotAccent.b) < 90) hits += 1; }
		return hits / (png.width * png.height);
	})();
	if (OUT) {
		const block = await rect(".tl-shot-block");
		const s = await send("Page.captureScreenshot", { format: "png", clip: { x: block.x - 4, y: block.y - 4, width: block.width + 8, height: block.height + 8, scale: 2 } });
		writeFileSync(`${OUT}/speed-graph-${theme}-shot-box.png`, Buffer.from(s.data, "base64"));
	}
	// The box is a dozen pixels tall, so the 2 px line alone is a tenth of it;
	// the stroked pin of old painted all of it.
	assert.ok(shotPainted < 0.3, `the shot box is a curve, not a block of accent (${(shotPainted * 100).toFixed(1)}%)`);
	assert.ok(await evaluate("[...document.querySelectorAll('.tl-shot-block .sg-shot .sg-scale-top, .tl-shot-block .sg-shot .sg-scale-avg, .tl-shot-block .sg-shot .sg-scale-zero')].every((e) => getComputedStyle(e).display === 'none')"), "the box carries no scale marks of its own");
	console.log(`${theme}: shot box ${shotBody.width.toFixed(0)}x${shotBody.height.toFixed(0)}, ${shotPins.length} dolly pins ${shotPins[0].width.toFixed(1)} px, accent ${(shotPainted * 100).toFixed(2)}%`);

	const object = async (id) => (await evaluate("JSON.parse(JSON.stringify(window.__cozyclay.objects))")).find((o) => o.id === id);
	const update = async (id, patch) => { await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(id)}, ...${JSON.stringify(patch)} }); true`); await sleep(400); };
	const row = await waitFor("chassis row", () => center('[data-node-id="object:cube"]'));
	await click(row.x, row.y);
	await waitFor("route strip", () => center('[data-testid="route-add-dot"]'));
	await waitFor("v2 sequencer", () => evaluate("Boolean(document.querySelector('.v2-sequencer .objmo .sg-body svg'))"));
	const frameCount = await evaluate("window.__cozyclay.frameCount");
	const frame = Math.round(frameCount * 0.55);
	await evaluate(`window.__cozyclay.scrub(${frame}); true`);
	await update("cube", { path: { ...(await object("cube")).path, timing } });
	await sleep(500);
	const stored = (await object("cube")).path.timing;
	assert.equal(stored?.cuts?.length, 3, `the timing took its three cuts: ${JSON.stringify(stored?.cuts)}`);
	await stripShot(`speed-graph-${theme}-cuts`);

	/* ------------------------------------------------------------ 1 + 2. */
	const accent = parseColor(await evaluate("getComputedStyle(document.querySelector('.objmo .sg-line')).stroke"));
	const painted = await accentShare(accent);
	console.log(`${theme}: accent ${JSON.stringify(accent)} covers ${(painted.share * 100).toFixed(2)}% of the ${painted.width}x${painted.height} body`);
	assert.ok(painted.share < 0.06, `the body is a graph, not a block of accent (${(painted.share * 100).toFixed(1)}%)`);
	assert.ok(painted.share > 0.003, `the curve is drawn at all (${(painted.share * 100).toFixed(2)}%)`);
	const fills = await evaluate("[...document.querySelectorAll('.objmo .sg-fill')].map((p) => getComputedStyle(p).fill)");
	assert.equal(fills.length, 4, "one area fill per segment");
	for (const fill of fills) assert.ok(parseColor(fill).a < 0.4, `the area fill is a tint: ${fill}`);
	assert.equal(await evaluate("document.querySelectorAll('.objmo .sg-body svg path').length"), 0, "no path is drawn inside the stretched viewBox");

	/* ---------------------------------------------------------------- 3. */
	const body = await rect(".objmo .sg-body");
	const pins = await rects(".objmo .sg-cut-pin");
	assert.equal(pins.length, 3, "one pin head per cut");
	pins.forEach((pin, index) => {
		assert.ok(pin.width <= 16 && pin.height <= 16 && pin.width >= 6, `pin ${index} is handle-sized: ${pin.width.toFixed(1)}x${pin.height.toFixed(1)}`);
		const expected = body.x + stored.cuts[index].t * body.width;
		assert.ok(Math.abs(pin.x + pin.width / 2 - expected) < 1.5, `pin ${index} stands on its cut: ${(pin.x + pin.width / 2).toFixed(1)} vs ${expected.toFixed(1)}`);
		assert.ok(pin.y >= body.y && pin.y + pin.height <= body.y + body.height, `pin ${index} is inside the body`);
	});
	console.log(`   ${pins.length} pins, ${pins[0].width.toFixed(1)}x${pins[0].height.toFixed(1)} px, on their cuts`);

	/* ---------------------------------------------------------------- 4. */
	const playhead = await rect(".v2-sequencer .tl-playhead");
	const expectedX = body.x + (frame / (frameCount - 1)) * body.width;
	assert.ok(Math.abs(playhead.x + playhead.width / 2 - expectedX) < 1.5, `the sequencer playhead crosses the body on the graph's clock: ${(playhead.x + playhead.width / 2).toFixed(1)} vs ${expectedX.toFixed(1)}`);
	assert.equal(await evaluate("getComputedStyle(document.querySelector('.objmo .sg-playhead')).display"), "none", "the graph draws no second playhead");
	const lane = await rect(".objmo.sg-row .tl-lane");
	assert.ok(Math.abs(body.x - lane.x) < 0.5 && Math.abs(body.x + body.width - lane.x - lane.width) < 0.5, "the body spans the lane edge to edge");
	console.log(`   playhead at frame ${frame}: ${(playhead.x + playhead.width / 2).toFixed(1)} px, graph expects ${expectedX.toFixed(1)}`);

	/* ---------------------------------------------------------------- 5. */
	await click(pins[1].x + pins[1].width / 2, pins[1].y + pins[1].height / 2);
	await sleep(250);
	const selected = await rects(".objmo .sg-cut-pin");
	assert.deepEqual(selected.map((p) => p.selected), [false, true, false], "pressing a pin selects its cut");
	await stripShot(`speed-graph-${theme}-selected`);
	await key("Delete", "Delete");
	await sleep(500);
	const afterDelete = (await object("cube")).path.timing;
	assert.equal(afterDelete.cuts.length, 2, `Delete removes the selected cut: ${JSON.stringify(afterDelete.cuts)}`);
	assert.equal((await rects(".objmo .sg-cut-pin")).length, 2, "and its pin");
	console.log(`   pin 2 selected and deleted: ${afterDelete.cuts.length} cuts remain`);

	/* ---------------------------------------------------------------- 6. */
	const marks = await Promise.all([".sg-scale-top", ".sg-scale-avg", ".sg-scale-zero"].map((s) => rect(`.objmo ${s}`)));
	// The compact glass shell hides the average mark; the marks still shown share the edge.
	const lefts = marks.filter((m) => m.width > 0).map((m) => m.x - body.x);
	assert.ok(lefts.length >= 2, `the top and zero marks are shown: ${lefts.length}`);
	assert.ok(lefts.every((l) => Math.abs(l - lefts[0]) < 1 && l < 12), `the scale marks share the left edge: ${lefts.map((l) => l.toFixed(1)).join(", ")}`);
	assert.ok(marks.every((m) => m.width < 60), `the marks are labels, not full-width spans: ${marks.map((m) => m.width.toFixed(0)).join(", ")}`);
	await stripShot(`speed-graph-${theme}-after`);
}

console.log("speed graph browser QA: pins are handle-sized HTML, the fill is a tint, the clock is the ruler's, in both themes");
ws.close();
