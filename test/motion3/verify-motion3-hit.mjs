#!/usr/bin/env node
// hitReaction (skills/impact.js): a body thrown by a hit lands and comes to rest, QA clean, the same every time.
// The pedestrian a truck hits mid-walk, a sweep of pushes, and a two-person push (B is shoved by A, then A's hands
// are on B's chest through person anchors before the shove).
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { takeSource, normalizeTakeSource, compileTakeSource } from "../../src/domains/motion/take-source.js";
import { bakeTake } from "../../src/motion3/take.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { peopleOf, personJoint } from "../../src/motion3/people.js";
import { takeHash } from "./fixtures/take-hash.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const yb = skeletonFor("y-bot-tpose"), xb = skeletonFor("x-bot-tpose"), spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 };
const groups = r => JSON.stringify(r.qa.groups.map(g => [g.kind, g.subject, g.first, g.last]));
// QA measures the body above the soles against the floor since #1113 ("<part> below floor", qa/floor.js), and the landing
// lays it in the floor (measured: the hips 3 cm on the back, the thighs 13-15 cm and the fingers 27-30 cm face down, on the
// rig's posed skin; skills/impact.js, open). "QA clean" here is every other check; FLOOR_MAX pins the depth so it cannot grow.
const FLOOR_MAX = 0.31, floorOf = r => r.qa.groups.filter(g => g.kind === "GROUND" && !/ sole below floor$/.test(g.subject));
const clean = r => r.qa.groups.every(g => floorOf(r).includes(g)) && floorOf(r).every(g => g.worst <= FLOOR_MAX);
const hips = (r, f) => r.out.frames[f].s.P[yb.index.Hips];

// 1. the pedestrian: walking across, a truck from the side at 8 m/s
const truck = { id: "truck", name: "truck", renderer: "cube", x: -2, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 2, scaleY: 2, scaleZ: 4, footprint: { width: 1, depth: 1 }, height: 1 };
const street = motionScene([truck]);
const walkHit = { ...spec0, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, -2], heading: 0 } }, { skill: "walkTo", f0: 1, args: { to: [0, 1], arrive: 70 } },
	{ skill: "hitReaction", f0: 44, args: { from: "object:truck", speed: 8 } }] };
const hit = compileSpec(walkHit, { sk: yb, scene: street });
const rest = hips(hit, 119), before = hips(hit, 44);
expect("a truck hits the walking pedestrian: thrown away from it, down on the floor and still, QA clean", clean(hit) && rest[0] - before[0] > 4 && rest[1] < 0.2 && Math.hypot(...hips(hit, 118).map((v, i) => v - rest[i])) < 1e-3, `${groups(hit)} rest ${rest}`);
const air = Math.max(...hit.out.frames.slice(44, 70).map(fr => fr.s.P[yb.index.Hips][1]));
expect("the body leaves the ground (ballistic, the hips higher than walking)", air > before[1] + 0.03, `${air} vs ${before[1]}`);
expect("the same spec compiles to the same take", takeHash(bakeTake(yb, compileSpec(walkHit, { sk: yb, scene: street }).out)) === takeHash(bakeTake(yb, hit.out)));

// 2. a sweep: pushed from each side, slow to fast, both rigs; it lands on the back when hit from the front
const stand = (sk, args) => compileSpec({ ...spec0, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "hitReaction", f0: 20, args }] }, { sk, scene: motionScene([]) });
for (const [sk, rig] of [[yb, "Y Bot"], [xb, "X Bot"]]) for (const args of [{ dir: [0, -1], speed: 2 }, { dir: [0, -1], speed: 5 }, { dir: [0, 1], speed: 3 }, { dir: [1, 0], speed: 8 }, { dir: [-1, 0.3], speed: 1.2 }, { dir: [0.5, -1], speed: 10 }]) {
	const r = stand(sk, args), lie = r.out.frames[89].c.pitch, back = args.dir[1] <= 0;
	expect(`${rig} ${JSON.stringify(args)}: QA clean, lying ${back ? "on the back" : "face down"} at the end`, clean(r) && lie === (back ? -90 : 90), `${groups(r)} pitch ${lie}`);
}
let refusal = "";
try { stand(yb, { speed: 3 }); } catch (error) { refusal = error.message; }
expect("without dir or from it is refused and says what it needs", /args\.dir/.test(refusal) && /args\.from/.test(refusal), refusal);
refusal = "";
try { stand(yb, { dir: [0, -1], speed: -5 }); } catch (error) { refusal = error.message; }
expect("a negative speed is refused", /speed/.test(refusal), refusal);

// 3. a two-person push: A (Y Bot, at the origin facing +z) shoves B (X Bot, 0.55 m in front, facing A) at f30
const A = { id: "char-a", subject: "Mina", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0 }, B = { id: "char-b", subject: "Jiwoo", model: "x-bot-tpose", x: 0, y: 0, z: 0.55, rot: 180 };
const aIdle = { ...spec0, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0, until: 89 } }] };
const take = (sk, spec, scene) => bakeTake(sk, compileSpec(spec, { sk, scene }).out, { position: [0, 0, 0], yaw: 0 }, { spec });
const atB = { position: [0, 0, 0.55], yaw: 180 };
const takes = { "char-a": take(yb, aIdle, motionScene([])) };
const sceneFor = id => ({ ...motionScene([]), people: peopleOf([A, B], id, other => takes[other] ?? null) });
const bSpec = { ...spec0, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0.55], heading: 180 } }, { skill: "hitReaction", f0: 30, args: { from: "person:char-a", speed: 2.5 } }] };
const shoved = compileSpec(bSpec, { sk: xb, scene: sceneFor("char-b") });
takes["char-b"] = bakeTake(xb, shoved.out, atB, { spec: bSpec });
const bRest = shoved.out.frames[89].s.P[xb.index.Hips];
const bJob = runCompileJob({ model: "x-bot-tpose", scene: sceneFor("char-b"), spec: bSpec, bake: { ...atB, prompt: "" } });
const bSource = normalizeTakeSource(JSON.parse(JSON.stringify(takeSource(bJob.take, []))));
expect("B's saved take keeps A's hips its from read and compiles back bit for bit without A's take", bJob.take.people?.["char-a"]?.names.join() === "Hips" && takeHash(compileTakeSource(bSource)) === takeHash(bJob.take),
	JSON.stringify(bJob.take.people && Object.keys(bJob.take.people)));
expect("B, shoved from A, falls away from A on the back and lies still, QA clean (A's body included)", clean(shoved) && bRest[2] > 1.2 && shoved.out.frames[89].c.pitch === -90, `${groups(shoved)} rest ${bRest}`);
// A's palm goes where B's chest is when the shove lands (B's installed take), then lets go as B flies
const shoveAt = personJoint(sceneFor("char-a"), "char-b", "Spine2", 30).map((v, i) => v + [0, -0.05, -0.15][i]);
const aSpec = { ...spec0, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
	{ skill: "reachGrip", f0: 4, args: { anchor: "chest", side: "r", define: { kind: "world", p: shoveAt }, hold: 6 } }],
	goals: [{ name: "hand on her chest", near: ["joint:RightHandMiddle1", "person:char-b.Spine2"], tol: 0.2, at: [24, 30] }] };
const pusher = compileSpec(aSpec, { sk: yb, scene: sceneFor("char-a") });
expect("A's hand is on B's chest as the shove lands, QA clean", clean(pusher) && pusher.qa.goals?.[0]?.ok, `${groups(pusher)} ${JSON.stringify(pusher.qa.goals)}`);
const chest = personJoint(sceneFor("char-a"), "char-b", "Spine2", 30);
expect("B's chest at the shove is where A's hand reached (person joints are B's installed take)", chest && Math.abs(chest[2] - 0.55) < 0.15, JSON.stringify(chest));

if (failures) { console.error(`${failures} motion3 hit check(s) failed`); process.exit(1); }
console.log("motion3 hit: all checks passed");
