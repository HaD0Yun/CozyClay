// A cup the arm cannot reach (box QA 2026-11-04, fixtures/cup-table-reach.mjs): the hand stopped at the rim, and the grip
// hints (hold it nearer the palm, move the point on the cup) sent the agent through six compiles. The grip groups now
// name the reach: the body nearer, or the cup nearer the body. With the cup 5 cm nearer the edge the same take grips it.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { objects, CUP_SPEC } from "./fixtures/cup-table-reach.mjs";

const sk = skeletonFor("x-bot-tpose");
const far = compileSpec(CUP_SPEC, { sk, scene: motionScene(objects()) }).qa.groups;
for (const kind of ["SUPPORT", "FINGER_GAP"]) {
	const g = far.find(x => x.kind === kind);
	assert.ok(g, `${kind} is reported: ${far.map(x => x.kind)}`);
	assert.match(g.cause, /^cylinder-5 out of reach at f10[0-2]$/, `${kind} names the reach as the cause: ${g.cause}`);
	assert.match(g.hint, /body: move .* toward the target .*arm r is at full reach.*cylinder-5 is out of reach.*move cylinder-5 nearer the body/, `${kind} hint: ${g.hint}`);
}
console.log("PASS a cup out of reach: SUPPORT and FINGER_GAP name the reach, not the grip");

const nearer = structuredClone(CUP_SPEC);
for (const key of nearer.objects["cylinder-5"].keys) if (key.f === 104) key.pos = [key.pos[0] + 0.05, key.pos[1], key.pos[2]];
const near = compileSpec(nearer, { sk, scene: motionScene(objects(0.05)) }).qa.groups;
assert.ok(!near.some(g => g.kind === "SUPPORT" || g.kind === "FINGER_GAP"), `5 cm nearer, the hand grips the cup: ${near.map(g => `${g.kind} ${g.subject}`)}`);
console.log("PASS the same take with the cup 5 cm nearer the edge: the fingers close round it");
