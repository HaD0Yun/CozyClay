import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { activeAt, resolveRailSchedule } from "./camera-rail-schedule.js";
import { sampleAt } from "./sample-at.js";
import { createCameraPerformance, framingFromCamera } from "./camera-performance.js";
import { ko } from "./locale.js";

const SENSITIVITY = 0.0032;
const PITCH_LIMIT = 85 * Math.PI / 180;

/** One pointer-locked rail performance. Nothing is authored until its last
 * frame has actually been applied; Escape, blur or a paused take discards
 * the draft and leaves the previous recording untouched. */
function useRailRecording(options) {
	const handlers = useRef(options);
	useLayoutEffect(() => { handlers.current = options; });
	const session = useRef(null);
	const [active, setActive] = useState(false);

	const finish = useCallback((save = false) => {
		const take = session.current;
		if (!take) return;
		session.current = null;
		setActive(false);
		handlers.current.setPlaying(false);
		handlers.current.previewEndRef.current = null;
		window.__cozyclayCameraGesture = false;
		if (document.pointerLockElement === take.canvas) document.exitPointerLock();
		if (save) handlers.current.writeTake(take.shot.id, { startFrame: take.start, samples: take.samples });
	}, []);

	useEffect(() => {
		const move = event => {
			const take = session.current;
			if (!take?.running || document.pointerLockElement !== take.canvas) return;
			take.yaw -= event.movementX * SENSITIVITY;
			take.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, take.pitch - event.movementY * SENSITIVITY));
		};
		const locked = () => {
			const take = session.current;
			if (!take) return;
			if (document.pointerLockElement !== take.canvas) { finish(); return; }
			if (take.running) return;
			take.running = true;
			window.__cozyclayCameraGesture = true;
			const current = handlers.current;
			current.setFrame(take.shot.startFrame + take.start);
			current.previewEndRef.current = take.shot.startFrame + take.end;
			current.setPlaying(true);
		};
		const failed = () => {
			if (!session.current) return;
			finish();
			handlers.current.onLockError();
		};
		const escape = event => {
			if (event.key !== "Escape" || !session.current) return;
			event.stopPropagation();
			finish();
		};
		const blur = () => finish();
		const pointer = event => {
			if (session.current?.canvas === event.target) event.stopPropagation();
		};
		// A take aims the camera, not objects under the locked cursor. Keep
		// these events out of scene selection, gizmos and their raycasters.
		document.addEventListener("pointermove", pointer, true);
		document.addEventListener("pointerdown", pointer, true);
		document.addEventListener("mousemove", move);
		document.addEventListener("pointerlockchange", locked);
		document.addEventListener("pointerlockerror", failed);
		window.addEventListener("keydown", escape, true);
		window.addEventListener("blur", blur);
		return () => {
			const take = session.current;
			session.current = null;
			if (take) window.__cozyclayCameraGesture = false;
			if (take && document.pointerLockElement === take.canvas) document.exitPointerLock();
			document.removeEventListener("mousemove", move);
			document.removeEventListener("pointerlockchange", locked);
			document.removeEventListener("pointerlockerror", failed);
			window.removeEventListener("keydown", escape, true);
			window.removeEventListener("blur", blur);
			document.removeEventListener("pointermove", pointer, true);
			document.removeEventListener("pointerdown", pointer, true);
		};
	}, [finish]);

	useEffect(() => {
		const take = session.current;
		// The final pose still has to run through the canvas before saving.
		if (take?.running && !options.playing && options.frameRef.current < take.shot.startFrame + take.end) finish();
		if (take && options.shot?.id !== take.shot.id) finish();
	});

	function start() {
		if (session.current) return false;
		const current = handlers.current, shot = current.shot;
		if (shot?.camera?.mode !== "rail") return false;
		const schedule = resolveRailSchedule({ ...shot.camera, frameCount: shot.endFrame - shot.startFrame + 1 });
		if (!activeAt(schedule, schedule.startFrame)) return false;
		const canvas = current.stageRef.current?.querySelector("canvas");
		if (!canvas?.requestPointerLock) { current.onLockError(); return false; }
		const cleanShot = { ...shot, camera: { ...shot.camera, aimTake: null } };
		const initial = sampleAt(current.scene, cleanShot, shot.startFrame + schedule.startFrame).camera;
		if (!initial) return false;
		current.enterShotLook();
		current.manualRef.current = false;
		current.setMovePlaying(false);
		const take = { shot: cleanShot, scene: current.scene, canvas, running: false,
			start: schedule.startFrame, end: schedule.endFrame, samples: [], yaw: initial.yaw, pitch: initial.pitch };
		session.current = take;
		setActive(true);
		window.__cozyclayCameraGesture = true;
		try {
			const request = canvas.requestPointerLock();
			request?.then(() => {
				if (!session.current && document.pointerLockElement === canvas) document.exitPointerLock();
			}, () => {
				if (session.current !== take) return;
				finish(); handlers.current.onLockError();
			});
		} catch {
			finish(); current.onLockError();
		}
		return true;
	}

	function tick() {
		const take = session.current;
		if (!take?.running) return;
		const current = handlers.current;
		const frame = current.frameRef.current;
		const local = frame - take.shot.startFrame;
		if (local < take.start || local > take.end) { finish(); return; }
		const camera = current.camRef.current;
		const sample = sampleAt(take.scene, take.shot, frame).camera;
		if (!camera || !sample) return;
		camera.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
		current.look.current = { yaw: take.yaw, pitch: take.pitch, roll: (sample.rollDeg ?? 0) * Math.PI / 180 };
		camera.rotation.order = "YXZ";
		camera.rotation.set(take.pitch, take.yaw, current.look.current.roll);
		if (camera.fov !== sample.fovDeg) { camera.fov = sample.fovDeg; camera.updateProjectionMatrix(); }
		const offset = local - take.start;
		// Slow renders can skip production frames. Keep the last performed
		// orientation until the next observed frame, never invent an ease.
		while (take.samples.length < offset) take.samples.push({ ...(take.samples.at(-1) ?? { yaw: take.yaw, pitch: take.pitch }) });
		take.samples[offset] = { yaw: take.yaw, pitch: take.pitch };
		if (local === take.end) finish(true);
	}
	return { active, start, cancel: () => finish(), tick };
}

export function RailRecordingRig({ recording }) {
	useFrame(() => recording.tick());
	return null;
}

/** Preserve walk-camera recording for keyed shots; rail shots record aim. */
export function useCameraPerformance(options) {
	const current = useRef(options);
	useLayoutEffect(() => { current.current = options; });
	const rail = useRailRecording(options);
	const shotId = useRef(null);
	const walkRef = useRef(null);
	const [walking, setWalking] = useState(false);
	useEffect(() => {
		const walk = createCameraPerformance({ sample: () => framingFromCamera(current.current.camRef.current, current.current.look.current) });
		walkRef.current = walk;
		return () => walk.cancel();
	}, []);
	function start() {
		const value = current.current, walk = walkRef.current;
		if (walk.active || rail.active || !value.shot) return false;
		if (value.shot.camera?.mode === "rail") return rail.start();
		if (!walk.start({ startFrame: value.shot.startFrame, endFrame: value.shot.endFrame, fps: value.fps })) return false;
		value.enterShotLook();
		shotId.current = value.shot.id;
		value.manualRef.current = true;
		setWalking(true);
		value.notify(ko("Recording camera performance — right-drag and WASD to shoot; Stop saves editable keys", "퍼포먼스 녹화 중 — 오른쪽 드래그와 WASD로 촬영하고 Stop으로 키를 저장하세요"));
		return true;
	}
	function stop() {
		if (rail.active) { rail.cancel(); return null; }
		const value = current.current, id = shotId.current, keys = walkRef.current.stop();
		shotId.current = null;
		setWalking(false);
		value.manualRef.current = false;
		if (!id || !keys.length) { value.notify(ko("No camera performance was recorded", "녹화된 퍼포먼스가 없습니다")); return null; }
		value.setFrame(keys.at(-1).frame);
		value.writeKeys(id, keys);
		value.notify(ko(`Camera performance saved as ${keys.length} editable keys`, `퍼포먼스를 편집 가능한 키 ${keys.length}개로 저장했어요`));
		return keys;
	}
	return { rail, active: walking || rail.active, start, stop };
}
