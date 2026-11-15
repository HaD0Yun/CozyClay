#!/usr/bin/env node
// Shot document v7: the storyboard fields of v5/v6 (kind, caption, per-shot
// cast overrides, stylized asset) are dropped on read; every other field of an
// older body survives byte-identical.
import assert from "node:assert/strict";
import {
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
	SHOT_AUTHORING_VERSION,
	createShotAuthoringDocument,
	readShotAuthoring,
	readShotAuthoringDocument,
	serializeShotAuthoring,
} from "../src/shot-authoring.js";
import { assetIdFromDigest } from "../src/scene-assets.js";

const STORYBOARD_FIELDS = ["kind", "caption", "cast", "stylizedAssetId"];
const framing = { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0.25, pitch: -0.1, fovDeg: 40 };
const imageId = assetIdFromDigest("ab".repeat(32));

const current = createShotAuthoringDocument({
	frameCount: 240,
	shots: [
		{ id: "shot-a", name: "Hero", startFrame: 0, endFrame: 95, cameraKeys: [{ id: "key-a", frame: 12, framing }], targetModel: "seedance-2.5",
			camera: { mode: "rail", cameraRail: [{ x: -2, z: 1 }, { x: 3, z: 4 }], railFollow: { mode: "range", startFrame: 4, endFrame: 60 }, followCam: { distance: 4 } } },
		{ id: "shot-b", name: "Wide", startFrame: 96, endFrame: 239 },
	],
});
for (const shot of current.shots) for (const field of STORYBOARD_FIELDS) assert.equal(field in shot, false, `a fresh shot has no ${field}`);

// A v6 body as an older build wrote it: the same shots plus the storyboard fields.
for (const version of [4, 5, 6]) {
	const extra = version >= 5 ? { kind: "still", caption: "She looks up.", cast: { "char-a": { x: 1, z: 2, rot: 3 } }, stylizedAssetId: imageId } : {};
	const body = { version, frameCount: 240, waypoints: [{ id: "wp-a", frame: 0, x: 1, z: 2, heading: null }], shots: current.shots.map((shot) => ({ ...shot, ...extra })) };
	const migrated = readShotAuthoringDocument(JSON.parse(JSON.stringify(body)));
	assert.equal(migrated.status, "migrated", `a v${version} body is rewritten as v7, so it reports migrated`);
	assert.equal(JSON.stringify(migrated.state.waypoints), JSON.stringify(body.waypoints));
	migrated.state.shots.forEach((shot, index) => {
		assert.equal(JSON.stringify(shot), JSON.stringify(current.shots[index]), `v${version}: ${shot.id} keeps every other field and drops the storyboard fields`);
	});
	const rewritten = JSON.parse(serializeShotAuthoring(migrated.state));
	assert.equal(rewritten.version, 7);
	assert.equal(readShotAuthoring(JSON.stringify(rewritten)).status, "valid");
	assert.deepEqual(readShotAuthoring(JSON.stringify(rewritten)).state.shots, migrated.state.shots);
}

// Keys step with the version; v6 is the newest legacy body.
assert.equal(SHOT_AUTHORING_VERSION, 7);
assert.equal(SHOT_AUTHORING_KEY, "cozyclay.shot-authoring.v7");
assert.equal(SHOT_AUTHORING_QUARANTINE_KEY, "cozyclay.shot-authoring.v7.quarantine");
assert.deepEqual([...SHOT_AUTHORING_LEGACY_KEYS], ["cozyclay.shot-authoring.v6", "cozyclay.shot-authoring.v5", "cozyclay.shot-authoring.v4", "cozyclay.shot-authoring.v3", "cozyclay.shot-authoring.v2", "cozyclay.shot-authoring.v1"]);
assert.equal(readShotAuthoringDocument({ version: 8, shots: [] }).status, "future");

// A single-frame shot survives with its range.
const single = readShotAuthoringDocument({ version: SHOT_AUTHORING_VERSION, frameCount: 240, waypoints: [], shots: [{ id: "shot-one", name: "Beat", startFrame: 10, endFrame: 10 }] }).state.shots[0];
assert.deepEqual([single.startFrame, single.endFrame], [10, 10]);

console.log("verify-shot-document-v5: ok (v7 drops the storyboard fields)");
