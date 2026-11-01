#!/usr/bin/env node
// One Studio action registry for the UI and the agent: declarations are data
// shared with the sidecar, implementations are registered by the editor.
import assert from "node:assert/strict";
import { STUDIO_ACTIONS, STUDIO_ACTION_IDS, STUDIO_ACTION_KINDS, studioActionDeclaration, createStudioActionRegistry } from "../src/studio-actions.js";
import { validateStudioCommand, validateStudioSchema } from "../src/studio-agent-protocol.js";
import * as studioActions from "../src/studio-actions.js";
import { FK_TRACKS, IK_TRACKS } from "../src/motion/ik.js";
import { FINGER_TRACK_IDS } from "../src/motion/fingers.js";
import { SCENE_ATTACH_BONES } from "../src/scene-objects.js";
import { GUIDE_MODES } from "../src/shot-guides.js";
import { IMAGE_MODELS } from "../src/shot.js";

const code = expected => error => error?.code === expected;

/* The first batch is declared once, as data. */
const firstBatch = ["shot.create", "shot.createStill", "shot.setCaption", "shot.setCastOverride", "shot.setHold", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.reorder", "object.duplicate"];
const castActions = ["character.move"];
const waypointActions = ["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"];
const ikKeyActions = ["character.setIkKey", "character.removeIkKey", "character.clearIkKeys"];
const attachActions = ["object.attach", "object.detach"];
const railActions = ["shot.setCameraRail", "shot.clearCameraRail", "shot.setCameraMode"];
const shotNameActions = ["shot.rename"];
const viewActions = ["view.setPartColours", "view.setGuideMode", "view.setInset", "view.setGhosts", "view.frame"];
const exportActions = ["export.shotVideo"];
const sceneActions = ["scene.create", "scene.duplicate", "scene.rename", "scene.delete", "scene.switch"];
const projectActions = ["project.save", "project.exportAsAnimation"];
const assetActions = ["asset.import"];
const aiActions = ["ai.prepareShot"];
assert.deepEqual([...STUDIO_ACTION_IDS].sort(), [...firstBatch, ...castActions, ...waypointActions, ...ikKeyActions, ...attachActions, ...railActions, ...shotNameActions, ...viewActions, ...exportActions, ...sceneActions, ...projectActions, ...assetActions, ...aiActions].sort());
assert.deepEqual([...STUDIO_ACTION_KINDS], ["mutation", "transient", "job", "document"]);
assert.ok(Object.isFrozen(STUDIO_ACTIONS));
for (const action of STUDIO_ACTIONS) {
	assert.match(action.id, /^[a-z]+\.[A-Za-z]+$/, action.id);
	assert.ok(STUDIO_ACTION_KINDS.includes(action.kind), action.id);
	assert.equal(typeof action.label, "string", action.id);
	assert.ok(action.description.length > 20, `${action.id} explains itself`);
	assert.equal(action.input.type, "object", action.id);
	assert.equal(action.input.additionalProperties, false, `${action.id} input is closed`);
	if (action.kind === "mutation") assert.ok(["shot", "objects", "cast", "motion"].includes(action.undoDomain), `${action.id} names its undo domain`);
	// A long-running action declares the hub timeout it needs: longer than the
	// 30 s Studio default, never past the hub's 300 s ceiling.
	if (action.timeoutMs !== undefined) assert.ok(Number.isSafeInteger(action.timeoutMs) && action.timeoutMs > 30_000 && action.timeoutMs <= 300_000, `${action.id} timeoutMs`);
	assert.equal(studioActionDeclaration(action.id), action);
	// The declared input is usable by the protocol's own validator.
	if (action.input.required.length === 0) validateStudioSchema(action.input, {});
	else assert.throws(() => validateStudioSchema(action.input, {}), code("INVALID_ARGUMENT"), action.id);
}
assert.equal(studioActionDeclaration("shot.create").kind, "mutation");
assert.equal(studioActionDeclaration("object.duplicate").undoDomain, "objects");
assert.equal(studioActionDeclaration("export.shotVideo").kind, "job");
assert.throws(() => studioActionDeclaration("shot.teleport"), code("INVALID_ARGUMENT"));
// Root waypoints: every action names its character explicitly and addresses a
// waypoint by its frame (unique on a path), the key inspect_studio "motion" shows.
for (const id of waypointActions) {
	const action = studioActionDeclaration(id);
	assert.equal(action.kind, "mutation", id);
	assert.equal(action.undoDomain, "cast", id);
	assert.ok(action.input.required.includes("characterId"), `${id} names its character`);
}
assert.deepEqual(studioActionDeclaration("character.addWaypoint").input.required, ["characterId", "position"]);
assert.deepEqual(validateStudioSchema(studioActionDeclaration("character.addWaypoint").input, { characterId: "char-a", position: { x: 1, z: 2 }, frame: 24 }), { characterId: "char-a", position: { x: 1, z: 2 }, frame: 24 });
assert.throws(() => validateStudioSchema(studioActionDeclaration("character.addWaypoint").input, { characterId: "char-a", position: { x: 1, y: 0, z: 2 } }), code("INVALID_ARGUMENT"), "a root waypoint is a floor point");
assert.throws(() => validateStudioSchema(studioActionDeclaration("character.addWaypoint").input, { characterId: "char-a", position: { x: 1, z: 2 }, frame: 0 }), code("INVALID_ARGUMENT"), "frame 0 is the character's own spot");
assert.deepEqual([...studioActionDeclaration("character.moveWaypoint").input.required].sort(), ["characterId", "frame", "position"]);
assert.deepEqual([...studioActionDeclaration("character.removeWaypoint").input.required].sort(), ["characterId", "frame"]);
assert.deepEqual(studioActionDeclaration("character.clearWaypoints").input.required, ["characterId"]);
// IK keys: one character's IK layer is its motion-domain state, so the undo
// entry restores that character's layer whichever character is active.
for (const id of ikKeyActions) {
	assert.equal(studioActionDeclaration(id).kind, "mutation", id);
	assert.equal(studioActionDeclaration(id).undoDomain, "motion", id);
	assert.ok(studioActionDeclaration(id).input.required.includes("characterId"), id);
}
// The JSON form of a key names exactly the tracks the IK layer keys.
assert.deepEqual([...studioActions.STUDIO_IK_CHAIN_TRACKS], IK_TRACKS.map(track => track.id));
assert.deepEqual([...studioActions.STUDIO_IK_JOINT_TRACKS], [...FK_TRACKS.map(track => track.id), ...FINGER_TRACK_IDS]);
const setIkKey = studioActionDeclaration("character.setIkKey").input;
assert.deepEqual([...setIkKey.required].sort(), ["characterId", "frame", "tracks"]);
assert.deepEqual(Object.keys(setIkKey.properties.tracks.properties).sort(), [...[...IK_TRACKS, ...FK_TRACKS].map(track => track.id), ...FINGER_TRACK_IDS, "placement"].sort());
const unit = { x: 0, y: 0, z: 0, w: 1 };
const ikArgs = { characterId: "char-a", frame: 12, tracks: { leftHand: { q: [unit, unit, unit], baseQ: [unit, unit, unit] }, hips: { q: [unit], p: { x: 0, y: 0.9, z: 0 }, basePos: { x: 0, y: 1, z: 0 } } } };
assert.deepEqual(validateStudioSchema(setIkKey, ikArgs), ikArgs);
assert.throws(() => validateStudioSchema(setIkKey, { ...ikArgs, tracks: { leftElbow: { q: [unit] } } }), code("INVALID_ARGUMENT"), "only keyable tracks");
assert.throws(() => validateStudioSchema(setIkKey, { ...ikArgs, tracks: { head: { q: [{ x: 0, y: 0, z: 0 }] } } }), code("INVALID_ARGUMENT"), "a rotation is a full quaternion");
assert.deepEqual([...studioActionDeclaration("character.removeIkKey").input.required].sort(), ["characterId", "frame"]);
assert.deepEqual(studioActionDeclaration("character.clearIkKeys").input.required, ["characterId"]);
// Attachment: an object rides a character's root or one of the store's attach bones.
for (const id of attachActions) {
	assert.equal(studioActionDeclaration(id).kind, "mutation", id);
	assert.equal(studioActionDeclaration(id).undoDomain, "objects", id);
}
assert.deepEqual([...studioActions.STUDIO_ATTACH_BONES], [...SCENE_ATTACH_BONES]);
const attach = studioActionDeclaration("object.attach").input;
assert.deepEqual([...attach.required].sort(), ["characterId", "objectId"]);
assert.deepEqual(validateStudioSchema(attach, { objectId: "cube-1", characterId: "char-a", bone: "rightHand" }), { objectId: "cube-1", characterId: "char-a", bone: "rightHand" });
assert.deepEqual(validateStudioSchema(attach, { objectId: "cube-1", characterId: "char-a" }), { objectId: "cube-1", characterId: "char-a" }, "no bone is the animated root");
assert.throws(() => validateStudioSchema(attach, { objectId: "cube-1", characterId: "char-a", bone: "tail" }), code("INVALID_ARGUMENT"));
assert.deepEqual(studioActionDeclaration("object.detach").input.required, ["objectId"]);
// Camera rail: floor points in travel order, as many as the shot document keeps.
for (const id of railActions) {
	assert.equal(studioActionDeclaration(id).kind, "mutation", id);
	assert.equal(studioActionDeclaration(id).undoDomain, "shot", id);
}
const rail = studioActionDeclaration("shot.setCameraRail").input;
assert.deepEqual([...rail.required].sort(), ["points", "shotId"]);
assert.equal(rail.properties.points.minItems, 2);
assert.equal(rail.properties.points.maxItems, 512, "shot-authoring.js RAIL_MAX_POINTS");
assert.deepEqual(validateStudioSchema(rail, { shotId: "shot-1", points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }), { shotId: "shot-1", points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] });
assert.throws(() => validateStudioSchema(rail, { shotId: "shot-1", points: [{ x: -2, z: 4 }] }), code("INVALID_ARGUMENT"), "a rail needs two points");
assert.deepEqual(studioActionDeclaration("shot.clearCameraRail").input.required, ["shotId"]);
// View toggles are viewer preferences: transient, never an undo entry.
for (const id of viewActions) {
	assert.equal(studioActionDeclaration(id).kind, "transient", id);
	assert.equal(studioActionDeclaration(id).undoDomain, undefined, id);
}
assert.deepEqual(studioActionDeclaration("view.setPartColours").input.properties.mode.enum, ["off", "flat", "shaded"]);
assert.deepEqual([...studioActionDeclaration("view.setGuideMode").input.properties.mode.enum], [...GUIDE_MODES]);
assert.deepEqual(validateStudioSchema(studioActionDeclaration("view.setInset").input, { collapsed: true }), { collapsed: true });
assert.throws(() => validateStudioSchema(studioActionDeclaration("view.setGuideMode").input, { mode: "fibonacci" }), code("INVALID_ARGUMENT"));
// Exporting a shot video is a long-running job that authors nothing.
const exportVideo = studioActionDeclaration("export.shotVideo");
assert.equal(exportVideo.kind, "job");
assert.equal(exportVideo.undoDomain, undefined);
assert.equal(exportVideo.timeoutMs, 300_000);
assert.deepEqual(exportVideo.input.required, []);
assert.deepEqual(validateStudioSchema(exportVideo.input, { shotId: "shot-1" }), { shotId: "shot-1" });
// Scenes are project-level document work: outside the undo history, each
// addressed by the scene id the context's host carries.
for (const id of sceneActions) {
	assert.equal(studioActionDeclaration(id).kind, "document", id);
	assert.equal(studioActionDeclaration(id).undoDomain, undefined, id);
}
assert.deepEqual(studioActionDeclaration("scene.create").input.required, []);
for (const id of ["scene.duplicate", "scene.delete", "scene.switch"]) assert.deepEqual(studioActionDeclaration(id).input.required, ["sceneId"], id);
assert.deepEqual(validateStudioSchema(studioActionDeclaration("scene.rename").input, { sceneId: "scene-a", name: "Rooftop" }), { sceneId: "scene-a", name: "Rooftop" });
assert.throws(() => validateStudioSchema(studioActionDeclaration("scene.rename").input, { sceneId: "scene-a", name: "  " }), code("INVALID_ARGUMENT"));
// Saving writes the project's current file: document work with no arguments.
assert.equal(studioActionDeclaration("project.save").kind, "document");
assert.deepEqual(studioActionDeclaration("project.save").input.required, []);
assert.deepEqual(Object.keys(studioActionDeclaration("project.save").input.properties), []);
// Importing an asset places one object: an undoable objects edit whose source
// is a data URL or an http(s) URL, never a local path.
const importAsset = studioActionDeclaration("asset.import");
assert.equal(importAsset.kind, "mutation");
assert.equal(importAsset.undoDomain, "objects");
assert.deepEqual([...importAsset.input.required].sort(), ["name", "placeAs", "source"]);
assert.deepEqual([...importAsset.input.properties.placeAs.enum], ["cutout", "backdrop", "mesh"]);
for (const source of ["data:image/png;base64,AAAA", "https://example.test/poster.png", "http://127.0.0.1:5180/chair.glb"]) validateStudioSchema(importAsset.input, { source, name: "poster.png", placeAs: "cutout" });
for (const source of ["/Users/me/poster.png", "file:///tmp/poster.png", "ftp://example.test/poster.png"]) assert.throws(() => validateStudioSchema(importAsset.input, { source, name: "poster.png", placeAs: "cutout" }), code("INVALID_ARGUMENT"), source);
// The Send-to-AI package is a job that answers with its prompt: no external
// call, no motion generation, nothing authored. Its model is one the Studio
// writes image prompts for.
const prepareShot = studioActionDeclaration("ai.prepareShot");
assert.equal(prepareShot.kind, "job");
assert.equal(prepareShot.generation, undefined);
assert.equal(prepareShot.undoDomain, undefined);
assert.deepEqual(prepareShot.input.required, []);
assert.deepEqual([...prepareShot.input.properties.mode.enum], ["image", "video"]);
assert.deepEqual([...prepareShot.input.properties.model.enum], IMAGE_MODELS.map(model => model.id));
assert.deepEqual(validateStudioSchema(prepareShot.input, { mode: "image", model: "flux_2" }), { mode: "image", model: "flux_2" });
assert.throws(() => validateStudioSchema(prepareShot.input, { model: "midjourney" }), code("INVALID_ARGUMENT"));
assert.throws(() => validateStudioSchema(prepareShot.input, { mode: "storyboard" }), code("INVALID_ARGUMENT"));
// Frame ranges are half-open, like every other Studio range.
assert.deepEqual(Object.keys(studioActionDeclaration("shot.setRange").input.properties).sort(), ["range", "shotId"]);
assert.throws(() => validateStudioSchema(studioActionDeclaration("shot.setRange").input, { shotId: "shot-1", range: { startFrame: 10, endFrameExclusive: 10 } }), code("INVALID_ARGUMENT"));

/* Registration refuses malformed or duplicate entries. */
const calls = [];
const state = { shots: 0 };
const registry = createStudioActionRegistry({ readState: () => state });
const entry = (overrides = {}) => ({
	...studioActionDeclaration("shot.remove"),
	available: current => current.shots > 0 || "There are no shots to remove.",
	run: args => { calls.push(args); return { affectedIds: [args.shotId], summary: `Removed ${args.shotId}.` }; },
	...overrides,
});
registry.register(entry());
assert.throws(() => registry.register(entry()), /already registered/);
assert.throws(() => createStudioActionRegistry().register(entry({ run: undefined })), /run/);
assert.throws(() => createStudioActionRegistry().register(entry({ available: undefined })), /available/);
assert.throws(() => createStudioActionRegistry().register(entry({ kind: "sometimes" })), /kind/);
assert.throws(() => createStudioActionRegistry().register(entry({ id: "not an id" })), /id/);
assert.throws(() => createStudioActionRegistry().register(entry({ input: { type: "string" } })), /input/);
registry.register({
	...studioActionDeclaration("shot.create"),
	available: () => true,
	run: () => ({ affectedIds: ["shot-new"], summary: "Added Shot 2." }),
});

/* list(state): available actions carry their schema, unavailable ones their reason. */
const listed = registry.list({ shots: 0 });
assert.deepEqual(listed.map(item => item.id), ["shot.remove", "shot.create"]);
const remove = listed.find(item => item.id === "shot.remove");
assert.equal(remove.available, false);
assert.equal(remove.reason, "There are no shots to remove.");
assert.equal(remove.input, undefined, "an unavailable action does not advertise arguments");
assert.equal(remove.description, studioActionDeclaration("shot.remove").description);
const create = listed.find(item => item.id === "shot.create");
assert.equal(create.available, true);
assert.deepEqual(create.input, studioActionDeclaration("shot.create").input);
assert.equal(create.kind, "mutation");
assert.equal(registry.list({ shots: 2 }).find(item => item.id === "shot.remove").available, true);
// Without an explicit state the registry reads its own.
assert.equal(registry.list().find(item => item.id === "shot.remove").available, false);

/* run(id, args): validated arguments, availability, then the one implementation. */
assert.throws(() => registry.run("shot.remove", { shotId: "shot-1" }), error => error.code === "TARGET_NOT_READY" && /no shots/.test(error.message));
assert.equal(calls.length, 0, "an unavailable action never runs");
state.shots = 1;
assert.throws(() => registry.run("shot.remove", {}), code("INVALID_ARGUMENT"));
assert.throws(() => registry.run("shot.remove", { shotId: "shot-1", extra: true }), code("INVALID_ARGUMENT"));
assert.throws(() => registry.run("shot.remove", { shotId: 7 }), code("INVALID_ARGUMENT"));
assert.throws(() => registry.run("shot.teleport", {}), error => error.code === "INVALID_ARGUMENT" && /shot\.remove/.test(error.message) && /shot\.create/.test(error.message));
assert.equal(calls.length, 0, "invalid arguments never reach the implementation");
assert.deepEqual(registry.run("shot.remove", { shotId: "shot-1" }), { affectedIds: ["shot-1"], summary: "Removed shot-1." });
assert.deepEqual(calls, [{ shotId: "shot-1" }]);
assert.deepEqual(registry.run("shot.create"), { affectedIds: ["shot-new"], summary: "Added Shot 2." }, "args default to {}");
assert.equal(registry.get("shot.create").kind, "mutation");
assert.throws(() => registry.get("shot.teleport"), code("INVALID_ARGUMENT"));

/* An implementation must report what it touched. */
const sloppy = createStudioActionRegistry();
sloppy.register({ ...studioActionDeclaration("shot.create"), available: () => true, run: () => undefined });
assert.throws(() => sloppy.run("shot.create", {}), /affectedIds/);
// Availability must be true or a reason, never a bare false.
const vague = createStudioActionRegistry();
vague.register({ ...studioActionDeclaration("shot.create"), available: () => false, run: () => ({ affectedIds: [], summary: "" }) });
assert.throws(() => vague.list({}), /reason/);

/* A job that runs to its end answers asynchronously, with its output. */
const jobs = createStudioActionRegistry({ readState: () => ({}) });
jobs.register({ ...studioActionDeclaration("export.shotVideo"), available: () => true,
	run: async ({ shotId }) => ({ affectedIds: [shotId], summary: "Exported.", output: { fileName: "cozyclay-shot.mp4", frameCount: 24 } }) });
const pending = jobs.run("export.shotVideo", { shotId: "shot-1" });
assert.equal(typeof pending?.then, "function", "an async action answers with a promise");
assert.deepEqual(await pending, { affectedIds: ["shot-1"], summary: "Exported.", output: { fileName: "cozyclay-shot.mp4", frameCount: 24 } });
const brokenJob = createStudioActionRegistry();
brokenJob.register({ ...studioActionDeclaration("export.shotVideo"), available: () => true, run: async () => ({ summary: "no ids" }) });
await assert.rejects(brokenJob.run("export.shotVideo", {}), /affectedIds/, "a settled result is checked like a synchronous one");

/* The protocol carries the new family and discovery scope. */
assert.deepEqual(validateStudioCommand({ name: "run_action", args: { action: "shot.split", args: { shotId: "shot-1" } } }).args, { action: "shot.split", args: { shotId: "shot-1" } });
assert.equal(validateStudioCommand({ name: "inspect_studio", args: { scope: "actions" } }).args.scope, "actions");

console.log(`studio actions verified: ${STUDIO_ACTIONS.length} declared`);
