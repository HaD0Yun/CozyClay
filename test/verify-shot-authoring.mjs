#!/usr/bin/env node
import assert from "node:assert/strict";
import { removeCameraRail } from "../src/camera-block.js";
import { WORLD } from "../src/world-scale.js";
import {
	createShotAuthoringDocument,
	loadShotAuthoring,
	readShotAuthoring,
	readShotAuthoringDocument,
	serializeShotAuthoring,
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
} from "../src/shot-authoring.js";

const framing = (fovDeg) => ({ pos: { x: 1, y: 1.6, z: 2.4 }, yaw: 0.2, pitch: -0.1, fovDeg });
const followCam = {
	distance: 3.5,
	height: 1.8,
	response: 0.6,
	lead: 0.2,
	railStartMode: "nearest",
	maxDollySpeed: 2.4,
	pitchOffsetDeg: -10,
	orbitOffsetDeg: 180,
};
const cameraRail = [{ x: -2, z: -1 }, { x: 1, z: 5 }];
const shots = [
	{
		id: "wide",
		name: "Wide",
		startFrame: 0,
		endFrame: 99,
		cameraKeys: [{ id: "camera-key-wide", frame: 0, framing: framing(40) }],
		camera: { mode: "keys", followCam, cameraRail: null, railFollow: null, craneHeight: null, dollyTiming: null },
	},
	{
		id: "close",
		name: "Close",
		startFrame: 100,
		endFrame: 299,
		cameraKeys: [{ id: "camera-key-close", frame: 100, framing: framing(70) }],
		camera: { mode: "rail", followCam, cameraRail, railFollow: { mode: "range", startFrame: 10, endFrame: 80 }, craneHeight: null, dollyTiming: null },
	},
];

// v8 writes only the canonical body and round-trips per-shot camera blocks.
const authored = {
	shots,
	waypoints: [{ id: "waypoint-authored", frame: 60, x: 1.5, z: -2, heading: null }],
	frameCount: 300,
	followCam: { enabled: true },
	cameraRail,
};
const document = createShotAuthoringDocument(authored);
assert.deepEqual(Object.keys(document), ["version", "frameCount", "waypoints", "shots"]);
assert.equal(document.version, 8);
const objectRestored = readShotAuthoringDocument(document);
assert.equal(objectRestored.status, "valid");
assert.deepEqual(objectRestored.state, {
	frameCount: 300,
	waypoints: authored.waypoints,
	shots,
});

// The object API is location-independent: nesting under Scene is only a caller concern.
const futureSceneEnvelope = { version: 1, scenes: [{ id: "scene-1", shotDocument: document }] };
assert.deepEqual(readShotAuthoringDocument(futureSceneEnvelope.scenes[0].shotDocument), objectRestored);
assert.equal(readShotAuthoringDocument(undefined).status, "absent");
assert.equal(readShotAuthoringDocument("not-an-object").status, "corrupt");

const raw = serializeShotAuthoring(authored);
assert.deepEqual(JSON.parse(raw), document);
const restored = readShotAuthoring(raw);
assert.equal(restored.status, "valid");
assert.equal(restored.state.frameCount, 300);
assert.deepEqual(restored.state.shots, shots);
assert.deepEqual(restored.state.waypoints, authored.waypoints);
assert.equal("followCam" in restored.state, false);
assert.equal("cameraRail" in restored.state, false);
assert.deepEqual(restored.state.shots[1].camera.railFollow, { mode: "range", startFrame: 10, endFrame: 80 });

const emptyV4 = readShotAuthoring(JSON.stringify({ version: 8, frameCount: 300, shots: [], waypoints: [] }));
assert.equal(emptyV4.status, "valid");
assert.deepEqual(emptyV4.state.shots, [], "zero Shots is a normal persisted state");
const highCamera = readShotAuthoring(JSON.stringify({
	version: 4,
	frameCount: 300,
	shots: [{ startFrame: 0, endFrame: 299, camera: { mode: "follow", followCam: { ...followCam, height: 12, pitchOffsetDeg: 120 } } }],
	waypoints: [],
}));
assert.equal(highCamera.state.shots[0].camera.followCam.height, 12, "camera height has no six-metre persistence ceiling");
assert.equal(highCamera.state.shots[0].camera.followCam.pitchOffsetDeg, 120, "high-camera pitch offset survives persistence");
const gapV4 = readShotAuthoring(JSON.stringify({
	version: 4,
	frameCount: 300,
	shots: [{ startFrame: 20, endFrame: 59 }, { startFrame: 100, endFrame: 139 }],
	waypoints: [],
}));
assert.deepEqual(gapV4.state.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59], [100, 139]]);

// v2 globals become independent camera settings on EVERY repaired shot.
const v2 = readShotAuthoring(JSON.stringify({
	version: 2,
	frameCount: 200,
	shots: shots.map(({ camera, ...shot }) => shot),
	waypoints: [],
	followCam: { enabled: true, ...followCam },
	cameraRail,
	railFollow: { mode: "range", startFrame: 20, endFrame: 90 },
}));
assert.equal(v2.status, "migrated");
assert.equal(v2.state.shots.length, 2);
for (const shot of v2.state.shots) {
	assert.equal(shot.camera.mode, "rail");
	assert.deepEqual(shot.camera.followCam, followCam);
	assert.deepEqual(shot.camera.cameraRail, cameraRail);
	assert.deepEqual(shot.camera.railFollow, { mode: "range", startFrame: 24, endFrame: 108 }, "a v2 rail range is retimed with everything else");
}
assert.notEqual(v2.state.shots[0].camera, v2.state.shots[1].camera);
assert.notEqual(v2.state.shots[0].camera.followCam, v2.state.shots[1].camera.followCam);
assert.notEqual(v2.state.shots[0].camera.cameraRail, v2.state.shots[1].camera.cameraRail);
v2.state.shots[0].camera.followCam.distance = 9;
v2.state.shots[0].camera.cameraRail[0].x = 99;
assert.equal(v2.state.shots[1].camera.followCam.distance, 3.5);
assert.equal(v2.state.shots[1].camera.cameraRail[0].x, -2);

// Migration mode is derived from the old enabled flag and usable rail.
const migrateMode = (enabled, rail) => readShotAuthoring(JSON.stringify({
	version: 2,
	frameCount: 100,
	shots: [{ startFrame: 0, cameraKeys: [] }],
	followCam: { enabled },
	cameraRail: rail,
})).state.shots[0].camera.mode;
assert.equal(migrateMode(false, cameraRail), "keys");
assert.equal(migrateMode(true, null), "follow");
assert.equal(migrateMode(true, [{ x: 0, z: 0 }]), "follow");
assert.equal(migrateMode(true, cameraRail), "rail");

// A v1 roll follows the same migration rules and arrives as one v4 shot.
const v1 = readShotAuthoring(JSON.stringify({
	version: 1,
	frameCount: 200,
	cameraKeys: [{ frame: 10, framing: framing(35) }, { frame: 180, framing: framing(80) }],
	waypoints: [],
	followCam: { enabled: true, distance: 4 },
}));
assert.equal(v1.status, "migrated");
assert.equal(v1.state.shots.length, 1);
assert.deepEqual(v1.state.shots[0].cameraKeys.map((key) => key.frame), [12, 216], "v1 camera keys move onto the 24 fps clock");
assert.equal(v1.state.frameCount, 240, "a 200-frame v1 roll was 10 s and stays 10 s");
assert.equal(v1.state.shots[0].camera.mode, "follow");
assert.deepEqual(v1.state.shots[0].camera.followCam, {
	distance: 4,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
		maxDollySpeed: WORLD.dollySpeed, // no default cap below the world's bound
		pitchOffsetDeg: 0,
		orbitOffsetDeg: 0,
});

// Invalid v4 block fields are repaired independently without leaking globals.
const repaired = loadShotAuthoring(JSON.stringify({
	version: 4,
	frameCount: 100,
	shots: [
		{
			id: "same",
			name: " A ",
			startFrame: 30,
			cameraKeys: [{ frame: -10, framing: framing(20) }],
			camera: {
				mode: "rail",
				followCam: {
					distance: 999,
					lead: -5,
					railStartMode: "middle",
					maxDollySpeed: 999,
					pitchOffsetDeg: -999,
				},
				cameraRail: [{ x: 0, z: 0 }, { x: Infinity, z: 1 }],
			},
		},
		{ id: "same", name: "", startFrame: 70, cameraKeys: [{ frame: 999, framing: framing(90) }], camera: { mode: "orbit" } },
	],
	waypoints: [{ frame: 3.6, x: 1, z: 2, heading: "north" }, { frame: 2, x: Infinity, z: 0 }],
}));
assert.deepEqual(repaired.shots.map((shot) => shot.startFrame), [30, 70]);
assert.equal(new Set(repaired.shots.map((shot) => shot.id)).size, 2);
assert.equal(repaired.shots[0].name, "A");
assert.equal(repaired.shots[0].cameraKeys[0].frame, 30);
assert.equal(repaired.shots[1].cameraKeys[0].frame, 99);
assert.deepEqual(repaired.waypoints.map(({ id, ...waypoint }) => waypoint), [{ frame: 4, x: 1, z: 2, heading: null }]);
assert.deepEqual(repaired.shots[0].camera, {
	mode: "follow",
	followCam: {
		distance: 15,
		height: 1.6,
		response: 0.7,
		lead: 0,
		railStartMode: "head",
		maxDollySpeed: 40,
		pitchOffsetDeg: -170,
		orbitOffsetDeg: 0,
	},
	cameraRail: null,
	railFollow: null,
	craneHeight: null,
				dollyTiming: null,
});
assert.equal(repaired.shots[1].camera.mode, "keys");

// Rail Follow is part of each self-contained Camera Block, not a global.
assert.equal("railFollow" in document, false);
const offRail = loadShotAuthoring(serializeShotAuthoring({
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "off" } } }],
}));
assert.deepEqual(offRail.shots[0].camera.railFollow, { mode: "off" });
assert.deepEqual(removeCameraRail({
	mode: "rail",
	followCam,
	cameraRail,
	railFollow: { mode: "range", startFrame: 10, endFrame: 80 },
}), {
	mode: "follow",
	followCam,
	cameraRail: null,
	railFollow: null,
	craneHeight: null,
				dollyTiming: null,
});
// The crane axis persists with its rail and cannot outlive it.
const cranedRoundTrip = loadShotAuthoring(serializeShotAuthoring({
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "off" }, craneHeight: { start: 3, end: 1.2 } } }],
}));
assert.deepEqual(cranedRoundTrip.shots[0].camera.craneHeight, { points: [{ t: 0, height: 3 }, { t: 1, height: 1.2 }] });
const pointCraneRoundTrip = loadShotAuthoring(serializeShotAuthoring({
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "off" }, craneHeight: { points: [{ t: 0, height: 3 }, { t: 0.4, height: 0.8 }, { t: 1, height: 2 }] } } }],
}));
assert.deepEqual(
	pointCraneRoundTrip.shots[0].camera.craneHeight,
	{ points: [{ t: 0, height: 3 }, { t: 0.4, height: 0.8 }, { t: 1, height: 2 }] },
	"a point crane survives serialize → load untouched",
);
const orphanCrane = loadShotAuthoring(serializeShotAuthoring({
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "follow", craneHeight: { start: 3, end: 1.2 } } }],
}));
assert.equal(orphanCrane.shots[0].camera.craneHeight, null, "a crane without a rail does not persist");

const badRail = loadShotAuthoring(JSON.stringify({
	version: 4,
	frameCount: 100,
	shots: [{ startFrame: 0, camera: { mode: "rail", cameraRail, railFollow: { mode: "range", startFrame: 50, endFrame: 10 } } }],
}));
assert.equal(badRail.shots[0].camera.railFollow, null);

/* ------------------- v3 → v4: the 20 fps → 24 fps clock ------------------- */
// A v3 roll counted frames at 20 fps. Reading those numbers at 24 without
// conversion would turn a 15 s clip into a 12.5 s one and pull every shot
// boundary, camera key and waypoint forward with it. Multiply once, on read.
const v3 = readShotAuthoring(JSON.stringify({
	version: 3,
	frameCount: 300,
	shots: [
		{ id: "wide", name: "Wide", startFrame: 0, endFrame: 99, cameraKeys: [{ id: "camera-key-wide", frame: 0, framing: framing(40) }], camera: { mode: "keys", followCam } },
		{
			id: "close",
			name: "Close",
			startFrame: 100,
			endFrame: 299,
			cameraKeys: [{ id: "camera-key-close", frame: 100, framing: framing(70) }],
			camera: { mode: "rail", followCam, cameraRail, railFollow: { mode: "range", startFrame: 10, endFrame: 80 } },
		},
	],
	waypoints: [{ id: "waypoint-authored", frame: 60, x: 1.5, z: -2, heading: null }],
}));
assert.equal(v3.status, "migrated", "a v3 body is rewritten onto the production clock");
assert.equal(v3.state.frameCount, 360, "a 300-frame 15 s roll stays 15 s as 360 frames");
assert.deepEqual(
	v3.state.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]),
	[[0, 119], [120, 359]],
	"shot boundaries keep their moments and stay gapless"
);
assert.deepEqual(v3.state.shots.map((shot) => shot.cameraKeys.map((key) => key.frame)), [[0], [120]], "camera keys move with their shots");
assert.deepEqual(v3.state.waypoints.map((waypoint) => waypoint.frame), [72], "root waypoints move onto the production clock");
assert.deepEqual(v3.state.shots[1].camera.railFollow, { mode: "range", startFrame: 12, endFrame: 96 }, "rail follow ranges are frames too");
assert.deepEqual(v3.state.shots[1].camera.cameraRail, cameraRail, "rail geometry carries no frames and is untouched");
assert.deepEqual(v3.state.shots[0].camera.followCam, followCam, "follow gains carry no frames and are untouched");
assert.equal(v3.state.waypoints[0].x, 1.5, "waypoint positions are untouched");
// The rewritten body is v4, so a reload must not scale it again.
const v3Rewritten = readShotAuthoring(serializeShotAuthoring(v3.state));
assert.equal(v3Rewritten.status, "valid");
assert.equal(v3Rewritten.state.frameCount, 360, "migration is not applied twice");
assert.deepEqual(v3Rewritten.state.shots.map((shot) => shot.startFrame), [0, 120]);
// The sanity bounds moved with the clock: 1 s .. 20 min still means that.
assert.equal(readShotAuthoring(JSON.stringify({ version: 4, frameCount: 1, shots: [] })).state.frameCount, 24, "the floor is one second");
assert.equal(readShotAuthoring(JSON.stringify({ version: 4, frameCount: 99999, shots: [] })).state.frameCount, 28800, "the ceiling is twenty minutes");
assert.equal(readShotAuthoring(JSON.stringify({ version: 3, frameCount: 24000, shots: [] })).state.frameCount, 28800, "a v3 roll at the old ceiling keeps its twenty minutes");

// Corrupt/future bytes remain tagged so App can quarantine or preserve them.
assert.equal(readShotAuthoring(null).status, "absent");
assert.equal(readShotAuthoring("{nope").status, "corrupt");
assert.equal(readShotAuthoring('"hello"').status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 4, frameCount: 100 })).status, "corrupt");
assert.equal(readShotAuthoring(JSON.stringify({ version: 99, shots: [] })).status, "future");
assert.equal(loadShotAuthoring("{nope"), null);

assert.equal(SHOT_AUTHORING_KEY, "cozyclay.shot-authoring.v8");
assert.equal(SHOT_AUTHORING_LEGACY_KEY, "cozyclay.shot-authoring.v7");
assert.deepEqual(SHOT_AUTHORING_LEGACY_KEYS, ["cozyclay.shot-authoring.v7", "cozyclay.shot-authoring.v6", "cozyclay.shot-authoring.v5", "cozyclay.shot-authoring.v4", "cozyclay.shot-authoring.v3", "cozyclay.shot-authoring.v2", "cozyclay.shot-authoring.v1"]);
assert.equal(SHOT_AUTHORING_QUARANTINE_KEY, "cozyclay.shot-authoring.v8.quarantine");

const reviewed = loadShotAuthoring(serializeShotAuthoring({ frameCount: 100, shots: [{
	...shots[0], endFrame: 99,
	optics: { shiftX: 0.75, shiftY: -0.2, focusTargetId: " character-1 " },
	review: { burnIn: true, comments: [{ id: "note", frame: 24, text: " Hold this ", resolved: false }, { id: "old", frame: 120, text: "outside" }],
		annotations: [{ id: "stroke", frame: 24, color: "#ffbf47", points: [[0, 0], [0.5, 0.75]] }] },
}] }));
assert.deepEqual(reviewed.shots[0].optics, { shiftX: 0.5, shiftY: -0.2, focusTargetId: "character-1" });
assert.equal(reviewed.shots[0].review.burnIn, true);
assert.equal(reviewed.shots[0].review.comments.length, 1);
assert.equal(reviewed.shots[0].review.comments[0].text, "Hold this");
assert.equal(reviewed.shots[0].review.annotations.length, 1);

console.log("all shot-authoring checks PASS");
