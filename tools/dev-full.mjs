#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { handleOAuthRequest } from "../bin/codex-auth.mjs";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { fileURLToPath } from "node:url";
import {
	installSignalCleanup,
	spawnOwned,
	terminateOwned,
	waitForExit,
} from "./process-supervisor.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const viteArgs = [...process.argv.slice(2), "--strictPort"];

function mainPortFrom(args) {
	let port = 5180;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--port" || args[index] === "-p") port = Number(args[++index]);
		else if (args[index].startsWith("--port=")) port = Number(args[index].slice("--port=".length));
	}
	if (!Number.isInteger(port) || port < 1 || port >= 65535) {
		throw new Error(`the Vite --port must be an integer in 1..65534 (got ${JSON.stringify(port)})`);
	}
	return port;
}

const livePort = process.env.COZYCLAY_LIVE_PORT ?? "5184";
const configuredOAuthPort = process.env.COZYCLAY_OAUTH_PORT?.trim();
const mainPort = mainPortFrom(viteArgs);

// Vite runs with --strictPort and reports a taken port as a raw stack trace.
// Probe the port first so the failure is one actionable line before anything
// spawns, the same courtesy `npx cozyclay` already extends.
await new Promise((resolvePromise, reject) => {
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen({ port: mainPort, host: "127.0.0.1" }, () => probe.close(resolvePromise));
}).catch((err) => {
	if (err?.code !== "EADDRINUSE") throw err;
	console.error(`[dev] port ${mainPort} is taken (another CozyClay dev server?). Try --port ${mainPort + 100}.`);
	process.exit(1);
});

const children = [];
const agentHandler = createAgentHandler({ port: mainPort });
const oauthServer = createServer((req, res) => {
	const path = (req.url || "").split("?")[0];
	const hosts = new Set([`127.0.0.1:${mainPort}`, `localhost:${mainPort}`]);
	const origins = new Set([`http://127.0.0.1:${mainPort}`, `http://${"local" + "host"}:${mainPort}`]);
	if (!(origins.has(req.headers.origin) || (req.headers.origin === undefined && req.method === "GET" && hosts.has(req.headers.host)))) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "forbidden origin" })); return; }
	// The Studio's motion.fill (src/commands/motion3-fill.js): MotionBricks runs on onnxruntime-node here, not in the browser.
	if (path === "/agent/motion-fill" && req.method === "POST") {
		void import("../mcp/motionbricks/service.mjs").then(({ handleFillRoute }) => handleFillRoute(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "FILL_FAILED", message: "MotionBricks fill is not available on this server" } })); } });
		return;
	}
	// motion.primitive: a MotionBricks Smart Primitive over a scene block (opt-in, mcp/motionbricks/primitive.mjs)
	if (path === "/agent/motion-primitive" && req.method === "POST") {
		void import("../mcp/motionbricks/primitive.mjs").then(({ handlePrimitiveRoute }) => handlePrimitiveRoute(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "CAPABILITY_MISSING", message: "Smart Primitives are not available on this server" } })); } });
		return;
	}
	if (path.startsWith("/agent/")) {
		void agentHandler(req, res, path).then((handled) => { if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); } }).catch(() => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "agent unavailable" })); } });
		return;
	}
	void handleOAuthRequest(req, res).then((handled) => { if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); } }).catch(() => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "oauth unavailable" })); } });
});
const oauthPort = configuredOAuthPort ? Number(configuredOAuthPort) : 0;
await new Promise((resolvePromise, reject) => { oauthServer.once("error", reject); oauthServer.listen({ port: oauthPort, host: "127.0.0.1" }, resolvePromise); });
const actualOAuthPort = oauthServer.address().port;

// The oauth/agent HTTP server and the agent's live hub (its own listener on
// COZYCLAY_LIVE_PORT) keep the event loop alive, so shutdown must close both
// (dropping open keep-alive/SSE sockets) or the process never exits.
const closeServers = async () => {
	const httpClosed = new Promise((resolvePromise) => oauthServer.close(() => resolvePromise()));
	oauthServer.closeAllConnections();
	await Promise.allSettled([httpClosed, agentHandler.close()]);
};
const removeSignalCleanup = installSignalCleanup(() => children, closeServers);

const vite = spawnOwned(process.execPath, ["node_modules/vite/bin/vite.js", ...viteArgs], {
	cwd: REPO,
		env: {
			...process.env,
			COZYCLAY_LIVE_PORT: livePort,
			COZYCLAY_OAUTH_PORT: String(actualOAuthPort),
		},
});
children.push(vite);

const first = await Promise.race(
	children.map(async (child) => ({ child, ...(await waitForExit(child)) })),
);

removeSignalCleanup();
await closeServers();
await Promise.allSettled(
	children.filter((child) => child !== first.child).map((child) => terminateOwned(child)),
);
if (process.exitCode == null) {
	process.exitCode = first.code ?? (first.signal ? 1 : 0);
}
