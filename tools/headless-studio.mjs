#!/usr/bin/env node
/**
 * Start the real CozyClay Studio in an owned headless Chrome process.
 *
 * This is intentionally a source-checkout tool. It starts the same dev server,
 * seeds a portable .cclayproject into the browser's storage before the app
 * loads, and leaves the live hub available to `cclay live` or an MCP client.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwned, terminateOwned } from "./process-supervisor.mjs";
import { openStudioProject, startChrome, waitFor } from "./headless-chrome.mjs";
import { readProjectDocument } from "../src/project.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const usage = `headless-studio - start the real Studio without a visible tab

  node tools/headless-studio.mjs --project shot.cclayproject

Options:
  --project <file>   portable .cclayproject to load (required)
  --port <port>      Vite/Studio port (default 5920)
  --live-port <port> live hub port (default 5924)
  --cdp-port <port>  Chrome DevTools port (default 9320)
`;

function value(argv, name, fallback = undefined) {
	const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
	if (index < 0) return fallback;
	const arg = argv[index];
	return arg.includes("=") ? arg.slice(name.length + 1) : argv[index + 1];
}
function port(argv, name, fallback) {
	const parsed = Number(value(argv, name, fallback));
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be an integer in 1..65535`);
	return parsed;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); process.exit(0); }
const projectPath = value(argv, "--project");
if (!projectPath) { console.error(usage); process.exit(2); }
const projectRaw = readFileSync(resolve(projectPath), "utf8");
const parsed = readProjectDocument(projectRaw);
if (!parsed.ok) throw new Error(`Cannot load project: ${parsed.reason}`);
const studioPort = port(argv, "--port", 5920);
const livePort = port(argv, "--live-port", 5924);
const cdpPort = port(argv, "--cdp-port", 9320);
const children = [];
const cleanups = [];
let cdp = null;
let shuttingDown = false;
const shutdown = async (code = 0) => {
	if (shuttingDown) return;
	shuttingDown = true;
	try { cdp?.close(); } catch { /* already closed */ }
	for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* best effort */ } }
	await Promise.allSettled(children.reverse().map((child) => terminateOwned(child)));
	process.exitCode = code;
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(128 + (signal === "SIGINT" ? 2 : 15)); });

let dev = null;
try {
	dev = spawnOwned(process.execPath, [join(ROOT, "tools/dev-full.mjs"), "--host", "127.0.0.1", "--port", String(studioPort)], {
		cwd: ROOT,
		env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) },
		stdio: ["ignore", "inherit", "inherit"],
	});
	children.push(dev);
	await waitFor("Studio server", async () => (await fetch(`http://127.0.0.1:${studioPort}/app/`)).ok, { child: dev });
	cdp = await startChrome({ port: cdpPort, children, cleanups });
	await openStudioProject(cdp, `http://127.0.0.1:${studioPort}/app/`, parsed.project, { raw: projectRaw });
	console.log(JSON.stringify({ ok: true, studio: `http://127.0.0.1:${studioPort}/app/`, livePort, cdpPort, project: parsed.project.name, warnings: parsed.warnings }, null, 2));
	await new Promise((resolve) => {
		const done = () => resolve();
		dev.once("exit", done);
		if (dev.exitCode !== null || dev.signalCode !== null) done();
	});
	await shutdown(dev.exitCode ?? 1);
} catch (error) {
	console.error(`headless Studio: ${error?.message || error}`);
	await shutdown(1);
}
