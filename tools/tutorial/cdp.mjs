// Raw-WebSocket CDP client for the tutorial recorder: the same pattern the
// browser suites use (test/qa-shell-start-browser.mjs), packaged
// so the recorder can also listen for screencast events.

export async function connectPage(port) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("no page target on the QA browser");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 1;
	const pending = new Map();
	const listeners = new Map();
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
	const on = (method, listener) => {
		if (!listeners.has(method)) listeners.set(method, new Set());
		listeners.get(method).add(listener);
		return () => listeners.get(method).delete(listener);
	};
	const once = (method, timeoutMs = 30000) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
		const off = on(method, (params) => { clearTimeout(timer); off(); resolve(params); });
	});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
		return result.result.value;
	};
	/** Resolve true once `condition` (a page expression) holds, false on timeout. */
	const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
		const started = performance.now();
		const tick = () => {
			let value = false;
			try { value = Boolean(${condition}); } catch {}
			if (value) resolve(true);
			else if (performance.now() - started > ${timeoutMs}) resolve(false);
			else setTimeout(tick, 50);
		};
		tick();
	})`);
	return { send, on, once, evaluate, waitFor, close: () => ws.close() };
}
