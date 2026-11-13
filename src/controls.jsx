import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { noteCameraGesture } from "./thrash-friction.js"; import { announceNav } from "./nav-signal.js";

const MOVE_SPEED = 2.6; // metres per second
const CRANE_SPEED = 1.3; // Q/E up/down runs at half walk speed — fine
// vertical adjustments while posing need the finer step, not a 2.6 m/s jump
const LOOK_SENS = 0.0032; // radians per pixel
const ORBIT_SENS = 0.006; // radians per pixel, a touch faster than looking
const PAN_SENS = 0.0022; // metres per pixel at 1 m of pivot distance
const DOLLY_STEP = 0.0016; // metres per wheel unit
const PITCH_LIMIT = (85 * Math.PI) / 180;
const BOOST = 2.6; // Shift during a fly
const MIN_ORBIT_RADIUS = 0.6;

/** yaw/pitch -> unit forward vector for a YXZ-ordered camera */
export function forwardFrom(yaw, pitch) {
	return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/** point a camera at a target and return the matching yaw/pitch */
export function aimAt(position, target) {
	const dx = target.x - position.x;
	const dy = target.y - position.y;
	const dz = target.z - position.z;
	return {
		yaw: Math.atan2(-dx, -dz),
		pitch: Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-6)),
	};
}

/**
 * Viewport navigation, on Unity's bindings.
 *
 * The left button belongs to the CONTENT — selecting and dragging gizmo
 * handles — and the camera lives on the other buttons. That split is the whole
 * point: while the left button was also "look around", every press had two
 * possible meanings and the tool had to guess, which is why W/E/R could not be
 * the transform hotkeys and why grabbing an object also swung the view.
 *
 *   right-drag            look around (flythrough)
 *   right-held + WASD/QE  walk and crane, live ONLY during the flythrough
 *   right-held + Shift    faster
 *   right-held + wheel    change the fly speed instead of dollying
 *   middle-drag           pan
 *   Alt + left-drag       orbit the pivot the caller supplies (the selection)
 *   wheel                 dolly
 *
 * Fly, pan and orbit request pointer lock for the hold so the system
 * cursor stays at the press and reappears there on release. Capture plus
 * clientX remains the fallback when lock is denied.
 *
 * `getPivot()` is optional and returns a world point to orbit; without one,
 * Alt-drag orbits a point straight ahead of the lens.
 */
export function FlyControls({ enabled, cameraLocked = false, camRef, look, getPivot, onFlyStateChange, onCameraChange }) {
	const { gl, invalidate } = useThree();
	const keys = useRef(new Set());
	const gesture = useRef(null); // { kind: "fly" | "pan" | "orbit", pointerId, x, y, ... }
	const speedScale = useRef(1);
	const invalidateRaf = useRef(0);
	const flyStateRef = useRef(onFlyStateChange);
	flyStateRef.current = onFlyStateChange;
	const cameraChangeRef = useRef(onCameraChange);
	cameraChangeRef.current = onCameraChange;
	const pivotRef = useRef(getPivot);
	pivotRef.current = getPivot;

	useEffect(() => {
		if (!enabled) return undefined;
		const element = gl.domElement;
		element.tabIndex = 0;
		element.style.touchAction = "none";
		let lockPending = false;
		let lockAttempts = 0;

		const isTyping = () => {
			const el = document.activeElement;
			return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
		};
		const isLocked = () => document.pointerLockElement === element;
		const requestNavLock = () => {
			if (lockPending || isLocked() || lockAttempts >= 2) return;
			if (typeof element.requestPointerLock !== "function") return;
			lockAttempts += 1;
			lockPending = true;
			try {
				const result = element.requestPointerLock();
				if (result && typeof result.catch === "function") {
					result.catch(() => { lockPending = false; });
				}
			} catch {
				lockPending = false;
			}
		};
		const releaseNavLock = () => {
			lockPending = false;
			if (document.pointerLockElement === element) document.exitPointerLock();
		};
		// Pointer events can arrive faster than the display refreshes. Camera
		// refs are updated immediately for the latest input, but invalidate the
		// demand renderer at most once per animation frame so a 120/240 Hz mouse
		// cannot queue multiple full WebGL renders for the same visible frame.
		const scheduleInvalidate = () => {
			if (invalidateRaf.current) return;
			invalidateRaf.current = requestAnimationFrame(() => {
				invalidateRaf.current = 0;
				invalidate();
			});
		};
		const flushInvalidate = () => {
			if (invalidateRaf.current) {
				cancelAnimationFrame(invalidateRaf.current);
				invalidateRaf.current = 0;
			}
			invalidate();
		};

		/* Physical key positions, not characters: `e.key` follows the OS input
		 * method, so in Hangul IME mode pressing W yields "ㅈ" and every
		 * camera key goes dead — the exact "WASD is blocked" failure Korean
		 * users hit. `e.code` is layout/IME independent. */
		const KEY_BY_CODE = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyQ: "q", KeyE: "e", ShiftLeft: "shift", ShiftRight: "shift" };
		const onKeyDown = (e) => {
			if (isTyping()) return;
			// Movement keys are live only while the flythrough button is held.
			// Outside a fly they are tool hotkeys and belong to the app.
			if (gesture.current?.kind !== "fly") return;
			const key = KEY_BY_CODE[e.code];
			if (key) {
				if (!keys.current.has(key) && key !== "shift") announceNav("walk", key); keys.current.add(key);
				e.preventDefault();
			}
		};
		const onKeyUp = (e) => {
			const key = KEY_BY_CODE[e.code];
			if (key) keys.current.delete(key);
		};
		// During a live hold Esc releases navigation first. Never prevent the
		// browser's unlock default, and never suppress a later Escape by time:
		// once pointerlockchange or pointerup ended the hold, App owns Esc again.
		const onEscapeCapture = (e) => {
			if (e.key !== "Escape") return;
			if (isLocked() || lockPending || gesture.current) {
				e.stopPropagation();
				endGesture();
			}
		};

		const endGesture = (e) => {
			const active = gesture.current;
			if (!active) return;
			// Mouse buttons share one pointerId. A left-up during a right-held
			// fly must not end the look; blur/cancel have no button and always end.
			if (e && typeof e.pointerId === "number" && e.pointerId !== active.pointerId) return;
			if (e?.type === "pointerup" && e.button !== active.button) return;
			if (e && active.pointerId !== undefined && element.hasPointerCapture(active.pointerId)) {
				element.releasePointerCapture(active.pointerId);
			}
			// Clear the gesture before exitPointerLock so pointerlockchange
			// cannot re-enter and double-commit.
			gesture.current = null;
			if (typeof window !== "undefined") window.__cozyclayCameraGesture = false;
			releaseNavLock();
			keys.current.clear();
			// the fly speed set with the wheel persists between flights, as it does in Unity
			element.style.cursor = "";
			flyStateRef.current?.(false);
			flushInvalidate();
			// A gesture that moved the view counts toward camera:thrash (thrash-friction.js).
			if (active.changed) { cameraChangeRef.current?.(); noteCameraGesture(active.kind); }
		};

		const onLostCapture = (e) => {
			// Pointer lock releases capture when it engages. Ending the gesture
			// here would abort fly/pan/orbit before the first move, and WASD
			// during a right-held walk would go dead.
			if (gesture.current && (lockPending || isLocked())) return;
			endGesture(e);
		};

		const onPointerLockChange = () => {
			if (isLocked()) {
				lockPending = false;
				if (!gesture.current) document.exitPointerLock();
				return;
			}
			lockPending = false;
			if (gesture.current) endGesture();
		};
		const onPointerLockError = () => { lockPending = false; };

		const onPointerDown = (e) => {
			if (cameraLocked) return;
			if (gesture.current) return;
			const orbit = e.button === 0 && e.altKey;
			const kind = e.button === 2 ? "fly" : e.button === 1 ? "pan" : orbit ? "orbit" : null;
			if (!kind) return;
			e.preventDefault();
			// Alt-drag and middle-drag must not reach the gizmo picker either;
			// the picker only claims plain left presses, so this is belt and
			// braces for the middle button's browser autoscroll.
			e.stopPropagation();
			const cam = camRef.current;
			const pivot = kind === "orbit" && cam ? resolvePivot(cam) : null;
			gesture.current = { kind, pointerId: e.pointerId, button: e.button, x: e.clientX, y: e.clientY, pivot, changed: false };
			if (typeof window !== "undefined") window.__cozyclayCameraGesture = true;
			try { element.setPointerCapture(e.pointerId); } catch { /* pointer already gone: window pointerup still ends it */ }
			element.focus();
			element.style.cursor = kind === "fly" ? "crosshair" : kind === "pan" ? "grabbing" : "move";
			lockAttempts = 0;
			if (e.pointerType !== "touch" && e.pointerType !== "pen") requestNavLock();
			if (kind === "fly") flyStateRef.current?.(true);
			announceNav(kind); scheduleInvalidate();
		};

		/** the point Alt-drag turns around: the caller's selection, or a point
		 * a few metres down the lens when there is nothing selected */
		const resolvePivot = (cam) => {
			const supplied = pivotRef.current?.();
			if (supplied) return new THREE.Vector3(supplied.x, supplied.y, supplied.z);
			return cam.position.clone().addScaledVector(forwardFrom(look.current.yaw, look.current.pitch), 3);
		};

		const onPointerMove = (e) => {
			const active = gesture.current;
			if (!active) return;
			if (!isLocked() && !lockPending && e.pointerType !== "touch" && e.pointerType !== "pen") {
				requestNavLock();
			}
			const locked = isLocked();
			const dx = locked ? (e.movementX ?? 0) : e.clientX - active.x;
			const dy = locked ? (e.movementY ?? 0) : e.clientY - active.y;
			if (!locked) {
				active.x = e.clientX;
				active.y = e.clientY;
			}
			const cam = camRef.current;
			if (!cam) return;

			if (active.kind === "fly") {
				look.current.yaw -= dx * LOOK_SENS;
				look.current.pitch -= dy * LOOK_SENS;
				look.current.pitch = THREE.MathUtils.clamp(look.current.pitch, -PITCH_LIMIT, PITCH_LIMIT);
				active.changed = active.changed || dx !== 0 || dy !== 0;
				if (dx !== 0 || dy !== 0) {
					cameraChangeRef.current?.();
					// Camera gestures run in demand mode. One explicit
					// invalidation per changed input is enough; keeping the
					// entire scene loop on "always" rendered frozen panes too.
					scheduleInvalidate();
				}
				return;
			}
			if (active.kind === "pan") {
				// Slide the camera across its own image plane, scaled by how far
				// away the subject is so panning feels the same at any distance.
				const distance = Math.max(cam.position.distanceTo(resolvePivot(cam)), 1);
				const right = new THREE.Vector3(Math.cos(look.current.yaw), 0, -Math.sin(look.current.yaw));
				const up = new THREE.Vector3(0, 1, 0);
				cam.position.addScaledVector(right, -dx * PAN_SENS * distance);
				cam.position.addScaledVector(up, dy * PAN_SENS * distance);
				cam.position.y = Math.max(cam.position.y, 0.12);
				active.changed = active.changed || dx !== 0 || dy !== 0;
				if (dx !== 0 || dy !== 0) {
					cameraChangeRef.current?.();
					scheduleInvalidate();
				}
				return;
			}
			// orbit: swing the camera around the pivot, then re-aim at it so the
			// yaw/pitch the rest of the app reads stays the truth
			const pivot = active.pivot ?? resolvePivot(cam);
			const offset = cam.position.clone().sub(pivot);
			const radius = Math.max(offset.length(), MIN_ORBIT_RADIUS);
			const spherical = new THREE.Spherical().setFromVector3(offset);
			spherical.radius = radius;
			spherical.theta -= dx * ORBIT_SENS;
			spherical.phi = THREE.MathUtils.clamp(spherical.phi + dy * ORBIT_SENS, 0.08, Math.PI - 0.08);
			cam.position.copy(pivot).add(new THREE.Vector3().setFromSpherical(spherical));
			cam.position.y = Math.max(cam.position.y, 0.12);
			const angles = aimAt(cam.position, pivot);
			look.current.yaw = angles.yaw;
			look.current.pitch = angles.pitch;
			active.changed = active.changed || dx !== 0 || dy !== 0;
			if (dx !== 0 || dy !== 0) {
				cameraChangeRef.current?.();
				scheduleInvalidate();
			}
		};

		const onWheel = (e) => {
			const cam = camRef.current;
			if (!cam) return;
			e.preventDefault();
			if (gesture.current?.kind === "fly") {
				// Unity: the wheel sets the flythrough speed, it does not dolly.
				speedScale.current = THREE.MathUtils.clamp(speedScale.current * (e.deltaY > 0 ? 0.9 : 1.1), 0.15, 6);
				return;
			}
			cam.position.addScaledVector(forwardFrom(look.current.yaw, look.current.pitch), -e.deltaY * DOLLY_STEP);
			announceNav("dolly"); cameraChangeRef.current?.();
		};

		// A right-drag is navigation, so the browser menu must not interrupt it.
		const onContextMenu = (e) => e.preventDefault();

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keydown", onEscapeCapture, true);
		window.addEventListener("keyup", onKeyUp);
		element.addEventListener("pointerdown", onPointerDown);
		element.addEventListener("pointermove", onPointerMove);
		element.addEventListener("pointerup", endGesture);
		element.addEventListener("pointercancel", endGesture);
		window.addEventListener("pointerup", endGesture);
		window.addEventListener("pointercancel", endGesture);
		element.addEventListener("lostpointercapture", onLostCapture);
		element.addEventListener("contextmenu", onContextMenu);
		element.addEventListener("wheel", onWheel, { passive: false });
		document.addEventListener("pointerlockchange", onPointerLockChange);
		document.addEventListener("pointerlockerror", onPointerLockError);
		// Alt-tabbing away mid-fly must not leave keys stuck down.
		window.addEventListener("blur", endGesture);
		return () => {
			if (invalidateRaf.current) {
				cancelAnimationFrame(invalidateRaf.current);
				invalidateRaf.current = 0;
			}
			keys.current.clear();
			gesture.current = null;
			if (typeof window !== "undefined") window.__cozyclayCameraGesture = false;
			releaseNavLock();
			element.style.cursor = "";
			flyStateRef.current?.(false);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keydown", onEscapeCapture, true);
			window.removeEventListener("keyup", onKeyUp);
			element.removeEventListener("pointerdown", onPointerDown);
			element.removeEventListener("pointermove", onPointerMove);
			element.removeEventListener("pointerup", endGesture);
			element.removeEventListener("pointercancel", endGesture);
			window.removeEventListener("pointerup", endGesture);
			window.removeEventListener("pointercancel", endGesture);
			element.removeEventListener("lostpointercapture", onLostCapture);
			element.removeEventListener("contextmenu", onContextMenu);
			element.removeEventListener("wheel", onWheel);
			document.removeEventListener("pointerlockchange", onPointerLockChange);
			document.removeEventListener("pointerlockerror", onPointerLockError);
			window.removeEventListener("blur", endGesture);
		};
	}, [enabled, gl, camRef, look]);

	useFrame((_, delta) => {
		const cam = camRef.current;
		if (!cam) return;
		cam.rotation.order = "YXZ";
		cam.rotation.y = look.current.yaw;
		cam.rotation.x = look.current.pitch;
		cam.rotation.z = 0;

		if (!enabled || keys.current.size === 0) return;
		const boost = keys.current.has("shift") ? BOOST : 1;
		const step = MOVE_SPEED * speedScale.current * boost * Math.min(delta, 0.1);
		// walking stays on the floor plane; Q/E is the crane
		const forward = new THREE.Vector3(-Math.sin(look.current.yaw), 0, -Math.cos(look.current.yaw));
		const right = new THREE.Vector3(Math.cos(look.current.yaw), 0, -Math.sin(look.current.yaw));
		if (keys.current.has("w")) cam.position.addScaledVector(forward, step);
		if (keys.current.has("s")) cam.position.addScaledVector(forward, -step);
		if (keys.current.has("d")) cam.position.addScaledVector(right, step);
		if (keys.current.has("a")) cam.position.addScaledVector(right, -step);
		const crane = CRANE_SPEED * speedScale.current * boost * Math.min(delta, 0.1);
		if (keys.current.has("e")) cam.position.y += crane;
		if (keys.current.has("q")) cam.position.y -= crane;
		cam.position.y = Math.max(cam.position.y, 0.12);
		if (gesture.current) {
			gesture.current.changed = true;
			cameraChangeRef.current?.();
		}
	});

	return null;
}
