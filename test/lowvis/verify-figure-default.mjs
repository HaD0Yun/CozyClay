#!/usr/bin/env node
// The look rig characters are drawn in has one home (src/lowvis/studio/figure.js): nothing named at launch is the cube
// look (scale 1 = the 1.70 m body, its body 0.943 of the rig's), "block" is the block figure, and the page and the agent
// sidecar always read the same look from the same launch value:
// 1. figureOf (the sidecar: its environment) for each launch value
// 2. the page's look for the same value as a page served by bin/cozyclay.mjs is handed it (window.__COZYCLAY_FIGURE__),
//    and as a dev server bakes it in (vite.config.js): FIGURE, lookBody() and bodyScale() equal the sidecar's; a worker
//    the page starts (motion3-compile.js, named by workerName) reads the page's value
// 3. every place that reads COZYCLAY_FIGURE goes through figure.js: no reader of its own anywhere in bin/ or src/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)), FIGURE = join(REPO, "src/lowvis/studio/figure.js");
const { COZYCLAY_FIGURE: _named, ...bare } = process.env;
/** figure.js imported fresh in a process of its own: the sidecar with COZYCLAY_FIGURE = env, a page handed `handed`,
 *  or a worker of the name `worker`. */
const read = ({ env, handed, worker } = {}) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
	${handed === undefined ? "" : `globalThis.window = { __COZYCLAY_FIGURE__: ${JSON.stringify(handed)} };`}
	${worker === undefined ? "" : `globalThis.self = { name: ${JSON.stringify(worker)} };`}
	const m = await import(${JSON.stringify(FIGURE)});
	console.log(JSON.stringify({ sidecar: m.figureOf(), page: m.FIGURE, body: m.lookBody(), sidecarBody: m.lookBody(m.figureOf()), scaled: m.bodyScale({ model: "x-bot-tpose", scale: 1.2 }), standing: m.standingHeight(), worker: m.workerName("motion-compile") }));
`], { encoding: "utf8", env: env === undefined ? bare : { ...bare, COZYCLAY_FIGURE: env } }));

// --- 1 and 2 ---
const CUBE = 0.943;
for (const [value, look, body] of [[undefined, "cube", CUBE], ["", "cube", CUBE], ["cube", "cube", CUBE], ["block", null, 1], ["box", "box", 1]]) {
	const sidecar = read({ env: value }), page = read({ env: "block", handed: value ?? "" }), named = JSON.stringify(value);
	assert.equal(sidecar.sidecar, look, `launch ${named}: the sidecar's look`);
	assert.equal(sidecar.sidecarBody, body, `launch ${named}: the sidecar's body`);
	// a page is handed the launch's value (a launch that names none hands ""), whatever its own process would say
	assert.equal(page.page, look, `launch ${named}: the page's look`);
	assert.equal(page.body, body, `launch ${named}: the page's body is the sidecar's`);
	assert.ok(Math.abs(page.scaled - 1.2 * body) < 1e-12, `launch ${named}: a scale 1.2 rig character is 1.2 x the body`);
	// a worker the page starts is named with the page's value and reads the same look
	const worker = read({ env: "block", worker: page.worker });
	assert.deepEqual([worker.page, worker.body], [look, body], `launch ${named}: the page's worker (${page.worker})`);
	// node with no page around (tests, the sidecar's own default arguments): the environment, as figureOf reads it
	assert.deepEqual([sidecar.page, sidecar.body], [look, body], `launch ${named}: figure.js's own default in the sidecar`);
}
assert.equal(read().standing, 1.7, "nothing named: a character at scale 1 stands 1.70 m");
assert.equal(read({ env: "block" }).standing, 1.739, "the block figure: 1.739 m, as before");
const baked = readFileSync(join(REPO, "vite.config.js"), "utf8");
assert.match(baked, /"import\.meta\.env\.VITE_COZYCLAY_FIGURE": JSON\.stringify\(process\.env\.COZYCLAY_FIGURE \?\? ""\)/, "a dev server bakes in its launch's value as it is: figure.js reads it with the same launchLook");
console.log("ok one value: for every launch value the page and the sidecar read the same look and body; nothing named is the cube look");

// --- 3: no reader of its own ---
const SETS = new Set(["bin/cozyclay.mjs", "src/lowvis/studio/figure.js"]); // the launcher sets it from --figure and hands it to the page
const files = dir => readdirSync(join(REPO, dir), { recursive: true }).filter(f => /\.(m?js|jsx)$/.test(f)).map(f => join(dir, f));
const readers = [...files("bin"), ...files("src")].filter(f => !SETS.has(f)).flatMap(f => readFileSync(join(REPO, f), "utf8").split("\n").map((line, k) => ({ f, k: k + 1, code: line.replace(/\/\/.*$|^\s*\*.*$|\/\*.*?\*\//g, "") })).filter(l => /COZYCLAY_FIGURE|[?&]figure=|get\(["']figure["']\)/.test(l.code)));
assert.deepEqual(readers.map(l => `${l.f}:${l.k}`), [], "every reader of the launch's look goes through figure.js (figureOf, FIGURE, lookBody)");
console.log("PASS verify-figure-default");
