#!/usr/bin/env node
// The work a camera drag does per pointer move, counted (no clock). A drag of the camera (rotate or move gizmo, a
// right-drag in Look through) runs one shot.captureCamera bus update per pointer move, and each one used to write out
// the whole document as JSON four or five times in the Studio binding (several MB with takes installed), to run the
// physics fingerprint's schema check each time, and to rebuild the shot subjects and every shot's camera with the
// subjects' posed bodies at each frame. Pinned here:
// - sameJson answers what JSON.stringify equality answers, and does not read a value that is the same object;
// - the binding's refresh reads an unchanged document and runs the physics check once over many refreshes, and its
//   revisions and target tokens move exactly on a real change (not on an equal copy);
// - a rail head turned by hand rebuilds no camera samples (no posed body is read again); after any other change, in
//   any order, the kept samples give what a build from nothing gives, frame by frame;
// - the hooks the app builds the cameras with keep the subjects and the samples over a head turn, under a real
//   React root, and rebuild them when a take, a character or a picked subject changes.
import assert from "node:assert/strict";
import { StrictMode, createElement, useEffect } from "react";
import { sameData, sameJson } from "../src/same-json.js";
import { createStudioAppBinding } from "../src/studio-app-binding.js";
import { buildShotCameraTracks, castAimPoint, createShotSubjectBodies, createShotSubjectSampler, shotSubjectTrack } from "../src/camera-direction.js";
import { subjectsCenter } from "../src/shot-subjects.js";
import { useShotCameraTracks, useShotSubjects } from "../src/use-shot-camera-tracks.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";
import { restState, toLocal } from "../src/motion3/compiler/skeleton.js";

let seed = 20261122;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(random() * n), pick = (list) => list[int(list.length)];

// sameJson against JSON.stringify: fixed values, then a pool of random ones (plain and not)
const fixed = [null, 0, -0, 1, NaN, Infinity, "a", "1", "", [1], ["1"], [], [[]], [{}], [null], [undefined], [() => 1], { a: 1 }, { a: "1" },
	{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: undefined }, {}, { a: [1, 2] }, { a: [2, 1] }, "x".repeat(5000), "x".repeat(5001), `${"x".repeat(4999)}y`,
	new Float32Array([1, 2]), { t: new Float32Array([1, 2]) }, { t: new Float32Array([1, 3]) }, { d: new Date(0) }, true, false, "true", { f() {} },
	Object.assign(Object.create(null), { a: 1 }), { a: { b: { c: [1, { d: "e" }] } } }, { a: { b: { c: [1, { d: "f" }] } } },
	new Date(0), "1970-01-01T00:00:00.000Z", new Uint8Array(0), new Map([[1, 2]]), new Set([1]), { 0: 1, 1: 2 }, new Number(1), new String("a"),
	{ toJSON: () => "a" }, { toJSON: () => undefined }, undefined, Symbol("s"), Object.assign(new Array(2), { 1: 1 }), [undefined, 1], [null, 1], { a: NaN }, { a: null }, { a: -0 }, { a: 0 }];
const leaves = [null, undefined, 0, -0, 1, 2, 1.5, 0.1 + 0.2, 0.3, NaN, Infinity, "", "a", "1", "null", true, false, () => 1];
const randomValue = (depth) => {
	const roll = random();
	if (depth <= 0 || roll < 0.35) return pick(leaves);
	if (roll < 0.6) return Array.from({ length: int(4) }, () => randomValue(depth - 1));
	if (roll < 0.92) return Object.fromEntries(Array.from({ length: int(4) }, () => [pick(["a", "b", "c", "0", "1"]), randomValue(depth - 1)]));
	return pick([() => new Float32Array([1, int(2)]), () => new Date(int(2)), () => new Map(), () => { const written = pick(["a", [1], undefined]); return { toJSON: () => written }; }])();
};
const pool = [...fixed, ...Array.from({ length: 500 }, () => randomValue(3))];
let equalPairs = 0;
for (const a of pool) for (const b of pool) {
	const text = JSON.stringify(a) === JSON.stringify(b);
	equalPairs += text;
	assert.equal(sameJson(a, b), text, `sameJson of ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
}
assert.ok(equalPairs > pool.length * 3, `the pool holds many equal pairs that are not one value (${equalPairs})`);
let reads = 0;
const counted = () => ({ get spec() { reads++; return { frames: 120, raw: "q".repeat(9000) }; } });
const heavy = counted(), wrapped = () => ({ stage: { characters: [{ id: "c1", motionTake: heavy }] } });
for (let i = 0; i < 30; i++) assert.ok(sameJson(wrapped(), wrapped()), "a new wrapper around the same value is the same");
assert.equal(reads, 0, `a value that is the same object is not read (${reads} reads)`);
assert.ok(sameData({ a: [1, { b: undefined }] }, { a: [1, { b: undefined }] }) && !sameData({ a: NaN }, { a: null }) && !sameData({ a: 1 }, { a: 1, b: 2 })
	&& !sameData({ a: 0 }, { a: -0 }) && !sameData({ a: undefined }, {}) && !sameData(new Map([[1, 2]]), new Map([[3, 4]])) && !sameData({ d: new Date(0) }, { d: new Date(5) }), "sameData");

// the binding's refresh, as the bus calls it before and after every command
reads = 0;
let physicsChecks = 0;
const host = { workspaceId: crypto.randomUUID(), documentEpoch: crypto.randomUUID(), sceneId: "scene-a", sceneEpoch: crypto.randomUUID() };
const shot = (camera) => ({ id: "s1", name: "S", startFrame: 0, endFrame: 47, cameraKeys: [], camera });
const railOf = (extra = {}) => ({ mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], ...extra });
// the schema check reads the footprint's width; nothing else does (the rows are compared as the objects they are)
const footprint = { get width() { physicsChecks++; return 1; }, depth: 1 };
const box = (x) => ({ id: "o1", name: "Box", renderer: "box", x, y: 0, z: 0, rot: 0, scaleX: 1, scaleY: 1, scaleZ: 1, footprint, height: 1 });
let shots = [shot(railOf())], objects = [box(0)], characters = [{ id: "c1", name: "A", x: 0, z: 0, rot: 0 }];
const stage = { shotAspect: "16:9", characters: [{ id: "c1", motionTake: counted() }] };
const read = () => ({ host, characters, objects, shots, frameCount: 48, stage, targets: new Map(), selection: null, view: { frame: 0 }, camera: null, activeCharacterId: "c1" });
const binding = createStudioAppBinding({ revision: { current: 0 }, isRetained: () => false, ikRevision: () => 0, read, storeDomains: () => [{ document: () => ({ motion: stage.characters }) }] });
const start = binding.refresh(), firstChecks = physicsChecks, tokenOf = (id) => binding.guard(id).token, tokens = { s1: tokenOf("s1"), o1: tokenOf("o1"), c1: tokenOf("c1") };
for (let i = 0; i < 30; i++) binding.refresh();
assert.equal(reads, 0, `30 refreshes of an unchanged document do not read its take (${reads} reads)`);
assert.ok(firstChecks > 0 && physicsChecks === firstChecks, `30 refreshes of unchanged physics run the fingerprint's schema check once (${firstChecks} reads, then ${physicsChecks})`);
assert.equal(binding.refresh().revision, start.revision, "nothing changed: the scene revision holds");
shots = [shot(railOf())]; objects = [box(0)]; characters = structuredClone(characters);
const copied = binding.refresh();
assert.deepEqual([copied.revision, copied.physicsRevision, copied.domainRevisions], [start.revision, start.physicsRevision, start.domainRevisions], "an equal copy of the rows is no change");
assert.deepEqual({ s1: tokenOf("s1"), o1: tokenOf("o1"), c1: tokenOf("c1") }, tokens, "and keeps every target token");
shots = [shot(railOf({ head: { yawDeg: 3, pitchDeg: 0 } }))];
const turned = binding.refresh();
assert.equal(turned.revision, start.revision + 1, "a hand turn moves the scene revision");
assert.equal(turned.domainRevisions.shot, start.domainRevisions.shot + 1, "and the shot domain's");
assert.deepEqual([turned.domainRevisions.stage, turned.domainRevisions.objects, turned.domainRevisions.motion, turned.physicsRevision],
	[start.domainRevisions.stage, start.domainRevisions.objects, start.domainRevisions.motion, start.physicsRevision], "and not the stage's, the objects', the takes' or the physics");
assert.ok(tokenOf("s1") !== tokens.s1 && tokenOf("o1") === tokens.o1 && tokenOf("c1") === tokens.c1, "the turned shot gets a new token, the other targets keep theirs");
assert.equal(physicsChecks, firstChecks, "a hand turn does not run the physics check");
objects = [box(1)];
const moved = binding.refresh();
assert.ok(physicsChecks > firstChecks && moved.physicsRevision === start.physicsRevision + 1 && moved.domainRevisions.objects === start.domainRevisions.objects + 1 && tokenOf("o1") !== tokens.o1,
	"a moved object runs the physics check, moves the physics and the objects revisions and its token");
const movedToken = tokenOf("o1");
objects = [{ ...box(1), name: "Crate" }];
const named = binding.refresh();
assert.ok(named.revision === moved.revision + 1 && tokenOf("o1") === movedToken && named.physicsRevision === moved.physicsRevision, "a new name moves the scene revision, not the object's token or the physics");
const beforePose = tokenOf("c1");
binding.invalidate("pose", 1, 2);
assert.notEqual(tokenOf("c1"), beforePose, "a pose edit still takes the character's token back");
assert.equal(tokenOf("c1"), tokenOf("c1"), "and the new token then holds");
assert.equal(reads, 0, "the unchanged take is still not read");

// camera tracks: a head-only edit reuses the built samples
const long = Array.from({ length: 96 }, (_, f) => ({ x: -1 + f / 48, y: 0, z: 0 }));
let bodies = 0;
const bodyAt = (frame) => { bodies++; return [[long[frame].x, 0, 0], [long[frame].x, 1.7, 0]]; };
const rail = { mode: "rail", cameraRail: [{ x: -3, z: 4 }, { x: 0, z: 5 }, { x: 3, z: 4 }], railFollow: { mode: "range", startFrame: 0, endFrame: 47 } };
const follow = { id: "f1", name: "F", startFrame: 48, endFrame: 95, cameraKeys: [], camera: { mode: "follow" } };
const build = (list, reuse) => buildShotCameraTracks({ shots: list, subjectTrack: long, fps: 24, bodyAt, filmback: { aspectRatio: 16 / 9 }, fovDeg: 45, reuse });
const reuse = new Map(), listOf = (camera, other = follow) => [{ id: "r1", name: "R", startFrame: 0, endFrame: 47, cameraKeys: [], camera }, other];
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
build(listOf({ ...rail, head: { yawDeg: 5, pitchDeg: 0 }, followCam: { distance: 4.7 } }), reuse);
assert.ok(bodies > 0 && bodies <= 48, `a change of the rail shot reframes that shot only (${bodies} bodies)`);
// a field set to undefined is written like a missing one, and read differently (the follow height's default)
const undefinedReuse = new Map(), unset = listOf({ ...rail, followCam: { height: undefined } });
build(listOf({ ...rail, followCam: {} }), undefinedReuse);
assert.deepEqual(build(unset, undefinedReuse), build(unset, null), "a field set to undefined is a rebuild, equal to one from nothing");
// every other change, mixed with head turns in a random order
const tenth = () => int(100) / 10;
const changes = {
	headTurn: (camera) => ({ ...camera, head: { ...(camera.head?.follow === false ? { follow: false } : {}), yawDeg: tenth() - 5, pitchDeg: tenth() - 5 } }),
	headFollow: (camera) => ({ ...camera, head: camera.head?.follow === false ? null : { follow: false, yawDeg: tenth(), pitchDeg: tenth() - 5 } }),
	railRedrawn: (camera) => ({ ...camera, cameraRail: [{ x: -3 + tenth() / 5, z: 4 }, { x: 0, z: 5 + tenth() / 10 }, { x: 3, z: 4 }] }),
	craneMark: (camera) => ({ ...camera, craneHeight: { points: [{ t: 0, height: 1 + tenth() / 10 }, { t: 0.5, height: 2 }, { t: 1, height: 1.2 }] } }),
	followSettings: (camera) => ({ ...camera, followCam: { ...camera.followCam, [pick(["distance", "height", "pitchOffsetDeg", "orbitOffsetDeg"])]: 0.5 + tenth() / 3 } }),
	aim: (camera) => ({ ...camera, aim: pick([null, { ids: ["a"] }, { ids: ["gone"] }, { point: { x: 1, y: tenth() / 5, z: 0 } }]) }),
	aimTake: (camera) => ({ ...camera, aimTake: random() < 0.4 ? null : { startFrame: int(5), samples: Array.from({ length: 12 + int(20) }, (_, i) => ({ yaw: i / 30, pitch: -i / 90 })) } }),
	railFollow: (camera) => ({ ...camera, railFollow: pick([null, { mode: "range", startFrame: int(5), endFrame: 15 + int(30) }]) }),
	dollyTiming: (camera) => ({ ...camera, dollyTiming: random() < 0.3 ? null : { cuts: [{ t: 0.2 + tenth() / 20, d: 0.3 + tenth() / 30 }], envelopes: [] } }),
	lens: (camera) => ({ ...camera, focalMm: pick([undefined, 24, 85]), rollDeg: pick([0, 10]) }),
};
const aimAt = (id, frame) => id === "a" ? { x: long[frame].x, y: 1.2, z: 0.5 } : null;
const mixed = (list, kept) => buildShotCameraTracks({ shots: list, subjectTrack: long, fps: 24, bodyAt, aimAt, filmback: { aspectRatio: 16 / 9 }, fovDeg: 45, reuse: kept });
let camera = rail, other = follow, length = 47, samples = 0;
const mixedReuse = new Map(), names = Object.keys(changes);
for (let step = 0; step < 400; step++) {
	const name = step % 2 ? "headTurn" : pick([...names, "otherShot", "shotLength"]);
	if (name === "otherShot") other = { ...follow, camera: { mode: "follow", followCam: { distance: 2 + tenth() / 5 } } };
	else if (name === "shotLength") length = 30 + int(18);
	else camera = changes[name](camera);
	const list = [{ id: "r1", name: "R", startFrame: 0, endFrame: length, cameraKeys: [], camera }, other];
	const kept = mixed(list, mixedReuse);
	assert.deepEqual(kept, mixed(list, null), `step ${step} (${name}): the kept samples give what a build from nothing gives`);
	samples += kept.filter(Boolean).length;
}
assert.ok(samples > 400 * 60, `the mixed changes compared built cameras (${samples} samples)`);

// the hooks, rendered again and again under a real React root (in StrictMode, as the app runs in development)
const { createRoot } = await import("@react-three/fiber");
const root = createRoot({ style: {}, addEventListener() {}, removeEventListener() {} });
await root.configure({ gl: { render() {}, setSize() {}, setPixelRatio() {}, domElement: { style: {} }, shadowMap: { enabled: false } }, frameloop: "never", size: { width: 64, height: 64, top: 0, left: 0 } });
const F = 60, sk = skeletonFor("x-bot-tpose"), rest = toLocal(sk, restState(sk));
let takeReads = 0;
const take = (reach) => {
	const rot = new Float32Array(F * rest.quats.length * 4), hips = new Float32Array(F * 3);
	for (let f = 0; f < F; f++) {
		rest.quats.forEach((q, b) => rot.set(q, (f * rest.quats.length + b) * 4));
		hips.set([rest.hips[0] + reach * f / F, rest.hips[1] - 0.5 * f / F, rest.hips[2] + f / F], f * 3);
	}
	return { schema: "cozyclay.take.v3", frameCount: F, frames: F, rig: "x-bot-tpose", bones: sk.names.slice(), rot, get hips() { takeReads++; return hips; } };
};
const person = (id, x, reach) => ({ id, model: "x-bot-tpose", x, y: 0, z: 0, rot: 0, scale: 1, sessionMotion: take(reach) });
let scene = { characters: [person("a", 0, 2), person("b", 2, -1)], objects: [], frameCount: F, fps: 24, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 }, fovDeg: 45, activeId: "a", motion: take(3),
	shots: [{ id: "r1", name: "R", startFrame: 0, endFrame: 29, cameraKeys: [], camera: railOf() }, { id: "f1", name: "F", startFrame: 30, endFrame: 59, subjectIds: ["b"], cameraKeys: [], camera: { mode: "follow" } }] };
let rendered;
function Cameras({ scene: props, done }) {
	const subjects = useShotSubjects(props);
	rendered = { subjects, tracks: useShotCameraTracks({ ...props, subjects }) };
	useEffect(done);
	return null;
}
const render = () => new Promise((done) => root.render(createElement(StrictMode, null, createElement(Cameras, { scene, done }))));
const fromNothing = ({ characters: cast, objects: props, shots: list, frameCount, fps, activeId, motion, filmback, fovDeg }) => {
	const state = { characters: cast, objects: props, shots: list, frameCount, fps, activeId, clipOf: (entry) => entry.id === activeId ? motion : entry.sessionMotion };
	const at = createShotSubjectSampler(state), track = shotSubjectTrack(state);
	return { track, tracks: buildShotCameraTracks({ shots: list, subjectTrack: track, fps, yawDegOf: (one) => subjectsCenter(at(one, one.startFrame))?.rot ?? 0, filmback, fovDeg,
		aimAt: (id, frame) => castAimPoint(id, frame, state), bodyAt: createShotSubjectBodies(state) }) };
};
const equalsFresh = (label) => {
	const want = fromNothing(scene);
	assert.deepEqual(rendered.tracks, want.tracks, `${label}: the hooks' cameras equal a build from nothing on every frame`);
	assert.deepEqual(rendered.subjects.track, want.track, `${label}: and so does the subject track`);
};
const turnHead = (yawDeg) => { scene = { ...scene, shots: scene.shots.map((one) => one.id === "r1" ? { ...one, camera: { ...one.camera, head: { yawDeg, pitchDeg: -yawDeg / 3 } } } : one) }; };
await render();
assert.ok(takeReads > 0 && rendered.tracks.filter(Boolean).length === F, "the hooks build a camera for every frame of both shots");
equalsFresh("first render");
for (let move = 1; move <= 20; move++) {
	turnHead(move * 0.9);
	takeReads = 0;
	const subjects = rendered.subjects;
	await render();
	assert.equal(takeReads, 0, `turn ${move}: the hooks read no take (${takeReads} reads)`);
	assert.equal(rendered.subjects, subjects, `turn ${move}: the shot subjects are the ones built before`);
	takeReads = 1e9; equalsFresh(`turn ${move}`);
}
const others = {
	"a take replaced": () => { scene = { ...scene, characters: scene.characters.map((row) => row.id === "b" ? { ...row, sessionMotion: take(-2) } : row) }; },
	"the active take replaced": () => { scene = { ...scene, motion: take(1) }; },
	"a character moved": () => { scene = { ...scene, characters: scene.characters.map((row) => row.id === "a" ? { ...row, x: 1, rot: 90 } : row) }; },
	"a subject picked": () => { scene = { ...scene, shots: scene.shots.map((one) => one.id === "r1" ? { ...one, subjectIds: ["b"] } : one) }; },
	"the shot shortened": () => { scene = { ...scene, shots: scene.shots.map((one) => one.id === "r1" ? { ...one, endFrame: 24 } : one) }; },
	"the lens changed": () => { scene = { ...scene, fovDeg: 30 }; },
	"the picture's shape changed": () => { scene = { ...scene, filmback: { ...scene.filmback, aspectRatio: 1 } }; },
	"the frame rate changed": () => { scene = { ...scene, fps: 30 }; },
	"another character made active": () => { scene = { ...scene, activeId: "b" }; },
};
let turn = 20;
for (const [label, change] of Object.entries(others)) {
	change(); await render(); equalsFresh(label);
	turnHead(++turn); await render(); equalsFresh(`${label}, then a head turn`);
}
root.unmount();
console.log(`PASS camera drag work: sameJson equals JSON equality over ${pool.length ** 2} pairs and does not read the same object; 30 binding refreshes read no unchanged document and run the physics check once; 30 head turns rebuild no camera samples (first build ${firstBodies} bodies), 400 mixed changes equal fresh builds; the hooks keep subjects and samples over 20 head turns and rebuild on ${Object.keys(others).length} other changes`);
