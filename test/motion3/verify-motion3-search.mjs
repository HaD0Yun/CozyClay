#!/usr/bin/env node
// Open parameters: { range: [lo, hi] } in place of a number is searched deterministically
// within a compile budget, stops at QA 0, and reports the chosen values and the time.
import "../lowvis/block-figure.mjs"; // the rig's own body: scale 1 of the block figure (figure.js: the launch names the look)
import { SCENE_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { compileSpec } from "./fixtures/legacy-compile.mjs";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { I3 } from "../../src/motion3/compiler/math.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { budgetMs } from "./fixtures/time-budget.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), car = motionScene(SCENE_OBJECTS);
const post = { objects: { Post: { pos: [0, 0, 2.6], R: I3(), half: [0.25, 0.8, 0.25] } } };
const say = (label, r) => console.log(`  ${label}: search ${JSON.stringify(r.search)}; QA ${r.qa.total}; ${JSON.stringify(r.ms)}`);

// 1. A walk that must turn to clear a post: the end heading is open.
const around = h1 => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 240,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { heading: [0, h1], steps: 8, turnDistance: 0.8 } }] });
const straight = compileSpec(around(0), { sk, scene: post });
expect("walking straight hits the post", straight.qa.groups.some(g => g.kind === "COLLIDE" && /Post/.test(g.subject)));
let r = compileSpec(around({ range: [-60, 60] }), { sk, scene: post });
say("post, heading[1] in [-60, 60]", r);
const h = r.search?.values["use[1].args.heading[1]"];
expect("the search finds a clean end heading", r.qa.ok && Math.abs(h) >= 10 && r.search.cost === 0, JSON.stringify(r.search));
expect("it returns the spec with the value filled in", r.spec.use[1].args.heading[1] === h);
expect("it stays within budget and is fast", r.search.evals <= 32 && r.search.ms < budgetMs(3000), JSON.stringify(r.search));

// 2. The car scene: walking off toward heading 80 swings through the open door unless the turn is
//    spread out; the turn distance is open.
const exit = (walk, extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 730, ...extra, use: [
	{ skill: "sitInSeat", f0: 0, args: { car: "Car", offset: [-0.06, 0.17, 0.023] } }, { skill: "exitCar", f0: 0, args: { car: "Car" } },
	{ skill: "walkTo", f0: 246, args: { steps: 8, halfWidth: 0.1, ...walk } }, { skill: "smokeCigarette", f0: 440 }] });
const tight = compileSpec(exit({ heading: [125, 80], turnDistance: 0.4 }), { sk, scene: car });
const doorHits = tight.qa.groups.filter(g => /Car_Door_L/.test(g.subject)).reduce((n, g) => n + g.count, 0);
console.log(`  turnDistance 0.4 by hand: ${tight.qa.total} issues (${doorHits} door hits)`);
expect("by hand, turnDistance 0.4 walks through the door", doorHits > 50);
r = compileSpec(exit({ heading: [125, 80], turnDistance: { range: [0.2, 2.0] } }), { sk, scene: car });
say("car, turnDistance in [0.2, 2.0]", r);
expect("the search clears the door with QA 0", r.qa.ok && r.search.values["use[2].args.turnDistance"] > 0.4, JSON.stringify(r.search));
expect("trial compiles only cover the frames the walk changes", r.search.window?.[0] > 200, JSON.stringify(r.search.window));
r = compileSpec(exit({ heading: [125, { range: [40, 110] }], turnDistance: { range: [0.2, 2.0] } }), { sk, scene: car });
say("car, heading[1] and turnDistance open", r);
expect("two open parameters: QA 0 within budget", r.qa.ok && r.search.evals <= 32, JSON.stringify(r.search));

// 3. Budget and errors.
r = compileSpec({ ...around({ range: [-2, 2] }), search: { budget: 6 } }, { sk, scene: post });
say("post, hopeless range, budget 6", r);
expect("a hopeless range stops at the budget and still reports QA", r.search.evals <= 6 && !r.qa.ok && r.qa.groups[0].hint, JSON.stringify(r.search));
let msg = "";
try { compileSpec(around({ range: [10, -10] }), { sk, scene: post }); } catch (error) { msg = error.message; }
expect("a reversed range is refused with its path", msg.includes("use[1].args.heading[1] range must be [lo, hi] with lo < hi"), msg);

// 4. Through motion.compile: output.search, and the installed take keeps the chosen numbers.
const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const character = { id: "c1", model: "x-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
const objects = [{ id: "Post", name: "Post", renderer: "cube", x: 0, y: 0, z: 2.6, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.5, scaleY: 1.6, scaleZ: 0.5, footprint: { width: 1, depth: 1 }, height: 1 }];
const registry = createStudioAppActions({ state: () => ({ characters: [character], objects, frameCount: 240 }), storeDomain: n => (n === "motion" ? owner : null) });
const out = (x => x?.output ?? x)(registry.run("motion.compile", { characterId: "c1", spec: around({ range: [-60, 60] }) }));
console.log(`  motion.compile output: ${JSON.stringify({ search: out.search, qa: { ok: out.qa.ok, total: out.qa.total }, skills: out.skills, ms: out.ms })}`);
expect("motion.compile answers search, skills and ms", out.qa.ok && out.search?.evals >= 1 && out.skills?.length === 2 && out.ms?.total > 0, JSON.stringify(out).slice(0, 300));
expect("the installed take stores the chosen value, not the range", typeof takes.get("c1")?.spec.use[1].args.heading[1] === "number");
const again = (x => x?.output ?? x)(registry.run("motion.qa", { characterId: "c1" }));
expect("motion.qa re-measures it clean without searching again", again.qa.ok && !again.search, JSON.stringify(again).slice(0, 200));

if (failures) { console.error(`${failures} motion3 search check(s) failed`); process.exit(1); }
console.log("motion3 search: all checks passed");
