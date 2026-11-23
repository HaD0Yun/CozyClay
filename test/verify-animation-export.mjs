#!/usr/bin/env node
// An old storyboard file opens as an animation copy: readProjectDocument marks
// it wasStoryboard, animationCopyOfStoryboard renames it and drops savedAt, and
// the shot reader drops the storyboard-only shot fields while keeping ranges
// and camera keys. The source object is never changed.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { animationCopyOfStoryboard, createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneDocument } from "../src/scenes.js";
import { readShotAuthoringDocument } from "../src/shot-authoring.js";
import { assetIdForBytes } from "../src/scene-assets.js";

globalThis.crypto ??= webcrypto;

const imageBytes = new Uint8Array([1, 2, 3, 4]);
const imageId = await assetIdForBytes(imageBytes);
const sceneDocument = createSceneDocument("Storyboard");
sceneDocument.scenes[0].objects = [{ id: "poster", renderer: "cutout", assetId: imageId, sourceAssetId: imageId, matteAssetId: "" }];
const key = { id: "key-1", frame: 0, framing: { pos: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: 5, fovDeg: 35 } };
// A v6 shot document as an older build wrote it, with the storyboard fields.
sceneDocument.scenes[0].shotDocument = {
	version: 6, frameCount: 144, waypoints: [],
	shots: [
		{ id: "still-1", name: "Panel 1", startFrame: 0, endFrame: 47, kind: "still", caption: "One", cast: { hero: { x: 1, z: 2, rot: 3 } }, stylizedAssetId: imageId, cameraKeys: [key] },
		{ id: "still-2", name: "Panel 2", startFrame: 48, endFrame: 95, kind: "still", caption: "Two", cast: { hero: { x: 4, z: 5, rot: 6 } }, cameraKeys: [] },
		{ id: "still-3", name: "Panel 3", startFrame: 96, endFrame: 143, kind: "still", caption: "Three", cast: { hero: { x: 7, z: 8, rot: 9 } }, cameraKeys: [] },
	],
};
const envelope = createProjectDocument({
	scenesDocument: sceneDocument,
	workspaceLayout: { hierarchyWidth: 320 },
	name: "Boards",
	assets: [{ id: imageId, type: "image/png", width: 1, height: 1, name: "poster.png", bytes: imageBytes }],
	workflow: { version: 1, nodes: [], edges: [] },
	savedAt: 1700000000000,
});
assert.equal("previsMode" in envelope, false, "a saved project no longer writes previsMode");
const source = { ...envelope, previsMode: "storyboard" };

const read = readProjectDocument(JSON.stringify(source));
assert.equal(read.ok, true);
assert.equal(read.project.wasStoryboard, true, "a storyboard file is recognised");
assert.equal(readProjectDocument(JSON.stringify(envelope)).project.wasStoryboard, undefined, "an animation file is not");
const before = structuredClone(read.project);
const copy = animationCopyOfStoryboard(read.project);
assert.equal(copy.name, "Boards - Animation");
assert.equal(copy.savedAt, null, "the copy is unsaved");
assert.equal(copy.wasStoryboard, false);
assert.deepEqual(copy.assets.map((asset) => asset.id), [imageId]);
assert.deepEqual(read.project, before, "the copy does not mutate the source project");

const shots = readShotAuthoringDocument(copy.scenesDocument.scenes[0].shotDocument);
assert.equal(shots.status, "migrated");
assert.deepEqual(shots.state.shots.map(({ startFrame, endFrame, cameraKeys }) => ({ startFrame, endFrame, keys: cameraKeys.length })), [
	{ startFrame: 0, endFrame: 47, keys: 1 }, { startFrame: 48, endFrame: 95, keys: 0 }, { startFrame: 96, endFrame: 143, keys: 0 },
]);
for (const shot of shots.state.shots) for (const field of ["kind", "caption", "cast", "stylizedAssetId"]) assert.equal(field in shot, false, `${field} is dropped`);
console.log("storyboard open-as-copy PASS: 3 stills read as 3 shots with their ranges and keys; the storyboard fields are dropped");
console.log("storyboard open-as-copy PASS: the copy is renamed and unsaved, and the source project is unchanged");

// Through the real open path (project.open with the browser's file picker, src/domains/scenes.js openProject ->
// applyProject): a storyboard file leaves no file handle, and a following save asks for a new file and never calls
// createWritable of the original handle.
const { readFileSync } = await import("node:fs");
const { projectFixture, ok } = await import("./bus/project-fixture.mjs");
const fixtureText = readFileSync(new URL("./fixtures/previs-v5.cclayproject", import.meta.url), "utf8");
assert.equal(JSON.parse(fixtureText).previsMode, "storyboard", "the fixture is a storyboard file");
const f = projectFixture(), previousWindow = globalThis.window, notices = [], originalWrites = [], copyWrites = [];
f.scope.setToast = (message) => notices.push(typeof message === "function" ? message(false, (english) => english) : String(message));
const original = {
	name: "Previs v5.cclayproject", kind: "file",
	getFile: async () => ({ name: "Previs v5.cclayproject", text: async () => fixtureText, lastModified: 1791504000000 }),
	createWritable: async () => { originalWrites.push("createWritable"); return { write: async () => {}, close: async () => {} }; },
};
const copyHandle = { name: "Previs v5 - Animation.cclayproject", kind: "file", createWritable: async () => ({ write: async (text) => { copyWrites.push(text); }, close: async () => {} }) };
let savePicks = 0;
try {
	globalThis.window = { showOpenFilePicker: async () => [original], showSaveFilePicker: async () => { savePicks += 1; return copyHandle; } };
	ok(await f.run("project.open"));
	assert.equal(f.scope.projectHandleRef.current, null, "a storyboard file opened through the picker leaves no file handle");
	assert.equal(f.project.metadata().name, "Previs v5 - Animation", "it opens as the renamed animation copy");
	assert.ok(notices.some((notice) => /This is a copy: the original file is unchanged/.test(notice)), `the user is told it is a copy (${notices.join(" | ")})`);
	ok(await f.run("project.save"));
	assert.deepEqual(originalWrites, [], "the save never calls createWritable of the original handle");
	assert.equal(savePicks, 1, "the save asks for a new file");
	assert.equal(copyWrites.length, 1, "the copy is written to the new file");
	assert.equal(JSON.parse(copyWrites[0]).name, "Previs v5 - Animation");
	assert.equal(f.scope.projectHandleRef.current, copyHandle, "later saves go to the new file");
} finally { globalThis.window = previousWindow; f.dispose(); }
console.log("storyboard open-as-copy PASS: opened through the picker it keeps no file handle; the next save asks for a new file and never writes the original");
