import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { aimAt } from "./controls.jsx";
import { SUBJECT_HEIGHT_M } from "./shot.js";
import { shotAtFrame } from "./cuts.js";
import { sampleAt } from "./sample-at.js";
import { probeVisibility } from "./motion/playback-probe.js";
import { RENDER_ACTIVITY_EVENT } from "./use-render-activity.js";
import { reportGlLost } from "./crash-telemetry.js";
import { PRESETS, editorFrameForSubject } from "./stage-startup-defaults.js";

/** Selection marker for the picked cast member: a Unity-style XYZ tripod
 * plus a ground ring at the feet. X/Z arrows also drag the character on the
 * floor (Y is display-only — characters stand on the deck). */
export function ShotRig({ preset, nonce, fovDeg, subject, subjectsAt, frameRef, camRef, look, onMetrics, appliedPresetRef, lastPosRef }) {
	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		// A preset is applied once per (preset, nonce), not once per mount. The
		// Canvas has no Suspense boundary of its own, so a cast member whose FBX
		// is still downloading suspends the whole scene graph; when it resolves,
		// React remounts the siblings — this rig included, on a fresh camera
		// object — and a per-mount seed would snap the shot back to the preset,
		// discarding a frame_shot or a manual move that landed in the meantime
		// (#86 on slow CI runners). Both refs live in App so they survive the
		// remount: the stamp says whether this preset was already applied, the
		// position ref (with look.current) says where the camera last was.
		const stamp = `${preset}:${nonce}`;
		if (appliedPresetRef && appliedPresetRef.current === stamp && lastPosRef?.current) {
			const last = lastPosRef.current;
			cam.position.set(last.x, last.y, last.z);
			cam.rotation.order = "YXZ";
			cam.rotation.set(look.current.pitch, look.current.yaw, 0);
			return;
		}
		if (appliedPresetRef) appliedPresetRef.current = stamp;
		const p = PRESETS[preset];
		const az = (p.azimuth * Math.PI) / 180;
		const el = (p.elevation * Math.PI) / 180;
		const aim = { x: subject.x, z: subject.z };
		const horizontal = p.distance * Math.cos(el);
		cam.position.set(
			aim.x + horizontal * Math.sin(az),
			p.height ?? Math.max(p.targetY + p.distance * Math.sin(el), 0.15),
			aim.z + horizontal * Math.cos(az),
		);
		const angles = aimAt(cam.position, { x: aim.x, y: p.targetY, z: aim.z });
		look.current.yaw = angles.yaw;
		look.current.pitch = angles.pitch; look.current.roll = 0;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [preset, nonce]);


	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		cam.fov = fovDeg;
		cam.updateProjectionMatrix();
	}, [fovDeg, camRef]);

	// A blocking tool must not claim a framing it is not holding, so the subject's
	// feet and eyes are projected into the frame every tick.
	const probe = useRef(new THREE.Vector3());
	const lastMetrics = useRef({ x: NaN, y: NaN, z: NaN, visible: null });
	useFrame(() => {
		const cam = camRef.current;
		if (!cam) return;
		// During motion playback the probe follows the played root, so the
		// "subject out of frame" caption stays honest.
		const frame = frameRef.current;
		const visible = subjectsAt(frame).every(current => probeVisibility(probe.current, cam, current, SUBJECT_HEIGHT_M * (current.scale ?? 1)));
		const previous = lastMetrics.current;
		if (
			Math.abs(previous.x - cam.position.x) +
				Math.abs(previous.y - cam.position.y) +
				Math.abs(previous.z - cam.position.z) >
				1e-4 ||
			previous.visible !== visible
		) {
			lastMetrics.current = {
				x: cam.position.x,
				y: cam.position.y,
				z: cam.position.z,
				visible,
			};
			onMetrics(cam.position, visible);
		}
	});

	return null;
}

/** Plays an authored A→B camera move by driving the shot camera exactly the
    way a fly-drag does — position on the camera, orientation through the look
    ref — so ShotRig's metrics, the slate, and the inset all stay honest for
    free. A right-drag interrupts the dolly: the user always outranks it.

    Two frame sources can drive the move. Standalone preview advances authored
    frames at production cadence; follow mode reads the timeline playhead, so the camera and
    the character motion are two views of the same time axis — playing or
    scrubbing frame 72 at 24 fps puts the camera exactly 3 s into its move.

    frameRef is the imperative playhead routed props and riders already read in
    their own useFrame. The followFrame prop reaches this Canvas subtree one
    commit later, so alone it would pose the camera a paint behind them. */
export function MoveRig({ playing, following, followFrame, frameRef, fps, keys, shots, scene, camRef, look, isInterrupted, onDone }) {
	const invalidate = useThree((state) => state.invalidate);
	const preview = useRef({ frame: 0, finished: false, notified: false });
	const handlers = useRef({ isInterrupted, onDone });
	handlers.current = { isInterrupted, onDone };
	// The follow branch only re-applies when its time changes; in demand mode
	// each apply needs one more frame so ShotRig's metrics see the new pose.
	const appliedFrame = useRef(null);
	useEffect(() => {
		// Arming or reshaping the move must schedule a frame by hand: this
		// component owns no three objects, so in demand mode nothing else will.
		appliedFrame.current = null;
		if (following) invalidate();
	}, [keys, shots, scene, fps, following, invalidate]);
	useEffect(() => {
		// A paused scrub changes the playhead without starting the render loop.
		if (following && !playing) invalidate();
	}, [followFrame, following, playing, invalidate]);
	useEffect(() => {
		if (!playing || keys.length < 1) return undefined;
		const firstFrame = keys[0].frame;
		const lastFrame = keys[keys.length - 1].frame;
		const spanFrames = Math.max(lastFrame - firstFrame, 1);
		const spanSeconds = Math.max(spanFrames / Math.max(fps, 1), 0.1);
		const tickMs = (spanSeconds * 1000) / spanFrames;
		let tick = 0;
		preview.current = { frame: firstFrame, finished: false, notified: false };
		invalidate();
		const timer = window.setInterval(() => {
			if (preview.current.finished) return;
			if (handlers.current.isInterrupted?.()) {
				preview.current.finished = true;
				invalidate();
				return;
			}
			tick += 1;
			preview.current = {
				frame: firstFrame + (lastFrame - firstFrame) * Math.min(tick / spanFrames, 1),
				finished: tick >= spanFrames,
				notified: false,
			};
			invalidate();
		}, tickMs);
		return () => window.clearInterval(timer);
	}, [playing, keys, fps, invalidate]);
	useFrame(() => {
		if ((playing && keys.length < 1) || (!playing && following && !shots.some((shot) => shot.cameraKeys.length))) return;
		const cam = camRef.current;
		if (!cam) return;
		const apply = (frame) => {
			// Timeline/PlayView sampling follows the editorial strips. Standalone
			// preview stays scoped to the selected strip's keys. Entering a Shot
			// applies its authored camera immediately (a hard cut). Leaving into a
			// gap returns null and deliberately applies nothing: the last physical
			// camera pose stays put and FlyControls regain ownership, so we do not
			// invent a second cut to an arbitrary "free camera" preset.
			const timelineShot = following ? shotAtFrame(shots, frame) : null;
			const sampledShot = timelineShot
				? { ...timelineShot, camera: { mode: "keys" } }
				: following ? null : { camera: { mode: "keys" }, cameraKeys: keys };
			const f = sampleAt(scene, sampledShot, frame).camera;
			if (!f) return null;
			cam.position.set(f.pos.x, f.pos.y, f.pos.z);
			look.current.yaw = f.yaw;
			look.current.pitch = f.pitch; look.current.roll = THREE.MathUtils.degToRad(f.rollDeg ?? 0);
			if (Math.abs(cam.fov - f.fovDeg) > 1e-3) {
				cam.fov = f.fovDeg;
				cam.updateProjectionMatrix();
			}
			return f;
		};
		if (playing) {
			const f = apply(preview.current.frame);
			if (preview.current.finished && !preview.current.notified) {
				preview.current.notified = true;
				handlers.current.onDone(f ? f.fovDeg : cam.fov);
			}
			return;
		}
		if (!following) return;
		if (isInterrupted?.()) return; // manual viewport framing owns the paused camera
		const frame = frameRef?.current ?? followFrame;
		if (appliedFrame.current === frame) return;
		appliedFrame.current = frame;
		apply(frame);
		invalidate();
	});
	return null;
}

/**
 * Applies the precomputed follow-camera track to the shot camera. The track
 * is derived offline from the subject trajectory (camera-follow.js), so this
 * rig only samples it at the playhead — scrub, play, PlayView and Record all
 * replay the identical deterministic move. Null-rendering, so every apply
 * must invalidate() by hand in demand mode, like MoveRig. Like MoveRig it
 * prefers frameRef over the frame prop so the camera lands in the same paint
 * as the routed props and riders it follows.
 */
export function FollowCamRig({ enabled, frame, frameRef, scene, shot, camRef, look, isInterrupted }) {
	const invalidate = useThree((state) => state.invalidate);
	const applied = useRef(null);
	useEffect(() => {
		applied.current = null;
		if (enabled) invalidate();
	}, [scene, shot, enabled, invalidate]);
	useEffect(() => { if (enabled) invalidate(); }, [frame, enabled, invalidate]);
	useFrame(() => {
		if (!enabled) return;
		if (isInterrupted?.()) return; // the user is flying; yield until released
		const cam = camRef.current;
		if (!cam) return;
		const playhead = frameRef?.current ?? frame;
		const sample = sampleAt(scene, shot, playhead).camera;
		if (!sample || applied.current === playhead) return;
		applied.current = playhead;
		cam.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
		look.current.yaw = sample.yaw;
		look.current.pitch = sample.pitch; look.current.roll = THREE.MathUtils.degToRad(sample.rollDeg ?? 0);
		// A rail with a lens of its own carries it; otherwise this is the scene lens.
		if (Math.abs(cam.fov - sample.fovDeg) > 1e-3) { cam.fov = sample.fovDeg; cam.updateProjectionMatrix(); }
		invalidate();
	});
	return null;
}

/**
 * Applies the shot camera's yaw/pitch (and roll about the lens axis) from its look ref every frame. Before
 * the camera split, FlyControls owned the shot camera and performed this
 * apply as a side effect of flying; with the fly controls bound to the
 * editor camera, the recording camera still needs its aim (ShotRig, follow,
 * frame-selection) reflected in its actual rotation — the preview and the
 * capture read the camera object, not the ref.
 */
export function ShotLookApplier({ camRef, look }) {
	useFrame(() => {
		const cam = camRef.current;
		if (!cam) return;
		if (cam.rotation.order !== "YXZ") cam.rotation.order = "YXZ";
		const roll = look.current.roll ?? 0; if (cam.rotation.x !== look.current.pitch || cam.rotation.y !== look.current.yaw || cam.rotation.z !== roll) {
			cam.rotation.set(look.current.pitch, look.current.yaw, roll);
		}
	});
	return null;
}

/**
 * Seeds the editor camera once, inside the Canvas root — App-level effects
 * run before R3F mounts its children, so the ref is still null there. The
 * seed frames both the subject and the shot camera: the first editor frame
 * must read as "the set with the camera in it".
 */
/**
 * A short editor-camera glide: 260 ms ease toward a target orientation (and
 * optionally a position), instead of the teleport that made "look at the
 * light" and F-framing feel like a cut. Any user press cancels it — the
 * operator always outranks the tour guide.
 */
export function CameraGlide({ glide, camRef, lookRef, onDone }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const animRef = useRef(null);
	useEffect(() => {
		if (!glide) {
			animRef.current = null;
			return undefined;
		}
		const cam = camRef.current;
		if (!cam) return undefined;
		const fromPos = cam.position.clone();
		const toPos = glide.position ? new THREE.Vector3(glide.position.x, glide.position.y, glide.position.z) : fromPos.clone();
		const angles = aimAt(toPos, glide.target);
		const from = { yaw: lookRef.current.yaw, pitch: lookRef.current.pitch };
		let dYaw = angles.yaw - from.yaw;
		while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
		while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
		// elapsed accumulates render-loop deltas: the glide needs no wall clock
		animRef.current = { fromPos, toPos, from, dYaw, dPitch: angles.pitch - from.pitch, elapsed: 0 };
		const cancel = () => {
			animRef.current = null;
			onDone?.();
		};
		gl.domElement.addEventListener("pointerdown", cancel, true);
		invalidate();
		return () => gl.domElement.removeEventListener("pointerdown", cancel, true);
		// camRef/lookRef are stable refs; onDone identity is per-glide noise
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [glide, gl, invalidate]);
	useFrame((_, delta) => {
		const anim = animRef.current;
		const cam = camRef.current;
		if (!anim || !cam) return;
		anim.elapsed += Math.min(delta, 0.1) * 1000;
		const t = Math.min(1, anim.elapsed / 260);
		const eased = 1 - (1 - t) ** 3;
		cam.position.lerpVectors(anim.fromPos, anim.toPos, eased);
		const yaw = anim.from.yaw + anim.dYaw * eased;
		const pitch = anim.from.pitch + anim.dPitch * eased;
		lookRef.current = { yaw, pitch };
		cam.rotation.order = "YXZ";
		cam.rotation.set(pitch, yaw, 0);
		if (t >= 1) {
			animRef.current = null;
			onDone?.();
		} else {
			invalidate();
		}
	});
	return null;
}

export function EditorCamSeed({ camRef, lookRef, subject }) {
	const seeded = useRef(false);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		if (seeded.current) return;
		const cam = camRef.current;
		if (!cam) return;
		seeded.current = true;
		// The selected character owns the first read. The shot camera remains a
		// useful reference in the inset; mixing its position into this seed pushed
		// the editor eye several metres back and made the mannequin look tiny.
		const frame = editorFrameForSubject(subject);
		const { target, position } = frame;
		cam.position.set(position.x, position.y, position.z);
		const angles = aimAt(cam.position, target);
		lookRef.current = { yaw: angles.yaw, pitch: angles.pitch };
		cam.rotation.order = "YXZ";
		cam.rotation.set(angles.pitch, angles.yaw, 0);
		invalidate();
	});
	return null;
}

export function RenderLoopController({ stageRef }) {
	const frameloop = useThree((state) => state.frameloop);
	const setFrameloop = useThree((state) => state.setFrameloop);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		const apply = (next) => {
			setFrameloop(next ? "always" : "demand");
			if (next) invalidate();
		};
		const onActivity = (event) => apply(event.detail);
		window.addEventListener(RENDER_ACTIVITY_EVENT, onActivity);
		return () => window.removeEventListener(RENDER_ACTIVITY_EVENT, onActivity);
	}, [invalidate, setFrameloop]);
	useEffect(() => {
		if (stageRef.current) stageRef.current.dataset.actualRenderLoop = frameloop;
	}, [frameloop, stageRef]);
	return null;
}

/** GPU resets — sleep/wake, a driver restart, VRAM pressure from an export —
 * kill the WebGL context, and without listeners the stage goes black and
 * stays black with no message. preventDefault on webglcontextlost is the
 * documented opt-in for browser-driven restoration; on restore, kick the
 * demand loop so the first frame actually paints. */
export function ContextLossGuard({ onLostChange }) {
	const gl = useThree((state) => state.gl);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		const canvas = gl.domElement;
		const onLost = (event) => {
			event.preventDefault();
			onLostChange(true);
			reportGlLost("context_lost");
		};
		const onRestored = () => { onLostChange(false); invalidate(); };
		canvas.addEventListener("webglcontextlost", onLost);
		canvas.addEventListener("webglcontextrestored", onRestored);
		return () => {
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
		};
	}, [gl, invalidate, onLostChange]);
	return null;
}

export function ViewportLayoutInvalidator({ insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		// The pane frame is regular DOM while its picture is a scissored WebGL
		// viewport. In demand mode a drag can commit its final DOM position just
		// after the continuous loop stops, leaving the picture at the previous
		// coordinates. Redraw now and once more after layout has settled.
		invalidate();
		const frame = requestAnimationFrame(invalidate);
		return () => cancelAnimationFrame(frame);
	}, [invalidate, insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom]);
	return null;
}
