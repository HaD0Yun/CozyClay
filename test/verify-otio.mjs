#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { serializeOtio, shotMetadata, shotsToOtio } from "../src/otio.js";

const framing = (x, focalMm) => ({
	pos: { x, y: 1.5, z: 4 },
	yaw: 0,
	pitch: -0.1,
	fovDeg: 45,
	focalMm,
});

const baseScene = {
	name: "Courtyard",
	frameCount: 96,
	filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 },
	cameraAnchor: { x: 0, z: 0 },
};

const shots = [{
	id: "shot-a",
	name: "Arrival",
	startFrame: 12,
	endFrame: 35,
	camera: { mode: "keys" },
	cameraKeys: [{ frame: 12, framing: framing(1, 50) }],
}, {
	id: "shot-b",
	name: "Reaction",
	startFrame: 48,
	endFrame: 95,
	camera: { mode: "keys" },
	cameraKeys: [{ frame: 48, framing: framing(-2, 85) }],
}];

{
	const subjectTrack = Array.from({ length: 96 }, (_, frame) => ({ x: frame / 10, z: -frame / 20 }));
	const scene = {
		...baseScene,
		activeCharacterId: "hero",
		subjectTrack,
		characters: [{
			id: "hero",
			model: "y-bot-tpose",
			subject: "Lead",
			x: 0,
			y: 0.1,
			z: 0,
			rot: 15,
			scale: 1.1,
		}, {
			id: "hidden-extra",
			hidden: true,
			x: 8,
			z: 8,
		}],
		objects: [{
			id: "chair",
			name: "Chair",
			renderer: "cylinder",
			x: 2,
			y: 0,
			z: -1,
			rot: 30,
			rotX: 5,
			rotZ: -2,
			scaleX: 1,
			scaleY: 1.2,
			scaleZ: 0.8,
		}, {
			id: "crate",
			name: "Crate",
			hidden: true,
			x: 1,
			y: 0,
			z: 1,
		}, {
			id: "cup",
			name: "Cup",
			parent: "crate",
			x: 1,
			y: 1,
			z: 1,
		}],
	};
	const before = JSON.stringify({ scene, shot: shots[0] });
	const metadata = shotMetadata(scene, shots[0]);
	assert.deepEqual(Object.keys(metadata.camera), ["pos", "yaw", "pitch", "fovDeg", "focalMm", "sensorId"]);
	assert.deepEqual(metadata.range, { startFrame: 12, endFrame: 35, fps: 24 });
	assert.deepEqual(metadata.lens, { focalMm: 50, sensorId: "fullFrame", verticalApertureMm: 20.25 });
	assert.equal(metadata.blocking.length, 2, "hidden cast and effectively hidden props are omitted; visible cast and props remain");
	assert.ok(!metadata.blocking.some((entry) => entry.id === "crate" || entry.id === "cup"));
	assert.deepEqual(metadata.blocking[0].pos, { x: 1.2, y: 0.1, z: -0.6 }, "blocking samples the shot's first inclusive frame");
	assert.deepEqual(metadata.blocking[1].rotationDeg, { x: 5, y: 30, z: -2 });
	assert.equal(JSON.stringify({ scene, shot: shots[0] }), before, "metadata export is pure");
}

{
	const scene = {
		...baseScene,
		blocking: [{ kind: "character", id: "hero", pos: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1 }],
	};
	const serialized = serializeOtio(scene, shots);
	const snapshotUrl = new URL("./snapshots/courtyard-cut-list.otio", import.meta.url);
	assert.equal(serialized, await readFile(snapshotUrl, "utf8"), "OTIO JSON matches the reviewed snapshot");

	const timeline = shotsToOtio(scene, shots);
	const items = timeline.tracks.children[0].children;
	const clips = items.filter((item) => item.OTIO_SCHEMA === "Clip.1");
	assert.equal(clips.length, shots.length, "one Shot becomes one Clip");
	assert.deepEqual(items.map((item) => item.source_range.duration.value), [12, 24, 12, 48], "gaps and inclusive shot lengths preserve absolute placement");
	assert.equal(items.reduce((frames, item) => frames + item.source_range.duration.value, 0), 96, "track spans frames 0 through 95 exactly");
	assert.deepEqual(clips.map((clip) => clip.source_range.start_time.value), [0, 0], "each shot-local media source begins at frame 0");
	assert.deepEqual(clips.map((clip) => clip.source_range.duration.value), [35 - 12 + 1, 95 - 48 + 1]);
	for (const clip of clips) {
		assert.equal(clip.source_range.start_time.rate, 24);
		assert.equal(clip.source_range.duration.rate, 24);
		assert.equal(clip.metadata.cozyclay.range.endFrame - clip.metadata.cozyclay.range.startFrame + 1, clip.source_range.duration.value);
	}
	assert.deepEqual(timeline.metadata.cozyclay, {
		metersPerUnit: 1,
		upAxis: "Y",
		fps: 24,
		startTimecode: "00:00:00:00",
	});
}

assert.throws(
	() => shotsToOtio(baseScene, [{ ...shots[0], startFrame: 20 }, { ...shots[1], startFrame: 30 }]),
	/overlaps/,
	"overlaps cannot produce an ambiguous OTIO track",
);

console.log("OTIO cut list verified: 2 clips, 72 shot frames, 24 timeline fps");
