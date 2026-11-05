#!/usr/bin/env node
// #1073: tools/headless-studio.mjs must resolve its browser helper and print
// usage without a project, Chrome or dev server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStudioProject, startChrome, waitFor } from "../tools/gt-render/browser.mjs";

const tool = fileURLToPath(new URL("../tools/headless-studio.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", timeout: 30000 });

for (const fn of [openStudioProject, startChrome, waitFor]) assert.equal(typeof fn, "function");

const help = run("--help");
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--project <file>/);
assert.equal(help.stderr, "");

const missing = run();
assert.equal(missing.status, 2, missing.stderr);
assert.match(missing.stderr, /--project <file>/);

assert.equal(await waitFor("probe", async () => 7, { timeoutMs: 1000 }), 7);
await assert.rejects(waitFor("never", async () => false, { timeoutMs: 50, intervalMs: 10 }), /never: timed out/);

console.log("PASS verify-headless-studio-cli: --help exits 0, missing --project exits 2, browser helper resolves");
