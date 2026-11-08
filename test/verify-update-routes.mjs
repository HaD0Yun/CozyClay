#!/usr/bin/env node
/**
 * GET and POST /__cozyclay/update over real HTTP, with a mock registry that
 * answers 3.9.9 (COZYCLAY_REGISTRY_URL) and a fake npm (COZYCLAY_NPM_BIN).
 *
 * The handler factory is mounted on a loopback server per case, so each case
 * starts from a fresh install state. Nothing touches the real registry, the
 * real npm or the user's config: state lives in temp dirs.
 *
 * POST /__cozyclay/update/restart (#960): its gating, and the real restarter
 * with an SSE stream held open, a real live hub with a client attached, and
 * test/fixtures/fake-launcher.mjs as the new launcher on the same port.
 *
 * Run: `node test/verify-update-routes.mjs`.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request, createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lookupLatest, updateChecksOn } from "../bin/update-check.mjs";
import { canSelfUpdate, createInstaller, globalLauncherPath } from "../bin/update-install.mjs";
import { createUpdateRoutes } from "../bin/update-routes.mjs";
import { RESTART_FALLBACK, closeServer, createRestarter } from "../bin/update-restart.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_NPM = join(ROOT, "test", "fixtures", "fake-npm.mjs");
const FAKE_LAUNCHER = join(ROOT, "test", "fixtures", "fake-launcher.mjs");
const CURRENT = "3.1.4";

function pass(message) {
	console.log(`PASS ${message}`);
}

const temp = mkdtempSync(join(tmpdir(), "cozyclay-update-routes-"));
const globalRoot = join(temp, "lib", "node_modules");
const globalPkg = join(globalRoot, "cozyclay");
const localPkg = join(temp, "project", "node_modules", "cozyclay");
mkdirSync(globalPkg, { recursive: true });
mkdirSync(localPkg, { recursive: true });
const npmLog = join(temp, "npm.log");
const gate = join(temp, "gate");
const savedEnv = { ...process.env };
process.env.XDG_CONFIG_HOME = join(temp, "config");
process.env.COZYCLAY_NPM_BIN = FAKE_NPM;
process.env.FAKE_NPM_ROOT = globalRoot;
process.env.FAKE_NPM_LOG = npmLog;

const registry = { version: "3.9.9", requests: 0 };
const registryServer = createServer((req, res) => {
	registry.requests += 1;
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ version: registry.version }));
});
await new Promise((resolve) => registryServer.listen(0, "127.0.0.1", resolve));
process.env.COZYCLAY_REGISTRY_URL = `http://127.0.0.1:${registryServer.address().port}/cozyclay/latest`;

const mounted = [];
let stateDirs = 0;

/** One launcher's update routes on a fresh port, state dir and installer. */
async function mount({ kind = "global", enabled = true, pkgRoot = globalPkg, current = CURRENT, selfUpdate, timeoutMs, restarter, stateDir = join(process.env.XDG_CONFIG_HOME, `cozyclay-${(stateDirs += 1)}`) } = {}) {
	let handler = null;
	// /sse is a stream that never ends on its own, like the agent pane's.
	const server = createServer((req, res) => {
		if (req.url === "/sse") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": open\n\n"); return; }
		void handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	handler = createUpdateRoutes({
		currentVersion: current,
		checkLatest: () => lookupLatest(current, stateDir),
		kind,
		enabled,
		port,
		canSelfUpdate: selfUpdate ?? (() => canSelfUpdate({ pkgRoot, platform: "darwin" })),
		installer: createInstaller(timeoutMs ? { timeoutMs } : {}),
		restarter: typeof restarter === "function" ? restarter(port, server) : restarter,
	});
	mounted.push(server);
	const origin = `http://127.0.0.1:${port}`;
	return {
		port,
		origin,
		server,
		restart: (headers = { origin }, method = "POST") => call(port, method, headers, undefined, "/__cozyclay/update/restart"),
		get: (headers = {}) => call(port, "GET", headers),
		post: (headers = { origin }, body) => call(port, "POST", headers, body),
		async settle() {
			const deadline = Date.now() + 5000;
			for (;;) {
				const { body } = await call(port, "GET");
				if (body.phase !== "updating") return body;
				assert.ok(Date.now() < deadline, "the install settles within 5 s");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		},
	};
}

function call(port, method, headers = {}, body, path = "/__cozyclay/update") {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				text += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

function installs() {
	try {
		return readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function resetNpm(mode = "ok") {
	rmSync(npmLog, { force: true });
	rmSync(gate, { force: true });
	process.env.FAKE_NPM_MODE = mode;
	delete process.env.FAKE_NPM_GATE;
}

try {
	/* ---------------------------------------------------------- GET ---- */

	resetNpm();
	let route = await mount();
	let res = await route.get();
	assert.equal(res.status, 200);
	assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
	assert.equal(res.headers["cache-control"], "no-store");
	assert.deepEqual(res.body, {
		enabled: true,
		current: CURRENT,
		latest: "3.9.9",
		status: "outdated",
		kind: "global",
		canSelfUpdate: true,
		phase: "idle",
		errorClass: null,
		durationMs: null,
		installed: null,
		notesUrl: "https://github.com/HaD0Yun/CozyClay/releases/tag/v3.9.9",
		command: "npm install -g cozyclay@latest",
	});
	assert.equal((await route.get({ origin: route.origin })).status, 200);
	assert.equal((await route.get({ origin: `http://localhost:${route.port}` })).status, 200);
	res = await route.get({ origin: "http://evil.test" });
	assert.equal(res.status, 403);
	assert.deepEqual(res.body, { error: "forbidden origin" });
	assert.equal((await route.get({ host: `evil.test:${route.port}` })).status, 403, "no Origin needs a loopback Host");
	assert.equal((await call(route.port, "PUT", { origin: route.origin })).status, 405);
	assert.deepEqual(installs(), [], "GET never installs");
	pass("GET answers every contract field, no-store, and the /oauth Origin rule");

	// A read-only config dir: the cache write fails, the fetched answer must still stand.
	const readOnlyHome = join(temp, "read-only-config");
	mkdirSync(readOnlyHome);
	chmodSync(readOnlyHome, 0o555);
	try {
		route = await mount({ stateDir: join(readOnlyHome, "cozyclay") });
		registry.requests = 0;
		res = await route.get();
		assert.equal(existsSync(join(readOnlyHome, "cozyclay")), false, "the state dir could not be created");
		assert.deepEqual([res.body.latest, res.body.status, res.body.notesUrl], ["3.9.9", "outdated", "https://github.com/HaD0Yun/CozyClay/releases/tag/v3.9.9"], "a good fetch is not lost to a failed cache write");
		await route.get();
		assert.equal(registry.requests, 1, "the in-memory answer serves the TTL, so polls do not refetch");
	} finally {
		chmodSync(readOnlyHome, 0o755);
	}
	pass("an unwritable state dir keeps the fetched latest in memory: GET reads 3.9.9 outdated, one registry request");

	/* --------------------------------------------------- POST Origin ---- */

	for (const headers of [{}, { origin: "http://evil.test" }, { origin: `http://localhost:${route.port}` }, { origin: "null" }]) {
		res = await route.post(headers);
		assert.equal(res.status, 403, JSON.stringify(headers));
		assert.deepEqual(res.body, { error: "forbidden origin" });
	}
	assert.equal((await route.get()).body.phase, "idle");
	assert.deepEqual(installs(), [], "a rejected POST starts nothing");
	pass("POST without, or with any other than, the exact 127.0.0.1 Origin is 403 and installs nothing");

	/* ------------------------------------ idempotent POST + transitions ---- */

	resetNpm("ok");
	process.env.FAKE_NPM_GATE = gate;
	res = await route.post({ origin: route.origin, "content-type": "application/json" }, JSON.stringify({ version: "1.0.0; touch /tmp/pwned" }));
	assert.equal(res.status, 202);
	assert.equal(res.body.phase, "updating");
	assert.equal(res.body.durationMs, null);
	assert.equal(res.body.installed, "3.9.9", "GET names the version npm is installing");
	res = await route.post();
	assert.equal(res.status, 202, "a second POST while updating is accepted");
	assert.equal(res.body.phase, "updating");
	writeFileSync(gate, "");
	let settled = await route.settle();
	assert.equal(settled.phase, "restart_needed");
	assert.equal(settled.errorClass, null);
	assert.equal(settled.installed, "3.9.9", "restart_needed keeps naming the installed version: the restart target");
	assert.ok(Number.isFinite(settled.durationMs) && settled.durationMs >= 0);
	assert.deepEqual(installs(), [["install", "-g", "cozyclay@3.9.9", "--engine-strict"]], "one install, pinned to the exact registry version; the body is ignored");
	res = await route.post();
	assert.equal(res.status, 202);
	assert.equal(res.body.phase, "restart_needed");
	assert.equal(installs().length, 1, "restart_needed starts nothing new");
	pass("POST runs one pinned install: idle -> updating -> restart_needed, idempotent while busy or done");

	/* ------------------------------------------------ 5 error classes ---- */

	for (const [mode, errorClass] of [["eacces", "permission"], ["network", "network"], ["node_version", "node_version"], ["other", "other"]]) {
		resetNpm(mode);
		route = await mount();
		assert.equal((await route.post()).status, 202);
		settled = await route.settle();
		assert.equal(settled.phase, "failed", mode);
		assert.equal(settled.errorClass, errorClass, mode);
		assert.ok(Number.isFinite(settled.durationMs));
	}
	resetNpm("ok");
	res = await route.post();
	assert.equal(res.status, 202, "a failed install may be retried");
	assert.equal(res.body.errorClass, null);
	settled = await route.settle();
	assert.equal(settled.phase, "restart_needed");

	resetNpm("ok");
	process.env.COZYCLAY_NPM_BIN = join(temp, "no-such-npm");
	route = await mount({ selfUpdate: async () => true });
	assert.equal((await route.post()).status, 202);
	settled = await route.settle();
	process.env.COZYCLAY_NPM_BIN = FAKE_NPM;
	assert.equal(settled.phase, "failed");
	assert.equal(settled.errorClass, "npm_missing");

	resetNpm("hang");
	route = await mount({ timeoutMs: 300 });
	assert.equal((await route.post()).status, 202);
	settled = await route.settle();
	assert.equal(settled.phase, "failed");
	assert.equal(settled.errorClass, "other", "the install ceiling kills npm and fails as other");
	pass("failed installs report permission, network, node_version, npm_missing and other, and can be retried");

	/* -------------------------------------------- disabled (CI) checks ---- */

	resetNpm("ok");
	route = await mount({ enabled: updateChecksOn(true, { CI: "true" }) });
	res = await route.get();
	assert.equal(res.status, 200);
	assert.deepEqual(res.body, {
		enabled: false,
		current: CURRENT,
		latest: null,
		status: "unknown",
		kind: "global",
		canSelfUpdate: false,
		phase: "idle",
		errorClass: null,
		durationMs: null,
		installed: null,
		notesUrl: null,
		command: "npm install -g cozyclay@latest",
	});
	res = await route.post();
	assert.equal(res.status, 403);
	assert.deepEqual(res.body, { error: "update checks are disabled" });
	assert.equal((await route.post({ origin: "http://evil.test" })).body.error, "forbidden origin", "Origin is checked first");
	assert.equal(updateChecksOn(true, { COZYCLAY_NO_UPDATE_CHECK: "1" }), false);
	assert.equal(updateChecksOn(false, {}), false);
	assert.equal(updateChecksOn(true, {}), true);
	assert.deepEqual(installs(), []);
	pass("with CI set, GET says enabled: false and POST is 403");

	/* ------------------------------------- cclay update --off: the switch ---- */

	const offDir = join(process.env.XDG_CONFIG_HOME, "cozyclay-off");
	mkdirSync(offDir, { recursive: true });
	writeFileSync(join(offDir, "state.json"), JSON.stringify({ updateNotice: false }));
	route = await mount({ enabled: updateChecksOn(true, {}, offDir), stateDir: offDir });
	res = await route.get();
	assert.equal(res.status, 200);
	assert.equal(res.body.enabled, false);
	assert.equal(res.body.status, "unknown");
	assert.equal(res.body.latest, null);
	assert.equal(res.body.canSelfUpdate, false);
	res = await route.post();
	assert.equal(res.status, 403);
	assert.deepEqual(res.body, { error: "update checks are disabled" });
	writeFileSync(join(offDir, "state.json"), JSON.stringify({ updateNotice: true }));
	route = await mount({ enabled: updateChecksOn(true, {}, offDir), stateDir: offDir });
	assert.equal((await route.get()).body.enabled, true, "--on turns the route back on at the next launch");
	assert.deepEqual(installs(), []);
	pass("with updateNotice: false in the state file, GET says enabled: false and POST is 403");

	/* ------------------------------------------- not self-updatable: 409 ---- */

	for (const kind of ["npx", "clone"]) {
		route = await mount({ kind });
		res = await route.get();
		assert.equal(res.body.kind, kind);
		assert.equal(res.body.canSelfUpdate, false);
		assert.equal(res.body.command, kind === "npx" ? "npx cozyclay" : "npm install -g cozyclay@latest");
		res = await route.post();
		assert.equal(res.status, 409, kind);
		assert.deepEqual(res.body, { error: "self-update unavailable" });
	}
	route = await mount({ pkgRoot: localPkg });
	assert.equal((await route.get()).body.canSelfUpdate, false);
	assert.equal((await route.post()).status, 409, "a global kind outside npm root -g");
	route = await mount({ current: "3.9.9" });
	assert.equal((await route.get()).body.status, "latest");
	assert.equal((await route.post()).status, 409, "nothing newer to install");
	registry.version = "4.0.0-rc.1";
	route = await mount();
	res = await route.get();
	assert.equal(res.body.status, "outdated");
	assert.equal((await route.post()).status, 409, "only an exact x.y.z reaches npm");
	assert.deepEqual(installs(), []);
	pass("POST is 409 for npx, clone, a non-global path, an up-to-date launch and a non x.y.z latest");

	/* ------------------------------------------- POST /update/restart ---- */

	registry.version = "3.9.9";
	resetNpm("ok");
	const spy = { restarts: 0, target: "/nowhere/bin/cozyclay.mjs", async targetPath() { return this.target; } };
	const spyRestarter = { target: () => spy.targetPath(), restart: async () => { spy.restarts += 1; } };
	route = await mount({ restarter: spyRestarter });
	res = await route.restart();
	assert.equal(res.status, 409, "idle: nothing to restart into");
	assert.deepEqual(res.body, { error: "restart unavailable" });
	for (const headers of [{}, { origin: "http://evil.test" }, { origin: `http://localhost:${route.port}` }]) {
		assert.equal((await route.restart(headers)).status, 403, JSON.stringify(headers));
	}
	assert.equal((await route.restart({ origin: route.origin }, "GET")).status, 405);
	process.env.FAKE_NPM_GATE = gate;
	assert.equal((await route.post()).status, 202);
	assert.equal((await route.restart()).status, 409, "updating: npm has not finished");
	writeFileSync(gate, "");
	assert.equal((await route.settle()).phase, "restart_needed");
	spy.target = null;
	assert.equal((await route.restart()).status, 409, "no new launcher on disk");
	spy.target = "/nowhere/bin/cozyclay.mjs";
	assert.equal((await route.restart({ origin: "http://evil.test" })).status, 403, "Origin first, even in restart_needed");
	res = await route.restart({ origin: route.origin, "content-type": "application/json" }, "POST");
	assert.equal(res.status, 202);
	assert.equal(res.body.phase, "restart_needed");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(spy.restarts, 1, "the restart runs once the 202 has left");
	assert.equal((await route.restart()).status, 202, "a second press is accepted");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(spy.restarts, 1, "and restarts nothing new");
	const noRestarter = await mount();
	resetNpm("ok");
	assert.equal((await noRestarter.post()).status, 202);
	assert.equal((await noRestarter.settle()).phase, "restart_needed");
	assert.equal((await noRestarter.restart()).status, 409, "no restarter: 409");
	const disabled = await mount({ enabled: false, restarter: spyRestarter });
	assert.equal((await disabled.restart()).status, 409, "checks off: 409");
	pass("POST /update/restart: exact Origin, 405 for other methods, 409 outside restart_needed or without a launcher, once");

	// An open SSE stream holds a plain close() (research 1.2); closeAllConnections first frees it.
	const openSse = (port) => new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path: "/sse" }, (stream) => {
			stream.resume();
			resolve({ ended: new Promise((done) => { stream.once("close", done); stream.once("error", done); }) });
		});
		req.once("error", reject);
		req.end();
	});
	const held = await mount();
	await openSse(held.port);
	let closedPlain = false;
	held.server.close(() => { closedPlain = true; });
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(closedPlain, false, "server.close() alone is still waiting on the SSE stream after 600 ms");
	held.server.closeAllConnections();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(closedPlain, true);
	const freed = await mount();
	const sse = await openSse(freed.port);
	const t0 = Date.now();
	await closeServer(freed.server);
	await sse.ended;
	assert.ok(Date.now() - t0 < 500, `closeServer returns at once with an SSE stream open (${Date.now() - t0} ms)`);
	pass("an open SSE stream holds server.close() for 600 ms+; closeServer (closeAllConnections first) closes at once");

	// The real hub the launcher starts: a connected client, then close, then its port binds again.
	const reserve = () => new Promise((resolve) => { const probe = createNetServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
	const hubPort = await reserve();
	process.env.COZYCLAY_LIVE_PORT = String(hubPort);
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(temp, "sessions");
	const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
	const agentHandler = createAgentHandler({ port: () => 5180 });
	let client = null;
	for (let t = 0; t < 100 && !client; t += 1) {
		client = await new Promise((resolve) => { const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/live`); socket.onopen = () => resolve(socket); socket.onerror = () => resolve(null); });
		if (!client) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(client, "a client is attached to the live hub");
	const clientClosed = new Promise((resolve) => { client.onclose = resolve; });

	// The whole path through the route: SSE open, hub attached, 202, the fake new launcher on the same port.
	resetNpm("ok");
	const launcherLog = join(temp, "launcher.log");
	const exits = [], lines = [];
	const signals = new EventEmitter();
	const full = await mount({
		restarter: (port, server) => createRestarter({
			port, getServer: () => server, closeHub: () => agentHandler.close(), launcherPath: async () => FAKE_LAUNCHER,
			argv: ["--port", String(port), "--no-star"], env: { ...process.env, FAKE_LAUNCHER_LOG: launcherLog, FAKE_LAUNCHER_EXIT: "7" },
			exit: (code) => exits.push(code), log: (line) => lines.push(line), signals,
		}),
	});
	assert.equal((await full.post()).status, 202);
	assert.equal((await full.settle()).phase, "restart_needed");
	const fullSse = await openSse(full.port);
	assert.equal((await full.restart()).status, 202);
	await fullSse.ended;
	await clientClosed;
	let answer = null;
	for (let t = 0; t < 100 && answer?.current !== "3.9.9"; t += 1) {
		try { answer = (await call(full.port, "GET")).body; } catch { /* between the two launchers */ }
		if (answer?.current !== "3.9.9") await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(answer?.current, "3.9.9", "the new launcher answers on the same port");
	assert.deepEqual(readFileSync(launcherLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [["--port", String(full.port), "--no-star", "--no-open"]], "same argv, plus --no-open");
	const hubFree = await new Promise((resolve) => { const probe = createNetServer(); probe.once("error", () => resolve(false)); probe.listen(hubPort, "127.0.0.1", () => probe.close(() => resolve(true))); });
	assert.equal(hubFree, true, "the live hub's port is free again");
	assert.deepEqual([exits, lines], [[], []], "the parent waits on the child");
	signals.emit("SIGTERM");
	for (let t = 0; t < 50 && !exits.length; t += 1) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(exits, [7], "SIGTERM reaches the child, and the parent exits with the child's code");
	pass("restart: SSE stream and hub client dropped, hub port released, the new launcher binds the same port with the same argv, exit code passed through");

	// A child that never binds: the fallback line and exit 1 after the bind window.
	const quiet = [], quietExits = [];
	const nobind = await mount({
		restarter: (port, server) => createRestarter({
			port, getServer: () => server, launcherPath: async () => FAKE_LAUNCHER, argv: ["--port", String(port)],
			env: { ...process.env, FAKE_LAUNCHER_MODE: "nobind" }, exit: (code) => quietExits.push(code), log: (line) => quiet.push(line),
			signals: new EventEmitter(), bindTimeoutMs: 600,
		}),
	});
	resetNpm("ok");
	assert.equal((await nobind.post()).status, 202);
	assert.equal((await nobind.settle()).phase, "restart_needed");
	assert.equal((await nobind.restart()).status, 202);
	for (let t = 0; t < 60 && !quietExits.length; t += 1) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual([quietExits, quiet], [[1], [RESTART_FALLBACK]], "no bind within the window: the fallback line, exit 1");
	assert.match(RESTART_FALLBACK, /run `cclay` again/);
	pass("a new launcher that does not bind in time: the fallback line and exit 1");

	// The restart target: <npm root -g>/cozyclay/bin/cozyclay.mjs once it exists; the env override wins.
	assert.equal(await globalLauncherPath("darwin"), null, "no bin under npm root -g yet");
	mkdirSync(join(globalPkg, "bin"), { recursive: true });
	writeFileSync(join(globalPkg, "bin", "cozyclay.mjs"), "");
	assert.equal(await globalLauncherPath("darwin"), join(globalRoot, "cozyclay", "bin", "cozyclay.mjs"));
	process.env.COZYCLAY_RESTART_BIN = FAKE_LAUNCHER;
	assert.equal(await globalLauncherPath("darwin"), FAKE_LAUNCHER);
	delete process.env.COZYCLAY_RESTART_BIN;
	pass("the restart target is <npm root -g>/cozyclay/bin/cozyclay.mjs, or COZYCLAY_RESTART_BIN");

	console.log("all Cozy Clay update-routes checks PASS");
} finally {
	for (const server of mounted) server.close();
	await new Promise((resolve) => registryServer.close(resolve));
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	rmSync(temp, { recursive: true, force: true });
}
