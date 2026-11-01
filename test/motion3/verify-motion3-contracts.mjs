#!/usr/bin/env node
// Motion API v3.1 contracts (docs/motion-api-v3.1.md) as W0 wires them: every stub answers its
// contract shape, motion.compile answers specId / timeline / ranked groups, the output fits the
// receipt budget with `more` and motion.report, motion.describe answers every topic, JSON Patch,
// point refs on the cup scene, the group message, readOnly declarations, unnamed checks and the
// lenient reload of a saved take.
import { createStudioAppActions } from "../../src/commands/index.js";
import { declarations } from "../../src/commands/motion3.js";
import { EXITCAR_SPEC, SCENE_OBJECTS as CAR_OBJECTS, CHARACTER as DRIVER } from "./fixtures/exitcar-scene.mjs";
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { validateGoals } from "../../src/motion3/compiler/validate-goals.js";
import { DESCRIBE_TOPICS, REF_KINDS } from "../../src/motion3/schema/fields.js";
import { partsOf, inHandAt, objectBoxesAt } from "../../src/motion3/object-pose.js";
import { refPoint, refDistance, checkRef } from "../../src/motion3/refs.js";
import { resolveBone } from "../../src/motion3/bones.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { fitOutput, reportPage, MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { DESCRIBE_BUDGET, describe } from "../../src/motion3/describe.js";
import { rankGroups, groupKey, severityOf, weightOf, excessOf } from "../../src/motion3/qa/severity.js";
import { nameChecks } from "../../src/motion3/qa/check-names.js";
import { objectChecks } from "../../src/motion3/qa/object-checks.js";
import { objectHints } from "../../src/motion3/qa/hints-object.js";
import { WRIST_COMFORT } from "../../src/motion3/compiler/arm-orient.js";
import { goalChecks } from "../../src/motion3/qa/goals.js";
import { goalHints } from "../../src/motion3/qa/hints-goal.js";
import { attachPatches } from "../../src/motion3/qa/patch.js";
import { timelineOf } from "../../src/motion3/timeline.js";
import { runProbes } from "../../src/motion3/probes.js";
import { specIdOf, createSpecStore } from "../../src/motion3/spec-store.js";
import { deltaOf } from "../../src/motion3/delta.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { resolveFrames } from "../../src/motion3/skills/frames-auto.js";
import { compileTakeSource } from "../../src/domains/motion/take-source.js";
import { relaxSpec, clampFrames, normalizeCompileArgs } from "../../src/motion3/lenient.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length;
const near = (a, b, tol = 1e-6) => Array.isArray(a) && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---- the cup scene: a Y Bot standing in front of the table, holding a grip prop ----------
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const stand = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 24, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: { tip: [0.02, 0, 0] } } },
	anchors: { spot: { kind: "world", p: [0.2, 1, 0.85] } }, ...extra });
const r = compileSpec(stand(), { sk, scene });
const { out } = r;

// 1. every stub answers its contract shape
expect("scene entries list their ancestors, nearest group first", JSON.stringify(scene.objects.cylinder.ancestors) === '["empty-2","empty"]' && JSON.stringify(scene.objects.cube.ancestors) === '["empty"]');
expect("partsOf: a body is itself, a group is its parts, an unknown id nothing", JSON.stringify(partsOf(scene, "cylinder")) === '["cylinder"]'
	&& JSON.stringify(partsOf(scene, CUP.group)) === JSON.stringify(CUP.parts) && partsOf(scene, "nope").length === 0);
expect("inHandAt: grab..release inclusive, defaults from 0 to the end", inHandAt({ prop: "grip" }, 0) && inHandAt({ prop: "grip", grab: 5, release: 9 }, 9) && !inHandAt({ prop: "grip", grab: 5 }, 4) && !inHandAt({ pivot: [0, 0, 0] }, 3));
const boxes = objectBoxesAt(out, CUP.group, 3);
expect("objectBoxesAt: the group's part boxes { id, pos, R, half }, null outside the window", boxes?.length === 4 && boxes.every(b => CUP.parts.includes(b.id) && b.pos.length === 3 && b.R.length === 3 && b.half.length === 3)
	&& objectBoxesAt(out, CUP.group, 24) === null && objectBoxesAt(out, "nope", 3) === null);
expect("resolveBone: exact name, else null with a suggestion", resolveBone(sk, "LeftHand").bone === "LeftHand" && resolveBone(sk, "LeftHnad").bone === null && /did you mean "LeftHand"/.test(resolveBone(sk, "LeftHnad").hint));
let goalErrors = 0;
validateGoals({ goals: [{ name: "x", near: ["joint:Hips", "joint:Head"], at: 3 }] }, () => goalErrors++, { frames: 24 });
expect("validateGoals accepts a goal", goalErrors === 0);
expect("objectChecks stub: no issues", Array.isArray(objectChecks(sk, out, r.expanded)) && objectChecks(sk, out, r.expanded).length === 0);
const gc = goalChecks(out, []);
expect("goalChecks stub: { issues, results }", Array.isArray(gc.issues) && Array.isArray(gc.results));
// C8 amendment (intent round): still, speed, after/before
goalErrors = 0;
validateGoals({ goals: [{ name: "kick", speed: "joint:RightFoot", by: 2, at: [3, 9] }, { name: "x", still: "object:cube", at: [0, 9], before: "kick" }, { moved: "object:cube", at: [0, 9], after: "kick", mode: "any" }] }, () => goalErrors++, { frames: 24 });
expect("C8: validateGoals accepts still, speed (with by) and after/before naming a goal", goalErrors === 0);
const amended = goalChecks(out, [{ name: "kick", speed: "joint:RightFoot", by: 50, at: [3, 9] }, { name: "x", still: "object:cube", at: [0, 9], before: "kick" }, { name: "y", still: "object:cube", at: [0, 9] }]);
expect("C8: still and speed answer { name, kind, ok, value, at, need }; a goal that waits on a goal that never holds answers value and at null",
	amended.results.map(x => `${x.name}:${x.kind}:${x.ok}`).join() === "kick:speed:false,x:still:false,y:still:true" && amended.results[1].value === null && amended.results[1].at === null
	&& amended.results[2].need === 0.01 && amended.issues.some(i => i.msg === 'x: waits for "kick" (before), which never holds' && i.value === 0.01 && i.limit === 0));
const hintShape = h => typeof h?.cause === "string" && typeof h?.hint === "string";
expect("GRAB and GOAL hints answer { cause, hint }", hintShape(objectHints.GRAB({}, { subject: "empty-2: hand 12.0 cm from it at grab", worstFrame: 104 })) && hintShape(goalHints.GOAL({}, { subject: "cup at mouth: 0.31 m", worstFrame: 150 })));
const someGroups = [{ kind: "COLLIDE", subject: "a x b", count: 1, worst: 0.02, limit: 0.005 }];
expect("attachPatches stub returns the same groups", attachPatches(someGroups, {}) === someGroups);
expect("timelineOf stub: an array; compileSpec answers timeline", Array.isArray(timelineOf(out, { used: r.used, spec: r.expanded })) && Array.isArray(r.timeline));
expect("runProbes stub: an object keyed by probe name", JSON.stringify(runProbes(out, [], {})) === "{}");
const d = deltaOf([], [], "spec-000000000000");
expect("deltaOf stub: the delta shape", d.base === "spec-000000000000" && ["resolved", "new", "worse", "better"].every(k => d[k] === 0) && ["resolved", "new", "worse"].every(k => Array.isArray(d.keys[k])));
const rep = repairSpec({ a: 1 }, { rounds: 4 }, s => ({ compiled: s }));
expect("repairSpec stub compiles once and changes nothing", rep.spec.a === 1 && rep.result.compiled.a === 1 && rep.repair.compiles === 1 && rep.repair.applied.length === 0 && rep.repair.rejected === 0);
const plain = stand();
expect("resolveFrames stub returns the spec", resolveFrames(plain, { sk, scene }) === plain);
expect("specIdOf: spec-<12 hex>, key order does not matter", /^spec-[0-9a-f]{12}$/.test(specIdOf(plain)) && specIdOf({ a: 1, b: [1, { c: 2, d: 3 }] }) === specIdOf({ b: [1, { d: 3, c: 2 }], a: 1 }) && specIdOf({ a: 1 }) !== specIdOf({ a: 2 }));
const store = createSpecStore(2), ida = store.put({ a: 1 });
store.keepParts(ida, { groups: [1], timeline: [], probes: {} });
store.put({ b: 1 }); store.put({ c: 1 });
expect("spec store: put/get/keepParts/parts, the oldest forgotten past its size", ida === specIdOf({ a: 1 }) && store.get(ida) === null && store.get(specIdOf({ c: 1 }))?.c === 1);

// 2. motion.compile through the registry: specId, timeline, groups by severity
const takes = new Map();
const owner = { replace: (cid, take) => takes.set(cid, take), motionFor: cid => takes.get(cid) ?? null };
const portsFor = (character, objects) => ({ state: () => ({ characters: [character], objects, frameCount: 800 }), storeDomain: name => (name === "motion" ? owner : null) });
const cupRegistry = createStudioAppActions(portsFor(CHARACTER, SCENE_OBJECTS));
const run = (registry, action, args) => registry.run(action, args).output;
const walkIn = stand({ frames: 240, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }, { skill: "walkTo", args: { to: [0, 1.6] }, f0: 10 }] });
const walked = run(cupRegistry, "motion.compile", { characterId: CHARACTER.id, spec: walkIn, install: false });
const sev = walked.qa.groups.map(g => g.severity);
expect("motion.compile answers specId, a timeline array and groups ranked by severity", /^spec-[0-9a-f]{12}$/.test(walked.specId) && Array.isArray(walked.timeline)
	&& walked.qa.groups.length > 1 && sev.every((s, i) => i === 0 || sev[i - 1] >= s) && walked.qa.groups.every(g => typeof g.excess === "number"), JSON.stringify(walked.qa.groups.map(g => [g.kind, g.subject, g.count, g.severity])));
const ranked = rankGroups([{ kind: "COLLIDE", subject: "a", count: 9, worst: 0.03, limit: 0.005 }, { kind: "GOAL", subject: "g", count: 1, worst: 0.1, limit: 0 }, { kind: "ORIENT", subject: "o", count: 2, worst: 0.1, limit: 0.64 }]);
expect("rankGroups: GOAL first, then severity; ORIENT counts low values as bad", ranked.map(g => g.kind).join() === "GOAL,COLLIDE,ORIENT" && ranked[2].excess === 0.54 && ranked[1].severity === 31.5 && ranked[2].severity === 3.69, JSON.stringify(ranked));
expect("severityOf rounds the search weight", severityOf({ kind: "SPEED", count: 3, worst: 0.05, limit: 0.04 }) === Math.round(weightOf({ kind: "SPEED", count: 3, worst: 0.05, limit: 0.04 }) * 100) / 100 && excessOf({ kind: "BELOW", worst: 0.1, limit: 0.08 }) === 0);
expect("groupKey: numbers become #, a bracketed index stays", groupKey({ kind: "CONTACT", subject: "contacts[1]: 12.5 cm apart" }) === "CONTACT contacts[1]: # cm apart");

// 3. a broken exitcar (many groups) still fits the budget, says what it cut and pages the rest
const carRegistry = createStudioAppActions(portsFor(DRIVER, CAR_OBJECTS));
const wrecked = structuredClone(EXITCAR_SPEC);
wrecked.fix = false;
delete wrecked.checks.allow;
// the whole body 20 cm lower and 50 cm toward the car's middle: about 30 groups
for (const k of wrecked.keys) for (const ch of ["root", "foot_l", "foot_r", "hand_l", "hand_r"]) if (k.set[ch]) k.set[ch] = [k.set[ch][0] - 0.5, k.set[ch][1] - (ch === "root" ? 0.2 : 0), k.set[ch][2]];
const big = run(carRegistry, "motion.compile", { characterId: DRIVER.id, spec: wrecked, install: false });
expect(`a wrecked exitcar output fits ${MOTION_OUTPUT_BUDGET} B and carries more`, bytes(big) <= MOTION_OUTPUT_BUDGET && big.more?.specId === big.specId && big.more.groups > 0 && big.qa.groups.length >= 4,
	`${bytes(big)} B, more ${JSON.stringify(big.more)}`);
console.log(`  wrecked exitcar: ${bytes(big)} B, ${big.qa.total} issues, more ${JSON.stringify(big.more)}`);
const page = run(carRegistry, "motion.report", { specId: big.specId, part: "groups", from: 4 });
expect("motion.report pages the full groups from an index", page.specId === big.specId && page.from === 4 && page.items.length > 0 && page.items[0].worst !== undefined && bytes(page) <= MOTION_OUTPUT_BUDGET
	&& (page.next === null || page.next > 4), JSON.stringify(page).slice(0, 200));
expect("motion.report refuses an unknown specId", /is not known/.test(refusal(() => carRegistry.run("motion.report", { specId: "spec-000000000000", part: "groups" }))));
const fat = { frames: 10, specId: "spec-0", qa: { ok: false, total: 40, groups: Array.from({ length: 40 }, (_, i) => ({ kind: "COLLIDE", subject: `p${i}`, count: 1, worst: 1, limit: 0, severity: 4, first: i, last: i, cause: "c".repeat(120), hint: "h".repeat(200) })) },
	timeline: Array.from({ length: 12 }, (_, i) => ({ beat: "keys", f: [i, i], planted: { l: [[0, 9]], r: [] } })), fixed: {}, ms: { total: 1 } };
const fitted = fitOutput(fat);
expect("fitOutput: 4 full groups, then the timeline, then one-liners, under budget", bytes(fitted) <= MOTION_OUTPUT_BUDGET && fitted.qa.groups.filter(g => g.hint).length >= 4
	&& fitted.timeline.length === 12 && fitted.qa.groups.length > 4 && fitted.more.groups > 0 && fitted.more.timeline === 0, JSON.stringify(fitted.more));
expect("reportPage answers { specId, part, from, items, next }", JSON.stringify(Object.keys(reportPage({ groups: [1, 2] }, "spec-0", "groups", 1))) === '["specId","part","from","items","next"]');

// 4. motion.describe answers every topic, small
const answers = DESCRIBE_TOPICS.map(topic => run(cupRegistry, "motion.describe", { topic }));
expect("motion.describe answers every topic with { topic, schema, example, notes } (essentials: { types, skills, notes } within DESCRIBE_BUDGET)", answers.every((a, i) => a.topic === DESCRIBE_TOPICS[i]
	&& bytes(a) <= (a.topic === "essentials" ? DESCRIBE_BUDGET : MOTION_OUTPUT_BUDGET)
	&& (a.topic === "skills" ? Array.isArray(a.skills) && a.skills.length > 0 : a.topic === "examples" ? a.examples.length > 0 && Array.isArray(a.notes) : a.topic === "fill" ? a.notes.length > 0 : a.topic === "essentials" ? a.types && a.skills.length > 0 && Array.isArray(a.notes) : a.schema && a.example && Array.isArray(a.notes))));
const one = run(cupRegistry, "motion.describe", { topic: "skills", name: "reachGrip" });
expect("motion.describe { skills, name } answers one skill", one.name === "reachGrip" && one.example.skill === "reachGrip" && /did you mean "reachGrip"/.test(refusal(() => cupRegistry.run("motion.describe", { topic: "skills", name: "reachGirp" }))));
const many = run(cupRegistry, "motion.describe", { topics: [{ topic: "objects" }, { topic: "skills", name: "reachGrip" }, { topic: "objects" }, { topic: "anchors" }, { topic: "skills", name: "walkTo" }] });
expect("motion.describe { topics } answers them in order, each once, within DESCRIBE_BUDGET, and names what did not fit in more", bytes(many) <= DESCRIBE_BUDGET
	&& JSON.stringify(many.topics) === JSON.stringify([describe("objects"), describe("skills", "reachGrip")]) && JSON.stringify(many.more) === JSON.stringify([{ topic: "anchors" }, { topic: "skills", name: "walkTo" }]), JSON.stringify(many.more));
const rest = run(cupRegistry, "motion.describe", { topics: many.more });
expect("motion.describe { topics: more } answers the rest", rest.topics.length === 2 && rest.more === undefined && rest.topics[1].name === "walkTo");
expect("motion.describe { topics } takes bare topic strings", JSON.stringify(run(cupRegistry, "motion.describe", { topics: ["anchors", { topic: "skills", name: "walkTo" }] }).topics) === JSON.stringify(rest.topics));
expect("motion.describe joins topic with topics, gives a name to its one skills ask (C19), and refuses neither, a name with two open asks and an unknown topic", JSON.stringify(run(cupRegistry, "motion.describe", { topic: "anchors", topics: ["skills"], name: "walkTo" }).topics) === JSON.stringify(rest.topics)
	&& /Send topic/.test(refusal(() => cupRegistry.run("motion.describe", {}))) && /name goes with one topic/.test(refusal(() => cupRegistry.run("motion.describe", { topics: ["skills", "skills"], name: "walkTo" }))) && /"skils" is not one of/.test(refusal(() => cupRegistry.run("motion.describe", { topics: [{ topic: "skils" }] }))));

// 5. JSON Patch
const doc = { keys: [{ f: 0 }, { f: 4 }], anchors: { a: { p: [0, 0, 0] } } };
const patched = applyPatch(doc, [{ op: "test", path: "/keys/1/f", value: 4 }, { op: "replace", path: "/keys/1/f", value: 6 }, { op: "add", path: "/keys/-", value: { f: 9 } },
	{ op: "add", path: "/keys/0", value: { f: -1 } }, { op: "remove", path: "/anchors/a" }, { op: "add", path: "/anchors/b~1c", value: 1 }]);
expect("add / replace / remove / test with - and ~1, on a copy", JSON.stringify(patched) === '{"keys":[{"f":-1},{"f":0},{"f":6},{"f":9}],"anchors":{"b/c":1}}' && doc.keys.length === 2 && doc.anchors.a);
const nine = { keys: Array.from({ length: 9 }, (_, f) => ({ f })) };
expect("a missing path names the op and what is there", refusal(() => applyPatch(nine, [{ op: "test", path: "/keys/0/f", value: 0 }, { op: "replace", path: "/keys/12/f", value: 112 }]))
	=== "MOTION_SPEC_INVALID: patch[1] (replace /keys/12/f): /keys/12 does not exist (keys has 9 entries; by f: /keys/@f=<f>, f 0, 1, 2, 3, 4, 5, 6, 7, ...)");
expect("a failed test, a bad op and - outside add are refused", /patch\[0\] \(test \/keys\/0\/f\): value is 0, not 5/.test(refusal(() => applyPatch(nine, [{ op: "test", path: "/keys/0/f", value: 5 }])))
	&& /op must be add, remove, replace, move, test, got "copy"/.test(refusal(() => applyPatch(nine, [{ op: "copy", path: "/keys/0" }])))
	&& /move needs from/.test(refusal(() => applyPatch(nine, [{ op: "move", path: "/keys/0" }])))
	&& /"-" \(append\) works with add only/.test(refusal(() => applyPatch(nine, [{ op: "replace", path: "/keys/-", value: 1 }]))));

// 6. refs on the cup scene
const f = 6, s = out.frames[f].s, P = j => s.P[sk.index[j]];
expect("joint: and bone: are the bone's joint", near(refPoint(out, f, "joint:LeftHand"), P("LeftHand")) && near(refPoint(out, f, "bone:Hips"), P("Hips")));
expect("prop: points (and origin) of a held prop", refPoint(out, f, "prop:grip.tip")?.length === 3 && refPoint(out, f, "prop:grip.origin")?.length === 3 && refPoint(out, f, "prop:grip.nope") === null);
expect("anchor: and landmark:mouth", near(refPoint(out, f, "anchor:spot"), [0.2, 1, 0.85]) && refPoint(out, f, "landmark:mouth")?.[1] > 1.4);
expect("object: centre / top / base of a body", near(refPoint(out, f, "object:cylinder.top"), [0.2, 0.85, 0.85]) && near(refPoint(out, f, "object:cylinder"), [0.2, 0.8, 0.85]) && near(refPoint(out, f, "object:cylinder.base"), [0.2, 0.75, 0.85]));
expect("object: a group is the AABB of its parts", near(refPoint(out, f, `object:${CUP.group}.top`), [0.217, 0.85, 0.85]) && near(refPoint(out, f, `object:${CUP.group}.base`), [0.217, 0.75, 0.85]));
const toTop = refDistance(out, f, "anchor:spot", "object:cylinder");
expect("a bare object: measures to the surface; points measure between them", Math.abs(toTop - 0.15) < 1e-6 && Math.abs(refDistance(out, f, "anchor:spot", "object:cylinder.top") - 0.15) < 1e-6
	&& refDistance(out, f, "object:cylinder.center", `object:${CUP.group}`) === 0 && refDistance(out, 99, "joint:Hips", "joint:Head") === null);
const msgs = [], err = m => msgs.push(m), ctx = { sk, scene }, spec = r.expanded;
const goodRefs = ["joint:LeftHand", "bone:Hips", "prop:grip.tip", "anchor:spot", "landmark:mouth", "object:cylinder.top", `object:${CUP.group}`].every(ref => checkRef(spec, err, ctx, "probes[0].position", ref));
expect("checkRef accepts every kind, a group included", goodRefs && msgs.length === 0, msgs.join("\n"));
checkRef(spec, err, ctx, "probes[0].distance[0]", "joint:LeftHnad");
checkRef(spec, err, ctx, "probes[1].position", "object:empty-3");
checkRef(spec, err, ctx, "goals[0].near[1]", "landmark:nose");
checkRef(spec, err, ctx, "goals[0].near[0]", "joint:Hips", ["object"]);
expect("checkRef messages", msgs[0] === 'probes[0].distance[0] "joint:LeftHnad": unknown bone; did you mean "LeftHand"?' && /probes\[1\]\.position "object:empty-3" names object "empty-3", which is not in the scene; did you mean "empty-2"?/.test(msgs[1])
	&& msgs[2] === 'goals[0].near[1] "landmark:nose": the only landmark is "mouth"' && msgs[3] === 'goals[0].near[0] "joint:Hips" must be object:<id>[.center|.top|.base|.rim]', msgs.join("\n"));
expect("REF_KINDS lists the grammar", REF_KINDS.join() === "joint,bone,prop,anchor,landmark,object,person");

// 7. objectOk names a group's parts
const groupMsg = refusal(() => validateSpec({ ...stand(), use: undefined, keys: [{ f: 0, set: { yaw: 0 } }], checks: { clearance: [{ name: "c", part: "hand_r", object: CUP.group, min: 0.01 }] } }, { sk, scene }));
expect("a group id where a body is needed lists the group's parts", /checks\.clearance\[0\] names "empty-2", a group \(Empty\) with no body of its own; its parts are cylinder, cube-6, cube-7, cube-8/.test(groupMsg), groupMsg);

// 8. readOnly declarations
const ro = Object.fromEntries(declarations.map(dd => [dd.id, dd.readOnly === true]));
expect("motion.qa / sample / describe / report are readOnly, motion.compile is not", ro["motion.qa"] && ro["motion.sample"] && ro["motion.describe"] && ro["motion.report"] && !ro["motion.compile"] && declarations.every(dd => dd.kind === "job"));

// nameChecks: unnamed checks are named by their index, one group each
const unnamed = { checks: { contacts: [{ point: "joint:LeftHand", target: "anchor:spot" }, { name: "kept", point: "joint:RightHand", target: "anchor:spot" }] } };
const named = nameChecks(unnamed);
expect("nameChecks names a copy and keeps given names", named.checks.contacts[0].name === "contacts[0]" && named.checks.contacts[1].name === "kept" && unnamed.checks.contacts[0].name === undefined && nameChecks({ keys: [] }).keys);
const far = compileSpec(stand({ checks: { contacts: [{ point: "joint:LeftHand", target: "anchor:spot" }] } }), { sk, scene });
const contactGroups = g => g.qa.groups.filter(x => x.kind === "CONTACT");
expect('an unnamed contact reports "contacts[0]: ..."', /^contacts\[0\]: \d+\.\d cm apart$/.test(contactGroups(far)[0]?.subject ?? ""), JSON.stringify(contactGroups(far)));
const two = compileSpec(stand({ checks: { contacts: [{ point: "joint:LeftHand", target: "anchor:spot" }, { point: "joint:RightHand", target: "anchor:spot" }] } }), { sk, scene });
expect("two unnamed contacts are two groups", contactGroups(two).map(g => g.subject.split(":")[0]).sort().join() === "contacts[0],contacts[1]", JSON.stringify(contactGroups(two).map(g => g.subject)));

// lenient reload: a saved take with a field this validator does not know still loads
const saved = { schema: "cozyclay.take.v3", rig: CHARACTER.model, spec: { ...stand(), futureField: 1, keys: [{ f: 0, set: { yaw: 0 }, note: "x" }] }, placement: { position: [0, 0, 0], yaw: 0 }, scene };
expect("compileTakeSource is lenient; motion.compile stays strict", compileTakeSource(saved)?.frameCount === 24
	&& /spec\.futureField is not a spec field/.test(refusal(() => cupRegistry.run("motion.compile", { characterId: CHARACTER.id, spec: saved.spec, install: false }))));

// C17. Free entries: the cup group lifted by keys falls back onto the table top, sqrt(2h/g) after it starts
const freeSpec = { ...stand(), use: undefined, keys: [{ f: 0, set: { yaw: 0 } }], frames: 60,
	objects: { [CUP.group]: { keys: [{ f: 5, pos: [0.2, 0.75, 0.85], rot: [0, 0, 0, 1] }, { f: 10, pos: [0.2, 1.05, 0.85], rot: [0, 0, 0, 1] }], fall: { at: 12, bounce: 0 } } } };
const freeOut = compileSpec(freeSpec, { sk, scene }).out, cupY = f => objectBoxesAt(freeOut, CUP.group, f).find(b => b.id === "cylinder").pos[1];
expect("C17: a free group rides its keys, falls at its frame and rests on the table top (0.75 m) after sqrt(2h/g)", Math.abs(cupY(10) - 1.05) < 1e-9 && cupY(17) > 0.76
	&& Math.abs(cupY(18) - 0.75) < 1e-9 && Math.abs(cupY(59) - 0.75) < 1e-9, [10, 17, 18, 59].map(cupY));
expect("C17: a fall while in hand is refused", /a carried object falls before its grab or from its release on/.test(refusal(() => validateSpec({ ...freeSpec, props: { grip: { hand: "l", origin: ["LeftHandIndex2"], points: {} } },
	objects: { [CUP.group]: { prop: "grip", grab: 10, release: 40, fall: { at: 20 } } } }, { sk, scene }))));

// C18. Fit grips and observations.wrist: the cup's reachGrip turns the hand (diag.grip_r) within the comfortable forearm twist,
// orient: false and a fit field of the wrong type are named, and the holding wrist is read
const gripSpec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [CHARACTER.x, CHARACTER.z] } },
	{ skill: "reachGrip", f0: 4, args: { anchor: "cupHold", side: "r", hold: 20, define: { kind: "object", object: CUP.group, local: [0, 0.05, 0] } } }] };
const cupScene = motionScene(SCENE_OBJECTS), gripped = compileSpec(gripSpec, { sk, scene: cupScene }), grip = gripped.out.frames[30].diag.grip_r;
const unturned = compileSpec({ ...gripSpec, use: [gripSpec.use[0], { ...gripSpec.use[1], args: { ...gripSpec.use[1].args, orient: false } }] }, { sk, scene: cupScene });
expect("C18: a fit on a body turns the hand within the comfortable forearm twist; orient false leaves it", !!grip && Math.abs(grip.twist) <= WRIST_COMFORT.twist[1] + 1e-6 && unturned.out.frames[30].diag.grip_r === undefined, JSON.stringify(grip));
expect("C18: fit.orient must be a boolean", /fits\[0\]\.orient must be true or false/.test(refusal(() => validateSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 10, anchors: { a: { kind: "world", p: [0, 1, 0.4] } },
	props: { g: { hand: "r", origin: ["RightHandIndex2"], points: { tip: [0, 0, 0] } } }, fits: [{ side: "r", anchor: "a", effector: { prop: "g", point: "tip" }, orient: "no" }] }, { sk, scene: cupScene }))));
expect("C18: observations.wrist reads the holding hand", (gripped.observations.wrist?.hand_r?.frames ?? 0) > 10 && /wrist: deg/.test(gripped.observations.units), JSON.stringify(gripped.observations.wrist));
// C18 path grip: a keyed carry of a thin body with a free grip reports the grip chosen over its keyed path, never dearer than the grab frame's
const cupRest = cupScene.groups[CUP.group].pos;
const pathed = compileSpec({ ...gripSpec, frames: 70, objects: { [CUP.group]: { prop: "cupHoldGrip", grab: 26, keys: [{ f: 26, pos: cupRest, aim: [0, 1, 0] },
	{ f: 50, pos: [CHARACTER.x - 0.03, 1.46, CHARACTER.z + 0.22], aim: [0, 0.8, -0.6] }] } } }, { sk, scene: cupScene }), chosen = pathed.observations.wrist?.hand_r?.grip;
expect("C18: a keyed thin carry with a free grip reports its chosen grip (object, chose, cost [it, today's])", chosen?.object === CUP.group && typeof chosen.chose === "string" && chosen.cost[0] <= chosen.cost[1] && /grip: the grip a keyed carry/.test(pathed.observations.units), JSON.stringify(chosen));

// C19. Lenient inputs: fixes that cannot change the meaning are made and named; the rest is refused as before
const slips = [], relaxed = relaxSpec({ frames: 60, goals: [{ name: "g", near: ["joint:Hips", "joint:Head"], at: [50, 80] }, { near: ["joint:Hips", "joint:Head"], at: [70, 80] }],
	objects: { [CUP.group]: { keys: [{ f: 5, pos: [0, 1, 0] }] } } }, motionScene(SCENE_OBJECTS), slips);
expect("C19: a goal window past the clip is cut, one wholly past it is left; a free pos-only key takes its scene turn; one note each",
	JSON.stringify(relaxed.goals.map(g => g.at)) === "[[50,59],[70,80]]" && JSON.stringify(relaxed.objects[CUP.group].keys[0].rot) === "[0,0,0,1]" && slips.length === 2, JSON.stringify(slips));
expect("C19: verify_result frames are pulled into the range; install and repair spellings are the declared ones", JSON.stringify(clampFrames([10, 60], [0, 47])) === JSON.stringify({ frames: [10, 47], adjusted: "frames 60 lie outside 0..47: drawn at 47" })
	&& JSON.stringify(normalizeCompileArgs({ install: "always", repair: { rounds: 0 } })) === JSON.stringify({ install: true, repair: false }));

if (failures) { console.error(`${failures} motion3 contract check(s) failed`); process.exit(1); }
console.log("motion3 contracts: all checks passed");
