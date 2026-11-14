#!/usr/bin/env node
// #1046: a page translator that ignores translate="no" rewrites React's text
// nodes; React's next removeChild / insertBefore on one of them threw
// NotFoundError and the studio fell to the crash screen. The studio installs
// a guard (src/dom-mutation-guard.js) before its first render.
//
// 1. The DOM calls React makes, against nodes a translator wrapped, merged or
//    replaced, in the live studio page.
// 2. A React tree in the same page (Vite's React), translated the way Chrome
//    does it, then re-rendered so React removes and inserts around the
//    translated text.
//   QA_URL=http://127.0.0.1:5561/app/ CDP_PORT=9561 node tools/qa-browser.mjs -- node test/qa-translate-guard-browser.mjs
import assert from "node:assert/strict";

const port = Number(process.env.CDP_PORT || 9222);
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
while (!(await evaluate("!!document.querySelector('canvas')").catch(() => false))) {
	if (Date.now() > deadline) throw new Error("studio did not mount");
	await sleep(250);
}

const guarded = await evaluate("Node.prototype.removeChild.cozyclayGuard === true && Node.prototype.insertBefore.cozyclayGuard === true");
// QA_EXPECT_GUARD=0 runs the React-level case against a build without the guard (the before picture).
const expectGuard = process.env.QA_EXPECT_GUARD !== "0";
if (expectGuard) assert.equal(guarded, true, "the studio installs the DOM mutation guard");

// 1. DOM level: the exact calls React's host config makes.
const dom = !expectGuard ? null : await evaluate(`(() => {
	const font = (text) => { const outer = document.createElement("font"); const inner = document.createElement("font"); inner.textContent = text; outer.append(inner); return outer; };
	const out = {};
	// Replaced: Chrome swaps the text node for <font><font>…</font></font>.
	let host = document.createElement("p"); let text = document.createTextNode("Saved"); host.append(text, document.createElement("b"));
	host.replaceChild(font("已保存"), text);
	try { host.removeChild(text); out.removeReplaced = "ok"; } catch (error) { out.removeReplaced = error.name; }
	try { host.insertBefore(document.createElement("i"), text); out.insertBeforeReplaced = host.lastChild.nodeName; } catch (error) { out.insertBeforeReplaced = error.name; }
	// Moved one level down: the node now lives inside a wrapper of host.
	host = document.createElement("p"); text = document.createTextNode("Play"); host.append(text);
	const wrapper = document.createElement("font"); host.replaceChild(wrapper, text); wrapper.append(text);
	try { host.insertBefore(document.createElement("i"), text); out.insertBeforeMoved = host.firstChild.nodeName; } catch (error) { out.insertBeforeMoved = error.name; }
	try { host.removeChild(text); out.removeMoved = wrapper.childNodes.length; } catch (error) { out.removeMoved = error.name; }
	// A real child still goes through untouched.
	host = document.createElement("p"); const a = document.createElement("a"); host.append(a);
	host.insertBefore(document.createElement("i"), a); host.removeChild(a);
	out.normal = [...host.childNodes].map((n) => n.nodeName).join(",");
	return out;
})()`);
if (expectGuard) assert.deepEqual(dom, { removeReplaced: "ok", insertBeforeReplaced: "I", insertBeforeMoved: "I", removeMoved: 0, normal: "I" }, `guarded DOM calls: ${JSON.stringify(dom)}`);

// 2. React level, when the page can load Vite's React (dev server).
const react = await evaluate(`(async () => {
	let React, ReactDOM;
	try {
		const load = async (path) => { const module = await import(path); return module.default ?? module; };
		React = await load("/node_modules/.vite/deps/react.js");
		ReactDOM = await load("/node_modules/.vite/deps/react-dom_client.js");
	} catch { return { skipped: true }; }
	const h = React.createElement;
	const host = document.createElement("div"); document.body.append(host);
	const errors = [];
	const note = (error) => errors.push(error.name + ": " + String(error.message).slice(0, 80));
	const root = ReactDOM.createRoot(host, { onUncaughtError: note, onCaughtError: note, onRecoverableError: note });
	const view = (state) => h("p", null, state.saving && "Saving", " · ", state.count, " items", state.badge ? h("b", null, "new") : "draft");
	const settle = () => new Promise((done) => setTimeout(done, 60));
	const render = async (state) => { root.render(view(state)); await settle(); };
	await render({ saving: true, count: 1, badge: false });
	// Translate: merge the run of text nodes, then wrap what is left in <font>.
	const p = host.firstChild;
	const texts = [...p.childNodes].filter((n) => n.nodeType === 3);
	const merged = document.createElement("font"); merged.append(document.createElement("font")); merged.firstChild.textContent = "正在保存 · 1 项 草稿";
	p.replaceChild(merged, texts[0]);
	for (const t of texts.slice(1)) p.removeChild(t);
	await render({ saving: false, count: 2, badge: true });
	await render({ saving: true, count: 3, badge: false });
	root.unmount(); host.remove();
	return { errors };
})()`);
if (!expectGuard) {
	console.log(`WITHOUT GUARD React errors: ${JSON.stringify(react.errors)}`);
	if (react.errors.length) process.exitCode = 1;
} else {
	if (react.skipped) console.log("SKIP React-level check: Vite's React modules are not served here (production build)");
	else assert.deepEqual(react.errors, [], `React re-renders over translated text without NotFoundError: ${JSON.stringify(react.errors)}`);
	assert.equal(await evaluate("!!document.querySelector('.crash-screen')"), false, "the studio is not on the crash screen");
	console.log(`PASS translated text nodes: guarded removeChild/insertBefore${react.skipped ? "" : " and React re-renders"} without NotFoundError`);
}
ws.close();
