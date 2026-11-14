import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { POSE_BONES, normalizeBoneName, primeBindPose } from "./poses.js";
import { poseThumbnail, warmThumbnailModels } from "./pose-thumbs.js";
import { IK_TRACKS, MID_TRACKS, ikControlIsExposed } from "./motion/ik.js";
import { pickIkHit } from "./motion/ik-pick.js";
import { blockerDistanceTo, exposureProbe } from "./motion/ik-exposure.js";
import { shouldRefreshIkExposure } from "./use-render-activity.js";
import { POSER_LAYER } from "./dualview.jsx";
import { ko } from "./locale.js";
import { ROTATION_AXES, backFaceFade, bindQuaternionOf, handleColor as sideColor, ringAngle, rotationFromBindDeg, rotationReadout } from "./pose-gizmo.js";
import "./pose-gizmo.css";

/** Same normalised-name match rule as poses.js: equal, or one is a suffix of
 * the other, so `mixamorig:LeftArm`, `mixamorigLeftArm` and `LeftArm` all hit. */
function matchesBone(boneName, entry) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(entry.bone);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

const HANDLE_RADIUS = 0.05;

/** Handle colour by joint group, mirroring the reference's arm/leg/torso/head
 * colour coding. */
function handleColor(entry) {
	const id = entry.id;
	if (id === "hips" || id.startsWith("spine") || id === "chest" || id === "upperChest") return "#ffd23d";
	if (id === "neck" || id === "head") return "#b98cff";
	if (id.includes("Arm") || id.includes("ForeArm") || id.includes("Hand") || id.includes("Shoulder")) return "#ff8a3d";
	return "#4dd2ff";
}

/**
 * Draggable joint spheres for pose mode. While `enabled`, renders one handle
 * per POSE_BONES joint at the joint's world position. Dragging a handle swings
 * that joint's limb toward the pointer: the pointer is projected onto the
 * camera-facing plane through the joint and the bone is rotated so its
 * bone->child direction follows the projected point (the rotation axis that
 * best matches the drag direction in screen space). Each move calls
 * `onChange()`.
 */
export function PoseHandles({ root, enabled, onChange, onCommit }) {
	const { camera, gl, raycaster } = useThree();
	const meshRefs = useRef([]);
	const jointsRef = useRef(new Map());
	const dragRef = useRef(null);
	const dragHandlersRef = useRef(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	// Called once when a drag that actually moved a joint ends: the pose the
	// rig now stands in is the author's, and the host keeps it.
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;
	const tmp = useRef({
		origin: new THREE.Vector3(),
		limb: new THREE.Vector3(),
		dir: new THREE.Vector3(),
		quat: new THREE.Quaternion(),
		ndc: new THREE.Vector2(),
		target: new THREE.Vector3(),
		qDelta: new THREE.Quaternion(),
		qWorld: new THREE.Quaternion(),
		qParent: new THREE.Quaternion(),
		qNew: new THREE.Quaternion(),
	}).current;
	// Late safety net only. Character primes the bind at clone time, while the
	// rig is untouched; by the time this mounts a pose has already been applied,
	// so a snapshot taken here would call that pose "rest". primeBindPose is a
	// no-op when the stamp exists, which is the normal path.
	useEffect(() => {
		primeBindPose(root);
	}, [root]);

	// Resolve every joint to its bone instances whenever the character or pose
	// mode changes. Mixamo FBX exports nest an identity "skinned" copy under
	// the control bone; the first match is the control bone and dragging it
	// carries the whole subtree, so the nested copy must not be written again.
	// Resolution happens in an effect but is consumed during render, so a
	// version counter is what actually re-renders the handles into the scene.
	const [resolved, setResolved] = useState(0);

	useEffect(() => {
		jointsRef.current.clear();
		if (!root || !enabled) {
			setResolved((n) => n + 1);
			return;
		}
		for (const entry of POSE_BONES) {
			const found = [];
			root.traverse((object) => {
				if (object.isBone && matchesBone(object.name, entry)) found.push(object);
			});
			if (found.length) jointsRef.current.set(entry.id, found);
		}
		setResolved((n) => n + 1);
	}, [root, enabled]);

	useEffect(() => {
		if (!enabled) return undefined;
		const onMove = (ev) => {
			const d = dragRef.current;
			if (!d) return;
			const rect = gl.domElement.getBoundingClientRect();
			tmp.ndc.set(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(tmp.ndc, camera);
			if (!raycaster.ray.intersectPlane(d.plane, tmp.target)) return;
			tmp.target.sub(d.origin);
			if (tmp.target.lengthSq() < 1e-8) return;
			tmp.target.normalize();
			tmp.qDelta.setFromUnitVectors(d.limbDir, tmp.target);
			const before = d.writable.map((bone) => bone.quaternion.toArray());
			for (const bone of d.writable) {
				bone.parent.getWorldQuaternion(tmp.qParent).invert();
				bone.getWorldQuaternion(tmp.qWorld);
				tmp.qNew.multiplyQuaternions(tmp.qDelta, tmp.qWorld).premultiply(tmp.qParent);
				bone.quaternion.copy(tmp.qNew);
				bone.updateMatrixWorld(true);
			}
			d.moved = true;
			onChangeRef.current?.(before, d.writable.map((bone) => bone.quaternion.toArray()));
		};
		const onUp = () => {
			// Detach this drag's listeners but KEEP the handler pair — nulling
			// it here bricks every subsequent drag (startDrag refuses to start
			// without it), the same failure the IK handles had. removeEventListener
			// is idempotent.
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const moved = dragRef.current?.moved === true;
			dragRef.current = null;
			if (moved) onCommitRef.current?.();
			gl.domElement.style.cursor = "";
		};
		dragHandlersRef.current = { onMove, onUp };
		return () => {
			// Abort an in-flight drag when pose mode closes mid-drag.
			if (dragHandlersRef.current) {
				window.removeEventListener("pointermove", dragHandlersRef.current.onMove);
				window.removeEventListener("pointerup", dragHandlersRef.current.onUp);
				window.removeEventListener("pointercancel", dragHandlersRef.current.onUp);
				dragHandlersRef.current = null;
			}
			dragRef.current = null;
			gl.domElement.style.cursor = "";
		};
	}, [enabled, camera, gl, raycaster, tmp]);

	useFrame(() => {
		if (!enabled) return;
		for (let i = 0; i < POSE_BONES.length; i++) {
			const mesh = meshRefs.current[i];
			if (!mesh) continue;
			const instances = jointsRef.current.get(POSE_BONES[i].id);
			if (instances?.length) mesh.position.copy(instances[0].getWorldPosition(tmp.origin));
		}
	});

	if (!enabled || !root) return null;

	const startDrag = (entry) => (ev) => {
		ev.stopPropagation();
		// Stop the fly-camera controls' element-level pointerdown from also
		// firing: R3F's canvas listener was registered before theirs, so
		// stopImmediatePropagation here keeps the camera still while posing.
		if (ev.nativeEvent.stopImmediatePropagation) ev.nativeEvent.stopImmediatePropagation();
		const instances = jointsRef.current.get(entry.id);
		if (!instances?.length || !dragHandlersRef.current) return;
		const bone = instances[0];
		bone.getWorldPosition(tmp.origin);
		let child = null;
		for (const c of bone.children) {
			if (c.isBone && normalizeBoneName(c.name) !== normalizeBoneName(bone.name)) {
				child = c;
				break;
			}
		}
		if (child) child.getWorldPosition(tmp.limb).sub(tmp.origin);
		else tmp.limb.set(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(tmp.quat)); // Mixamo limbs run along +Y
		if (tmp.limb.lengthSq() < 1e-8) return;
		tmp.limb.normalize();
		const writable = [];
		for (const inst of instances) {
			let nested = false;
			for (let p = inst.parent; p; p = p.parent) {
				if (writable.includes(p)) {
					nested = true;
					break;
				}
			}
			if (!nested) writable.push(inst);
		}
		camera.getWorldDirection(tmp.dir);
		dragRef.current = {
			writable,
			origin: tmp.origin.clone(),
			limbDir: tmp.limb.clone(),
			plane: new THREE.Plane().setFromNormalAndCoplanarPoint(tmp.dir.clone(), tmp.origin.clone()),
		};
		gl.domElement.style.cursor = "grabbing";
		window.addEventListener("pointermove", dragHandlersRef.current.onMove);
		window.addEventListener("pointerup", dragHandlersRef.current.onUp);
		window.addEventListener("pointercancel", dragHandlersRef.current.onUp);
	};

	return (
		<group key={resolved}>
			{POSE_BONES.map((entry, i) =>
				jointsRef.current.has(entry.id) ? (
					<mesh
						key={entry.id}
						ref={(m) => {
							meshRefs.current[i] = m;
						}}
						renderOrder={999}
						onPointerDown={startDrag(entry)}
						onPointerOver={() => (gl.domElement.style.cursor = "grab")}
						onPointerOut={() => {
							if (!dragRef.current) gl.domElement.style.cursor = "";
						}}
					>
						<sphereGeometry args={[HANDLE_RADIUS, 16, 16]} />
						<meshStandardMaterial
							color="#000000"
							emissive={handleColor(entry)}
							emissiveIntensity={1.5}
							toneMapped={false}
							depthTest={false}
							transparent
							opacity={0.95}
						/>
					</mesh>
				) : null
			)}
		</group>
	);
}

/** World-axis gizmo colours (Blender / Cascadeur convention), shared with the rotation rings. */
const AXIS_DEFS = ROTATION_AXES.map(({ axis, dir, color }) => ({ axis: axis.toUpperCase(), dir, color }));
const GIZMO_LEN = 0.22;
const GIZMO_SHAFT_R = 0.0065;
const GIZMO_TIP_R = 0.022;
const GIZMO_PICK_SHAFT_R = 0.045;
const GIZMO_PICK_TIP_R = 0.055;
const HANDLE_R = 0.055; // chain target spheres
const JOINT_R = 0.042; // mid-joint + FK swing spheres
const SWING_RING_R = 0.17; // rotation ring radius, clear of the hand/foot mesh
const SWING_RING_TUBE = 0.0045; // visible ring line
const SWING_RING_PICK_TUBE = 0.035; // invisible grab tube
/** Unfocused handles fade back so the focused one reads clearly. */
const OPACITY_FOCUSED = 1;
const OPACITY_UNFOCUSED = 0.5;
const OPACITY_NEAR = 0.86;
const OPACITY_FAR = 0.5;
const OPACITY_DISABLED_NEAR = 0.16;
const OPACITY_DISABLED_FAR = 0.07;
/** FK swing drag speed: TransformControls uses 20/camDist, tuned for its
 * gizmo rings; posing needs finer steps, so the same formula runs at 5 —
 * a ~60 px drag reads as ~15°, a full-screen sweep as ~165°. */
const FK_ROTATE_SPEED = 5;

/**
 * Draggable IK/FK handles, DCC-style (Unity grab-handle + Cascadeur
 * manipulators). Three handle kinds:
 *
 * - chain targets (wrists/ankles): the handle is the TARGET, decoupled from
 *   the effector — it follows the pointer freely and the limb only reaches
 *   for it. Focused ones get the mini move-gizmo (X/Y/Z axis arrows + the
 *   centre sphere free-drag).
 * - mid joints (elbows/knees): drag repositions the mid joint with both
 *   ends pinned; the handle snaps to the clamped elbow/knee position. Also
 *   position handles, so they get the gizmo when focused.
 * - FK swing joints (shoulders, spine, chest, neck, head, hips): drag
 *   swings the part toward the pointer — rotation only, no gizmo.
 *
 * Unfocused handles render at low opacity so the focused one stands out.
 * Every drag move calls `onSolve(kind, trackId, targetWorld)`; the drag end
 * calls `onDragEnd(trackId)` so the caller can key it.
 */
export function IkHandles({ chains, fkJoints, ikState, enabled, focus, onFocus, onSolve, onDragEnd, selectionOnly = false, onPartPick, focusToolsHidden = false, exposureProbeRef }) {
	const { camera, gl, raycaster, scene } = useThree();
	const handleRefs = useRef({}); // id -> mesh (all sphere handles)
	const handleMetaRef = useRef(new Map()); // id -> { track, radius }
	const visibilityRef = useRef(new Map()); // id -> exposed in the active camera
	const visibilityDetailRef = useRef(new Map());
	const exposureDepthRef = useRef(new Map()); // id -> active-camera depth
	const exposureInputRef = useRef({ values: [], count: 0, valid: false });
	const poseInputRef = useRef({ values: [], count: 0, valid: false });
	const exposurePerfRef = useRef({ passes: 0, skippedFrames: 0, raycasts: 0, lastPassMs: 0 });
	const exposureLastPassAt = useRef(0);
	const cameraGestureRef = useRef(false);
	const blockerRefs = useRef([]);
	const skinnedBlockerProxiesRef = useRef(new Map());
	const occlusionRay = useRef(new THREE.Raycaster()).current;
	// The last pass's blockers, so the fingertip handles can ask the same exposure question (#913).
	const occludersRef = useRef(null);
	useEffect(() => { if (exposureProbeRef) exposureProbeRef.current = exposureProbe(camera, occludersRef); }, [exposureProbeRef, camera]);
	const gizmoRef = useRef(null);
	const ringRef = useRef(null); // rotation rings around the focused joint
	const readoutRef = useRef(null);
	const [hoverAxis, setHoverAxis] = useState(null);
	const [rotationDrag, setRotationDrag] = useState(null); // { axis, angle } while a ring drags
	const [rotationDeg, setRotationDeg] = useState(null);
	const dragRef = useRef(null);
	const handlersRef = useRef(null);
	const solveRef = useRef(onSolve);
	const endRef = useRef(onDragEnd);
	const focusRef = useRef(onFocus);
	const partPickRef = useRef(onPartPick);
	partPickRef.current = onPartPick;
	// The pointerdown handler filters picks through the CURRENT focus: while
	// a joint is focused, only that joint (sphere + its gizmo arrows) is
	// interactive — unfocused handles are inert, so they can never shadow a
	// gizmo arrow (the "the yellow circles block the gizmo" failure).
	const focusIdRef = useRef(focus);
	solveRef.current = onSolve;
	endRef.current = onDragEnd;
	focusRef.current = onFocus;
	focusIdRef.current = focus;
	const tmp = useRef({
		ndc: new THREE.Vector2(),
		hit: new THREE.Vector3(),
		delta: new THREE.Vector3(),
		target: new THREE.Vector3(),
		pos: new THREE.Vector3(),
		cameraPos: new THREE.Vector3(),
		rayDirection: new THREE.Vector3(),
		viewPoint: new THREE.Vector3(),
		skinnedVertex: new THREE.Vector3(),
	}).current;

	useEffect(() => {
		exposureInputRef.current.valid = false;
		poseInputRef.current.valid = false;
		if (!enabled) {
			exposureDepthRef.current.clear();
			visibilityRef.current.clear();
			visibilityDetailRef.current.clear();
		}
	}, [chains, enabled, fkJoints, scene]);

	useEffect(() => () => {
		skinnedBlockerProxiesRef.current.clear();
	}, []);

	useEffect(() => {
		if (!enabled) return undefined;
		const onMove = (ev) => {
			const d = dragRef.current;
			if (!d) return;
			if (d.kind === "empty") {
				// past the click threshold it's a camera drag, not a focus click
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				return;
			}
			const rect = gl.domElement.getBoundingClientRect();
			tmp.ndc.set(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(tmp.ndc, camera);
			if (!raycaster.ray.intersectPlane(d.plane, tmp.hit)) return;
			if ((d.kind === "fk" || d.kind === "swing") && d.axisDir) {
				const angle = ringAngle(d.axisDir, d.targetStart, d.hitStart, tmp.hit);
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				solveRef.current?.(d.kind, d.trackId, { axis: d.axisDir, angle, startQuat: d.startQuat, startParentQuat: d.startParentQuat });
				setRotationDrag({ axis: d.axisName, angle });
				return;
			}
			if (d.kind === "fk" || d.kind === "swing" || (d.kind === "body" && !d.axisDir)) {
				// Swing = trackball rotation (TransformControls rotate model):
				// axis = offset × eye, angle = (offset · tangent) × speed/camDist,
				// applied absolutely from the drag-start orientation (no compounding).
				// The body centre sphere swings the body; its arrows translate.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const axis = tmp.delta.clone().cross(d.eye);
				if (axis.lengthSq() < 1e-12) return;
				axis.normalize();
				const tangent = axis.clone().cross(d.eye).normalize();
				const angle = tmp.delta.dot(tangent) * (FK_ROTATE_SPEED / d.camDist);
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				solveRef.current?.(d.kind, d.trackId, { axis, angle, startQuat: d.startQuat, startParentQuat: d.startParentQuat });
				return;
			}
			if (d.kind === "body" && d.axisDir) {
				// Body translate: absolute from the drag-start local position,
				// so repeated moves never compound — the hips' local start plus
				// the world delta along the dragged axis.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const along = tmp.delta.dot(d.axisDir);
				if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
				solveRef.current?.(d.kind, d.trackId, { worldDelta: d.axisDir.clone().multiplyScalar(along), startLocalPos: d.startLocalPos });
				return;
			}
			if (d.axisDir) {
				// Axis drag: keep only the axis component of the pointer travel.
				tmp.delta.subVectors(tmp.hit, d.hitStart);
				const along = tmp.delta.dot(d.axisDir);
				tmp.target.copy(d.targetStart).addScaledVector(d.axisDir, along);
			} else {
				// Free drag: camera-facing plane, pointer-exact via the grab offset.
				tmp.target.copy(tmp.hit).add(d.offset);
			}
			if (Math.hypot(ev.clientX - d.downXY[0], ev.clientY - d.downXY[1]) > CLICK_PX) d.moved = true;
			solveRef.current?.(d.kind, d.trackId, tmp.target, { bypass: ev.altKey });
		};
		const onUp = () => {
			// Detach this drag's listeners but KEEP the handler pair — nulling
			// it here would brick every subsequent drag (beginDrag refuses to
			// start without it), which is exactly the "second drag does
			// nothing" failure. removeEventListener is idempotent.
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const d = dragRef.current;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
			setRotationDrag(null);
			if (!d) return;
			// Click (never dragged): the focused sphere toggles focus OFF; a
			// not-yet-focused sphere just took focus (nothing to bake). An
			// empty-canvas click releases focus too.
			if (!d.moved) {
				// (An empty press is always wasFocused: it only begins while focused.)
				// A gizmo volume can win the raycast over the sphere centre, so a
				// no-move press on the centre (d.centerClick) toggles off too.
				if (d.wasFocused && (!d.axisDir || d.centerClick)) focusRef.current?.(null); // toggle off
				// axis-arrow clicks and fresh-sphere clicks: nothing to bake
				return;
			}
			endRef.current?.(d.trackId);
		};
		handlersRef.current = { onMove, onUp };
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			handlersRef.current = null;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
		};
	}, [enabled, camera, gl, raycaster, tmp]);

	// QA hook: live handle world positions for headless checks (harmless).
	if (typeof window !== "undefined") {
		window.__ikHandlePos = (id) => {
			const m = handleRefs.current[id];
			return m ? m.getWorldPosition(new THREE.Vector3()) : null;
		};
		// world → screen for a handle (or the focused ring's edge), so headless
		// drags can land on the mesh pixel-exactly.
		window.__ikProject = (world) => {
			const v = world.clone ? world.clone() : new THREE.Vector3(world.x, world.y, world.z);
			v.project(camera);
			const rect = gl.domElement.getBoundingClientRect();
			return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
		};
		// effector local quaternion per chain track — rotation-edit assertions.
		window.__ikEffectorQuat = (id) => {
			const bone = chains?.get(id)?.bones[2];
			return bone ? { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w } : null;
		};
		// is the swing ring mounted for this track (focused chain)?
		window.__ikRingVisible = () => !!ringRef.current;
		window.__ikVisibleControls = () =>
			[...visibilityRef.current.entries()]
				.filter(([, exposed]) => exposed)
				.map(([id]) => id)
				.sort();
		window.__ikVisibilityDetails = () =>
			Object.fromEntries(visibilityDetailRef.current);
		window.__ikVisibilityPerformance = () => ({ ...exposurePerfRef.current });
		window.__ikControlScreenPositions = () => {
			const rect = gl.domElement.getBoundingClientRect();
			return Object.fromEntries(
				Object.entries(handleRefs.current)
					.filter(([, mesh]) => mesh?.parent)
					.map(([id, mesh]) => {
						const point = mesh.getWorldPosition(new THREE.Vector3()).project(camera);
						return [id, {
							x: rect.left + ((point.x + 1) / 2) * rect.width,
							y: rect.top + ((1 - point.y) / 2) * rect.height,
							exposed: mesh.visible && mesh.userData.ikExposed === true,
						}];
					})
			);
		};
	}

	// Handles + gizmo follow the live state every frame. A chain handle RIDES
	// its effector (the actual wrist/ankle) at all times — pose changes,
	// character moves and scrubs can never strand it in stale world space
	// (the "IK handle escapes" bug) — EXCEPT while that chain is being
	// dragged, when it tracks the pointer target for 1:1 feedback past reach.
	// On release it returns to the effector, i.e. exactly where the hand is.
	useFrame(() => {
		if (!enabled || !ikState) return;
		const draggingChain = dragRef.current?.kind === "chain" ? dragRef.current.trackId : null;
		for (const track of IK_TRACKS) {
			const mesh = handleRefs.current[track.id];
			const chain = chains?.get(track.id);
			if (!mesh || !chain) continue;
			if (draggingChain === track.id) {
				const t = ikState.targets.get(track.id);
				if (t) mesh.position.copy(t);
			} else {
				mesh.position.copy(chain.bones[2].getWorldPosition(tmp.pos));
			}
		}
		for (const track of MID_TRACKS) {
			const mesh = handleRefs.current[track.id];
			const chain = chains?.get(track.chain);
			if (mesh && chain) mesh.position.copy(chain.bones[1].getWorldPosition(tmp.pos));
		}
		for (const [id, joint] of fkJoints ?? []) {
			const mesh = handleRefs.current[id];
			if (mesh && joint) mesh.position.copy(joint.bone.getWorldPosition(tmp.pos));
		}

		// One exposure result owns both rendering and picking. Measure how far
		// each control centre sits behind the first opaque scene surface; each
		// track's visibilityDepth describes its legitimate under-skin depth.
		// Centreline torso/head controls get enough allowance to stay usable,
		// while a far-side shoulder or limb remains hidden behind the body.
		const blockers = blockerRefs.current;
		const input = exposureInputRef.current;
		const poseInput = poseInputRef.current;
		const cameraGesture = typeof window !== "undefined" && window.__cozyclayCameraGesture === true;
		const cameraGestureEnded = cameraGestureRef.current && !cameraGesture;
		cameraGestureRef.current = cameraGesture;
		if (cameraGesture) {
			// Camera-only movement cannot change the rig silhouette. Keep the last
			// exposure result and defer the expensive scene/proxy scan until release.
			exposurePerfRef.current.skippedFrames += 1;
		} else {
			camera.updateMatrixWorld();
			camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
			camera.getWorldPosition(tmp.cameraPos);
			blockers.length = 0;
			// A release must refresh visibility once even if the gesture was shorter
			// than the normal 100 ms exposure throttle window.
			if (cameraGestureEnded) input.valid = false;
			let inputIndex = 0;
			let poseInputIndex = 0;
			let exposureDirty = !input.valid;
			let poseDirty = !poseInput.valid;
			const captureInput = (value) => {
				if (Math.abs((input.values[inputIndex] ?? Infinity) - value) > 1e-6) exposureDirty = true;
				input.values[inputIndex] = value;
				inputIndex += 1;
			};
			const capturePoseInput = (value) => {
				captureInput(value);
				if (Math.abs((poseInput.values[poseInputIndex] ?? Infinity) - value) > 1e-6) poseDirty = true;
				poseInput.values[poseInputIndex] = value;
				poseInputIndex += 1;
			};
			for (const value of camera.matrixWorld.elements) captureInput(value);
			for (const mesh of Object.values(handleRefs.current)) {
				if (!mesh?.parent) continue;
				capturePoseInput(mesh.position.x);
				capturePoseInput(mesh.position.y);
				capturePoseInput(mesh.position.z);
			}
			scene.traverse((object) => {
				// Lines are editor overlays, not opaque geometry. Treating drei's
				// Line2/LineSegments2 as blockers invokes its screen-space raycast
				// without a camera and throws on every exposure pass.
				if (!object.isMesh || object.isLine || object.isLine2 || object.isLineSegments2 || !object.visible || object.layers.isEnabled(POSER_LAYER)) return;
				const materials = Array.isArray(object.material) ? object.material : null;
				let opaque = false;
				if (materials) {
					for (const material of materials) {
						if (material && material.visible !== false && material.opacity > 0.01 && material.depthWrite !== false) {
							opaque = true;
							break;
						}
					}
				} else {
					const material = object.material;
					opaque = !!material && material.visible !== false && material.opacity > 0.01 && material.depthWrite !== false;
				}
				if (!opaque) return;
				blockers.push(object);
				captureInput(object.id);
				for (const value of object.matrixWorld.elements) {
					if (object.isSkinnedMesh) capturePoseInput(value);
					else captureInput(value);
				}
				for (const value of object.morphTargetInfluences ?? []) capturePoseInput(value);
				if (object.isSkinnedMesh) {
					// Handle centres do not reveal an in-place joint rotation
					// (notably a head turn), so every skinning bone participates
					// in the proxy-bake signature.
					for (const bone of object.skeleton?.bones ?? []) {
						for (const value of bone.matrixWorld.elements) capturePoseInput(value);
					}
				}
			});
			if (input.count !== inputIndex) exposureDirty = true;
			input.count = inputIndex;
			input.values.length = inputIndex;
			if (poseInput.count !== poseInputIndex) poseDirty = true;
			poseInput.count = poseInputIndex;
			poseInput.values.length = poseInputIndex;

		// Camera navigation changes the input signature every frame, but the
		// character silhouette and all handle positions are unchanged. Running
		// the full skinned-proxy exposure pass for every orbit sample walks
		// thousands of proxy points per handle and makes right-drag hitch.
		// Keep the last visibility result for a short interval during a gesture;
		// this still follows a slow orbit without making every pointer sample
		// pay the full proxy cost.
		const refreshExposure = shouldRefreshIkExposure({
			cameraGesture,
			cameraGestureEnded,
			exposureDirty,
			poseDirty,
			elapsedMs: performance.now() - exposureLastPassAt.current,
		});
		// No work is scheduled when `if (exposureDirty)` is false; camera-only
		// changes use the pure decision above to keep this expensive pass cached.
		if (!refreshExposure && exposureDirty) {
			exposurePerfRef.current.skippedFrames += 1;
		} else if (refreshExposure) {
			const passStartedAt = performance.now();
			input.valid = true;
			poseInput.valid = true;
			exposureDepthRef.current.clear();
			occlusionRay.layers.set(0);
			const staticBlockers = blockers.filter((object) => !object.isSkinnedMesh);
			const currentSkinnedBlockers = new Set(blockers.filter((object) => object.isSkinnedMesh));
			for (const object of skinnedBlockerProxiesRef.current.keys()) {
				if (!currentSkinnedBlockers.has(object)) skinnedBlockerProxiesRef.current.delete(object);
			}
			const skinnedProxies = [];
			for (const object of blockers) {
				if (!object.isSkinnedMesh) continue;
				let proxy = skinnedBlockerProxiesRef.current.get(object);
				if (!proxy) {
					proxy = { points: [], radius: 0.04 };
					skinnedBlockerProxiesRef.current.set(object, proxy);
					poseDirty = true;
				}
				if (poseDirty) {
					const cells = new Set();
					let pointCount = 0;
					const positions = object.geometry.getAttribute("position");
					// The production FBX is non-indexed and repeats vertices
					// per triangle (about 166k across its two skin meshes).
					// Six thousand evenly distributed samples per mesh are
					// ample for a 4 cm surface cloud and keep a pose update
					// inside a frame instead of re-skinning every duplicate.
					const stride = Math.max(1, Math.floor(positions.count / 6000));
					for (let index = 0; index < positions.count; index += stride) {
						object.getVertexPosition(index, tmp.skinnedVertex);
						tmp.skinnedVertex.applyMatrix4(object.matrixWorld);
						const ix = Math.round(tmp.skinnedVertex.x / 0.04);
						const iy = Math.round(tmp.skinnedVertex.y / 0.04);
						const iz = Math.round(tmp.skinnedVertex.z / 0.04);
						const key = (ix + 4096) * 16777216 + (iy + 4096) * 4096 + iz + 4096;
						if (cells.has(key)) continue;
						cells.add(key);
						const point = proxy.points[pointCount] ?? new THREE.Vector3();
						point.copy(tmp.skinnedVertex);
						proxy.points[pointCount] = point;
						pointCount += 1;
					}
					proxy.points.length = pointCount;
				}
				skinnedProxies.push(proxy);
			}
			for (const [id, mesh] of Object.entries(handleRefs.current)) {
				if (!mesh?.parent) continue;
				const meta = handleMetaRef.current.get(id);
				mesh.getWorldPosition(tmp.viewPoint);
				const targetDistance = tmp.cameraPos.distanceTo(tmp.viewPoint);
				tmp.rayDirection.copy(tmp.viewPoint).sub(tmp.cameraPos).normalize();
				// A coarse cloud of baked skin-surface spheres preserves the animated
				// silhouette; camera-only changes test a few cached points, pose changes rebuild the cloud once.
				const blockerDistance = blockerDistanceTo(occlusionRay, tmp.cameraPos, tmp.rayDirection, targetDistance, staticBlockers, skinnedProxies);
				const visibilityDepth = meta?.track.visibilityDepth ?? (meta?.radius ?? JOINT_R) * 2;
				const isExposed = ikControlIsExposed(targetDistance, blockerDistance, visibilityDepth);
				visibilityDetailRef.current.set(id, {
					exposed: isExposed,
					targetDistance,
					blockerDistance: blockerDistance ?? null,
					visibilityDepth,
				});
				visibilityRef.current.set(id, isExposed);
				mesh.userData.ikExposed = isExposed;
				// Occlusion is a visual hint, not an interaction lock. A joint
				// hidden behind the character is still a valid IK target (and
				// becomes reachable as soon as the camera moves), so keep every
				// registered handle renderable and pickable.
				mesh.visible = true;
				tmp.viewPoint.applyMatrix4(camera.matrixWorldInverse);
				exposureDepthRef.current.set(id, -tmp.viewPoint.z);
			}
			occludersRef.current = { blockers: [...blockers] };
			exposurePerfRef.current.passes += 1;
			exposurePerfRef.current.raycasts += Object.keys(handleRefs.current).length;
			exposurePerfRef.current.lastPassMs = performance.now() - passStartedAt;
			exposureLastPassAt.current = performance.now();
			} else {
				exposurePerfRef.current.skippedFrames += 1;
			}
		}

		let near = Infinity;
		let far = -Infinity;
		for (const depth of exposureDepthRef.current.values()) {
			near = Math.min(near, depth);
			far = Math.max(far, depth);
		}
		const span = Math.max(0.001, far - near);
		const activeFocus = focusIdRef.current;
		for (const [id, depth] of exposureDepthRef.current) {
			const mesh = handleRefs.current[id];
			if (!mesh) continue;
			const focused = activeFocus === id;
			const clickable = activeFocus === null || activeFocus === undefined || focused;
			const closeness = 1 - THREE.MathUtils.clamp((depth - near) / span, 0, 1);
			const emphasis = THREE.MathUtils.smoothstep(closeness, 0, 1);
			mesh.material.opacity = focused
				? OPACITY_FOCUSED
				: clickable
					? THREE.MathUtils.lerp(OPACITY_FAR, OPACITY_NEAR, emphasis)
					: THREE.MathUtils.lerp(OPACITY_DISABLED_FAR, OPACITY_DISABLED_NEAR, emphasis);
			const [core, halo] = mesh.children;
			if (core) core.material.opacity = mesh.material.opacity;
			if (halo) {
				halo.quaternion.copy(camera.quaternion);
				halo.material.opacity = mesh.material.opacity * (focused ? 0.6 : 0.4);
			}
		}
		// A focused control keeps its gizmo and rings even when the body hides it:
		// the user picked it, and while focused nothing else can take a press.
		// Finger editing hands the focused hand's space to the fingertip handles: no gizmo, rings or readout.
		const focusExposed = !!focus && !focusToolsHidden;
		if (gizmoRef.current) gizmoRef.current.visible = focusExposed;
		if (ringRef.current) ringRef.current.visible = focusExposed;

		if (gizmoRef.current && focus) {
			const mid = MID_TRACKS.find((t) => t.id === focus);
			const chainTrack = IK_TRACKS.find((t) => t.id === focus);
			if (chainTrack) {
				const chain = chains?.get(focus);
				if (draggingChain === focus) {
					const t = ikState.targets.get(focus);
					if (t) gizmoRef.current.position.copy(t);
				} else if (chain) {
					gizmoRef.current.position.copy(chain.bones[2].getWorldPosition(tmp.pos));
				}
			} else if (mid) {
				const chain = chains?.get(mid.chain);
				if (chain) gizmoRef.current.position.copy(chain.bones[1].getWorldPosition(tmp.pos));
			} else if (focus === "hips") {
				// the body gizmo rides the hips bone (also while it translates)
				const joint = fkJoints?.get("hips");
				if (joint) gizmoRef.current.position.copy(joint.bone.getWorldPosition(tmp.pos));
			}
		}
		// The swing ring rides the focused chain's effector and always faces
		// the camera: a trackball ring, not a bone-aligned one — the drag math
		// is trackball, so the affordance must match.
		if (ringRef.current && focus) {
			const bone = chains?.get(focus)?.bones[2] ?? fkJoints?.get(focus)?.bone ?? null;
			if (bone) {
				bone.getWorldPosition(tmp.pos);
				ringRef.current.position.copy(tmp.pos);
				const deg = rotationFromBindDeg(bindQuaternionOf(bone), bone.quaternion);
				if (!rotationDeg || deg.x !== rotationDeg.x || deg.y !== rotationDeg.y || deg.z !== rotationDeg.z) setRotationDeg(deg);
				if (readoutRef.current) {
					readoutRef.current.position.copy(tmp.pos).add(tmp.delta.set(SWING_RING_R * 0.8, SWING_RING_R * 0.8, 0).applyQuaternion(camera.quaternion));
					readoutRef.current.visible = focusExposed;
				}
			}
		}
	});

	/* Hit-testing is OWNED, not delegated to R3F: R3F computes the pointer
	 * NDC from its own measured canvas size, which drifts a few percent from
	 * the live rect (window resizes, layout shifts) — big handle spheres
	 * still catch the skewed ray, but small gizmo cones miss it entirely,
	 * which is exactly the "the handle doesn't grab" failure. A manual
	 * pointerdown + raycast against the registered handle/gizmo meshes uses
	 * the CURRENT canvas rect, so every hit is pixel-exact. */
	const pickRefs = useRef([]); // [{ mesh, track, axisDir, kind }]
	if (typeof window !== "undefined") {
		window.__ikPickScreenPositions = () => {
			const rect = gl.domElement.getBoundingClientRect();
			return pickRefs.current
				.filter((pick) => pick.mesh?.parent)
				.map((pick) => {
					pick.mesh.updateWorldMatrix(true, false);
					const point = pick.part === "ring"
						? new THREE.Vector3(SWING_RING_R * Math.SQRT1_2, SWING_RING_R * Math.SQRT1_2, 0).applyMatrix4(pick.mesh.matrixWorld)
						: pick.mesh.getWorldPosition(new THREE.Vector3());
					point.project(camera);
					const axis = pick.axisDir
						? Math.abs(pick.axisDir.x) > 0.5 ? "x" : Math.abs(pick.axisDir.y) > 0.5 ? "y" : "z"
						: null;
					return {
						trackId: pick.track.id,
						kind: pick.kind,
						part: pick.part,
						axis,
						x: rect.left + ((point.x + 1) / 2) * rect.width,
						y: rect.top + ((1 - point.y) / 2) * rect.height,
					};
				});
		};
	}

/** Click/drag threshold (screen px): a press that never moves past this is
 * a click (focus toggle), not a drag (no key baked). */
const CLICK_PX = 4;

	const beginDrag = (kind, track, axisDir, ndc, downXY) => {
		if (!handlersRef.current) return;
		if (kind === "empty") {
			// An empty-canvas press: no drag, just a click candidate that
			// releases focus on pointerup (see onUp).
			dragRef.current = { kind: "empty", trackId: "empty", downXY, moved: false, wasFocused: true };
			window.addEventListener("pointermove", handlersRef.current.onMove);
			window.addEventListener("pointerup", handlersRef.current.onUp);
			window.addEventListener("pointercancel", handlersRef.current.onUp);
			return;
		}
		let origin;
		if (kind === "chain" || kind === "swing") {
			// Every drag starts from the CURRENT effector — the handle rides the
			// wrist between drags, so that is where the user grabs it.
			origin = chains.get(track.id).bones[2].getWorldPosition(new THREE.Vector3());
		} else if (kind === "mid") {
			origin = chains.get(track.chain).bones[1].getWorldPosition(new THREE.Vector3());
		} else {
			origin = fkJoints.get(track.id).bone.getWorldPosition(new THREE.Vector3());
		}
		raycaster.setFromCamera(ndc, camera);
		let plane;
		const rect = gl.domElement.getBoundingClientRect(), c = origin.clone().project(camera);
		const ringDrag = !!axisDir && (kind === "fk" || kind === "swing");
		if (ringDrag) {
			// A ring turns about its axis: the pointer is read on the ring's own plane.
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisDir, origin);
		} else if (axisDir) {
			// TransformControls: plane normal = axis × (eye × axis) — the plane
			// contains the axis and is as view-perpendicular as possible.
			const eye = camera.getWorldDirection(new THREE.Vector3());
			const normal = axisDir.clone().cross(eye).cross(axisDir).normalize();
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
		} else {
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
				camera.getWorldDirection(new THREE.Vector3()),
				origin
			);
		}
		const hit = new THREE.Vector3();
		raycaster.ray.intersectPlane(plane, hit);
		dragRef.current = {
			kind,
			trackId: track.id,
			plane,
			axisDir: axisDir || null,
			targetStart: origin,
			hitStart: hit.clone(),
			offset: axisDir ? new THREE.Vector3() : origin.clone().sub(hit),
			downXY,
			moved: false,
			// Whether THIS handle was already focused when the press began —
			// a no-move click toggles focus OFF only then; a click on a fresh
			// (unfocused) handle must keep the focus it just took.
			wasFocused: focusIdRef.current === track.id,
			// Press landed within CLICK_PX of the sphere's projected centre.
			centerClick: Math.hypot(downXY[0] - (rect.left + (c.x + 1) / 2 * rect.width), downXY[1] - (rect.top + (1 - c.y) / 2 * rect.height)) <= CLICK_PX,
		};
		if (kind === "fk" || kind === "swing" || kind === "body") {
			// Swing/translate start state, frozen at drag start so moves stay
			// absolute: the bone's orientation, its parent's world rotation,
			// the bone→camera eye, the camera distance, and (for the body) the
			// hips' local position. "swing" rotates a chain's end bone (the
			// hand/foot); "fk"/"body" rotate an FK joint's bone.
			const bone = kind === "swing" ? chains.get(track.id)?.bones[2] : fkJoints?.get(track.id)?.bone;
			if (!bone) {
				// A pick whose bone is gone (stale rig) must not half-start a drag.
				dragRef.current = null;
				return;
			}
			if (ringDrag) dragRef.current.axisName = ROTATION_AXES.find((a) => a.dir === axisDir)?.axis ?? "x";
			dragRef.current.startQuat = bone.quaternion.clone();
			dragRef.current.startParentQuat = bone.parent.getWorldQuaternion(new THREE.Quaternion());
			dragRef.current.eye = origin.clone().sub(camera.getWorldPosition(new THREE.Vector3())).negate().normalize();
			dragRef.current.camDist = camera.getWorldPosition(new THREE.Vector3()).distanceTo(origin);
			if (kind === "body") dragRef.current.startLocalPos = fkJoints.get(track.id).bone.position.clone();
		}
		focusRef.current?.(track.id);
		if (selectionOnly) {
			partPickRef.current?.(track.id);
			dragRef.current = null;
			gl.domElement.style.cursor = "";
			return;
		}
		gl.domElement.style.cursor = "grabbing";
		window.addEventListener("pointermove", handlersRef.current.onMove);
		window.addEventListener("pointerup", handlersRef.current.onUp);
		window.addEventListener("pointercancel", handlersRef.current.onUp);
	};

	// Capture-phase pointerdown on the canvas: nearest registered handle /
	// gizmo mesh under the pointer starts a drag. While a joint is FOCUSED,
	// the pick list narrows to that joint only (sphere + its gizmo arrows),
	// so unfocused handles are inert and can never shadow a gizmo arrow;
	// with nothing focused every sphere is a focus+drag target. A press that
	// hits nothing records an empty click (releases focus on pointerup).
	useEffect(() => {
		if (!enabled) return undefined;
		const el = gl.domElement;
		const onDown = (ev) => {
			if (ev.button !== 0) return;
			const downXY = [ev.clientX, ev.clientY];
			const focused = focusIdRef.current;
			// A hidden unfocused control keeps only its sphere: its gizmo and rings are not drawn.
			let picks = pickRefs.current.filter((p) =>
				p.mesh?.visible &&
				handleRefs.current[p.track.id]?.visible &&
				(handleRefs.current[p.track.id]?.userData.ikExposed !== false || !p.part || p.track.id === focused)
			);
			if (focused && !selectionOnly) picks = picks.filter((p) => p.track.id === focused && !(focusToolsHidden && (p.axisDir || p.part)));
			else picks = picks.filter((p) => !p.axisDir); // spheres only
			if (!picks.length) {
				if (focused) beginDrag("empty", { id: "empty" }, null, null, downXY);
				return;
			}
			const rect = el.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(ndc, camera);
			const pick = pickIkHit(raycaster.intersectObjects(picks.map((p) => p.mesh), false), picks, handleRefs.current);
			if (!pick) {
				if (focused) beginDrag("empty", { id: "empty" }, null, null, downXY);
				return;
			}
			if (typeof window !== "undefined") {
				window.__ikLastPick = { trackId: pick.track.id, kind: pick.kind, part: pick.part };
			}
			ev.stopImmediatePropagation();
			ev.stopPropagation();
			ev.preventDefault();
			beginDrag(pick.kind, pick.track, pick.axisDir, ndc, downXY);
		};
		// The handles live on POSER_LAYER so they render only in the poser
		// (IK working) view; the raycaster must see that layer to hit them.
		const onHover = (ev) => {
			if (ev.buttons || dragRef.current) return;
			const rings = pickRefs.current.filter((p) => p.part === "ring" && p.mesh?.parent && p.track.id === focusIdRef.current);
			let axis = null;
			if (rings.length) {
				const rect = el.getBoundingClientRect();
				raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), camera);
				const hit = raycaster.intersectObjects(rings.map((p) => p.mesh), false)[0];
				axis = hit ? ROTATION_AXES.find((a) => a.dir === rings.find((p) => p.mesh === hit.object)?.axisDir)?.axis ?? null : null;
			}
			setHoverAxis((current) => (current === axis ? current : axis));
		};
		// Esc releases the focused handle (same path as the toggle-off click).
		const onKey = (ev) => {
			if (ev.key === "Escape" && focusIdRef.current && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target?.tagName)) focusRef.current?.(null);
		};
		raycaster.layers.enable(POSER_LAYER);
		el.addEventListener("pointerdown", onDown, true);
		el.addEventListener("pointermove", onHover);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			el.removeEventListener("pointerdown", onDown, true);
			el.removeEventListener("pointermove", onHover);
			raycaster.layers.disable(POSER_LAYER);
		};
	});

	if (!enabled || !chains || !ikState) return null;

	const register = (track, kind, axisDir = null, part = null) => (m) => {
		const idx = pickRefs.current.findIndex((p) => p.track === track && p.kind === kind && p.axisDir === axisDir && p.part === part);
		if (idx >= 0) pickRefs.current[idx].mesh = m;
		else pickRefs.current.push({ mesh: m, track, axisDir, kind, part });
	};

	const sphereFor = (track, kind, color, radius) => {
		const focused = focus === track.id;
		return (
			<mesh
				key={track.id}
				ref={(m) => {
					handleRefs.current[track.id] = m;
					if (m) {
						m.layers.set(POSER_LAYER);
						handleMetaRef.current.set(track.id, { track, radius });
					} else {
						handleMetaRef.current.delete(track.id);
						visibilityRef.current.delete(track.id);
					}
					register(track, kind)(m);
				}}
				renderOrder={999}
			>
				<sphereGeometry args={[radius, 12, 8]} />
				<meshBasicMaterial colorWrite={false} depthTest={false} depthWrite={false} transparent opacity={focused ? OPACITY_FOCUSED : OPACITY_UNFOCUSED} />
				<mesh renderOrder={999} ref={(m) => m?.layers.set(POSER_LAYER)} raycast={() => {}}>
					<sphereGeometry args={[radius * (focused ? 0.62 : 0.52), 20, 14]} />
					<meshBasicMaterial color={color} toneMapped={false} depthTest={false} depthWrite={false} transparent />
				</mesh>
				<mesh renderOrder={998} ref={(m) => m?.layers.set(POSER_LAYER)} raycast={() => {}}>
					<ringGeometry args={[radius * (focused ? 0.86 : 0.8), radius * (focused ? 1.0 : 0.92), 48]} />
					<meshBasicMaterial color={color} toneMapped={false} depthTest={false} depthWrite={false} transparent side={THREE.DoubleSide} />
				</mesh>
			</mesh>
		);
	};

	// The gizmo appears on chain + mid (position) handles — and on the hips
	// BODY handle: its arrows translate the body (Y = height, for crouching
	// and lying poses) while its centre sphere keeps swinging the body.
	const gizmoTrack =
		IK_TRACKS.find((t) => t.id === focus) ||
		MID_TRACKS.find((t) => t.id === focus) ||
		(focus === "hips" ? (fkJoints?.get("hips")?.track ?? null) : null);
	const gizmoKind = IK_TRACKS.find((t) => t.id === focus) ? "chain" : MID_TRACKS.find((t) => t.id === focus) ? "mid" : focus === "hips" ? "body" : null;
	// The focused hand/foot gets rotation rings beside its move arrows (the rings turn the hand/foot itself); a focused
	// FK joint gets rings only. Hips get rings too: they turn the whole body, feet with it, so it can lie down.
	const rotateTrack = IK_TRACKS.find((t) => t.id === focus) ?? (focus ? fkJoints?.get(focus)?.track ?? null : null);
	const rotateKind = IK_TRACKS.find((t) => t.id === focus) ? "swing" : "fk";

	return (
		<group>
			{IK_TRACKS.map((track) => (chains.has(track.id) ? sphereFor(track, "chain", sideColor(track.id), HANDLE_R) : null))}
			{MID_TRACKS.map((track) => (chains.has(track.chain) ? sphereFor(track, "mid", sideColor(track.id), JOINT_R) : null))}
			{[...(fkJoints ?? [])].filter(([, joint]) => !joint.track.finger).map(([id, joint]) => sphereFor(joint.track, id === "hips" ? "body" : "fk", sideColor(id), id === "hips" ? HANDLE_R : JOINT_R))}

			{gizmoTrack && (
				<group ref={gizmoRef} renderOrder={999}>
					{AXIS_DEFS.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh
									position={[0, GIZMO_LEN / 2, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "shaft")(m);
									}}
								>
									<cylinderGeometry args={[GIZMO_SHAFT_R, GIZMO_SHAFT_R, GIZMO_LEN, 8]} />
									<meshBasicMaterial color={color} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.85} />
								</mesh>
								<mesh
									position={[0, GIZMO_LEN + 0.04, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "tip")(m);
									}}
								>
									<coneGeometry args={[GIZMO_TIP_R, 0.06, 16]} />
									<meshBasicMaterial color={color} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								{/* Invisible forgiving hit volumes keep the target
								    at least as easy to grab as the visible arrow. */}
								<mesh
									position={[0, GIZMO_LEN / 2 + 0.02, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "hit-shaft")(m);
									}}
								>
									<cylinderGeometry args={[GIZMO_PICK_SHAFT_R, GIZMO_PICK_SHAFT_R, GIZMO_LEN + 0.04, 8]} />
									<meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
								</mesh>
								<mesh
									position={[0, GIZMO_LEN + 0.04, 0]}
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(gizmoTrack, gizmoKind, dir, "hit-tip")(m);
									}}
								>
									<coneGeometry args={[GIZMO_PICK_TIP_R, 0.12, 12]} />
									<meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}

			{rotateTrack && (
				<group ref={(g) => { ringRef.current = g; }} renderOrder={999}>
					{ROTATION_AXES.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
						const active = rotationDrag?.axis === axis;
						const hot = active || (!rotationDrag && hoverAxis === axis);
						return (
							<group key={axis} quaternion={quat}>
								<mesh ref={(m) => m?.layers.set(POSER_LAYER)}>
									<torusGeometry args={[SWING_RING_R, hot ? SWING_RING_TUBE * 2.2 : SWING_RING_TUBE, 6, 96]} />
									<meshBasicMaterial ref={(m) => m && backFaceFade(m)} color={color} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={rotationDrag && !active ? 0.15 : hot ? 1 : 0.7} />
								</mesh>
								<mesh
									ref={(m) => {
										if (m) m.layers.set(POSER_LAYER);
										register(rotateTrack, rotateKind, dir, "ring")(m);
									}}
								>
									<torusGeometry args={[SWING_RING_R, SWING_RING_PICK_TUBE, 8, 48]} />
									<meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}
			{rotateTrack && rotationDeg && !focusToolsHidden && (
				<group ref={readoutRef}>
					<Html zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
						<RotationReadout readout={rotationReadout(rotationDeg, rotationDrag)} />
					</Html>
				</group>
			)}
		</group>
	);
}

function RotationReadout({ readout }) {
	return (
		<div className="pose-rotation-readout" data-testid="pose-rotation-readout">
			{readout.delta && (
				<div className="pose-rotation-delta" data-axis={readout.delta.axis}>
					<span>{readout.delta.axis.toUpperCase()}</span>{readout.delta.value}
				</div>
			)}
			<div className="pose-rotation-axes">
				{readout.axes.map(({ axis, value, active }) => (
					<span key={axis} data-axis={axis} className={active ? "active" : undefined}><i>{axis.toUpperCase()}</i>{value}</span>
				))}
			</div>
		</div>
	);
}

/** A poser-only target marker for the active range pin. The target is supplied
 * in world space; the line is rebuilt every render frame so object travel and
 * the effector's keyed pose stay visually connected while the playhead moves. */
export function RangePinMarker({ chains, track, target = null, enabled = false }) {
	const markerRef = useRef(null);
	const lineRef = useRef(null);
	const effector = useRef(new THREE.Vector3()).current;
	const targetVector = useRef(new THREE.Vector3()).current;
	const markerColor = track?.endsWith("Hand") ? "#ff8a3d" : "#4dd2ff";

	useFrame(() => {
		if (!enabled || !track || !target) return;
		const chain = chains?.get(track);
		if (!chain || !markerRef.current || !lineRef.current) return;
		targetVector.fromArray(target);
		markerRef.current.position.copy(targetVector);
		chain.bones[2].getWorldPosition(effector);
		lineRef.current.geometry.setPositions([...effector.toArray(), ...targetVector.toArray()]);
	});

	return (
		<group visible={enabled} renderOrder={1001}>
			<mesh ref={(mesh) => {
				markerRef.current = mesh;
				if (mesh) mesh.layers.set(POSER_LAYER);
			}}>
				<sphereGeometry args={[0.035, 12, 8]} />
				<meshBasicMaterial color={markerColor} transparent opacity={0.95} depthTest={false} depthWrite={false} />
			</mesh>
			<Line
				ref={(line) => {
					lineRef.current = line;
					if (line) line.layers.set(POSER_LAYER);
				}}
				points={[[0, 0, 0], [0, 0, 0]]}
				color={markerColor}
				lineWidth={1.2}
				transparent
				opacity={0.72}
				depthTest={false}
			/>
		</group>
	);
}

/**
 * Pose Studio overlay panel. `poses` is the merged list (built-ins + custom)
 * the caller owns; every pose has `{ id, label, bones }` and custom poses add
 * `{ thumb, custom: true }`. The tile entry animation cascades with the same
 * stagger as the reference.
 */
/** Pose tile preview: generated lazily per model+pose and cached for the
 * session (see pose-thumbs.js); user-saved poses keep their stored thumb. */
function PoseThumb({ model, pose, alt }) {
	const [url, setUrl] = useState(pose.thumb ?? null);
	useEffect(() => {
		if (pose.thumb) {
			setUrl(pose.thumb);
			return undefined;
		}
		let live = true;
		setUrl(null);
		poseThumbnail(model, pose).then((generated) => {
			if (live) setUrl(generated);
		}).catch(() => {});
		return () => { live = false; };
	}, [model, pose]);
	return url ? <img src={url} alt={alt} /> : <div className="tile-blank" />;
}

/** The tile preview on its own, for surfaces that show a rig rather than a
 * pose library — the rig picker renders each model in the character's own
 * current pose so the choice is a like-for-like comparison. */
export function PoseThumbPreview({ model, pose, alt }) {
	// The stored thumb belongs to the model it was captured on, so a rig
	// comparison must always re-render rather than reuse it.
	return <PoseThumb model={model} pose={{ ...pose, thumb: undefined }} alt={alt} />;
}

// Warm the thumbnail rigs while the studio sits idle: the first pose-studio
// open then pays no FBX parse. Both shipped models, one idle render each.
let thumbnailsWarmed = false;
export function warmPoseThumbnails() {
	if (thumbnailsWarmed) return;
	thumbnailsWarmed = true;
	warmThumbnailModels(["y-bot-tpose", "x-bot-tpose"]);
}

export function PoseStudioPanel({ subject, model, poses, selectedId, onSelect, onApply, onReset, onSave, onDelete, onClose, closing, motionActive = false, ikCorrection = false, docked = false }) {
	const poseLabelsKo = {
		"T-pose": ko("T-pose", "T 포즈"),
		Relaxed: ko("Relaxed", "편안한 자세"),
		Contrapposto: ko("Contrapposto", "콘트라포스토"),
		Walking: ko("Walking", "걷는 자세"),
		Seated: ko("Seated", "앉은 자세"),
		"Arms crossed": ko("Arms crossed", "팔짱"),
		Pointing: ko("Pointing", "가리키기"),
		"Hands on hips": ko("Hands on hips", "허리에 손"),
		"Looking back": ko("Looking back", "뒤돌아보기"),
		"Hands up": ko("Hands up", "손 올리기"),
		Wave: ko("Wave", "손 흔들기"),
		Thinking: ko("Thinking", "생각하기"),
		Crouch: ko("Crouch", "웅크리기"),
		Kneel: ko("Kneel", "무릎 꿇기"),
		Run: ko("Run", "달리기"),
		Jump: ko("Jump", "점프"),
	};
	const categoryLabelsKo = {
		all: ko("All", "전체"),
		basic: ko("Basic", "기본"),
		gesture: ko("Gesture", "제스처"),
		action: ko("Action", "동작"),
		floor: ko("Floor", "바닥"),
		custom: ko("My poses", "내 포즈"),
	};
	const displayPoseLabel = (pose) => pose.custom ? pose.label : poseLabelsKo[pose.label] ?? pose.label;
	const poseCategory = (pose) => pose.custom ? "custom" : pose.category ?? "basic";
	const [category, setCategory] = useState("all");
	const selectedIdRef = useRef(selectedId);
	useEffect(() => {
		selectedIdRef.current = selectedId;
	}, [selectedId]);
	const selectPose = (id) => {
		selectedIdRef.current = id;
		onSelect(id);
	};
	const categories = ["all", ...Array.from(new Set(poses.map(poseCategory)))];
	const visiblePoses = category === "all" ? poses : poses.filter((pose) => poseCategory(pose) === category);
	return (
		<div className={"pose-studio" + (docked ? " docked" : "") + (closing ? " closing" : "")}>
			<div className="studio-head">
				<span>{ko(`Pose Studio · Character ${subject}`, `포즈 스튜디오 · 인물 ${subject}`, `姿势工作室 · 角色 ${subject}`)}</span>
				<button type="button" className="x" onClick={onClose} aria-label={ko("Close pose studio", "포즈 스튜디오 닫기")}>
					✕
				</button>
			</div>
			{motionActive && (
				<p className="studio-hint" data-pose-motion-warning role="status">
					{ikCorrection
						? ko("Pose mode is on — applying keys the pose as a full-body correction at the current frame; the motion stays.", "포즈 모드가 켜져 있어요 — 적용하면 현재 프레임에 전신 보정 키로 들어가고, 모션은 그대로 유지됩니다.")
						: ko("A sample motion is moving the character — applying a pose clears it and returns to the blocking pose.", "현재 샘플 모션이 인물을 움직이고 있어요. 포즈를 적용하면 샘플 모션이 지워지고 블로킹 포즈로 돌아가요.")}
				</p>
			)}
			<div className="studio-actions">
				<button type="button" className="btn primary full" data-pose-apply onClick={() => onApply(selectedIdRef.current)}>
					{motionActive
						? (ikCorrection ? ko("Key pose as IK correction", "포즈를 IK 보정 키로 적용") : ko("Clear motion and apply pose", "모션 지우고 포즈 적용"))
						: ko("Apply pose", "포즈 적용")}
				</button>
				<button type="button" className="btn ghost full" onClick={onReset}>
					{ko("Reset pose", "포즈 초기화")}
				</button>
			</div>
			{categories.length > 2 && (
				<div className="studio-filters" aria-label={ko("Pose categories", "포즈 카테고리")}>
					{categories.map((item) => (
						<button
							type="button"
							key={item}
							className={"btn ghost" + (item === category ? " active" : "")}
							aria-pressed={item === category}
							onClick={() => setCategory(item)}
						>
							{categoryLabelsKo[item] ?? item}
						</button>
					))}
				</div>
			)}
			{poses.length === 0 && (
				<p className="studio-hint" data-pose-empty role="status">
					{ko(
						"Your pose library is empty. Pose the character and save it — it stays here for every project.",
						"포즈 라이브러리가 비어 있어요. 인물 자세를 잡아 저장하면, 모든 프로젝트에서 계속 쓸 수 있어요.",
					)}
				</p>
			)}
			<PoseTileGrid
				poses={visiblePoses}
				model={model}
				selectedId={selectedId}
				onSelect={selectPose}
				onDelete={onDelete}
				onSave={onSave}
				categoryOf={poseCategory}
				labelOf={displayPoseLabel}
			/>
		</div>
	);
}

/**
 * The pose tiles themselves, without the studio around them.
 *
 * The Inspector shows the same library as the studio panel, so choosing a pose
 * is the same act in both places: see the shape, click the shape. A dropdown
 * of names cannot do that — a pose read out of a photograph is recognisable
 * only by how the body looks.
 */
export function PoseTileGrid({
	poses,
	model,
	selectedId,
	onSelect,
	onDelete,
	onSave,
	categoryOf = () => "custom",
	labelOf = (pose) => pose.label,
}) {
	return (
			<div className="pose-grid">
				{poses.map((pose, index) => (
					<button
						type="button"
						key={pose.id}
						className={"pose-tile" + (pose.id === selectedId ? " active" : "")}
						data-pose-id={pose.id}
						data-pose-category={categoryOf(pose)}
						style={{ animationDelay: `${0.04 + index * 0.028}s` }}
						onClick={() => onSelect(pose.id)}
					>
						<PoseThumb model={model} pose={pose} alt={labelOf(pose)} />
						<span>{labelOf(pose)}</span>
						{pose.custom && onDelete && (
							<em
								className="del"
								title={ko("Delete", "삭제")}
								onClick={(e) => {
									e.stopPropagation();
									onDelete(pose.id);
								}}
							>
								✕
							</em>
						)}
					</button>
				))}
				{onSave && (
				<button type="button" className="pose-tile add" data-pose-id="save-custom" title={ko("Save the character's current pose", "현재 인물 포즈 저장")} onClick={onSave}>
					<span className="add-plus">＋</span>
					<span className="add-text">{ko("Save pose", "포즈 저장")}</span>
				</button>
				)}
			</div>
	);
}
