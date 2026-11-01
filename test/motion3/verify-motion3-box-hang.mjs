#!/usr/bin/env node
// The bench box hang (M2 de4c3bd5, box-m2f-r1/r4/r5 at 240.0 s): a carry with walkTo { arrive } paid all 22 walk-plan probes on
// every compile, because the probe has no moving objects and the hands gripping the box missed it (arm REACH) on every
// candidate; then checkHints compiled two hint patches with no time bound. walk-plan.js leaves arm REACH out of a walk's
// issues; compile-job.js stops compiling hint patches past HINT_LIMIT_MS (a patch repair already compiled is still checked).
// box-m2f-r2 still paid 22 probes (no cadence walked clean with the box left out); a carry checks at most CARRY_TRIALS.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { checkHints } from "../../src/motion3/hint-check.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// 1. the r5 carry plans its walk on a few probes (it took 22, ~25 s of a 34 s compile on the Mac)
const r5 = load("bench-box-m2f-r5-spec.json");
const planned = compileSpec({ fps: 24, ...r5.spec }, { sk: skeletonFor("x-bot-tpose"), scene: motionScene(r5.objects) }, {}).observations.planned ?? [];
const checked = Number(/\((\d+) checked\)/.exec(planned[0] ?? "")?.[1]);
expect("box carry: the walk is planned", planned.length === 1, JSON.stringify(planned));
// arm REACH on the gripped box does not count: before, every candidate showed 178 issues (the hands missing the box) and none walked clean
const left = /no candidate walked clean \((\d+) issues/.exec(planned[0] ?? "")?.[1];
expect("box carry: the walk is planned within 6 probes, with at most a few issues left (arm REACH on the gripped box does not count)", checked <= 6 && (left === undefined || Number(left) <= 10), planned[0]);

// 1b. the r2 carry walks clean on no candidate (the probe leaves the box out: the right forearm pops and flips on every
// one); a spec that carries an object checks at most 6 cadences (it checked 22, ~35 s of a 37 s compile on the Mac)
const r2 = load("bench-box-m2f-r2-spec.json");
const t2 = performance.now();
const planned2 = compileSpec({ fps: 24, ...r2.spec }, { sk: skeletonFor("x-bot-tpose"), scene: motionScene(r2.objects) }, {}).observations.planned ?? [];
const checked2 = Number(/\((\d+) checked\)/.exec(planned2[0] ?? "")?.[1]);
expect("box carry r2: the walk is planned", planned2.length === 1, JSON.stringify(planned2));
expect("box carry r2: at most 6 cadences checked for a carried object", checked2 >= 1 && checked2 <= 6, `${planned2[0]} (${Math.round(performance.now() - t2)} ms)`);

// 2. checkHints: a compile that answers null (out of time) drops the patch and says so
const qa = { groups: [{ kind: "SLIDE", subject: "Left ball slides", count: 2, severity: 2, patch: [{ op: "add", path: "/keys/-", value: { f: 1, set: {} } }] }] };
checkHints({ keys: [] }, qa, () => null);
expect("checkHints: null from compile drops the patch", qa.groups[0].patch === undefined && /not compiled \(the compile had used its time\)/.test(qa.groups[0].patchTried ?? ""), JSON.stringify(qa.groups[0]));

// 3. compile-job: past the limit an uncompiled hint patch is not compiled; one repair compiled is still checked
// both limits set, so the result does not depend on the machine: repairLimitMs 1 stops the repair before its first round
// (no patch compiled by repair), Infinity lets the round run in full
const job = (doc, hintLimitMs, repairLimitMs) => runCompileJob({ model: "x-bot-tpose", scene: motionScene(doc.objects ?? []), spec: doc.spec, repair: { rounds: 1, limitMs: repairLimitMs }, hintLimitMs });
const box2 = job(load("bench-box2-spec.json"), 0, 1).qa.groups.filter(g => g.patchTried);
expect("box2, hintLimitMs 0: its hint patches are not compiled", box2.length > 0 && box2.every(g => /not compiled/.test(g.patchTried)), JSON.stringify(box2.map(g => g.patchTried)));
const parkour = job(load("bench-parkour-spec.json"), 0, Infinity).qa.groups.filter(g => g.patchTried);
expect("parkour, hintLimitMs 0: patches repair compiled are still checked", parkour.length > 0 && parkour.every(g => /compiled, did not help|helped/.test(g.patchTried) && !/not compiled/.test(g.patchTried)), JSON.stringify(parkour.map(g => g.patchTried)));

if (failures) { console.error(`${failures} box-hang check(s) failed`); process.exit(1); }
console.log("verify-motion3-box-hang: all checks passed");
