#!/usr/bin/env node
// install: "ifClean" (variant K, deep research 20): installs a clean result, the first take when none is on, and one whose QA
// beats the installed take's (fewer groups, then fewer frame issues); "never" never installs. A hand pushed into a board by
// 3.5 / 4.0 / 3.6 / 3.8 cm gives one COLLIDE group of a different length each.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createStudioAppActions } from "../../src/commands/index.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const sk = skeletonFor("x-bot-tpose"), I = sk.index;
const held = z => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }],
	keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.22, 1.1, 0.32], elbow_r: [-0.5, -1, -0.3] } }, { f: 30, set: { hand_r: [-0.22, 1.1, z] } }, { f: 59, set: { hand_r: [-0.22, 1.1, 0.32] } }] });
const P30 = compileSpec(held(0.36), { sk, scene: { objects: {} } }).out.frames[30].s.P, front = Math.max(P30[I.RightHand][2], P30[I.RightHandMiddle3][2]) + 0.022;
const board = [{ id: "board", name: "Board", renderer: "cube", x: -0.2, y: 0, z: front + 0.035, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.6, scaleY: 1.6, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 }];
const takes = new Map(), owner = { replace: (cid, take) => takes.set(cid, take), motionFor: cid => takes.get(cid) ?? null };
const actor = { id: "c", model: "x-bot-tpose", subject: "C", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
const reg = createStudioAppActions({ state: () => ({ characters: [actor], objects: board, frameCount: 60 }), storeDomain: name => (name === "motion" ? owner : null) });
const run = (z, install) => reg.run("motion.compile", { characterId: "c", spec: held(z), install, repair: false, thin: false }).output;
const issues = o => o.qa.groups.reduce((n, g) => n + (g.count ?? 1), 0);
const a = run(0.38, "ifClean"), on = () => takes.get("c")?.spec;
expect("ifClean with no take on: the first dirty take is installed", a.qa.ok === false && a.installed === true && JSON.stringify(on()) !== undefined, JSON.stringify({ installed: a.installed }));
const firstSpec = JSON.stringify(on());
const b = run(0.36, "never");
expect("never: a better take is not installed", b.installed === false && JSON.stringify(on()) === firstSpec && issues(b) < issues(a), `${issues(a)} -> ${issues(b)}`);
const c = run(0.4, "ifClean");
expect("ifClean: a worse take is not installed", c.installed === false && JSON.stringify(on()) === firstSpec && issues(c) > issues(a), `${issues(a)} -> ${issues(c)}`);
const d = run(0.35, "ifClean");
expect("ifClean: a take that beats the installed one is installed (installs twice in the sequence)", d.installed === true && JSON.stringify(on()) !== firstSpec && issues(d) < issues(a), `${issues(a)} -> ${issues(d)}`);
const e = run(0.3, "ifClean");
expect("ifClean: a clean take is installed", e.qa.ok && e.installed === true);
// a sit spec that repairs and thins (output.repair.ms / thinned.ms below)
const sit = JSON.parse(readFileSync(new URL("./fixtures/h-sit-spec.json", import.meta.url), "utf8"));
const sitTakes = new Map(), sitOwner = { replace: (cid, take) => sitTakes.set(cid, take), motionFor: cid => sitTakes.get(cid) ?? null };
const sitReg = createStudioAppActions({ state: () => ({ characters: [{ ...actor, model: sit.model }], objects: sit.objects, frameCount: 240 }), storeDomain: name => (name === "motion" ? sitOwner : null) });
// INSTALL_WORSE (variant M): install: true over an installed take with fewer QA problems still installs and says so (the installed
// specId, its problems and the new ones); over a worse take there is no note; a take never measured here gets none either
const clean = JSON.stringify(on()), cleanId = e.specId;
const f = run(0.4, true), worseNote = (f.notes ?? []).find(n => n.startsWith("INSTALL_WORSE"));
expect("INSTALL_WORSE: install true over a better installed take installs and notes it", f.installed === true && JSON.stringify(on()) !== clean && Boolean(worseNote)
	&& worseNote.includes(cleanId) && worseNote.includes("(0 QA problems)") && worseNote.includes(`(${f.qa.groups.length})`), JSON.stringify({ installed: f.installed, notes: f.notes }));
const g = run(0.3, true);
expect("INSTALL_WORSE: install true over a worse installed take: no note", g.installed === true && !(g.notes ?? []).some(n => n.startsWith("INSTALL_WORSE")), JSON.stringify(g.notes));
// after a document reload the spec store is empty (a new registry here) while the take stays on: the installed take's QA is
// measured once from its own spec (session eeff213e, deep-36 §4: 12 ifClean compiles in a row after a reload never installed)
const unmeasured = new Map([["c", { schema: "cozyclay.take.v3", spec: held(0.31) }]]), fresh = createStudioAppActions({ state: () => ({ characters: [actor], objects: board, frameCount: 60 }),
	storeDomain: name => (name === "motion" ? { replace: (cid, take) => unmeasured.set(cid, take), motionFor: cid => unmeasured.get(cid) ?? null } : null) });
const h = fresh.run("motion.compile", { characterId: "c", spec: held(0.4), install: true, repair: false, thin: false }).output;
expect("INSTALL_WORSE after a reload: the installed take is measured, and replacing it with a worse one is noted", h.installed === true && (h.notes ?? []).some(n => n.startsWith("INSTALL_WORSE") && n.includes("(0 QA problems)")), JSON.stringify(h.notes));
const reloaded = () => createStudioAppActions({ state: () => ({ characters: [actor], objects: board, frameCount: 60 }), storeDomain: name => (name === "motion" ? owner : null) });
takes.clear(); run(0.38, "ifClean"); run(0.4, "ifClean");
const before = JSON.stringify(on()), afterReload = reloaded(), runR = (z, reg2 = afterReload) => reg2.run("motion.compile", { characterId: "c", spec: held(z), install: "ifClean", repair: false, thin: false }).output;
const worseR = runR(0.4);
expect("ifClean after a reload: a worse take is not installed (the installed take's QA is measured)", worseR.installed === false && JSON.stringify(on()) === before && !(worseR.notes ?? []).length, JSON.stringify({ installed: worseR.installed, notes: worseR.notes }));
const betterR = runR(0.35);
expect("ifClean after a reload: a take that beats the installed one is installed", betterR.qa.ok === false && betterR.installed === true && JSON.stringify(on()) !== before, JSON.stringify({ installed: betterR.installed, problems: issues(betterR) }));
takes.set("c", { schema: "cozyclay.take.v3", spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "noSuchSkill" }] } });
const lostR = runR(0.4, reloaded());
expect("ifClean over a take whose spec no longer compiles: installed, with a note", lostR.installed === true && (lostR.notes ?? []).some(n => n.includes("could not be measured")), JSON.stringify({ installed: lostR.installed, notes: lostR.notes }));
takes.set("c", { schema: "cozyclay.take.v3" });
const nospecR = runR(0.4, reloaded());
expect("ifClean over a take with no spec: installed, with a note", nospecR.installed === true && (nospecR.notes ?? []).some(n => n.includes("could not be measured")), JSON.stringify({ installed: nospecR.installed, notes: nospecR.notes }));
// output.repair.ms (the repair's wall time) and output.thinned.ms on a compile that repaired and thinned, also on the ifClean path
const timed = sitReg.run("motion.compile", { characterId: "c", spec: sit.spec, install: true, repair: { rounds: 1 } }).output;
// thinning stops at its 10 s limit, so a loaded machine may thin nothing here: thinned.ms is checked when it thinned (verify-motion3-thin.mjs pins it)
const thinMs = o => o.thinned === undefined || Number.isInteger(o.thinned.ms);
expect("repair.ms and thinned.ms on a repaired, thinned compile (install true)", Number.isInteger(timed.repair?.ms) && thinMs(timed) && timed.ms.repair >= timed.repair.ms, JSON.stringify({ repair: timed.repair, thinned: timed.thinned }));
sitTakes.clear();
const timedIf = sitReg.run("motion.compile", { characterId: "c", spec: sit.spec, install: "ifClean", repair: { rounds: 1 } }).output;
expect("ifClean that installs: repair.ms is the first job's, thinned.ms the thinning's", timedIf.installed === true && Number.isInteger(timedIf.repair?.ms) && thinMs(timedIf) && timedIf.ms.repair >= timedIf.repair.ms,
	JSON.stringify({ repair: timedIf.repair, thinned: timedIf.thinned, ms: timedIf.ms.repair }));
if (failures) { console.error(`${failures} ifClean check(s) failed`); process.exit(1); }
console.log("verify-motion3-ifclean: all checks passed");
