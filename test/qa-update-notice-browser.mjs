#!/usr/bin/env node
// U1: the in-Studio update notice, end to end through the real launcher route.
// Start Vite separately, then:
//   QA_URL=http://127.0.0.1:5371/app/ CDP_PORT=9571 node tools/qa-browser.mjs -- node test/qa-update-notice-browser.mjs
// The launcher is this commit laid out as a global install (git archive into a
// temp <prefix>/lib/node_modules/cozyclay, no .git), so it reports kind global
// and can update itself. A mock registry answers 3.9.9 and test/fixtures/fake-npm.mjs
// stands in for npm (held on a gate file, then ok; later EACCES). The Studio runs on
// Vite; CDP forwards its /__cozyclay/update requests to that launcher with the
// launcher's own Origin. The analytics module gets a PROD environment and an
// in-memory SDK at the real track()/before_send boundary. Screenshots go to
// QA_SHOT_DIR (default ~/CozyClay3-wt/logs/qa-u1).
// U2b (#960): Restart now runs for real. COZYCLAY_RESTART_BIN makes the launcher
// hand over to test/fixtures/fake-launcher.mjs, a "new launcher" that binds the
// same port and answers current 3.9.9: once with unsaved changes (the save-first
// card and its Reload button), once saved (the Studio reloads by itself).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const ROOT = resolve(import.meta.dirname, "..");
const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5371/app/").origin;
const port = Number(process.env.CDP_PORT || 9571);
const launcherPort = Number(process.env.QA_LAUNCHER_PORT || 5791);
const shotDir = process.env.QA_SHOT_DIR || join(homedir(), "CozyClay3-wt", "logs", "qa-u1");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
mkdirSync(shotDir, { recursive: true });

// --- the launcher, as a global install --------------------------------------
const temp = mkdtempSync(join(tmpdir(), "cozyclay-qa-u1-"));
const npmRoot = join(temp, "prefix", "lib", "node_modules");
const pkg = join(npmRoot, "cozyclay");
mkdirSync(pkg, { recursive: true });
execFileSync("git", ["archive", "--format=tar", "-o", join(temp, "pkg.tar"), "HEAD"], { cwd: ROOT });
execFileSync("tar", ["-xf", join(temp, "pkg.tar"), "-C", pkg]);
mkdirSync(join(pkg, "dist", "app"), { recursive: true });
writeFileSync(join(pkg, "dist", "app", "index.html"), "<!doctype html><title>qa</title>");
symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"));
const registry = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "cozyclay", version: "3.9.9" })); });
await new Promise((done) => registry.listen(0, "127.0.0.1", done));
const gate = join(temp, "npm-gate");
let launcher = null;
async function startLauncher(mode) {
	if (launcher) { launcher.kill("SIGTERM"); await new Promise((done) => launcher.once("exit", done)); }
	const env = { ...process.env, COZYCLAY_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}/cozyclay/latest`,
		COZYCLAY_NPM_BIN: join(ROOT, "test", "fixtures", "fake-npm.mjs"), FAKE_NPM_ROOT: npmRoot, FAKE_NPM_MODE: mode, FAKE_NPM_GATE: gate,
		FAKE_NPM_LOG: join(temp, "npm.log"), XDG_CONFIG_HOME: join(temp, "config"), COZYCLAY_LIVE_PORT: String(launcherPort + 100),
		COZYCLAY_RESTART_BIN: join(ROOT, "test", "fixtures", "fake-launcher.mjs"), FAKE_LAUNCHER_LOG: join(temp, "launcher.log"),
		// The new launcher binds 2.5 s late, so the Studio's 1 s poll meets a closed port first.
		FAKE_LAUNCHER_DELAY_MS: "2500" };
	delete env.CI; delete env.COZYCLAY_NO_UPDATE_CHECK;
	launcher = spawn(process.execPath, [join(pkg, "bin", "cozyclay.mjs"), "--port", String(launcherPort), "--no-open", "--no-star", "--no-motion"], { env, stdio: ["ignore", "pipe", "pipe"] });
	launcher.stdout.resume();
	launcher.stderr.on("data", (chunk) => process.stderr.write(`[launcher] ${chunk}`));
	for (let t = 0; t < 100; t += 1) { try { if ((await fetch(`http://127.0.0.1:${launcherPort}/__cozyclay/update`)).ok) return; } catch { /* starting */ } await sleep(200); }
	throw new Error("launcher never answered /__cozyclay/update");
}

// --- the browser --------------------------------------------------------------
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
let sequence = 0, proxied = 0, gaps = 0;
const pending = new Map(), records = [], errors = [], log = [];
const send = (method, params = {}) => new Promise((done, fail) => { const id = ++sequence; pending.set(id, { done, fail }); ws.send(JSON.stringify({ id, method, params })); });
async function forward({ requestId, request }) {
	const route = new URL(request.url);
	const headers = request.headers.Origin || request.headers.origin ? { origin: `http://127.0.0.1:${launcherPort}` } : {};
	let answer;
	try { answer = await fetch(`http://127.0.0.1:${launcherPort}${route.pathname}`, { method: request.method, headers }); } catch {
		// Between the old launcher and the new one nothing listens: the page sees a failed fetch.
		gaps += 1;
		return send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
	}
	const body = await answer.text();
	proxied += 1;
	if (request.method === "POST") log.push(`POST ${route.pathname} -> ${answer.status} ${JSON.parse(body).phase ?? JSON.parse(body).error}`);
	await send("Fetch.fulfillRequest", { requestId, responseCode: answer.status, responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(body).toString("base64") });
}
async function rewriteAnalytics({ requestId }) {
	const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId });
	let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
	source = source.replace("return import.meta.env ?? {};", "return { PROD: true };");
	source = source.replace(/await import\([^)]*posthog[^)]*\)/g, "await Promise.resolve({ default: window.__qaPosthog })");
	await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
}
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) { const { done, fail } = pending.get(message.id); pending.delete(message.id); message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result); return; }
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaRecord") records.push(JSON.parse(message.params.payload));
	if (message.method === "Fetch.requestPaused") {
		const job = message.params.request.url.includes("/__cozyclay/update") ? forward(message.params) : rewriteAnalytics(message.params);
		void job.catch((error) => errors.push(`QA proxy: ${error.message}`));
	}
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const waitFor = async (expression, label, ms = 30_000) => {
	for (let t = 0; t < ms; t += 200) { try { if (await evaluate(expression)) return; } catch { /* page busy */ } await sleep(200); }
	throw new Error(`Timed out: ${label}`);
};
const view = (testid) => `document.querySelector('[data-testid=${testid}]')?.dataset.updateView`;
const click = (testid) => evaluate(`document.querySelector('[data-testid=${testid}]').click(), true`);
// A real pointer press: the clipboard wants a trusted gesture.
async function press(testid) {
	const { x, y } = await evaluate(`(() => { const r = document.querySelector('[data-testid=${testid}]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
}
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
async function shot(name) {
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, "base64"));
	console.log(`SHOT ${join(shotDir, `${name}.png`)}`);
}
async function load(query = "") {
	const before = proxied;
	await send("Page.navigate", { url: `${origin}/app/${query}` });
	await waitFor("!!document.querySelector('.topbar') && !!window.__cozyclay", "the Studio and its editor", 120_000);
	for (let t = 0; t < 150 && proxied === before; t += 1) await sleep(200);
	assert.ok(proxied > before, "the Studio asked the launcher for update info");
}
const updates = () => records.filter((record) => record.event.startsWith("update:")).map((record) => ({ event: record.event, ...Object.fromEntries(Object.entries(record.properties).filter(([key]) => ["kind", "behind", "action", "outcome", "error_class", "duration"].includes(key))) }));
const scene = { version: 4, activeSceneId: "qa-update", scenes: [{ id: "qa-update", name: "QA update", objects: [], shotDocument: { version: 4, frameCount: 96, waypoints: [], shots: [] },
	stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "QA" }], hasCharSheet: false, shotAspect: "16:9" } }] };
const runtime = { distribution: "npm", telemetryEnabled: true, apiKey: "internal-qa-u1", apiHost: "https://telemetry.invalid", appVersion: version, installKind: "global",
	installationId: "0192f0d6-3a4b-7c2d-8e9f-abcdefabcd01", internalQa: true, updateStatus: "outdated" };

try {
	await send("Page.enable"); await send("Runtime.enable");
	await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
	await send("Runtime.addBinding", { name: "__qaRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/__cozyclay/update*", requestStage: "Request" }, { urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === window.top) {
		if (!sessionStorage.getItem('qa-u1-seeded')) { localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded'); localStorage.setItem('cozyclay.locale', 'en'); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'QA', updatedAt: Date.now() })); localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(scene))}); sessionStorage.setItem('qa-u1-seeded', '1'); }
		window.__COZYCLAY_RUNTIME__ = ${JSON.stringify(runtime)}; }
		let beforeSend; window.__qaPosthog = { init(_key, options) { beforeSend = options.before_send; }, register() {}, opt_in_capturing() {}, opt_out_capturing() {},
			has_opted_out_capturing: () => false, get_distinct_id: () => 'internal-qa-u1', get_session_id: () => '0192f0d6-3a4b-7c2d-8e9f-abcdefabcd02',
			capture(event, properties = {}) { const payload = beforeSend({ event, properties: { ...properties } }); if (payload) window.__qaRecord(JSON.stringify(payload)); } };` });

	// 1. available -> dialog -> busy during a scripted agent turn
	await startLauncher("ok");
	await load("?agent=mock&state=ready&speed=0.15");
	await waitFor(`${view("update-chip")} === 'available'`, "the available chip");
	console.log(`CHIP ${await text("[data-testid=update-chip]")}`);
	await shot("01-chip-available");
	await click("update-chip");
	await waitFor(`${view("update-dialog")} === 'available' && document.querySelector('[data-testid=update-now]')?.disabled === false`, "the dialog with Update now enabled");
	console.log(`DIALOG ${await text("[data-testid=update-dialog]")}`);
	await shot("02-dialog-available");
	await evaluate("document.querySelector('.menubar-dialog-close').click(), true");
	if (!await evaluate("!!document.querySelector('.agent-input')")) await evaluate("document.querySelector('.studio-agent-bar')?.click(), true");
	await waitFor("!!document.querySelector('.agent-input')", "the agent composer");
	await waitFor("!!document.querySelector('[data-fid=\"tl_play\"]')", "the timeline", 60_000);
	await sleep(1500);
	// The editor answers the turn's first scene read only once it has booted; a refusal this early is retried.
	for (let attempt = 0; ; attempt += 1) {
		await evaluate("(() => { const t = document.querySelector('.agent-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Frame a wide two-shot'); t.dispatchEvent(new Event('input', { bubbles: true })); })()");
		await waitFor("document.querySelector('.agent-send:not(.stop)')?.disabled === false", "Send enabled");
		await evaluate("document.querySelector('.agent-send').click(), true");
		try { await waitFor("!!document.querySelector('.agent-send.stop')", "a running agent turn", 10_000); break; } catch (error) {
			console.log(`AGENT ${await evaluate("JSON.stringify({ state: document.querySelector('.agent-panel')?.dataset.agentState, last: [...document.querySelectorAll('.agent-row')].at(-1)?.textContent.slice(0, 120) })")}`);
			if (attempt >= 4) throw error;
			await sleep(2000);
		}
	}
	await click("update-chip");
	await waitFor("document.querySelector('[data-testid=update-now]')?.disabled === true && !!document.querySelector('[data-testid=update-busy]')", "Update now disabled during the turn", 5000);
	console.log(`BUSY ${await text("[data-testid=update-busy]")}`);
	await shot("03-dialog-busy-agent-turn");
	await waitFor("!document.querySelector('.agent-send.stop')", "the turn to end", 60_000);
	await waitFor("document.querySelector('[data-testid=update-now]')?.disabled === false", "Update now enabled after the turn", 5000);
	console.log("PASS Update now is disabled while the scripted agent turn runs, and enabled after it");

	// 2. Update now -> updating (npm held on the gate) -> restart_needed
	await click("update-now");
	await waitFor(`${view("update-chip")} === 'updating'`, "the updating chip", 10_000);
	await shot("04-updating");
	writeFileSync(gate, "go");
	await waitFor(`${view("update-chip")} === 'restart_needed'`, "the restart chip", 15_000);
	const restart = await text("[data-testid=update-dialog]");
	console.log(`RESTART ${restart}`);
	assert.match(restart, /Restart now, or quit CozyClay in the terminal \(Ctrl\+C\) and run `cclay` again/);
	await waitFor("document.querySelector('[data-testid=update-restart]')?.disabled === false", "Restart now enabled", 5000);
	await shot("05-restart-needed");
	assert.deepEqual(readFileSync(join(temp, "npm.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)), [["install", "-g", "cozyclay@3.9.9", "--engine-strict"]], "one pinned install");
	console.log("PASS one click ran npm install -g cozyclay@3.9.9 --engine-strict and ended in the restart text");

	// 2b. Restart now with unsaved changes: Restarting…, the new launcher answers 3.9.9, the save-first card, Reload.
	await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', x: 0, z: 0 }), true");
	await waitFor("!!document.querySelector('.project-dirty-dot')", "unsaved changes");
	await evaluate("window.__qaBeforeRestart = true");
	await click("update-restart");
	await waitFor(`${view("update-chip")} === 'restarting'`, "the restarting chip", 5000);
	console.log(`RESTARTING ${await text("[data-testid=update-dialog]")}`);
	await shot("09-restarting");
	await waitFor(`${view("update-dialog")} === 'restarted'`, "the save-first card", 30_000);
	const saveFirst = await text("[data-testid=update-dialog]");
	console.log(`SAVE_FIRST ${saveFirst}`);
	assert.match(saveFirst, /Updated\. Save your project, then reload\./);
	assert.equal(await evaluate("window.__qaBeforeRestart === true"), true, "a dirty project is not reloaded");
	assert.ok(gaps > 0, "the Studio kept polling through failed fetches while no launcher listened");
	console.log(`GAPS ${gaps} failed fetches while no launcher listened`);
	await shot("10-restarted-save-first");
	const before = proxied;
	await click("update-reload");
	await waitFor("!!document.querySelector('.topbar') && !!window.__cozyclay && window.__qaBeforeRestart !== true", "the reloaded Studio", 120_000);
	for (let t = 0; t < 150 && proxied === before; t += 1) await sleep(200);
	await sleep(1000);
	assert.equal(await evaluate("!!document.querySelector('[data-testid=update-chip]')"), false, "3.9.9 is current now: no chip");
	assert.deepEqual(readFileSync(join(temp, "launcher.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)), [["--port", String(launcherPort), "--no-open", "--no-star", "--no-motion"]], "the new launcher got the same argv");
	await shot("11-after-reload");
	console.log("PASS Restart now: Restarting…, the new launcher on the same port answers 3.9.9, a dirty project gets Save then Reload");

	// 2c. The same with a saved project: the Studio reloads by itself.
	await startLauncher("ok");
	writeFileSync(gate, "go");
	await load();
	await waitFor(`${view("update-chip")} === 'available'`, "the available chip");
	assert.equal(await evaluate("!document.querySelector('.project-dirty-dot')"), true, "nothing unsaved");
	await click("update-chip");
	await waitFor("document.querySelector('[data-testid=update-now]')?.disabled === false", "Update now enabled");
	await click("update-now");
	await waitFor("document.querySelector('[data-testid=update-restart]')?.disabled === false", "Restart now", 15_000);
	await evaluate("window.__qaBeforeRestart = true");
	await click("update-restart");
	await waitFor("!!document.querySelector('.topbar') && !!window.__cozyclay && window.__qaBeforeRestart !== true", "the Studio reloaded by itself", 60_000);
	await sleep(1500);
	assert.equal(await evaluate("!!document.querySelector('[data-testid=update-chip]')"), false, "no chip after the automatic reload");
	await shot("12-auto-reloaded");
	console.log("PASS Restart now with a saved project reloads the Studio by itself onto 3.9.9");

	// 3. a fresh launcher whose npm fails with EACCES -> the failure card
	await startLauncher("eacces");
	await load();
	await waitFor(`${view("update-chip")} === 'available'`, "the available chip after the restart");
	await click("update-chip");
	await waitFor("document.querySelector('[data-testid=update-now]')?.disabled === false", "Update now enabled");
	await click("update-now");
	await waitFor(`${view("update-chip")} === 'failed'`, "the failed chip", 15_000);
	await waitFor(`${view("update-dialog")} === 'failed'`, "the failure card");
	await press("update-copy");
	await waitFor("document.querySelector('[data-testid=update-copy]')?.dataset.copied === 'true'", "the copied command");
	const failed = await text("[data-testid=update-dialog]");
	console.log(`FAILED ${failed}`);
	console.log(`CLIPBOARD ${await evaluate("navigator.clipboard.readText()")}`);
	assert.match(failed, /npm can't write to its global folder/);
	assert.match(await text(".update-dialog-command"), /^npm install -g cozyclay@latest$/);
	await shot("06-failed-permission");
	console.log("PASS EACCES shows the permission card with the command, Copy command copies it");

	// 4. dismiss hides 3.9.9 for good
	await startLauncher("ok");
	await load();
	await waitFor(`${view("update-chip")} === 'available'`, "the available chip");
	await click("update-dismiss");
	await waitFor("!document.querySelector('[data-testid=update-chip]')", "the chip gone after dismiss");
	await load();
	await sleep(1500);
	assert.equal(await evaluate("!!document.querySelector('[data-testid=update-chip]')"), false, "a dismissed version stays hidden after reload");
	await shot("07-dismissed-after-reload");
	console.log("PASS dismiss hides 3.9.9, and it stays hidden after a reload that polled the launcher");

	// 5. Korean copy once
	await evaluate("localStorage.setItem('cozyclay.locale', 'ko'), localStorage.removeItem('cozyclay:update-dismissed'), true");
	await load();
	await waitFor(`${view("update-chip")} === 'available'`, "the Korean chip");
	await click("update-chip");
	await waitFor("!!document.querySelector('[data-testid=update-now]')", "the Korean dialog");
	const korean = `${await text("[data-testid=update-chip]")} | ${await text("[data-testid=update-dialog]")}`;
	console.log(`KO ${korean}`);
	assert.match(korean, /3\.9\.9 업데이트/); assert.match(korean, /CozyClay 3\.9\.9 버전이 나왔어요/); assert.match(korean, /지금 업데이트/);
	await shot("08-korean");
	console.log("PASS Korean chip and dialog copy");

	console.log("--- launcher POSTs");
	for (const line of log) console.log(`  ${line}`);
	console.log("--- update:* events (global properties omitted)");
	const events = updates();
	for (const event of events) console.log(`  ${JSON.stringify(event)}`);
	const has = (shape) => events.some((event) => Object.entries(shape).every(([key, value]) => event[key] === value));
	assert.ok(has({ event: "update:notice_shown", kind: "global", behind: "minor" }), "notice_shown global/minor");
	assert.ok(has({ event: "update:clicked", action: "update_now", kind: "global" }), "clicked update_now");
	assert.ok(has({ event: "update:finished", outcome: "ok", error_class: "none" }), "finished ok");
	assert.ok(has({ event: "update:finished", outcome: "failed", error_class: "permission" }), "finished failed permission");
	assert.ok(has({ event: "update:clicked", action: "copy_command" }), "clicked copy_command");
	assert.ok(has({ event: "update:clicked", action: "dismiss" }), "clicked dismiss");
	assert.ok(has({ event: "update:clicked", action: "restart", kind: "global" }), "clicked restart");
	assert.equal(events.filter((event) => event.event === "update:restarted" && event.outcome === "ok").length, 2, "update:restarted ok, once per restart");
	assert.equal(events.filter((event) => event.event === "update:finished").length, 3, "one update:finished per install");
	assert.ok(!JSON.stringify(records.filter((r) => r.event.startsWith("update:"))).match(/3\.9\.9|EACCES|node_modules|npm install/), "no version string, npm output, path or command in update:* payloads");
	assert.deepEqual(errors, [], "no uncaught page errors");
	console.log("PASS qa-update-notice-browser: available, busy, updating, restart, Restart now (dirty and saved), EACCES failure, dismiss, Korean, and the update:* events");
} finally {
	ws.close();
	launcher?.kill("SIGTERM");
	registry.close();
}
