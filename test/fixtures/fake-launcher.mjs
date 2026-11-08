#!/usr/bin/env node
/**
 * A stand-in for the newly installed bin/cozyclay.mjs, pointed at by
 * COZYCLAY_RESTART_BIN (or an injected launcherPath) in the restart tests.
 *
 * It binds 127.0.0.1:<--port> and answers GET /__cozyclay/update with
 * `current` FAKE_LAUNCHER_VERSION (default 3.9.9), up to date and idle.
 * FAKE_LAUNCHER_MODE=nobind never binds; FAKE_LAUNCHER_DELAY_MS waits that
 * long before it binds. FAKE_LAUNCHER_LOG gets its argv as
 * one JSON line. SIGTERM exits with FAKE_LAUNCHER_EXIT (default 0).
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (process.env.FAKE_LAUNCHER_LOG) appendFileSync(process.env.FAKE_LAUNCHER_LOG, `${JSON.stringify(args)}\n`);
const at = args.indexOf("--port");
const port = Number(at >= 0 ? args[at + 1] : 5180);
const current = process.env.FAKE_LAUNCHER_VERSION || "3.9.9";
process.on("SIGTERM", () => process.exit(Number(process.env.FAKE_LAUNCHER_EXIT ?? 0)));
process.on("SIGINT", () => process.exit(130));

if (process.env.FAKE_LAUNCHER_MODE === "nobind") {
	setInterval(() => {}, 1000);
} else {
	const server = createServer((req, res) => {
		if (!req.url?.startsWith("/__cozyclay/update")) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify({
			enabled: true, current, latest: current, status: "latest", kind: "global", canSelfUpdate: true, phase: "idle",
			errorClass: null, durationMs: null, notesUrl: `https://github.com/HaD0Yun/CozyClay/releases/tag/v${current}`, command: "npm install -g cozyclay@latest",
		}));
	});
	setTimeout(() => server.listen({ port, host: "127.0.0.1" }, () => console.log(`fake launcher ${current} on ${port}`)), Number(process.env.FAKE_LAUNCHER_DELAY_MS ?? 0));
}
