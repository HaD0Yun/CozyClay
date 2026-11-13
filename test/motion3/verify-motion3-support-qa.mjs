#!/usr/bin/env node
// A box held from below at its sides (grasp "support", 2026-11-05): QA judges the fingertips under it
// (qa/grasp-checks.js, qa/hints-grasp.js). On the A/B T2 walk (fixtures/ab-t2-box.json):
//   - TIPS_OFF "<side> fingertips not under <id>": a support hold with fewer than 3 of the 4 fingertips under the box's
//     bottom face, on a frame whose box stands SUPPORT_SLIDE (0.1 m) clear of what is under it on every frame within
//     SUPPORT_LEAD (6) of it (sockets.js); nearer, the compiler has the fingers out on purpose (the pickup from the
//     table, the drop onto the shelf), so those frames are not judged
//   - PALM_OFF judges a support hold's palm as it judges a palm hold's
//   - TIPS_OFF's hint names what the spec sets, never a hand move: a local that pins the palm (its patch removes it)
// Both anchors take grasp support: local at mid-height (the palm 15 cm up, where the agents' runs put it: the fingers
// cannot reach under) fires through the walk; no local (the compiler's placement) fires nowhere. The fixture's own palm
// grasp is not judged.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { graspChecks, clearanceAt } from "../../src/motion3/qa/grasp-checks.js";
import { explainGroups } from "../../src/motion3/qa/explain.js";
import { SUPPORT_SLIDE, SUPPORT_LEAD } from "../../src/motion3/sockets.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}

const { objects, reference } = JSON.parse(readFileSync(new URL("./fixtures/ab-t2-box.json", import.meta.url), "utf8"));
const sk = skeletonFor("x-bot-tpose"), scene = motionScene(objects), BOX = "cube-3", SIDES = ["left", "right"];
const WALK = [180, 280], HELD = [155, 362]; // the walk with the box; reachGrip's hold (f0 136 + reach 19 .. + hold 207)

/** The reference with both box anchors on grasp support, local [+-x, y, z] (null: no local, the compiler places the hand). */
function supportSpec(local) {
	const spec = structuredClone(reference);
	for (const [name, sx] of [["boxL", 1], ["boxR", -1]]) {
		spec.anchors[name].grasp = "support";
		if (local) spec.anchors[name].local = [sx * local[0], local[1], local[2]];
		else delete spec.anchors[name].local;
	}
	for (const u of spec.use.filter(u => u.skill === "reachGrip")) delete u.args.fingers; // the grasp's own (hook)
	return spec;
}
/** The absolute frames of one side's issues of a kind (graspChecks frames index out.frames). */
const framesOf = (r, kind, side) => graspChecks(sk, r.out).filter(i => i.kind === kind && i.msg.startsWith(`${side} `)).map(i => i.frame + (r.out.f0 ?? 0));
const span = ([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i), inSpan = ([a, b]) => fs => fs.filter(f => f >= a && f <= b);
const runs = fs => fs.reduce((out, f) => (out.length && f === out.at(-1)[1] + 1 ? (out.at(-1)[1] = f, out) : [...out, [f, f]]), []).map(([a, b]) => (a === b ? `f${a}` : `f${a}-${b}`)).join(", ") || "none";
/** The frames whose box stands SUPPORT_SLIDE clear on every frame within SUPPORT_LEAD (the frames TIPS_OFF judges). */
const clearFrames = r => { const gap = span([0, r.out.frameCount - 1]).map(g => clearanceAt(r.out, BOX, g).gap); return span(HELD).filter(f => gap.slice(Math.max(0, f - SUPPORT_LEAD), f + SUPPORT_LEAD + 1).every(v => v >= SUPPORT_SLIDE)); };

const mid = supportSpec([0.152, 0.15, -0.06]), rMid = compileSpec(mid, { sk, scene });
const none = supportSpec(null), rNone = compileSpec(none, { sk, scene });
const rPalm = compileSpec(reference, { sk, scene });
const tips = Object.fromEntries([["mid", rMid], ["none", rNone]].map(([k, r]) => [k, Object.fromEntries(SIDES.map(side => [side, framesOf(r, "TIPS_OFF", side)]))]));

// the palm 15 cm up the face: no fingertip reaches under the bottom on any frame of the walk
for (const side of SIDES) {
	const walk = inSpan(WALK)(tips.mid[side]);
	expect(`support, local 15 cm up: TIPS_OFF on every walk frame (${walk.length}/${WALK[1] - WALK[0] + 1}), ${side} hand`, walk.length === WALK[1] - WALK[0] + 1, runs(tips.mid[side]));
	expect(`support, local 15 cm up: one group "${side} fingertips not under ${BOX}"`, rMid.qa.groups.filter(g => g.kind === "TIPS_OFF" && g.subject === `${side} fingertips not under ${BOX}`).length === 1,
		rMid.qa.groups.filter(g => g.kind === "TIPS_OFF").map(g => g.subject).join("; "));
}
// near the table (the pickup) and the shelf (the drop) it is not judged: the fingers have no room under the box there
const judged = clearFrames(rMid), skipped = span(HELD).filter(f => !judged.includes(f)), early = SIDES.flatMap(side => tips.mid[side].filter(f => !judged.includes(f)));
expect(`support, local 15 cm up: no TIPS_OFF on a held frame within ${SUPPORT_LEAD} frames of the box nearer than ${SUPPORT_SLIDE} m to what is under it (${runs(skipped)})`, skipped.length >= 10 && early.length === 0, runs(early));
// the compiler's own placement (no local, reachGrip's grasp fingers): the fingertips stay under the box wherever it is judged
for (const side of SIDES) expect(`support, no local: no TIPS_OFF, ${side} hand`, tips.none[side].length === 0, runs(tips.none[side]));
// the palms are on their faces in both: PALM_OFF judges a support hold and stays quiet
for (const [label, r] of [["local 15 cm up", rMid], ["no local", rNone]]) {
	const off = SIDES.flatMap(side => framesOf(r, "PALM_OFF", side));
	expect(`support, ${label}: no PALM_OFF`, off.length === 0 && !r.qa.groups.some(g => g.kind === "PALM_OFF"), runs(off));
}
// the fixture's own palm grasp (fingers hook): only a support hold is judged for the tips
expect("the palm-grasp reference raises no TIPS_OFF", !rPalm.qa.groups.some(g => g.kind === "TIPS_OFF") && SIDES.every(side => framesOf(rPalm, "TIPS_OFF", side).length === 0),
	rPalm.qa.groups.filter(g => g.kind === "TIPS_OFF").map(g => `${g.subject} f${g.first}-${g.last}`).join("; "));

// the hint, whatever the group's rank: a local pins the palm, its patch removes it
const explained = (r, spec) => explainGroups(sk, r.out, r.expanded, r.qa.groups.filter(g => g.kind === "TIPS_OFF").map(g => ({ ...g, cause: undefined, hint: undefined, patch: undefined })), { userSpec: spec });
for (const g of explained(rMid, mid)) {
	const name = g.subject.startsWith("left") ? "boxL" : "boxR";
	expect(`support, local 15 cm up: ${g.subject}'s hint names anchors.${name}.local and its patch removes it`, g.cause === `anchors.${name}.local` && /holds the palm 15 cm above the bottom: remove it/.test(g.hint ?? "")
		&& JSON.stringify(g.patch) === JSON.stringify([{ op: "remove", path: `/anchors/${name}/local` }]), `${g.cause} | ${g.hint} | ${JSON.stringify(g.patch)}`);
}
// with no local the compiler's hand is the one the spec does not set: the hint keys the box (a group put on the no-local
// take at f250, mid-walk, two tips off: the explain context is the real one)
const [made] = explainGroups(sk, rNone.out, rNone.expanded, [{ kind: "TIPS_OFF", subject: `left fingertips not under ${BOX}`, count: 1, worst: 2, worstFrame: 250, first: 250, last: 250, limit: 1 }], { userSpec: none });
expect("support, no local: the hint keys the box nearest the frame (objects.cube-3.keys[i] f248), says how far it is over what is under it, and moves no hand or anchor point",
	/^objects\.cube-3\.keys\[\d+\] f248$/.test(made.cause ?? "") && /^cube-3 at f250: 2 of 4 left fingertips under its bottom, which is [\d.]+ cm over the floor; .*level and nearer the chest/.test(made.hint ?? "")
		&& !/: move \[|anchors\./.test(made.hint ?? "") && !made.patch, `${made.cause} | ${made.hint}`);
// every other hint on the no-local take (a forearm against the box, a thumb in it) keeps the anchor without local: a move
// of its point would pin the palm higher, the fingers off the bottom (qa/hints-contact.js moveHint)
const others = explainGroups(sk, rNone.out, rNone.expanded, rNone.qa.groups.map(g => ({ ...g, cause: undefined, hint: undefined, patch: undefined })), { userSpec: none })
	.filter(g => /box[LR]/.test(`${g.cause} ${g.hint}`));
expect(`support, no local: no hint moves anchors.boxL/boxR.local or patches it (${others.length} hints on the anchors: ${[...new Set(others.map(g => g.kind))].join(", ")})`,
	others.length > 0 && others.every(g => !/anchors\.box[LR]\.local/.test(g.hint ?? "") && !JSON.stringify(g.patch ?? null).includes("/local") && /keep it without local/.test(g.hint ?? "")),
	others.map(g => `${g.kind} ${g.subject}: ${g.hint} | ${JSON.stringify(g.patch ?? null)}`).join("\n"));
console.log(`  TIPS_OFF frames: local 15 cm up ${SIDES.map(s => `${s} ${runs(tips.mid[s])}`).join(", ")}; no local ${SIDES.map(s => `${s} ${runs(tips.none[s])}`).join(", ")}`);
console.log(`  QA problems: local 15 cm up ${rMid.qa.problems}, no local ${rNone.qa.problems}, palm reference ${rPalm.qa.problems}`);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
