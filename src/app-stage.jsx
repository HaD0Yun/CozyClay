// Module-level constants, pure helpers, and standalone R3F stage components
// extracted verbatim from App.jsx. Nothing here reads App() state directly —
// everything arrives through props or module imports, which is what made the
// extraction safe. Behavior-identical by construction; verified by the build
// and the browser QA suites.
import {
	useRef,
	useState,
} from "react";
import { imageFilesFrom } from "./scene-assets.js";
import { splitDroppedFiles } from "./scene-mesh.js";

export {
	PRESETS,
	SHOT_ASPECT_PRESETS,
	characterModelUrl,
	CHARACTER_MODEL_LABELS,
	nextCharacterId,
	OBJECT_DELETE_UNDO_MS,
	ASSET_DELETE_UNDO_MS,
	CLAY,
	CLAY_B,
	CLAY_X,
	defaultCharacterTint,
	editorFrameForSubject,
	DEFAULT_SUBJECT,
	DEFAULT_SUBJECT2,
	DEFAULT_ENVIRONMENT,
	DEFAULT_CAMERA_POSITION,
	REST_BONES,
	GIZMO_HOTKEYS,
	WORKSPACE_LAYOUT_KEY,
	DEFAULT_WORKSPACE_LAYOUT,
	loadWorkspaceLayout,
	loadSceneStartup,
} from "./stage-startup-defaults.js";

export {
	RIG_HIERARCHY_FOCUS,
	HIERARCHY_INSPECTOR_TITLES,
	POSE_LABELS_KO,
	CAMERA_MOVE_LABELS_KO,
	SHOT_SIZE_LABELS_KO,
	SHOT_LEVEL_LABELS_KO,
	SCENE_RENDERER_LABELS_KO,
	SCENE_OBJECT_NAME_LABELS_KO,
	poseLabelKo,
	cameraMoveLabelKo,
	sceneRendererLabelKo,
	sceneObjectNameDisplayKo,
	viewShortKo,
	slateLineKo,
	moveSequenceSlateKo,
	hierarchyIdForIkFocus,
} from "./stage-labels-ko.js";

export * from "./stage-attach-frames.js";

export { Character, PlaybackCharacter } from "./stage-characters.jsx";

export {
	ShotRig,
	MoveRig,
	FollowCamRig,
	ShotLookApplier,
	CameraGlide,
	EditorCamSeed,
	RenderLoopController,
	ContextLossGuard,
	ViewportLayoutInvalidator,
} from "./stage-canvas-rigs.jsx";

export {
	KeyLightPuck,
	ShotCameraGhost,
	CameraRailScenePreview,
	ObjectPathHandles,
	CraneHandles,
	ShotPathPreview,
} from "./stage-editor-gizmos.jsx";

export {
	CAPTURE_W,
	CAPTURE_H,
	MCP_CAPTURE_W,
	MCP_CAPTURE_H,
	MCP_CAPTURE_SAMPLE_STEP,
	CAPTURE_FOG_NEAR,
	CAPTURE_FOG_FAR,
	CaptureRig,
	captureMcpFrame,
} from "./stage-capture.jsx";
export {
	TIMELINE_FPS,
	DEFAULT_DURATION_S,
	DEFAULT_PLAYBACK_SPEED,
	MAX_WAYPOINTS,
} from "./timeline-defaults.js";

/* ------------------------------------------------------------------ 3D --- */

/**
 * Anything that accepts a dropped picture. Returns the handlers to spread onto
 * an element and whether a drag is currently over it, so the target can say so
 * — a drop zone that gives no sign it is armed reads as a dead area, and the
 * file gets dropped on the desktop instead.
 *
 * `dragover` must preventDefault, or the browser navigates away to the file.
 */
export function useImageDrop(onFiles, onRejected) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const carriesFiles = (event) => !!event.dataTransfer?.types?.includes?.("Files");
	return {
		over,
		handlers: {
			onDragEnter: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				depth.current += 1;
				setOver(true);
			},
			onDragOver: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			},
			// dragleave fires for every child the pointer crosses, so the
			// highlight is refcounted rather than toggled.
			onDragLeave: () => {
				depth.current = Math.max(0, depth.current - 1);
				if (!depth.current) setOver(false);
			},
			onDrop: (event) => {
				const files = imageFilesFrom(event.dataTransfer);
				depth.current = 0;
				setOver(false);
				// Dropped files that are not supported images (HEIC from an iPhone
				// is the mainline case) used to die here with zero feedback — the
				// user concluded drag-and-drop was broken. Name the rejection.
				if (!files.length) {
					const dropped = event.dataTransfer?.files?.length ?? 0;
					if (dropped > 0) onRejected?.(dropped);
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				onFiles(files);
			},
		},
	};
}

/**
 * Inspector, hierarchy and viewport drop: pictures AND .glb files in one
 * gesture. A GLB must not go through `useImageDrop`, or it toasts as an
 * unsupported image even though the set can now stand it up as a mesh.
 *
 * `onRejected` fires only when the drop carried files and none of them were
 * a picture or a GLB — a mixed PNG+GLB drop imports both, and leftover
 * HEICs in that mix stay silent rather than blocking the good files.
 */
export function useStageFilesDrop({ onImages, onMeshes, onRejected } = {}) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const carriesFiles = (event) => !!event.dataTransfer?.types?.includes?.("Files");
	return {
		over,
		handlers: {
			onDragEnter: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				depth.current += 1;
				setOver(true);
			},
			onDragOver: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			},
			onDragLeave: () => {
				depth.current = Math.max(0, depth.current - 1);
				if (!depth.current) setOver(false);
			},
			onDrop: (event) => {
				const { images = [], meshes = [] } = splitDroppedFiles(event.dataTransfer);
				depth.current = 0;
				setOver(false);
				if (!images.length && !meshes.length) {
					const dropped = event.dataTransfer?.files?.length ?? 0;
					if (dropped > 0) onRejected?.(dropped);
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				void (async () => {
					if (images.length) await onImages?.(images);
					if (meshes.length) await onMeshes?.(meshes);
				})();
			},
		},
	};
}
