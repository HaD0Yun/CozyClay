#!/usr/bin/env node
// Execute App's production export functions at their renderer/encoder seams.
// Browser QA separately covers React rendering, real WebGL and WebCodecs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { parseSync } from "rolldown/utils";
import * as THREE from "three";
import { exportFailureCode } from "../src/analytics.js";
import { startExportAttempt } from "../src/export-attempt.js";
import { keyframePackEntries, keyframePackName } from "../src/keyframe-pack.js";
import { buildZip } from "../src/zip-store.js";
import { depthRangeFromFrames, depthRangeFromPixels } from "../src/render-passes.js";
import { shotsFixture } from "./bus/shots-fixture.mjs";
import { isProxyFigure } from "../src/scenes.js";
import { placementAt } from "../src/root-path.js";
import { applyCameraOptics } from "../src/camera-optics.js";
const shotFixtures = [];
import { readStudioFunction } from "./bus/verify-domain-modules.mjs";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const parsed = parseSync("App.jsx", source, { lang: "jsx" });
assert.deepEqual(parsed.errors, []);
const app = parsed.program.body.find((node) => node.type === "ExportDefaultDeclaration").declaration;
const names = ["dataUrlToBytes", "captureShotFramePng", "shotFramingAtFrame", "packMetaForShot", "buildShotKeyframePack", "shotIndexForPack", "exportKeyframePacks", "download"];
const functions = names.map((name) => {
	const node = app.body.body.find((node) => node.type === "FunctionDeclaration" && node.id.name === name);
	assert.ok(node, `production function ${name} exists`);
	return source.slice(node.start, node.end);
}).join("\n");
const region = source.slice(source.indexOf('\tconst [recState, setRecState]'), source.indexOf('\tfunction exportPhaseLabel('));
const load = new Function("deps", "createAppContext", `with (deps) { ${region}\n${functions}
const appContext = createAppContext().forRender({
  get recRef() { return recRef; }, get captureCurrentFraming() { return captureCurrentFraming; },
  get motion() { return motion; }, get currentRecordFrameCount() { return currentRecordFrameCount; },
  get executeExportRequest() { return executeExportRequest; }, get exportRequest() { return exportRequest; },
  get runShotExport() { return runShotExport; },
});
${readStudioFunction("exportShotVideo")}
return {
	exportShotVideo, exportDepthVideo, exportKeyframePacks, buildShotKeyframePack, runShotExport, download,
	retryExport, stopShotRecording, exportRequest, executeExportRequest, withExportFrame,
	get job() { return recRef.current; }, get request() { return retryExportRef.current; }
}; }`);

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function bounded(promise) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("export seam signal timed out")), 5000);
	})]).finally(() => clearTimeout(timer));
}
function fixture() {
	const events = new EventEmitter();
	const statuses = [], lifecycle = [], legacy = [], downloads = [], encodes = [], captures = [], targets = [];
	let hookIndex = 0;
	const hooks = [];
	const camera = new THREE.PerspectiveCamera(46, 2, 0.1, 100);
	camera.position.set(7, 8, 9);
	camera.rotation.order = "ZXY";
	camera.rotation.set(0.1, 0.2, 0.3);
	const rig = new THREE.Group();
	const parent = new THREE.Group();
	parent.position.set(2, 0, 3);
	parent.rotation.y = 0.5;
	parent.add(rig);
	rig.scale.setScalar(0.01);
	const bone = new THREE.Bone();
	bone.position.set(1, 2, 3);
	rig.add(bone);
	const framing = { pos: { x: 1, y: 2, z: 4 }, yaw: 0.4, pitch: -0.2, fovDeg: 35 };
	const shots = [0, 1].map((index) => ({ id: `shot-${index}`, name: `Shot ${index}`, startFrame: index * 2, endFrame: index * 2 + 1,
		cameraKeys: [{ id: `key-${index}`, frame: index * 2, framing: structuredClone(framing) }] }));
	const deps = {
		useEffect: () => {}, applyCameraOptics,
		useRef: (value) => ({ current: value }),
		useState: (value) => {
			const index = hookIndex++;
			hooks[index] = value;
			return [value, (next) => {
				hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
				if (index === 1) { statuses.push(next); events.emit("status", next); }
			}];
		},
		shots, tlFrame: 0, tlFrameCount: 360, tlFps: 24, TIMELINE_FPS: 24,
		characters: [{ id: "cast", x: 2, y: 0, z: 3, rot: 30, scale: 1 }], characterViews: [], activeChar: { id: "cast" }, motion: null,
		playbackScene: { frameCount: 360 }, shotOutput: { width: 2, height: 2 },
		ikStateRef: { current: { keys: new Map(), tracked: new Set(), rig, chains: new Map() } },
		ikStatesRef: { current: new Map() }, snapshotIkKeys: (state) => new Map(state.keys),
		captureCurrentFraming: () => ({ pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, yaw: 0.2, pitch: 0.1, fovDeg: camera.fov }),
		shotCamRef: { current: camera }, rigs: { cast: rig },
		look: { current: { yaw: 0.2, pitch: 0.1 } }, propFrameRef: { current: 42 }, propSyncRef: { current() {} }, syncCarriers() {}, syncPhysicsOverlays() {},
		captureRef: { current: { createExportCapture(output) {
			const target = { output: { ...output }, disposed: false, scene: {}, render() {
				const state = { camera: camera.position.toArray(), fov: camera.fov, scale: rig.scale.toArray(), placement: parent.position.toArray(), bone: bone.position.toArray() };
				captures.push(state);
				if (deps.renderError) throw deps.renderError;
				return new Uint8Array(output.width * output.height * 4).fill(Math.round(camera.position.x + rig.scale.x * 100 + bone.position.x));
			}, dispose() { target.disposed = true; } };
			targets.push(target);
			return target;
		} } },
		snapshotPlaybackBones: () => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }),
		restorePlaybackBones: (_rig, saved) => { bone.position.copy(saved.position); bone.quaternion.copy(saved.quaternion); },
		poseMemberAtFrame: (_rig, clip, _ik, frame) => { if (clip) bone.position.x = frame; }, IK_CORRECTION_BLEND_FRAMES: 6, isProxyFigure,
		sampleAt: (_scene, shot) => ({ camera: shot?.cameraKeys[0]?.framing }), placementAt,
		shotAtFrame: (list, frame) => list.find((shot) => frame >= shot.startFrame && frame <= shot.endFrame),
		shotIndexAtFrame: (list, frame) => list.findIndex((shot) => frame >= shot.startFrame && frame <= shot.endFrame),
		timelineContentExtent: () => 0, promptClips: [], multiModelFootage: null,
		updateStableItem: (list, id, update) => list.map((item) => item.id === id ? update(item) : item),
		createStableItemId: () => "new-key", recordShotUndo: () => { deps.undoCount += 1; }, undoCount: 0,
		setShots: (list) => { deps.shots = list; deps.shotWrites += 1; }, shotWrites: 0,
		embedMode: false, sceneObjects: [], ko: (english) => english, isKo: false, setToast() {}, setRecordedVideoName() {},
		startExportAttempt: (descriptor) => startExportAttempt(descriptor, { capture: (event, props) => lifecycle.push({ event, props }) }),
		exportFailureCode, track: (event) => legacy.push(event), trackFeature() {}, trackActivation() {},
		// #466: the optional use-case question after a finished export.
		playgroundMode: false, shouldAskUseCase: () => false, setUseCaseAskOpen() {},
		moveSequence: { slate: "original-shot" },
		// The workspace helper owns the browser handoff now. This seam records the
		// same names the old anchor did, and throws where an injected handoff fails.
		saveExport: async (_source, name) => {
			if (deps.downloadFailure?.(name)) throw new Error("injected handoff failure");
			downloads.push(name);
			return { method: "download", name };
		},
		URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} },
		// Only schedule production URL revocation; tests never await a timer.
		setTimeout: (callback) => { queueMicrotask(callback); },
		document: { body: { appendChild() {} }, createElement: () => ({ remove() {}, click() {
			if (deps.downloadFailure?.(this.download)) throw new Error("injected handoff failure");
			downloads.push(this.download);
		} }) },
		bufferToPng: (buffer) => `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`,
		keyLight: {}, shot: { focalMm: 35 }, fovDeg: 35, shotAspectKey: "16:9",
		shotCaptureMeta: ({ shot, size }) => ({ title: shot.name, size }), buildShotPrompt: () => "fixture prompt",
		keyframePackEntries, keyframePackName, buildZip,
		renderPass: (capture) => capture.render(), depthRangeFromFrames, depthRangeFromPixels, DEPTH_RANGE_M: 40,
		result: { frame: "data:image/png;base64,AA==", frameB: "data:image/png;base64,AQ==", partColours: { arm: "red" } },
		setResult: (update) => { deps.result = update(deps.result); },
		async exportOffscreenVideo(options) {
			encodes.push(options);
			events.emit("encode", options);
			if (deps.encodeGate) await deps.encodeGate.promise;
			options.signal.throwIfAborted();
			if (deps.encodeError) throw deps.encodeError;
			options.onPhase?.({ phase: "encoding", cancellable: true });
			for (let frame = options.startFrame; frame <= options.endFrame; frame += 1) {
				options.capture(frame, options.passKind);
				options.onFrame?.({ index: frame - options.startFrame, frameCount: options.endFrame - options.startFrame + 1 });
			}
			options.onPhase?.({ phase: "finalizing", stage: "flush", cancellable: true });
			options.onPhase?.({ phase: "finalizing", stage: "mux", cancellable: false });
			return { blob: new Blob([new Uint8Array([1, 2])]), mimeType: "video/mp4", frameCount: options.endFrame - options.startFrame + 1 };
		},
	};
	const studio = shotsFixture();
	shotFixtures.push(studio);
	studio.scope.captureCurrentFraming = deps.captureCurrentFraming;
	studio.shots.load({ shots: deps.shots, frameCount: deps.tlFrameCount, camera: studio.actual.readStudioState().camera });
	studio.shots.documentStore.subscribe(() => { deps.shots = studio.shots.read(); });
	Object.defineProperties(deps, {
		undoCount: { get: () => studio.shots.documentStore.depths().past },
		shotWrites: { get: () => studio.shots.documentStore.getSnapshot().domainRevisions.shot },
	});
	deps.shotsDomain = studio.shots;
	const api = load(deps, () => studio.scope.appContext);
	const signal = (name, predicate = () => true) => {
		const ready = deferred();
		const listener = (value) => { if (predicate(value)) { events.off(name, listener); ready.resolve(value); } };
		events.on(name, listener);
		return bounded(ready.promise).finally(() => events.off(name, listener));
	};
	return { api, deps, camera, rig, parent, bone, statuses, lifecycle, legacy, downloads, encodes, captures, targets, signal,
		get status() { return hooks[1]; }, get busy() { return hooks[0]; } };
}
function terminals(run) { return run.lifecycle.filter(({ event }) => event !== "export:attempt_started"); }
function assertPaired(run, count) {
	const starts = run.lifecycle.filter(({ event }) => event === "export:attempt_started");
	assert.equal(starts.length, count);
	assert.equal(terminals(run).length, count);
	assert.equal(new Set(starts.map(({ props }) => props.attempt_id)).size, count);
	for (const start of starts) assert.equal(terminals(run).filter(({ props }) => props.attempt_id === start.props.attempt_id).length, 1);
}
function editor(run) {
	return { camera: run.camera.position.toArray(), quaternion: run.camera.quaternion.toArray(), order: run.camera.rotation.order,
		fov: run.camera.fov, scale: run.rig.scale.toArray(), placement: run.parent.position.toArray(), bone: run.bone.position.toArray(),
		look: { ...run.deps.look.current }, propFrame: run.deps.propFrameRef.current };
}

// Guard is acquired before depth, pack endpoint captures, or even a frame's
// synchronous handoff. A second video click must never toggle cancellation.
for (const kind of ["video", "depth_video", "keyframe_pack", "frame"]) {
	const run = fixture();
	const first = kind === "video" ? run.api.exportShotVideo() : kind === "depth_video" ? run.api.exportDepthVideo()
		: kind === "keyframe_pack" ? run.api.exportKeyframePacks() : run.api.download();
	const job = run.api.job;
	assert.ok(job, `${kind} acquires the shared ref synchronously`);
	await Promise.all([run.api.exportShotVideo(), run.api.exportDepthVideo(), run.api.exportKeyframePacks(), run.api.download(), run.api.retryExport(), run.api.retryExport()]);
	assert.equal(job.controller.signal.aborted, false, "duplicate clicks do not cancel");
	await bounded(first);
	assert.equal(run.status.phase, "completed");
	assert.equal(run.api.job, null);
	assert.ok(run.targets.every((target) => target.disposed));
	assertPaired(run, 1);
}
console.log("PASS all four kinds and duplicate retries share one synchronous lock and one lifecycle");

// A failure retains the request, but runtime resources and editor state are
// sampled afresh on retry. No state setter may restore old authored settings.
const retry = fixture();
const originalEditor = editor(retry);
retry.deps.encodeError = Object.assign(new Error("codec unavailable"), { exportFailureCode: "unsupported_codec" });
await retry.api.exportShotVideo();
assert.equal(retry.status.code, "unsupported_codec");
assert.deepEqual(editor(retry), originalEditor);
const request = retry.api.request;
retry.deps.shots[0].startFrame = 100;
retry.deps.shots[0].endFrame = 200;
retry.deps.shots[0].cameraKeys[0].framing.pos.x = 99;
retry.deps.shotOutput = { width: 4, height: 4 };
retry.deps.tlFrame = 2;
retry.camera.position.set(20, 21, 22);
retry.camera.fov = 60;
retry.rig.scale.setScalar(0.012);
retry.parent.position.set(15, 0, 16);
retry.bone.position.set(9, 8, 7);
const edited = editor(retry);
retry.deps.encodeError = null;
const entered = retry.signal("encode");
retry.deps.encodeGate = deferred();
const retried = retry.api.retryExport();
const config = await entered;
assert.equal(retry.api.request, request);
assert.deepEqual([config.startFrame, config.endFrame, config.width, config.height], [0, 1, 2, 2]);
const duplicate = retry.api.retryExport();
assert.equal(duplicate, undefined);
retry.deps.encodeGate.resolve();
await bounded(retried);
assert.equal(retry.status.phase, "completed");
assert.deepEqual(retry.captures[0], { camera: [1, 2, 4], fov: 35, scale: [0.01, 0.01, 0.01], placement: [2, 0, 3], bone: [1, 2, 3] });
assert.deepEqual(editor(retry), edited, "retry restores current editor, not the request snapshot");
assert.equal(retry.deps.shotWrites, 0);
assert.equal(retry.deps.undoCount, 0);
assert.equal(retry.downloads.length, 1);
assertPaired(retry, 2);
assert.equal(retry.legacy.filter((event) => event === "export:video_succeeded").length, 1);
assert.ok(retry.statuses.some((status) => status.phase === "encoding" && status.completedFrames === 2 && status.frameCount === 2));
assert.ok(retry.statuses.some((status) => status.phase === "finalizing" && status.stage === "mux" && !status.cancellable && status.frameCount === undefined));
console.log("PASS retry preserves shot/camera/range/output and cast transforms without overwriting current edits");

const staticShot = fixture();
staticShot.deps.shots[0].cameraKeys = [];
staticShot.deps.shotsDomain.load({ shots: staticShot.deps.shots, frameCount: 360 });
staticShot.deps.encodeError = Object.assign(new Error("encode"), { exportFailureCode: "encode_failed" });
await staticShot.api.exportShotVideo();
assert.equal(staticShot.deps.shotWrites, 1);
staticShot.deps.encodeError = null;
await staticShot.api.retryExport();
assert.equal(staticShot.deps.shotWrites, 1, "static-shot preflight is not repeated on retry");
assert.equal(staticShot.deps.undoCount, 1);
assertPaired(staticShot, 2);

// A named output size renders and encodes at that size; odd sides round down to even for H.264.
const sized = fixture();
await sized.api.exportShotVideo({ output: { width: 737, height: 416 } });
assert.equal(sized.status.phase, "completed");
assert.deepEqual([sized.encodes[0].width, sized.encodes[0].height], [736, 416]);
assert.deepEqual(sized.targets.map((target) => target.output), [{ width: 736, height: 416 }]);
await sized.api.retryExport();
assert.deepEqual([sized.encodes[1].width, sized.encodes[1].height], [736, 416], "Retry keeps the requested size");
const preset = fixture();
await preset.api.exportShotVideo();
assert.deepEqual([preset.encodes[0].width, preset.encodes[0].height], [2, 2], "without a size the shot aspect's preset still decides");
console.log("PASS a video export renders at a requested output size, else at the shot preset");

const depth = fixture();
const beforeDepth = editor(depth);
const depthFrame = depth.signal("status", (status) => status.stage === "depth");
const depthRun = depth.api.exportDepthVideo();
await depthFrame;
assert.deepEqual(editor(depth), beforeDepth, "depth prepass restores camera and bones before yielding");
depth.api.stopShotRecording();
await bounded(depthRun);
assert.equal(depth.status.phase, "cancelled");
assert.equal(depth.encodes.length, 0, "cancelled prepass never starts encoding");
assert.equal(depth.downloads.length, 0);
assert.ok(depth.targets.every((target) => target.disposed));
assert.equal(depth.api.job, null);
assertPaired(depth, 1);
console.log("PASS cancellable depth prepass restores camera/bones and releases capture before encoding");

// Stop during encoding: the "Cancelling…" status is UI only, so the cancelled
// attempt still reports the stage and frame share it stopped at.
const stopped = fixture();
stopped.deps.encodeGate = deferred();
const encodeEntered = stopped.signal("encode");
const stoppedRun = stopped.api.exportShotVideo();
const encodeOptions = await encodeEntered;
encodeOptions.onPhase({ phase: "encoding", cancellable: true });
encodeOptions.onFrame({ index: 4, frameCount: 10 });
stopped.api.stopShotRecording();
stopped.deps.encodeGate.resolve();
await bounded(stoppedRun);
const stoppedEnd = stopped.lifecycle.find(({ event }) => event === "export:attempt_cancelled");
assert.deepEqual([stoppedEnd?.props.stage, stoppedEnd?.props.progress], ["encoding", "26-50"], "Stop keeps the stage and progress it interrupted");
assertPaired(stopped, 1);
console.log("PASS a stopped export reports the stage and progress it was stopped at, not the cancelling message");

const render = fixture();
const beforeRender = editor(render);
render.deps.renderError = new Error("renderer lost");
await render.api.exportShotVideo();
assert.equal(render.status.code, "render_failed");
assert.deepEqual(editor(render), beforeRender);
assert.ok(render.targets.every((target) => target.disposed));
render.deps.renderError = null;
await render.api.retryExport();
assert.equal(render.status.phase, "completed");
assertPaired(render, 2);

const pack = fixture();
pack.deps.downloadFailure = (name) => name.includes("shot-2-");
await pack.api.exportKeyframePacks(true);
assert.equal(pack.status.phase, "failed");
assert.equal(pack.downloads.length, 1);
assert.equal(pack.status.handedOff, 1);
const firstPack = pack.downloads[0];
pack.deps.downloadFailure = null;
await pack.api.retryExport();
assert.equal(pack.status.phase, "completed");
assert.equal(pack.downloads.filter((name) => name === firstPack).length, 1);
assert.equal(pack.downloads.length, 2);
assertPaired(pack, 2);
assert.equal(pack.legacy.includes("export:video_succeeded"), false, "pack clip has no nested legacy video success");
console.log("PASS partial all-shot handoff retries only remaining packs without nested attempts/downloads");

const archiveCancel = fixture();
const archiving = archiveCancel.signal("status", (status) => status.stage === "archive");
const archiveRun = archiveCancel.api.exportKeyframePacks();
await archiving;
archiveCancel.api.stopShotRecording();
await bounded(archiveRun);
assert.equal(archiveCancel.status.phase, "cancelled");
assert.equal(archiveCancel.downloads.length, 0);
assert.ok(archiveCancel.targets.every((target) => target.disposed));
assertPaired(archiveCancel, 1);

const frames = fixture();
frames.deps.downloadFailure = (name) => name === "blocking-frame-B-end.png";
await frames.api.download();
assert.equal(frames.status.phase, "failed");
assert.equal(frames.downloads.length, 2);
assert.equal(frames.status.handedOff, 2);
frames.deps.result = { frame: "data:image/png;base64,Ag==" };
frames.deps.downloadFailure = null;
await frames.api.retryExport();
assert.deepEqual(frames.downloads, ["blocking-frame-palette.json", "blocking-frame-A-start.png", "blocking-frame-B-end.png"]);
assert.equal(frames.deps.result.downloaded, undefined, "retry does not mark a newer frame result downloaded");
assertPaired(frames, 2);
console.log("PASS frame and pack cancellation/handoff boundaries suppress duplicate partial downloads");

const external = fixture();
await external.api.buildShotKeyframePack(external.deps.shots[0], 0);
assert.equal(external.status.phase, "completed");
assert.equal(external.lifecycle.length, 0, "external caller remains the only lifecycle owner");
assert.equal(external.downloads.length, 0);
assert.equal(external.api.job, null);
console.log("PASS embed/Workflow pack builder keeps external ownership and returns without downloading");
for (const fixture of shotFixtures) fixture.dispose();
console.log("all export recovery seam checks PASS");
