#!/usr/bin/env node
// What the agent may leave to the compiler (#1078): tempo hints and @names (auto-spec.js, #1082), frames left out, root
// [x, z] (#1079), set.look (compiler/auto.js, #1081), knee poles and foot headings where nothing keys them (#1080), the
// authored count (#1083); and a spec that keys every such channel compiles exactly as before.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { autoSpec, authoredOf } from "../../src/motion3/auto-spec.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const sk = skeletonFor("x-bot-tpose"), I = sk.index;
const scene = { objects: { box: { pos: [0, 0.3, 1.4], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.25, 0.3, 0.25] } } };
const base = { schema: "cozyclay.motion-spec.v1", fps: 24, label: "auto" };
const feet = (z, x = 0.1) => ({ foot_l: [x, 0.087, z], foot_r: [-x, 0.087, z] });

// tempo and names
const timed = autoSpec({ ...base, objects: { box: { keys: [{ f: "@a", pos: [0, 0.3, 1.4] }, { f: "@b+2", pos: [0, 0.3, 1.5] }] } },
	keys: [{ f: 0, set: { root: [0, 0], ...feet(0) } }, { after: "normal", name: "a", set: { root: [0, 0.9] } }, { after: "slow", name: "b", set: { root: [0, 1.8] } }, { after: 6, set: { yaw: 30 } }] }, sk);
const fs = timed.keys.map(k => k.f);
expect("frames left out is auto", timed.frames === "auto", JSON.stringify(timed.frames));
expect("after: normal places a 0.9 m root move about 1 s later (24 frames)", fs[1] === 24, JSON.stringify(fs));
expect("after: slow takes 1.6x as long", fs[2] - fs[1] === Math.round(1.6 * 24), JSON.stringify(fs));
expect("after: <frames> is that gap", fs[3] - fs[2] === 6, JSON.stringify(fs));
expect("@name and @name+2 read the keys' frames", JSON.stringify(timed.objects.box.keys.map(k => k.f)) === JSON.stringify([fs[1], fs[2] + 2]), JSON.stringify(timed.objects.box.keys));
expect("root [x, z] gets the standing hips height", timed.keys[1].set.root.length === 3 && Math.abs(timed.keys[1].set.root[1] - sk.restWorldPos[I.Hips][1]) < 1e-9, JSON.stringify(timed.keys[1].set.root));
expect("no after or name is left in the keys", timed.keys.every(k => !("after" in k) && !("name" in k)));
const plain = { ...base, frames: 30, keys: [{ f: 0, set: { root: [0, 1, 0] } }] };
expect("a spec that uses none of it comes back as the same object", autoSpec(plain, sk) === plain);
expect("authoredOf counts keys, values and families", JSON.stringify(authoredOf({ keys: [{ f: 0, set: { root: [0, 0], foot_l: [0, 0, 0], w_box_l: 1 } }, { f: 4, set: { foot_r: [0, 0, 0] } }] }))
	=== JSON.stringify({ keys: 2, values: 4, byChannel: { root: 1, foot: 2, "w_<anchor>": 1 } }));

// look: the head turns to the box and follows it down
const look = compileSpec({ ...base, keys: [{ f: 0, set: { root: [0, 0], ...feet(0), look: "object:box" } }, { f: 20, set: { root: [0, 0] } }, { f: 40, set: { look: null } }, { f: 60, set: { root: [0, 0] } }] }, { sk, scene });
const pitchAt = f => look.out.baked.head_pitch[f];
expect("look: the head pitches down toward a box on the floor ahead (> 25 deg)", pitchAt(10) > 25, `${pitchAt(10)}`);
expect("look: null hands the head back (eased to its keyed 0 within 8 frames)", Math.abs(pitchAt(look.out.frameCount - 1)) < 1, `${pitchAt(look.out.frameCount - 1)}`);
expect("look moves to spec.look in the stored spec", Array.isArray(look.spec.look) && look.spec.look[0].at === "object:box", JSON.stringify(look.spec.look));

// a turn on planted feet, then a step: the knee follows the foot, the planted foot keeps its heading
const turn = { ...base, keys: [{ f: 0, set: { root: [0, 0], ...feet(0), yaw: 0 } }, { f: 24, set: { yaw: 40 } }, { f: 30, set: { foot_l: [0.1, 0.087, 0] } },
	{ f: 36, set: { foot_l: [0.2, 0.15, 0.15] } }, { f: 42, set: { foot_l: [0.3, 0.087, 0.3] } }, { f: 60, set: { root: [0.1, 0.15] } }] };
const on = compileSpec(turn, { sk, scene }), off = compileSpec({ ...turn, auto: false }, { sk, scene });
expect("auto: the planted left foot keeps heading 0 while the body turns", Math.abs(on.out.baked.fyaw_l[24]) < 1e-6, `${on.out.baked.fyaw_l[24]}`);
expect("auto: after its step the left foot faces the body's heading", Math.abs(on.out.baked.fyaw_l[50] - 40) < 1, `${on.out.baked.fyaw_l[50]}`);
expect("auto: the planted right knee pole turns with its foot against the body (-40 deg)", Math.abs(Math.atan2(on.out.baked.knee_r[24][0], on.out.baked.knee_r[24][2]) * 180 / Math.PI + 40) < 1, JSON.stringify(on.out.baked.knee_r[24]));
expect("auto: false leaves the channels to the fixes (no knee pole made, nothing reported)", off.out.baked.knee_r === undefined && off.out.auto === null, JSON.stringify({ knee: off.out.baked.knee_r?.[24], auto: off.out.auto }));

// a spec that keys every channel the rules fill compiles the same with them on and off
const keyed = { ...turn, keys: turn.keys.map((k, i) => (i ? k : { ...k, set: { ...k.set, knee_l: [0, 0, 1], knee_r: [0, 0, 1], fyaw_l: 0, fyaw_r: 0, aswing_l: 0, aswing_r: 0, abend_l: 0, abend_r: 0 } })) };
const hash = r => JSON.stringify(r.out.frames.map(fr => fr.s.P.map(p => p.map(v => Math.round(v * 1e5)))));
expect("a fully keyed spec: the same take with auto on and off", hash(compileSpec(keyed, { sk, scene })) === hash(compileSpec({ ...keyed, auto: false }, { sk, scene })));

if (failures) { console.error(`${failures} auto check(s) failed`); process.exit(1); }
console.log("verify-motion3-auto: all checks passed");
