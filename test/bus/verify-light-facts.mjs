#!/usr/bin/env node
// Placed lights the agent can say (object-look.js: a directional kind, an aim that follows a character or record, the
// drawn-light and shadow caps) and what verify_result lighting tells it about them (stage-light-facts.js): which lights
// reach each subject, from which side seen from the shot camera, how much of it a cast shadow hides, and its lit to
// shaded ratio. The facts are checked against scenes built here and against an independent recomputation on many
// random inputs.
import assert from "node:assert/strict";
import * as THREE from "three";
import { LIGHT_MENU_ENTRIES, PRACTICAL_LIGHT_CAP, PRACTICAL_SHADOW_CAP, capPracticalLights, normalizeObjectLight, practicalShadows, withShadowCapWarnings } from "../../src/object-look.js";
import { createSceneObject, loadScene, normalizeSceneObject, serializeScene } from "../../src/scene-objects.js";
import { placeObjectLook } from "../../src/scene-light-place.js";
import { STUDIO_PATCH_SET_SCHEMAS, validateStudioSchema } from "../../src/studio-agent-protocol.js";
import { bodyMask, stageLightFacts } from "../../src/stage-light-facts.js";
import { lightingChecks } from "../../src/studio-lighting-check.js";
import { setStageScene } from "../../src/stage-scene-ref.js";
import { objectsFixture } from "./objects-fixture.mjs";

let failures = 0;
const test = (name, run) => {
	try { run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n${error.stack}`); }
};

test("the words: a directional kind, an aim at a point or an id, old records unchanged", () => {
	assert.deepEqual(LIGHT_MENU_ENTRIES.map((e) => e.kind), ["point-light", "spot-light", "directional-light"]);
	const sun = createSceneObject("directional-light", []);
	assert.deepEqual([sun.renderer, sun.light.type, sun.light.shadow, sun.light.intensity], ["light", "directional", true, 1]);
	assert.equal(normalizeObjectLight({ type: "directional", intensity: 40 }).intensity, 4, "a directional light is clamped to the key's 0..4");
	assert.equal(normalizeObjectLight({ type: "spot", intensity: 40 }).intensity, 40);
	assert.deepEqual(normalizeObjectLight({ aim: { id: "char-a" } }).aim, { id: "char-a" });
	assert.deepEqual(normalizeObjectLight({ aim: { id: "char-a", x: 1 } }).aim, { id: "char-a" }, "an id wins over stray numbers");
	assert.equal(normalizeObjectLight({ aim: { id: "" } }).aim, null);
	assert.deepEqual(normalizeObjectLight({ aim: { x: 1, y: 2, z: 3 } }).aim, { x: 1, y: 2, z: 3 });
	assert.equal(normalizeObjectLight({}, "directional").type, "directional");
	// a scene saved before: its point and spot records come back byte for byte
	const old = [normalizeSceneObject({ id: "lamp", renderer: "light", x: 1, y: 3, z: 0, light: { type: "spot", color: "#ffe0b2", intensity: 40, range: 0, angle: 30, softness: 0.3, shadow: true, flicker: 0, aim: { x: 0, y: 0, z: 1 } } }),
		normalizeSceneObject({ id: "cube", renderer: "cube", x: 0, y: 0, z: 0 })];
	const saved = serializeScene(old);
	assert.equal(serializeScene(loadScene(saved).objects), saved, "an old scene re-saves to the same bytes");
	const aimed = [normalizeSceneObject({ ...sun, light: { ...sun.light, aim: { id: "char-a" } } })];
	assert.deepEqual(loadScene(serializeScene(aimed)).objects, aimed, "a scene with a followed aim saves and reloads with it");
	const schema = STUDIO_PATCH_SET_SCHEMAS.object.properties.light;
	validateStudioSchema(schema, { type: "directional", aim: { id: "char-a" } });
	validateStudioSchema(schema, { aim: { x: 0, y: 1, z: 2 } });
	assert.throws(() => validateStudioSchema(schema, { type: "area" }));
	assert.throws(() => validateStudioSchema(schema, { aim: { id: "a", y: 1 } }));
});

test("caps: the first 16 shown lights are drawn, of those the first 4 that ask cast shadows", () => {
	assert.deepEqual([PRACTICAL_LIGHT_CAP, PRACTICAL_SHADOW_CAP], [16, 4]);
	const lights = Array.from({ length: 18 }, (_, i) => ({ ...createSceneObject("spot-light", []), id: `l${i}`, ...(i === 2 ? { hidden: true } : {}) }));
	const { casting, capped, unlit } = practicalShadows(lights);
	assert.deepEqual(casting, ["l0", "l1", "l3", "l4"], "a hidden light counts for neither cap");
	assert.equal(capped.length, 16 - 4, "the hidden one makes room for l16 among the drawn");
	assert.deepEqual(unlit, ["l17"]);
	const drawn = capPracticalLights(lights);
	assert.deepEqual([drawn[17].lightCapped, drawn[17].light.shadow, drawn[5].shadowCapped, drawn[5].light.shadow], [true, false, true, false]);
	assert.equal(drawn[0], lights[0]);
	const warned = withShadowCapWarnings({ affectedIds: ["l17", "l5"] }, lights).warnings.map((w) => w.code);
	assert.deepEqual(warned, ["LIGHT_CAP", "SHADOW_CAP"]);
	const few = lights.slice(0, 4);
	assert.equal(capPracticalLights(few), few);
});

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
const lightOf = (group) => group.children.find((c) => c.isLight);

test("the place pass: a directional light aims its rays and shadow box, an id aim follows, a missing id is said", () => {
	const sun = { ...createSceneObject("directional-light", []), x: 4, y: 6, z: 2 };
	const group = lightGroup(sun);
	placeObjectLook(group, { ...sun, light: { ...sun.light, aim: { x: 0, y: 0, z: 0 }, intensity: 1.5, softness: 1 } }, 0, null);
	const light = lightOf(group), target = light.target.getWorldPosition(new THREE.Vector3());
	assert.ok(target.distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-9, "the target is the aim point");
	assert.equal(light.intensity, 1.5, "a directional light's unit is three.js's own");
	assert.deepEqual([light.shadow.camera.right, light.shadow.camera.far, light.shadow.radius], [10, Math.hypot(4, 6, 2) + 20, 8]);
	const at = new THREE.Vector3(1, 1, -1);
	placeObjectLook(group, { ...sun, light: { ...sun.light, aim: { id: "hero" } } }, 0, null, (id, out) => (id === "hero" ? out.copy(at) : null));
	assert.ok(light.target.getWorldPosition(new THREE.Vector3()).distanceTo(at) < 1e-9 && light.userData.aimFound === true, "an id aim turns to where aimAt puts it");
	placeObjectLook(group, { ...sun, light: { ...sun.light, aim: { id: "gone" } } }, 0, null, () => null);
	assert.equal(light.userData.aimFound, false);
	assert.ok(light.target.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(4, -4, 2)) < 1e-9, "a missing id points down its -Y");
	assert.equal(light.userData.sceneObjectId, sun.id);
});

// A stage for the facts: a subject standing at the origin (posed points up a 1.8 m body, bones between them), the key,
// and whatever lights and blockers a case adds. The camera looks at the subject from +z.
const BODY = [[0, 0.1, 0], [0, 0.5, 0], [0, 0.9, 0], [0, 1.3, 0], [0, 1.7, 0], [0.25, 1.3, 0], [-0.25, 1.3, 0]];
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [3, 6]];
function stage({ key = { x: 6, y: 9, z: 4 } } = {}) {
	const scene = new THREE.Scene(), hero = new THREE.Group();
	hero.userData.characterPick = "hero";
	const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.8), new THREE.MeshStandardMaterial());
	body.position.y = 0.9;
	body.castShadow = body.receiveShadow = true;
	hero.add(body);
	scene.add(hero);
	const keyLight = new THREE.DirectionalLight();
	keyLight.position.set(key.x, key.y, key.z);
	keyLight.castShadow = true;
	Object.assign(keyLight.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 0.5, far: 60 });
	keyLight.shadow.camera.updateProjectionMatrix();
	scene.add(keyLight);
	scene.updateMatrixWorld(true);
	return scene;
}
const bounds = { min: { x: -0.2, y: 0, z: -0.2 }, max: { x: 0.2, y: 1.8, z: 0.2 }, points: BODY.map(([x, y, z]) => ({ x, y, z })), bones: BONES };
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 1000);
camera.position.set(0, 1.2, 5);
camera.lookAt(0, 1, 0);
camera.updateMatrixWorld(true);
const W = 160, H = 90, dark = { data: new Uint8Array(W * H * 4).fill(60), width: W, height: H };
function addLight(scene, id, type, at, fields = {}, aim = null) {
	const record = { ...createSceneObject(`${type}-light`, []), id, ...at };
	record.light = normalizeObjectLight({ ...record.light, ...fields, aim });
	const group = lightGroup(record);
	scene.add(group);
	scene.updateMatrixWorld(true);
	placeObjectLook(group, record, 0, null);
	return record;
}
function addBox(scene, id, min, max, cast = true) {
	const box = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), new THREE.MeshStandardMaterial());
	box.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
	box.castShadow = cast;
	const group = new THREE.Group();
	group.userData.sceneObjectId = id;
	group.add(box);
	scene.add(group);
	scene.updateMatrixWorld(true);
}
const facts = (scene, objects = [], image = dark) => stageLightFacts(scene, { subjects: [{ subject: { id: "hero" }, bounds }], keyLight: { x: 6, y: 9, z: 4 },
	view: { camera, width: W, height: H }, image, state: { objects, frame: 0 }, ports: {} });
const row = (out, id) => out.subjects.hero.lights.find((r) => r.id === id);

test("a light behind the subject reports back; the key reports side-right-above", () => {
	const scene = stage(), rim = addLight(scene, "rim", "spot", { x: -1, y: 2.5, z: -3 }, { intensity: 40, angle: 40 }, { x: 0, y: 1, z: 0 });
	const out = facts(scene, [rim]);
	assert.deepEqual(row(out, "rim"), { id: "rim", type: "spot", reach: 1, side: "back-left-above", distanceM: Math.round(Math.hypot(1, 1.6, 3) * 100) / 100 });
	assert.deepEqual(row(out, "key"), { id: "key", type: "directional", reach: 1, side: "side-right-above" }, "the key at (6, 9, 4) is 63 degrees off the camera direction");
});

test("a subject under a roof that casts a shadow reports it, by the roof; a glass roof does not", () => {
	const scene = stage();
	addBox(scene, "roof", [-3, 2.4, -3], [3, 2.6, 3]);
	const shaded = row(facts(scene), "key");
	assert.deepEqual([shaded.reach, shaded.shadow, shaded.why], [0, { share: 1, by: ["roof"] }, "shadow"]);
	const clear = stage();
	addBox(clear, "glass", [-3, 2.4, -3], [3, 2.6, 3], false);
	assert.deepEqual(row(facts(clear), "key").reach, 1, "a body that casts no shadow hides nothing");
	const half = stage();
	addBox(half, "awning", [-3, 1.1, -3], [3, 1.2, 3]);
	const low = row(facts(half), "key");
	assert.deepEqual([low.reach, low.shadow], [0.57, { share: 0.43, by: ["awning"] }], "the three points under the awning are shaded, the chest, head and shoulders are not");
});

test("a light out of range, outside its cone, at level 0, or with no shadow behind a wall", () => {
	const scene = stage();
	const far = addLight(scene, "far", "point", { x: 4, y: 1, z: 0 }, { intensity: 5, range: 2 });
	const away = addLight(scene, "away", "spot", { x: 0, y: 3, z: 2 }, { intensity: 40, angle: 20 }, { x: 0, y: 3, z: 6 });
	const off = addLight(scene, "off", "point", { x: 1, y: 1, z: 1 }, { intensity: 0 });
	addBox(scene, "wall", [-1.5, 0, -1.5], [1.5, 3, -1.2]);
	const through = addLight(scene, "through", "point", { x: 0, y: 1, z: -3 }, { intensity: 5, shadow: false });
	const blocked = addLight(scene, "blocked", "point", { x: 0.1, y: 1, z: -3 }, { intensity: 5, shadow: true });
	const out = facts(scene, [far, away, off, through, blocked]);
	assert.deepEqual([row(out, "far").reach, row(out, "far").why], [0, "range"]);
	assert.deepEqual([row(out, "away").reach, row(out, "away").why], [0, "cone"]);
	assert.deepEqual([row(out, "off").reach, row(out, "off").why], [0, "off"]);
	assert.equal(row(out, "through").reach, 1, "a light without a shadow lights through the wall, as three.js draws it");
	assert.deepEqual([row(out, "blocked").reach, row(out, "blocked").why, row(out, "blocked").shadow.by], [0, "shadow", ["wall"]]);
	assert.deepEqual(out.notDrawn, undefined);
	const missing = facts(scene, [far, { ...far, id: "not-mounted" }]);
	assert.deepEqual(missing.notDrawn, ["not-mounted"]);
	assert.ok(out.subjects.hero.lights.length <= 8 && out.subjects.hero.moreLights === undefined && out.subjects.hero.lights.length === 6);
});

test("litToShade: the brightest quarter of the body's pixels over the darkest", () => {
	// the body's left half (screen) at 200, its right half at 50: thin bone lines cover both
	const image = { data: new Uint8Array(W * H * 4), width: W, height: H };
	for (let i = 0; i < W * H; i++) image.data.set(i % W < W / 2 ? [200, 200, 200, 255] : [50, 50, 50, 255], i * 4);
	const out = facts(stage(), [], image);
	assert.equal(out.subjects.hero.litToShade, 4);
	assert.equal(facts(stage(), [], dark).subjects.hero.litToShade, 1);
	const tiny = stageLightFacts(stage(), { subjects: [{ subject: { id: "hero" }, bounds: { ...bounds, bones: [[0, 1]] } }], keyLight: null, view: { camera, width: W, height: H }, image, state: { objects: [], frame: 0 }, ports: {} });
	assert.equal(tiny.subjects.hero.litToShade, null, "too few pixels say nothing");
	// the mask: inside the body's projected box, and gone where a wall hides the body from the camera
	const mask = bodyMask(BONES, bounds.points, { camera, width: W, height: H }, []);
	const lit = [...mask.keys()].filter((i) => mask[i]), xs = lit.map((i) => i % W), ys = lit.map((i) => Math.floor(i / W));
	const project = (p) => new THREE.Vector3(...p).project(camera), top = project([0, 1.7, 0]), foot = project([0, 0.1, 0]);
	assert.ok(Math.min(...ys) >= Math.floor(((foot.y + 1) / 2) * H) - 1 && Math.max(...ys) <= Math.ceil(((top.y + 1) / 2) * H) + 1 && Math.max(...xs) - Math.min(...xs) < 20, "the lines run up the body, rows bottom-up");
	const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.1), new THREE.MeshStandardMaterial());
	wall.position.set(0, 1.5, 2);
	wall.updateMatrixWorld(true);
	assert.equal(bodyMask(BONES, bounds.points, { camera, width: W, height: H }, [wall]).some(Boolean), false, "a body behind a wall shows no pixels");
});

// Independent recomputation: random lights and walls against the subject's points, by a slab test and plain angles.
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
const inside = (p, min, max) => p.every((v, a) => v > min[a] - 1e-6 && v < max[a] + 1e-6);
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const span = (lo, hi) => lo + random() * (hi - lo);
test("400 random lights and walls: reach, shadow share, why and side agree with a recomputation", () => {
	let checked = 0, shadowed = 0, sides = new Set();
	while (checked < 400) {
		const type = random() < 0.5 ? "point" : "spot", L = [span(-6, 6), span(0.3, 6), span(-6, 6)];
		// half the walls stand somewhere on the line from the light to the body, the rest anywhere
		const t = span(0.2, 0.8), on = [L[0] * t, 0.9 + (L[1] - 0.9) * t, L[2] * t];
		const min = random() < 0.5 ? on.map((v) => v - span(0.1, 0.8)) : [span(-3, 2), span(0, 2), span(-3, 2)], max = min.map((v) => v + span(0.2, 1.5));
		if (BODY.some((p) => inside(p, min, max)) || inside(L, min, max) || Math.hypot(L[0], L[2]) < 0.3) continue;
		const range = random() < 0.4 ? 0 : span(1, 8), angle = span(5, 80), shadow = random() < 0.7, aim = [span(-1, 1), span(0, 2), span(-1, 1)];
		const scene = stage();
		addBox(scene, "wall", min, max);
		const light = addLight(scene, "l", type, { x: L[0], y: L[1], z: L[2] }, { intensity: 10, range, angle, shadow }, type === "spot" ? { x: aim[0], y: aim[1], z: aim[2] } : null);
		const got = row(facts(scene, [light]), "l");
		const axis = aim.map((v, a) => v - L[a]), axisLength = Math.hypot(...axis);
		let lit = 0, hidden = 0, out = { range: 0, cone: 0 };
		for (const p of BODY) {
			const d = Math.hypot(...p.map((v, a) => v - L[a]));
			if (range > 0 && d >= range) { out.range++; continue; }
			const cos = p.reduce((s, v, a) => s + (v - L[a]) * axis[a], 0) / (d * axisLength);
			if (type === "spot" && cos <= Math.cos((angle * Math.PI) / 180)) { out.cone++; continue; }
			if (shadow && d > 0.03 && slab(p, L, min, max)) { hidden++; continue; }
			lit++;
		}
		assert.equal(got.reach, Math.round((lit / BODY.length) * 100) / 100, JSON.stringify({ type, L, min, max, range, angle, shadow, got }));
		assert.equal(got.shadow?.share ?? 0, hidden ? Math.round((hidden / (BODY.length - out.range - out.cone)) * 100) / 100 : 0);
		if (!lit) assert.equal(got.why, [["range", out.range], ["cone", out.cone], ["shadow", hidden]].reduce((a, b) => (b[1] > a[1] ? b : a))[0]);
		// side: the angle at the body's centre between the camera and the light; left or right of the camera's vertical plane; up and down
		const c = [0, 0.9, 0], toL = L.map((v, a) => v - c[a]), n = Math.hypot(...toL), toC = [0, 1.2 - 0.9, 5], m = Math.hypot(...toC);
		const deg = (Math.acos(toL.reduce((s, v, a) => s + v * toC[a], 0) / (n * m)) * 180) / Math.PI;
		const right = [1, 0, 0], across = toL[0] * right[0] / n, up = toL[1] / n;
		const want = [deg < 60 ? "front" : deg > 120 ? "back" : "side", across > 0.25 ? "right" : across < -0.25 ? "left" : null, up > Math.sin(Math.PI / 12) ? "above" : up < -Math.sin(Math.PI / 12) ? "below" : null].filter(Boolean).join("-");
		assert.equal(got.side, want);
		sides.add(want);
		if (hidden) shadowed++;
		checked++;
	}
	assert.ok(shadowed > 40 && sides.size >= 8, `the inputs cover shadows (${shadowed}) and sides (${[...sides].join(" ")})`);
	console.log(`  ${checked} inputs, ${shadowed} with a cast shadow, ${sides.size} distinct sides`);
});

test("lightingChecks adds the facts to each subject row while a stage scene is published", () => {
	const scene = stage();
	setStageScene(scene);
	try {
		const state = { frame: 0, camera: { position: { x: 0, y: 1.2, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 }, filmback: { sensorId: "super35" },
			characters: [{ id: "hero", x: 0, z: 0 }], objects: [], stage: { keyLight: { x: 6, y: 9, z: 4, intensity: 0.9 } } };
		const ports = { renderFrameBuffer: () => dark, bounds: () => bounds };
		const subject = lightingChecks([], state, ports).subjects[0];
		assert.deepEqual(Object.keys(subject), ["id", "meanLuma", "contrast", "litToShade", "lights"]);
		assert.deepEqual(subject.lights.map((r) => r.id), ["key"]);
	} finally { setStageScene(null); }
});

// The actions: add, change and remove a light through the registry, each one undo step.
const f = objectsFixture([]);
try {
	test("object.add / object.set / object.remove a directional light aimed at a record, each undoable", () => {
		const target = f.run("object.add", { kind: "cube", name: "Crate", placement: { x: 1, y: 0, z: 0 } }, "agent").affectedIds[0];
		const added = f.run("object.add", { kind: "directional-light", name: "Window", placement: { x: -3, y: 4, z: 1 } }, "agent");
		assert.equal(added.ok, true, JSON.stringify(added));
		const id = added.affectedIds[0], read = () => f.store.current.objects.find((o) => o.id === id);
		assert.equal(read().light.type, "directional");
		const set = f.run("object.set", { id, set: { light: { aim: { id: target }, intensity: 2 } } }, "agent");
		assert.equal(set.ok, true, JSON.stringify(set));
		assert.deepEqual([read().light.aim, read().light.intensity], [{ id: target }, 2]);
		assert.equal(f.run("edit.undo", { receiptId: set.receiptId }, "agent").status, "undone");
		assert.deepEqual([read().light.aim, read().light.intensity], [null, 1]);
		const removed = f.run("object.remove", { ids: [id] }, "agent");
		assert.equal(removed.ok, true);
		assert.equal(read(), undefined);
		assert.equal(f.run("edit.undo", { receiptId: removed.receiptId }, "agent").status, "undone");
		assert.equal(read().light.type, "directional");
	});
} finally { f.dispose(); }

if (failures) process.exit(1);
