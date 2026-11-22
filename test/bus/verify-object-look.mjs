// Practical lights and glow: record normalization, the object.update merge,
// the agent-facing schema, deterministic flicker, the take level reader and
// the practical shadow cap (src/object-look.js).
import assert from "node:assert/strict";
import {
	LIGHT_KIND, LIGHT_MENU_ENTRIES, PRACTICAL_SHADOW_CAP, normalizeObjectLight, normalizeObjectGlow, flickerAt,
	practicalShadows, capPracticalLights, withShadowCapWarnings,
} from "../../src/object-look.js";
import { trackLevel } from "../../src/object-travel.js";
import { createSceneObject, normalizeSceneObject, updateSceneObject, objectPatchFields, isEmptyObject, dropToSurfacePatch, loadScene, serializeScene, OBJECT_MENU_ENTRIES } from "../../src/scene-objects.js";
import { STUDIO_PATCH_SET_SCHEMAS, validateStudioSchema } from "../../src/studio-agent-protocol.js";
import { studioObjectCatalogue } from "../../src/studio-agent-commands.js";
import { elementByPath } from "../../src/studio-elements.js";
import * as THREE from "three";
import { placeObjectLook } from "../../src/scene-light-place.js";
import { renderPass } from "../../src/render-passes.js";
import { LIGHT_INTENSITY_SCALE } from "../../src/object-look.js";

const tests = [];
const test = (name, run) => tests.push([name, run]);

test("catalogue kinds point-light and spot-light create a light record", () => {
	assert.deepEqual(LIGHT_MENU_ENTRIES.map((entry) => entry.kind), ["point-light", "spot-light", "directional-light"]);
	assert.ok(LIGHT_MENU_ENTRIES.every((entry) => OBJECT_MENU_ENTRIES.includes(entry)), "the add menu lists all three");
	const kinds = studioObjectCatalogue().objects.map((entry) => entry.kind);
	assert.ok(kinds.includes("point-light") && kinds.includes("spot-light"), "the agent catalogue lists both");
	assert.ok(elementByPath("object.renderer").enum.includes(LIGHT_KIND));
	const point = createSceneObject("point-light", [], { x: 1, z: 2 });
	const spot = createSceneObject("spot-light", [point]);
	assert.equal(point.renderer, "light");
	assert.equal(point.light.type, "point");
	assert.equal(spot.light.type, "spot");
	assert.equal(spot.id, "spot-light");
	assert.ok(point.y > 1 && spot.y > point.y, "a fresh light hangs above the deck");
	assert.deepEqual(point.footprint, { width: 0, depth: 0 });
	assert.ok(isEmptyObject(point), "a light has no surface, no collision");
	assert.equal(dropToSurfacePatch(point, []), null);
	assert.deepEqual(normalizeSceneObject(point), point, "a fresh light is already normal");
	assert.ok(objectPatchFields(point).includes("light") && !objectPatchFields({ renderer: "cube" }).includes("light"));
});

test("light fields are repaired: defaults, clamps, colour, aim", () => {
	const light = normalizeObjectLight({ type: "spot", color: "#ABC", intensity: 5000, range: -3, angle: 120, softness: 2, shadow: "yes", flicker: -1, aim: { x: 1, y: 0, z: "2" } });
	assert.deepEqual(light, { type: "spot", color: "#aabbcc", intensity: 1000, range: 0, angle: 89, softness: 1, shadow: true, flicker: 0, aim: { x: 1, y: 0, z: 2 } });
	assert.equal(normalizeObjectLight({}, "spot").type, "spot", "the kind it was made as is the fallback type");
	assert.equal(normalizeObjectLight({ type: "area" }).type, "point");
	assert.equal(normalizeObjectLight({ aim: { x: 1, y: NaN, z: 0 } }).aim, null);
	assert.equal(normalizeObjectLight({ intensity: "0.45" }).intensity, 0.45);
	const record = normalizeSceneObject({ id: "lamp", renderer: "spot-light", light: { intensity: 40 } });
	assert.equal(record.renderer, "light", "a kind written as the renderer normalizes to the light renderer");
	assert.equal(record.light.type, "spot");
	assert.equal(normalizeSceneObject({ id: "cube", renderer: "cube", light: { intensity: 4 } }).light, undefined, "only a light carries a light");
});

test("glow is optional on any record, and null removes it", () => {
	assert.equal(normalizeObjectGlow(null), null);
	assert.equal(normalizeObjectGlow("hot"), null);
	assert.deepEqual(normalizeObjectGlow({}), { color: "#ff9a3c", intensity: 4, halo: 1.5 });
	assert.deepEqual(normalizeObjectGlow({ color: "#FF5A1F", intensity: 99, halo: -1 }), { color: "#ff5a1f", intensity: 20, halo: 0 });
	const plain = { id: "ball", renderer: "sphere", x: 0, y: 0, z: 0 };
	assert.equal(Object.hasOwn(normalizeSceneObject(plain), "glow"), false, "an old record comes back without the key");
	const loaded = loadScene(serializeScene([normalizeSceneObject(plain)]));
	assert.deepEqual(loaded.objects[0], normalizeSceneObject(plain), "old scenes round-trip unchanged");
	for (const renderer of ["sphere", "cylinder", "empty", "light"]) {
		const glowing = normalizeSceneObject({ id: renderer, renderer, glow: { intensity: 6 } });
		assert.equal(glowing.glow.intensity, 6, `${renderer} keeps its glow`);
		assert.deepEqual(normalizeSceneObject(glowing), glowing, `${renderer} is a fixed point`);
	}
});

test("object.update merges light and glow over the record's own", () => {
	const lamp = createSceneObject("point-light", []);
	const [warm] = updateSceneObject([lamp], lamp.id, { light: { intensity: 0.45, flicker: 0.6 } });
	assert.deepEqual({ ...warm.light, intensity: undefined, flicker: undefined }, { ...lamp.light, intensity: undefined, flicker: undefined });
	assert.equal(warm.light.intensity, 0.45);
	assert.equal(warm.light.flicker, 0.6);
	const [spot] = updateSceneObject([warm], lamp.id, { light: { type: "spot" } });
	assert.equal(spot.light.type, "spot");
	assert.equal(spot.light.intensity, 0.45, "switching the type keeps the numbers");
	const same = [warm];
	assert.equal(updateSceneObject(same, lamp.id, { light: { intensity: 0.45 } }), same, "a no-op is the same array");
	const cube = createSceneObject("cube", []);
	const [lit] = updateSceneObject([cube], cube.id, { glow: { color: "#ff5a1f" } });
	assert.deepEqual(lit.glow, { color: "#ff5a1f", intensity: 4, halo: 1.5 });
	const [brighter] = updateSceneObject([lit], cube.id, { glow: { intensity: 8 } });
	assert.deepEqual(brighter.glow, { color: "#ff5a1f", intensity: 8, halo: 1.5 });
	const [off] = updateSceneObject([brighter], cube.id, { glow: null });
	assert.equal(off.glow, null);
	assert.equal(Object.hasOwn(normalizeSceneObject(off), "glow"), false);
	assert.equal(updateSceneObject([cube], cube.id, { light: { intensity: 9 } })[0], cube, "a cube ignores a light patch");
});

test("the set schema carries the shapes and their ranges", () => {
	const { light, glow } = STUDIO_PATCH_SET_SCHEMAS.object.properties;
	validateStudioSchema(light, { type: "spot", intensity: 40, angle: 35, aim: { x: 0, y: 0, z: 1 } });
	validateStudioSchema(light, { aim: null });
	validateStudioSchema(glow, null);
	validateStudioSchema(glow, { color: "#ff5a1f", intensity: 6, halo: 2 });
	assert.throws(() => validateStudioSchema(light, { intensity: 1001 }));
	assert.throws(() => validateStudioSchema(light, { angle: 90 }));
	assert.throws(() => validateStudioSchema(light, { glow: 1 }));
	assert.throws(() => validateStudioSchema(glow, { halo: 5 }));
	for (const path of ["object.light", "object.glow"]) assert.match(elementByPath(path).note, /e\.g\./, `${path} note gives an example`);
});

test("flicker is a pure function of id and frame", () => {
	const frames = Array.from({ length: 240 }, (_, index) => index);
	const forward = frames.map((frame) => flickerAt("lighter-flame", frame, 0.6));
	const backward = [...frames].reverse().map((frame) => flickerAt("lighter-flame", frame, 0.6)).reverse();
	const shuffled = new Map();
	for (const frame of [...frames].sort((a, b) => ((a * 7919) % 241) - ((b * 7919) % 241))) shuffled.set(frame, flickerAt("lighter-flame", frame, 0.6));
	assert.deepEqual(backward, forward, "scrubbing backwards sees the same values");
	assert.deepEqual(frames.map((frame) => shuffled.get(frame)), forward, "any evaluation order sees the same values");
	assert.ok(frames.every((frame) => flickerAt("lighter-flame", frame, 0) === 1), "flicker 0 is steady");
	const min = Math.min(...forward), max = Math.max(...forward), mean = forward.reduce((sum, value) => sum + value, 0) / forward.length;
	assert.ok(min >= 1 - 0.65 * 0.6 - 1e-9 && max <= 1 + 0.65 * 0.6 + 1e-9, `bounded: ${min}..${max}`);
	assert.ok(max - min > 0.2, `a lighter visibly flickers: ${min}..${max}`);
	assert.ok(Math.abs(mean - 1) < 0.1, `it wavers about its intensity: mean ${mean}`);
	const candle = frames.map((frame) => flickerAt("lighter-flame", frame, 0.3));
	assert.ok(Math.max(...candle) - Math.min(...candle) < max - min, "a candle wavers less than a lighter");
	const other = frames.map((frame) => flickerAt("candle", frame, 0.6));
	assert.notDeepEqual(other, forward, "each light has its own pattern");
	assert.ok(forward.some((value, index) => index && Math.abs(value - forward[index - 1]) > 0.01), "it changes frame to frame");
});

test("the take level reads a baked lvl track, 1 without one", () => {
	assert.equal(trackLevel("ember", 10, null), 1);
	assert.equal(trackLevel("ember", 10, { objectTracks: new Map() }), 1);
	const lvl = new Float32Array([0, 0.5, 2, 9, NaN]);
	const take = { objectTracks: new Map([["ember", { frameCount: 5, lvl }], ["cig", { frameCount: 5, pos: new Float32Array(15) }]]) };
	assert.deepEqual([0, 1, 2, 3, 4, 12, -3].map((frame) => trackLevel("ember", frame, take)), [0, 0.5, 2, 4, 1, 1, 0]);
	assert.equal(trackLevel("cig", 2, take), 1, "a track without lvl leaves the level at 1");
});

test("at most four practical lights cast shadows; the rest are reported", () => {
	const lights = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ ...createSceneObject("spot-light", []), id, name: id, x: index }));
	lights[1] = { ...lights[1], light: { ...lights[1].light, shadow: false } };
	const objects = [createSceneObject("cube", []), ...lights];
	assert.equal(PRACTICAL_SHADOW_CAP, 4);
	assert.deepEqual(practicalShadows(objects), { casting: ["a", "c", "d", "e"], capped: ["f"], unlit: [] });
	const drawn = capPracticalLights(objects);
	assert.equal(drawn.find((object) => object.id === "f").light.shadow, false);
	assert.equal(drawn.find((object) => object.id === "f").shadowCapped, true);
	assert.equal(drawn.find((object) => object.id === "a"), objects.find((object) => object.id === "a"), "casting lights are untouched");
	const fewer = objects.slice(0, 5);
	assert.equal(capPracticalLights(fewer), fewer, "nothing capped, same array");
	assert.deepEqual(practicalShadows([...objects.slice(0, 6), { ...lights[5], hidden: true }]).capped, [], "a hidden light does not count");
	const result = withShadowCapWarnings({ affectedIds: ["f"], summary: "Updated object." }, objects);
	assert.equal(result.warnings.length, 1);
	assert.equal(result.warnings[0].code, "SHADOW_CAP");
	assert.equal(result.warnings[0].id, "f");
	assert.ok(result.warnings[0].message.length <= 120 && result.warnings[0].message.includes("a, c, d, e"));
	const untouched = { affectedIds: ["a"] };
	assert.equal(withShadowCapWarnings(untouched, objects), untouched, "an edit that does not touch a capped light carries no warning");
});

/** A SceneObject's group as the place pass sees it: the record's content plus,
 * for a light, the three.js light the component mounts. */
function stageGroup(object) {
	const group = new THREE.Group();
	group.position.set(object.x, object.y, object.z);
	group.scale.set(object.scaleX, object.scaleY, object.scaleZ);
	if (object.light) {
		const light = object.light.type === "spot" ? new THREE.SpotLight() : new THREE.PointLight();
		light.position.set(0, 0, 0);
		light.userData.sceneLight = true;
		group.add(light);
	} else group.add(new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshStandardMaterial({ color: "#8a5a44" })));
	return group;
}
const lightOf = (group) => group.children.find((child) => child.isLight);
const haloOf = (group) => group.children.find((child) => child.userData.glowHalo);
const meshOf = (group) => group.children.find((child) => child.isMesh);

test("the place pass follows the take: level scales light, glow and halo; no level is 1", () => {
	const lvl = new Float32Array([1, 0.5, 0, 2]);
	const lamp = { ...createSceneObject("point-light", []), light: normalizeObjectLight({ intensity: 4, color: "#ff8800" }) };
	const ember = { ...createSceneObject("sphere", []), id: "ember", scaleX: 0.01, scaleY: 0.01, scaleZ: 0.01, glow: normalizeObjectGlow({ color: "#ff4a1a", intensity: 6, halo: 3 }) };
	const take = { fps: 24, objectTracks: new Map([[lamp.id, { frameCount: 4, lvl }], [ember.id, { frameCount: 4, lvl }]]) };
	const lampGroup = stageGroup(lamp), emberGroup = stageGroup(ember);
	const sample = (frame) => {
		placeObjectLook(lampGroup, lamp, frame, take);
		placeObjectLook(emberGroup, ember, frame, take);
		return { light: lightOf(lampGroup).intensity, emissive: meshOf(emberGroup).material.emissiveIntensity, halo: haloOf(emberGroup).scale.x, haloShown: haloOf(emberGroup).visible };
	};
	const full = sample(0), half = sample(1), none = sample(2), double = sample(3);
	assert.equal(full.light, 4 * LIGHT_INTENSITY_SCALE);
	assert.equal(lightOf(lampGroup).decay, 2, "physical falloff");
	assert.equal(full.emissive, 6);
	assert.ok(Math.abs(full.halo - 2 * 0.005 * 3 / 0.01) < 1e-9, `halo is 3 x the 5 mm radius: ${full.halo}`);
	assert.deepEqual([half.light, half.emissive, half.halo], [full.light / 2, full.emissive / 2, full.halo / 2]);
	assert.deepEqual([none.light, none.emissive, none.haloShown], [0, 0, false], "level 0 is dark");
	assert.deepEqual([double.light, double.emissive, double.halo], [full.light * 2, full.emissive * 2, full.halo * 2]);
	assert.deepEqual(sample(0), full, "back to frame 0 gives frame 0 again");
	assert.deepEqual(sample(1), half, "any order, same frame, same look");
	placeObjectLook(emberGroup, ember, 0, null);
	assert.equal(meshOf(emberGroup).material.emissiveIntensity, 6, "without a take the level is 1");
	const color = meshOf(emberGroup).material.emissive.getHexString();
	assert.equal(color, new THREE.Color("#ff4a1a").getHexString());
	placeObjectLook(emberGroup, { ...ember, glow: undefined }, 0, null);
	assert.equal(haloOf(emberGroup), undefined, "removing the glow drops the halo");
	assert.equal(meshOf(emberGroup).material.emissive.getHex(), 0, "and restores the material's own emissive");
	assert.equal(meshOf(emberGroup).material.emissiveIntensity, 1);
});

test("a flickering light flickers by frame; a spot aims at its point or hangs down", () => {
	const flame = { ...createSceneObject("point-light", []), light: normalizeObjectLight({ intensity: 0.45, flicker: 0.6 }) };
	const group = stageGroup(flame);
	const values = [0, 1, 2, 3, 4, 5].map((frame) => { placeObjectLook(group, flame, frame, null); return lightOf(group).intensity; });
	assert.ok(new Set(values).size > 3, `the flame wavers: ${values}`);
	placeObjectLook(group, flame, 3, null);
	assert.equal(lightOf(group).intensity, values[3], "frame 3 is frame 3 whenever it is drawn");
	const lamp = { ...createSceneObject("spot-light", []), x: 2, y: 4, z: 1 };
	const spotGroup = stageGroup(lamp);
	placeObjectLook(spotGroup, lamp, 0, null);
	const target = lightOf(spotGroup).target.getWorldPosition(new THREE.Vector3());
	assert.deepEqual(target.toArray().map((value) => Math.round(value * 1000) / 1000), [2, 3, 1], "aim null points down the record's -Y");
	const aimed = { ...lamp, light: { ...lamp.light, aim: { x: 2, y: 0, z: 5 } } };
	placeObjectLook(spotGroup, aimed, 0, null);
	const direction = lightOf(spotGroup).target.getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3(2, 4, 1)).normalize();
	const expected = new THREE.Vector3(0, -4, 4).normalize();
	assert.ok(direction.distanceTo(expected) < 1e-6, "an aim point turns the cone toward it");
	assert.ok(Math.abs(lightOf(spotGroup).angle - (30 * Math.PI) / 180) < 1e-12);
});

test("a halo is beauty-only: the depth and normal passes never draw it", () => {
	const ember = { ...createSceneObject("sphere", []), id: "ember", glow: normalizeObjectGlow({ intensity: 6 }) };
	const group = stageGroup(ember);
	const scene = new THREE.Scene();
	scene.add(group);
	placeObjectLook(group, ember, 0, null);
	const halo = haloOf(group);
	assert.equal(halo.userData.beautyOnly, true);
	assert.equal(halo.material.depthWrite, false);
	assert.equal(halo.castShadow, false);
	const seen = [];
	const capture = { render: () => { seen.push(halo.visible); return new Uint8Array(4); } };
	for (const kind of ["depth", "normal"]) renderPass(capture, scene, new THREE.PerspectiveCamera(), kind);
	assert.deepEqual(seen, [false, false], "hidden while a pass draws");
	assert.equal(halo.visible, true, "and shown again for the beauty render");
});

let failures = 0;
for (const [name, run] of tests) {
	try {
		run();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name}\n${error.stack}`);
	}
}
if (failures) process.exit(1);
