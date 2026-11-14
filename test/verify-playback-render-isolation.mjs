import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { readStudioFunction } from "./bus/verify-domain-modules.mjs";
import { createShotSubjectSampler } from "../src/camera-direction.js";
import { createSceneObject } from "../src/scene-objects.js";
import { probeVisibility } from "../src/motion/playback-probe.js";
import { SUBJECT_HEIGHT_M } from "../src/shot.js";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const playback = await readFile(new URL("../src/domains/playback.js", import.meta.url), "utf8");
const characters = await readFile(new URL("../src/stage-characters.jsx", import.meta.url), "utf8");
const rigs = await readFile(new URL("../src/stage-canvas-rigs.jsx", import.meta.url), "utf8");
const ghosts = await readFile(new URL("../src/view-ghosts.jsx", import.meta.url), "utf8");

assert.match(app, /<PlaybackCharacter/);
assert.match(app, /entry=\{view\.entry\}/);
assert.match(characters, /PlaybackCharacter/);
assert.doesNotMatch(app, /followTrack\?\.\[tlFrame\]/);
assert.match(playback, /shared\.propFrameRef\.current = frame/);
assert.match(characters, /usePlaybackSnapshot\(playbackFrame\)/);
assert.match(characters, /placementAt\(entry, frame/);
assert.match(ghosts, /usePlaybackSnapshot\(playbackFrame\)/);

const cast = [0, 1, 2].map((x, index) => ({ id: `cast-${index}`, x, z: 0, rot: 0, ...(index === 2 ? { parent: "carrier" } : {}) }));
const shot = { id: "named", startFrame: 0, endFrame: 1, subjectIds: cast.map(entry => entry.id) };
const carrier = { ...createSceneObject("cube"), id: "carrier", path: { points: [{ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }], faceTravel: false } };
const sample = createShotSubjectSampler({ characters: cast, objects: [carrier], shots: [shot], frameCount: 2, fps: 24, activeId: cast[0].id, clipOf: () => null });
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000);
camera.position.set(1, 1.6, 10); camera.lookAt(1, 1, 0); camera.updateMatrixWorld();
const frameRef = { current: 0 }, visibility = [];
let onFrame;
const scope = { THREE, SUBJECT_HEIGHT_M, probeVisibility,
	useRef: current => ({ current }), useEffect() {}, useFrame: callback => { onFrame = callback; } };
const ShotRig = new Function("scope", `with(scope){return (${readStudioFunction("ShotRig", rigs)});}`)(scope);
ShotRig({ subject: cast[0], subjectsAt: frame => sample(shot, frame), frameRef, camRef: { current: camera },
	onMetrics: (_position, visible) => visibility.push(visible) });
onFrame(); onFrame();
assert.deepEqual(visibility, [true], "an unchanged frame must not republish metrics");
frameRef.current = 1; onFrame();
assert.deepEqual(visibility, [true, false], "the frame-local probe must see a moving non-active third member leave");

console.log("playback render isolation: App-level frame consumers stay out of playback ticks");
