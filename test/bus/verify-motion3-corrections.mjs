#!/usr/bin/env node
// C21 corrections and the whole refusal. Slips with one reading are corrected before the spec is stored and
// named in output.adjusted ("corrected: ..."), so the compile goes on; what has two readings is refused, every
// problem in one answer that the refusal receipt carries whole. walkTo with to and steps walks to `to` or says
// where it would end. Each class as the Studio agent sent it in the 14-day audit (schema/runtime errors were
// 9.6% of the repair iterations of the 100 motion turns with the most recompiles).
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "../motion3/fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fitOutput, MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { fixture } from "./fixture.mjs";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures += 1; };
const json = JSON.stringify;
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const refused = run => { try { run(); return ""; } catch (error) { return error.message; } };
const compile = (spec, sc = null, opts) => compileSpec(spec, { sk, scene: sc }, opts);
const base = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto" };
const stand = { skill: "standIdle", f0: 0, args: { at: [0, 0] } };
const walkSpec = args => ({ ...base, use: [stand, { skill: "walkTo", f0: 2, args }] });
const feetAt = r => { const st = {}; for (const k of [...r.expanded.keys].sort((a, b) => a.f - b.f)) Object.assign(st, k.set); return [(st.foot_l[0] + st.foot_r[0]) / 2, (st.foot_l[2] + st.foot_r[2]) / 2]; };
const off = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[q.length - 1]);

// 1. a generator with to is the walkTo skill (sessions 07a0a2a9, 1851a0fd: refused, then rewritten by hand)
const gen = compile({ ...base, use: [stand], generators: [{ type: "walk", f0: 2, to: [0, 1.47], steps: 4, period: 16 }] });
expect("generators[0] with to becomes use[1] walkTo, named, stored without the generator", json(gen.spec.use[1]) === json({ skill: "walkTo", f0: 2, args: { to: [0, 1.47], steps: 4, period: 16 } })
	&& gen.spec.generators === undefined && gen.notes?.[0] === "corrected: generators[0] (a walk with to) -> use[1] walkTo { to, steps, period }: a generator walks by steps and [h0, h1]; walkTo is the walk that heads for a point", json(gen.notes));
const turned = compile({ ...base, use: [stand], generators: [{ type: "walk", f0: 2, steps: 3, heading: 30 }] });
expect("a generator with a single heading becomes walkTo too (heading h is [h0, h])", turned.spec.use[1]?.skill === "walkTo" && /generators\[0\] \(a walk with a single heading\)/.test(turned.notes?.[0]), json(turned.notes));
expect("a generator with steps and [h0, h1] stays a generator", compile({ ...base, use: [stand], generators: [{ type: "walk", f0: 2, steps: 3, heading: [0, 10] }] }).notes === undefined);

// 2. names with one reading: channels (session 5e88f204: arm_swing_l x 10 keys), fields, skills, args, enums
const keyed = compile({ ...base, frames: 30, use: [stand], keys: [{ f: 10, set: { arm_swing_l: 12, spinePitch: 5, fpitch_left: 3 }, step: ["arm_swing_l"] }] });
const set = keyed.spec.keys[0].set;
expect("key channels: alias, case and side words are corrected (and step follows)", set.aswing_l === 12 && set.spine_pitch === 5 && set.fpitch_l === 3 && json(keyed.spec.keys[0].step) === '["aswing_l"]'
	&& json(keyed.notes) === json(['corrected: keys[0] (f10) channel "arm_swing_l" -> "aswing_l"', 'corrected: keys[0] (f10) channel "spinePitch" -> "spine_pitch"', 'corrected: keys[0] (f10) channel "fpitch_left" -> "fpitch_l"']), json(keyed.notes));
const both = refused(() => compile({ ...base, frames: 30, use: [stand], keys: [{ f: 10, set: { arm_swing_l: 12, aswing_l: 3 } }] }));
expect("a key that already sets the right channel keeps the slip refused (two readings)", /sets unknown channel "arm_swing_l"; did you mean "aswing_l"\?/.test(both), both);
const used = compile({ ...base, Label: "walk", use: [stand, { skill: "walk_to", f0: 2, to: [0, 1.47], args: { turn_distance: 0.4 } }, { skill: "reachGrip", args: { f0: 140, side: "Right", anchor: "bar", define: { kind: "world", position: [0.2, 1.2, 0.3] } } }] });
expect("spec field, skill name, a misplaced arg, args.f0, an arg's case and an enum's spelling are corrected",
	used.spec.label === "walk" && json(used.spec.use[1]) === json({ skill: "walkTo", f0: 2, args: { turnDistance: 0.4, to: [0, 1.47] } }) && used.spec.use[2].f0 === 140 && used.spec.use[2].args.side === "r"
	&& json(used.notes.slice(0, 6)) === json(["corrected: spec.Label -> spec.label", 'corrected: use[1].skill "walk_to" -> "walkTo"', "corrected: use[1].args.turn_distance -> use[1].args.turnDistance", "corrected: use[1].to -> use[1].args.to",
		'corrected: use[2].args.side "Right" -> "r"', "corrected: use[2].args.f0 -> use[2].f0"]), json(used.notes));
const objs = compile({ ...base, frames: 60, use: [stand], anchors: { spot: { kind: "world", pos: [0.3, 1, 0.3] } }, objects: { [CUP.group]: { free: { keys: [{ f: 10, position: [0.2, 0.9, 0.85], rot: [0, 0, 0, 1] }] } } },
	goals: [{ name: "cup up", near: [`object:${CUP.group}`, "anchor:spot"], tol: 1, at: 10 }] }, scene);
expect("an object wrapped in its kind (session 5e88f204: { free: { keys } }), a key's position and a world anchor's pos are corrected",
	json(objs.spec.objects[CUP.group]) === json({ keys: [{ f: 10, pos: [0.2, 0.9, 0.85], rot: [0, 0, 0, 1] }] }) && json(objs.spec.anchors.spot) === json({ kind: "world", p: [0.3, 1, 0.3] })
	&& objs.notes.includes(`corrected: objects.${CUP.group}.free { keys } -> objects.${CUP.group} { keys }: an entry's kind is read from its fields, not named`), json(objs.notes));
const typo = refused(() => compile({ ...base, frames: 30, use: [stand], goals: [{ near: ["joint:Hips", "joint:Head"], tolerence: 1, at: 10 }] }));
expect("a misspelling that is not one name told another way is refused, not guessed", /goals\[0\] has unknown field "tolerence"/.test(typo), typo);

// 3. refusals: every problem in one answer, repeated ones on one line, corrections named after them
const many = refused(() => compile({ ...base, frames: 50, use: [{ ...stand, args: { at: [0, 0], bogus: 1 } }, { skill: "reachGrip", f0: 2, args: { side: "l" } }, { skill: "flip", f0: 20, args: { kind: "sideways" } }] }));
expect("use entries: every problem at once (an unknown arg, a missing arg, an enum miss), not the first only", many === ["MOTION_SPEC_INVALID: use[0].args.bogus is not an arg of standIdle (args: at, heading, until)",
	"use[1] reachGrip needs args.anchor (not ending in _l/_r)", 'use[2].args.kind must be one of "back", "front", "cartwheel" (a standing back or front tuck, or a cartwheel), got "sideways"'].join("\n"), many);
const merged = refused(() => compile({ ...base, frames: 30, use: [stand], keys: [0, 4, 8].map(f => ({ f, set: { zzz: 1 } })), goals: [{ near: ["joint:Hips", "joint:Head"], tol: 0.1, at: 40 }, { near: ["joint:Hips", "joint:Head"], tol: 0.1, at: 41 }] }));
expect("problems that differ only in their index share a line", merged.includes('keys[0,1,2] (f0, f4, f8) sets unknown channel "zzz"') && merged.split("\n").length === 3, merged);
const mixed = refused(() => compile({ ...base, use: [stand, { skill: "walkTo", f0: 2, args: { to: [0, 3], steps: 3, period: 16 } }, { skill: "reachGrip", f0: 100, args: { side: "r", anchor: "bar", define: { kind: "world", p: [0.3, 1.2, 2] } } }], keys: [{ f: 5, set: { zzz: 1 } }] }));
expect("a walk that cannot reach to is refused with the validator's problems, not before them", /^MOTION_SPEC_INVALID: use\[1\] walkTo: steps 3/.test(mixed) && /keys\[0\] \(f5\) sets unknown channel "zzz"/.test(mixed), mixed);
const moved = refused(() => compile({ ...base, frames: 30, use: [stand], generators: [{ type: "walk", f0: 2, to: [0, 1] }], keys: [{ f: 5, set: { zzz: 1 } }] }));
expect("a refusal names the corrections made before it (the paths it names are the corrected spec's)", /\n\(adjusted before these checks: corrected: generators\[0\] \(a walk with to\) -> use\[1\] walkTo/.test(moved), moved);

// 4. what the validator now takes or says better
const origin = compile({ ...base, frames: 60, use: [stand], props: { lhand: { hand: "l", origin: ["LeftHandIndex1", "LeftHandPinky1"] } }, anchors: { bar: { kind: "world", p: [0.3, 1.1, 0.35] } },
	fits: [{ side: "l", anchor: "bar", effector: { prop: "lhand", point: "origin" } }], keys: [{ f: 10, set: { w_bar_l: 1, armw_l: 1 } }] });
expect("a fit's effector may be its prop's origin (refs and the compiler always had it; sessions 90f6b8d5, 95b449d7)", origin.qa !== undefined);
const plane = motionScene([...SCENE_OBJECTS, { id: "plane", name: "Floor", renderer: "plane", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 5, scaleY: 1, scaleZ: 5, footprint: { width: 1, depth: 1 }, height: 0 }]);
const onto = refused(() => compile({ ...base, frames: 60, use: [stand], objects: { [CUP.group]: { fall: { at: 10, onto: "plane" } } } }, plane));
expect("a record with no body is said to have none (it was 'not in the scene; did you mean \"plane\"?')", /fall\.onto names "plane", a plane with no body/.test(onto), onto);

// 5. a knee pole sent as a world direction while the body faces -Z (sessions 80f5f6fa, 4a3423e0)
const back = { ...base, frames: 40, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 180 } }], keys: [{ f: 10, set: { knee_l: [-0.03, 0.29, -0.96] } }] };
const pole = compile(back);
expect("at root yaw 180 a backward body-frame pole that points forward in the world is that world direction", json(pole.expanded.keys.find(k => k.src === "keys[0]").set.knee_l) === "[0.03,0.29,0.96]"
	&& pole.notes?.[0] === "corrected: keys[0] (f10) knee_l [-0.03,0.29,-0.96] is a world direction at root yaw 180: body frame [0.03,0.29,0.96] (a pole is +z forward)", json(pole.notes));
// facing +Z it points backward either way: the validator mirrors it forward and says so (#1126; validate-mend.js)
const facing = compile({ ...back, use: [stand] });
expect("facing +Z the same pole is mirrored forward, named", json(facing.expanded.keys.find(k => k.src === "keys[0]").set.knee_l) === "[-0.03,0.29,0.96]"
	&& facing.notes?.includes("corrected: keys[0] (f10) knee_l = [-0.03,0.29,-0.96] points backward (knees bend toward +z): mirrored forward to [-0.03,0.29,0.96]")
	&& facing.spec.keys[0].set.knee_l[2] === -0.96, json(facing.notes));

// 6. walkTo with to and steps (C21): the steps walked steps x stride wherever to was (386 of 561 such walks missed it by > 0.1 m)
// in a natural gait (skills/basic.js fitTo): a stride fitted at a fixed cadence went to 0.87 m at 1.2 steps a second
const fit = compile(walkSpec({ to: [0, 1.7], steps: 4, step: 0.44 }));
expect("to with steps and a stride that falls short: the stride (and the first step's share) is fitted, stored and named, and the walk ends at to",
	fit.spec.use[1].args.step === 0.56 && fit.spec.use[1].args.firstStep === 0.51 && off(feetAt(fit), [0, 1.7]) <= 0.1
	&& fit.notes?.[0] === "corrected: use[1] walkTo: step 0.44 -> 0.56 m, firstStep 0.4 -> 0.51 m, so steps 4 end at to [0, 1.7] (at step 0.44 they walk 1.35 of 1.7 m)", json([fit.notes, feetAt(fit)]));
const again = compile(fit.spec);
expect("the stored spec compiles to the same walk with nothing to fit", again.notes === undefined && json(feetAt(again)) === json(feetAt(fit)));
const two = compile(walkSpec({ to: [0, 0.6], steps: 2 }));
expect("two steps fit the first step", two.spec.use[1].args.firstStep === 0.53 && off(feetAt(two), [0, 0.6]) <= 0.1, json([two.notes, feetAt(two)]));
// a reach after the walk fixes its time; without one (frames "auto") the walk may end later
const reachAt = f0 => ({ skill: "reachGrip", f0, args: { side: "r", anchor: "bar", define: { kind: "world", p: [0.3, 1.2, 2] } } });
const timedSpec = (args, f0) => ({ ...base, use: [stand, { skill: "walkTo", f0: 2, args }, reachAt(f0)] });
const gaitOf = r => { const a = r.spec.use[1].args; return { step: a.steps >= 3 ? a.step : a.firstStep, cadence: 24 / (a.period ?? 20), end: 2 + 16 + a.steps * (a.period ?? 20) + 18 }; };
const natural = g => g.step >= 0.25 && g.step <= 0.7 && g.cadence >= 1 && g.cadence <= 1.8;
const lunge = compile(walkSpec({ to: [0, 1.28], steps: 3 }));
expect("a stride past the natural band (0.81 m at 1.2 steps a second) is not taken: one more step at the walk's cadence", lunge.spec.use[1].args.steps === 4 && gaitOf(lunge).step <= 0.7
	&& gaitOf(lunge).cadence === 1.2 && off(feetAt(lunge), [0, 1.28]) <= 0.1, json([lunge.notes, lunge.spec.use[1].args]));
const quick = compile(timedSpec({ to: [0, 1.6], steps: 3 }, 100));
expect("steps that cannot reach in a natural step get more steps at a quicker cadence in the same time (the walk still ends f96), named", json(quick.spec.use[1].args) === json({ to: [0, 1.6], steps: 4, period: 15, swing: 11, step: 0.55, firstStep: 0.44 })
	&& gaitOf(quick).end === 96 && natural(gaitOf(quick)) && off(feetAt(quick), [0, 1.6]) <= 0.1
	&& quick.notes?.[0] === "corrected: use[1] walkTo: steps 3 -> 4, period 20 -> 15 (swing 14 -> 11), step 0.5 -> 0.55 m, firstStep 0.4 -> 0.44 m, so steps 4 end at to [0, 1.6] in a natural gait (step 0.25..0.7 m, 1..1.8 steps a second: period 14..24 at 24 fps; steps 3 would need a step of 0.85 m at 1.2 steps a second)", json([quick.notes, feetAt(quick)]));
const last = compile(walkSpec({ to: [0, 1.6], steps: 3 }));
expect("with nothing after it in a frames \"auto\" spec the walk keeps its cadence and ends later", json(last.spec.use[1].args) === json({ to: [0, 1.6], steps: 4, step: 0.55, firstStep: 0.44 })
	&& /second\); it ends f116, not f96 \(nothing follows it\)$/.test(last.notes?.[0] ?? ""), json(last.notes));
const many2 = compile(timedSpec({ to: [0, 1], steps: 6 }, 200));
expect("too many steps for the distance: fewer, slower ones that end no later (the pose holds to the old end)", json(many2.spec.use[1].args) === json({ to: [0, 1], steps: 4, period: 24, swing: 17, step: 0.33, firstStep: 0.27 })
	&& natural(gaitOf(many2)) && gaitOf(many2).end <= 156 && /it ends f132, not f156 \(the pose holds to f156\)/.test(many2.notes?.[0] ?? "") && off(feetAt(many2), [0, 1]) <= 0.1, json(many2.notes));
const far = refused(() => compile(timedSpec({ to: [0, 3], steps: 3, period: 16 }, 100)));
expect("a walk no natural gait reaches in its time is refused with the steps and frames it needs", far === "MOTION_SPEC_INVALID: use[1] walkTo: steps 3 at period 16 (48 frames of stepping) walk 0.97 m and end at [0, 0.97], 2.03 m short of to [0, 3] (3 m away); in a natural gait (step 0.25..0.7 m, 1..1.8 steps a second: period 14..24 at 24 fps) that takes 6 steps and 84 frames of stepping or more (the walk would end at f120 or later, not f84): leave steps out (walkTo picks the count), or give steps: 6 and room for the walk before what follows", far);
// bench S7/S10 (merged runs r2-r3): 4 walks refused although a gait in the bands reached; now fitted and named
const edge = compile(timedSpec({ to: [0, 1.38], steps: 3, period: 18 }, 90));
expect("steps a hair past the longest natural step (0.73 m): that step, ending within 0.1 m of to (as a walk that near is not fitted), named", json(edge.spec.use[1].args) === json({ to: [0, 1.38], steps: 3, period: 18, step: 0.7, firstStep: 0.56 })
	&& off(feetAt(edge), [0, 1.38]) <= 0.1 && edge.notes?.[0] === "corrected: use[1] walkTo: step 0.5 -> 0.7 m, firstStep 0.4 -> 0.56 m, so steps 3 end 0.05 m short of to [0, 1.38], the longest natural step (a natural gait (step 0.25..0.7 m, 1..1.8 steps a second: period 14..24 at 24 fps; steps 3 would need a step of 0.73 m at 1.33 steps a second)", json([edge.notes, feetAt(edge)]));
const beyond = refused(() => compile(timedSpec({ to: [0, 1.45], steps: 3, period: 18 }, 90)));
expect("the longest natural step ending 0.11 m short or more: still refused", /^MOTION_SPEC_INVALID: use\[1\] walkTo: steps 3 at period 18 \(54 frames of stepping\) walk 0.97 m/.test(beyond), beyond);
const fixedTake = extra => ({ ...base, frames: 100, use: [stand, { skill: "walkTo", f0: 2, args: { to: [0, 1.9], steps: 3, period: 18 } }], keys: [{ f: 40, set: { head_pitch: 5 } }, ...(extra?.keys ?? [])], ...(extra?.objects ? { objects: extra.objects } : {}) });
const roomy = compile(fixedTake());
expect("free frames after the walk (no skill, key or object key; the take has room): more steps at a natural cadence end later there, named", json(roomy.spec.use[1].args) === json({ to: [0, 1.9], steps: 4, period: 15, swing: 12, step: 0.65, firstStep: 0.52 })
	&& off(feetAt(roomy), [0, 1.9]) <= 0.1 && natural(gaitOf(roomy)) && /second\); it ends f96, not f90 \(nothing uses f91-f96\)$/.test(roomy.notes?.[0] ?? ""), json(roomy.notes));
const settleKey = refused(() => compile(fixedTake({ keys: [{ f: 85, set: { head_pitch: 0 } }] })));
const objectKey = refused(() => compile(fixedTake({ objects: { [CUP.group]: { keys: [{ f: 80, pos: [0.2, 0.75, 0.85] }] } } })));
expect("a key, or an object key, after the walk's stepping: those frames are not free, still refused", [settleKey, objectKey].every(m => /^MOTION_SPEC_INVALID: use\[1\] walkTo: steps 3 at period 18/.test(m)), json([settleKey, objectKey]));
const short = refused(() => compile({ ...fixedTake(), frames: 92 }));
expect("the take's last frame bounds the room: a walk that would end past it is still refused", /^MOTION_SPEC_INVALID: use\[1\] walkTo: steps 3 at period 18/.test(short), short);
// a to against a body: the bench replay (n=692) had walks fitted onto a to 0.22-0.30 m from a box the body then bent over;
// the walk stops 0.5 legs (0.41 m on the Y Bot) before a low body ahead instead, named; a carried body or a far one keeps the fit
const boxRec = { id: "crate", name: "crate", renderer: "cube", x: 0, y: 0, z: 1, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.4, scaleY: 0.3, scaleZ: 0.3, footprint: { width: 1, depth: 1 }, height: 1 };
const crate = motionScene([boxRec]);
const atCrate = compile(walkSpec({ to: [0, 0.6], steps: 3 }), crate);
expect("to 0.25 m from a low box ahead: the walk ends 0.41 m before it, at the nearest natural gait, named", off(feetAt(atCrate), [0, 0.44]) <= 0.1
	&& /^corrected: use\[1\] walkTo: .*so steps \d end at \[0, 0\.4\d\], 0\.4\d m before crate \(to \[0, 0\.6\] is against it\)/.test(atCrate.notes?.[0] ?? ""), json([atCrate.notes, feetAt(atCrate)]));
const shy = compile(walkSpec({ to: [0, 0.3], steps: 2 }), crate);
expect("a to clear of the box keeps the exact fit", off(feetAt(shy), [0, 0.3]) <= 0.1 && /so steps 2 end at to \[0, 0\.3\]/.test(shy.notes?.[0] ?? ""), json(shy.notes));
// a table (higher than 0.65 legs): the standing body clears it by 0.05 m (legs, feet, hips), so a cup on it stays in reach
const atTable = compile({ ...base, use: [{ skill: "standIdle", f0: 0, args: { at: [0, -1.2] } }, { skill: "walkTo", f0: 2, args: { to: [0, 0.6], steps: 3 } }] }, scene);
expect("to at a table's edge: the walk ends where the standing body clears it (0.13 m from it), named", off(feetAt(atTable), [0, 0.47]) <= 0.02
	&& /so steps \d end at \[0, 0\.47\], 0\.13 m before cube \(to \[0, 0\.6\] is against it\)/.test(atTable.notes?.[0] ?? ""), json([atTable.notes, feetAt(atTable)]));
// a stop moves where the next walk starts: kept only while no later walk refuses (bench replay: 3 of 692 specs did)
const chainCrate = motionScene([{ ...boxRec, z: 0.9 }]);
const backUp = [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }, { skill: "walkTo", f0: 2, args: { to: [0, 0.8], steps: 3 } }, { skill: "walkTo", f0: 100, args: { to: [0, 0.55], steps: 2, heading: 180 } }];
const alone = compile({ ...base, use: backUp.slice(0, 2) }, chainCrate), chained = compile({ ...base, use: backUp }, chainCrate);
expect("a stop that would turn a later walk away from its to (heading 180 backing up) is not made: the walk keeps to, no refusal, nothing said", / m before crate/.test(alone.notes?.[0] ?? "")
	&& !/ m before /.test(json(chained.notes)) && off(feetAt({ expanded: { keys: chained.expanded.keys.filter(k => k.f <= 99) } }), [0, 0.8]) <= 0.1, json([alone.notes, chained.notes]));
const carried = compile({ ...walkSpec({ to: [0, 0.6], steps: 3 }), props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } }, objects: { crate: { prop: "grip", grab: 1, release: 70 } } }, crate);
expect("a body the hand carries during the walk is not in its way: the exact fit", off(feetAt(carried), [0, 0.6]) <= 0.1 && !/ m before /.test(json(carried.notes)), json(carried.notes));
const away = refused(() => compile(walkSpec({ to: [0, 2], heading: 180 })));
expect("a heading that points away from to is refused (session 4a3423e0)", /use\[1\] walkTo: heading 180 points 180 deg away from to \[0, 2\] \(it lies at heading 0\)/.test(away), away);
expect("a saved take (lenient) walks as it always did: no fit, no refusal", compile(walkSpec({ to: [0, 1.6], steps: 3 }), null, { lenient: true }).spec.use[1].args.step === undefined);
const loose = compile(walkSpec({ to: [0, 1.2] }));
expect("to alone: the walk that misses by more than 0.1 m says where it ends", json(loose.observations.placed) === json(["walkTo f2: ends 0.27 m from to [0, 1.2]: at [0, 1.47], heading 0"]), json(loose.observations.placed));

// 7. the refusal receipt carries the whole message (it was cut at 500 characters: 30 of the audited refusals)
const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const app = createStudioAppActions({ state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 120 }), storeDomain: n => (n === "motion" ? owner : null) });
const bus = fixture([app.get("motion.compile")]);
const longSpec = { ...base, frames: 30, use: [stand], keys: [{ f: 1, set: { a1: 1, b2: 1, c3: 1, d4: 1, e5: 1, f6: 1, g7: 1, h8: 1, i9: 1 } }] };
const receipt = await bus.bus.run("motion.compile", { characterId: CHARACTER.id, spec: longSpec, install: false }, bus.request("agent"));
expect("a refusal of nine problems reaches the agent whole (no cut), within the 8 KiB receipt", receipt.ok === false && receipt.code === "INVALID_ARGUMENT" && receipt.message.length > 500
	&& receipt.message.split("\n").length === 9 && /i9/.test(receipt.message) && new TextEncoder().encode(json(receipt)).length <= 8192, json(receipt).slice(0, 300));

// a repair starts from the corrected spec (its patches address the stored spec) and still names the corrections
const repaired = app.run("motion.compile", { characterId: CHARACTER.id, install: false, repair: { rounds: 1 },
	spec: { ...base, use: [{ skill: "standIdle", f0: 0, args: { at: [-1, 0], heading: -90 } }], generators: [{ type: "walk", f0: 2, to: [-2.47, 0], steps: 4 }] } });
expect("a repaired compile keeps the corrections in output.adjusted and the corrected spec", /^corrected: generators\[0\] \(a walk with to\) -> use\[1\] walkTo/.test(repaired.output.adjusted?.[0] ?? "") && "repair" in repaired.output, json(repaired.output.adjusted));

// 8. a repair that applied many patches keeps the newest within the receipt budget (it answered "Receipt exceeds 8 KiB")
const applied = Array.from({ length: 80 }, (_, i) => ({ kind: "SLIDE", subject: `foot_l step ${i}`, patch: [{ op: "replace", path: `/use/1/args/step`, value: 0.5 + i / 100 }], severity: [3, 2] }));
const cut = fitOutput({ frames: 100, specId: "spec-000000000000", qa: { ok: false, total: 1, groups: [] }, observations: {}, repair: { rounds: 8, compiles: 80, applied, rejected: 2 } });
expect("repair.applied keeps its newest entries within the budget, more.repair counts the rest", new TextEncoder().encode(json(cut)).length <= MOTION_OUTPUT_BUDGET && cut.more.repair > 0
	&& cut.repair.applied.at(-1).subject === "foot_l step 79" && cut.repair.applied.length + cut.more.repair === 80, json(cut.more));

if (failures) { console.error(`${failures} corrections check(s) failed`); process.exit(1); }
console.log("verify-motion3-corrections: all checks passed");
