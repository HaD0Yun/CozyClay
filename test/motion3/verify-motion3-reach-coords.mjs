#!/usr/bin/env node
// fix/reach-body.js (iteration E, deep research 8): a hand plant keyed as hand_r world coordinates with armw 1 that the
// arm cannot reach (0.85 m from the shoulder, the arm ~0.6 m) brings the body to it like an anchor plant does: the hips
// and the lean move and the hand ends where the anchor plant's does (8 cm: the lean, shift and drop caps), from 0.25+ m.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), len = a => Math.hypot(...a), scale = (a, s) => a.map(v => v * s);
const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]), F = 30;
const stand = keys => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }], ...(keys ? { keys } : {}) });
const probe = compileSpec(stand(), { sk, scene });
// a vault plant: ahead and down at 45 deg (a wall top near hip height)
const shoulder = probe.out.frames[F].s.P[sk.index.RightArm], dir = [0, -1, 1].map(v => v / Math.SQRT2);
const point = add(shoulder, scale(dir, 0.85)).map(v => Math.round(v * 1000) / 1000);
const plant = () => stand([{ f: 10, set: { armw_r: 0 } }, { f: 24, set: { armw_r: 1, hand_r: point } }, { f: 36, set: { armw_r: 1, hand_r: point } }, { f: 50, set: { armw_r: 0 } }]);
const on = compileSpec(plant(), { sk, scene }), off = compileSpec({ ...plant(), fix: { reach: false } }, { sk, scene });
const miss = r => len(sub(r.out.frames[F].s.P[sk.index.RightHand], point)), hips = r => r.out.frames[F].s.P[sk.index.Hips];
expect("the plant is 0.85 m from the shoulder", Math.abs(len(sub(point, shoulder)) - 0.85) < 0.01, `${len(sub(point, shoulder))}`);
expect("without fix.reach the hand stays short (> 0.15 m)", miss(off) > 0.15, `${miss(off)}`);
expect("with it the body comes: fixed.reachBody, the hips moved", Boolean(on.fixed?.reachBody) && len(sub(hips(on), hips(off))) > 0.02, JSON.stringify(on.fixed?.reachBody ?? null));
expect("the hand ends within 9 cm (the anchor plant's reach under the same caps)", miss(on) <= 0.09, `${miss(on)}`);
const anchored = compileSpec({ ...plant(), anchors: { wall: { kind: "world", p: point } }, keys: [{ f: 10, set: { armw_r: 0, w_wall_r: 0 } }, { f: 24, set: { armw_r: 1, w_wall_r: 1 } }, { f: 36, set: { armw_r: 1, w_wall_r: 1 } }, { f: 50, set: { armw_r: 0, w_wall_r: 0 } }] }, { sk, scene });
expect("about as close as the same plant on an anchor (within 1 cm)", Math.abs(miss(on) - len(sub(anchored.out.frames[F].s.P[sk.index.RightHand], point))) < 0.01, `${miss(on)} vs ${len(sub(anchored.out.frames[F].s.P[sk.index.RightHand], point))}`);

if (failures) { console.error(`${failures} reach-coords check(s) failed`); process.exit(1); }
console.log("verify-motion3-reach-coords: all checks passed");
