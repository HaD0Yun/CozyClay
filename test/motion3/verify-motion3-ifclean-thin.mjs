#!/usr/bin/env node
// install: "ifClean" does not thin a repaired take that will not go on over the installed one (compile-job.js ifCleanOver,
// install-verdict.js): thinning it costs compiles for keys no take keeps. Over none, or over a take it beats, it thins as before.
import { readFileSync } from "node:fs";
import { motionScene } from "../../src/motion3/scene.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { installVerdict } from "../../src/motion3/install-verdict.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures += 1; };
const json = JSON.stringify;

// the verdict: clean or first goes on; unmeasured goes on with a note; else fewer groups, then fewer frame issues
const g = (...counts) => counts.map(count => ({ count }));
expect("verdict: a clean take goes on", installVerdict({ groups: [] }, { ok: true, groups: [] }).wanted === true);
expect("verdict: the first take goes on", installVerdict(null, { ok: false, groups: g(3) }).wanted === true);
expect("verdict: over an unmeasured take it goes on, with a note", installVerdict({ groups: null }, { ok: false, groups: g(1) }).note?.includes("could not be measured"));
expect("verdict: fewer groups goes on", installVerdict({ groups: g(1, 1) }, { ok: false, groups: g(5) }).wanted === true);
expect("verdict: same groups, fewer issues goes on", installVerdict({ groups: g(4) }, { ok: false, groups: g(2) }).wanted === true);
expect("verdict: a worse take stays off", installVerdict({ groups: g(1) }, { ok: false, groups: g(1, 1) }).wanted === false);

// ifClean over an installed take this one does not beat: not thinned (the same keys as thin: false); over none: thinned
const sit = JSON.parse(readFileSync(new URL("./fixtures/h-sit-spec.json", import.meta.url), "utf8"));
const job = extra => runCompileJob({ model: sit.model, scene: motionScene(sit.objects), spec: sit.spec, repair: { rounds: 1, limitMs: Infinity }, installing: true, thinLimitMs: 120000, hintLimitMs: 0, ...extra });
const none = job({ ifCleanOver: null }), plain = job({}), off = job({ ifCleanOver: { groups: [] } }), unthinned = job({ thin: false });
expect("ifClean with no take on: thinned as an installing compile is", Boolean(none.thinned?.removed.length) && json(none.stored) === json(plain.stored), json(none.thinned));
expect("ifClean over a clean take: a take with QA problems is not thinned (its keys as repaired, no output.thinned)", off.qa.groups.length > 0 && off.thinned === undefined && json(off.stored) === json(unthinned.stored), json(off.thinned));
expect("ifClean over a take it beats: thinned", job({ ifCleanOver: { groups: Array.from({ length: 50 }, () => ({ count: 1 })) } }).thinned?.removed.length === none.thinned.removed.length);

if (failures) { console.error(`${failures} ifClean thinning check(s) failed`); process.exit(1); }
console.log("verify-motion3-ifclean-thin: all checks passed");
