#!/usr/bin/env node
// Browser timings of the handle poser core (onnxruntime-web WASM): model load cold and cached, network per call,
// IK and full solve on the Y Bot. Needs a dev server with the model at public/models/cozy-poser-v1.onnx:
//   npx vite --host 127.0.0.1 --port 5199 &
//   QA_URL=http://127.0.0.1:5199/ CDP_PORT=9333 node tools/qa-browser.mjs -- node tools/qa-poser-bench.mjs
const port = Number(process.env.CDP_PORT || 9222), runs = Number(process.env.POSER_BENCH_RUNS || 128);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map(), events = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method) events.push(message.method);
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(source) {
	const out = await send("Runtime.evaluate", { expression: `(async () => { ${source} })()`, awaitPromise: true, returnByValue: true });
	if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
	return out.result.value;
}
const reload = async () => {
	await send("Page.enable");
	events.length = 0;
	await send("Page.reload", { ignoreCache: false });
	while (!events.includes("Page.loadEventFired")) await new Promise((r) => setTimeout(r, 50));
};

const stats = `const stats = (xs) => { const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0] }; };`;
const load = `
	const { createWebNetwork } = await import("/src/poser/ort-web.js");
	const t = performance.now(); const net = await createWebNetwork(); const loadMs = performance.now() - t;
	globalThis.__poserNet = net;
	return { loadMs, ...net.info, crossOriginIsolated: globalThis.crossOriginIsolated, cores: navigator.hardwareConcurrency, ua: navigator.userAgent };`;

await reload();
await evaluate(`const { POSER_MODEL } = await import("/src/poser/config.js"); await caches.delete(POSER_MODEL.cacheName); return true;`);
const cold = await evaluate(load);
const measured = await evaluate(`${stats}
	const net = globalThis.__poserNet;
	const { createPoser } = await import("/src/poser/poser.js");
	const { characterFromRigJson } = await import("/src/poser/ybot.js");
	const { CASES } = await import("/test/poser/poser-cases.mjs");
	// the network inputs of the authored test cases, captured from one solve each
	const inputs = [], character = characterFromRigJson();
	const spy = createPoser({ network: { run: (x) => { inputs.push(x); return net.run(x); } } });
	for (const c of CASES) await spy.solve(c.sends, character, c.options);
	for (let i = 0; i < 8; i += 1) await net.run(inputs[i % inputs.length]);
	const netMs = [];
	for (let i = 0; i < ${runs}; i += 1) { const t = performance.now(); await net.run(inputs[i % inputs.length]); netMs.push(performance.now() - t); }
	const base = CASES.find((c) => c.name === "left hand forward").sends;
	const poser = createPoser({ network: net });
	const keys = ["networkMs", "ikMs", "floorMs", "writeMs", "totalMs"], series = Object.fromEntries(keys.map((k) => [k, []]));
	for (let i = 0; i < 8 + ${runs}; i += 1) {
		// a 30 cm left-hand drag forward and up, one step per solve
		const s = (i % 32) / 31, sends = base.map((h) => h.id === "leftHand" ? { ...h, position: [h.position[0] - 0.2 * s, h.position[1] + 0.1 * s, h.position[2] + 0.2 * s] } : h);
		const r = await poser.solve(sends, character);
		if (!r.ok) throw new Error(r.reason);
		if (i >= 8) for (const k of keys) series[k].push(r.timings[k]);
	}
	return { network: stats(netMs), solve: Object.fromEntries(keys.map((k) => [k, stats(series[k])])) };`);
await reload();
const cached = await evaluate(load);
ws.close();
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));
console.log(JSON.stringify(round({ cold, cached, ...measured }), null, 1));
