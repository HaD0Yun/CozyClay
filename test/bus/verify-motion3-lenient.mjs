#!/usr/bin/env node
// Two refusals that cost the Studio agent a compile in most bat-swing runs (lane M2):
//   1. reachGrip ran one frame past the end: the agent keeps the left hand on the bat all take, so
//      reach + hold + release = frames and the release ended on f<frames>. A release (or a walk's
//      settle) that the take end cuts now ends the skill holding at the last frame, says so in
//      observations.cut and skills[i].cut, and a take that ends before the hold is still refused.
//   2. goals[i].moved "prop:batGrip.tip" was refused (object refs only). moved now takes any point
//      ref and measures how far the point gets from where it is at at[0]; the object form is as before.
// The specs are the agent's own (fixtures/bat-past-end.mjs); each was refused on v3@1d1ae6a6.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { resolveFrames } from "../../src/motion3/skills/frames-auto.js";
import { refPoint } from "../../src/motion3/refs.js";
import { len, sub } from "../../src/motion3/compiler/math.js";
import { batKit } from "../motion3/fixtures/bat-aim-swing.mjs";
import { REACH_PAST_END, MOVED_POINT } from "../motion3/fixtures/bat-past-end.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message.replace(/^MOTION_SPEC_INVALID: /, ""); } };
const sk = skeletonFor("y-bot-tpose"), m3 = v => Math.round(v * 1000) / 1000;
// the skill's own frames are measured: fix.retime (on by default) would move the swing's keys, and the reach with them
const compile = (run, spec = run.spec) => compileSpec({ ...spec, fix: { ...spec.fix, retime: false } }, { sk, scene: motionScene(batKit(run.kitAt)) });
/** The largest difference of any baked channel value (a number, a vector or a preset map) on frames 0..to. */
const diffUpTo = (a, b, to) => {
	const d = (x, y) => (typeof x === "number" ? Math.abs(x - y) : Math.max(0, ...Object.keys(x).map(k => d(x[k], y?.[k] ?? NaN))));
	return Math.max(0, ...Object.keys(a.out.baked).map(ch => Math.max(0, ...a.out.baked[ch].slice(0, to + 1).map((v, f) => d(v, b.out.baked[ch]?.[f])))));
};

// 1. reachGrip whose release the take end cuts
for (const run of REACH_PAST_END) {
	const { spec } = run, last = spec.frames - 1, a = spec.use[0].args, held = a.reach + a.hold, w = `w_${a.anchor}_${a.side}`, note = `release cut at f${last} (hold to the end)`;
	expect(`${run.session}: as sent, the release ends one frame past the last (reach + hold + release = frames ${spec.frames})`, held + a.release === spec.frames);
	const r = compile(run);
	console.log(`  ${run.session}: QA ${r.qa.total}, skills ${JSON.stringify(r.used)}, observations.cut ${JSON.stringify(r.observations.cut)}`);
	expect(`${run.session}: compiles; skills[0] ends at f${last} with cut "${note}"; observations.cut says "reachGrip: ${note}"`,
		r.out.frameCount === spec.frames && r.used[0].end === last && r.used[0].cut === note && JSON.stringify(r.observations.cut) === JSON.stringify([`reachGrip: ${note}`]), JSON.stringify([r.used, r.observations.cut]));
	expect(`${run.session}: ${w} holds 1 from the reach (f${a.reach}) to the last frame`, r.out.baked[w].slice(a.reach).every(v => Math.abs(v - 1) < 1e-9), JSON.stringify(r.out.baked[w].slice(-4)));
	const retry = compile(run, { ...spec, frames: spec.frames + 1 });
	expect(`${run.session}: every channel up to the hold end (f${held}) equals the agent's retry with one more frame, bit for bit`, !retry.used[0].cut && diffUpTo(r, retry, held) === 0, diffUpTo(r, retry, held));
	// a hold the take end cuts holds to the end too (grasp round 2, session 7f15b4ae); these specs' own keys past it are still refused
	const short = refusal(() => compile(run, { ...spec, frames: held }));
	expect(`${run.session}: a take that ends before the hold ends is refused for the spec's own keys past its end, not by reachGrip`,
		new RegExp(`^keys\\[\\d+\\]\\.f = \\d+ is outside 0\\.\\.${held - 1} \\(spec\\.frames ${held}\\)`).test(short) && !/reachGrip needs/.test(short), short);
	const auto = compile(run, { ...spec, frames: "auto" });
	expect(`${run.session}: frames "auto" ends with the release (frames ${held + a.release + 1}), nothing cut`, resolveFrames({ ...spec, frames: "auto" }, { sk, scene: motionScene(batKit(run.kitAt)) }).frames === held + a.release + 1
		&& auto.out.frameCount === held + a.release + 1 && !auto.used[0].cut && !auto.observations.cut, `${auto.out.frameCount} ${JSON.stringify(auto.used)}`);
}

// 2. walkTo whose settle (the held pose after the last step) the take end cuts: 4 steps from f10,
//    the last lands at f100, the walk ends at f124
const walk = frames => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [0, 1.2] } }] });
const empty = { sk, scene: { objects: {} } }, cutWalk = compileSpec(walk(110), empty), fullWalk = compileSpec(walk(125), empty);
expect("walkTo: a take that ends in the settle ends the walk at its last frame and says so", fullWalk.used[1].end === 124 && !fullWalk.used[1].cut && cutWalk.used[1].end === 109
	&& JSON.stringify(cutWalk.observations.cut) === JSON.stringify(["walkTo: settle cut at f109 (hold to the end)"]), JSON.stringify([cutWalk.used, cutWalk.observations.cut]));
// the held segment is evaluated as a spline between equal keys in the full take: equal to 1e-15
expect("walkTo: the cut take is the full take's first 110 frames (the settle only holds)", diffUpTo(cutWalk, fullWalk, 109) < 1e-12, diffUpTo(cutWalk, fullWalk, 109));
expect("walkTo: a take that ends before the last step lands is refused as before", refusal(() => compileSpec(walk(90), empty))
	=== 'use[1] walkTo needs 114 frames from f10 (to f124), past the last frame f89; set frames >= 125 or frames: "auto"', refusal(() => compileSpec(walk(90), empty)));

// 3. moved on a point ref: the farthest the point gets from where it is at at[0]
const [swing, sweep] = MOVED_POINT;
const travel = (r, ref, [f0, f1]) => {
	const home = refPoint(r.out, f0, ref);
	let best = { f: f0, v: 0 };
	for (let f = f0; f <= f1; f++) { const v = len(sub(refPoint(r.out, f, ref), home)); if (v > best.v) best = { f, v }; }
	return best;
};
let r = compile(swing);
const goal = swing.spec.goals[0], far = travel(r, goal.moved, goal.at), res = r.qa.goals.find(g => g.name === goal.name);
console.log(`  ${swing.session}: QA ${r.qa.total}, goals ${JSON.stringify(r.qa.goals)}`);
expect(`${swing.session}: moved "${goal.moved}" compiles and answers its farthest frame from f${goal.at[0]}`, res.kind === "moved" && res.value === m3(far.v) && res.at === far.f && res.ok === far.v >= goal.by, JSON.stringify({ res, far }));
r = compile(swing, { ...swing.spec, goals: [{ ...goal, by: 5 }] });
const g = r.qa.groups.find(x => x.kind === "GOAL");
expect(`${swing.session}: a point moved short of by is one GOAL issue at that frame, its subject naming from where`, !r.qa.ok && g.count === 1 && g.worstFrame === far.f
	&& g.subject === `${goal.name}: moved ${m3(far.v)} m from f${goal.at[0]} at f${far.f} (needs >= 5)` && /hand_r/.test(`${g.hint} ${g.cause}`), JSON.stringify(g));
// the probe row cap that stopped it is now fixed for it (C19): every grows to 5 and the answer names it
const sent = compile(sweep);
expect(`${sweep.session}: the spec as sent compiles; the probe's every grows to fit 16 rows, named in notes`, sent.probes?.["tip path"]?.at?.length === 15
	&& JSON.stringify(sent.notes) === JSON.stringify(["probes[0].every 4 -> 5: a position probe answers at most 16 rows"]), JSON.stringify(sent.notes));
r = compile(sweep, { ...sweep.spec, probes: [{ ...sweep.spec.probes[0], every: 5 }] });
const tip = r.qa.goals.find(x => x.name === sweep.spec.goals[1].name), tipFar = travel(r, sweep.spec.goals[1].moved, sweep.spec.goals[1].at);
expect(`${sweep.session}: with every 5 it compiles; "${sweep.spec.goals[1].name}" measures the tip`, r.probes?.["tip path"]?.at?.length === 15 && tip.value === m3(tipFar.v) && tip.at === tipFar.f, JSON.stringify(tip));
const invalid = goals => refusal(() => compile(swing, { ...swing.spec, goals }));
const cases = [
	[[{ moved: "joint:LeftHand", at: 30 }], 'goals[0].moved "joint:LeftHand" measures how far the point gets from where it is at at[0], so at must be [f0, f1] with f0 < f1, got 30'],
	[[{ moved: "landmark:mouth", at: [30, 30] }], 'goals[0].moved "landmark:mouth" measures how far the point gets from where it is at at[0], so at must be [f0, f1] with f0 < f1, got [30,30]'],
	[[{ moved: "prop:batGrip.nope", at: [30, 40] }], 'goals[0].moved "prop:batGrip.nope": spec.props has no point batGrip.nope'],
	[[{ moved: ["prop:batGrip.tip"], at: [30, 40] }], 'goals[0].moved must be an object id or a point ref (object:<id>[.center|.top|.base], prop:<prop>.<point>, joint:<Bone>, landmark:mouth, anchor:<name>), got ["prop:batGrip.tip"]'],
	[[{ moved: "object:empty", at: 30 }, { moved: "empty.top", at: 31 }, { moved: "joint:Head", at: [0, 20], mode: "any" }], ""],
];
for (const [goals, want] of cases) expect(`validation: ${want ? want.slice(0, 80) : "object:<id> at one frame, a bare id and a joint over a span pass"}`, invalid(goals) === want, invalid(goals));

if (failures) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("PASS motion3 lenient: reachGrip/walkTo tails cut at the take end, moved on point refs");
