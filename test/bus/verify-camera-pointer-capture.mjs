#!/usr/bin/env node
// Execute the real FlyControls pointerdown handler (as verify-camera-pointer-lock.mjs does) on a canvas whose
// setPointerCapture throws, as a browser does when the pointer is no longer active (InvalidStateError /
// NotFoundError). The gesture must start without capture and end cleanly on the window's pointerup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as THREE from "three";

const source = readFileSync(new URL("../../src/controls.jsx", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "")
	.replace(/^export /gm, "");

class Surface {
	listeners = new Map();
	addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
	removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== fn)); }
	dispatchEvent(event) {
		event.preventDefault ??= () => {};
		event.stopPropagation ??= () => {};
		for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
		return event;
	}
}

for (const name of ["InvalidStateError", "NotFoundError"]) {
	const window = new Surface(), document = new Surface(), canvas = new Surface();
	let fly = false;
	canvas.style = {};
	canvas.focus = () => {};
	canvas.setPointerCapture = () => { throw Object.assign(new Error(`setPointerCapture: ${name}`), { name }); };
	canvas.hasPointerCapture = () => false;
	canvas.releasePointerCapture = () => {};
	canvas.requestPointerLock = () => {};
	document.pointerLockElement = null;
	document.exitPointerLock = () => {};
	const effects = [];
	const context = {
		THREE, window, document,
		CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
		useRef: (current) => ({ current }),
		useEffect: (effect) => effects.push(effect),
		useFrame: () => {},
		useThree: () => ({ gl: { domElement: canvas }, invalidate: () => {} }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		noteCameraGesture: () => {},
		announceNav: () => {},
	};
	const Controls = runInNewContext(`${source}\nFlyControls;`, context);
	Controls({ enabled: true, camRef: { current: new THREE.PerspectiveCamera() }, look: { current: { yaw: 0, pitch: 0 } },
		onCameraChange: () => {}, onFlyStateChange: (value) => { fly = value; } });
	const cleanup = effects.map((effect) => effect());
	const down = { type: "pointerdown", pointerId: 7, pointerType: "mouse", button: 2, clientX: 10, clientY: 10 };
	assert.doesNotThrow(() => canvas.dispatchEvent(down), `${name} from setPointerCapture stays inside the gesture start`);
	assert.equal(window.__cozyclayCameraGesture, true, `${name}: the fly gesture starts without capture`);
	assert.equal(fly, true, `${name}: the fly state follows the gesture`);
	window.dispatchEvent({ type: "pointerup", pointerId: 7, button: 2 });
	assert.equal(window.__cozyclayCameraGesture, false, `${name}: the window pointerup ends the uncaptured gesture`);
	assert.equal(fly, false, `${name}: the fly state is cleared on release`);
	cleanup.forEach((fn) => fn?.());
	console.log(`PASS ${name}: gesture starts without capture and ends on window pointerup`);
}
console.log("verify-camera-pointer-capture: all behavioral checks passed");
