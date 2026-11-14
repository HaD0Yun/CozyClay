#!/usr/bin/env node
// Execute the actual recording hook/frame callback under a deterministic
// effect and pointer-lock host. Native input is covered by the browser suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { activeAt, resolveRailSchedule } from "../src/camera-rail-schedule.js";
import { sampleAt } from "../src/sample-at.js";

const source = readFileSync(new URL("../src/use-rail-recording.jsx", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const performanceSource = readFileSync(new URL("../src/camera-performance.js", import.meta.url), "utf8").replace(/^export /gm, "");
class Surface {
	listeners = new Map();
	addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
	removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== fn)); }
	emit(type, args = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, ...args }); }
}
function mount() {
	const document = new Surface(), window = new Surface(), effects = [], cleanup = [];
	const saved = [], errors = [], frameRef = { current: 22 }, look = { current: { yaw: 0, pitch: 0 } };
	let playing = false, active = false, requests = 0, tick;
	const canvas = { requestPointerLock() { requests++; return undefined; } };
	document.pointerLockElement = null;
	document.exitPointerLock = () => { document.pointerLockElement = null; document.emit("pointerlockchange"); };
	const shot = { id: "rail", startFrame: 12, endFrame: 59, cameraKeys: [],
		camera: { mode: "rail", cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], railFollow: { mode: "range", startFrame: 10, endFrame: 33 } } };
	const scene = { frameCount: 72, cameraTrack: Array.from({ length: 72 }, (_, frame) => ({
		pos: { x: frame / 20, y: 2, z: 4 }, yaw: 0.2, pitch: -0.1, fovDeg: 37, rollDeg: 17,
	})) };
	const camera = new THREE.PerspectiveCamera();
	const context = { document, window, activeAt, resolveRailSchedule, sampleAt,
		cancelAnimationFrame: () => {},
		ko: en => en,
		useRef: current => ({ current }), useCallback: callback => callback,
		useEffect: effect => effects.push(effect), useLayoutEffect: effect => effects.push(effect),
		useFrame: callback => { tick = callback; },
		useState: initial => [typeof initial === "function" ? initial() : initial, value => { active = value; }],
	};
	const { useCameraPerformance: Recording, RailRecordingRig } = runInNewContext(`${performanceSource}\n${source}\n({useCameraPerformance,RailRecordingRig});`, context);
	const options = { shot, scene, frameRef, look, camRef: { current: camera }, playing,
		stageRef: { current: { querySelector: () => canvas } }, manualRef: { current: false },
		previewEndRef: { current: null }, fps: 24, setFrame: value => { frameRef.current = value; },
		setPlaying: value => { playing = value; }, enterShotLook: () => {}, setMovePlaying: () => {},
		writeTake: (id, take) => saved.push({ id, take }), writeKeys: () => { throw Error("rail cannot write keys"); },
		notify: () => {}, onLockError: () => errors.push("lock"),
	};
	const controller = Recording(options);
	RailRecordingRig({ recording: controller.rail });
	for (const effect of effects) cleanup.push(effect());
	return { controller, options, document, window, camera, look, saved, errors,
		grant: () => { document.pointerLockElement = canvas; document.emit("pointerlockchange"); },
		frame: frame => { frameRef.current = frame; tick(); },
		move: (movementX, movementY) => document.emit("mousemove", { movementX, movementY }),
		get state() { return { active, playing, requests }; },
		cleanup: () => cleanup.reverse().forEach(fn => fn?.()),
	};
}
{
	const h = mount();
	assert.equal(h.controller.start(), true);
	assert.equal(h.state.requests, 1, "record requests mouse capture once");
	h.grant();
	assert.equal(h.state.playing, true, "capture starts real playback");
	assert.equal(h.window.__cozyclayCameraGesture, true, "mouse aim shares the existing transient camera-render path");
	h.frame(22);
	h.move(30, -10); h.frame(34);
	assert.ok(Math.abs(h.camera.rotation.y - (0.2 - 30 * 0.0032)) < 1e-9);
	assert.ok(Math.abs(h.camera.position.x - 34 / 20) < 1e-9, "mouse cannot move the rail position");
	assert.equal(h.camera.fov, 37);
	assert.ok(Math.abs(h.camera.rotation.z - 17 * Math.PI / 180) < 1e-9);
	h.move(-10, 4); h.frame(45);
	assert.equal(h.state.playing, false);
	assert.equal(h.document.pointerLockElement, null, "completed take releases mouse");
	assert.equal(h.window.__cozyclayCameraGesture, false, "completed take restores the full-quality settled render");
	assert.equal(h.saved.length, 1, "one complete write at the actual final frame");
	const take = h.saved[0].take;
	assert.equal(take.startFrame, 10); assert.equal(take.samples.length, 24);
	assert.equal(take.samples[0].yaw, 0.2);
	assert.ok(Math.abs(take.samples[12].yaw - 0.104) < 1e-9);
	assert.ok(Math.abs(take.samples[23].yaw - 0.136) < 1e-9);
	assert.equal(take.samples[11].yaw, 0.2, "skipped display frames hold the last observed aim");
	h.cleanup();
}
for (const interruption of ["escape", "blur", "unlock", "error"]) {
	const h = mount();
	h.controller.start(); h.grant(); h.frame(22); h.move(20, 10);
	if (interruption === "escape") h.window.emit("keydown", { key: "Escape", stopPropagation() {} });
	if (interruption === "blur") h.window.emit("blur");
	if (interruption === "unlock") h.document.exitPointerLock();
	if (interruption === "error") h.document.emit("pointerlockerror");
	assert.equal(h.saved.length, 0, `${interruption} leaves the previous take untouched`);
	assert.equal(h.state.playing, false, `${interruption} stops the rail`);
	assert.equal(h.document.pointerLockElement, null, `${interruption} releases mouse capture`);
	assert.equal(h.window.__cozyclayCameraGesture, false, `${interruption} restores the settled renderer`);
	h.cleanup();
}
{
	const h = mount();
	let grant;
	const request = new Promise(resolve => { grant = resolve; });
	h.options.stageRef.current.querySelector().requestPointerLock = () => request;
	h.controller.start(); h.controller.rail.cancel();
	h.grant(); grant(); await request;
	assert.equal(h.document.pointerLockElement, null, "a late grant after cancellation releases capture");
	assert.equal(h.saved.length, 0);
	h.cleanup();
}
{
	const h = mount();
	let deny;
	const request = new Promise((_, reject) => { deny = reject; });
	const canvas = h.options.stageRef.current.querySelector();
	canvas.requestPointerLock = () => request;
	h.controller.start(); h.controller.rail.cancel();
	canvas.requestPointerLock = () => undefined;
	h.controller.start(); h.grant();
	deny(new Error("old request denied")); await request.catch(() => {});
	assert.equal(h.state.playing, true, "a stale rejection cannot cancel the next recording");
	assert.equal(h.errors.length, 0, "a stale rejection is not a current permission error");
	h.controller.rail.cancel(); h.cleanup();
}
console.log("PASS actual rail recorder lifecycle: aim input, full range, skipped display frames, authored optics, auto-stop and interruption discard");
