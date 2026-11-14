#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixture-qa-chrome.mjs", import.meta.url));
const port = async () => {
	const server = createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const value = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return value;
};
let failures = 0;
const check = (name, value) => {
	console.log(`${value ? "PASS" : "FAIL"} ${name}`);
	if (!value) failures++;
};
for (const mode of ["exit", "no-cdp", "stuck-cdp"]) {
	const out = mkdtempSync(join(tmpdir(), "qa-browser-startup-test-"));
	try {
	const child = spawn(process.execPath, ["tools/qa-browser.mjs", "--", process.execPath, "-e", "console.log('UNEXPECTED_RUNNER')"], {
		cwd: root,
		env: { ...process.env, CHROME_PATH: fixture, QA_CHROME_FIXTURE: mode, CDP_PORT: String(await port()),
			QA_CDP_TIMEOUT_MS: "200", DBUS_SESSION_BUS_ADDRESS: "fixture-desktop-bus", XDG_RUNTIME_DIR: "/fixture-desktop-runtime",
			QA_CHROME_FLAGS: "", CHROME_FLAGS: "", QA_OUT: out },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "", stderr = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	let watchdogFired = false;
	const timer = setTimeout(() => { watchdogFired = true; child.kill("SIGTERM"); }, 5000);
	const result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	clearTimeout(timer);
	const launch = stdout.split("\n").filter(Boolean).map(line => {
		try { return JSON.parse(line); } catch { return null; }
	}).find(row => row?.fixture === "qa-chrome");
	assert.ok(launch, "fixture browser actually ran");
	check(`${mode}: startup deadline does not need the external watchdog`, !watchdogFired);
	check(`${mode}: wrapper fails without starting the runner`, result.code === 1 && !stdout.includes("UNEXPECTED_RUNNER"));
	if (process.platform === "linux") {
		check(`${mode}: isolated browser does not inherit desktop services`, launch.desktopBus === null && launch.runtimeDir === null);
		check(`${mode}: isolated profile uses the basic password store`, launch.args.includes("--password-store=basic"));
	}
	check(`${mode}: launch does not start an app lifetime before seeding`, launch.args.at(-1) === "about:blank");
	check(`${mode}: browser stderr is preserved`, stderr.includes("fixture browser stderr"));
	const diagnostic = stderr.split("\n").filter(line => line.startsWith("QA_BROWSER_DIAGNOSTIC ")).map(line => JSON.parse(line.slice("QA_BROWSER_DIAGNOSTIC ".length))).at(-1);
	check(`${mode}: failure reports process and CDP state`, diagnostic?.chrome?.pid === launch.pid && diagnostic?.phase === "cdp" && diagnostic?.cdp?.ready === false);
	const profile = launch.args.find(arg => arg.startsWith("--user-data-dir=")).split("=")[1];
	check(`${mode}: owned profile removed`, !existsSync(profile));
	try { process.kill(launch.pid, 0); check(`${mode}: browser removed`, false); }
	catch (error) { assert.equal(error.code, "ESRCH"); check(`${mode}: browser removed`, true); }
	} finally { rmSync(out, { recursive: true, force: true }); }
}
assert.equal(failures, 0, `${failures} startup checks failed`);
console.log("QA browser startup checks PASS");
