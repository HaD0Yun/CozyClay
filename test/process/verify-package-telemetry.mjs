#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminateOwned } from "../../tools/process-supervisor.mjs";
import { computePackageDigest } from "../../bin/package-signature.mjs";

const REPO = new URL("../..", import.meta.url);
const stateRoot = mkdtempSync(join(tmpdir(), "cozyclay-package-telemetry-"));
const packageRoot = join(stateRoot, "package");
mkdirSync(join(packageRoot, "tools"), { recursive: true });
cpSync(new URL("../../bin", import.meta.url), join(packageRoot, "bin"), { recursive: true });
cpSync(new URL("../../dist", import.meta.url), join(packageRoot, "dist"), { recursive: true });
cpSync(new URL("../../package.json", import.meta.url), join(packageRoot, "package.json"));
cpSync(new URL("../../tools/process-supervisor.mjs", import.meta.url), join(packageRoot, "tools", "process-supervisor.mjs"));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const signatureModule = join(packageRoot, "bin", "package-signature.mjs");
writeFileSync(
	signatureModule,
	readFileSync(signatureModule, "utf8").replace(
		/const PACKAGE_SIGNATURE_PUBLIC_KEY = "[^"]+";/,
		`const PACKAGE_SIGNATURE_PUBLIC_KEY = ${JSON.stringify(publicDer)};`,
	),
);
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const markerPayload = JSON.stringify({
	distribution: "npm",
	package: "cozyclay",
	version: packageMetadata.version,
	repository: "HaD0Yun/CozyClay",
	content_sha256: computePackageDigest(packageRoot),
});
writeFileSync(join(packageRoot, "dist", "cozyclay-package.json"), JSON.stringify({
	payload: markerPayload,
	signature: sign(null, Buffer.from(markerPayload), privateKey).toString("base64"),
}));

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => error ? reject(error) : resolve(address.port));
		});
	});
}

function outputWatcher(child) {
	let output = "";
	const waiters = [];
	const append = (chunk) => {
		output += chunk.toString();
		for (const waiter of waiters.splice(0)) waiter();
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	return {
		all: () => output,
		waitFor(pattern) {
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`output did not match ${pattern}\n${output}`)), 15_000);
				const check = () => {
					const match = pattern.exec(output);
					if (!match) {
						waiters.push(check);
						return;
					}
					clearTimeout(timeout);
					resolve(match);
				};
				check();
			});
		},
	};
}

function launch(port, extraArgs = [], extraEnv = {}) {
	const child = spawn(process.execPath, [
		"bin/cozyclay.mjs",
		"--port", String(port),
		"--no-open",
		"--no-motion",
		"--no-star",
		"--no-update-check",
		...extraArgs,
	], {
		cwd: packageRoot,
		env: {
			...process.env,
			CI: "",
			XDG_CONFIG_HOME: stateRoot,
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	return { child, output: outputWatcher(child) };
}

async function command(...args) {
	const child = spawn(process.execPath, ["bin/cozyclay.mjs", ...args], {
		cwd: packageRoot,
		env: {
			...process.env,
			CI: "",
			XDG_CONFIG_HOME: stateRoot,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = outputWatcher(child);
	const [code] = await once(child, "exit");
	return { code, output: output.all() };
}

async function sourceCommand(...args) {
	const child = spawn(process.execPath, ["bin/cozyclay.mjs", ...args], {
		cwd: REPO,
		env: {
			...process.env,
			CI: "",
			XDG_CONFIG_HOME: stateRoot,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = outputWatcher(child);
	const [code] = await once(child, "exit");
	return { code, output: output.all() };
}

try {
	const sourceStatus = await sourceCommand("telemetry", "status");
	assert.equal(sourceStatus.code, 0);
	assert.match(sourceStatus.output, /Telemetry: on/);

	for (const [source, expected] of [["unlisted-source", null], ["installer", "installer"]]) {
		const config = join(stateRoot, source);
		const fresh = launch(await freePort(), ["--via", source], { XDG_CONFIG_HOME: config });
		try {
			const ready = await fresh.output.waitFor(/CozyClay is running at (http:\/\/[^\s]+)/);
			const html = await (await fetch(new URL("/app/", ready[1]))).text();
			const runtime = JSON.parse(html.match(/window\.__COZYCLAY_RUNTIME__ = (\{.*?\});/)[1]);
			assert.equal(runtime.firstLaunch, true);
			assert.equal(runtime.firstLaunchHeardFrom, expected, `--via ${source} first-launch attribution`);
			const persisted = JSON.parse(readFileSync(join(config, "cozyclay", "state.json"), "utf8"));
			assert.equal(persisted.telemetryFirstLaunchHeardFrom ?? null, expected);
			assert.equal(fresh.output.all().includes(`ignoring --via ${source}`), expected === null);
		} finally {
			await terminateOwned(fresh.child);
		}
	}

	const port = await freePort();
	// A copied landing command answers the first-launch source without a TTY prompt (#466).
	const first = launch(port, ["--via", "site"]);
	try {
		await first.output.waitFor(/CozyClay is running at/);
		const html = await (await fetch(`http://127.0.0.1:${port}/app/`)).text();
		const match = html.match(/window\.__COZYCLAY_RUNTIME__ = (\{.*?\});/);
		assert.ok(match, "the official package injects runtime telemetry configuration");
		const runtime = JSON.parse(match[1]);
		assert.equal(runtime.distribution, "npm");
		assert.equal(runtime.telemetryEnabled, true);
		assert.equal(runtime.firstLaunch, true);
		assert.equal(runtime.firstLaunchHeardFrom, "site", "--via site is recorded with the first launch");
		assert.equal(runtime.updateStatus, "unknown", "--no-update-check never claims latest or outdated");
		assert.match(runtime.installationId, /^[0-9a-f-]{36}$/);
		assert.match(html, /window\.__COZYCLAY_LIVE__ = true;/, "the served studio opts into the loopback live socket (issue #58)");

		const forged = await fetch(`http://127.0.0.1:${port}/__cozyclay/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: JSON.stringify({ enabled: false }),
		});
		assert.equal(forged.status, 403, "a remote website cannot change loopback telemetry state");
		const originless = await fetch(`http://127.0.0.1:${port}/__cozyclay/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		assert.equal(originless.status, 403, "an originless request cannot change telemetry state");
		const malformed = await fetch(`http://127.0.0.1:${port}/%ZZ`);
		assert.equal(malformed.status, 400, "malformed URL encoding cannot crash the launcher");

		const cliDisabled = await command("telemetry", "off");
		assert.equal(cliDisabled.code, 0);
		assert.match(cliDisabled.output, /Telemetry: off/);
		const afterCliOff = await (await fetch(`http://127.0.0.1:${port}/app/`)).text();
		const disabledRuntime = JSON.parse(afterCliOff.match(/window\.__COZYCLAY_RUNTIME__ = (\{.*?\});/)[1]);
		assert.equal(disabledRuntime.telemetryEnabled, false, "a CLI opt-out reaches the running server after reload");
		assert.equal(disabledRuntime.installationId, null, "CLI opt-out removes the anonymous installation identity");

		const cliEnabled = await command("telemetry", "on");
		assert.equal(cliEnabled.code, 0);
		const afterCliOn = await (await fetch(`http://127.0.0.1:${port}/app/`)).text();
		const enabledRuntime = JSON.parse(afterCliOn.match(/window\.__COZYCLAY_RUNTIME__ = (\{.*?\});/)[1]);
		assert.equal(enabledRuntime.telemetryEnabled, true);
		assert.notEqual(enabledRuntime.installationId, runtime.installationId, "opt-in starts with a fresh identity");

		const disabled = await fetch(`http://127.0.0.1:${port}/__cozyclay/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
			body: JSON.stringify({ enabled: false }),
		});
		assert.equal(disabled.status, 200);
		assert.equal((await disabled.json()).telemetryEnabled, false);
	} finally {
		await terminateOwned(first.child);
	}

	const status = await command("telemetry", "status");
	assert.equal(status.code, 0);
	assert.match(status.output, /Telemetry: off/);

	const enabled = await command("telemetry", "on");
	assert.equal(enabled.code, 0);
	assert.match(enabled.output, /Telemetry: on/);

	const secondPort = await freePort();
	// An unknown --via never blocks a launch and never rewrites the first-launch source.
	const secondLivePort = await freePort();
	const second = launch(secondPort, ["--via=private text"], { COZYCLAY_LIVE_PORT: String(secondLivePort) });
	try {
		await second.output.waitFor(/CozyClay is running at/);
		const html = await (await fetch(`http://127.0.0.1:${secondPort}/app/`)).text();
		const match = html.match(/window\.__COZYCLAY_RUNTIME__ = (\{.*?\});/);
		const runtime = JSON.parse(match[1]);
		assert.equal(runtime.firstLaunch, false);
		assert.equal(runtime.telemetryEnabled, true);
		assert.equal(runtime.firstLaunchHeardFrom, "site");
		assert.equal(JSON.stringify(runtime).includes("private text"), false);
		const persisted = JSON.parse(readFileSync(join(stateRoot, "cozyclay", "state.json"), "utf8"));
		assert.equal(runtime.installationId, persisted.installationId);
		// The prebuilt bundle baked its own hub port; the launcher must tell it
		// the COZYCLAY_LIVE_PORT this launch chose (#862).
		assert.match(html, new RegExp(`window\\.__COZYCLAY_LIVE_PORT__ = ${secondLivePort};`), "the served studio is told the launcher's live hub port");
	} finally {
		await terminateOwned(second.child);
	}

	console.log("all packaged telemetry checks PASS");
} finally {
	rmSync(stateRoot, { recursive: true, force: true });
}
