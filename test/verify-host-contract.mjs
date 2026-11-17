#!/usr/bin/env node
// The host contract (#1319, bin/host-contract.mjs): what a host app that runs
// `npx cozyclay@latest` and shows the Studio in its own window relies on. Every
// release reaches every installed host at once, so a failure here means a
// release would break hosts that already shipped.
//
// - the launch flags a host passes are all still accepted;
// - with COZYCLAY_DESKTOP=1 the JSON ready line comes before the unchanged
//   human line, and GET /__cozyclay/contract answers the same contract;
// - the contract version is pinned together with the agent-route fields hosts
//   read. Adding a field is fine. If a pinned field had to go or change type,
//   prefer keeping the old field; otherwise bump HOST_CONTRACT_VERSION and
//   update the pin in the same change.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminateOwned } from "../tools/process-supervisor.mjs";
import { announceReady, HOST_CAPABILITIES, HOST_CONTRACT_VERSION } from "../bin/host-contract.mjs";

const scratch = mkdtempSync(join(tmpdir(), "cozyclay-host-contract-"));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// The installed host's flags and its ready pattern, exactly as it uses them.
const HOST_FLAGS = ["--no-open", "--no-star", "--no-update-check", "--via", "installer"];
const LEGACY_READY = /CozyClay is running at (https?:\/\/\S+)/;

// A package root with the launcher and a stub build: the launcher serves
// dist/ and needs nothing else to start. Without mcp/ it starts no live hub.
const packageRoot = join(scratch, "package");
cpSync(new URL("../bin", import.meta.url), join(packageRoot, "bin"), { recursive: true });
cpSync(new URL("../package.json", import.meta.url), join(packageRoot, "package.json"));
mkdirSync(join(packageRoot, "dist", "app"), { recursive: true });
writeFileSync(join(packageRoot, "dist", "app", "index.html"), "<!doctype html><head></head><body>stub</body>");

const env = {
	...process.env,
	CI: "",
	XDG_CONFIG_HOME: join(scratch, "config"),
	COZYCLAY_CONFIG_DIR: join(scratch, "agent-config"),
	COZYCLAY_AGENT_SESSIONS_DIR: join(scratch, "launcher-sessions"),
};
delete env.COZYCLAY_DESKTOP;

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function launch(args, extraEnv = {}) {
	const child = spawn(process.execPath, ["bin/cozyclay.mjs", ...args], {
		cwd: packageRoot,
		env: { ...env, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const out = { stdout: "", stderr: "" };
	child.stdout.on("data", (chunk) => { out.stdout += chunk; });
	child.stderr.on("data", (chunk) => { out.stderr += chunk; });
	return { child, out };
}

async function run(args) {
	const { child, out } = launch(args);
	const [code] = await once(child, "exit");
	return { code, ...out };
}

try {
	// --- launch flags -----------------------------------------------------------
	{
		const port = String(await freePort());
		for (const args of [
			["--port", port, ...HOST_FLAGS],
			[`--port=${port}`, "--no-open", "--no-star", "--no-update-check", "--via=installer"],
			// A retired flag stays a no-op.
			["--no-motion", ...HOST_FLAGS],
		]) {
			const result = await run([...args, "--version"]);
			assert.equal(result.stderr.includes("unknown option"), false, `${args.join(" ")} is accepted:\n${result.stderr}`);
			assert.equal(result.code, 0, `${args.join(" ")} exits 0`);
			assert.equal(result.stdout.trim(), version);
		}
		// The check above would catch a removed flag: an unknown one exits 1.
		const unknown = await run(["--no-such-flag", "--version"]);
		assert.equal(unknown.code, 1);
		assert.match(unknown.stderr, /unknown option --no-such-flag/);
		console.log("PASS every flag a host passes is accepted, in both spellings");
	}

	// --- ready lines and the contract route -------------------------------------
	assert.equal(HOST_CONTRACT_VERSION, 1, "contract version pinned; see the header of this file before changing it");
	assert.deepEqual(HOST_CAPABILITIES, ["project-files"]);
	const contract = { contract: HOST_CONTRACT_VERSION, version, capabilities: [...HOST_CAPABILITIES] };
	{
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/app/`;
		const { child, out } = launch(["--port", String(port), ...HOST_FLAGS], { COZYCLAY_DESKTOP: "1", COZYCLAY_LIVE_PORT: String(await freePort()) });
		try {
			const deadline = Date.now() + 15_000;
			while (!LEGACY_READY.test(out.stdout)) {
				assert.ok(child.exitCode === null && Date.now() < deadline, `the launcher did not announce itself:\n${out.stdout}\n${out.stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const lines = out.stdout.split(/\r?\n/);
			const human = lines.findIndex((line) => LEGACY_READY.test(line));
			const machine = lines.findIndex((line) => line.startsWith("{"));
			assert.ok(machine >= 0 && machine < human, "the JSON ready line comes before the human line");
			assert.deepEqual(JSON.parse(lines[machine]), { cozyclay: "ready", url, ...contract });
			assert.equal(lines[human], `CozyClay is running at ${url}`, "the human line stays word for word");
			assert.equal(lines.filter((line) => LEGACY_READY.test(line)).length, 1, "an installed host's pattern matches one line only");
			assert.equal(LEGACY_READY.exec(lines[human])[1], url);
			console.log("PASS COZYCLAY_DESKTOP=1 prints the JSON ready line before the unchanged human line");

			const contractUrl = `http://127.0.0.1:${port}/__cozyclay/contract`;
			const answer = await fetch(contractUrl);
			assert.equal(answer.status, 200);
			assert.match(answer.headers.get("content-type"), /^application\/json/);
			assert.deepEqual(await answer.json(), contract);
			assert.equal((await fetch(contractUrl, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200, "the Studio page may read it");
			assert.equal((await fetch(contractUrl, { headers: { origin: "http://example.com" } })).status, 403, "another site may not");
			assert.equal((await fetch(contractUrl, { method: "POST" })).status, 405);
			console.log("PASS GET /__cozyclay/contract answers the contract");
		} finally {
			await terminateOwned(child);
		}
	}
	{
		// Without the env var nothing changes for a person in a terminal.
		const printed = [];
		announceReady("http://127.0.0.1:5200/app/", version, { env: {}, log: (line) => printed.push(line) });
		assert.deepEqual(printed, ["CozyClay is running at http://127.0.0.1:5200/app/", "Use a Chromium-based browser — Safari and Firefox are not supported."]);
		console.log("PASS without COZYCLAY_DESKTOP the launcher prints only the human lines");
	}

	// --- agent-route fields hosts read, pinned with the contract version -----------
	{
		const configDir = join(scratch, "routes-config");
		const sessionsDir = join(scratch, "routes-sessions");
		process.env.COZYCLAY_CONFIG_DIR = configDir;
		process.env.COZYCLAY_CODEX_AUTH_FILE = join(configDir, "codex-auth.json");
		process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionsDir;
		for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "CLIPROXY_API_KEY", "CLIPROXY_BASE_URL", "FAL_KEY", "FAL_MODEL"]) delete process.env[name];
		const [{ createAgentHandler }, { createSessionStore }] = await Promise.all([import("../bin/agent/agent-routes.mjs"), import("../bin/agent/session-store.mjs")]);
		createSessionStore(sessionsDir).append("host-contract", [{ role: "user", content: "block the chase" }], { surface: "studio", sceneName: "Chase" });

		// A ComfyUI double, so POST /agent/video answers with a real result.
		const comfy = createServer((req, res) => {
			const send = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
			if (req.url.startsWith("/upload/image")) { req.resume(); req.on("end", () => send({ name: "cozyclay-frame.png" })); return; }
			if (req.url === "/prompt") { req.resume(); req.on("end", () => send({ prompt_id: "p1" })); return; }
			if (req.url.startsWith("/history/")) { send({ p1: { outputs: { 7: { videos: [{ filename: "c.mp4", subfolder: "", type: "output" }] } } } }); return; }
			res.writeHead(200, { "content-type": "video/mp4" }); res.end(Buffer.from("000000206674797069736f6d", "hex"));
		});
		comfy.listen(0, "127.0.0.1");
		await once(comfy, "listening");
		writeFileSync(join(scratch, "workflow.json"), JSON.stringify({ 1: { class_type: "LoadImage", inputs: { image: "x.png" } } }));
		process.env.COZYCLAY_COMFY_URL = `http://127.0.0.1:${comfy.address().port}`;
		process.env.COZYCLAY_COMFY_WORKFLOW = join(scratch, "workflow.json");

		const auth = { readStored() {}, writeStored() {}, logout() {}, status: () => ({ signedIn: false }), getAccessToken: async () => null };
		let server;
		const handler = createAgentHandler({ auth, codex: { listModels: async () => [], parseQuotaHeaders: () => ({ primary: {} }) }, liveHub: {}, port: () => server.address().port });
		server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const origin = `http://127.0.0.1:${server.address().port}`;
		try {
			const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
			const video = { provider: "comfy", prompt: "slow push in", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" };
			// Each value is a JSON type, "a|b" for either; a one-item array means every item has that shape.
			const pinned = [
				["GET", "/agent/providers", null, 200, { providers: [{ id: "string", label: "string", signedIn: "boolean" }] }],
				["GET", "/agent/models", null, 200, {
					providers: [{ id: "string", label: "string", signedIn: "boolean", models: [{ id: "string", key: "string", label: "string" }] }],
					models: [{ id: "string", label: "string" }],
				}],
				["GET", "/agent/sessions", null, 200, { sessions: [{ sessionId: "string", surface: "string", updatedAt: "string", sceneName: "string|null", firstText: "string" }] }],
				["GET", "/agent/video/providers", null, 200, { providers: [{ id: "string", name: "string", configured: "boolean" }] }],
				["POST", "/agent/video", video, 200, { dataUrl: "string", width: "number", height: "number", seconds: "number" }],
				["POST", "/agent/video", { ...video, prompt: "" }, 400, { error: "string" }],
				["POST", "/agent/video", { ...video, provider: "fal" }, 409, { error: "string" }],
			];
			const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
			const assertShape = (value, shape, where) => {
				if (Array.isArray(shape)) {
					assert.ok(Array.isArray(value) && value.length > 0, `${where} is a non-empty list`);
					value.forEach((item, index) => assertShape(item, shape[0], `${where}[${index}]`));
				} else if (typeof shape === "object") {
					assert.equal(typeOf(value), "object", `${where} is an object`);
					for (const [key, inner] of Object.entries(shape)) {
						assert.ok(Object.hasOwn(value, key), `${where}.${key} is gone: installed hosts read it`);
						assertShape(value[key], inner, `${where}.${key}`);
					}
				} else assert.ok(shape.split("|").includes(typeOf(value)), `${where} is ${typeOf(value)}, hosts read ${shape}`);
			};
			for (const [method, path, body, status, shape] of pinned) {
				const response = await fetch(`${origin}${path}`, body ? { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) } : { method });
				assert.equal(response.status, status, `${method} ${path} answers ${status}`);
				assertShape(await response.json(), shape, `${method} ${path}`);
			}
			console.log(`PASS contract ${HOST_CONTRACT_VERSION}: the agent-route fields hosts read are all still there`);
		} finally {
			server.close();
			comfy.close();
			await handler.close?.();
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
