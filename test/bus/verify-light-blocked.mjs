#!/usr/bin/env node
// A practical light inside a shadow-casting record lights almost nothing (session 1e3d1adc: a street
// lamp's light at y 2.9 inside its 3.2 m pole; 30 -> 90 cd left the measured luma at 0.075). Two
// fixes: a glowing record is self-lit and casts no shadow (object-glow.js), and the receipt that
// places, switches or moves a blocked light or its blocker says LIGHT_BLOCKED, naming the record
// (light-blockers.js).
import assert from "node:assert/strict";
import * as THREE from "three";
import { blockedLights, withLightWarnings } from "../../src/light-blockers.js";
import { normalizeObjectGlow } from "../../src/object-look.js";
import { placeObjectLook } from "../../src/scene-light-place.js";
import { createSceneObject, normalizeSceneObject } from "../../src/scene-objects.js";
import { objectsFixture } from "./objects-fixture.mjs";

let failures = 0;
const test = (name, run) => {
	try { run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n${error.stack}`); }
};
const record = (kind, id, fields = {}) => normalizeSceneObject({ ...createSceneObject(kind, []), id, name: id, ...fields });
const shadowLight = (id, at, fields = {}) => record("point-light", id, { ...at, ...fields, light: { intensity: 30, range: 9, shadow: true } });
// the session's street lamp, as its records were authored (world numbers, base on the floor)
const pole = record("cylinder", "cylinder", { name: "Lamp Pole", x: -1.4, y: 0, z: 0.7, scaleX: 0.08, scaleY: 3.2, scaleZ: 0.08 });
const bulb = record("sphere", "sphere-3", { name: "Lamp Bulb", x: -1.4, y: 3.1, z: 0.7, scaleX: 0.3, scaleY: 0.3, scaleZ: 0.3, glow: normalizeObjectGlow({ color: "#ffb060", intensity: 6, halo: 1.5 }) });
const lamp = shadowLight("point-light-3", { x: -1.4, y: 2.9, z: 0.7 }, { name: "Lamp Light" });
const ids = rows => rows.map(({ light, by }) => `${light.id} in ${by.id}`);

test("the session's lamp light sits inside its pole, which casts shadows", () => {
	assert.deepEqual(ids(blockedLights([pole, bulb, lamp])), ["point-light-3 in cylinder"]);
	const receipt = withLightWarnings({ affectedIds: ["point-light-3"], warnings: [] }, [pole, bulb, lamp]);
	assert.deepEqual(receipt.warnings, [{ code: "LIGHT_BLOCKED", id: "point-light-3",
		message: "Blocked: inside Lamp Pole (cylinder), which casts shadows, so it lights almost nothing. Move it out or set shadow false." }]);
	assert.ok(receipt.warnings[0].message.length <= 120);
	assert.equal(withLightWarnings({ affectedIds: ["cylinder"] }, [pole, bulb, lamp]).warnings?.[0]?.code, "LIGHT_BLOCKED", "moving the pole onto the light warns too");
	const other = { affectedIds: ["sphere-3"] };
	assert.equal(withLightWarnings(other, [pole, bulb, lamp]), other, "an edit that touches neither carries no warning");
});

test("only a light that renders a shadow, inside a shown record that casts one, is blocked", () => {
	const centre = { x: -1.4, y: 3.25, z: 0.7 }, inBulb = shadowLight("in-bulb", centre);
	assert.deepEqual(ids(blockedLights([bulb, inBulb])), [], "a glowing bulb is self-lit and casts no shadow");
	assert.deepEqual(ids(blockedLights([{ ...bulb, glow: undefined }, inBulb])), ["in-bulb in sphere-3"], "the same bulb without glow blocks it");
	assert.deepEqual(ids(blockedLights([pole, { ...lamp, light: { ...lamp.light, shadow: false } }])), [], "a light without a shadow passes through");
	assert.deepEqual(ids(blockedLights([{ ...pole, hidden: true }, lamp])), [], "a hidden record draws nothing");
	assert.deepEqual(ids(blockedLights([pole, { ...lamp, light: { ...lamp.light, type: "directional" } }])), [], "a directional light's place only starts its shadow box");
	const parked = ["a", "b", "c", "d"].map((id, i) => shadowLight(id, { x: 9 - i, y: 1, z: 9 }));
	assert.deepEqual(ids(blockedLights([...parked, pole, lamp])), [], "a light past the shadow cap renders without one");
	const plane = record("plane", "floor", { scaleX: 5, scaleZ: 5 });
	assert.deepEqual(ids(blockedLights([plane, shadowLight("low", { x: 0, y: 0.001, z: 0 })])), [], "a plane is a card, nothing is inside it");
});

test("the primitives by their drawn shape, turned and scaled", () => {
	const ball = record("sphere", "ball", { x: 0, y: 0, z: 0, scaleX: 2, scaleY: 2, scaleZ: 2 });
	assert.deepEqual(ids(blockedLights([ball, shadowLight("c", { x: 0, y: 1, z: 0 })])), ["c in ball"]);
	assert.deepEqual(ids(blockedLights([ball, shadowLight("corner", { x: 0.9, y: 0.15, z: 0.9 })])), [], "inside the box, outside the sphere");
	const cone = record("cone", "cone", { scaleX: 2, scaleY: 2, scaleZ: 2 });
	assert.deepEqual(ids(blockedLights([cone, shadowLight("low", { x: 0.7, y: 0.2, z: 0 }), shadowLight("high", { x: 0.7, y: 1.5, z: 0 })])), ["low in cone"]);
	const capsule = record("capsule", "capsule");
	assert.deepEqual(ids(blockedLights([capsule, shadowLight("mid", { x: 0.3, y: 0.7, z: 0 }), shadowLight("cap", { x: 0.3, y: 0.05, z: 0 })])), ["mid in capsule"]);
	// a 2 m x 0.2 m slab turned 90 deg about z: its 2 m side runs along y, 0.2 m thick toward -x
	const slab = record("cube", "slab", { scaleX: 2, scaleY: 0.2, scaleZ: 1, rotZ: 90, x: 0, y: 0, z: 0 });
	assert.deepEqual(ids(blockedLights([slab, shadowLight("up", { x: -0.1, y: 0.9, z: 0 }), shadowLight("side", { x: 0.9, y: 0.1, z: 0 })])), ["up in slab"]);
	const lamp45 = record("cube", "yawed", { scaleX: 2, scaleZ: 0.2, rot: 45 });
	assert.deepEqual(ids(blockedLights([lamp45, shadowLight("diag", { x: 0.6, y: 0.5, z: -0.6 }), shadowLight("cross", { x: 0.6, y: 0.5, z: 0.6 })])), ["diag in yawed"]);
});

test("a glowing record's meshes cast no shadow while it glows, and cast again without it", () => {
	const ember = { ...createSceneObject("sphere", []), id: "ember", glow: normalizeObjectGlow({ intensity: 6 }) };
	const group = new THREE.Group(), mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshStandardMaterial());
	mesh.castShadow = true;
	group.add(mesh);
	placeObjectLook(group, ember, 0, null);
	assert.equal(mesh.castShadow, false);
	const rebuilt = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	rebuilt.castShadow = true;
	group.add(rebuilt);
	placeObjectLook(group, ember, 1, null);
	assert.equal(rebuilt.castShadow, false, "a mesh added while glowing stops casting on the next pass");
	placeObjectLook(group, { ...ember, glow: undefined }, 2, null);
	assert.deepEqual([mesh.castShadow, rebuilt.castShadow], [true, true]);
});

// The receipts the agent reads: object.set that turns the shadow on, and arrange_objects that moves the pole.
const f = objectsFixture([]);
try {
	const add = (kind, name, placement) => f.run("object.add", { kind, name, placement }, "agent").affectedIds[0];
	const poleId = add("cylinder", "Lamp Pole", { x: -1.4, y: 0, z: 0.7 }), lightId = add("point-light", "Lamp Light", { x: -1.4, y: 2.9, z: 0.7 });
	assert.equal(f.run("object.set", { id: poleId, set: { scale: { x: 0.08, y: 3.2, z: 0.08 } } }, "agent").ok, true);
	const quiet = f.run("object.set", { id: lightId, set: { light: { intensity: 30 } } }, "agent");
	test("receipt: a light without a shadow inside the pole carries no warning", () => assert.deepEqual(quiet.warnings ?? [], []));
	const on = f.run("object.set", { id: lightId, set: { light: { shadow: true } } }, "agent");
	test("receipt: object.set that turns the light's shadow on says LIGHT_BLOCKED, naming the pole", () => {
		assert.equal(on.ok, true, JSON.stringify(on));
		assert.deepEqual(on.warnings?.map(w => [w.code, w.id]), [["LIGHT_BLOCKED", lightId]], JSON.stringify(on.warnings));
		assert.ok(on.warnings[0].message.includes(`Lamp Pole (${poleId})`), on.warnings[0].message);
	});
	const moved = f.run("objects.arrange", { ops: [{ op: "update", id: poleId, position: { world: { x: 0, y: 0, z: 0.7 } } }] }, "agent");
	test("receipt: moving the pole off the light clears it", () => assert.deepEqual((moved.warnings ?? []).filter(w => w.code === "LIGHT_BLOCKED"), [], JSON.stringify(moved)));
} finally { f.dispose(); }

if (failures) { console.error(`${failures} light-blocked check(s) failed`); process.exit(1); }
console.log("light blocked: all checks passed");
