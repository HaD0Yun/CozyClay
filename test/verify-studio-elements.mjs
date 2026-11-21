#!/usr/bin/env node
import assert from "node:assert/strict";
import { STUDIO_ELEMENTS, elementByPath, elementsFor, isSettableElement } from "../src/studio-elements.js";
import { buildPatchSchema, patchValueSchema, STUDIO_PATCHABLE_PATHS, STUDIO_PATCH_KINDS, validateStudioSchema } from "../src/studio-agent-protocol.js";
import { createCharacterEntry, createSceneStage } from "../src/scenes.js";
import { normalizeSceneObject, updateSceneObject } from "../src/scene-objects.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";
import { STUDIO_ACTION_IDS } from "../src/studio-actions.js";

const normalizers = {
	createCharacterEntry,
	createSceneStage,
	normalizeSceneObject,
	repairCamera: (camera) => createShotAuthoringDocument({ frameCount: 96, shots: [{ id: "shot-test", startFrame: 0, endFrame: 95, camera }] }).shots[0].camera,
};
const allowedTypes = new Set(["number", "string", "boolean", "vec3", "color", "enum", "id", "image", "array", "object"]);
const allowedDomains = new Set(["cast", "objects", "shot", "stage", null]);
const allowedNormalizers = new Set([...Object.keys(normalizers), null]);

function validate(entries) {
	const paths = new Set();
	for (const entry of entries) {
		assert.equal(typeof entry.path, "string");
		assert.ok(entry.path && !paths.has(entry.path), `duplicate path: ${entry.path}`);
		paths.add(entry.path);
		assert.ok(allowedTypes.has(entry.type), `unknown type: ${entry.path}`);
		assert.equal(typeof entry.persisted, "boolean", entry.path);
		assert.equal(Object.hasOwn(entry, "agentExposure"), false, `no separate agent allowlist: ${entry.path}`);
		assert.ok(allowedDomains.has(entry.undoDomain), `unknown undo domain: ${entry.path}`);
		assert.ok(allowedNormalizers.has(entry.normalizer), `unknown normalizer: ${entry.normalizer}`);
		if (entry.type === "enum") assert.ok(Array.isArray(entry.enum) && entry.enum.length > 0, entry.path);
		// An element the agent reaches through the action registry names the
		// registered action ids that edit it; no other exposure lists actions.
		if (entry.actions !== undefined) {
			assert.ok(Array.isArray(entry.actions) && entry.actions.length > 0, `action element without actions: ${entry.path}`);
			for (const id of entry.actions) assert.ok(STUDIO_ACTION_IDS.includes(id), `unregistered action ${id} on ${entry.path}`);
		} else assert.equal(entry.actions, undefined, `actions on a non-action element: ${entry.path}`);
		if (entry.type === "vec3") {
			for (const axis of ["x", "y", "z"]) {
				if (entry.min !== undefined) assert.ok(Number.isFinite(entry.min[axis]), `${entry.path}.${axis}`);
				if (entry.max !== undefined) assert.ok(Number.isFinite(entry.max[axis]), `${entry.path}.${axis}`);
				if (entry.min !== undefined && entry.max !== undefined) assert.ok(entry.min[axis] <= entry.max[axis], `${entry.path}.${axis}`);
			}
		} else {
			if (entry.min !== undefined) assert.ok(Number.isFinite(entry.min), entry.path);
			if (entry.max !== undefined) assert.ok(Number.isFinite(entry.max), entry.path);
			if (entry.min !== undefined && entry.max !== undefined) assert.ok(entry.min <= entry.max, entry.path);
		}
	}
}

validate(STUDIO_ELEMENTS);
assert.throws(() => validate([STUDIO_ELEMENTS[0], STUDIO_ELEMENTS[0]]), /duplicate path/);
assert.throws(() => validate([{ ...STUDIO_ELEMENTS[0], normalizer: "unknown" }]), /unknown normalizer/);
assert.throws(() => validate([{ ...STUDIO_ELEMENTS[0], undoDomain: "unknown" }]), /unknown undo domain/);
assert.throws(() => validate([{ ...elementByPath("shot.crud"), actions: ["shot.teleport"] }]), /unregistered action/);
assert.throws(() => validate([{ ...elementByPath("shot.crud"), actions: [] }]), /without actions/);
assert.equal(isSettableElement(elementByPath("shot.crud")), false);
assert.deepEqual([...elementByPath("shot.crud").actions].sort(), ["shot.create", "shot.duplicate", "shot.remove", "shot.reorder", "shot.setRange", "shot.split"]);
// The capabilities that were agent exposure gaps now run through registered actions.
const exposedThroughActions = {
	"character.waypoints": ["character.addWaypoint", "character.clearWaypoints", "character.moveWaypoint", "character.removeWaypoint"],
	"character.ikKeys": ["character.clearIkKeys", "character.removeIkKey", "character.setIkKey"],
	"object.attach": ["object.attach", "object.detach"],
	"shot.cameraRail": ["shot.clearCameraRail", "shot.setCameraRail"],
	"view.partColoursGuideModeInset": ["view.setGhosts", "view.setGuideMode", "view.setInset", "view.setPartColours"],
	scenes: ["scene.create", "scene.delete", "scene.duplicate", "scene.rename", "scene.switch"],
	project: ["project.save"],
	"object.cutout": ["asset.import"],
};
for (const [path, actions] of Object.entries(exposedThroughActions)) {
	assert.equal(isSettableElement(elementByPath(path)), false, `${path} is owned by commands`);
	assert.deepEqual([...elementByPath(path).actions].sort(), actions, `${path} actions`);
}
assert.ok(Object.isFrozen(STUDIO_ELEMENTS));
for (const entry of STUDIO_ELEMENTS) {
	assert.ok(Object.isFrozen(entry), entry.path);
	if (entry.enum) assert.ok(Object.isFrozen(entry.enum), entry.path);
	if (entry.actions) assert.ok(Object.isFrozen(entry.actions), entry.path);
	assert.equal(elementByPath(entry.path), entry);
}
assert.equal(elementByPath("missing.path"), undefined);
assert.equal(elementByPath("object.position").note, "y is the object's base: y=0 rests on the floor; height/supportY rise from it");
assert.equal(elementByPath("character.position").note, "y is the feet");
for (const name of [...Object.keys(normalizers), null]) {
	assert.deepEqual(elementsFor(name), STUDIO_ELEMENTS.filter((entry) => entry.normalizer === name));
}

const get = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
const rail = [{ x: -2, z: 1 }, { x: 3, z: 4 }];
const framing = { pos: { x: 2, y: 3, z: 4 }, yaw: 0.25, pitch: -0.2, fovDeg: 42 };

const shotDocument = (shot) => createShotAuthoringDocument({ frameCount: 96, shots: [{ id: "shot-test", startFrame: 0, endFrame: 95, ...shot }] }).shots[0];

function makeCase(entry) {
	if (entry.path === "shot.targetModel") {
		const input = { targetModel: "seedance-2.5" };
		return { input, output: shotDocument(input), read: (output) => output.targetModel ?? null };
	}
	if (entry.normalizer === "createCharacterEntry") {
		const input = { id: "char-test", model: "y-bot-tpose", layer: { waypoints: [], promptClips: [] }, motionRef: { url: "https://example.test/original.npz" } };
		const field = entry.path.slice("character.".length);
		if (field === "tint") input.tint = "#a1b2c3";
		if (field === "identityImage") input.identityImage = "data:image/png;base64,AAAA";
		if (field === "pose") input.pose = { id: "pose-authored", label: "Authored", bones: { hips: [0, 0, 0, 1] } };
		if (field === "position") Object.assign(input, { x: 1.25, y: 2.5, z: -3.75 });
		if (field === "rot") input.rot = 15;
		if (field === "scale") input.scale = 1.75;
		if (field === "subject") input.subject = "authored-test";
		if (field === "hidden") input.hidden = true;
		if (field === "parent") input.parent = "car-object";
		if (field === "model") input.model = "x-bot-tpose";
		if (field === "posture") input.posture = "sit";
		if (field === "promptBlocks") input.layer.promptClips = [{ id: "prompt-authored", startFrame: 12, endFrame: 36, prompt: "Walk forward" }];
		if (field === "waypoints") input.layer.waypoints = [{ id: "waypoint-authored", frame: 24, x: 1, z: 2, heading: null }];
		if (field === "motionRef.url") input.motionRef.url = "https://example.test/authored.npz";
		if (field === "motionRef.motionId") input.motionRef = { motionId: "a".repeat(64), url: "https://example.test/authored.npz" };
		return { input, output: createCharacterEntry(input), read: (output) => field === "position" ? [output.x, output.y, output.z] : field === "promptBlocks" ? output.layer.promptClips : field === "waypoints" ? output.layer.waypoints : field === "pose" ? output.pose?.id ?? null : get(output, field) };
	}
	if (entry.normalizer === "createSceneStage") {
		const input = { characters: [], shotAspect: "16:9", keyLight: { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 } };
		const field = entry.path.slice("stage.".length);
		if (field === "camera") input.shotAspect = "9:16";
		if (field === "cameraPresetId") input.cameraPresetId = "wide";
		if (field === "sensorId") input.sensorId = "super35";
		if (field === "environmentImage") input.environmentImage = "data:image/png;base64,BBBB";
		if (field === "environment") input.environment = "a rainy rooftop at dusk";
		if (field === "style") input.style = "handheld 16mm, sodium streetlight";
		if (field === "hasEnvSheet") input.hasEnvSheet = true;
		if (field.startsWith("keyLight.")) input.keyLight = { x: -1.5, y: 7.25, z: 2.5, intensity: 2.75, warmth: 0.25, color: "#9db6e6" };
		if (field.startsWith("lighting.")) input.lighting = { preset: "night", sky: "#0b1426", skyTop: "#020408", ambient: 0.6, hemiSky: "#34507f", hemiGround: "#0a0c12", fill: 0.25, fog: 0.45, exposure: 1.4, shadowSoftness: 0.75, envLight: 1.3, ao: 0.8, hdr: "builtin:night-street", hdrRotation: 30, hdrIntensity: 1.5, hdrBackground: false };
		return { input, output: createSceneStage(input), read: (output) => field.includes(".") ? get(output, field) : field === "camera" ? output.shotAspect : output[field] };
	}
	if (entry.normalizer === "normalizeSceneObject") {
		const field = entry.path.slice("object.".length);
		const input = { id: "object-test", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, name: "Cube", color: "#c2c6c8", parent: null, path: null };
		if (field === "renderer") input.renderer = "sphere";
		if (field === "position") Object.assign(input, { x: 1.25, y: 2.5, z: -3.75 });
		if (field === "rotation") Object.assign(input, { rot: 15, rotX: 25, rotZ: -35 });
		if (field === "scale") Object.assign(input, { scaleX: 1.25, scaleY: 1.5, scaleZ: 1.75 });
		if (field === "name") input.name = "Authored prop";
		if (field === "color") input.color = "#a1b2c3";
		if (field === "opacity") input.opacity = 0.3;
		if (field === "material") input.material = "wood";
		if (field === "finish") input.finish = "gloss";
		if (field === "parent") input.parent = "parent-object";
		if (field === "attach") input.attach = { characterId: "char-test", bone: "rightHand" };
		if (field === "path") input.path = { points: [{ x: 1, y: 0, z: 2 }, { x: 4, y: 1, z: 5 }] };
		if (field === "cutout") Object.assign(input, { renderer: "cutout", assetId: "image-authored", aspect: 1.5, height: 2 });
		if (field === "light") Object.assign(input, { renderer: "light", light: { type: "spot", color: "#FFAA00", intensity: 40, range: 12, angle: 35, softness: 0.5, shadow: true, flicker: 0.2, aim: { x: 0, y: 0, z: 1 } } });
		if (field === "glow") input.glow = { color: "#ff5a1f", intensity: 6, halo: 2 };
		if (field === "grasp") input.grasp = { grip: { at: [0, 0.1, 0], axis: [0, 2, 0], thumb: [0, 1, 0] } };
		if (field === "effect") Object.assign(input, { renderer: "effect", effect: { preset: "fire", rate: 12 } });
		if (field === "text") Object.assign(input, { renderer: "text", text: { value: "Authored words", size: 0.5, depth: 0.04, align: "left" } });
		return {
			input,
			output: normalizeSceneObject(input),
			read: (output) => field === "position" ? [output.x, output.y, output.z]
				: field === "rotation" ? [output.rot, output.rotX, output.rotZ]
				: field === "scale" ? [output.scaleX, output.scaleY, output.scaleZ]
				: field === "cutout" ? output.assetId
				: field === "effect" ? [output.effect.preset, output.effect.rate, output.effect.additive] : get(output, field),
		};
	}
	if (entry.normalizer === "repairCamera") {
		const input = { mode: "rail", cameraRail: rail, railFollow: null, craneHeight: null, dollyTiming: null, followCam: {} };
		return { input, output: normalizers.repairCamera(input), read: (output) => output.cameraRail };
	}
	return null;
}

const expected = new Map([
	["character.position", [1.25, 2.5, -3.75]],
	["character.rot", 15],
	["character.scale", 1.75],
	["character.subject", "authored-test"],
	["character.hidden", true],
	["character.parent", "car-object"],
	["character.model", "x-bot-tpose"],
	["character.posture", "sit"],
	["character.promptBlocks", [{ id: "prompt-authored", startFrame: 12, endFrame: 36, prompt: "Walk forward" }]],
	["character.waypoints", [{ id: "waypoint-authored", frame: 24, x: 1, z: 2, heading: null }]],
	["character.motionRef.url", "https://example.test/authored.npz"],
	["character.motionRef.motionId", "a".repeat(64)],
	["character.tint", "#a1b2c3"],
	["character.identityImage", "data:image/png;base64,AAAA"],
	["character.pose", "pose-authored"],
	["stage.camera", "9:16"],
	["stage.cameraPresetId", "wide"],
	["stage.sensorId", "super35"],
	["stage.keyLight.x", -1.5],
	["stage.keyLight.y", 7.25],
	["stage.keyLight.z", 2.5],
	["stage.keyLight.intensity", 2.75],
	["stage.keyLight.warmth", 0.25],
	["stage.keyLight.color", "#9db6e6"],
	["stage.lighting.preset", "night"],
	["stage.lighting.sky", "#0b1426"],
	["stage.lighting.skyTop", "#020408"],
	["stage.lighting.ambient", 0.6],
	["stage.lighting.hemiSky", "#34507f"],
	["stage.lighting.hemiGround", "#0a0c12"],
	["stage.lighting.fill", 0.25],
	["stage.lighting.fog", 0.45],
	["stage.lighting.exposure", 1.4],
	["stage.lighting.shadowSoftness", 0.75],
	["stage.lighting.envLight", 1.3],
	["stage.lighting.ao", 0.8],
	["stage.lighting.hdr", "builtin:night-street"],
	["stage.lighting.hdrRotation", 30],
	["stage.lighting.hdrIntensity", 1.5],
	["stage.lighting.hdrBackground", false],
	["stage.environmentImage", "data:image/png;base64,BBBB"],
	["stage.environment", "a rainy rooftop at dusk"],
	["stage.style", "handheld 16mm, sodium streetlight"],
	["stage.hasEnvSheet", true],
	["shot.targetModel", "seedance-2.5"],
	["shot.cameraRail", rail],
	["object.renderer", "sphere"],
	["object.position", [1.25, 2.5, -3.75]],
	["object.rotation", [15, 25, -35]],
	["object.scale", [1.25, 1.5, 1.75]],
	["object.name", "Authored prop"],
	["object.color", "#a1b2c3"],
	["object.opacity", 0.3],
	["object.material", "wood"],
	["object.finish", "gloss"],
	["object.parent", "parent-object"],
	["object.attach", { characterId: "char-test", bone: "rightHand" }],
	["object.path", { points: [{ x: 1, y: 0, z: 2 }, { x: 4, y: 1, z: 5 }], marks: [], timing: null, speed: 0, faceTravel: true, loop: false, extend: false }],
	["object.cutout", "image-authored"],
	["object.light", { type: "spot", color: "#ffaa00", intensity: 40, range: 12, angle: 35, softness: 0.5, shadow: true, flicker: 0.2, aim: { x: 0, y: 0, z: 1 } }],
	["object.glow", { color: "#ff5a1f", intensity: 6, halo: 2 }],
	["object.grasp", { grip: { at: [0, 0.1, 0], axis: [0, 1, 0], thumb: [0, 1, 0] } }],
	["object.effect", ["fire", 12, true]],
	["object.text", { value: "Authored words", size: 0.5, depth: 0.04, align: "left" }],
]);

let verified = 0;
for (const entry of STUDIO_ELEMENTS) {
	if (!entry.persisted || !entry.normalizer) continue;
	const testCase = makeCase(entry);
	assert.ok(testCase, `no fixture for ${entry.path}`);
	const expectedValue = expected.get(entry.path);
	assert.notEqual(expectedValue, undefined, `no non-default fixture for ${entry.path}`);
	assert.deepEqual(testCase.read(testCase.output), expectedValue, `persistence lost ${entry.path}`);
	verified += 1;
}

/* Reverse completeness: every element the table exposes to the agent as a
 * patch is carriable by the generated patch schema, and nothing else is. */
const generated = buildPatchSchema(STUDIO_ELEMENTS);
const sample = {
	number: (entry) => (entry.min ?? 0) + ((entry.max ?? 1) - (entry.min ?? 0)) / 2,
	boolean: () => true,
	enum: (entry) => entry.enum[0],
	id: () => "sample-id",
	color: () => "#a1b2c3",
	image: () => "data:image/png;base64,AAAA",
	vec3: () => ({ x: 1, y: 2, z: 3 }),
	string: () => "sample text",
	object: (entry) => (entry.path === "object.light" ? { type: "point", intensity: 0.45, flicker: 0.6, aim: null }
		: entry.path === "object.effect" ? { preset: "smoke", rate: 30, wind: { x: 0.1 } }
			: entry.path === "object.text" ? { value: "CozyClay", size: 0.4, depth: 0, align: "center" } : { color: "#ff5a1f", intensity: 6, halo: 2 }),
	array: (entry) => (entry.path === "shot.subjectIds" ? ["first", "second", "third"] : entry.path === "object.path"
		? { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }] }
		: entry.path === "shot.cameraKeys"
			? [{ frame: 4, framing: { pos: { x: 0, y: 1, z: 2 }, yaw: 0.1, pitch: -0.2, fovDeg: 40 } }]
			: [{ startFrame: 0, endFrame: 24, text: "walk" }]),
};
let patchable = 0;
for (const entry of STUDIO_ELEMENTS) {
	const kind = STUDIO_PATCH_KINDS.find((candidate) => entry.path.startsWith(`${candidate}.`));
	if (!isSettableElement(entry)) {
		if (kind) assert.equal(STUDIO_PATCHABLE_PATHS[kind].includes(entry.path), false, `${entry.path} is not exposed for patching`);
		continue;
	}
	assert.ok(kind, `patch element outside every patch kind: ${entry.path}`);
	const key = entry.path.slice(kind.length + 1);
	assert.ok(patchValueSchema(entry), `no value schema for patch element ${entry.path}`);
	assert.ok(generated[kind].properties[key], `buildPatchSchema omits ${entry.path}`);
	assert.ok(STUDIO_PATCHABLE_PATHS[kind].includes(entry.path), `${entry.path} is missing from the published vocabulary`);
	// The declared value must actually pass its own generated schema.
	validateStudioSchema(generated[kind].properties[key], sample[entry.type](entry));
	patchable += 1;
}
for (const kind of STUDIO_PATCH_KINDS) {
	for (const path of STUDIO_PATCHABLE_PATHS[kind]) assert.equal(isSettableElement(elementByPath(path)), true, `${path} is published without a patch declaration`);
}

/* Transform bounds are one contract: every editor envelope is declared, and
 * each domain repair reaches the same declaration rather than a second set of
 * literals. Camera key frames are the one dynamic exception: their bounds are
 * the owning shot's [startFrame,endFrame] range. These checks intentionally
 * exercise the real normalizers so a divergent hard-coded clamp fails here. */
const transformPaths = new Set([
	"character.position", "character.rot", "character.scale",
	"object.position", "object.rotation", "object.scale",
	"stage.keyLight.x", "stage.keyLight.y", "stage.keyLight.z",
	"stage.keyLight.intensity", "stage.keyLight.warmth",
]);
for (const entry of STUDIO_ELEMENTS.filter(({ path }) => transformPaths.has(path))) {
	if (entry.type === "vec3") {
		assert.deepEqual(Object.keys(entry.min ?? {}).sort(), ["x", "y", "z"], `${entry.path} min axes`);
		assert.deepEqual(Object.keys(entry.max ?? {}).sort(), ["x", "y", "z"], `${entry.path} max axes`);
		for (const axis of ["x", "y", "z"]) {
			assert.ok(Number.isFinite(entry.min[axis]), `${entry.path}.${axis} min`);
			assert.ok(Number.isFinite(entry.max[axis]), `${entry.path}.${axis} max`);
			assert.ok(entry.min[axis] <= entry.max[axis], `${entry.path}.${axis} order`);
		}
	} else {
		assert.ok(Number.isFinite(entry.min), `${entry.path} min`);
		assert.ok(Number.isFinite(entry.max), `${entry.path} max`);
		assert.ok(entry.min <= entry.max, `${entry.path} order`);
	}
}
assert.equal(transformPaths.size, 11);
const characterGizmo = elementByPath("character.position").gizmo;
assert.deepEqual(characterGizmo.min, { x: -4, y: 0, z: -4 });
assert.deepEqual(characterGizmo.max, { x: 4, y: 240, z: 4 });
for (const axis of ["x", "y", "z"]) {
	assert.ok(Number.isFinite(characterGizmo.min[axis]), `character.position gizmo.${axis} min`);
	assert.ok(Number.isFinite(characterGizmo.max[axis]), `character.position gizmo.${axis} max`);
}

const wrapToEntry = (entry, value) => {
	const span = entry.max - entry.min;
	return ((((value - entry.min) % span) + span) % span) + entry.min;
};
const scalarCases = (entry, wrap = false) => {
	const mid = (entry.min + entry.max) / 2;
	return [
		["min-1", entry.min - 1, wrap ? wrapToEntry(entry, entry.min - 1) : entry.min],
		["mid", mid, wrap ? wrapToEntry(entry, mid) : mid],
		["max+1", entry.max + 1, wrap ? wrapToEntry(entry, entry.max + 1) : entry.max],
	];
};
const assertScalarBounds = (entry, normalize, wrap = false, belowExpected = null) => {
	for (const [label, input, expectedValue] of scalarCases(entry, wrap)) {
		assert.equal(normalize(input), label === "min-1" && belowExpected !== null ? belowExpected : expectedValue, `${entry.path} ${label}`);
	}
};
const assertVec3Bounds = (entry, normalize, wrap = false) => {
	for (const axis of ["x", "y", "z"]) {
		const mid = (entry.min[axis] + entry.max[axis]) / 2;
		for (const [label, input, expectedValue] of [
			["min-1", entry.min[axis] - 1, wrap ? wrapToEntry({ min: entry.min[axis], max: entry.max[axis] }, entry.min[axis] - 1) : entry.min[axis]],
			["mid", mid, wrap ? wrapToEntry({ min: entry.min[axis], max: entry.max[axis] }, mid) : mid],
			["max+1", entry.max[axis] + 1, wrap ? wrapToEntry({ min: entry.min[axis], max: entry.max[axis] }, entry.max[axis] + 1) : entry.max[axis]],
		]) {
			assert.equal(normalize(axis, input)[axis], expectedValue, `${entry.path}.${axis} ${label}`);
		}
	}
};

const persistedCharacter = createCharacterEntry({ id: "persisted-character", x: 7, y: 2, z: -7 });
assert.deepEqual({ x: persistedCharacter.x, y: persistedCharacter.y, z: persistedCharacter.z }, { x: 7, y: 2, z: -7 }, "document character positions are not gizmo-clamped");

const characterBase = { id: "bounded-character", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
const characterEntry = (path, axis, value) => {
	const input = { ...characterBase };
	const field = path === "character.position" ? axis : path.slice("character.".length);
	input[field] = value;
	return createCharacterEntry(input)[field];
};
assertVec3Bounds(elementByPath("character.position"), (axis, value) => ({ [axis]: characterEntry("character.position", axis, value) }), false);
assertScalarBounds(elementByPath("character.rot"), (value) => characterEntry("character.rot", "rot", value), true);
assert.equal(characterEntry("character.rot", "rot", 181), -179, "character.rot wraps just above max");
assert.equal(characterEntry("character.rot", "rot", -181), 179, "character.rot wraps just below min");
assert.equal(characterEntry("character.rot", "rot", 270), -90, "character.rot wraps a full-turn-plus value");
assert.equal(characterEntry("character.rot", "rot", 540), -180, "character.rot wraps two full turns");
const characterScale = elementByPath("character.scale");
// Non-positive stature is an intentional invalid-input fallback to canonical
// scale 1; also prove a positive below-min value reaches the declared floor.
assertScalarBounds(characterScale, (value) => characterEntry("character.scale", "scale", value), false, 1);
assert.equal(characterEntry("character.scale", "scale", characterScale.min / 2), characterScale.min, "character.scale positive below-min");

const objectChannels = {
	"object.position": { x: "x", y: "y", z: "z" },
	"object.rotation": { x: "rotX", y: "rot", z: "rotZ" },
	"object.scale": { x: "scaleX", y: "scaleY", z: "scaleZ" },
};
const objectBase = { id: "bounded-object", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, name: "Cube", color: "#c2c6c8", parent: null, path: null };
const normalizedObject = (path, axis, value) => {
	const input = { ...objectBase, [objectChannels[path][axis]]: value };
	return normalizeSceneObject(input);
};
const updatedObject = (path, axis, value) => {
	const field = objectChannels[path][axis];
	const next = updateSceneObject([objectBase], objectBase.id, { [field]: value })[0];
	return next;
};
for (const path of ["object.position", "object.rotation", "object.scale"]) {
	const entry = elementByPath(path);
	const wraps = path === "object.rotation";
	assertVec3Bounds(entry, (axis, value) => ({ [axis]: normalizedObject(path, axis, value)[objectChannels[path][axis]] }), wraps);
	assertVec3Bounds(entry, (axis, value) => ({ [axis]: updatedObject(path, axis, value)[objectChannels[path][axis]] }), wraps);
}

const stageDefaults = createSceneStage(null).keyLight;
for (const path of ["stage.keyLight.x", "stage.keyLight.y", "stage.keyLight.z", "stage.keyLight.intensity", "stage.keyLight.warmth"]) {
	const entry = elementByPath(path);
	const axis = path.slice("stage.keyLight.".length);
	assertScalarBounds(entry, (value) => createSceneStage({ keyLight: { ...stageDefaults, [axis]: value } }).keyLight[axis]);
}
// The stage look's numbers clamp to their declared ranges in the same normalizer.
for (const key of ["ambient", "fill", "fog", "exposure", "shadowSoftness", "envLight", "ao"]) {
	assertScalarBounds(elementByPath(`stage.lighting.${key}`), (value) => createSceneStage({ lighting: { [key]: value } }).lighting[key]);
}

const cameraKeyEntry = elementByPath("shot.cameraKeys");
assert.ok(Number.isFinite(cameraKeyEntry.frameMin), "shot.cameraKeys frame floor");
const cameraKeyFrame = (value) => createShotAuthoringDocument({
	frameCount: 24,
	shots: [{ id: "shot-bounds", startFrame: 5, endFrame: 10, cameraKeys: [{ frame: value, framing }] }],
}).shots[0].cameraKeys[0]?.frame;
assert.equal(cameraKeyFrame(4), 5, "camera key frame below shot range clamps to shot start");
assert.equal(cameraKeyFrame(7), 7, "camera key frame midpoint survives exactly");
assert.equal(cameraKeyFrame(11), 10, "camera key frame above shot range clamps to shot end");

console.log(`elements=${STUDIO_ELEMENTS.length} persisted-verified=${verified} patchable=${patchable}`);
// Every generic writable field is tested above; composite fields name commands.
