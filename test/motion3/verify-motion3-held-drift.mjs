#!/usr/bin/env node
// HELD_OBJECT_DRIFT (qa/held-drift.js): a box keyed to move while the hand on its anchor
// fades off it is flagged once, with a hint; the same box with the arm kept on it is not; and a throw that lets go by
// fading the anchor while the box flies on is not (the let-go exemption), though the same flight with the weight held is.
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const scene = motionScene([{ id: "cube", name: "box-1", renderer: "cube", x: -0.2, y: 0.9, z: 0.35, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.2, scaleY: 0.2, scaleZ: 0.2, footprint: { width: 1, depth: 1 }, height: 1 }]);
// the right hand on the box from f0; the box moves 0.15 m (the hand follows it) or 1.2 m forward from f20 to f40
const spec = ({ to = 1.5, armOff = false, fade = false } = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }],
	anchors: { boxR: { kind: "object", object: "cube", local: [0, 0.1, -0.1] } },
	objects: { cube: { keys: [{ f: 0, pos: [-0.2, 0.9, 0.35] }, { f: 20, pos: [-0.2, 0.9, 0.35] }, { f: 40, pos: [-0.2, 0.95, to] }] } },
	keys: [{ f: 0, set: { armw_r: 1, w_boxR_r: 1 } }, { f: 20, set: { armw_r: 1, w_boxR_r: 1 } },
		...(armOff ? [{ f: 26, set: { armw_r: 0 } }] : []), ...(fade ? [{ f: 21, set: { armw_r: 1, w_boxR_r: 1 } }, { f: 26, set: { armw_r: 0, w_boxR_r: 0 } }] : [])] });
const qa = s => runCompileJob({ model: "x-bot-tpose", scene, spec: s, thin: false }).qa;
const drift = q => q.groups.filter(g => g.kind === "HELD_OBJECT_DRIFT");

const floats = drift(qa(spec({ armOff: true })));
expect("a box keyed away while the arm fades off its anchor: one HELD_OBJECT_DRIFT group", floats.length === 1 && floats[0].worst > 0.25, JSON.stringify(floats));
expect("its hint says the box left the hand and to keep the anchor weight and armw_r on it, or carry it", /cube left the hand/.test(floats[0]?.hint ?? "") && /w_boxR_r and armw_r at 1/.test(floats[0]?.hint ?? "") && /carry cube/.test(floats[0]?.hint ?? ""), floats[0]?.hint);
const follows = drift(qa(spec({ to: 0.5 })));
expect("a box moved 0.15 m with the arm kept on its anchor: no HELD_OBJECT_DRIFT", follows.length === 0, JSON.stringify(follows));
const thrown = drift(qa(spec({ fade: true })));
expect("a throw: the anchor fades 1 -> 0 over f21-f26 while the box flies on: no HELD_OBJECT_DRIFT (let-go exemption)", thrown.length === 0, JSON.stringify(thrown));
const held = drift(qa(spec()));
expect("the same flight with the anchor weight held: flagged (the exemption is the let-go, not the flight)", held.length === 1, JSON.stringify(held));
if (failures) { console.error(`${failures} held-drift check(s) failed`); process.exit(1); }
console.log("verify-motion3-held-drift: all checks passed");
