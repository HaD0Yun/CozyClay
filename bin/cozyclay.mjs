#!/usr/bin/env node
/**
 * cozyclay - run the studio from a published package.
 *
 * `npx cozyclay` / `bunx cozyclay` should behave like `npm run dev` does in a
 * clone: the studio in a browser. The difference is that nothing is built
 * here. The package ships the built `dist/`, so this launcher only has to
 * serve those files over loopback (plus the OAuth and agent routes).
 *
 * The only runtime dependencies are the agent packages
 * `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` (MIT), and the
 * agent sidecar loads them lazily, so this launcher itself still starts
 * without them. Everything else stays dependency-free on purpose: a launcher
 * that needs an install step before it can serve a prebuilt app is a
 * launcher that will break.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMcpRuntime, runMcp } from "./mcp-runtime.mjs";
import { openBrowser } from "./open-browser.mjs";
import { maybeAskForStar } from "./star-prompt.mjs";
import { checkForUpdate, readUpdateStatus, runUpdateCommand, updateChecksOn } from "./update-check.mjs";
import { createStudioRoutes } from "./studio-routes.mjs";
import { handleOAuthRequest } from "./codex-auth.mjs";
import { createAgentHandler } from "./agent/agent-routes.mjs";
import { liveHubPort } from "./live-endpoint.mjs";
import {
	markTelemetryFirstLaunch,
	setTelemetryFirstLaunchSource,
	effectiveTelemetryEnabled,
	readTelemetryState,
	setTelemetryEnabled,
	setTelemetryInternalQa,
	takeRuntimeTelemetryConfig,
	FIRST_LAUNCH_SOURCES,
} from "./telemetry-state.mjs";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_CHECKOUT = existsSync(join(PKG_ROOT, ".git"));
let packageMetadata = {};
try {
	packageMetadata = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
} catch {
	// An unreadable package is handled by the existing missing-build checks.
}
const DIST = join(PKG_ROOT, "dist");
const INSTALL_KIND = SOURCE_CHECKOUT ? "clone" : process.env.npm_config_global === "true"
	|| (/[\\/]node_modules[\\/]/.test(PKG_ROOT) && !/[\\/]_npx[\\/]/.test(PKG_ROOT))
	? "global"
	: "npx";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".fbx": "application/octet-stream",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function parseArgs(argv) {
	const opts = { port: 5180, host: "127.0.0.1", open: true, star: true, updateCheck: true };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
		else if (arg.startsWith("--port=")) opts.port = Number(arg.slice(7));
		else if (arg === "--host") opts.host = String(argv[++i]);
		else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
		// Accepted for old scripts: there is no motion sidecar any more.
		else if (arg === "--no-motion") continue;
		else if (arg === "--no-open") opts.open = false;
		else if (arg === "--scene") opts.scene = String(argv[++i] ?? "");
		else if (arg.startsWith("--scene=")) opts.scene = arg.slice(8);
		else if (arg === "--no-star") opts.star = false;
		else if (arg === "--no-update-check") opts.updateCheck = false;
		else if (arg === "--via") opts.via = String(argv[++i] ?? "");
		else if (arg.startsWith("--via=")) opts.via = arg.slice(6);
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--version" || arg === "-v") opts.version = true;
		else {
			console.error(`cozyclay: unknown option ${arg}`);
			opts.help = true;
			opts.invalid = true;
		}
	}
	if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65534) {
		console.error("cozyclay: --port must be an integer in 1..65534");
		opts.help = true;
		opts.invalid = true;
	}
	// Attribution never blocks a launch: an unknown source is dropped, not an error.
	if (opts.via !== undefined) {
		const via = String(opts.via).trim().toLowerCase();
		opts.via = FIRST_LAUNCH_SOURCES.includes(via) ? via : null;
		if (!opts.via) console.error(`cozyclay: ignoring --via ${via || "(empty)"}; expected one of ${FIRST_LAUNCH_SOURCES.join(", ")}`);
	}
	if (opts.host !== "127.0.0.1") {
		console.error("cozyclay: --host is restricted to 127.0.0.1");
		opts.help = true;
		opts.invalid = true;
	}
	return opts;
}

const STATE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
const STATE_FILE = join(STATE_DIR, "state.json");

const HELP = `cozyclay - browser-based 3D staging studio

  npx cozyclay              start the studio and open it
  npx cozyclay mcp          run the MCP server (for Claude, Cursor, any MCP client)
  cclay live status         drive a running studio from the terminal
                            (cclay live --help lists every verb)
  cclay update              install the latest cozyclay globally (npm install -g)
  cclay update --check      only compare: exit 0 latest, 10 newer exists, 11 unknown
  cclay update --off|--on   stop or resume update notices (launch line, Studio chip)
  npx cozyclay --port 5200  serve on another port
  npx cozyclay --no-open    do not open a browser
  npx cozyclay --scene <id> open the studio on a bundled starter scene
  npx cozyclay --no-star    never ask about starring the repo
  npx cozyclay --no-update-check
                            do not look for a newer release
  npx cozyclay --via site   say where you found CozyClay (site, playground, installer, x,
                            hn, reddit, github, friend or other); recorded once,
                            with the anonymous first launch
  cclay telemetry status   show anonymous telemetry status
  cclay telemetry off      disable anonymous telemetry
  cclay telemetry on       enable anonymous telemetry
  cclay telemetry internal on|off
                            mark or unmark this installation as internal QA

cclay is the same command, shorter: a global install gives you both.

Everything - staging, posing, compiled motion, cameras, timeline, playback -
runs locally with no extra setup.`;

function serveFile(res, path) {
	const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, {
		"content-type": type,
		"content-length": statSync(path).size,
		// The studio is served from a local process a user just started; a
		// stale cache across versions is more confusing than a re-read.
		"cache-control": "no-cache",
	});
	createReadStream(path).pipe(res);
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(patch) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		const temporary = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ ...readState(), ...patch }, null, "\t"), { mode: 0o600 });
		renameSync(temporary, STATE_FILE);
	} catch {
		/* a read-only home is not a reason to fail a local dev server */
	}
}

// Read on every launch now, so it must not be able to take the launcher down:
// the version is cosmetic here, and "0.0.0" just suppresses a bogus notice.
function readVersion() {
	return typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";
}

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
	await runMcp(argv.slice(1));
} else if (argv[0] === "live") {
	// Loaded on demand: the terminal controller is JSON over one socket and has
	// no business being parsed on every `npx cozyclay` launch.
	const { runLiveCli } = await import("./live/cli.mjs");
	process.exit(await runLiveCli(argv.slice(1)));
} else if (argv[0] === "update") {
	// This branch bypasses parseArgs; runUpdateCommand refuses anything but one
	// known flag, so `cclay update --help` never performs a global install.
	const code = await runUpdateCommand(argv.slice(1), { currentVersion: readVersion(), kind: INSTALL_KIND, stateDir: STATE_DIR });
	if (code !== null) process.exit(code);
} else if (argv[0] === "telemetry") {
	const action = argv[1] ?? "status";
	const internalAction = action === "internal" ? argv[2] : null;
	if (
		(action === "internal" && (argv.length !== 3 || !["on", "off"].includes(internalAction)))
		|| (action !== "internal" && (argv.length > 2 || !["status", "on", "off"].includes(action)))
	) {
		console.error("cozyclay: telemetry accepts status, on, off, or internal on|off");
		process.exit(1);
	}
	if (action === "on") setTelemetryEnabled(STATE_FILE, true);
	if (action === "off") setTelemetryEnabled(STATE_FILE, false);
	if (action === "internal") setTelemetryInternalQa(STATE_FILE, internalAction === "on");
	const state = readTelemetryState(STATE_FILE);
	const effective = effectiveTelemetryEnabled(state);
	const reason = state.telemetryEnabled && !effective ? " (environment override)" : "";
	console.log(`Telemetry: ${effective ? "on" : "off"}${reason}`);
	console.log(`Internal QA: ${state.internalQa ? "on" : "off"}`);
	if (action !== "status") console.log("Reload any open CozyClay studio tab to apply this setting.");
} else {

const opts = parseArgs(argv);
if (opts.help) {
	console.log(HELP);
	process.exit(opts.invalid ? 1 : 0);
}
const version = readVersion();
if (opts.version) {
	console.log(version);
	process.exit(0);
}
const takeRuntime = () => takeRuntimeTelemetryConfig(STATE_FILE, { appVersion: version, officialPackage: true, installKind: INSTALL_KIND });
let runtimeTelemetry = takeRuntime();
if (runtimeTelemetry.firstLaunch && opts.via && !readTelemetryState(STATE_FILE).firstLaunchHeardFrom) {
	// A copied `--via` command already says where the install came from.
	setTelemetryFirstLaunchSource(STATE_FILE, opts.via);
	runtimeTelemetry = takeRuntime();
}
// Fired before anything blocking and never awaited on the launch path: the
// notice is worth a line of output, never a second of startup.
const updateChecksEnabled = updateChecksOn(opts.updateCheck, process.env, STATE_DIR);
const updatePending = updateChecksEnabled ? checkForUpdate(version, STATE_DIR) : null;
if (!existsSync(join(DIST, "app", "index.html"))) {
	console.error("cozyclay: this package is missing its build (dist/app/index.html).");
	console.error("cozyclay: from a clone, run `npm install && npm run build` first.");
	process.exit(1);
}

let server = null;
let shuttingDown = false;
async function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		await new Promise((resolvePromise) => server?.close(() => resolvePromise()));
	} catch {
		/* never let shutdown hold the process hostage */
	}
	process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

// A source checkout has mcp/node_modules; the package loads the Studio's live
// tools from the staged MCP runtime that `cclay mcp` also uses (#576).
const agentHandler = createAgentHandler({ port: () => opts.port, ...(SOURCE_CHECKOUT ? {} : { mcpRuntime: { ensure: ensureMcpRuntime } }) });
const studioRoutes = createStudioRoutes({ port: opts.port, stateFile: STATE_FILE, takeRuntime, update: { currentVersion: version, stateDir: STATE_DIR, kind: INSTALL_KIND, enabled: updateChecksEnabled, pkgRoot: PKG_ROOT }, restart: { getServer: () => server, closeHub: () => agentHandler.close() } });
server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (/^\/oauth\/(start|status|logout|cancel)$/.test(url.pathname)) {
		const origin = req.headers.origin;
		const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
		const origins = new Set([`http://127.0.0.1:${opts.port}`, `http://${"local" + "host"}:${opts.port}`]);
		if (!(origins.has(origin) || (origin === undefined && req.method === "GET" && hosts.has(req.headers.host)))) { res.writeHead(403, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "forbidden origin" })); return; }
		void handleOAuthRequest(req, res).catch(() => { if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "oauth unavailable" })); } });
		return;
	}
	if (url.pathname.startsWith("/agent/")) {
		void agentHandler(req, res, url.pathname).then((handled) => { if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); } }).catch((error) => {
			// The pane only sees "502 — agent unavailable"; the reason belongs on
			// the launcher's terminal rather than nowhere.
			console.error(`cozyclay: agent request ${url.pathname} failed: ${error?.message ?? error}`);
			if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "agent unavailable" })); }
		});
		return;
	}
	if (studioRoutes(req, res, url)) return;
	let rel;
	try {
		rel = decodeURIComponent(url.pathname);
	} catch {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		res.end("invalid URL encoding");
		return;
	}
	// normalize + prefix check: a request must not escape dist/.
	let target = join(DIST, normalize(rel));
	if (!target.startsWith(DIST)) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	// The build is multi-page: "/" is the landing and "/app/" is the studio, so a
	// directory has to resolve to its index the way a static host would. Without
	// this the studio 404s and the CLI only ever serves the landing page.
	if (existsSync(target) && statSync(target).isDirectory()) {
		target = join(target, "index.html");
	}
	if (!existsSync(target) || statSync(target).isDirectory()) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	if (target === join(DIST, "app", "index.html")) {
		runtimeTelemetry = takeRuntime();
		// Whether this launch is the newest release, from the registry answer the
		// update check already cached (#466). Never a request of its own.
		const runtime = { ...runtimeTelemetry, updateStatus: updateChecksEnabled ? readUpdateStatus(version, STATE_DIR) : "unknown" };
		if (runtime.firstLaunch) {
			markTelemetryFirstLaunch(STATE_FILE);
		}
		// __COZYCLAY_LIVE__ opts the production build into the loopback live
		// socket (src/App.jsx gates on DEV || this flag); without it an
		// npx-served studio can never attach to the MCP server's live hub.
		// __COZYCLAY_LIVE_PORT__ tells the prebuilt bundle which hub port this
		// launch chose (COZYCLAY_LIVE_PORT), since the build baked its own (#862).
		const html = readFileSync(target, "utf8").replace("</head>", `<script>window.__COZYCLAY_RUNTIME__ = ${JSON.stringify(runtime).replaceAll("<", "\\u003c")}; window.__COZYCLAY_LIVE__ = true; window.__COZYCLAY_LIVE_PORT__ = ${JSON.stringify(liveHubPort())};</script>\n</head>`);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": Buffer.byteLength(html),
			"cache-control": "no-store",
		});
		res.end(html);
		return;
	}
	serveFile(res, target);
});

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		console.error(`cozyclay: port ${opts.port} is taken. Try --port 5200.`);
		void shutdown(1);
		return;
	}
	throw err;
});

server.listen({ port: opts.port, host: "127.0.0.1", ipv6Only: false }, async () => {
	// The package exists to open the studio, which the site serves from /app/.
	// Landing on "/" would greet someone who just typed `npx cozyclay` with a
	// marketing page.
	// --scene <id> opens a bundled starter scene. Only a bare id is accepted
	// here; the studio resolves it to dist/scenes/<id>.cclayproject and ignores
	// an id it does not ship, with a console warning.
	const sceneParam = opts.scene && /^[a-z0-9-]+$/i.test(opts.scene) ? `?scene=${encodeURIComponent(opts.scene)}` : "";
	if (opts.scene && !sceneParam) console.error(`cozyclay: --scene expects a bare starter id (got ${opts.scene}); opening the studio without it.`);
	const url = `http://127.0.0.1:${opts.port}/app/${sceneParam}`;
	console.log(`CozyClay is running at ${url}`);
	console.log("Use a Chromium-based browser — Safari and Firefox are not supported.");
	// Asked once per version, before the browser opens: the question comes
	// first, and the studio opens after the answer (or the ask timeout).
	try {
		await maybeAskForStar(opts, { readState, writeState, version });
	} catch {
		/* the question must never block the launch */
	}
	if (opts.open) openBrowser(url);
	void updatePending?.then((latest) => {
		// `cclay` only exists after a global install, so name the command that
		// works from an npx run too.
		if (latest) console.log(`cozyclay ${latest} is available (you have ${version}). Run: npm install -g cozyclay@latest`);
	});
});

}
