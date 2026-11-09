#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	COZY_SCENE_INPUTS,
	COZY_SCENE_OUTPUTS,
	COZY_SCENE_NODE_TYPE,
	applyCozyScenePatch,
	applyCozySceneRunResult,
	normalizeCozySceneData,
	nextSceneFrame,
	sceneCharacterHandle,
	sceneCharacterIdFromHandle,
	sceneInputSpecs,
	sceneInputsFromEdges,
	sceneTimelinePatch,
	SCENE_TIMELINE_MESSAGE,
	toCozySceneRunRequest,
} from "../src/workflow/cozy-scene-node.js";

const componentSource = readFileSync(new URL("../src/workflow/CozySceneNode.jsx", import.meta.url), "utf8");
const previewStyle = readFileSync(new URL("../src/workflow/cozy-scene-node.css", import.meta.url), "utf8");
assert.match(componentSource, /app\/\?embed=playview/);
assert.match(componentSource, /CozyClay Studio PlayView preview/);
assert.match(componentSource, /publishScenePlayback/);
assert.match(componentSource, /window\.setTimeout/);
assert.match(previewStyle, /cozy-scene-live-frame/);
assert.doesNotMatch(componentSource, /<boxGeometry/);
// #218: a finished render is a thumbnail beside the live previs, never a still
// image in place of it — Play has to have something left to move.
assert.doesNotMatch(componentSource, /className="cozy-scene-render"/);
assert.match(componentSource, /cozy-scene-render-thumb/);
assert.match(previewStyle, /\.cozy-scene-render-thumb/);
assert.match(componentSource, /sceneTimelinePatch/);
assert.match(componentSource, /className="cozy-scene-video"/);
assert.match(componentSource, /cozy-scene-hint/);
{
	const builder = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");
	assert.match(builder, /data-testid="mocap-framing-warning"/, "the H3 form warns before generation when framing may crop mocap landmarks");
	assert.match(builder, /locked camera · character motion only/, "the H3 form states the fixed-camera motion contract");
	assert.match(builder, /onSceneVideo: sendSceneToVideo/, "the Scene node reaches the builder's Video action through decorated data");
	assert.match(builder, /sourceHandle: "render", targetHandle: "input"/, "the added Video node is fed by the Scene render output");
}

const defaults = normalizeCozySceneData({ sceneName: 42, frame: "bad", controls: { camera: { yaw: "35" } } });
assert.equal(defaults.type, COZY_SCENE_NODE_TYPE);
assert.equal(defaults.sceneName, "CozyClay Scene");
assert.equal(defaults.frame, 0);
assert.equal(defaults.controls.camera.yaw, 35);
assert.deepEqual(nextSceneFrame({ frame: 0, frameCount: 3, controls: { playing: true } }), { frame: 1, playing: true });
assert.deepEqual(nextSceneFrame({ frame: 2, frameCount: 3, controls: { playing: true } }), { frame: 2, playing: false });
assert.deepEqual(COZY_SCENE_INPUTS.map(({ id }) => id), ["asset", "motion"]);
assert.deepEqual(COZY_SCENE_OUTPUTS.map(({ id }) => id), ["render", "scene"]);
assert.equal(sceneCharacterHandle("char-a"), "character:char-a");
assert.equal(sceneCharacterIdFromHandle("character:char-a"), "char-a");
assert.equal(sceneCharacterIdFromHandle("motion"), null);
assert.deepEqual(sceneInputSpecs([{ id: "char-a", subject: "Hero" }]).map(({ id }) => id), ["asset", "character:char-a"]);
assert.deepEqual(sceneInputsFromEdges([
	{ source: "image-1", target: "scene-1", targetHandle: "asset" },
	{ source: "motion-1", target: "scene-1", targetHandle: "character:char-a" },
	{ source: "motion-1", target: "scene-1", targetHandle: "character:char-a" },
	{ source: "other", target: "scene-2", targetHandle: "character:char-b" },
], "scene-1"), {
	assetInputs: ["image-1"],
	motionInputs: [{ source: "motion-1", handle: "character:char-a", characterId: "char-a" }],
});

// The take length comes from the embedded Studio, so the slider and the node's
// own preview clock stop where the previs does (#218).
assert.equal(SCENE_TIMELINE_MESSAGE, "cozyclay:scene-timeline");
assert.deepEqual(sceneTimelinePatch({ frameCount: 120, frame: 110 }, { type: SCENE_TIMELINE_MESSAGE, frameCount: 96 }), { frameCount: 96, frame: 95 });
assert.deepEqual(sceneTimelinePatch({ frameCount: 120, frame: 10 }, { type: SCENE_TIMELINE_MESSAGE, frameCount: 240 }), { frameCount: 240, frame: 10 });
assert.equal(sceneTimelinePatch({ frameCount: 96 }, { type: SCENE_TIMELINE_MESSAGE, frameCount: 96 }), null, "an unchanged length writes no state");
assert.equal(sceneTimelinePatch({ frameCount: 96 }, { type: "cozyclay:capture-framing-result", frameCount: 12 }), null, "other frame messages are ignored");
assert.equal(sceneTimelinePatch({ frameCount: 96 }, { type: SCENE_TIMELINE_MESSAGE, frameCount: 0 }), null, "an empty take is not a length");
assert.equal(sceneTimelinePatch({ frameCount: 96 }, null), null);

const changed = applyCozyScenePatch(defaults, { frame: 14, controls: { playing: true, camera: { pitch: -8 } }, assetInputs: ["asset-1"] });
assert.equal(changed.frame, 14);
assert.equal(changed.controls.playing, true);
assert.equal(changed.controls.camera.yaw, 35, "nested camera fields remain controlled when only pitch changes");
assert.equal(changed.controls.camera.pitch, -8);
assert.deepEqual(changed.assetInputs, ["asset-1"]);
assert.equal(defaults.frame, 0, "patching never mutates the original envelope");

const request = toCozySceneRunRequest({ id: "node-1", data: { ...changed, sceneId: "scene-1", motionInputs: ["motion-1"] } }, { projectId: "project-1" });
assert.equal(request.type, COZY_SCENE_NODE_TYPE);
assert.equal(request.nodeId, "node-1");
assert.deepEqual(request.inputs, { asset: ["asset-1"], motion: ["motion-1"] });
assert.deepEqual(request.context, { projectId: "project-1" });

const complete = applyCozySceneRunResult(changed, { jobId: "job-1", renderUrl: "/render.mp4", sceneUrl: "/scene.json" });
assert.equal(complete.status, "complete");
assert.equal(complete.preview, "render");
assert.equal(complete.lastOutput.jobId, "job-1");
const failed = applyCozySceneRunResult(changed, { error: "bridge unavailable" });
assert.equal(failed.status, "error");
assert.equal(failed.statusMessage, "bridge unavailable");

console.log("cozy scene node adapter checks passed");

// The embedded Studio is the Scene node's preview: it must look through the
// shot camera (what capture_framing_png renders), not the editor camera.
{
	const { readFileSync } = await import("node:fs");
	const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
	assert.match(app, /useState\(embedMode\)/, "lookThroughShot defaults to the embed mode");
	assert.match(app, /if \(!lookThroughShot \|\| embedMode\) return undefined;/, "Escape does not leave the shot view inside the embed");
	assert.match(app, /type: "cozyclay:scene-timeline", activeSceneId, frameCount: tlFrameCount/, "the embed announces the take length the Scene node reads");
	console.log("PASS embedded Studio previews through the shot camera");
}
