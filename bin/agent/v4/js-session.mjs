// A persistent JavaScript session for one conversation: ONE long-running pi-codemode QuickJS
// execution used as a REPL. The VM stays alive between cells because the REPL loop awaits the
// host global __next; each cell answers through __done. Top-level declarations that start a line
// are kept on globalThis, so state survives between calls. A timeout, an abort or a VM crash
// ends the VM; the next call starts a fresh one (rig and the host functions come back).

const RESET_TEXT = "The js session was reset: every kept name is gone; rig and the host functions are back.";
const RESERVED = ["console", "text", "__grab", "__next", "__done", "rig", "track", "measure", "render", "qa", "tools", "ALL_TOOLS", "image", "exit", "store", "load"];
const LIMITS = { stdout: 1024 * 1024, typed: 200000 };
const ABORT_GRACE_MS = 2000;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Runs inside QuickJS (its source text is shipped), so it uses only its arguments and globals.
async function replMain(reserved, limits) {
	const NAMES = /^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
	const skip = new Set(reserved);
	let out = null;
	const fnName = f => `[function ${f.name || "anonymous"}]`;
	const show = v => {
		if (typeof v === "string") return v;
		try {
			const s = JSON.stringify(v, (k, x) => (typeof x === "function" ? fnName(x) : ArrayBuffer.isView(x) && "length" in x ? Array.from(x) : x));
			return s === undefined ? String(v) : s;
		} catch { return String(v); }
	};
	const write = line => {
		if (!out || out.cut) return;
		if (out.size + line.length > limits.stdout) { out.lines.push(`[stdout cut at ${limits.stdout} chars]`); out.cut = true; return; }
		out.size += line.length + 1;
		out.lines.push(line);
	};
	const log = (...a) => write(a.map(show).join(" "));
	// one console for every cell: a kept function that logs writes to the cell that calls it
	const con = { log, info: log, warn: log, error: log, debug: log };
	const text = v => write(show(v));
	const plain = (v, stack) => {
		if (v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number") return v;
		if (v === undefined) return undefined;
		if (typeof v === "function") return fnName(v);
		if (typeof v !== "object") return String(v);
		if (ArrayBuffer.isView(v)) {
			if (!("length" in v)) return { type: v.constructor.name, byteLength: v.byteLength };
			return v.length <= limits.typed ? Array.from(v, Number) : { type: v.constructor.name, length: v.length, head: Array.from(v.subarray(0, 8), Number) };
		}
		if (stack.includes(v)) return "[circular]";
		stack.push(v);
		let res;
		if (Array.isArray(v)) res = v.map(x => { const p = plain(x, stack); return p === undefined ? null : p; });
		else if (v instanceof Map) res = plain(Object.fromEntries(v), stack);
		else if (v instanceof Set) res = plain([...v], stack);
		else if (typeof v.toJSON === "function") res = plain(v.toJSON(), stack);
		else {
			res = {};
			for (const k of Object.keys(v)) { const p = plain(v[k], stack); if (p !== undefined) res[k] = p; }
		}
		stack.pop();
		return res;
	};
	const top = v => (v === undefined ? null : v !== null && typeof v === "object" ? plain(v, []) : { value: plain(v, []) });
	const errorOf = (e, headLength) => {
		const stack = String(e?.stack ?? ""), m = /<input>:(\d+):(\d+)/.exec(stack);
		const line = m ? Number(m[1]) : null, column = m ? (line === 1 ? Math.max(1, Number(m[2]) - headLength) : Number(m[2])) : null;
		const isObj = e !== null && typeof e === "object";
		return { name: isObj && e.name ? String(e.name) : "Error", message: isObj && "message" in e ? String(e.message) : String(e), line, column,
			stack: stack.split("\n").filter(l => l.includes("<input>")).map(l => l.trim()).join("\n") };
	};
	for (;;) {
		const cell = await globalThis.__next();
		if (!cell || cell.stop) return;
		out = { lines: [], size: 0, cut: false };
		const names = [];
		for (const m of cell.code.matchAll(NAMES)) if (!skip.has(m[1]) && !names.includes(m[1])) names.push(m[1]);
		const keep = names.map(n => `${JSON.stringify(n)}: (() => { try { return ${n}; } catch { return undefined; } })()`).join(", ");
		const head = `(async (console, text, __grab) => { __grab(() => ({${keep}})); `;
		let ok = true, value = null, error = null, grab = null;
		try {
			const fn = (0, eval)(`${head}${cell.code}\n})`);
			value = top(await fn(con, text, g => { grab = g; }));
		} catch (e) { ok = false; error = errorOf(e, head.length); }
		const kept = [];
		if (grab) {
			const got = grab();
			for (const n of names) if (got[n] !== undefined) { globalThis[n] = got[n]; kept.push(n); }
		}
		const stdout = out.lines;
		out = null;
		await globalThis.__done({ id: cell.id, ok, value, stdout, error, kept });
	}
}

const errorText = (name, message) => ({ name, message, line: null, column: null, stack: "" });

/**
 * createJsSession({ prelude, host, memoryLimitBytes, loadSandbox })
 *   prelude: JS source run once per VM (the js tool assigns the rig library to globalThis.rig), or a function that
 *            answers it, read at each VM start (the rig's scene may change between turns)
 *   host:    { [name]: (args) => Promise<V4Result> } exposed as top-level async globals; they return result.data
 * -> { run(code, { timeoutMs, signal }) -> Promise<CellResult>, reset(reason), close(), live (a VM is running) }
 */
export function createJsSession({ prelude = "", host = {}, memoryLimitBytes = 512 * 1024 * 1024, loadSandbox = () => import("@earendil-works/pi-codemode") } = {}) {
	for (const name of Object.keys(host)) {
		if (!IDENTIFIER.test(name) || ["__next", "__done", "console", "text", "image", "exit", "store", "load", "tools", "ALL_TOOLS"].includes(name)) throw new Error(`js session: bad host function name "${name}"`);
	}
	const source = () => `${typeof prelude === "function" ? prelude() : prelude}\n;await (${replMain.toString()})(${JSON.stringify(RESERVED)}, ${JSON.stringify(LIMITS)});\n`;
	let vm = null, chain = Promise.resolve(), closed = false, nextId = 0, pendingReset = null, current = null;

	async function callHost(name, fn, args) {
		const cell = current, t0 = performance.now();
		let res;
		try { res = await fn(args ?? {}); }
		catch (error) {
			cell?.calls.push({ name, ms: Math.round(performance.now() - t0), ok: false });
			throw new Error(error?.message ?? String(error), { cause: error });
		}
		const ok = !res?.isError;
		cell?.calls.push({ name, ms: Math.round(performance.now() - t0), ok });
		if (cell && Array.isArray(res?.images)) cell.images.push(...res.images);
		if (!ok) throw new Error(res?.text || `${name} failed`);
		return res?.data ?? null;
	}

	async function start() {
		const { CodemodeSandbox } = await loadSandbox();
		const v = { inbox: [], waiter: null, cells: new Map(), dead: null, controller: new AbortController() };
		const globals = [
			{ name: "__next", execute: () => new Promise(resolve => { if (v.inbox.length) resolve(v.inbox.shift()); else v.waiter = resolve; }) },
			{ name: "__done", execute: r => { const cb = v.cells.get(r?.id); if (cb) { v.cells.delete(r.id); cb(r); } return true; } },
			...Object.entries(host).map(([name, fn]) => ({ name, execute: args => callHost(name, fn, args) })),
		];
		const sandbox = new CodemodeSandbox({ timeoutMs: Infinity, memoryLimitBytes, globals });
		v.ended = sandbox.execute(source(), { timeoutMs: Infinity, signal: v.controller.signal }).then(result => {
			v.dead = result.ok ? errorText("SessionEnded", "The js session ended (exit() or the REPL returned).")
				: errorText(result.error.kind === "script" ? "SessionStart" : "SessionEnded", `The js session stopped (${result.error.kind}): ${result.error.message}`);
			for (const cb of v.cells.values()) cb(null);
			v.cells.clear();
		});
		v.post = cell => { const w = v.waiter; v.waiter = null; if (w) w(cell); else v.inbox.push(cell); };
		return v;
	}

	const kill = v => { if (v && !v.dead) v.dead = errorText("SessionEnded", "The js session was stopped."); v?.controller.abort(); for (const cb of v?.cells.values() ?? []) cb(null); v?.cells.clear(); };

	async function runCell(code, { timeoutMs = 120000, signal } = {}) {
		if (closed) throw new Error("The js session is closed.");
		const t0 = performance.now(), limit = Math.min(600000, Math.max(1000, Number(timeoutMs) || 120000));
		let reset = pendingReset;
		pendingReset = null;
		if (!vm || vm.dead) { if (vm?.dead) reset ??= RESET_TEXT; vm = await start(); }
		const v = vm, id = ++nextId, extras = { images: [], calls: [] };
		current = extras;
		const answer = new Promise(resolve => v.cells.set(id, resolve));
		if (v.dead) v.cells.get(id)?.(null);
		v.post({ id, code });
		let timer, onAbort;
		const waits = [answer.then(r => (r ? { r } : { dead: true })), new Promise(res => { timer = setTimeout(() => res({ timeout: true }), limit); })];
		if (signal) waits.push(new Promise(res => { onAbort = () => res({ aborted: true }); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }));
		let outcome = await Promise.race(waits);
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
		if (outcome.aborted) outcome = await Promise.race([waits[0], new Promise(res => setTimeout(() => res(outcome), ABORT_GRACE_MS))]);
		current = null;
		const ms = Math.round(performance.now() - t0);
		if (outcome.r) {
			const r = outcome.r;
			return { ok: r.ok, value: r.value, stdout: r.stdout ?? [], ...(r.ok ? {} : { error: r.error }), kept: r.kept ?? [], calls: extras.calls, images: extras.images, ms, ...(reset ? { reset } : {}) };
		}
		let error = v.dead ?? errorText("SessionEnded", "The js session stopped.");
		if (outcome.timeout) error = errorText("Timeout", `The cell ran past its ${limit} ms timeout and was stopped.`);
		if (outcome.aborted) error = errorText("Aborted", "The call was aborted and the cell was stopped.");
		kill(v);
		if (vm === v) vm = null;
		return { ok: false, value: null, stdout: [], error, kept: [], calls: extras.calls, images: extras.images, ms, reset: RESET_TEXT };
	}

	return {
		/** True while a VM is running: a prelude change reaches it only through a cell. */
		get live() { return Boolean(vm && !vm.dead); },
		/** Run one cell; parallel calls queue in order. */
		run(code, options) {
			const p = chain.then(() => runCell(code, options));
			chain = p.catch(() => {});
			return p;
		},
		/** Drop the VM; the next call starts a fresh one and says why. */
		reset(reason) {
			pendingReset = reason ? `The js session was reset (${reason}): every kept name is gone; rig and the host functions are back.` : RESET_TEXT;
			kill(vm);
			vm = null;
		},
		/** Stop the VM for good. */
		async close() {
			closed = true;
			const v = vm;
			vm = null;
			kill(v);
			await v?.ended;
		},
	};
}
