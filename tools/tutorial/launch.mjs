#!/usr/bin/env node
// `npm run tutorial:record -- <episode> [flags]`: starts a dev server with a
// throwaway config dir (so the Agent panel shows the signed-out screen, not
// this machine's sign-in), runs record.mjs inside tools/qa-browser.mjs, and
// tears both down. Ports come from TUTORIAL_DEV_PORT, CDP_PORT,
// COZYCLAY_LIVE_PORT and COZYCLAY_OAUTH_PORT, defaulting to 5594-5597 so a
// recording never touches a Studio on 5180/5184. dev-full, not vite alone:
// without the agent server the panel reports a missing server instead of the
// sign-in card.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg } from "./assemble.mjs";
import { installSignalCleanup, spawnOwned, terminateOwned, waitForExit } from "../process-supervisor.mjs";

const devPort = Number(process.env.TUTORIAL_DEV_PORT || 5594);
const cdpPort = String(process.env.CDP_PORT || 5595);
const livePort = String(process.env.COZYCLAY_LIVE_PORT || 5596);
const oauthPort = String(process.env.COZYCLAY_OAUTH_PORT || 5597);
const url = `http://127.0.0.1:${devPort}/app/`;
const reachable = () => fetch(url).then((response) => response.ok, () => false);

try {
	findFfmpeg();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
if (await reachable()) {
	console.error(`port ${devPort} already serves a page; stop it or set TUTORIAL_DEV_PORT`);
	process.exit(1);
}

const configDir = mkdtempSync(join(tmpdir(), "cozyclay-tutorial-config-"));
const children = [];
const removeSignalCleanup = installSignalCleanup(() => children, () => rmSync(configDir, { recursive: true, force: true }));
// No provider key or endpoint from this shell may reach the recording's agent sidecar.
const devEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(_API_KEY|_AUTH_TOKEN|_BASE_URL)$/.test(name) && name !== "COZYCLAY_CODEX_AUTH_FILE"));
try {
	const dev = spawnOwned(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(devPort)], {
		env: { ...devEnv, COZYCLAY_CONFIG_DIR: configDir, XDG_CONFIG_HOME: configDir, COZYCLAY_LIVE_PORT: livePort, COZYCLAY_OAUTH_PORT: oauthPort },
		stdio: ["ignore", "ignore", "inherit"],
	});
	children.push(dev);
	const deadline = Date.now() + 60000;
	while (!(await reachable())) {
		if (dev.exitCode !== null) throw new Error("the dev server exited before it served the Studio");
		if (Date.now() > deadline) throw new Error(`the dev server did not answer on ${url} within 60s`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const recorder = spawnOwned(process.execPath, ["tools/qa-browser.mjs", "--", process.execPath, "tools/tutorial/record.mjs", ...process.argv.slice(2)], {
		env: { ...process.env, QA_URL: url, CDP_PORT: cdpPort, QA_FIRST_OPEN: "1" },
	});
	children.push(recorder);
	process.exitCode = (await waitForExit(recorder)).code ?? 1;
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	removeSignalCleanup();
	await Promise.allSettled(children.map((child) => terminateOwned(child)));
	rmSync(configDir, { recursive: true, force: true });
}
