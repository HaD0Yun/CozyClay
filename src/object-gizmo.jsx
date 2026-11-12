import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GIZMO_LAYER, SHOT_ASPECT } from "./dualview.jsx";
import { fitAspect } from "./shot-frame.js";
import { HANDLE_PROXY_FLAG, claimsPress } from "./gizmo-claim.js";
import { CUTOUT_KIND, rotatePatch, scalePatch, screenRotatePatch, translatePatch, wrapAngle } from "./scene-objects.js";
import { dragTravel, dragTurn } from "./held-object-pose.js";
import { viewportTools } from "./viewport-tools.js"; import { viewportSketch } from "./viewport-sketch.js";
import { HeldTrail } from "./held-object-edit.jsx";
import { ACTIVE_COLOR, ARROW_LEN, AXES, AXIS_VECTORS, BOX_SIZE, CARD_CORNERS, CENTRE_BOX, CORNER_BOX, FAR_HALF_ALPHA, GROUND, PICK_CENTRE_R, PICK_CORNER_R, PICK_SHAFT_R, PICK_TUBE_R,
	PLANES, PLANE_OFFSET, PLANE_SIZE, RING_R, RING_TUBE, SCREEN_RING_R, SCREEN_SCALE, SHAFT_R, TIP_LEN, TIP_R, gizmoOrigin, gizmoTurn, handleKey } from "./object-gizmo-parts.js";

/**
 * The transform gizmo for the selected scene object — the thing every 3D tool
 * has and this one did not: axis arrows to slide an object along X/Y/Z, rings
 * to spin it and boxes to scale it, straight in the shot view, with the plan
 * board's 5 cm / 5° detents so both views agree.
 *
 * Three deliberate choices:
 *
 * - Picking is owned here, not delegated to R3F. The shot camera renders into
 *   a letterboxed 16:9 sub-rect of the canvas, so R3F's canvas-wide pointer
 *   NDC is vertically off by the size of the bars and small cones would never
 *   be hit. The rect the camera actually drew into is what the ray is built
 *   from.
 * - The listener sits on `window` in the CAPTURE phase. The fly-camera
 *   controls listen on the canvas element itself and were registered first;
 *   only a capture-phase listener further up the tree can stop a press on the
 *   gizmo — or on an object — from also swinging the camera.
 * - Unity's division of labour: a plain left press SELECTS and nothing else,
 *   transforms only ever come from a handle, and a press on empty space clears
 *   the selection. Dragging the body used to move it, which made selecting an
 *   object — just to read its numbers — nudge the set. The plane handles below
 *   are the honest replacement for that.
 *   (docs/unity-reference.md §3.2, §6, §9.3, §9.6)
 *
 * The axis rings drive the object's X/Y/Z Euler channels directly. With the
 * yaw-only rotations blocking actually uses that is exact; with all three
 * channels live it is the usual world-axis-to-Euler approximation, same as
 * any DCC's global-space rotate. The outer screen-space ring is different:
 * a roll about the view axis legitimately touches all three channels at
 * once, so its delta is composed onto the current orientation in quaternion
 * space and decomposed back into the same channels (screenRotatePatch).
 */


export default function ObjectGizmo({ object, objects = [], mode = "move", snap = true, enabled, pickOnly = false, paneRef, camRef, shotAspect = SHOT_ASPECT, onChange, onSelect, onGroundClick, onDragStart, onDragEnd, claimPointer, held = null }) {
	const { gl, scene } = useThree();
	// shotAspect null = the camera fills the pane (the editor working view):
	// pointer mapping uses the pane rect itself instead of a letterboxed
	// sub-rect, and the camera takes the pane's own aspect.
	const imageRect = (bounds) => {
		const rect = { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
		return shotAspect ? fitAspect(rect, shotAspect) : rect;
	};
	const applyAspect = (camera) => {
		if (shotAspect) {
			camera.aspect = shotAspect;
		} else {
			const bounds = paneRef?.current?.getBoundingClientRect();
			if (bounds && bounds.height >= 1) camera.aspect = bounds.width / bounds.height;
		}
	};
	const rootRef = useRef(null);
	const handlesRef = useRef(new Map()); // axis -> { mesh (pick proxy), axis, dir }
	const screenRingRef = useRef(null); // the outer ring's group, billboarded to the camera each frame
	const ringGroupsRef = useRef({}); // axis -> the group whose rotation.z picks that ring's near half
	const [activeHandle, setActiveHandle] = useState(null); // the handle under a drag — and, after release, the last one (§3.1)
	const [hoveredHandle, setHoveredHandle] = useState(null); // the handle under the pointer
	const hoverRef = useRef(null); // last hovered key: pointer moves that keep it skip the re-render
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	// `held` (held-object-edit.jsx): the object is drawn by a compiled take. The
	// gizmo stands on that drawn pose, and while a hand holds the object a move
	// or rotate drag edits its motion through `held` instead of the record.
	stateRef.current = { object, objects, mode, snap, onChange, onSelect, onGroundClick, onDragStart, onDragEnd, claimPointer, held };
	const tools = useMemo(
		() => ({
			raycaster: new THREE.Raycaster(),
			ndc: new THREE.Vector2(),
			hit: new THREE.Vector3(),
			delta: new THREE.Vector3(),
			eye: new THREE.Vector3(),
			origin: new THREE.Vector3(),
			camPos: new THREE.Vector3(),
		}),
		[],
	);
	/** each axis ring's in-plane basis in world space (u, v), for the
	 * per-frame near/far split — the torus sweeps cosθ·u + sinθ·v around the
	 * axis, and the frame loop only needs the world images of the group's
	 * local X and Z */
	const ringBases = useMemo(
		() =>
			AXES.map(({ axis, dir }) => {
				const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
				return {
					axis,
					u: new THREE.Vector3(1, 0, 0).applyQuaternion(quat),
					v: new THREE.Vector3(0, 0, 1).applyQuaternion(quat),
				};
			}),
		[],
	);

	// Unity keeps the last-dragged handle yellow until the selection or the
	// tool changes (§3.1). The scope the highlight was captured in is compared
	// each render; when either moves, the stored key no longer names a handle
	// in this view. (Render-phase state adjustment: conditional, and it
	// converges because the refs flip first.)
	const activeScopeRef = useRef(null);
	if (activeScopeRef.current && (activeScopeRef.current.id !== object?.id || activeScopeRef.current.mode !== mode)) {
		setActiveHandle(null);
		if (hoverRef.current !== null) {
			hoverRef.current = null;
			setHoveredHandle(null);
		}
	}
	activeScopeRef.current = { id: object?.id, mode };

	// The WHOLE gizmo — visible arrows and rings included, not only the pick
	// proxies — belongs on GIZMO_LAYER: the working views enable that layer,
	// while the shot preview, capture and PlayView draws drop it, so editing
	// chrome can never reach a recorded frame. No dependency list: the handle
	// meshes remount on tool/selection changes and must be re-layered each time.
	useEffect(() => {
		rootRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
	});

	/** the scene object under the pointer, if any (meshes carry the id on an
	 * ancestor group, so the hit walks up to find it) */
	const pickObject = () => {
		// Edge linework (EdgesGeometry LineSegments) raycasts with a generous
		// distance threshold, so it would claim pixels far from the solid mesh.
		// Picking walks past lines/points to the first real surface.
		const hits = tools.raycaster.intersectObjects(scene.children, true);
		const hit = hits.find((entry) => entry.object.isMesh);
		// The camera ghost and the key-light sun live on GIZMO_LAYER so the
		// recording never sees them; give them their own pick pass and prefer
		// whichever surface is nearer.
		tools.raycaster.layers.set(GIZMO_LAYER);
		let ghostId = null;
		let ghostIsEmpty = false;
		const ghostHit = tools.raycaster.intersectObjects(scene.children, true).find((entry) => {
			if (!entry.object.isMesh) return false;
			for (let node = entry.object; node; node = node.parent) {
				// An Empty's marker: its pick volume is a gizmo-layer mesh under
				// the object's own group, so the owning record is the first
				// ancestor carrying a sceneObjectId.
				if (entry.object.userData?.emptyPick && node.userData?.sceneObjectId) {
					ghostId = node.userData.sceneObjectId;
					ghostIsEmpty = true;
					return true;
				}
				if (node.userData?.shotCameraPick) {
					ghostId = "__shotcam__";
					return true;
				}
				if (node.userData?.keyLightPick) {
					ghostId = "__keylight__";
					return true;
				}
			}
			return false;
		});
		tools.raycaster.layers.set(0);
		// The Empty's marker is drawn over the set (no depth test), so what you
		// see is what you click: it wins over whatever surface is behind it.
		if (ghostHit && (ghostIsEmpty || !hit || ghostHit.distance < hit.distance)) return { id: ghostId, point: ghostHit.point.clone() };
		if (!hit) return null;
		for (let node = hit.object; node; node = node.parent) {
			if (node.userData?.sceneObjectId) return { id: node.userData.sceneObjectId, point: hit.point.clone() };
			// Characters are click targets too: a namespaced id routes the
			// selection to the hierarchy, so the Inspector owns the controls.
			if (node.userData?.characterPick) return { id: `char:${node.userData.characterPick}`, point: hit.point.clone() };
		}
		return null; // whatever is in front is set, not an object
	};

	/** pointer -> NDC inside the rect the shot camera actually rendered into */
	const toNdc = (event) => {
		const pane = paneRef?.current;
		const camera = camRef?.current;
		if (!pane || !camera) return null;
		const bounds = pane.getBoundingClientRect();
		if (bounds.width < 2 || bounds.height < 2) return null;
		const rect = imageRect(bounds);
		tools.ndc.set(
			((event.clientX - rect.x) / rect.w) * 2 - 1,
			-((event.clientY - rect.y) / rect.h) * 2 + 1,
		);
		return Math.abs(tools.ndc.x) <= 1 && Math.abs(tools.ndc.y) <= 1 ? tools.ndc : null;
	};

	useEffect(() => {
		if (!enabled) return undefined;

		/** aims the shared raycaster through the pointer; null when the shot
		 * camera or the pane is not measurable yet */
		const rayFrom = (event) => {
			const camera = camRef?.current;
			const ndc = camera ? toNdc(event) : null;
			if (!ndc) return null;
			// Picking happens outside the render loop: under demand rendering a
			// programmatic camera move (framing, preset snap) may not have had a
			// frame yet, and setFromCamera reads matrixWorld as-is. Refresh it
			// here so the first pick after an idle gap aims from the true pose.
			// The shot camera's aspect is locked by the render
			// loop (dualview); under demand rendering a layout change may not
			// have had a frame yet, leaving a stale projection. Re-apply the
			// render contract here so the pick matches what is on screen.
			applyAspect(camera);
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld();
			camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
			rootRef.current?.updateMatrixWorld(true);
			// object meshes move with the drag record; between frames their
			// matrixWorld can lag the same way, so refresh the scene too
			scene.updateMatrixWorld();
			tools.raycaster.setFromCamera(ndc, camera);
			return { ndc, camera };
		};

		const applyDrag = (event) => {
			const drag = dragRef.current;
			if (!drag) return;
			if (!rayFrom(event)) return;
			if (!tools.raycaster.ray.intersectPlane(drag.plane, tools.hit)) return;
			const { objects: all, onChange: change, snap: snapOn } = stateRef.current;
			// "Still exists" guard. Proxy objects (the shot camera, the key
			// light) never live in the scene-object list — for those the current
			// `object` prop is the liveness check, or every drag tick is a no-op.
			const live = all.find((entry) => entry.id === drag.id)
				?? (stateRef.current.object?.id === drag.id ? stateRef.current.object : null);
			if (!live) return;
			// Unity's polarity: a drag is continuous, and Ctrl/Cmd snaps it to the
			// increment. A persistent Snap toggle flips which one the modifier
			// gives you, so the always-on 5 cm grid stays available as a choice
			// instead of a law. (docs/unity-reference.md §5.2, §9.5)
			const snapping = snapOn !== (event.ctrlKey || event.metaKey);
			if (drag.mode === "rotate") {
				tools.delta.subVectors(tools.hit, drag.origin);
				const angle = Math.atan2(tools.delta.dot(drag.binormal), tools.delta.dot(drag.tangent));
				// Accumulate wrapped increments. Reading the raw difference from
				// the drag-start angle instead makes the object snap a full turn
				// the moment the pointer crosses the ring's ±180° seam.
				drag.turned += wrapAngle(((angle - drag.lastAngle) * 180) / Math.PI);
				drag.lastAngle = angle;
				if (drag.held) return void stateRef.current.held?.rotate(drag.dir, dragTurn(drag.turned, snapping ? 5 : 0));
				if (drag.axis === "screen") {
					// The screen ring spins about the view axis: compose the
					// delta onto the drag-start orientation in quaternion space
					// and write all three Euler channels back in one patch.
					const patch = screenRotatePatch(drag.start, drag.dir, drag.turned, snapping ? undefined : 0);
					if (patch) change?.(drag.id, patch, drag.token);
					return;
				}
				const patch = rotatePatch(drag.start, drag.axis, drag.turned, snapping ? undefined : 0);
				if (patch) change?.(drag.id, patch, drag.token);
				return;
			}
			if (drag.mode === "corner") {
				// Both dimensions from one number, so the picture keeps its shape:
				// a corner drag is "bigger/smaller", and the axis knobs are still
				// there for the one-axis stretch.
				const offset = tools.delta.subVectors(tools.hit, drag.origin);
				const along = offset.dot(drag.right) * drag.corner.sx + offset.dot(drag.up) * drag.corner.sy;
				const factor = Math.max(0.02, 1 + (along - drag.startAlong) / drag.reference);
				const height = Math.max(0.05, drag.startHeight * factor);
				const width = Math.max(0.05, drag.startWidth * factor);
				change?.(
					drag.id,
					snapping
						? { height: Math.round(height * 20) / 20, width: Math.round(width * 20) / 20 }
						: { height, width },
					drag.token,
				);
				return;
			}
			if (drag.mode === "scale") {
				// A ratio against the grab point's leverage, so the knob keeps
				// tracking the cursor and a drag toward the pivot shrinks.
				tools.delta.subVectors(tools.hit, drag.origin);
				const travel = tools.delta.dot(drag.dir) - drag.startAlong;
				const factor = 1 + travel / drag.reference;
				// A cutout's width is a measurement in metres, not a scale multiplier:
				// the inspector shows it, the plan board draws it, and the picture is
				// what gets wider. Sending the X handle through `scaleX` would widen
				// the card on screen while its stated width stayed put, so the drag
				// writes the same channel the field does.
				const startWidth = drag.start?.renderer === CUTOUT_KIND ? (drag.start.footprint?.width ?? 0) : 0;
				if (drag.axis === "x" && startWidth > 0) {
					const width = Math.max(0.05, startWidth * Math.max(factor, 0.01));
					change?.(drag.id, { width: snapping ? Math.round(width * 20) / 20 : width }, drag.token);
					return;
				}
				const patch = scalePatch(drag.start, drag.axis, factor, snapping ? undefined : 0);
				if (patch) change?.(drag.id, patch, drag.token);
				return;
			}
			tools.delta.subVectors(tools.hit, drag.hitStart);
			if (drag.held) return void stateRef.current.held?.move(dragTravel(tools.delta, drag.planeAxes ? drag.planeAxes.map((axis) => AXIS_VECTORS[axis]) : [drag.dir], snapping ? 0.05 : 0));
			if (drag.planeAxes) {
				// Plane handle: two axes travel, the third is pinned. This is what
				// replaced body-dragging — the XZ square is how a set gets dressed.
				const patch = {};
				for (const axis of drag.planeAxes) {
					Object.assign(patch, translatePatch(drag.start, axis, tools.delta.dot(AXIS_VECTORS[axis]), snapping ? undefined : 0));
				}
				if (viewportTools().surfaceSnap && drag.planeAxes.includes("x") && drag.planeAxes.includes("z")) {
					tools.raycaster.layers.set(0);
					const surface = tools.raycaster.intersectObjects(scene.children, true).find(hit => {
						if (!hit.object.isMesh || !hit.object.visible) return false;
						for (let node = hit.object; node; node = node.parent) if (node.userData?.sceneObjectId === drag.id) return false;
						return true;
					});
					if (surface) patch.y = surface.point.y;
				}
				change?.(drag.id, patch, drag.token);
				return;
			}
			const patch = translatePatch(drag.start, drag.axis, tools.delta.dot(drag.dir), snapping ? undefined : 0);
			if (patch) change?.(drag.id, patch, drag.token);
		};

		/** pure teardown: listeners down, drag ref null, cursor reset. This is
		 * also the `cancel` handed to the coordinator — teardown only, it never
		 * calls the end-style prop, because the coordinator owns the close
		 * (§5.2). */
		const teardownDrag = () => {
			if (!dragRef.current) return;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
			window.removeEventListener("pointermove", applyDrag);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("keydown", onKeyDown, true);
		};

		/** close the live drag with the given disposition. The token the
		 * coordinator issued is presented on the close; without one (the
		 * no-props fallback) the close is teardown-only, exactly today's
		 * behaviour. */
		const endDrag = (commit) => {
			const drag = dragRef.current;
			if (!drag) return;
			const end = stateRef.current.onDragEnd;
			const token = drag.token;
			teardownDrag();
			if (drag.held) stateRef.current.held?.end(commit);
			else if (token != null && end) end(token, { commit });
		};

		/** pointerup and pointercancel both commit: the travel already applied
		 * is work the user watched happen, and pointer loss is not intent to
		 * discard (§6.3). */
		const onPointerUp = () => endDrag(true);
		const onPointerCancel = () => endDrag(true);

		/** window blur commits the drag as one entry — losing focus mid-drag is
		 * not an abort gesture, and silently rolling back work the user saw
		 * applied is the "undo eats work" failure (§6.3, §14.2). */
		const onBlur = () => endDrag(true);

		/** Escape cancels an in-flight drag: rollback, listeners down. Capture
		 * phase so stopPropagation keeps the same press away from App's
		 * Escape-clears-selection handler; with no drag open it returns without
		 * touching the event, so App still gets its deselect (§7). */
		const onKeyDown = (event) => {
			if (!dragRef.current) return;
			// Settle before App chooses between owned and native undo histories.
			if ((event.ctrlKey || event.metaKey) && (event.code === "KeyZ" || event.code === "KeyY")) {
				endDrag(true);
				return;
			}
			if (event.code !== "Escape" && event.key !== "Escape") return;
			endDrag(false);
			event.preventDefault();
			event.stopPropagation();
		};

		/** Starts a `kind` drag ("move" / "rotate" / "scale"). The raycaster is
		 * already aimed at the pointer by the pick that got us here; `axis` is
		 * null for the uniform-scale knob and for plane handles, which carry
		 * their own `plane` axes instead. */
		const beginDrag = (kind, axis, dir, camera) => {
			const shown = stateRef.current.object;
			if (!shown) return false;
			// The gizmo can be SHOWN on the pose a routed record is drawn at, while
			// every channel a drag writes starts from the AUTHORED record: a start
			// taken from the drawn numbers would land them in the authored ones
			// (a jump of however far the car has driven). The pivot, and the yaw
			// the card's corners are seen at, are the shown ones.
			const live = stateRef.current.objects.find((entry) => entry.id === shown.id) ?? shown;
			const heldEdit = stateRef.current.held;
			gizmoOrigin(shown, heldEdit, tools.origin);
			camera.getWorldDirection(tools.eye);
			let plane;
			let drag;
			if (kind === "rotate") {
				// spin plane: perpendicular to the ring's axis, through the
				// pivot. The screen ring has no axis of its own: it spins
				// about the camera's own forward, so its plane is the
				// camera-facing plane through the pivot.
				// A held object turns about its own axes (its rings are drawn turned too).
				const turn = gizmoTurn(heldEdit, kind);
				const spinDir = axis === "screen" ? tools.eye : turn ? dir.clone().applyQuaternion(new THREE.Quaternion(...turn)) : dir;
				plane = new THREE.Plane().setFromNormalAndCoplanarPoint(spinDir, tools.origin.clone());
				const hit = new THREE.Vector3();
				if (!tools.raycaster.ray.intersectPlane(plane, hit)) return false;
				// a stable in-plane basis to read the pointer's angle from
				const tangent = new THREE.Vector3(spinDir.y, spinDir.z, spinDir.x).cross(spinDir).normalize();
				const binormal = spinDir.clone().cross(tangent).normalize();
				const offset = hit.clone().sub(tools.origin);
				if (offset.lengthSq() < 1e-8) return false;
				drag = {
					mode: "rotate",
					tangent,
					binormal,
					lastAngle: Math.atan2(offset.dot(binormal), offset.dot(tangent)),
					turned: 0,
					origin: tools.origin.clone(),
					dir: spinDir.clone(), // the world axis the delta spins about (the ring's, or the view's)
				};
			} else if (kind === "scale") {
				// Scale reads a ratio against the grab point's distance from the
				// pivot, so the knob tracks the cursor. The centre knob has no
				// axis of its own: it rides the camera's right vector.
				const dragDir = axis ? dir.clone() : new THREE.Vector3().crossVectors(tools.eye, new THREE.Vector3(0, 1, 0)).normalize();
				const normal = dragDir.clone().cross(tools.eye).cross(dragDir).normalize();
				plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tools.origin.clone());
				const hit = new THREE.Vector3();
				if (!tools.raycaster.ray.intersectPlane(plane, hit)) return false;
				const startAlong = hit.clone().sub(tools.origin).dot(dragDir);
				// A grab right on the pivot has no leverage; fall back to the
				// gizmo's own length so the first move is still sane.
				const reference = Math.abs(startAlong) < 0.05 ? (rootRef.current?.scale.x ?? 1) * ARROW_LEN : startAlong;
				drag = { mode: "scale", dir: dragDir, startAlong, reference, origin: tools.origin.clone() };
			} else if (kind === "corner") {
				// The card's own plane, so the grab tracks the picture rather than a
				// world axis: a standee that has been turned is still resized by the
				// corner the eye sees.
				const yaw = ((shown.rot ?? 0) * Math.PI) / 180;
				const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
				const up = new THREE.Vector3(0, 1, 0);
				const normal = new THREE.Vector3().crossVectors(right, up).normalize();
				plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tools.origin.clone());
				const hit = new THREE.Vector3();
				if (!tools.raycaster.ray.intersectPlane(plane, hit)) return false;
				const startWidth = live.footprint?.width ?? 0;
				const startHeight = live.height ?? 0;
				if (!(startWidth > 0) || !(startHeight > 0)) return false;
				// Leverage is the grab's distance from the centre measured along the
				// corner's own diagonal, so pulling out grows and pushing in shrinks
				// however the card is turned.
				const offset = hit.clone().sub(tools.origin);
				const along = offset.dot(right) * dir.sx + offset.dot(up) * dir.sy;
				const halfDiagonal = (startWidth + startHeight) / 4;
				drag = {
					mode: "corner",
					corner: dir,
					right,
					up,
					startAlong: along,
					reference: Math.abs(along) < 0.05 ? halfDiagonal : along,
					startWidth,
					startHeight,
					origin: tools.origin.clone(),
				};
			} else if (kind === "plane") {
				// The handle's own plane, pinned through the pivot: the two loose
				// axes are read straight off the hit point.
				const normal = AXIS_VECTORS[dir.normal];
				plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tools.origin.clone());
				const hit = new THREE.Vector3();
				if (!tools.raycaster.ray.intersectPlane(plane, hit)) return false;
				drag = { mode: "move", planeAxes: dir.axes, hitStart: hit };
			} else {
				// slide plane: contains the axis and faces the camera as squarely
				// as it can, the same construction TransformControls uses
				const normal = dir.clone().cross(tools.eye).cross(dir).normalize();
				plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tools.origin.clone());
				const hit = new THREE.Vector3();
				if (!tools.raycaster.ray.intersectPlane(plane, hit)) return false;
				drag = { mode: "move", dir: dir.clone(), hitStart: hit };
			}
			// The coordinator (App) issues the token; the gizmo keeps it on its
			// own drag ref and presents it on every apply and on the close, so
			// a resumed pointer stream after a settle is inert by construction
			// (§6.1). The `cancel` handed over is teardown-only — the
			// coordinator owns the close, and a close attempted from inside it
			// is inert because the token is retired first (§5.2).
			// A held-object drag edits the motion, not the record: no scene transaction.
			const heldDrag = Boolean(heldEdit?.editable && (kind === "rotate" || (!heldEdit.hinge && (kind === "move" || kind === "plane"))) && heldEdit.begin());
			let token; try { token = heldDrag ? undefined : stateRef.current.onDragStart?.({
				owner: "gizmo",
				cancel: teardownDrag,
			}); } catch (error) { if (error?.code === "TARGET_BUSY") return true; throw error; } // refused (an agent turn holds the scene; the bus toasts why): claim the press, start no drag
			const corner = kind === "corner" ? dir : null;
			dragRef.current = { ...drag, id: live.id, axis, plane, corner, start: { ...live }, token, held: heldDrag };
			// the grabbed handle turns yellow now and stays yellow after
			// release, until the selection or the tool changes (§3.1)
			setActiveHandle(handleKey({ axis, plane, corner }));
			gl.domElement.style.cursor = "grabbing";
			window.addEventListener("pointermove", applyDrag);
			window.addEventListener("pointerup", onPointerUp);
			window.addEventListener("pointercancel", onPointerCancel);
			// Only a real transaction gets the extra lifecycle edges: blur and
			// Escape would otherwise change mid-drag behaviour for callers that
			// pass no transaction props (the byte-for-byte fallback path).
			if (token != null || heldDrag) {
				window.addEventListener("blur", onBlur);
				window.addEventListener("keydown", onKeyDown, true);
			}
			return true;
		};

		/** the gizmo handle under the pointer, if any */
		const pickHandle = (event) => {
			const aim = rayFrom(event);
			if (!aim) return null;
			// entries whose mesh has left the scene (mode switch, deselect) are
			// stale registrations, not pick targets
			const handles = [...handlesRef.current.values()].filter((entry) => entry.mesh?.parent);
			if (!handles.length) return null;
			tools.raycaster.layers.set(GIZMO_LAYER);
			const hits = tools.raycaster.intersectObjects(handles.map((entry) => entry.mesh), false)
			if (!hits.length) return null;
			const entryFor = (hit) => handles.find((entry) => entry.mesh === hit.object);
			// A corner sits out at the card's edge while the uniform knob's pick
			// sphere is fat and nearer the camera, so depth order alone would hand
			// every corner grab to the centre. A corner that was hit at all was
			// aimed at: nothing else lives that far out.
			const corner = hits.map(entryFor).find((entry) => entry?.corner);
			const grabbed = corner ?? entryFor(hits[0]);
			return grabbed ? { ...grabbed, aim } : null;
		};

		const onDown = (event) => {
			// Plain left only. Alt+left orbits, middle pans, right flies — those
			// belong to the camera and must pass straight through.
			if (event.button !== 0 || event.altKey || event.target !== gl.domElement || viewportSketch().tool) return; // the Annotate pen owns the press (context-chip-tools.jsx)
			// A mode that owns this press outranks selection entirely. This
			// window-capture listener runs BEFORE any listener below the window
			// (capture descends root-first), so without this yield the line-edit
			// stage listener could never see a press this handler claims — the
			// stopPropagation below killed the descent. The probe must be
			// side-effect free: it only answers "would you grab here?".
			if (stateRef.current.claimPointer?.(event)) return;
			const grabbed = pickHandle(event);
			// A press ON the key-light sun, or on a route or crane dot, outranks
			// any handle overlapping it: the puck's own body-drag and the dot's
			// own grab are the primary interaction there, and the centre
			// plane-square would otherwise silently claim the grab. (A routed
			// object drawn at frame 0 sits exactly on its route's start dot.)
			if (grabbed && rayFrom(event)) {
				tools.raycaster.layers.set(GIZMO_LAYER);
				const dotClaims = tools.raycaster.intersectObjects(scene.children, true).some((entry) => {
					for (let node = entry.object; node; node = node.parent) {
						const data = node.userData;
						if (data?.keyLightPick || data?.pathIndex !== undefined || data?.pathRing || data?.craneIndex !== undefined) return true;
					}
					return false;
				});
				tools.raycaster.layers.set(0);
				if (dotClaims) return;
			}
			if (
				grabbed &&
				beginDrag(
					grabbed.corner ? "corner" : grabbed.plane ? "plane" : stateRef.current.mode,
					grabbed.axis,
					grabbed.corner ?? grabbed.plane ?? grabbed.dir,
					grabbed.aim.camera,
				)
			) {
				// keep this press away from the fly camera
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			// A pick-only instance (the character's ride on this gizmo) owns
			// nothing beyond its handles: selection, ground clicks and the
			// object-hover cursor belong to the primary instance.
			if (pickOnly) return;
			// And the mirror duty: a press on the TWIN's handles is not ours to
			// claim either. Handles live on GIZMO_LAYER and our own already had
			// their chance in pickHandle above, so any gizmo-layer surface still
			// under the pointer belongs to the other instance — claiming it here
			// deselected the character and killed the drag it had just started.
			if (!rayFrom(event)) return;
			tools.raycaster.layers.set(GIZMO_LAYER);
			// Only surfaces that OWN their press may veto selection (#81): the
			// twin's marked pick proxies, the key-light sun, path and crane dots
			// — see gizmo-claim.js. Everything else on the layer is furniture
			// (the selection cage, drawn arrows and rings, rail lines, labels):
			// counting ANY layer hit here let the SELECTED object's own cage veto
			// a press aimed at a different object's body, so the press never
			// reached pickObject and Cube -> Sphere selection silently failed.
			// The camera ghost is deliberately NOT a claimer: it is a selection
			// target for pickObject below, so its press must fall through.
			if (claimsPress(tools.raycaster.intersectObjects(scene.children, true))) return;
			// Selection. A left press on a body selects it and does nothing else;
			// a press on empty space clears the selection. Both claim the press so
			// the fly camera cannot also react — navigation lives on the right and
			// middle buttons now.
			tools.raycaster.layers.set(0);
			const picked = pickObject();
			event.preventDefault();
			event.stopPropagation();
			// Path authoring outranks deselection: an empty-floor press drops a
			// waypoint where the ray meets the deck. Presses on bodies still select.
			if (!picked && stateRef.current.onGroundClick && tools.raycaster.ray.intersectPlane(GROUND, tools.hit)) {
				stateRef.current.onGroundClick({ x: tools.hit.x, z: tools.hit.z });
				return;
			}
			stateRef.current.onSelect?.(picked ? picked.id : null);
		};

		const onHover = (event) => {
			// A held button is a camera look-drag: no picking work per frame.
			if (dragRef.current || event.buttons !== 0 || event.target !== gl.domElement) return;
			const picked = pickHandle(event);
			const key = picked ? handleKey(picked) : null;
			// Re-render only when the handle under the pointer actually
			// changes; a plain move across one handle would otherwise re-render
			// the gizmo every pointer tick.
			if (key !== hoverRef.current) {
				hoverRef.current = key;
				setHoveredHandle(key);
			}
			if (picked) {
				gl.domElement.style.cursor = "grab";
				return;
			}
			if (pickOnly) return;
			tools.raycaster.layers.set(0);
			gl.domElement.style.cursor = pickObject() ? "pointer" : "";
		};

		// QA hooks: the real pickers, addressable from a headless check. The
		// pick-only instance must not clobber the primary's hooks.
		if (!pickOnly) window.__gizmoPick = (x, y) => {
			const grabbed = pickHandle({ clientX: x, clientY: y, button: 0 });
			if (!grabbed) return null;
			return handleKey(grabbed);
		};
		if (!pickOnly) window.__objectPick = (x, y) => {
			if (!rayFrom({ clientX: x, clientY: y })) return null;
			tools.raycaster.layers.set(0);
			return pickObject()?.id ?? null;
		};

		window.addEventListener("pointerdown", onDown, true);
		gl.domElement.addEventListener("pointermove", onHover);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			gl.domElement.removeEventListener("pointermove", onHover);
			// unmount / enabled->false: the drag's travel is real work, so it
			// commits as one entry rather than silently rolling back (§6.3)
			endDrag(true);
		};
	}, [enabled, pickOnly, gl, scene, camRef, paneRef, tools]);

	// Constant on-screen size: the gizmo is UI, not set dressing.
	useFrame(() => {
		const root = rootRef.current;
		const camera = camRef?.current;
		if (!root || !camera || !object) return;
		camera.getWorldPosition(tools.camPos);
		gizmoOrigin(object, held, tools.origin);
		root.scale.setScalar(Math.max(0.2625, tools.camPos.distanceTo(tools.origin) * SCREEN_SCALE));
		if (mode !== "rotate") return;
		// The rotate rings are view-dependent, so their orientation is frame
		// state: the screen ring billboards flat to the camera (the shot
		// camera is a bare scene child, so its quaternion is world space),
		// and each axis ring's near/far half boundary is the camera-facing
		// plane through the pivot.
		camera.getWorldDirection(tools.eye);
		const screen = screenRingRef.current;
		if (screen) screen.quaternion.copy(camera.quaternion);
		// Turned rings (a held object's own axes): the near/far split and the
		// billboard are worked out in the gizmo's own frame.
		const turn = gizmoTurn(held, mode);
		if (turn) {
			const unturn = new THREE.Quaternion(...turn).invert();
			tools.eye.applyQuaternion(unturn);
			screen?.quaternion.premultiply(unturn);
		}
		for (const { axis, u, v } of ringBases) {
			const ring = ringGroupsRef.current[axis];
			if (!ring) continue;
			// The near half points at the camera: its centre is −forward
			// projected onto the ring plane, i.e. atan2(−f·v, −f·u) in the
			// ring's (u, v) basis. The far half sits at φ + π.
			ring.rotation.z = Math.atan2(-tools.eye.dot(v), -tools.eye.dot(u));
		}
	});

	// QA hook: where each handle sits on screen, through the exact rect the
	// picker builds its ray from. Headless checks drive real pointer events
	// with it (harmless in normal use). The character gizmo is a separate
	// pick-only instance, so it needs its own mirror hook.
	const getHandles = useCallback(() => {
			const camera = camRef?.current;
			const pane = paneRef?.current;
			if (!camera || !pane) return [];
			// reads happen between frames (QA, headless checks): sync the
			// matrices the projection depends on instead of trusting the last
			// render tick under demand rendering, and re-apply the render
			// loop's locked aspect (dualview) so QA geometry matches the
			// drawn frame exactly
			applyAspect(camera);
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld();
			camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
			rootRef.current?.updateMatrixWorld(true);
			const bounds = pane.getBoundingClientRect();
			const rect = imageRect(bounds);
			return [...handlesRef.current.values()]
				.filter((entry) => entry.mesh?.parent)
				.map((entry) => {
					const point = entry.mesh.getWorldPosition(new THREE.Vector3()).project(camera);
					return {
						// One source of truth for the key, so a new handle kind cannot
						// report itself as "centre" to QA while picking as itself.
						axis: handleKey(entry),
						x: rect.x + ((point.x + 1) / 2) * rect.w,
						y: rect.y + ((1 - point.y) / 2) * rect.h,
					};
				});
		}, [camRef, paneRef, shotAspect]);
	if (typeof window !== "undefined" && !pickOnly) window.__gizmoHandles = getHandles;
	useEffect(() => {
		if (typeof window === "undefined" || !pickOnly) return undefined;
		window.__characterGizmoHandles = getHandles;
		return () => {
			if (window.__characterGizmoHandles === getHandles) delete window.__characterGizmoHandles;
		};
	}, [getHandles, pickOnly]);

	if (!enabled || !object) {
		handlesRef.current.clear();
		return null;
	}
	// Keyed registration: a re-render replaces the pick proxy in place instead
	// of stacking a second copy of the gizmo in the pick list.
	const register = (axis, dir) => (mesh) => {
		if (!mesh) return;
		mesh.layers.set(GIZMO_LAYER);
		// The claim mark (gizmo-claim.js): the OTHER gizmo instance's selection
		// handler yields presses on this proxy instead of deselecting mid-grab.
		mesh.userData[HANDLE_PROXY_FLAG] = true;
		handlesRef.current.set(axis ?? "centre", { mesh, axis, dir });
	};
	/** the group whose rotation.z picks which half of this axis ring is near */
	const registerRingGroup = (axis) => (group) => {
		ringGroupsRef.current[axis] = group;
	};
	/** a plane square: no single axis, so it carries its own two-axis descriptor */
	const registerPlane = (plane) => (mesh) => {
		if (!mesh) return;
		mesh.layers.set(GIZMO_LAYER);
		mesh.userData[HANDLE_PROXY_FLAG] = true;
		handlesRef.current.set(`plane:${plane.id}`, { mesh, axis: null, plane });
	};
	/** a cutout card's corner: resizes the picture, so it owns no axis either */
	const registerCorner = (corner) => (mesh) => {
		if (!mesh) return;
		mesh.layers.set(GIZMO_LAYER);
		mesh.userData[HANDLE_PROXY_FLAG] = true;
		handlesRef.current.set(`corner:${corner.id}`, { mesh, axis: null, corner });
	};
	/** invisible-but-raycastable pick volume */
	const pickMaterial = <meshBasicMaterial visible={false} />;

	const screenActive = activeHandle === "screen";
	const screenHovered = hoveredHandle === "screen";
	const centreActive = activeHandle === "centre";
	const centreHovered = hoveredHandle === "centre";
	return (<>
		<HeldTrail trail={held?.trail ?? null} />
		<group ref={rootRef} position={gizmoOrigin(object, held, new THREE.Vector3()).toArray()} quaternion={gizmoTurn(held, mode) ?? [0, 0, 0, 1]} renderOrder={999}>
			{AXES.map(({ axis, dir, color }) => {
				const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
				// The handle under a drag — and, after release, the last one —
				// is yellow; the one under the pointer is brighter (§3.1).
				const isActive = activeHandle === axis;
				const isHovered = hoveredHandle === axis;
				const emissive = isActive ? ACTIVE_COLOR : color;
				const emissiveIntensity = isActive ? 2.2 : isHovered ? 3.6 : 2.2;
				const material = (opacity = 0.95) => (
					<meshStandardMaterial
						color="#000000"
						emissive={emissive}
						emissiveIntensity={emissiveIntensity}
						toneMapped={false}
						depthTest={false}
						depthWrite={false}
						transparent
						opacity={opacity}
					/>
				);
				return (
					<group key={axis} quaternion={quat}>
						{mode === "rotate" ? (
							<group ref={registerRingGroup(axis)} rotation={[Math.PI / 2, 0, 0]}>
								{/* near half: full brightness */}
								<mesh renderOrder={999}>
									<torusGeometry args={[RING_R, RING_TUBE, 8, 24, Math.PI]} />
									{material()}
								</mesh>
								{/* far half: faded so it reads as behind (see FAR_HALF_ALPHA) */}
								<mesh rotation={[0, 0, Math.PI]} renderOrder={999}>
									<torusGeometry args={[RING_R, RING_TUBE, 8, 24, Math.PI]} />
									{material(FAR_HALF_ALPHA)}
								</mesh>
								<mesh ref={register(axis, dir)}>
									<torusGeometry args={[RING_R, PICK_TUBE_R, 6, 32]} />
									{pickMaterial}
								</mesh>
							</group>
						) : (
							<>
								<mesh position={[0, ARROW_LEN / 2, 0]} renderOrder={999}>
									<cylinderGeometry args={[SHAFT_R, SHAFT_R, ARROW_LEN, 8]} />
									{material()}
								</mesh>
								<mesh position={[0, ARROW_LEN + (mode === "scale" ? BOX_SIZE / 2 : TIP_LEN / 2), 0]} renderOrder={999}>
									{mode === "scale" ? (
										<boxGeometry args={[BOX_SIZE, BOX_SIZE, BOX_SIZE]} />
									) : (
										<coneGeometry args={[TIP_R, TIP_LEN, 14]} />
									)}
									{material()}
								</mesh>
								<mesh ref={register(axis, dir)} position={[0, (ARROW_LEN + TIP_LEN) / 2, 0]}>
									<cylinderGeometry args={[PICK_SHAFT_R, PICK_SHAFT_R, ARROW_LEN + TIP_LEN, 8]} />
									{pickMaterial}
								</mesh>
							</>
						)}
					</group>
				);
			})}
			{mode === "rotate" && (
				<group ref={screenRingRef}>
					{/* the outermost ring, always flat to the viewer: rolls the
					    object about the view axis (§3.3) */}
					<mesh renderOrder={999}>
						<torusGeometry args={[SCREEN_RING_R, RING_TUBE, 8, 64]} />
						<meshStandardMaterial
							color="#000000"
							emissive={screenActive ? ACTIVE_COLOR : "#f2f2f2"}
							emissiveIntensity={screenActive ? 2.2 : screenHovered ? 3.6 : 2.2}
							toneMapped={false}
							depthTest={false}
							depthWrite={false}
							transparent
							opacity={0.95}
						/>
					</mesh>
					<mesh ref={register("screen", null)}>
						<torusGeometry args={[SCREEN_RING_R, PICK_TUBE_R, 6, 48]} />
						{pickMaterial}
					</mesh>
				</group>
			)}
			{mode === "move" &&
				PLANES.map((plane) => {
					// The square lies in its own plane, offset along both loose axes
					// so it sits in the quadrant between the two arrows.
					const position = [0, 0, 0];
					const index = { x: 0, y: 1, z: 2 };
					for (const axis of plane.axes) position[index[axis]] = PLANE_OFFSET;
					const rotation = plane.normal === "y" ? [-Math.PI / 2, 0, 0] : plane.normal === "x" ? [0, Math.PI / 2, 0] : [0, 0, 0];
					const planeActive = activeHandle === `plane:${plane.id}`;
					const planeHovered = hoveredHandle === `plane:${plane.id}`;
					return (
						<group key={plane.id} position={position} rotation={rotation}>
							<mesh renderOrder={999}>
								<planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
								<meshBasicMaterial
									color={planeActive ? ACTIVE_COLOR : plane.color}
									transparent
									opacity={planeActive ? 0.6 : planeHovered ? 0.55 : 0.34}
									side={THREE.DoubleSide}
									depthTest={false}
									depthWrite={false}
								/>
							</mesh>
							<mesh ref={registerPlane(plane)}>
								<planeGeometry args={[PLANE_SIZE * 1.5, PLANE_SIZE * 1.5]} />
								<meshBasicMaterial visible={false} side={THREE.DoubleSide} />
							</mesh>
						</group>
					);
				})}
			{/* A cutout is a picture, so it also gets the gesture pictures have:
			    grab a corner, pull, and it resizes without changing shape. Drawn in
			    scale mode beside the axis knobs, which keep the one-axis stretch. */}
			{mode === "scale" &&
				object?.renderer === CUTOUT_KIND &&
				CARD_CORNERS.map((corner) => {
					const halfWidth = (object.footprint?.width ?? 0) / 2;
					const halfHeight = (object.height ?? 0) / 2;
					if (!(halfWidth > 0) || !(halfHeight > 0)) return null;
					// The gizmo is drawn at a constant screen size, so the card's own
					// metres have to be divided back out to land on its corners.
					const unit = rootRef.current?.scale.x || 1;
					const key = `corner:${corner.id}`;
					const active = activeHandle === key;
					const hovered = hoveredHandle === key;
					// The gizmo group carries no rotation, so the corner is placed on
					// the card's own turned plane by hand.
					const yaw = ((object.rot ?? 0) * Math.PI) / 180;
					const outX = (corner.sx * halfWidth) / unit;
					const position = [outX * Math.cos(yaw), (corner.sy * halfHeight) / unit, -outX * Math.sin(yaw)];
					return (
						<group key={key} position={position}>
							<mesh renderOrder={999}>
								<boxGeometry args={[CORNER_BOX, CORNER_BOX, CORNER_BOX]} />
								<meshStandardMaterial
									color="#000000"
									emissive={active ? ACTIVE_COLOR : "#f2f2f2"}
									emissiveIntensity={active ? 2 : hovered ? 3.4 : 2}
									toneMapped={false}
									depthTest={false}
									depthWrite={false}
								/>
							</mesh>
							<mesh ref={registerCorner(corner)}>
								<sphereGeometry args={[PICK_CORNER_R, 8, 6]} />
								{pickMaterial}
							</mesh>
						</group>
					);
				})}
			{mode === "scale" && (
				<>
					{/* uniform scale: one knob at the pivot, all three axes at once */}
					<mesh renderOrder={999}>
						<boxGeometry args={[CENTRE_BOX, CENTRE_BOX, CENTRE_BOX]} />
						<meshStandardMaterial
							color="#000000"
							emissive={centreActive ? ACTIVE_COLOR : "#f2f2f2"}
							emissiveIntensity={centreActive ? 2 : centreHovered ? 3.4 : 2}
							toneMapped={false}
							depthTest={false}
							depthWrite={false}
						/>
					</mesh>
					<mesh ref={register(null, null)}>
						<sphereGeometry args={[PICK_CENTRE_R, 8, 6]} />
						{pickMaterial}
					</mesh>
				</>
			)}
		</group>
	</>);
}
