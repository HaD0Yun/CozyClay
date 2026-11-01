#!/usr/bin/env node
// fix.person (fix/person.js): an arm keyed into another character comes back out of her body the side it came from, in
// fixed passes, so the same spec bakes the same take. A: Y Bot at z 1.52 facing +z; Jiwoo (X Bot) at z 2 facing A, as in
// verify-motion3-people.mjs. The poke keys A's right wrist into her chest at z tz from f24 to f52.
// The closest-point escape (the normal as it is) passes the PERSON count too but takes the hand out through her back at
// tz 1.93 and 2.00 (fingertip z 2.154 and 2.165 at f40 in the research prototype): that is why the fingertip is checked.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { bakeTake } from "../../src/motion3/take.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { peopleOf } from "../../src/motion3/people.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { takeSource, compileTakeSource } from "../../src/domains/motion/take-source.js";
import { createHash } from "node:crypto";
import { takeHash } from "./fixtures/take-hash.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const yb = skeletonFor("y-bot-tpose"), xb = skeletonFor("x-bot-tpose"), spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 };
const B = { id: "char-b", subject: "Jiwoo", model: "x-bot-tpose", x: 0, y: 0, z: 2, rot: 180 };
const bSpec = { ...spec0, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 2], heading: 180, until: 119 } }] };
const takeB = bakeTake(xb, compileSpec(bSpec, { sk: xb, scene: motionScene([]) }).out, { position: [0, 0, 2], yaw: 180 }, { spec: bSpec });
const people = peopleOf([B, { id: "char-a", model: "y-bot-tpose" }], "char-a", id => (id === "char-b" ? takeB : null));
const scene = { ...motionScene([]), people }, empty = motionScene([]);
const compile = (spec, sc = scene) => compileSpec(spec, { sk: yb, scene: sc });
const hash = r => takeHash(bakeTake(yb, r.out));
const personCount = r => r.qa.groups.filter(g => g.kind === "PERSON").reduce((s, g) => s + g.count, 0);
const off = spec => ({ ...spec, fix: { ...spec.fix, person: false } });
const TIP = yb.index.RightHandMiddle3;

const stand = at => ({ skill: "standIdle", f0: 0, args: { at: [0, at], heading: 0 } });
const elbow = [-1, -0.5, 0];
const poke = tz => ({ ...spec0, frames: 80, use: [stand(1.52)], keys: [
	{ f: 0, set: { armw_r: 0 } }, { f: 16, set: { armw_r: 1, hand_r: [-0.12, 1.3, 1.62], elbow_r: elbow } },
	{ f: 24, set: { hand_r: [-0.1, 1.28, tz], elbow_r: elbow } }, { f: 52, set: { hand_r: [-0.1, 1.28, tz], elbow_r: elbow } },
	{ f: 66, set: { armw_r: 1, hand_r: [-0.12, 1.3, 1.62] } }] });

// 1-3. each poke: PERSON before, none after; the fingertip never past her hips (z 2.0); the same take twice
// fix.person alone: retime (on by default) re-times the z 2.0 poke's retraction and leaves the fingertip at z 2.013 on f56
const pokeFixed = tz => ({ ...poke(tz), fix: { retime: false } });
let ms = 0;
for (const tz of [1.8, 1.86, 1.9, 1.93, 2.0]) {
	const before = compile(off(pokeFixed(tz)));
	const t0 = performance.now(), r = compile(pokeFixed(tz)), t = performance.now() - t0;
	const t1 = performance.now(); compile(off(pokeFixed(tz))); ms += t - (performance.now() - t1);
	const tips = r.out.frames.map(fr => fr.s.P[TIP][2]), tip = Math.max(...tips);
	expect(`poke z ${tz}: ${personCount(before)} PERSON before, none after fix.person (${r.out.fixed.person?.passes} passes)`, personCount(before) > 0 && personCount(r) === 0,
		JSON.stringify(r.qa.groups.filter(g => g.kind === "PERSON").map(g => [g.subject, g.count, g.worst])));
	expect(`poke z ${tz}: the fingertip stays on A's side of her (max z ${tip.toFixed(3)}, f40 ${tips[40].toFixed(3)} < 2.0)`, tip < 2.0, tip);
	expect(`poke z ${tz}: the same spec bakes the same take twice`, hash(r) === hash(compile(pokeFixed(tz))));
}
console.log(`fix.person time over the five 80-frame pokes: ${ms.toFixed(0)} ms (${(ms / 5).toFixed(0)} ms each, compile with it minus without)`);

// 4. a hug meant to touch: with checks.allow for the parts that touch, fix.person leaves the hands where they are
const hands = { hand_l: [0.12, 1.32, 2.14], hand_r: [-0.12, 1.32, 2.14], elbow_l: [1, -0.3, 0.3], elbow_r: [-1, -0.3, 0.3] };
const hug = { ...spec0, frames: 90, use: [stand(1.62)], keys: [
	{ f: 0, set: { armw_l: 0, armw_r: 0 } },
	{ f: 20, set: { armw_l: 1, armw_r: 1, hand_l: [0.3, 1.3, 1.9], hand_r: [-0.3, 1.3, 1.9], elbow_l: [1, -0.3, 0.5], elbow_r: [-1, -0.3, 0.5] } },
	{ f: 30, set: hands }, { f: 70, set: hands }, { f: 82, set: { hand_l: [0.3, 1.3, 1.9], hand_r: [-0.3, 1.3, 1.9] } }] };
const raw = compile(off(hug)), parts = [...new Set(raw.qa.groups.filter(g => g.kind === "PERSON").map(g => /^(\S+) x/.exec(g.subject)[1]))];
const meant = { ...hug, checks: { allow: parts.map(part => ({ part, object: "person:char-b", depth: 0.2 })) } };
const hugged = compile(meant);
expect(`a hug without allow is PERSON (${parts.join(", ")}) and fix.person moves it`, parts.some(p => /^hand_/.test(p)) && hugged && hash(compile(hug)) !== hash(raw));
expect("with checks.allow person:char-b (depth 0.2) fix.person leaves the hands alone: the take is the one without the fix", hash(hugged) === hash(compile(off(meant))) && !hugged.out.fixed.person,
	JSON.stringify(hugged.out.fixed.person));

// 5. no people, or no contact: the take is the one of before (pinned from the tree before fix.person, upstream 3.1.6)
const PINS = { pokeAlone: "ed92acb11cd0b503", noContact: "c61eaa7747c7bd73", shoulder: "d2859d1c6ef6223d" };
const alone = compile(poke(1.93), empty), apart = compile(poke(1.62));
const onShoulder = { ...spec0, frames: 90, use: [stand(1.52), { skill: "reachGrip", f0: 10, args: { anchor: "shoulder", side: "r", define: { kind: "person", person: "char-b", bone: "LeftArm" }, hold: 30 } }] };
const shoulder = compile(onShoulder);
for (const [name, r] of [["pokeAlone", alone], ["noContact", apart], ["shoulder", shoulder]])
	expect(`${name}: no fix.person report and the take of before (${hash(r)})`, !r.out.fixed.person && hash(r) === PINS[name], JSON.stringify({ fixed: r.out.fixed.person, hash: hash(r) }));

// 6. an FK arm (armw 0) cannot be pushed: counted as skipped, its PERSON stays
const walk = { ...spec0, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 1, args: { to: [0, 4], arrive: 110 } }] };
const through = compile(walk), fk = through.out.fixed.person;
expect(`walking through her with FK arms: fixed.person.skipped ${fk?.skipped}, the arms' PERSON stays, the take unchanged`,
	fk?.skipped > 0 && fk.frames === 0 && through.qa.groups.some(g => g.kind === "PERSON" && /^(hand|farm)_/.test(g.subject)) && hash(through) === hash(compile(off(walk))), JSON.stringify(fk));

// 7. the saved source compiles the same take again without her take: the body fix.person pushed out of rides with it
// (people.js keptPeople); a take fix.person did not move saves the source of before (pinned from the tree before this)
const job = (spec, sc = scene) => runCompileJob({ model: "y-bot-tpose", scene: sc, spec, bake: { position: [0, 0, 0], yaw: 0 } });
const saved = r => JSON.stringify(takeSource(r.take, [])), sha = s => createHash("sha256").update(s).digest("hex").slice(0, 16);
const pushed = job(poke(1.93)), source = JSON.parse(saved(pushed)), again = compileTakeSource(source);
expect(`poke z 1.93 (fixed.person.frames ${pushed.fixed.person?.frames}): the saved source (${Object.keys(source.scene.people ?? {}).join(", ")}) compiles the same take`,
	pushed.fixed.person?.frames > 0 && takeHash(again) === takeHash(pushed.take), `${takeHash(pushed.take)} -> ${takeHash(again)}`);
const SOURCES = { pokeAlone: [570, "8006d3ff95ae8a05"], noContact: [570, "ce488561492cac9e"], shoulder: [3469, "6aaa0de2a92a813c"] };
for (const [name, r] of [["pokeAlone", job(poke(1.93), empty)], ["noContact", job(poke(1.62))], ["shoulder", job(onShoulder)]]) {
	const s = saved(r);
	expect(`${name}: the saved source of before (${s.length} bytes, ${sha(s)})`, s.length === SOURCES[name][0] && sha(s) === SOURCES[name][1], JSON.stringify([s.length, sha(s)]));
}

let refusal = "";
try { compile({ ...poke(1.8), fix: { person: 1 } }); } catch (error) { refusal = error.message; }
expect("fix.person takes a boolean only", /fix\.person must be true/.test(refusal), refusal);

if (failures) { console.error(`motion3 person fix: ${failures} failed`); process.exit(1); }
console.log("motion3 person fix: all checks passed");
