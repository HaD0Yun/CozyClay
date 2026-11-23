#!/usr/bin/env node
// Other characters in a compile (people.js): their installed takes are bodies (QA PERSON), an anchor can sit on one of
// their joints ({ kind: "person" }) and a ref can name one (person:<id>.<Bone>); a take keeps the joints its person
// anchors read, so its saved source compiles the same without the others' takes (take-source.js).
import "../lowvis/block-figure.mjs"; // the rig's own body: scale 1 of the block figure (figure.js: the launch names the look)
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { bakeTake } from "../../src/motion3/take.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { peopleOf, personJoint } from "../../src/motion3/people.js";
import { takeSource, normalizeTakeSource, compileTakeSource } from "../../src/domains/motion/take-source.js";
import { takeHash } from "./fixtures/take-hash.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const yb = skeletonFor("y-bot-tpose"), xb = skeletonFor("x-bot-tpose"), spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 };
// Jiwoo (X Bot) stands at (0, 2) facing A (yaw 180); her take is compiled in the world and baked at her placement
const B = { id: "char-b", subject: "Jiwoo", model: "x-bot-tpose", x: 0, y: 0, z: 2, rot: 180 };
const bSpec = { ...spec0, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 2], heading: 180, until: 119 } }] };
const takeB = bakeTake(xb, compileSpec(bSpec, { sk: xb, scene: motionScene([]) }).out, { position: [0, 0, 2], yaw: 180 }, { spec: bSpec });
const people = peopleOf([B, { id: "char-a", model: "y-bot-tpose" }, { id: "char-c", model: "y-bot-tpose", hidden: true }], "char-a", id => (id === "char-b" ? takeB : null));
const scene = { ...motionScene([]), people };
const person = r => r.qa.groups.filter(g => g.kind === "PERSON");

expect("the cast becomes people: the other characters with a take, never the compiled one or a hidden one", Object.keys(people).join() === "char-b" && people["char-b"].name === "Jiwoo");
const head = personJoint(scene, "char-b", "Head", 30);
expect("a person's joint is where playback draws it: her head at her placement, 1.5-1.7 m up", head && Math.abs(head[0]) < 0.05 && Math.abs(head[2] - 2) < 0.15 && head[1] > 1.5 && head[1] < 1.75, JSON.stringify(head));

// 1. a walk straight through her: each part that goes into her body is a PERSON group with a hint
const walk = { ...spec0, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 1, args: { to: [0, 4], arrive: 110 } }] };
const through = compileSpec(walk, { sk: yb, scene }), alone = compileSpec(walk, { sk: yb, scene: motionScene([]) });
const groups = person(through);
expect("walking through another character is PERSON, one group per body part (it was nothing)", groups.length >= 5 && groups.every(g => /^\S+ x person:char-b$/.test(g.subject)) && person(alone).length === 0,
	JSON.stringify(groups.map(g => g.subject)));
expect("a PERSON group's hint moves the part out of her and offers checks.allow for a touch that is meant",
	groups.every(g => /out of Jiwoo's /.test(g.hint ?? "") && /object: "person:char-b"/.test(g.hint ?? "")), groups[0]?.hint);
expect("the people change QA only: the walk's take is the same with or without them", takeHash(bakeTake(yb, through.out)) === takeHash(bakeTake(yb, alone.out)));
const allowed = compileSpec({ ...walk, checks: { allow: [{ part: "torso", object: "person:char-b", depth: 0.5 }] } }, { sk: yb, scene });
expect("checks.allow { object: \"person:<id>\" } excuses that part", !person(allowed).some(g => /^torso/.test(g.subject)) && person(allowed).length > 0);

// 2. a hand on her shoulder: a person anchor, reachGrip on it, a goal on a person ref
const reach = { ...spec0, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 1.52], heading: 0 } },
	{ skill: "reachGrip", f0: 10, args: { anchor: "shoulder", side: "r", define: { kind: "person", person: "char-b", bone: "LeftArm" }, hold: 30 } }],
	goals: [{ name: "hand on her shoulder", near: ["joint:RightHandMiddle1", "person:char-b.LeftArm"], tol: 0.1, at: [32, 58] }] };
const onShoulder = compileSpec(reach, { sk: yb, scene });
const gap = f => { const h = onShoulder.out.frames[f].s.P[yb.index.RightHandMiddle1], p = personJoint(scene, "char-b", "LeftArm", f); return Math.hypot(h[0] - p[0], h[1] - p[1], h[2] - p[2]); };
expect("a person anchor puts the hand on her shoulder: QA clean, the goal met, under 5 cm at f45", onShoulder.qa.ok && onShoulder.qa.goals?.[0]?.ok && gap(45) < 0.05,
	JSON.stringify({ total: onShoulder.qa.total, goals: onShoulder.qa.goals, gap: gap(45), groups: onShoulder.qa.groups.slice(0, 3).map(g => g.subject) }));
let refusal = "";
try { compileSpec({ ...reach, use: [reach.use[0], { ...reach.use[1], args: { ...reach.use[1].args, define: { kind: "person", person: "char-z", bone: "LeftArm" } } }], goals: [] }, { sk: yb, scene }); }
catch (error) { refusal = error.message; }
expect("an anchor on someone not in the scene is refused with the people there", /person/.test(refusal) && /char-b \(Jiwoo\)/.test(refusal), refusal);

// 3. the take keeps the joints its person anchor read: its saved source compiles the same without her take
const job = runCompileJob({ model: "y-bot-tpose", scene, spec: { ...reach, goals: undefined }, bake: { position: [0, 0, 0], yaw: 0, prompt: "" } });
const kept = job.take.people?.["char-b"];
expect("the take keeps only the person joint its anchor read, as plain numbers", kept && kept.names.join() === "LeftArm" && Array.isArray(kept.P) && kept.P.length === kept.frames * 3, JSON.stringify(kept && { names: kept.names, frames: kept.frames }));
const source = normalizeTakeSource(JSON.parse(JSON.stringify(takeSource(job.take, []))));
const reloaded = compileTakeSource(source);
expect("a saved take with a person anchor compiles back bit for bit, without her take", reloaded && takeHash(reloaded) === takeHash(job.take) && reloaded.rot.every((v, i) => v === job.take.rot[i]));

const looking = { ...spec0, frames: 30, use: [reach.use[0]], goals: [{ name: "near her head", near: ["joint:Head", "person:char-b.Head"], tol: 3, at: [5, 20] }] };
const refJob = runCompileJob({ model: "y-bot-tpose", scene, spec: looking, bake: { position: [0, 0, 0], yaw: 0, prompt: "" } });
const refSource = normalizeTakeSource(JSON.parse(JSON.stringify(takeSource(refJob.take, []))));
expect("a person ref only in a goal is kept too: the saved source compiles back without her take", refJob.take.people?.["char-b"]?.names.join() === "Head" && takeHash(compileTakeSource(refSource)) === takeHash(refJob.take),
	JSON.stringify(refJob.take.people && Object.keys(refJob.take.people)));

if (failures) { console.error(`${failures} motion3 people check(s) failed`); process.exit(1); }
console.log("motion3 people: all checks passed");
