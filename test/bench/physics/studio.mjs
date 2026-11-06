// Drive one CozyClay Studio for the physics bench: start the dev server with a fresh config home, run a command
// under tools/qa-browser.mjs (headless Chrome, fresh profile), and, inside that command, reach the page over CDP,
// open a project document and call `cclay live`. Kept to what check-sets.mjs (PR 1) and the run harness need.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../../..", import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Headless Chrome falls back to SwiftShader (software WebGL) by default; ANGLE over EGL keeps the GPU (on the bench
// box an RTX 3070), so captures cost what they cost a user. QA_CHROME_FLAGS set by the caller wins.
const GPU_FLAGS = "--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist";

/** Env for one Studio lane: its own config home (agent sessions, providers, live endpoint) and live port. */
export function laneEnv(configHome, livePort, extra = {}) {
	mkdirSync(join(configHome, "cozyclay"), { recursive: true });
	return { ...process.env, QA_CHROME_FLAGS: process.env.QA_CHROME_FLAGS ?? GPU_FLAGS, XDG_CONFIG_HOME: configHome,
		COZYCLAY_CONFIG_DIR: join(configHome, "cozyclay"), COZYCLAY_LIVE_PORT: String(livePort), DO_NOT_TRACK: "1", COZYCLAY_TELEMETRY: "0", ...extra };
}

/** Start tools/dev-full.mjs on `port`; resolves once /app/ answers. Returns a stop() that kills its process group. */
export async function startStudio({ port, env, log }) {
	const fd = openSync(log, "a");
	const child = spawn(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: REPO, env, detached: true, stdio: ["ignore", fd, fd] });
	const stop = async () => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } await sleep(2000); try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
	for (const t0 = Date.now(); Date.now() - t0 < 180_000; await sleep(1000)) {
		if (child.exitCode !== null) throw new Error(`dev server exited (${child.exitCode}), see ${log}`);
		try { if ((await fetch(`http://127.0.0.1:${port}/app/`)).ok) return { stop }; } catch { /* starting */ }
	}
	await stop();
	throw new Error(`dev server on ${port} never answered, see ${log}`);
}

/** Run `node <script> ...args` under tools/qa-browser.mjs against the Studio on `port`. Resolves with the exit code. */
export function underBrowser({ port, cdpPort, env, script, args, log }) {
	const fd = openSync(log, "a");
	const child = spawn(process.execPath, ["tools/qa-browser.mjs", "--", process.execPath, script, ...args],
		{ cwd: REPO, env: { ...env, CDP_PORT: String(cdpPort), QA_URL: `http://127.0.0.1:${port}/app/` }, stdio: ["ignore", fd, fd] });
	return new Promise(res => child.on("exit", code => res(code)));
}

/** The page behind CDP_PORT: { send, ev, close }. */
export async function connectPage(cdpPort = Number(process.env.CDP_PORT)) {
	for (const t0 = Date.now(); Date.now() - t0 < 30_000; await sleep(300)) {
		let page;
		try { page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === "page" && t.webSocketDebuggerUrl); } catch { continue; }
		if (!page) continue;
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let next = 1;
		const pending = new Map();
		ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
		const send = (method, params = {}) => new Promise(res => { const id = next++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
		const ev = async expr => {
			const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
			if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
			return r.result?.result?.value;
		};
		return { send, ev, close: () => ws.close() };
	}
	throw new Error(`no page on CDP ${cdpPort}`);
}

export async function waitFor(ev, expr, ms) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) if (await ev(expr).catch(() => false)) return true;
	return false;
}

const READY = "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclayProject?.open)";

/** Make the page an Animation project with rigged cast (one reload), then open `doc`. */
export async function openDocument(page, doc) {
	const { send, ev } = page;
	await send("Page.enable");
	if (!(await waitFor(ev, READY, 120_000))) throw new Error("the Studio did not load");
	await ev(`localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: ${JSON.stringify(doc.name)}, previsMode: "animation", castStyle: "rig", updatedAt: Date.now() })); true`);
	await send("Page.reload", {});
	await sleep(3000);
	if (!(await waitFor(ev, READY, 120_000))) throw new Error("the Studio did not load after reload");
	const opened = await ev(`window.__cozyclayProject.open(${JSON.stringify(JSON.stringify(doc))}).then(r => ({ ok: r.ok, problems: r.problems ?? null }))`);
	if (!opened?.ok) throw new Error(`the document did not open: ${JSON.stringify(opened)}`);
	return opened;
}

/** `cclay live <args>` against the hub on `livePort`, parsed JSON (or { error }). */
export function cclayLive(livePort, ...args) {
	try {
		return JSON.parse(execFileSync(process.execPath, [join(REPO, "bin/cozyclay.mjs"), "live", ...args],
			{ env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) }, encoding: "utf8", timeout: 180_000, maxBuffer: 1 << 28 }));
	} catch (e) { return { error: String(e.stdout || e.message).slice(0, 600) }; }
}
