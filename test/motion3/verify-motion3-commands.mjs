#!/usr/bin/env node
// motion.compile / motion.qa / motion.sample through the real action registry with stub ports.
import { createStudioAppActions } from "../../src/commands/index.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { specIdOf } from "../../src/motion3/spec-store.js";
import { keyObject } from "../../src/motion3/key-edit.js";
import { expandUse } from "../../src/motion3/skills/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { SCENE_OBJECTS as CAR_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { SCENE_OBJECTS as CUP_OBJECTS } from "./fixtures/cup-scene.mjs";
import { draftTelemetrySeam } from "../../src/motion-draft-telemetry.js";
import { strictPropValidator } from "../../src/analytics-strict.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const takes = new Map();
let replaced = 0;
const owner = { replace: (id, take) => { replaced += 1; takes.set(id, take); }, motionFor: id => takes.get(id) ?? null };
const character = { id: "char-1", model: "x-bot-tpose", subject: "Cascy", x: 1, y: 0, z: 2, rot: 90, scale: 1 };
const objects = [{ id: "wall", name: "Wall", renderer: "cube", x: 4.7, y: 0, z: 2, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.2, scaleY: 2, scaleZ: 2, footprint: { width: 1, depth: 1 }, height: 1 }];
const ports = { state: () => ({ characters: [character], objects, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) };
const registry = createStudioAppActions(ports);
const run = (id, args) => registry.run(id, args);
// motion:draft_compiled: one event per compile draft, captured at the telemetry seam.
const drafts = [];
const restoreDrafts = draftTelemetrySeam((event, props) => drafts.push({ event, props }));

const sk = skeletonFor("x-bot-tpose"), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
// The character stands at (1, 0, 2) facing +X (rot 90): its left is -Z.
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 200,
	keys: [{ f: 0, set: { root: [1, P[I.Hips][1] - 0.01, 2], yaw: 90, foot_l: [1.03, ank, 1.91], foot_r: [0.97, ank, 2.09], fyaw_l: 90, fyaw_r: 90 } }],
	generators: [{ type: "walk", f0: 8, steps: 6, heading: [90, 90] }] };

let receipt = run("motion.compile", { characterId: "char-1", spec });
const out = receipt?.output ?? receipt?.receipt?.output ?? receipt;
expect("motion.compile answers frames and QA", out?.frames === 200 && typeof out?.qa?.ok === "boolean", JSON.stringify(receipt).slice(0, 300));
expect("a straight walk that stops short of the wall is clean", out?.qa?.ok === true, JSON.stringify(out?.qa?.groups?.slice(0, 3)));
const take = takes.get("char-1");
expect("the take v3 is installed with frames and the spec", take?.schema === "cozyclay.take.v3" && take.frames === 200 && JSON.stringify(take.spec) === JSON.stringify(spec));

const sample = run("motion.sample", { characterId: "char-1", frames: [0, 199], bones: ["Hips", "LeftFoot"] });
const rows = (sample?.output ?? sample).frames;
expect("motion.sample returns world positions in the scene frame", Math.abs(rows[0].bones.Hips[0] - 1) < 0.02 && Math.abs(rows[0].bones.Hips[2] - 2) < 0.02, JSON.stringify(rows[0]));
expect("the walk travels toward +X", rows[1].bones.Hips[0] > 2.5, JSON.stringify(rows[1]));

const long = { ...spec, generators: [{ type: "walk", f0: 8, steps: 14, heading: [90, 90] }], frames: 340 };
const bad = (r => r?.output ?? r)(run("motion.compile", { characterId: "char-1", spec: long, install: false }));
expect("walking through the wall is reported, and install: false leaves the take alone", bad.qa.groups.some(g => g.kind === "COLLIDE" && /Wall|wall/.test(g.subject)) && takes.get("char-1").frames === 200, JSON.stringify(bad.qa.groups.slice(0, 3)));
const qa = (r => r?.output ?? r)(run("motion.qa", { characterId: "char-1" }));
expect("motion.qa re-measures the installed take", qa.qa.ok === true);

let refused = null;
try { run("motion.compile", { characterId: "char-1", spec: { ...spec, fps: 30 } }); } catch (error) { refused = error; }
expect("a spec at another frame rate is refused", refused?.code === "INVALID_ARGUMENT" || /fps/.test(JSON.stringify(refused ?? "")), String(refused));
// Two compiles published two drafts; motion.qa and the refused compile published none.
const allowed = strictPropValidator("motion:draft_compiled");
expect("motion:draft_compiled: one event per compile draft, none for motion.qa or a refused spec", drafts.length === 2 && drafts.every(row => row.event === "motion:draft_compiled"), JSON.stringify(drafts));
expect("motion:draft_compiled: every value is in its closed set", drafts.every(({ props }) => Object.entries(props).every(([key, value]) => allowed(key, value))), JSON.stringify(drafts));
expect("motion:draft_compiled: the clean installed walk, then the dirty probe that was not installed",
	drafts[0]?.props.draft_index === "1" && drafts[0].props.qa_clean === true && drafts[0].props.installed === true && drafts[0].props.frames === "121-480" && drafts[0].props.qa_problems === "0"
	&& drafts[1]?.props.draft_index === "2" && drafts[1].props.qa_clean === false && drafts[1].props.installed === false && drafts[1].props.frames === "121-480" && drafts[1].props.qa_frames !== "0",
	JSON.stringify(drafts.map(row => row.props)));
restoreDrafts();

// install: "ifClean" installs only a clean final result (qa.ok, goals included, after repair), in the same compile.
const ifClean = args => registry.run("motion.compile", { characterId: "char-1", install: "ifClean", ...args });
const before = takes.get("char-1"), count = () => replaced;
let n = count(), r = ifClean({ spec: long });
expect("ifClean: a dirty spec is not installed, the take is unchanged, no affectedIds", r.output.qa.ok === false && r.output.installed === false && r.affectedIds.length === 0
	&& takes.get("char-1") === before && count() === n && /not installed/.test(r.summary), JSON.stringify({ installed: r.output.installed, ids: r.affectedIds, summary: r.summary }));
const missed = { ...spec, goals: [{ name: "hand at head", near: ["joint:LeftHand", "joint:Head"], tol: 0.02, at: 100 }] };
r = ifClean({ spec: missed });
expect("ifClean: a failed goal (no other issue) is not installed", r.output.qa.goals?.[0]?.ok === false && r.output.qa.groups.every(g => g.kind === "GOAL")
	&& r.output.installed === false && r.affectedIds.length === 0 && takes.get("char-1") === before && count() === n, JSON.stringify(r.output.qa.groups.slice(0, 2)));
const met = { ...spec, frames: 210, goals: [{ name: "walked", above: ["joint:Head", "joint:LeftFoot"], by: 1, at: 100 }] };
r = ifClean({ spec: met });
const metTake = takes.get("char-1");
expect("ifClean: a clean spec (goals met) is installed, with affectedIds; output.specId names the installed take's spec", r.output.qa.ok && r.output.installed === true
	&& r.affectedIds[0] === "char-1" && count() === n + 1 && metTake.frames === 210 && r.output.specId === specIdOf(metTake.spec) && r.output.specId === specIdOf(met), JSON.stringify(r.output.qa.groups.slice(0, 2)));
n = count();
r = ifClean({ base: r.output.specId });
expect("ifClean: the take already installed stays as it is (installed: true, no replace, no affectedIds)", r.output.qa.ok && r.output.installed === true && r.affectedIds.length === 0
	&& takes.get("char-1") === metTake && count() === n && /already installed/.test(r.summary), r.summary);
r = ifClean({ base: r.output.specId, patch: [{ op: "replace", path: "/frames", value: 220 }] });
expect("ifClean with base + patch: the clean patched spec is installed and output.specId names it", r.output.qa.ok && r.output.installed === true && r.output.delta?.base === specIdOf(met)
	&& takes.get("char-1").frames === 220 && r.output.specId === specIdOf(takes.get("char-1").spec) && r.output.specId !== specIdOf(met));
const cleanTake = takes.get("char-1");
r = ifClean({ base: r.output.specId, patch: [{ op: "replace", path: "/generators/0/steps", value: 14 }, { op: "replace", path: "/frames", value: 340 }] });
expect("ifClean with base + patch: a dirty patched spec is not installed", r.output.qa.ok === false && r.output.installed === false && takes.get("char-1") === cleanTake);
r = registry.run("motion.compile", { characterId: "char-1", spec: long });
expect("install: true still installs a dirty spec", r.output.qa.ok === false && r.output.installed === true && takes.get("char-1").frames === 340 && r.affectedIds[0] === "char-1");
// "yes" is an install spelling (C19, normalizeCompileArgs); a word that is none is refused
const wrongInstall = (() => { try { registry.run("motion.compile", { characterId: "char-1", spec, install: "maybe" }); return null; } catch (error) { return error; } })();
expect("install takes only true, false, \"ifClean\" or \"never\" (and their spellings)", wrongInstall?.code === "INVALID_ARGUMENT", String(wrongInstall));

// ifClean + repair: a hand 1.5 cm into a board; repair reaches qa.ok and the repaired spec is installed.
const boardTakes = new Map();
const boardOwner = { replace: (cid, take) => boardTakes.set(cid, take), motionFor: cid => boardTakes.get(cid) ?? null };
const still = { id: "char-2", model: "x-bot-tpose", subject: "Still", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
const held = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }],
	keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.22, 1.1, 0.32], elbow_r: [-0.5, -1, -0.3] } }, { f: 30, set: { hand_r: [-0.22, 1.1, 0.36] } }, { f: 59, set: { hand_r: [-0.22, 1.1, 0.32] } }] };
const P30 = compileSpec(held, { sk, scene: { objects: {} } }).out.frames[30].s.P, front = Math.max(P30[I.RightHand][2], P30[I.RightHandMiddle3][2]) + 0.022;
const board = [{ id: "board", name: "Board", renderer: "cube", x: -0.2, y: 0, z: front + 0.035, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.6, scaleY: 1.6, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 }];
const boardReg = createStudioAppActions({ state: () => ({ characters: [still], objects: board, frameCount: 60 }), storeDomain: name => (name === "motion" ? boardOwner : null) });
r = boardReg.run("motion.compile", { characterId: "char-2", spec: held, install: "ifClean", repair: false });
expect("ifClean without repair on a character with no take: the first (dirty) take is installed", r.output.qa.ok === false && r.output.installed === true && boardTakes.has("char-2"));
r = boardReg.run("motion.compile", { characterId: "char-2", spec: held, install: "ifClean", repair: { rounds: 4 } });
const repaired = boardTakes.get("char-2");
expect("ifClean + repair: repaired to clean, the repaired spec is installed and output.specId names it", r.output.qa.ok && r.output.installed === true && r.output.repair.applied.length >= 1
	&& repaired?.spec?.fix?.penetration === 0.02 && r.output.specId === specIdOf(repaired.spec) && r.output.specId !== specIdOf(held), JSON.stringify(r.output.repair));

// motion.keyObject's edit (key-edit.js, C14): a door a skill hinges takes its channel key; a part of a carried group names the group.
const carScene = motionScene(CAR_OBJECTS), sat = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 300,
	use: [{ skill: "sitInSeat", f0: 0, args: { car: "Car" } }, { skill: "exitCar", f0: 0, args: { car: "Car", side: "l" } }] };
const skillObjects = expandUse(sat, { sk: skeletonFor("x-bot-tpose"), scene: carScene }).spec.objects, [door, hinge] = Object.entries(skillObjects).find(([, o]) => o.channel);
const doorKey = keyObject(sat, carScene, { objectId: door, frame: 120, angle: -25 }, skillObjects);
expect("keyObject: a door the exitCar skill hinges takes a key on its channel in spec.keys (the skill's entry stays the skill's)", JSON.stringify(doorKey.keyed) === JSON.stringify({ objectId: door, kind: "hinge", channel: hinge.channel, f: 120, angle: -25 })
	&& JSON.stringify(doorKey.spec.keys) === JSON.stringify([{ f: 120, set: { [hinge.channel]: -25 } }]) && doorKey.spec.objects === undefined, JSON.stringify(doorKey));
const cupHeld = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100, props: { grip: { hand: "l", origin: ["LeftHandIndex2"] } }, objects: { "empty-2": { prop: "grip", grab: 34 } } };
let part = "";
try { keyObject(cupHeld, motionScene(CUP_OBJECTS), { objectId: "cube-6", frame: 50, pos: [0, 1, 0], rot: [0, 0, 0, 1] }); } catch (error) { part = error.message; }
expect("keyObject: a part of a carried group names the group to key", part === 'MOTION_SPEC_INVALID: "cube-6" moves with "empty-2" (spec.objects.empty-2); key "empty-2" with its root pose', part);

// A hybrid project (scenes domain castStyle) gets the capsule hint on that collision; a rig project does not.
const styled = style => createStudioAppActions({ ...ports, storeDomain: name => (name === "motion" ? owner : name === "scenes" ? { metadata: () => ({ castStyle: style }) } : null) });
const hinted = style => (r => r?.output ?? r)(styled(style).run("motion.compile", { characterId: "char-1", spec: long, install: false }));
expect("a hybrid project's colliding take carries the capsule hint", hinted("hybrid").hint === "hybrid project: propose capsule figures to the user before more repairs", JSON.stringify(hinted("hybrid").qa.groups.slice(0, 2)));
expect("a rig project's colliding take carries no hint", hinted("rig").hint === undefined && bad.hint === undefined);
// PATCH_TOO_BROAD (patch-guard.js): a patch that mixes /fix with key edits is applied and answered with the note
const broadBase = boardReg.run("motion.compile", { characterId: "char-2", spec: held, install: false }).output.specId;
r = boardReg.run("motion.compile", { characterId: "char-2", base: broadBase, install: false, patch: [{ op: "replace", path: "/keys/@f=30/set/hand_r", value: [-0.22, 1.1, 0.34] }, { op: "add", path: "/fix", value: { retime: false } }] });
const narrow = boardReg.run("motion.compile", { characterId: "char-2", base: broadBase, install: false, patch: [{ op: "add", path: "/fix", value: { retime: false } }] });
expect("PATCH_TOO_BROAD: /fix mixed with key edits is noted and still applied; a narrow patch carries no note", /^PATCH_TOO_BROAD \/fix mixed with key edits/.test(r.output.notes?.[0] ?? "")
	&& r.output.specId !== broadBase && narrow.output.notes === undefined, JSON.stringify(r.output.notes));
if (failures) { console.error(`${failures} motion3 command check(s) failed`); process.exit(1); }
console.log("motion3 commands: all checks passed");
