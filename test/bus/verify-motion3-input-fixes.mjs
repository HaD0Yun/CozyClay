#!/usr/bin/env node
// C19 lenient inputs: the mechanical slips that cost the Studio agent a refused call (71 refusals in 66 audited
// sessions) are fixed and named in output.adjusted, and what would change the meaning is still refused.
// Each rule through the real action registry on the cup scene: a goal window past the clip, keys with pos
// only, a near-unit rot, a patch replace on a missing member, install and repair spellings, probes.
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "../motion3/fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { relaxSpec, normalizeCompileArgs, clampFrames } from "../../src/motion3/lenient.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures += 1; };
const json = JSON.stringify;
const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const ports = { state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 120 }), storeDomain: n => (n === "motion" ? owner : null) };
const registry = createStudioAppActions(ports);
const compile = args => registry.run("motion.compile", { characterId: CHARACTER.id, install: false, ...args });
const refused = run => { try { run(); return ""; } catch (error) { return `${error.code ?? ""} ${error.message}`; } };
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS), cupRest = scene.groups[CUP.group].pos;

const idle = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }] };
const grip = { ...idle, frames: 70, use: [...idle.use, { skill: "reachGrip", f0: 4, args: { anchor: "cupHold", side: "r", hold: 20, define: { kind: "object", object: CUP.group, local: [0, 0.05, 0] } } }] };
const lifted = [CHARACTER.x - 0.03, 1.2, CHARACTER.z + 0.4];
const carry = keys => ({ ...grip, objects: { [CUP.group]: { prop: "cupHoldGrip", grab: 26, keys } } });

// 1. goal windows: a range past the clip is cut to it; one wholly past it is still refused
const goal = at => ({ ...idle, goals: [{ name: "cup stays", still: `object:${CUP.group}`, at }] });
const cut = compile({ spec: goal([30, 90]) });
expect("a goal window past the clip is cut to it and named in output.adjusted", cut.output.qa.goals[0].ok === true
	&& json(cut.output.adjusted) === json(['goals[0] "cup stays" at [30,90] -> [30,59]: the clip is 0..59']) && /1 input adjusted \(output\.adjusted\)/.test(cut.summary), json({ adjusted: cut.output.adjusted, summary: cut.summary }));
expect("a window wholly past the clip is still refused with the C7 advice", /goals\[0\]\.at = \[70,90\] is outside 0\.\.59 \(spec\.frames 60\); set frames >= 91/.test(refused(() => compile({ spec: goal([70, 90]) }))));
expect("the stored spec keeps the window as sent (the fix is in the measured copy)", json(compileSpec(goal([30, 90]), { sk, scene }).spec.goals[0].at) === "[30,90]");

// 2. keys with pos only: a carry takes the scene pose's +Y as aim (the arm picks the roll), exactly as if written
const bare = compile({ spec: carry([{ f: 26, pos: cupRest }, { f: 50, pos: lifted }]) });
const written = compile({ spec: carry([{ f: 26, pos: cupRest, aim: [0, 1, 0] }, { f: 50, pos: lifted, aim: [0, 1, 0] }]) });
expect("carry keys with pos only compile as the scene's upright aim, named", json(bare.output.adjusted) === json([`objects.${CUP.group}.keys[0,1] had no rot or aim: +Y as in the scene, aim [0,1,0]`])
	&& bare.output.qa.total === written.output.qa.total && json(bare.output.observations.held) === json(written.output.observations.held), json({ adjusted: bare.output.adjusted, qa: [bare.output.qa.total, written.output.qa.total] }));
const between = compileSpec(carry([{ f: 26, pos: cupRest, aim: [0, 1, 0] }, { f: 40, pos: lifted }, { f: 50, pos: lifted, aim: [0, 0.8, -0.6] }]), { sk, scene });
expect("a pos-only key between turned keys holds the turn of the key before it", json(between.expanded.objects[CUP.group].keys[1].aim) === "[0,1,0]"
	&& /keys\[1\] had no rot or aim: each holds the turn of the nearest key before it/.test(between.notes?.[0]), json(between.notes));
const free = compileSpec({ ...idle, objects: { [CUP.group]: { keys: [{ f: 10, pos: [0.2, 0.9, 0.85] }] } } }, { sk, scene });
expect("a free entry's pos-only key keeps its scene turn (rot)", json(free.expanded.objects[CUP.group].keys[0].rot) === "[0,0,0,1]" && /turned as in the scene/.test(free.notes?.[0]), json(free.notes));
const rolled = refused(() => compileSpec(carry([{ f: 26, pos: cupRest, roll: 20 }]), { sk, scene }));
expect("a key with roll but no aim is still refused (its meaning is unclear)", /keys\[0\]\.roll turns the object about aim/.test(rolled), rolled);

// 3. a near-unit rot is normalized; far from unit it is still refused
const q = [0, 0.38268343, 0, 0.92387953], long = q.map(v => v * 1.1);
const norm = compileSpec({ ...idle, objects: { [CUP.group]: { keys: [{ f: 10, pos: cupRest, rot: long }] } } }, { sk, scene });
expect("a rot of length 1.1 is normalized and named", norm.expanded.objects[CUP.group].keys[0].rot.every((v, i) => Math.abs(v - q[i]) < 1e-6) && /rot had length 1\.100: normalized/.test(norm.notes?.[0]), json(norm.notes));
expect("a rot of length 2 is still refused", /rot must be a unit quaternion \[x, y, z, w\], got \[0,0,0,2\]/.test(refused(() => compileSpec({ ...idle, objects: { [CUP.group]: { keys: [{ f: 10, pos: cupRest, rot: [0, 0, 0, 2] }] } } }, { sk, scene }))));

// 4. patch: replace on a missing member of an existing object adds it (motion.compile); repair stays strict
const keyed = { ...idle, keys: [{ f: 0, set: { spine_pitch: 0 } }] };
const base = compile({ spec: keyed }).output.specId;
const patched = compile({ base, patch: [{ op: "replace", path: "/keys/0/set/head_pitch", value: 10 }] });
expect("replace on a missing member adds it, named", /patch\[0\] \(replace \/keys\/0\/set\/head_pitch\): \/keys\/0\/set\/head_pitch did not exist \(set has spine_pitch\); added/.test(patched.output.adjusted?.[0]), json(patched.output.adjusted));
expect("a replace at a missing array index is still refused", /\/keys\/3 does not exist \(keys has 1 entries; by f: \/keys\/@f=<f>, f 0\)/.test(refused(() => compile({ base, patch: [{ op: "replace", path: "/keys/3/f", value: 1 }] }))));
expect("applyPatch without notes (repair) stays strict", /does not exist \(set has spine_pitch\)/.test(refused(() => applyPatch(keyed, [{ op: "replace", path: "/keys/0/set/head_pitch", value: 10 }]))));
const unknown = refused(() => compile({ base, patch: [{ op: "replace", path: "/keys/0/set/zzz", value: 10 }] }));
expect("an added member the spec does not know is then refused by the validator", /sets unknown channel "zzz"/.test(unknown), unknown);

// 5. install and repair spellings; an unknown word is still refused
expect("install \"always\" installs", compile({ spec: idle, install: "always" }).output.installed === true && takes.has(CHARACTER.id));
const ifClean = compile({ spec: idle, install: "if_clean" });
expect("install \"if_clean\" is ifClean (its summary says what ifClean did)", ifClean.output.installed === true && /already installed|; installed/.test(ifClean.summary), ifClean.summary);
expect("install \"sometimes\" is still refused by the schema", /install must be true, false, "ifClean" or "never", got "sometimes"/.test(refused(() => compile({ spec: idle, install: "sometimes" }))));
expect("repair: { rounds: 0 } is no repair; repair: true is the default rounds", !("repair" in compile({ spec: idle, repair: { rounds: 0 } }).output)
	&& json(normalizeCompileArgs({ repair: true })) === json({ repair: {} }) && json(normalizeCompileArgs({ repair: false })) === json({ repair: false }) && json(normalizeCompileArgs({ install: "never" })) === json({ install: "never" }));

// 6. probes through the action: the cut window and the grown every are named, the summary counts them
const probed = compile({ spec: idle, probes: [{ name: "hips", position: "joint:Hips", frames: [10, 90], every: 2 }] });
expect("a probe past the take and too dense answers, with both fixes named", probed.output.probes.hips.at.length <= 16 && probed.output.adjusted?.length === 2 && /2 inputs adjusted/.test(probed.summary), json(probed.output.adjusted));

// 7. relaxSpec leaves a clean spec alone; clampFrames keeps frames inside the range
const clean = JSON.parse(json(carry([{ f: 26, pos: cupRest, aim: [0, 1, 0] }]))), notes = [];
expect("relaxSpec changes nothing on a spec that needs nothing", json(relaxSpec(JSON.parse(json(clean)), scene, notes)) === json(clean) && notes.length === 0);
expect("clampFrames: inside frames unchanged, no note", json(clampFrames([5, 1, 3], [0, 9])) === json({ frames: [1, 3, 5] }));

// 8. motion.report without part reads the groups, as { part: "groups" } does
const reported = compile({ spec: goal([30, 90]) }).output.specId;
expect("motion.report without part pages the groups", json(registry.run("motion.report", { specId: reported }).output) === json(registry.run("motion.report", { specId: reported, part: "groups" }).output));

// 9. a repaired compile says how long its repair took (output.ms.repair); a plain one has no repair time
const repairedMs = compile({ spec: idle, repair: { rounds: 1 } }).output.ms, plainMs = compile({ spec: idle }).output.ms;
expect("output.ms.repair is the repair's wall time, only when repair ran", Number.isInteger(repairedMs.repair) && repairedMs.repair >= 0 && !("repair" in plainMs), json({ repairedMs, plainMs }));

if (failures) { console.error(`${failures} input-fix check(s) failed`); process.exit(1); }
console.log("verify-motion3-input-fixes: all checks passed");
