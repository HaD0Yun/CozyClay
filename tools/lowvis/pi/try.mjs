#!/usr/bin/env node
// Starts the dev Studio with its agent sidecar to try the lowvis motion engine by hand in the Agent box.
//   node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs [--viewer 5199] [--live 5399] [--no-direct] [--figure cube]
// tools/dev-full.mjs: the dev server on --viewer with the Studio's agent sidecar and its live hub on --live, so this
// Studio never joins the hub of another Studio on the default port. The sidecar keeps its sessions and sign-ins in a
// folder of its own (COZYCLAY_CONFIG_DIR, default lowvis-out/studio-config), not in the user's CozyClay config.
// The direct key of the motion writer is listed in the model picker (COZYCLAY_MOTION_DIRECT=on) unless --no-direct.
// Uses a Studio that already answers on --viewer instead of starting one.
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--no-direct") opt.direct = false;
	else if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
}
const ROOT = resolve(import.meta.dirname, "../../.."), VIEW = Number(opt.viewer ?? 5199), LIVE = Number(opt.live ?? 5399);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async () => { try { return (await fetch(`http://127.0.0.1:${VIEW}/app/`)).ok; } catch { return false; } };
const env = { ...process.env, COZYCLAY_LIVE_PORT: String(LIVE), COZYCLAY_CONFIG_DIR: process.env.COZYCLAY_CONFIG_DIR ?? join(ROOT, "lowvis-out/studio-config") };
if (opt.direct !== false) env.COZYCLAY_MOTION_DIRECT = "on";
// --figure <look>: rig characters are drawn in that look of src/lowvis/looks and are of its body (src/lowvis/studio/figure.js;
// none: the cube look, or the block figure under COZYCLAY_MOTION_ENGINE=old; "block": the block figure)
if (opt.figure) env.COZYCLAY_FIGURE = opt.figure;

const switches = () => [
	`  COZYCLAY_MOTION_ENGINE=${env.COZYCLAY_MOTION_ENGINE ?? ""}  (old: the old motion engine; anything else: lowvis)`,
	`  COZYCLAY_MOTION_DIRECT=${env.COZYCLAY_MOTION_DIRECT ?? ""}  (on: the direct key "Opus 5.5 (lowvis motion)" is in the model picker)`,
	`  COZYCLAY_MOTION_OFF=${env.COZYCLAY_MOTION_OFF ?? ""}  (engine steps switched off, of pace, turn, tops, body)`,
	`  COZYCLAY_FIGURE=${env.COZYCLAY_FIGURE ?? ""}  (a look of src/lowvis/looks for the rig characters, e.g. block; empty: the cube look, under the old engine the block figure)`,
].join("\n");

if (await answers()) {
	console.log(`a Studio already answers on ${VIEW} (its own switches apply): http://127.0.0.1:${VIEW}/app/`);
	process.exit(0);
}
const vite = spawn(process.execPath, [join(ROOT, "tools/dev-full.mjs"), "--port", String(VIEW), "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env });
process.on("exit", () => vite.kill("SIGTERM"));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
vite.on("exit", code => process.exit(code ?? 0));
for (let i = 0; !(await answers()); i++) { if (vite.exitCode !== null || i > 600) throw new Error(`the Studio did not start on ${VIEW}`); await sleep(100); }
console.log(`studio: http://127.0.0.1:${VIEW}/app/  (live hub ${LIVE})\n${switches()}`);
