#!/usr/bin/env node
// Timing edits on a take v3 (take-edit.js, commands/motion-timing.js): cut, per-segment speed,
// remove, trim and reset, the resampled take, IK key remapping, and save/load of the edit.
import "../lowvis/block-figure.mjs"; // the rig's own body: scale 1 of the block figure (figure.js: the launch names the look)
import { createStudioAppActions } from "../../src/commands/index.js";
import { createTakeEdit, isIdentityEdit, remapFrameKeys, removeSegment, renderTakeEdit, segmentSpeedForFrames, setSegmentSpeed, sourceToTimeline, splitTakeEdit,
	takeEditDuration, takeEditLayout, timelineToSource, trimTakeEdit } from "../../src/motion3/take-edit.js";
import { compileTakeSource, normalizeTakeSource, savedTakeSource } from "../../src/domains/motion/take-source.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { carryEdit } from "../../src/motion3/edit-carry.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

// --- the edit model -------------------------------------------------------------------------
const base = createTakeEdit(240);
expect("a fresh edit is one 1x segment over the whole take", takeEditDuration(base) === 240 && isIdentityEdit(base, 240));
const cut = splitTakeEdit(base, 100);
expect("a cut makes two segments meeting at the cut", cut.length === 2 && cut[0].sourceEnd === 99 && cut[1].sourceStart === 100 && takeEditDuration(cut) === 240);
expect("a cut at frame 0 or on a segment start changes nothing", splitTakeEdit(base, 0) === base && splitTakeEdit(cut, 100) === cut);
const slow = setSegmentSpeed(cut, cut[1].id, 0.5);
expect("half speed doubles the segment on the timeline", takeEditDuration(slow) === 100 + 280, String(takeEditDuration(slow)));
const layout = takeEditLayout(slow);
expect("the layout places the slow segment after the first", layout[1].timelineStart === 100 && layout[1].timelineEnd === 379);
expect("timeline -> source runs at half rate inside the slow segment", near(timelineToSource(slow, 100), 100) && near(timelineToSource(slow, 379), 239) && near(timelineToSource(slow, 239.5), 100 + 139.5 * 139 / 279));
expect("source -> timeline inverts it", sourceToTimeline(slow, 239) === 379 && sourceToTimeline(slow, 50) === 50);
const fast = setSegmentSpeed(cut, cut[0].id, 2);
expect("double speed halves the segment", takeEditDuration(fast) === 50 + 140);
let threw = false;
try { setSegmentSpeed(cut, cut[0].id, 9); } catch { threw = true; }
expect("a speed past 4x is refused", threw);
expect("the stretch grip speed is the source frames over the dragged width", segmentSpeedForFrames(cut[1], 280) === 0.5 && segmentSpeedForFrames(cut[1], 10) === 4);
const removed = removeSegment(cut, cut[0].id);
expect("removing a segment closes the gap", removed.length === 1 && takeEditDuration(removed) === 140 && timelineToSource(removed, 0) === 100);
expect("the last segment is never removed", removeSegment(removed, removed[0].id) === removed);
const trimmed = trimTakeEdit(slow, 20, 299);
expect("a trim keeps the edited frames start..end", takeEditDuration(trimmed) === 100 - 20 + Math.round((Math.floor(timelineToSource(slow, 299)) - 100 + 1) / 0.5) && trimmed[0].sourceStart === 20, JSON.stringify(trimmed));
const keys = remapFrameKeys([{ frame: 10, tracks: { a: 1 } }, { frame: 150, tracks: { b: 1 } }, { frame: 230, tracks: { c: 1 } }], cut, slow);
expect("IK keys keep their poses through a speed change", keys.length === 3 && keys[0].frame === 10 && keys[1].frame === 100 + Math.round(50 / 139 * 279) && keys[2].frame === 100 + Math.round(130 / 139 * 279), JSON.stringify(keys.map(k => k.frame)));
expect("keys whose source was cut away drop out", remapFrameKeys([{ frame: 10 }, { frame: 150 }], cut, removed).map(k => k.frame).join() === "50");

// --- resampling a take ------------------------------------------------------------------------
const F = 11, axis = f => [0, Math.sin(f * 0.05), 0, Math.cos(f * 0.05)];
const synthetic = { schema: "cozyclay.take.v3", fps: 24, frameCount: F, frames: F, bones: ["Hips", "Spine"],
	rot: Float32Array.from({ length: F * 8 }, (_, i) => axis(Math.floor(i / 8))[i % 4]), hips: Float32Array.from({ length: F * 3 }, (_, i) => (i % 3 === 0 ? Math.floor(i / 3) * 0.1 : 0)),
	objects: { door: { pos: Float32Array.from({ length: F * 3 }, (_, i) => Math.floor(i / 3)), quat: Float32Array.from({ length: F * 4 }, (_, i) => axis(Math.floor(i / 4))[i % 4]),
		vis: Uint8Array.from({ length: F }, (_, f) => (f >= 5 ? 1 : 0)), lvl: Float32Array.from({ length: F }, (_, f) => f / 10) } } };
expect("no edit returns the take itself", renderTakeEdit(synthetic) === synthetic && renderTakeEdit({ ...synthetic, edit: createTakeEdit(F) }).rot === synthetic.rot);
const halfEdit = setSegmentSpeed(createTakeEdit(F), "motion-0", 0.5), half = renderTakeEdit({ ...synthetic, edit: halfEdit });
expect("half speed resamples every track to 22 frames", half.frameCount === 22 && half.frames === 22 && half.rot.length === 22 * 8 && half.hips.length === 66 && half.objects.door.pos.length === 66 && half.objects.door.vis.length === 22);
expect("the ends match the source ends", near(half.hips[0], 0) && near(half.hips[21 * 3], 1, 1e-4) && near(half.objects.door.pos[21 * 3], 10, 1e-4));
const mid = timelineToSource(halfEdit, 7);
expect("hips and object positions interpolate between source frames", near(half.hips[21], mid * 0.1, 1e-4) && near(half.objects.door.pos[21], mid, 1e-4));
expect("bone and object quaternions stay unit length on the arc", [...Array(22).keys()].every(f => near(Math.hypot(...half.rot.slice(f * 8, f * 8 + 4)), 1, 1e-4)) && near(half.rot[7 * 8 + 1], Math.sin(mid * 0.05), 1e-3));
expect("visibility steps and levels follow the source", half.objects.door.vis[0] === 0 && half.objects.door.vis[21] === 1 && near(half.objects.door.lvl[21], 1, 1e-4));
expect("a rendered take is never resampled twice", renderTakeEdit(half) === half);

const sk = skeletonFor("x-bot-tpose"), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
const source = { schema: "cozyclay.take.v3", rig: "x-bot-tpose", placement: { position: [0, 0, 0], yaw: 0 }, scene: { objects: {} },
	spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 96, keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], foot_l: [0.09, ank, 0], foot_r: [-0.09, ank, 0] } }],
		generators: [{ type: "walk", f0: 8, steps: 3, heading: [0, 0] }] } };
const compiled = compileTakeSource(source);
const walkEdit = setSegmentSpeed(splitTakeEdit(createTakeEdit(96), 40), "motion-0-b", 0.5), walk = renderTakeEdit({ ...compiled, edit: walkEdit });
expect("a compiled walk slowed after frame 40 gets 40 + 112 frames", walk.frameCount === 152, String(walk.frameCount));
const sameBones = (f, g) => Array.from(walk.rot.slice(f * walk.bones.length * 4, (f + 1) * walk.bones.length * 4)).every((v, i) => near(v, compiled.rot[g * walk.bones.length * 4 + i], 1e-6));
expect("frames before the cut and the last frame are the compiled ones", sameBones(0, 0) && sameBones(39, 39) && sameBones(151, 95));

// --- save and load ------------------------------------------------------------------------------
const saved = savedTakeSource({ source, studioTakeId: "take-1", edit: walkEdit });
const loaded = normalizeTakeSource(JSON.parse(JSON.stringify(saved)));
expect("a saved take keeps its timing edit", JSON.stringify(loaded.edit) === JSON.stringify(walkEdit) && loaded.takeId === "take-1");
expect("a broken edit is dropped on load, the take still loads", normalizeTakeSource({ ...saved, edit: [{ id: "x", sourceStart: 0, sourceEnd: 500, speed: 1 }] })?.edit === undefined);

// --- the commands through the registry ------------------------------------------------------------
const rows = new Map([["char-1", { id: "char-1", take: { resourceId: "r1", frames: 96, source }, ikKeys: [{ frame: 60, tracks: {} }] }]]);
let synced = 0, follow = null;
// replace: an install puts a new take without an edit and drops the IK keys, as the motion domain does
const owner = { layer: id => rows.get(id), writeLayer: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }), fullMotionFor: id => (rows.get(id)?.take ? compiled : null), motionFor: () => compiled,
	replace: (id, take) => rows.set(id, { id, take: { resourceId: "r2", frames: take.frames, source }, ikKeys: [] }) };
const ports = { state: () => ({ characters: [{ id: "char-1", model: "x-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 }], objects: [], frameCount: 96 }),
	storeDomain: name => (name === "motion" ? owner : name === "cast" ? { syncTimeline: shots => { synced += 1; follow = shots; } } : null) };
const registry = createStudioAppActions(ports), run = (id, args) => registry.run(id, args);
const fails = (id, args, code) => { try { run(id, args); return false; } catch (error) { return error.code === code; } };
let r = run("motion.cut", { characterId: "char-1", frame: 40 });
expect("motion.cut splits the take and answers the segments", r.output.segments.length === 2 && r.output.frames === 96 && rows.get("char-1").take.edit.length === 2 && synced === 1);
r = run("motion.setSegmentSpeed", { characterId: "char-1", segmentId: "motion-0-b", speed: 0.5 });
expect("motion.setSegmentSpeed stretches the timeline and moves IK keys with their poses", r.output.frames === 152 && rows.get("char-1").ikKeys[0].frame === 40 + 40, JSON.stringify(rows.get("char-1").ikKeys));
expect("an unknown segment and a bad cut are refused", fails("motion.setSegmentSpeed", { characterId: "char-1", segmentId: "nope", speed: 2 }, "INVALID_ARGUMENT") && fails("motion.cut", { characterId: "char-1", frame: 0 }, "INVALID_RANGE"));
r = run("motion.removeSegment", { characterId: "char-1", segmentId: "motion-0-a" });
expect("motion.removeSegment drops the first part", r.output.frames === 112 && r.output.segments.length === 1);
expect("the last segment cannot be removed", fails("motion.removeSegment", { characterId: "char-1", segmentId: "motion-0-b" }, "INVALID_ARGUMENT"));
r = run("motion.resetTiming", { characterId: "char-1" });
expect("motion.resetTiming restores the compiled timing and clears the edit", r.output.frames === 96 && rows.get("char-1").take.edit === undefined);
r = run("motion.trim", { characterId: "char-1", start: 10, end: 69 });
expect("motion.trim keeps the range", r.output.frames === 60 && rows.get("char-1").take.edit[0].sourceStart === 10);
// a shot laid over the whole take ends with it again, or it holds the timeline at the old length (timelineSpan)
const overTake = [{ id: "s1", startFrame: 0, endFrame: 40 }, { id: "s2", startFrame: 41, endFrame: 95 }];
expect("motion.trim pulls the shot that ended with the take to the take's new end", typeof follow === "function" && JSON.stringify(follow(overTake).map(s => s.endFrame)) === "[40,59]", String(follow));
run("motion.resetTiming", { characterId: "char-1" });
expect("motion.resetTiming stretches that shot back with the take", typeof follow === "function" && follow([{ id: "s1", startFrame: 0, endFrame: 59 }])[0].endFrame === 95);
run("motion.trim", { characterId: "char-1", start: 10, end: 69 });

// --- a recompile keeps the timing edit of the take it replaces (edit-carry.js) ----------------------
const edited = setSegmentSpeed(splitTakeEdit(createTakeEdit(96), 40), "motion-0-b", 0.5);
expect("the same frame count keeps the edit as it is", JSON.stringify(carryEdit(edited, 96, 96)?.edit) === JSON.stringify(edited) && /kept the timing edit/.test(carryEdit(edited, 96, 96).note));
const longer = carryEdit(edited, 96, 120)?.edit, shorter = carryEdit(edited, 96, 30);
expect("a longer take: the segment that ran to the end runs to the new end", longer?.[1].sourceEnd === 119 && longer[1].speed === 0.5 && longer[0].sourceEnd === 39, JSON.stringify(longer));
expect("a shorter take: segments past the end drop out, and an edit left as the plain take is dropped with a note", shorter?.edit === null && /dropped the timing edit/.test(shorter.note), JSON.stringify(shorter));
expect("no edit, or the plain take, carries nothing", carryEdit(undefined, 96, 96) === null && carryEdit(createTakeEdit(96), 96, 96) === null);
r = run("motion.compile", { characterId: "char-1", spec: source.spec });
expect("motion.compile installs the new take with the trim kept, and says so in the receipt", JSON.stringify(rows.get("char-1").take.edit) === JSON.stringify([{ id: "motion-0-t10", sourceStart: 10, sourceEnd: 69, speed: 1 }])
	&& /kept the timing edit .*motion\.resetTiming/.test(r.output.timing ?? ""), JSON.stringify([rows.get("char-1").take.edit, r.output.timing]));

if (failures) { console.error(`${failures} timing check(s) failed`); process.exit(1); }
console.log("all timing checks passed");
