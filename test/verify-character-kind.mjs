#!/usr/bin/env node
// Scene document v5: a cast member may be a rig-free proxy figure and carries
// a persisted posture. v4 documents read forward with every other byte intact.
import assert from "node:assert/strict";
import {
	CHARACTER_KIND_IDS,
	CHARACTER_MODEL_IDS,
	DEFAULT_CHARACTER_MODEL,
	LEGACY_SCENES_STORAGE_KEYS,
	NEW_CHARACTER_MODEL,
	POSTURES,
	PROXY_FIGURE_MODEL,
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	createCharacterEntry,
	createSceneStage,
	isProxyFigure,
	loadSceneDocumentFromStorage,
	migrateScenesDocument,
	readSceneDocument,
} from "../src/scenes.js";
import { elementByPath } from "../src/studio-elements.js";

assert.equal(PROXY_FIGURE_MODEL, "proxy-figure");
assert.deepEqual(CHARACTER_MODEL_IDS, ["y-bot-tpose", "x-bot-tpose"], "the FBX rig ids stay the two shipped rigs");
assert.equal(NEW_CHARACTER_MODEL, "x-bot-tpose", "a new character is the block figure on the X Bot skeleton");
assert.equal(createCharacterEntry({ id: "old" }).model, "y-bot-tpose", "a saved row without a model still loads as before");
assert.deepEqual(CHARACTER_KIND_IDS, [...CHARACTER_MODEL_IDS, PROXY_FIGURE_MODEL]);
assert.deepEqual(POSTURES, ["stand", "sit", "lie"]);

const proxy = createCharacterEntry({ model: "proxy-figure" });
assert.equal(proxy.model, "proxy-figure", "a proxy figure keeps its kind");
assert.equal(proxy.posture, "stand", "posture defaults to stand");
assert.equal(isProxyFigure(proxy), true);
assert.equal(isProxyFigure(createCharacterEntry({})), false);
assert.equal(isProxyFigure(null), false);
assert.equal(createCharacterEntry({ model: "proxy-figure", posture: "lie" }).posture, "lie", "a stored posture survives");
assert.equal(createCharacterEntry({ model: "proxy-figure", posture: "sit" }).posture, "sit");
assert.equal(createCharacterEntry({ model: "proxy-figure", posture: "crouch" }).posture, "stand", "an unknown posture falls back to stand");
assert.equal(createCharacterEntry({ posture: 3 }).posture, "stand");
assert.equal(createCharacterEntry({ model: "nope" }).model, DEFAULT_CHARACTER_MODEL, "an unknown model falls back to the default rig");
assert.equal(createCharacterEntry({ model: "x-bot-tpose" }).model, "x-bot-tpose");

// The element declarations mirror the normalizer's vocabulary.
assert.deepEqual(elementByPath("character.model").enum, CHARACTER_KIND_IDS);
const posture = elementByPath("character.posture");
assert.equal(posture.type, "enum");
assert.equal(posture.persisted, true);
assert.equal(posture.undoDomain, "cast");
assert.equal(posture.normalizer, "createCharacterEntry");
assert.deepEqual(posture.enum, POSTURES);

// A v4 document: normalized v4 entries (no posture key) on the 24 fps clock.
const v4Characters = createSceneStage({ characters: [
	{ id: "char-a", model: "y-bot-tpose", x: 1.5, z: -2, rot: 30, tint: "#a1b2c3", subject: "hero",
		layer: { waypoints: [{ id: "wp-1", frame: 48, x: 1, z: 2, heading: null }], promptClips: [{ id: "clip-1", text: "walks", startFrame: 48, endFrame: 96 }] } },
	{ id: "char-b", model: "x-bot-tpose", scale: 1.2, motionRef: { url: "/ardy/motions/b.npz", prompt: "waves" } },
] }).characters.map(({ posture: _posture, ...entry }) => entry);
const v4Stage = { ...createSceneStage({}), characters: v4Characters };
const v4Document = {
	version: 4,
	activeSceneId: "s-2",
	scenes: [
		{ id: "s-1", name: "One", objects: [{ id: "box", renderer: "cube", x: 2 }], shotDocument: { version: 4, frameCount: 96, shots: [] }, stage: v4Stage },
		{ id: "s-2", name: "Two", objects: [], shotDocument: null, stage: { ...v4Stage, characters: [v4Characters[1]] } },
	],
};
const v4Raw = JSON.stringify(v4Document);
const read = readSceneDocument(v4Raw);
assert.equal(read.status, "migrated");
assert.equal(read.document.version, 5);
const characters = read.document.scenes.flatMap((scene) => scene.stage.characters);
assert.equal(characters.length, 3);
assert.ok(characters.every((character) => character.posture === "stand"), "every v4 cast member reads forward standing");
const stripped = {
	...read.document,
	version: 4,
	scenes: read.document.scenes.map((scene) => ({
		...scene,
		stage: { ...scene.stage, characters: scene.stage.characters.map(({ posture: _posture, ...entry }) => entry) },
	})),
};
assert.equal(JSON.stringify(stripped), v4Raw, "every other v4 field is byte-identical after the read");

// A v5 body round-trips its posture and kind.
const v5 = readSceneDocument(JSON.stringify({ ...read.document, scenes: [{ ...read.document.scenes[0], stage: createSceneStage({ characters: [{ id: "c", model: "proxy-figure", posture: "sit" }] }) }] }));
assert.equal(v5.status, "valid");
assert.equal(v5.document.scenes[0].stage.characters[0].model, "proxy-figure");
assert.equal(v5.document.scenes[0].stage.characters[0].posture, "sit");

// The shared helper the project-file and playground paths call.
const lifted = migrateScenesDocument(v4Document);
assert.equal(lifted.version, SCENES_VERSION);
assert.deepEqual(lifted.scenes[0].stage.characters[0].layer, v4Characters[0].layer, "a v4 body is not retimed a second time");
assert.ok(lifted.scenes.every((scene) => scene.stage.characters.every((character) => character.posture === "stand")));
assert.equal(v4Document.scenes[0].stage.characters[0].posture, undefined, "the source document is not mutated");
const v3Lifted = migrateScenesDocument({ version: 3, activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "c", layer: { waypoints: [{ frame: 40 }], promptClips: [] } }] } }] });
assert.equal(v3Lifted.scenes[0].stage.characters[0].layer.waypoints[0].frame, 48, "a v3 body still moves onto the 24 fps clock");
assert.equal(v3Lifted.scenes[0].stage.characters[0].posture, "stand");
const current = { version: SCENES_VERSION, scenes: [] };
assert.equal(migrateScenesDocument(current), current, "a current document passes through untouched");

// Storage: a v4 key migrates into the v5 key and stays as the backup.
const values = new Map([["cozyclay.scenes.v4", v4Raw]]);
const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
assert.ok(LEGACY_SCENES_STORAGE_KEYS.includes("cozyclay.scenes.v4"));
assert.equal(SCENES_STORAGE_KEY, "cozyclay.scenes.v5");
assert.equal(loadSceneDocumentFromStorage(storage).status, "migrated");
assert.equal(JSON.parse(values.get("cozyclay.scenes.v5")).version, 5);
assert.equal(values.get("cozyclay.scenes.v4"), v4Raw, "the v4 body is kept as a backup");

console.log("all character kind checks PASS");
