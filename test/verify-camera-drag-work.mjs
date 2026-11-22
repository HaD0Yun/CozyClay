#!/usr/bin/env node
// The work a camera drag does per pointer move, counted (no clock). A drag of the camera (rotate or move gizmo, a
// right-drag in Look through) runs one shot.captureCamera bus update per pointer move, and each one used to write out
// the whole document as JSON four or five times in the Studio binding (several MB with takes installed) and to rebuild
// every shot's camera with the subjects' posed bodies at each frame (lag-measure, 2026-11-22). Pinned here:
// - contentKey is equal exactly when JSON.stringify is, and keys an unchanged value once, however often it is asked;
// - the binding's refresh reads an unchanged document value once over many refreshes, and still moves the scene
//   revision on a real change and not on an equal copy;
// - a rail head turned 30 times rebuilds no camera samples (no posed body is read again), and every build equals
//   one made from nothing, frame by frame; a change of anything else rebuilds that shot only.
import assert from "node:assert/strict";
import { contentKey, sameData } from "../src/content-key.js";
import { createStudioAppBinding } from "../src/studio-app-binding.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";

// contentKey against JSON.stringify
const values = [null, 0, -0, 1, NaN, Infinity, "a", "1", "", [1], ["1"], [], [[]], [{}], [null], [undefined], [() => 1], { a: 1 }, { a: "1" },
	{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: undefined }, {}, { a: [1, 2] }, { a: [2, 1] }, "x".repeat(5000), "x".repeat(5001), `${"x".repeat(4999)}y`,
	new Float32Array([1, 2]), { t: new Float32Array([1, 2]) }, { t: new Float32Array([1, 3]) }, { d: new Date(0) }, true, false, "true", { f() {} },
	Object.assign(Object.create(null), { a: 1 }), { a: { b: { c: [1, { d: "e" }] } } }, { a: { b: { c: [1, { d: "f" }] } } }];
for (const a of values) for (const b of values) {
	assert.equal(contentKey(a) === contentKey(b), JSON.stringify(a) === JSON.stringify(b), `contentKey of ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
}
let reads = 0;
const counted = () => ({ get spec() { reads++; return { frames: 120, raw: "q".repeat(9000) }; } });
const heavy = counted(), wrapped = () => ({ stage: { characters: [{ id: "c1", motionTake: heavy }] } });
const first = contentKey(wrapped());
for (let i = 0; i < 30; i++) assert.equal(contentKey(wrapped()), first, "a new wrapper around the same value keys the same");
assert.equal(reads, 1, `an unchanged value is keyed once (${reads} reads)`);
assert.ok(sameData({ a: [1, { b: undefined }] }, { a: [1, { b: undefined }] }) && !sameData({ a: NaN }, { a: null }) && !sameData({ a: 1 }, { a: 1, b: 2 }), "sameData");

// the binding's refresh, as the bus calls it before and after every command
reads = 0;
const host = { workspaceId: crypto.randomUUID(), documentEpoch: crypto.randomUUID(), sceneId: "scene-a", sceneEpoch: crypto.randomUUID() };
const shot = (camera) => ({ id: "s1", name: "S", startFrame: 0, endFrame: 47, cameraKeys: [], camera });
let shots = [shot({ mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }] })];
const stage = { shotAspect: "16:9", characters: [{ id: "c1", motionTake: counted() }] };
const read = () => ({ host, characters: [{ id: "c1", x: 0, z: 0, rot: 0 }], objects: [], shots, frameCount: 48, stage, targets: new Map(),
	selection: null, view: { frame: 0 }, camera: null });
const ports = { revision: { current: 0 }, isRetained: () => false, ikRevision: () => 0, read, storeDomains: () => [] };
const binding = createStudioAppBinding(ports);
const start = binding.refresh();
for (let i = 0; i < 30; i++) binding.refresh();
assert.equal(reads, 1, `30 refreshes of an unchanged document read its take once (${reads} reads)`);
assert.equal(binding.refresh().revision, start.revision, "nothing changed: the scene revision holds");
shots = [shot({ mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }] })];
assert.equal(binding.refresh().revision, start.revision, "an equal copy of the shots is no change");
shots = [shot({ mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], head: { yawDeg: 3, pitchDeg: 0 } })];
const turned = binding.refresh();
assert.equal(turned.revision, start.revision + 1, "a hand turn moves the scene revision");
assert.equal(turned.domainRevisions.shot, start.domainRevisions.shot + 1, "and the shot domain's");
assert.equal(turned.domainRevisions.stage, start.domainRevisions.stage, "and not the stage's");
assert.equal(reads, 1, "the unchanged take is still not read again");

// camera tracks: a head-only edit reuses the built samples
const long = Array.from({ length: 96 }, (_, f) => ({ x: -1 + f / 48, y: 0, z: 0 }));
let bodies = 0;
const bodyAt = (frame) => { bodies++; return [[long[frame].x, 0, 0], [long[frame].x, 1.7, 0]]; };
const rail = { mode: "rail", cameraRail: [{ x: -3, z: 4 }, { x: 0, z: 5 }, { x: 3, z: 4 }], railFollow: { mode: "range", startFrame: 0, endFrame: 47 } };
const follow = { id: "f1", name: "F", startFrame: 48, endFrame: 95, cameraKeys: [], camera: { mode: "follow" } };
const build = (list, reuse) => buildShotCameraTracks({ shots: list, subjectTrack: long, fps: 24, bodyAt, filmback: { aspectRatio: 16 / 9 }, fovDeg: 45, reuse });
const reuse = new Map(), listOf = (camera) => [{ id: "r1", name: "R", startFrame: 0, endFrame: 47, cameraKeys: [], camera }, follow];
build(listOf(rail), reuse);
const firstBodies = bodies;
assert.ok(firstBodies >= 96, `the first build frames both shots' bodies (${firstBodies})`);
for (let move = 1; move <= 30; move++) {
	const list = listOf({ ...rail, head: { yawDeg: move * 0.7, pitchDeg: -move * 0.2 } });
	bodies = 0;
	const kept = build(list, reuse);
	assert.equal(bodies, 0, `turn ${move}: no posed body is read again`);
	assert.deepEqual(kept, build(list, null), `turn ${move}: the reused build equals a build from nothing`);
}
bodies = 0;
const moved = listOf({ ...rail, head: { yawDeg: 5, pitchDeg: 0 }, followCam: { distance: 4.6 } });
assert.deepEqual(build(moved, reuse), build(moved, null), "a follow framing change builds what a build from nothing does");
bodies = 0;
build(listOf({ ...rail, head: { yawDeg: 5, pitchDeg: 0 }, followCam: { distance: 4.7 } }), reuse);
assert.ok(bodies > 0 && bodies <= 48, `a change of the rail shot reframes that shot only (${bodies} bodies)`);
const off = listOf({ ...rail, head: { follow: false, yawDeg: 5, pitchDeg: 0 } });
assert.deepEqual(build(off, reuse), build(off, null), "turning follow off is a rebuild, equal to one from nothing");
console.log(`PASS camera drag work: contentKey equals JSON equality and keys an unchanged value once; 30 binding refreshes read the document once; 30 head turns rebuild no camera samples (first build ${firstBodies} bodies), each equal to a fresh build`);
