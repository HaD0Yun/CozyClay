// One CDP observer spans seeding and the suite, so a failed reload keeps its
// request URLs, response status, transport error and navigation context.
export async function browserSession(port, timeoutMs, events) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) })).json();
	const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("QA browser exposed no page target to seed");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map(), requests = new Map();
	let seq = 0;
	const record = entry => {
		events.push({ at: new Date().toISOString(), ...entry });
		if (events.length > 2000) events.shift();
	};
	const closed = () => {
		for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("QA browser CDP closed")); }
		pending.clear();
	};
	ws.addEventListener("close", closed);
	ws.addEventListener("message", event => {
		const message = JSON.parse(event.data);
		const request = pending.get(message.id);
		if (request) {
			pending.delete(message.id);
			clearTimeout(request.timer);
			if (message.error) request.reject(new Error(JSON.stringify(message.error)));
			else request.resolve(message.result);
		}
		const p = message.params;
		if (message.method === "Network.requestWillBeSent") {
			requests.set(p.requestId, { url: p.request.url, loaderId: p.loaderId, frameId: p.frameId, type: p.type });
			if (requests.size > 2000) requests.delete(requests.keys().next().value);
		} else if (message.method === "Network.responseReceived") {
			const row = requests.get(p.requestId);
			if (row) Object.assign(row, { status: p.response.status, statusText: p.response.statusText });
			if (p.response.status >= 400) record({ method: message.method, requestId: p.requestId, ...row,
				url: p.response.url, status: p.response.status, statusText: p.response.statusText });
		} else if (message.method === "Network.loadingFailed") {
			record({ method: message.method, ...requests.get(p.requestId), ...p });
			requests.delete(p.requestId);
		} else if (message.method === "Network.loadingFinished") {
			const row = requests.get(p.requestId);
			if (row?.url.includes("/models/")) record({ method: message.method, ...row, ...p });
			requests.delete(p.requestId);
		} else if (message.method === "Page.frameNavigated") {
			record({ method: message.method, url: p.frame.url, frameId: p.frame.id, loaderId: p.frame.loaderId });
		} else if (message.method === "Runtime.exceptionThrown") {
			record({ method: message.method, text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text });
		}
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { ws.close(); reject(new Error("QA browser CDP websocket timed out")); }, timeoutMs);
		ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
		ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("QA browser CDP websocket failed")); }, { once: true });
	});
	const send = (method, params = {}, deadline = timeoutMs) => new Promise((resolve, reject) => {
		const id = ++seq;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`QA browser CDP command timed out: ${method}`)); }, deadline);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression, deadline) => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, deadline);
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result.result.value;
	};
	const navigate = async url => {
		let listener, timer;
		const loaded = new Promise((resolve, reject) => {
			listener = event => { if (JSON.parse(event.data).method === "Page.loadEventFired") resolve(); };
			ws.addEventListener("message", listener);
			timer = setTimeout(() => reject(new Error(`QA browser navigation timed out: ${url}`)), timeoutMs);
		});
		// Navigation may fail before the load event; keep its rejection observed.
		loaded.catch(() => {});
		try {
			const result = await send("Page.navigate", { url });
			if (result.errorText) throw new Error(`QA browser navigation failed: ${url}: ${result.errorText}`);
			await loaded;
		} finally {
			clearTimeout(timer);
			ws.removeEventListener("message", listener);
		}
	};
	try {
		for (const method of ["Page.enable", "Network.enable", "Runtime.enable"]) await send(method);
	} catch (error) {
		ws.close();
		throw error;
	}
	return { send, evaluate, navigate, close: () => { closed(); ws.close(); } };
}
