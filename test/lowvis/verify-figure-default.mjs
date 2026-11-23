#!/usr/bin/env node
// The look rig characters are drawn in has one home (src/lowvis/studio/figure.js): nothing named at launch is the cube
// look (scale 1 = the 1.70 m body, its body 0.943 of the rig's), "block" is the block figure, and the page and the agent
// sidecar always read the same look from the same launch value:
// 1. figureOf (the sidecar: its environment) for each launch value
// 2. the page's look for the same value as a page served by bin/cozyclay.mjs is handed it (window.__COZYCLAY_FIGURE__),
//    and as a dev server bakes it in (vite.config.js): FIGURE, lookBody() and bodyScale() equal the sidecar's; a worker
//    the page starts (motion3-compile.js, named by workerName) reads the page's value
// 3. every place that reads COZYCLAY_FIGURE goes through figure.js: no reader of its own anywhere in bin/ or src/
// 4. the old motion engine (COZYCLAY_MOTION_ENGINE=old) with no look named: the block look on both sides, as it compiles
//    for the rig's own body only; a look named with it is that look
// 5. lookClash: the page says the look it draws in its describe answer; another look than the launch's is told
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)), FIGURE = join(REPO, "src/lowvis/studio/figure.js");
const { COZYCLAY_FIGURE: _named, ...bare } = process.env;
/** figure.js imported fresh in a process of its own: the sidecar with COZYCLAY_FIGURE = env, a page handed `handed`,
 *  or a worker of the name `worker`. */
const read = ({ env, handed, handedEngine, worker, engine } = {}) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
	${handed === undefined ? "" : `globalThis.window = { __COZYCLAY_FIGURE__: ${JSON.stringify(handed)}, __COZYCLAY_MOTION_ENGINE__: ${JSON.stringify(handedEngine ?? "")} };`}
	${worker === undefined ? "" : `globalThis.self = { name: ${JSON.stringify(worker)} };`}
	const m = await import(${JSON.stringify(FIGURE)});
	console.log(JSON.stringify({ value: m.launchValue(), sidecar: m.figureOf(), page: m.FIGURE, body: m.lookBody(), sidecarBody: m.lookBody(m.figureOf()), scaled: m.bodyScale({ model: "x-bot-tpose", scale: 1.2 }), standing: m.standingHeight(), worker: m.workerName("motion-compile") }));
`], { encoding: "utf8", env: { ...bare, ...(env === undefined ? {} : { COZYCLAY_FIGURE: env }), ...(engine === undefined ? {} : { COZYCLAY_MOTION_ENGINE: engine }) } }));

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
const HANDS = 'window.__COZYCLAY_FIGURE__ = ${JSON.stringify(process.env.COZYCLAY_FIGURE ?? "").replaceAll("<", "\\\\u003c")}; window.__COZYCLAY_MOTION_ENGINE__ = ${JSON.stringify(process.env.COZYCLAY_MOTION_ENGINE ?? "").replaceAll("<", "\\\\u003c")};';
const baked = readFileSync(join(REPO, "vite.config.js"), "utf8");
assert.match(baked, /"import\.meta\.env\.VITE_COZYCLAY_FIGURE": JSON\.stringify\(launchValue\(process\.env\)\)/, "a dev server bakes in its launch's value (launchValue): figure.js reads it with the same launchLook");
assert.ok(readFileSync(join(REPO, "bin/cozyclay.mjs"), "utf8").includes(HANDS), "the launcher hands the page its launch's COZYCLAY_FIGURE and COZYCLAY_MOTION_ENGINE as given: figure.js reads them with the same launchValue");
console.log("ok one value: for every launch value the page and the sidecar read the same look and body; nothing named is the cube look");

// --- 3: no reader of its own ---
const SETS = new Set(["src/lowvis/studio/figure.js"]); // the one reader (launchValue); bin/cozyclay.mjs only hands the launch's two values on (HANDS)
const files = dir => readdirSync(join(REPO, dir), { recursive: true }).filter(f => /\.(m?js|jsx)$/.test(f)).map(f => join(dir, f));
const readers = [...files("bin"), ...files("src")].filter(f => !SETS.has(f)).flatMap(f => readFileSync(join(REPO, f), "utf8").split("\n").map((line, k) => ({ f, k: k + 1, code: line.replace(/\/\/.*$|^\s*\*.*$|\/\*.*?\*\//g, "") })).filter(l => /COZYCLAY_FIGURE|[?&]figure=|get\(["']figure["']\)/.test(l.code.replace(HANDS, "")))); // but the launcher's write of launchValue into the page
assert.deepEqual(readers.map(l => `${l.f}:${l.k}`), [], "every reader of the launch's look goes through figure.js (figureOf, FIGURE, lookBody)");
console.log("ok no reader of COZYCLAY_FIGURE but figure.js");

// --- 4: the old motion engine ---
for (const [env, look, body, value] of [[undefined, null, 1, "block"], ["", null, 1, "block"], ["cube", "cube", CUBE, "cube"], ["block", null, 1, "block"]]) {
	// the launcher's page is handed the launch's two values as given; a dev server's page has launchValue baked in (the worker's name carries it)
	const sidecar = read({ env, engine: "old" }), page = read({ env: "cube", handed: env ?? "", handedEngine: "old" }), worker = read({ env: "cube", worker: page.worker });
	assert.deepEqual([sidecar.value, sidecar.sidecar, sidecar.sidecarBody], [value, look, body], `the old engine, launch ${JSON.stringify(env)}: the sidecar`);
	assert.deepEqual([page.page, page.body], [look, body], `the old engine, launch ${JSON.stringify(env)}: the page handed ${JSON.stringify(env ?? "")} and the engine`);
	assert.deepEqual([worker.page, worker.body], [look, body], `the old engine, launch ${JSON.stringify(env)}: the page's worker (${page.worker})`);
}
assert.equal(read({ engine: "lowvis" }).sidecar, "cube", "any other engine value: the default look");
// the engine switch is judged once (figure.js oldMotionEngine, which bin/agent/motion-engine.mjs reads): the two agree
const { motionEngine } = await import(join(REPO, "bin/agent/motion-engine.mjs")), { launchValue } = await import(FIGURE);
for (const engine of [undefined, "", "old", "OLD", "lowvis", " old"]) assert.equal(launchValue({ COZYCLAY_MOTION_ENGINE: engine }) === "block", motionEngine({ COZYCLAY_MOTION_ENGINE: engine }) === "old", `COZYCLAY_MOTION_ENGINE=${JSON.stringify(engine)}: the block look exactly where the old engine is on`);
console.log("ok the old engine with no look named: the block look, the rig's own body, on both sides");

// --- 5: a page of another look ---
const { lookClash } = await import(FIGURE);
assert.equal(lookClash({ figure: "cube" }, {}), null);
assert.equal(lookClash({ figure: "block" }, { COZYCLAY_FIGURE: "block" }), null);
assert.equal(lookClash({ figure: "block" }, { COZYCLAY_MOTION_ENGINE: "old" }), null);
assert.equal(lookClash({}, {}), null, "a page that says no look is not checked");
assert.match(lookClash({ figure: "block" }, {}), /^The Studio page draws rig characters in the look "block" and this Studio was started for the look "cube": .* start the Studio with COZYCLAY_FIGURE=block\.$/);
assert.match(lookClash({ figure: "cube" }, { COZYCLAY_FIGURE: "block" }), /in the look "cube" and this Studio was started for the look "block"/);
assert.match(readFileSync(join(REPO, "src/App.jsx"), "utf8"), /figure: FIGURE \?\? "block",/, "the page's describe answer says the look it draws");
console.log("PASS verify-figure-default");
