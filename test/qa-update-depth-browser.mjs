#!/usr/bin/env node
// #1045: React "Maximum update depth exceeded" (#185) during playback on a
// busy main thread. Every playback frame is a sync commit (the frame store
// feeds useSyncExternalStore). A passive effect that schedules a React update
// after each of those commits leaves work pending, and React counts each such
// commit as nested until its scheduler task gets to run. Chrome runs input and
// rendering ahead of that normal-priority task when the page is busy, so the
// count reached 50 and the next frame threw. With an empty cast the fallback
// character was a new object per render, which re-ran App's dirty check (and
// its setState) after every frame.
//
// The suite plays the starved case directly: frame steps posted as
// user-blocking tasks, which Chrome runs before React's scheduler task, the
// way it runs pointer input on a busy page.
//   QA_URL=http://127.0.0.1:5561/app/ CDP_PORT=9561 node tools/qa-browser.mjs -- node test/qa-update-depth-browser.mjs
import assert from "node:assert/strict";

const port = Number(process.env.CDP_PORT || 9222);
const STEPS = Number(process.env.QA_UPDATE_DEPTH_STEPS || 150);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA browser exposes a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { nextId += 1; pending.set(nextId, resolve); ws.send(JSON.stringify({ id: nextId, method, params })); });
const evaluate = async (expression) => {
	const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
	return result?.result?.value;
};

const deadline = Date.now() + 60_000;
while (!(await evaluate("!!(window.__cozyclay && window.__cozyclay.setFrame)").catch(() => false))) {
	if (Date.now() > deadline) throw new Error("studio did not expose window.__cozyclay.setFrame");
	await sleep(250);
}
await sleep(1500);

const castSize = await evaluate("window.__cozyclay.characters.length");
assert.equal(castSize, 0, "the QA session starts with an empty cast (the case that re-ran the dirty check every frame)");

const run = await evaluate(`(async () => {
	if (typeof scheduler === "undefined" || typeof scheduler.postTask !== "function") return { skipped: "no scheduler.postTask" };
	const errors = [];
	const onError = (event) => errors.push(String(event.error?.message ?? event.message));
	addEventListener("error", onError);
	let steps = 0, thrown = null;
	try {
		for (let i = 0; i < ${STEPS}; i++) {
			await scheduler.postTask(() => window.__cozyclay.setFrame(i % 200), { priority: "user-blocking" });
			steps = i + 1;
		}
	} catch (error) {
		thrown = String(error?.message ?? error);
	}
	await new Promise((done) => setTimeout(done, 300));
	removeEventListener("error", onError);
	window.__cozyclay.setFrame(0);
	return { steps, thrown, errors };
})()`);
assert.ok(!run.skipped, `this Chrome has scheduler.postTask (${run.skipped})`);
const depth = /Maximum update depth|Minified React error #185/;
assert.ok(!depth.test(run.thrown ?? ""), `no React #185 while frames outrun React's scheduler (threw after ${run.steps} steps: ${run.thrown})`);
assert.equal(run.thrown, null, `frame steps run clean (${run.thrown})`);
assert.equal(run.steps, STEPS);
assert.deepEqual(run.errors.filter((message) => depth.test(message)), [], "no #185 reaches window error");
console.log(`PASS ${STEPS} starved playback frames with an empty cast: no React #185`);
ws.close();
