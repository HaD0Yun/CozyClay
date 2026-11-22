#!/usr/bin/env node
// What verify_result lighting says against how the frame is drawn (stage-light-facts.js), and the words around it:
// where a lamp's light ends under a finish that pools it (at its range, as in the stock draw), which stage light is the key, a directional light's shadow
// box against an independent recomputation on random inputs, an aim switched between a followed id and a point, an aim
// at a character that left the cast, and receipt lines that never cut an id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { normalizeObjectLight, withShadowCapWarnings } from "../../src/object-look.js";
import { createSceneObject } from "../../src/scene-objects.js";
import { aimAtFor, placeObjectLook } from "../../src/scene-light-place.js";
import { stageLightFacts } from "../../src/stage-light-facts.js";
import { lightingChecks } from "../../src/studio-lighting-check.js";
import { setStageScene } from "../../src/stage-scene-ref.js";
import { objectsFixture } from "./objects-fixture.mjs";

let failures = 0;
const test = (name, run) => {
	try { run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n${error.stack}`); }
};

// A subject at the origin (posed points up a 1.8 m body), the stage's key, and what a case adds; the camera looks from +z.
const BODY = [[0, 0.1, 0], [0, 0.5, 0], [0, 0.9, 0], [0, 1.3, 0], [0, 1.7, 0], [0.25, 1.3, 0], [-0.25, 1.3, 0]];
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [3, 6]];
const bounds = { min: { x: -0.2, y: 0, z: -0.2 }, max: { x: 0.2, y: 1.8, z: 0.2 }, points: BODY.map(([x, y, z]) => ({ x, y, z })), bones: BONES };
function stageKey(scene, at) {
	const key = new THREE.DirectionalLight();
	key.position.set(at.x, at.y, at.z);
	key.castShadow = true;
	Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 0.5, far: 60 });
	key.shadow.camera.updateProjectionMatrix();
	scene.add(key);
	return key;
}
function stage({ key = { x: 6, y: 9, z: 4 }, look = null } = {}) {
	const scene = new THREE.Scene(), hero = new THREE.Group();
	hero.userData.characterPick = "hero";
	const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.8), new THREE.MeshStandardMaterial());
	body.position.y = 0.9;
	body.castShadow = body.receiveShadow = true;
	hero.add(body);
	scene.add(hero);
	if (key) stageKey(scene, key);
	if (look) scene.userData.finishLook = look;
	scene.updateMatrixWorld(true);
	return scene;
}
/** A light record's group as SceneObject mounts it (scene-lights.jsx makeLight). */
function lightGroup(object) {
	const group = new THREE.Group();
	group.position.set(object.x, object.y, object.z);
	group.userData.sceneObjectId = object.id;
	const light = object.light.type === "spot" ? new THREE.SpotLight() : object.light.type === "directional" ? new THREE.DirectionalLight() : new THREE.PointLight();
	light.position.set(0, 0, 0);
	if (!light.isDirectionalLight) light.decay = 2;
	light.castShadow = object.light.shadow;
	light.userData.sceneLight = true;
	light.shadow.camera.near = 0.03;
	group.add(light);
	return group;
}
function addLight(scene, id, type, at, fields = {}, aim = null) {
	const record = { ...createSceneObject(`${type}-light`, []), id, ...at };
	record.light = normalizeObjectLight({ ...record.light, ...fields, aim });
	const group = lightGroup(record);
	scene.add(group);
	scene.updateMatrixWorld(true);
	placeObjectLook(group, record, 0, null);
	return record;
}
function addBox(scene, id, min, max) {
	const box = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), new THREE.MeshStandardMaterial());
	box.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
	box.castShadow = true;
	const group = new THREE.Group();
	group.userData.sceneObjectId = id;
	group.add(box);
	scene.add(group);
	scene.updateMatrixWorld(true);
}
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 1000);
camera.position.set(0, 1.2, 5);
camera.lookAt(0, 1, 0);
camera.updateMatrixWorld(true);
const W = 160, H = 90, image = { data: new Uint8Array(W * H * 4).fill(60), width: W, height: H };
const facts = (scene, objects = [], keyLight = { x: 6, y: 9, z: 4 }) => stageLightFacts(scene, { subjects: [{ subject: { id: "hero" }, bounds }], keyLight,
	view: { camera, width: W, height: H }, image, state: { objects, frame: 0 }, ports: {} });
const row = (out, id) => out.subjects.hero.lights.find((r) => r.id === id);

// The look a finish puts on the scene (stage-finish.js FINISH_LOOKS): only the two numbers the facts read are needed here.
const POOLED = { surface: { bands: { pool: 0.6, reach: 8 } } };

test("under a finish that pools lamp light a point or spot light ends at its range, as in the stock draw", () => {
	const scene = stage({ look: POOLED });
	const lights = [
		addLight(scene, "far-open", "point", { x: 0, y: 1, z: 6 }, { intensity: 100, range: 0 }),
		addLight(scene, "ranged", "spot", { x: 4, y: 1, z: 0 }, { intensity: 100, range: 6, angle: 40 }, { x: 0, y: 1, z: 0 }),
		addLight(scene, "ranged-far", "spot", { x: 7, y: 1, z: 0 }, { intensity: 100, range: 6, angle: 40 }, { x: 0, y: 1, z: 0 }),
		addLight(scene, "sun", "directional", { x: -3, y: 5, z: 2 }, { intensity: 1 }, { x: 0, y: 1, z: 0 }),
	];
	const out = facts(scene, lights);
	assert.deepEqual([row(out, "far-open").reach, "endsAtM" in row(out, "far-open")], [1, false], "6 m away, no range: past the pool the stock falloff still lights it, and it never ends");
	assert.deepEqual([row(out, "ranged").reach, row(out, "ranged").endsAtM], [1, 6], "range 6, 4 m away: inside its range");
	assert.deepEqual([row(out, "ranged-far").reach, row(out, "ranged-far").why, row(out, "ranged-far").endsAtM], [0, "range", 6], "range 6, 7 m away: past its range");
	assert.equal("endsAtM" in row(out, "sun") || "endsAtM" in row(out, "key"), false, "a directional light does not end");
	// the stock draw: the same
	const stock = stage(), same = [addLight(stock, "far-open", "point", { x: 0, y: 1, z: 6 }, { intensity: 100, range: 0 }), addLight(stock, "ranged", "spot", { x: 4, y: 1, z: 0 }, { intensity: 100, range: 6, angle: 40 }, { x: 0, y: 1, z: 0 })];
	const plain = facts(stock, same);
	assert.deepEqual([row(plain, "far-open").reach, "endsAtM" in row(plain, "far-open")], [1, false]);
	assert.deepEqual([row(plain, "ranged").reach, row(plain, "ranged").endsAtM], [1, 6]);
});

test("the finish's surface still ends lamp light where the stock falloff does", () => {
	// endOf (stage-light-facts.js) restates this shader: a change to either line needs the same change there.
	const surface = readFileSync(new URL("../../src/stage-finish-surface.js", import.meta.url), "utf8");
	assert.ok(surface.includes("float cozyRim = COZY_POOL * ( cutoffDistance > 0.0 ? cutoffDistance : COZY_REACH );"), "the pool's rim: pool x the range, or x the look's reach without one");
	assert.ok(surface.includes("distanceFalloff = max( ( 1.0 - smoothstep( ( 1.0 - COZY_POOL_SOFT ) * cozyRim, cozyRim, lightDistance ) ) * cozyLevel, min( distanceFalloff, cozyLevel ) );"), "past the pool the stock falloff, which ends at the range (never without one)");
	assert.ok(surface.includes("COZY_POOL: glsl(surface.bands.pool)") && surface.includes("COZY_REACH: glsl(surface.bands.reach)"), "the two numbers come from the look's bands");
});

test("the key is the stage's own shadow-casting directional light, wherever it stands", () => {
	// the stage's light 3 m off stage.keyLight, a second one further off, and a record's directional light not placed yet
	const scene = stage({ key: { x: 6, y: 12, z: 4 } });
	stageKey(scene, { x: -20, y: 9, z: 4 });
	const unplaced = lightGroup({ ...createSceneObject("directional-light", []), id: "new", x: 6, y: 9, z: 4 });
	delete unplaced.userData.sceneObjectId;
	scene.add(unplaced);
	scene.updateMatrixWorld(true);
	const out = facts(scene, [{ id: "new", renderer: "light" }]);
	assert.deepEqual(out.subjects.hero.lights.map((r) => r.id), ["key"]);
	assert.equal(row(out, "key").side, "side-right-above", "the nearer of the two stage lights, read where it stands");
	assert.deepEqual(out.notDrawn, ["new"]);
	const none = stage({ key: null });
	assert.deepEqual(facts(none).subjects.hero.lights, []);
});

// Independent recomputation for directional lights: the shadow box (10 m either side of the aim line in the shadow
// camera's own axes, from 0.1 m to 20 m past the aim point) and a slab test against one wall.
function slab(p, q, min, max) {
	let t0 = 0, t1 = 1;
	for (let a = 0; a < 3; a++) {
		const d = q[a] - p[a];
		if (Math.abs(d) < 1e-12) { if (p[a] < min[a] || p[a] > max[a]) return false; continue; }
		let lo = (min[a] - p[a]) / d, hi = (max[a] - p[a]) / d;
		if (lo > hi) [lo, hi] = [hi, lo];
		t0 = Math.max(t0, lo); t1 = Math.min(t1, hi);
		if (t0 > t1) return false;
	}
	return true;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
let seed = 31;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647), span = (lo, hi) => lo + random() * (hi - lo);
test("300 random directional lights and walls: reach, shadow share, why and side agree with a recomputation", () => {
	let checked = 0, shadowed = 0, outside = 0;
	const sides = new Set();
	while (checked < 300) {
		const L = [span(-8, 8), span(1, 9), span(-8, 8)], wide = random() < 0.35;
		const A = wide ? [span(-14, 14), span(0, 2), span(-14, 14)] : [span(-1, 1), span(0, 2), span(-1, 1)];
		const dir = unit(A.map((v, a) => v - L[a])), depth = Math.hypot(...A.map((v, a) => v - L[a]));
		if (Math.abs(dir[1]) > 0.999 || depth < 0.5) continue;
		// the wall: half the time somewhere up the rays from the body, else anywhere near
		const t = span(0.3, 4), on = [-dir[0] * t, 0.9 - dir[1] * t, -dir[2] * t];
		const min = random() < 0.6 ? on.map((v) => v - span(0.1, 0.9)) : [span(-3, 2), span(0, 3), span(-3, 2)], max = min.map((v) => v + span(0.2, 1.8));
		if (BODY.some((p) => p.every((v, a) => v > min[a] - 0.02 && v < max[a] + 0.02))) continue;
		const shadow = random() < 0.75;
		// the shadow camera's axes, as three.js looks from the light to its target with y up
		const right = unit(cross(dir, [0, 1, 0])), up = cross(right, dir);
		const placed = BODY.map((p) => { const rel = p.map((v, a) => v - L[a]); return { p, x: dot(rel, right), y: dot(rel, up), z: dot(rel, dir) }; });
		if (placed.some(({ x, y, z }) => Math.abs(Math.abs(x) - 10) < 0.05 || Math.abs(Math.abs(y) - 10) < 0.05 || Math.abs(z - 0.1) < 0.05 || Math.abs(z - (depth + 20)) < 0.05)) continue;
		const scene = stage({ key: null });
		addBox(scene, "wall", min, max);
		const light = addLight(scene, "l", "directional", { x: L[0], y: L[1], z: L[2] }, { intensity: 1.5, shadow }, { x: A[0], y: A[1], z: A[2] });
		const got = row(facts(scene, [light], null), "l");
		let lit = 0, hidden = 0;
		for (const { p, x, y, z } of placed) {
			const inBox = Math.abs(x) <= 10 && Math.abs(y) <= 10 && z >= 0.1 && z <= depth + 20;
			if (!inBox) outside++;
			if (shadow && inBox && slab(p, p.map((v, a) => v - dir[a] * z), min, max)) hidden++; else lit++;
		}
		const detail = JSON.stringify({ L, A, min, max, shadow, got });
		assert.equal(got.reach, Math.round((lit / BODY.length) * 100) / 100, detail);
		assert.equal(got.shadow?.share ?? 0, Math.round((hidden / BODY.length) * 100) / 100, detail);
		if (!lit) assert.equal(got.why, "shadow", detail);
		assert.equal("distanceM" in got || "endsAtM" in got, false, "a directional light has no distance and no end");
		const toLight = dir.map((v) => -v), toCamera = unit([0, 1.2 - 0.9, 5]);
		const deg = (Math.acos(Math.max(-1, Math.min(1, dot(toLight, toCamera)))) * 180) / Math.PI, level = Math.sin(Math.PI / 12);
		const want = [deg < 60 ? "front" : deg > 120 ? "back" : "side", toLight[0] > level ? "right" : toLight[0] < -level ? "left" : null, toLight[1] > level ? "above" : toLight[1] < -level ? "below" : null].filter(Boolean).join("-");
		assert.equal(got.side, want, detail);
		sides.add(want);
		if (hidden) shadowed++;
		checked++;
	}
	assert.ok(shadowed > 40 && outside > 40 && sides.size >= 8, `the inputs cover shadows (${shadowed}), points outside the shadow box (${outside}) and sides (${sides.size})`);
	console.log(`  ${checked} inputs, ${shadowed} with a cast shadow, ${outside} body points outside the shadow box, ${sides.size} distinct sides`);
});

test("the facts are read while the scene stands as the frame drew it, through the camera that drew it", () => {
	// The port poses the scene for the frame, draws, lets the check look, then puts the editor's own state back: here
	// the editor shows the lamp parked far away, the frame has it beside the subject.
	const scene = stage({ key: null }), lamp = addLight(scene, "lamp", "point", { x: 30, y: 1, z: 0 }, { intensity: 50, range: 0 });
	const group = scene.children.find((node) => node.userData.sceneObjectId === "lamp");
	const state = { frame: 0, camera: { position: { x: 0, y: 1.2, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 }, filmback: { sensorId: "super35" }, characters: [{ id: "hero", x: 0, z: 0 }], objects: [lamp], stage: {} };
	const drawnBy = (shotCamera) => (frame, view, inspect) => {
		group.position.set(2, 1, 0); scene.updateMatrixWorld(true);
		inspect?.({ ...image, camera: shotCamera });
		group.position.set(30, 1, 0); scene.updateMatrixWorld(true);
		return image;
	};
	setStageScene(scene);
	try {
		const inFrame = lightingChecks([], state, { renderFrameBuffer: drawnBy(camera), bounds: () => bounds }).subjects[0].lights[0];
		assert.deepEqual([inFrame.id, inFrame.distanceM, inFrame.side], ["lamp", 2, "side-right"], "the lamp where the frame had it, 2 m to screen right");
		const after = lightingChecks([], state, { renderFrameBuffer: () => image, bounds: () => bounds }).subjects[0].lights[0];
		assert.equal(after.distanceM, 30, "a port that does not let the check look is read right after the frame");
		// the camera rolled half a turn about its lens axis: the frame shows the lamp on the left
		const rolled = camera.clone();
		rolled.rotateZ(Math.PI);
		rolled.updateMatrixWorld(true);
		assert.equal(lightingChecks([], state, { renderFrameBuffer: drawnBy(rolled), bounds: () => bounds }).subjects[0].lights[0].side, "side-left");
		// a body the scene cannot be read through: the exposure numbers stay, the rows are left out, and the answer says why
		const broken = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		broken.castShadow = true;
		broken.raycast = () => { throw new Error("no ray through this one"); };
		scene.add(broken);
		addLight(scene, "caster", "point", { x: -2, y: 1, z: 0 }, { intensity: 50, shadow: true });
		const answer = lightingChecks([], state, { renderFrameBuffer: drawnBy(camera), bounds: () => bounds });
		assert.deepEqual([answer.lightsError, "lights" in answer.subjects[0], typeof answer.meanLuma], ["no ray through this one", false, "number"]);
	} finally { setStageScene(null); }
});

test("an aim switches between a followed id and a point in one set", () => {
	// a set merges member by member over the stored aim: the member written last is the new form
	assert.deepEqual(normalizeObjectLight({ aim: { id: "hero", x: 1, y: 2, z: 3 } }).aim, { x: 1, y: 2, z: 3 }, "a point set over a followed id");
	assert.deepEqual(normalizeObjectLight({ aim: { x: 1, y: 2, z: 3, id: "hero" } }).aim, { id: "hero" }, "an id set over a point");
	assert.deepEqual(normalizeObjectLight({ aim: { id: "hero", y: 2 } }).aim, { id: "hero" }, "a part of a point changes nothing");
	assert.deepEqual(normalizeObjectLight({ aim: { x: 1, y: 2, z: 3 } }).aim, { x: 1, y: 2, z: 3 });
	assert.deepEqual(normalizeObjectLight({ aim: { id: "hero" } }).aim, { id: "hero" });
});

test("a light does not aim at a character that left the cast, though its rig is still held", () => {
	const hips = new THREE.Matrix4().makeTranslation(2, 1, 0), attachFrameRef = { current: (id, bone, out) => (id === "gone" || id === "hero" ? out.copy(hips) : null) };
	const out = new THREE.Vector3();
	assert.deepEqual(aimAtFor({ current: new Map() }, { current: new Map() }, attachFrameRef, [{ id: "hero" }])("hero", out)?.toArray(), [2, 1, 0]);
	assert.equal(aimAtFor({ current: new Map() }, { current: new Map() }, attachFrameRef, [{ id: "hero" }])("gone", out), null);
	assert.deepEqual(aimAtFor({ current: new Map() }, { current: new Map() }, attachFrameRef)("gone", out)?.toArray(), [2, 1, 0], "a set that is not given the cast resolves as before");
	// a record wins over a character of the same id, and needs no cast
	const world = new THREE.Matrix4().makeTranslation(-1, 0, 3), registry = { current: new Map([["crate", { world: (m) => m.copy(world) }]]) };
	assert.deepEqual(aimAtFor(registry, { current: new Map([["crate", { height: 2 }]]) }, attachFrameRef, [])("crate", out)?.toArray(), [-1, 1, 3]);
});

test("the shadow-cap receipt never cuts an id", () => {
	const lights = (ids) => ids.map((id) => ({ id, renderer: "light", light: { shadow: true } }));
	const message = (ids) => withShadowCapWarnings({ affectedIds: [ids.at(-1)] }, lights(ids)).warnings[0].message;
	assert.equal(message(["a", "b", "c", "d", "e"]), "Renders without a shadow: only 4 lights cast shadows (a, b, c, d).");
	const long = message(["directional-light-12", "directional-light-13", "directional-light-14", "directional-light-15", "x"]);
	assert.equal(long, "Renders without a shadow: only 4 lights cast shadows (directional-light-12, directional-light-13, 2 more).");
	assert.ok(message(["s".repeat(80), "b", "c", "d", "e"]).length <= 120 && long.length <= 120);
});

// Through the registry, as the agent sets it: a followed aim, then a point, then the id again, then none.
const f = objectsFixture([]);
try {
	test("object.set switches a light's aim from an id to a point and back", () => {
		const id = f.run("object.add", { kind: "spot-light", name: "Spot", placement: { x: 1, y: 3, z: 1 } }, "agent").affectedIds[0];
		const aim = () => f.store.current.objects.find((o) => o.id === id).light.aim;
		for (const next of [{ id: "char-a" }, { x: -4, y: 0, z: 5 }, { id: "char-a" }, { x: 2, y: 1, z: 0 }, null]) {
			assert.equal(f.run("object.set", { id, set: { light: { aim: next } } }, "agent").ok, true);
			assert.deepEqual(aim(), next);
		}
	});
} finally { f.dispose(); }

if (failures) process.exit(1);
