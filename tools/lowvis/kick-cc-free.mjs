#!/usr/bin/env node
// Builds the "kick" clip (src/lowvis/kick-cc-free.js) with engine-simple, validates it, runs the engine's checks,
// measures the four conditions of the request from the written clip and writes public/lowvis/clips/cc-free/kick.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { checkClip } from "../../src/lowvis/engine-simple/checks.js";
import { KICK, scene, spec } from "../../src/lowvis/kick-cc-free.js";

const outDir = new URL("../../public/lowvis/clips/cc-free/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const mm = v => (v * 1000).toFixed(1);

const t0 = performance.now(), { clip, aux } = buildClip(spec, scene);
clip.stats.buildMs = Math.round((performance.now() - t0) * 100) / 100;
const parsed = JSON.parse(serializeClip(clip)), valid = validateClip(parsed), c = checkClip(parsed, aux), k = c.launches[0];

// the support (left) foot while the right leg kicks: from the end of the run-up to the start of the next step
const planted = f => aux.contacts.a[f][0], ankle = f => parsed.characters[0].pos.slice((f * JOINT_COUNT + J.LeftFoot) * 3, (f * JOINT_COUNT + J.LeftFoot) * 3 + 3);
const from = 96, to = 141;
let drift = 0, onFloor = true;
for (let f = from; f <= to; f++) { drift = Math.max(drift, Math.hypot(...ankle(f).map((v, i) => v - ankle(from)[i]))); onFloor &&= planted(f); }
const ball = parsed.props.find(p => p.id === "ball"), goal = parsed.props.find(p => p.id === "goal");
let maxZ = -Infinity;
for (let f = 0; f < parsed.frameCount; f++) maxZ = Math.max(maxZ, ball.pos[f * 3 + 2]);

Object.assign(clip.stats, { stretch: valid.stretch, plantedFootSlide: c.slide, footLow: c.footLow, headTurn: c.headTurn, elbowSpeed: c.elbow, wristSpeed: c.wrist, freeTravel: c.freeTravel, launches: c.launches, supportFoot: { from, to, drift, onFloor } });
writeFileSync(new URL("kick.json", outDir), serializeClip(clip));

console.log(`kick: ${clip.frameCount} frames, built in ${clip.stats.buildMs} ms, ${(serializeClip(clip).length / 1024).toFixed(0)} KB, valid ${valid.ok ? "ok" : "FAIL"}, stretch ${mm(valid.stretch)} mm`);
console.log(`  checks: planted-foot slide ${mm(c.slide)} mm (step ${mm(c.slideStep)}), foot low ${mm(c.footLow)} mm, joint low ${mm(c.jointLow)} mm, head ${c.headTurn.toFixed(1)} deg/frame, elbow ${(c.elbow * 100).toFixed(1)}, wrist ${(c.wrist * 100).toFixed(1)} cm/frame, free prop travel ${mm(c.freeTravel)} mm`);
console.log(`  1 ball before the kick: moved ${mm(k.before)} mm in frames 0..${k.f}; leaves at ${(k.speed * 24).toFixed(2)} m/s on frame ${k.f + 1}`);
console.log(`  2 on frame ${k.f} the ${k.touch.foot} foot of ${k.touch.who} is ${mm(k.touch.dist)} mm from the ball surface (0 = touching, negative = inside)`);
console.log(`  3 support (left) foot in frames ${from}..${to}: ankle drift ${mm(drift)} mm, on the floor in every frame: ${onFloor}`);
console.log(`  4 ball bottom ${mm(k.low)}..${mm(k.high)} mm over the floor; nearest to the goal ${mm(k.wall)} mm (negative = inside); ball centre z max ${maxZ.toFixed(3)} m, goal front face z ${(goal.pos[2] - goal.size[2] / 2).toFixed(3)} m`);
console.log(`  ball stops on frame ${k.stop} at [${k.rest.map(v => v.toFixed(2)).join(", ")}]`);
const ok = valid.ok && clip.frameCount === 240 && k.before === 0 && Math.abs(k.touch.dist) < 0.01 && drift < 0.001 && onFloor && c.slide < 0.001 && k.low > -1e-4 && k.wall > -1e-3 && maxZ < goal.pos[2] - goal.size[2] / 2 && k.stop <= 180;
if (!valid.ok) console.error(valid.errors);
console.log(ok ? "  all conditions hold" : "  FAIL: a condition does not hold");
process.exit(ok ? 0 : 1);
