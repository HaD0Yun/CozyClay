#!/usr/bin/env node
// Execute the real FlyControls effect/frame handlers with a deterministic DOM
// and R3F scheduler. Browser QA separately proves native lock and React wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as THREE from "three";

const source = readFileSync(new URL("../src/controls.jsx", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "")
	.replace(/^export /gm, "");

class Surface {
	listeners = new Map();
	addEventListener(type, fn, capture = false) {
		const entries = this.listeners.get(type) ?? [];
		entries.push({ fn, capture: capture === true });
		this.listeners.set(type, entries);
	}
	removeEventListener(type, fn) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.fn !== fn));
	}
	dispatchEvent(event) {
		event.preventDefault ??= () => { event.defaultPrevented = true; };
		event.stopPropagation ??= () => { event.stopped = true; };
		for (const capture of [true, false]) {
			if (event.stopped) break;
			for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
				if (entry.capture === capture) entry.fn(event);
			}
		}
		return event;
	}
}
function mount({ lock = "granted", enabled = true } = {}) {
	const window = new Surface();
	const document = new Surface();
	const canvas = new Surface();
	const raf = new Map();
	const effects = [];
	let frame;
	let requests = 0;
	let commits = 0;
	let invalidations = 0;
	let fly = false;
	let sequence = 0;
	const captures = new Set();
	canvas.style = {};
	canvas.focus = () => { document.activeElement = canvas; };
	canvas.setPointerCapture = (id) => captures.add(id);
	canvas.hasPointerCapture = (id) => captures.has(id);
	canvas.releasePointerCapture = (id) => captures.delete(id);
	canvas.requestPointerLock = () => {
		requests += 1;
		if (lock === "denied") throw new Error("Permission denied");
	};
	document.pointerLockElement = null;
	document.exitPointerLock = () => {
		document.pointerLockElement = null;
		document.dispatchEvent({ type: "pointerlockchange" });
	};
	const context = {
		THREE, window, document,
		CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
		useRef: (current) => ({ current }),
		useEffect: (effect) => effects.push(effect),
		useFrame: (callback) => { frame = callback; },
		useThree: () => ({ gl: { domElement: canvas }, invalidate: () => { invalidations += 1; } }),
		requestAnimationFrame: (fn) => { raf.set(++sequence, fn); return sequence; },
		cancelAnimationFrame: (id) => raf.delete(id),
		// controls.jsx's camera:thrash hook (thrash-friction.js); its detector has its own tests.
		noteCameraGesture: () => {},
		// the camera tutorial's cozyclay:nav signal (nav-signal.js); verify-guest-start covers it.
		announceNav: () => {},
	};
	const Controls = runInNewContext(`${source}\nFlyControls;`, context);
	const camera = new THREE.PerspectiveCamera();
	camera.position.set(1, 2, 4);
	const look = { current: { yaw: 0, pitch: 0 } };
	Controls({ enabled, camRef: { current: camera }, look,
		onCameraChange: () => { commits += 1; }, onFlyStateChange: (value) => { fly = value; } });
	const cleanup = effects.map((effect) => effect());
	const pointer = (type, props = {}) => canvas.dispatchEvent({ type, pointerId: 1, pointerType: "mouse", button: 2, clientX: 100, clientY: 100, ...props });
	const escape = () => window.dispatchEvent({ type: "keydown", key: "Escape", code: "Escape" });
	const grant = () => {
		document.pointerLockElement = canvas;
		document.dispatchEvent({ type: "pointerlockchange" });
	};
	return { window, document, canvas, camera, look, pointer, escape, grant,
		frame: (delta = 1 / 60) => frame({}, delta),
		flush: () => { for (const [id, fn] of raf) { raf.delete(id); fn(); } },
		cleanup: () => cleanup.forEach((fn) => fn?.()),
		get state() { return { requests, commits, invalidations, fly, gesture: window.__cozyclayCameraGesture }; } };
}

for (const [kind, button, altKey] of [["fly", 2, false], ["pan", 1, false], ["orbit", 0, true]]) {
	const h = mount();
	const initialPosition = h.camera.position.clone();
	h.pointer("pointerdown", { button, altKey });
	assert.equal(h.state.requests, 1, `${kind} requests lock in pointerdown`);
	h.pointer("lostpointercapture");
	assert.equal(h.state.gesture, true, "pending lock preserves the hold");
	h.grant();
	h.pointer("lostpointercapture");
	h.pointer("pointermove", { clientX: 100, clientY: 100, movementX: 30, movementY: 10 });
	h.frame();
	assert.ok(kind === "fly" ? Math.abs(h.camera.rotation.y) > 0.01 : h.camera.position.distanceTo(initialPosition) > 0.01, `${kind} consumes relative motion with stationary client coordinates`);
	h.pointer("pointerup", { button: (button + 1) % 3 });
	assert.equal(h.state.gesture, true, "another mouse button cannot end the hold");
	h.pointer("pointerup", { pointerId: 2, button });
	assert.equal(h.state.gesture, true, "another pointer cannot end the hold");
	h.pointer("pointerup", { button });
	assert.equal(h.document.pointerLockElement, null);
	assert.equal(h.state.gesture, false);
	assert.equal(h.state.commits, 2, "changed input and release commit once each, without unlock re-entry");
	assert.equal(h.escape().stopped, undefined, "Escape immediately after release belongs to App");
	h.cleanup();
	console.log(`PASS ${kind}: native-lock event sequence, movement, stray releases, commit and immediate Escape`);
}

{
	const h = mount();
	let appEscapes = 0;
	h.window.addEventListener("keydown", (event) => { if (event.key === "Escape") appEscapes += 1; });
	h.pointer("pointerdown");
	h.grant();
	h.window.dispatchEvent({ type: "keydown", code: "KeyW" });
	h.frame();
	const event = h.escape();
	assert.equal(event.defaultPrevented, undefined, "the browser's unlock default is never blocked");
	assert.equal(h.document.pointerLockElement, null);
	assert.equal(appEscapes, 0, "Esc during the hold unlocks first");
	assert.equal(h.state.fly, false);
	const stopped = h.camera.position.clone();
	h.frame();
	assert.ok(h.camera.position.equals(stopped), "unlock clears held movement keys");
	h.escape();
	assert.equal(appEscapes, 1, "the next Escape immediately reaches shot-look's exit listener");
	h.cleanup();
	console.log("PASS active-hold Escape unlocks first, clears WASD, and the immediate next Escape exits");
}
{
	const h = mount();
	h.pointer("pointerdown");
	h.grant();
	h.document.exitPointerLock(); // Native Escape may deliver unlock before keydown.
	assert.equal(h.state.gesture, false);
	assert.equal(h.escape().stopped, undefined, "unlock-before-keydown cannot swallow the next Escape");
	h.cleanup();
	console.log("PASS browser unlock-before-keydown has no time-based Escape suppression");
}
{
	const h = mount({ lock: "denied" });
	h.pointer("pointerdown");
	h.pointer("pointermove", { clientX: 150, clientY: 120 });
	h.pointer("pointermove", { clientX: 160, clientY: 125 });
	h.frame();
	assert.equal(h.state.requests, 2, "denied lock retries at most once");
	assert.ok(Math.abs(h.camera.rotation.y) > 0.01, "capture fallback still flies");
	h.window.dispatchEvent({ type: "pointerup", pointerId: 1, button: 2 });
	assert.equal(h.state.gesture, false, "window release ends uncaptured gestures");
	h.cleanup();
	console.log("PASS denied lock retains client-coordinate navigation and window release");
}
for (const pointerType of ["touch", "pen"]) {
	const h = mount();
	h.pointer("pointerdown", { pointerType });
	h.pointer("pointermove", { pointerType, clientX: 140 });
	assert.equal(h.state.requests, 0);
	h.cleanup();
}
{
	const h = mount();
	h.pointer("pointerdown");
	h.pointer("pointerup");
	h.grant();
	assert.equal(h.document.pointerLockElement, null, "a late lock grant after release immediately unlocks");
	h.pointer("pointerdown");
	h.grant();
	h.cleanup();
	assert.equal(h.document.pointerLockElement, null, "unmount releases native lock");
	assert.equal(h.state.gesture, false);
}
{
	const h = mount({ enabled: false });
	h.pointer("pointerdown");
	assert.equal(h.state.requests, 0, "the chrome-free player's disabled controls cannot lock");
	h.cleanup();
}
{
	const h = mount();
	// Another camera tool may own the same canvas lock without a navigation
	// hold. Disabling fly controls must not unlock that recording.
	h.document.pointerLockElement = h.canvas;
	h.window.__cozyclayCameraGesture = true;
	h.cleanup();
	assert.equal(h.document.pointerLockElement, h.canvas, "cleanup only releases a navigation-owned lock");
	assert.equal(h.window.__cozyclayCameraGesture, true, "cleanup preserves another camera tool's render ownership");
	h.document.exitPointerLock();
}
console.log("PASS touch/pen fallback, late grant, cleanup, and disabled player controls");
console.log("verify-camera-pointer-lock: all behavioral checks passed");
