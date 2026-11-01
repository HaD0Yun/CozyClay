import { useMotion } from "./domains/motion.js";
import { useCast } from "./domains/cast.js";
import { useShots } from "./domains/shots.js";
import { useObjects } from "./domains/objects.js";
import { useScenes } from "./domains/scenes.js";
import { useStage } from "./domains/stage.js";
import StudioShell from "./shell/StudioShell.jsx";
import ViewportToolbar from "./shell/ViewportToolbar.jsx";
import CompositionGuideButton from "./shell/CompositionGuideButton.jsx";
import { StudioShellContext } from "./shell/studio-shell-context.js";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Canvas,
} from "@react-three/fiber";
import {
	OrthographicCamera,
	PerspectiveCamera,
} from "@react-three/drei";
import * as THREE from "three";

import { restorePlaybackBones, snapshotPlaybackBones } from "./motion/rig-snapshot.js";
import { applyTakeFrame } from "./motion3/playback.js";

import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import { createCameraPerformance, framingFromCamera } from "./camera-performance.js";
import ViewportMeasurement from "./viewport-measurement.jsx";
import ReviewOverlay from "./review-overlay.jsx";
import "./previs.css";
import { applyCameraOptics, focusDistance } from "./camera-optics.js";
import { burnInRgba, reviewSlate } from "./review-burn-in.js";
import { frameEditorView } from "./editor-view-frame.js";
import { createLiveControl, loadLiveWorkspaceId, mintLiveWorkspaceId } from "./live-control.js";
import { startUserEdits } from "./command-bus-telemetry.js";
import { noteHistoryKey, noteShortcutIgnored, noteUnselectedKey } from "./shortcut-friction.js";
import { noteNavSwitch } from "./thrash-friction.js";

import AgentPanel from "./workflow/AgentPanel.jsx";
import SculptPanel from "./panels/SculptPanel.jsx";
import { dropAssetAt } from "./asset-drop.js";
import { saveSculptToShelf } from "./sculpt-shelf.js";
import { createAgentPort, createSculptRun } from "./sculpt-run.js";
import { SculptTurntable } from "./sculpt-stage.jsx";
import { measureReferenceOutline } from "./sculpt-compare.js";
import { BLUEPRINT_LAYOUT, blueprintRunViews, buildBlueprintPrompt } from "./sculpt-blueprint.js";
import { browserSculptImages } from "./commands/sculpt-images.js";
import { sculptAgentClient, sculptModelLabel } from "./sculpt-mode.js";
import { useSculptMode } from "./use-sculpt-mode.js";
import { useFirstSuccessPrompt } from "./use-first-success-prompt.js";
import { useEmbedBridge } from "./use-embed-bridge.js";
import { useAssetShelf } from "./use-asset-shelf.js";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { elementByPath } from "./studio-elements.js";
import {
	resolveStudioToast,
} from "./studio-actions.js";
import { createStudioAppActions } from "./commands/index.js";
import { STORYBOARD_MOTION_REFUSAL } from "./commands/view.js";

import { createStudioAppBinding } from "./studio-app-binding.js";
import { AppContext, createAppContext } from "./app-context.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { PlanBoard } from "./planview.jsx";
import { drawPlanDiagram } from "./plan-diagram.js";
import { placementAt } from "./root-path.js";
import { proxyYaw } from "./proxy-figure.jsx";
import { autoColorHex, loadAutoColor } from "./auto-color.js";
import { DualRender, GIZMO_LAYER } from "./dualview.jsx";
import { GridFloor } from "./grid-floor.jsx";
import { readStoredGridView, writeStoredGridView } from "./grid-view.js";
import { useUiTheme } from "./theme.js";

import { Room, StageLights, StageAtmosphere } from "./room.jsx";
import { createDocumentMirrors } from "./document-mirrors.js";
import { buildRail, simplifyStroke } from "./camera-follow.js";
import { useShotCameraTracks } from "./use-shot-camera-tracks.js";
import { ObjectCarrier, SetProps } from "./props.jsx";
import {
	CUTOUT_KIND,
	isEffectivelyHidden,
	objectSize,
	sceneObjectIdFromHierarchy,
} from "./scene-objects.js";

import {
	assetGraphSignature,
	assetUsageCounts,
	deleteAsset,
	deleteAssetWithGraphGuard,
	getAsset,
	imageFilesFromClipboard,
	isImageAssetId,
	isMeshAssetId,
	isSupportedMeshType,
	listAssetIds,
	openAssetDb,
	putAsset,
	unreachableAssetIds,
} from "./scene-assets.js";
import { derivedAssetIds, sourceAssetIds } from "./asset-shelf.js";
import { assetRecord, evictAssetTexture, rememberAsset } from "./scene-asset-cache.js";
import { evictMeshScene } from "./scene-mesh-cache.js";
import { subscribeToSceneDocuments, subscribeToScenePlayback } from "./workflow/scene-asset-sync.js";
import {
	decodeMask,
} from "./matte.js";
import { createMatteEditor } from "./matte-editor.js";
import {
	SCENES_VERSION,
	activeSceneIndex,
	createSceneStage,
	isProxyFigure,
	normalizeReferenceImage,
} from "./scenes.js";
import {
	hasFileSystemAccess,
	loadStoredProjectHandle,
	queryHandlePermission,
	requestHandlePermission,
	readProjectDocument,
	WORKFLOW_STORAGE_KEY,
} from "./project.js";
import ProjectBrowser, { ProjectNameDialog } from "./project-browser.jsx";
import FirstSuccessGuide from "./first-success-guide.jsx";
import { noteDeleteUndone, notePanelToggled } from "./studio-telemetry.js";
import UseCaseQuestion from "./use-case-question.jsx";
import ObjectGizmo from "./object-gizmo.jsx";
import { useHeldObjectEdit } from "./held-object-edit.jsx";

import {
	SaveBlockedDialog,
} from "./resource-status.jsx";

import ResultModal from "./result-modal.jsx";


import { PWA_UPDATE_EVENT } from "./pwa.js";
import {
	createObjectPath,
	insertPathMark,
	objectTransformAt,
	pathMetrics,
	strokeToPathPoints,
} from "./object-path.js";
import { carriedPointAt, sceneObjectsAt } from "./object-travel.js"; import { objectTracksOf } from "./motion3/object-tracks.js"; import { ViewGhosts } from "./view-ghosts.jsx"; import { DraftGhost } from "./draft-ghost.jsx"; import { SculptSketch } from "./sculpt-sketch.jsx"; import { PhysicsOverlayLayer } from "./physics-overlay.jsx"; import { syncPhysicsOverlays } from "./physics-overlay.js";
import { routeOwnerFor } from "./route-owner.js";
import {
	exportFailureCode,
	recordUseCase,
	sculptRunTelemetry,
	shouldAskUseCase,
	track,
	trackActivation,
	trackFeature,
} from "./analytics.js";
import { ko, isKo, isZh } from "./locale.js";
import { saveExport } from "./export-workspace.js";
import { startExportAttempt } from "./export-attempt.js";
import { characterCapabilities, kindRefusal, proxyFigureBounds } from "./character-kind.js";
import { STARTER_SCENES, resolveSceneParam } from "./starter-scenes.js";
import { PART_COLOURS } from "./part-colours.js";
import {
	DEFAULT_POSE,
	applyHipsOffset,
	applyPose,
} from "./poses.js";
import {
	IkHandles,
	PoseHandles,
	RangePinMarker,
	warmPoseThumbnails,
} from "./posestudio.jsx";
import { FingerHandles, useFingerEdit } from "./finger-handles.jsx";
import { STORYBOARD_FONT, storyboardCaption, storyboardLine } from "./shell/storyboard-caption.js";

import {
	createIkState,
	ikEvaluate,
	ikKeyframes,
	ikSeedTargets,
	resolveIkRig,
	shareContactMeasurements,
} from "./motion/ik.js";

import {
	Toast,
} from "./ui.jsx";
import { useRenderActivity } from "./use-render-activity.js";
import { useWebGlAvailable } from "./use-webgl-available.js";

import {
	CUSTOM_MOVE,
	IMAGE_MODELS,
	SUBJECT_HEIGHT_M,
	composePrompt,
	deriveShot,
	fovToFocalMm,
} from "./shot.js";
import { captureFraming, classifyMove, moveSequenceSlate, moveSequencePhrase } from "./camera-move.js";
import { sampleAt } from "./sample-at.js";
import { exportOffscreenVideo } from "./offscreen-export.js";
import { parseRigNodeId } from "./hierarchy-model.js";
import { timelineContentExtent } from "./timeline-extent.js";
import {
	guideGeometry,
	readStoredGuideMode,
	writeStoredGuideMode,
} from "./shot-guides.js";
import { shotCaptureMeta } from "./shot-meta.js";
import { buildShotPrompt } from "./shot-prompt.js";
import { buildKeyframePack, keyframePackEntries, keyframePackName, slugifyTitle } from "./keyframe-pack.js";
import { buildZip } from "./zip-store.js";
import { composeStoryboard } from "./storyboard.js";
import { DEPTH_RANGE_M, depthRangeFromFrames, passFileName, renderPass } from "./render-passes.js";

import { serializeOtio } from "./otio.js";
import "./shell/mode.css";
import { readPoseFadeOpacity, withPoseFadeLifted, writePoseFadeOpacity } from "./pose-fade.js";
import {
	shotAtFrame,
	shotIndexAtFrame,
} from "./cuts.js";
import { playbackFrame } from "./motion/playback-frame-store.js";
import { usePlaybackSubjectPosition } from "./motion/playback-subject.js";
import { studioBusy } from "./studio-busy.js";
import { characterGizmoObject as buildCharacterGizmoObject, characterGizmoView, followCameraActive, playbackSceneWithTrack, updateShotMetrics } from "./stage-gizmo.js";
import {
	CameraGlide,
	CameraRailScenePreview,
	CaptureRig,
	PlaybackCharacter,
	ContextLossGuard,
	CraneHandles,
	DEFAULT_CAMERA_POSITION,
	DEFAULT_DURATION_S,
	EditorCamSeed,
	FollowCamRig,
	GIZMO_HOTKEYS,
	KeyLightPuck,
	MCP_CAPTURE_H,
	MCP_CAPTURE_W,
	
	MoveRig,
	OBJECT_DELETE_UNDO_MS,
	ObjectPathHandles,
	RIG_HIERARCHY_FOCUS,
	RenderLoopController,
	SHOT_ASPECT_PRESETS,
	ShotCameraGhost,
	ShotLookApplier,
	ShotPathPreview,
	ShotRig,
	TIMELINE_FPS,
	ViewportLayoutInvalidator,
	WORKSPACE_LAYOUT_KEY,
	attachFrameMatrix,
	captureMcpFrame,
	characterModelUrl,
	defaultCharacterTint,
	loadSceneStartup,
	loadWorkspaceLayout,
	moveSequenceSlateKo,
	slateLineKo,
	useStageFilesDrop,
} from "./app-stage.jsx";

/**
 * Composition guides stretched over whichever DOM rect currently shows the
 * shot frame. The SVG uses a 0..100 space with preserveAspectRatio="none":
 * proportional guides (thirds, golden, safe) stay correct under any aspect,
 * and non-scaling strokes keep the ink one pixel wide. Overlay only — it
 * never reaches the WebGL scene or exported pixels.
 */
function ShotGuideOverlay({ mode, aspect, className = "" }) {
	const geometry = guideGeometry(mode);
	if (geometry.lines.length === 0 && geometry.rects.length === 0) return null;
	// The viewBox carries the shot aspect and "meet" centers it, so the SVG
	// letterboxes itself exactly like the framed render underneath — the same
	// fit rule, computed by the same engine, with no JS measurement.
	const spanX = 100 * (aspect || 1);
	const sx = (value) => (value / 100) * spanX;
	return (
		<div className={"shot-guides " + className} aria-hidden="true" data-guide-mode={mode}>
			<svg viewBox={`0 0 ${spanX} 100`} preserveAspectRatio="xMidYMid meet">
				{geometry.lines.map((l, index) => (
					<line key={index} x1={sx(l.x1)} y1={l.y1} x2={sx(l.x2)} y2={l.y2} vectorEffect="non-scaling-stroke" />
				))}
				{geometry.rects.map((r) => (
					<rect key={r.kind} x={sx(r.x)} y={r.y} width={sx(r.width)} height={r.height} className={"guide-" + r.kind} vectorEffect="non-scaling-stroke" />
				))}
			</svg>
		</div>
	);
}

const CHARACTER_POSITION_BOUNDS = elementByPath("character.position").gizmo;
const CHARACTER_SCALE_BOUNDS = elementByPath("character.scale");

// How long an agent receipt keeps its targets lit in the hierarchy. Long
// enough to find the row after reading the chat line, short enough that it is
// never mistaken for selection. Paired with --agent-touch in styles.css, which
// fades the same highlight out over the same two seconds.
const AGENT_RECEIPT_HIGHLIGHT_MS = 2000;

/**
 * Pose ONE cast member's rig at an absolute timeline frame: its own clip first,
 * then its own IK correction layer on top. This is the single description of
 * "where is this character at frame N" — the viewport effect, the offscreen
 * recorder and the range-pin bake all go through it, so a body stands exactly
 * where the render would draw it.
 *
 * Pure in the sense that matters here: it takes the rig, the clip and the layer
 * state and writes bones. No React, no refs, no knowledge of who is active — a
 * caller that wants the active character's LIVE editing state passes it, and
 * one that wants a stored layer passes that.
 *
 * A missing rig, a member with no clip and a layer with no keys are all
 * no-ops rather than errors: characters without a take keep their pose.
 */
function poseMemberAtFrame(rig, clip, ikState, frame, blendFrames = 0, pose = null) {
	if (!rig) return;
	if (clip) {
		const sampled = sampleAt({ frameCount: clip.frames, motion: clip }, null, frame);
		applyTakeFrame(rig, clip, sampled.motionFrame);
	} else if (pose) {
		applyPose(rig, pose);
		applyHipsOffset(rig, pose.rootY ?? 0);
	}
	if (ikState && ikState.keys.size > 0 && ikState.chains && ikState.rig === rig) {
		ikEvaluate(ikState.chains, ikState, frame, ikState.fkJoints, clip ? blendFrames : 0);
	}
}

/** The longest edge a stored reference picture may have. A character sheet is
 * read as a LOOK, not as texture detail, and the whole thing has to survive
 * inside the project document — 1024 px keeps a face legible at a fraction of
 * the bytes a phone photo would cost. */

/**
 * Read one picked file into the data URL a reference slot stores: FileReader
 * for the bytes (so the result survives save/load exactly like an Upload node's
 * image), then a canvas pass to cap the long side. The source type is kept, so
 * a JPEG photo stays a JPEG instead of being re-encoded into a much larger PNG.
 */

/** An http(s) asset source as the data URL the import path takes. */
async function fetchImportSource(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const blob = await response.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("could not read the download"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(blob);
	});
}

export default function App() {
	// App retains the lifetime and ownership of these cells; the facade only
	// centralizes access for current and long-lived callbacks.
	const [appContext] = useState(() => createAppContext({
		// These cells initialize later in this render. Readers run only after
		// initialization and follow the same refs across subsequent renders.
		motion: { get current() { return bufferRef.current.motion; } },
		getBus: () => studioBindingRef.current.bus,
		notify: (...args) => setToast(...args),
	}));
	const { embedMode, playgroundMode } = useEmbedBridge();
	const exportMenuTriggerRef = useRef(null);
	const exportShotIdRef = useRef(null);
	useEffect(() => {
		if (!embedMode) return undefined;
		// The Workflow page's Scene node embeds the studio as its preview, so the
		// embed enters the player through enterPreview(). The states are seeded
		// from embedMode as well, so the first painted frame is already the shot
		// view rather than a flash of editor chrome.
		enterPreview();
		const capture = () => {
			try {
				const live = appContext.live.state;
				const dataUrl = live.captureFramingPng(live.captureCurrentFraming());
				if (!dataUrl) throw new Error("The shot renderer is not ready");
				const output = SHOT_ASPECT_PRESETS[live.stage.shotAspect] ?? SHOT_ASPECT_PRESETS["16:9"];
				const meta = live.captureShotMeta(live.timeline.currentFrame);
				// The identity sheets and the environment reference ride with the
				// frame (#167): the PNG says where the bodies stand, these say who
				// they are and what the location is made of.
				const references = live.captureShotReferences();
				window.parent.postMessage({ type: "cozyclay:capture-framing-result", dataUrl, width: output.width, height: output.height, meta, references }, "*");
			} catch (error) { window.parent.postMessage({ type: "cozyclay:capture-framing-result", error: error.message }, "*"); }
		};
		// The Workflow page's Scene node asks the embed for a whole reference
		// pack (#165). The zip is transferred rather than copied: a pack carries a
		// clip, and structured-cloning tens of megabytes across the frame boundary
		// is the one part of this that would actually be felt.
		const exportPack = async (shotId, ownedByWorkflow) => {
			const attempt = ownedByWorkflow ? null : startExportAttempt({ export_kind: "keyframe_pack", format: "zip", surface: "embed" });
			try {
				const live = appContext.live.state;
				const index = live.shotIndexForPack(shotId ?? null);
				const pack = await live.buildShotKeyframePack(live.shots[index], index);
				const bytes = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength);
				window.parent.postMessage(
					{ type: "cozyclay:export-keyframe-pack-result", name: pack.name, bytes, entries: pack.entries.map((entry) => entry.name) },
					"*",
					[bytes],
				);
				attempt?.succeed();
			} catch (error) {
				attempt?.fail(error);
				window.parent.postMessage({ type: "cozyclay:export-keyframe-pack-result", error: error?.message || String(error), failure_code: exportFailureCode(error) }, "*");
			}
		};
		const onMessage = (event) => {
			if (event.data?.type === "cozyclay:capture-framing") capture();
			if (event.data?.type === "cozyclay:export-keyframe-pack") {
				const ownedByWorkflow = event.source === window.parent && event.origin === window.location.origin && event.data.surface === "workflow";
				void exportPack(event.data.shotId, ownedByWorkflow);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embedMode]);
	// QA-only render counter (same spirit as window.__cozyclay): headless perf
	// probes read renders/second to find re-render storms. Negligible cost.
	if (typeof window !== "undefined") window.__cozyclayRenders = (window.__cozyclayRenders || 0) + 1;
	const sceneRevisionRef = useRef(0);
	const studioBindingRef = useRef(null);
	const semanticEditRef = useRef(null);
	if (!semanticEditRef.current) {
		// A new mount boundary for the first edit. User edits are counted from the
		// command bus's own receipts (command-bus-telemetry.js), not from here.
		startUserEdits(playgroundMode ? "playground" : "craft");
		semanticEditRef.current = (domain, before, after) => {
			if (before !== after) sceneRevisionRef.current += 1;
			studioBindingRef.current?.invalidate(domain, before, after);
			studioBindingRef.current?.publishSemantic(domain, after);
		};
	}
	// One semantic hook for authored UI and programmatic mutations. Passive
	// setters intentionally bypass it (navigation, load, seed, restore, history).
	const markSemanticEdit = (domain, before, after) => semanticEditRef.current(domain, before, after);
	const craftActionTrackedRef = useRef(false);
	const markCraftAction = (actionKind) => {
		if (craftActionTrackedRef.current) return;
		craftActionTrackedRef.current = true;
		// Playground pokes are funnel data for the landing page, not for the
		// install -> first craft funnel the studio reports.
		track(playgroundMode ? "playground:first_action" : "craft:first_action", { action_kind: actionKind });
	};
	useEffect(() => {
		if (!playgroundMode) return;
		track("playground:opened");
		// The landing page keeps a loading veil over the iframe until the
		// studio has actually mounted; a bare `load` fires far too early.
		window.parent?.postMessage({ type: "cozyclay:playground-ready" }, "*");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const [startup] = useState(loadSceneStartup);
	const startupScene = startup.document.scenes[activeSceneIndex(startup.document.scenes, startup.document.activeSceneId)];
	const startupStage = createSceneStage(startupScene.stage);
	const startupCreatedScene = startup.startupCreatedScene === true;
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const stageDomain = useStage(appContext.forRender({
		startupStage,
		get stageDomain() { return stageDomain; },
		get actorStageRef() { return actorStageRef; },
		get objects() { return storeRef.current.objects; },
	}));
	const {
		preset, shotAspectKey, environmentImage, cameraPresetId, sensorId, keyLight, lighting, changeKeyLight,
		resetKeyLight, changeEnvironmentImage, hasEnvSheet, environment, style, publishStudioStage,
	} = stageDomain;
	const shotsDomain = useShots(appContext.forRender({
		get cameraPreviewEndRef() { return cameraPreviewEndRef; },
		get captureCurrentFraming() { return captureCurrentFraming; },
		get charA() { return charA; },
		get framingSessionOpen() { return framingSessionOpen; },
		get framingSessionRef() { return framingSessionRef; },
		get ikMode() { return ikMode; },
		get look() { return look; },
		get manualCameraOverrideRef() { return manualCameraOverrideRef; },
		get markCraftAction() { return markCraftAction; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motionPos() { return motionPos; },
		get playMode() { return playMode; },
		

		get runStudioAction() { return runStudioAction; },
		get selectWorkflowMode() { return selectWorkflowMode; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setTlPlaying() { return setTlPlaying; },
		get setWorkspaceLayout() { return setWorkspaceLayout; },
		get shotCamRef() { return shotCamRef; },
		get snapshotCast() { return snapshotCast; },
		get startupScene() { return startupScene; },
		get tlPlaying() { return tlPlaying; },
		get waypointMode() { return waypointMode; },
		get workflowMode() { return workflowMode; },
		get activeChar() { return activeChar; },
		get characters() { return characters; },
		get currentRecordFrameCount() { return currentRecordFrameCount; },
		get enterPreview() { return enterPreview; },
		get executeExportRequest() { return executeExportRequest; },
		get exportRequest() { return exportRequest; },
		get motion() { return motion; },
		get playgroundMode() { return playgroundMode; },
		
		get recRef() { return recRef; },
		get runShotExport() { return runShotExport; },
		get setCameraPos() { return setCameraPos; },
		get setNonce() { return setNonce; },
		get shotCameraPosRef() { return shotCameraPosRef; },
		get stageDomain() { return stageDomain; },
	}));
	const {
		fovDeg, setFovDeg, cameraMove, customMove, startupShotState, shots, setShots, editShots, movePlaying,
		setMovePlaying, moveFollow, railDraw, setRailDraw, craneSelectedIndex, setCraneSelectedIndex, tlFrame,
		setTlFrame, tlFrameCount, setTlFrameCount, tlFps, setTlFps, activeShotIdx, activeShot, cameraKeys,
		activeCamera, craneActive, cameraRail, activeShotDuration, hasCameraKeys, changeActiveCamera,
		changeShotTargetModel, addActiveCranePoint, deleteSelectedCranePoint, syncActiveCameraFraming,
		commitManualCameraFraming, beginCameraFramingGesture, beginTimelineEditGesture, setShotCameraRail,
		clearShotCameraRail, changeCameraRail, toggleCameraRailDraw, deleteCameraRail, previewCameraShot,
		addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, addTimelineShot, splitTimelineShot,
		selectTimelineShot, duplicateTimelineShot, moveTimelineShot, setTimelineShotRange, removeTimelineShot,
	} = shotsDomain;
	const { publishStudioCamera, applyPreset, exportShotVideo } = shotsDomain;

	const shotOutput = SHOT_ASPECT_PRESETS[shotAspectKey] ?? SHOT_ASPECT_PRESETS["16:9"];

	// Composition guides over the shot frame (Blender's camera display guides).
	// A viewer preference, not scene data: it persists per browser, never in
	// the scene document, and never touches exported pixels.
	const [guideMode, setGuideMode] = useState(() => readStoredGuideMode(globalThis.localStorage));
	useEffect(() => {
		writeStoredGuideMode(globalThis.localStorage, guideMode);
	}, [guideMode]);
	// Blender-style grid viewport: dark void + reference grid instead of the
	// clay deck. A viewer preference like the guides — never scene data.
	const [gridView, setGridView] = useState(() => readStoredGridView(globalThis.localStorage));
	// The stage follows the UI theme (grid-view.js stageBackground).
	const uiTheme = useUiTheme();
	useEffect(() => {
		writeStoredGridView(globalThis.localStorage, gridView);
	}, [gridView]);

	const [camGlide, setCamGlide] = useState(null);
	const filmback = useMemo(
		() => ({ sensorId, aspectRatio: shotOutput.aspect }),
		[sensorId, shotOutput.aspect],
	);
	const [nonce, setNonce] = useState(0);
	// Which `preset:nonce` ShotRig last seeded the shot camera from. Held here
	// rather than inside ShotRig because a suspending cast model remounts the
	// Canvas children, and a remount must not re-seed over a camera move.
	const shotPresetAppliedRef = useRef(null);
	// The shot camera's last position, kept outside the Canvas so a remount can
	// put the camera back where it was. ShotRig's metrics tick keeps it fresh;
	// the live set_camera handler writes it directly because that command can
	// land while the camera is unmounted.
	const shotCameraPosRef = useRef(null);
	// The Top-View is always the inset: the old double-click swap that let the
	// plan own the big pane is gone, so there is no view mode to toggle.
	const planIsMain = false;
	// The framed output only — no editing chrome (gizmo, inset, fly navigation)
	// reaches it. The Scene/PlayView centre tabs are gone (#195): this is an
	// internal player with two entry points (the Workflow embed and the
	// playground rail) and one exit (Esc / the exit pill). The shot PiP's
	// look-through button flies the recording camera instead.
	const [preview, setPreview] = useState(embedMode);
	// The name stays `playMode`: window.__cozyclay QA hooks and the MCP live
	// bridge read this global, and the render path is still PlayView's.
	globalThis.playMode = preview;
	const playMode = preview;
	// Preview is the player for the finished motion: entering starts playback,
	// leaving pauses it. The editor view stays the manipulation surface.
	const [tlPlaying, setTlPlaying] = useState(false);
	// Playback ticks stay outside React; stopping commits the live frame back to
	// the edit-time state so exports and agent reads see the stopped frame.
	useEffect(() => {
		if (playgroundMode && tlPlaying) window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "play" }, "*");
	}, [playgroundMode, tlPlaying]);
	const cameraPreviewEndRef = useRef(null);
	// Once the operator touches the viewport, the physical camera stays in
	// their hands. Follow/Rail only take it back through an explicit Preview or
	// timeline Play, avoiding the snap-back that used to happen on pointer-up.
	const manualCameraOverrideRef = useRef(false);
	// Split cameras: the EDITOR camera is the user's own eye and never
	// records; the shot camera keeps the framing. Look-through hands the fly
	// controls the shot camera itself — the pre-split single-view behaviour —
	// for framing by flying.
	// The Workflow page embeds this Studio as the Scene node's preview; that
	// preview must show what the node captures on Run: the shot camera's view.
	const [lookThroughShot, setLookThroughShot] = useState(embedMode);
	useEffect(() => {
		if (!lookThroughShot || embedMode) return undefined;
		const onKey = (event) => {
			if (event.key === "Escape") exitPreview();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lookThroughShot, embedMode]);
	/** The chrome-free player. The shot camera takes the whole pane
	 * (DualRender's playMode branch), the piece restarts from frame 0, and
	 * auto-play only exists once there is a motion to play. Look-through rides
	 * along so every site that picks a camera keeps pointing at the shot camera.
	 * Studio look-through does NOT come through here — that is enterShotLook. */
	function enterPreview() {
		setPreview(true);
		setLookThroughShot(true);
		setTlFrame(0);
		if (motion) setTlPlaying(true);
	}
	/** ...and the one way out of both the player and shot-look: editing chrome
	 * back, playback paused, so leaving never leaves the timeline running
	 * underneath it. */
	function exitPreview() {
		if (cameraPerformanceRef.current?.active) stopCameraPerformance();
		setPreview(false);
		setLookThroughShot(false);
		setTlPlaying(false);
	}
	/** Fly the shot camera with the same bindings as the free camera. Preview
	 * stays off so FlyControls stay live and framing commits stick. */
	function enterShotLook() {
		if (embedMode) return;
		setPreview(false);
		setTlPlaying(false);
		setLookThroughShot(true);
		setSelectedHierarchyId("camera");
		setWorkflowMode("camera");
	}
	const stageRef = useRef();
	const mainPaneRef = useRef();
	const insetPaneRef = useRef();
	// The shot preview pane: the recording camera's framed output, rendered
	// like an exported frame (no editing chrome) while the editor camera owns
	// the main pane.
	const shotPreviewRef = useRef();
	// User-dragged inset position (px, stage-relative). null = the CSS default
	// (top-right); double-clicking the tag snaps back to it.
	const [insetPos, setInsetPos] = useState(null);
	// Timestamp of the last fold toggle that came from the tag strip (click or
	// caret). A double-click started on the tag lands its dblclick event on
	// the pane body afterwards — the body listener skips those, or every tag
	// double-click would toggle twice.
	const insetToggledAtRef = useRef(0);
	const planCamRef = useRef();
	const planHostRef = planIsMain ? mainPaneRef : insetPaneRef;

	useEffect(() => {
		// The landing-page playground runs a fixed, throwaway layout: whatever a
		// visitor drags in the iframe must never overwrite the layout they use in
		// the real studio (same origin, same key).
		if (playgroundMode) return;
		// Quota-guarded like persistScenes: a full disk used to throw out of
		// this effect and blank the studio mid-resize (issue #63).
		try {
			localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
		} catch (err) {
			console.warn("[cozyclay] workspace layout not saved:", err?.name ?? err);
		}
	}, [playgroundMode, workspaceLayout]);

	// Wheel over the inset zooms the Top-View plan: scroll up closes in on
	// the pucks (camera lower), scroll down widens out (camera higher) — the
	// ortho extent is divided by planZoom in DualRender. React's onWheel is
	// passive and could never keep the page still, so a real listener.
	useEffect(() => {
		const pane = insetPaneRef.current;
		if (!pane) return;
		const onWheel = (e) => {
			e.preventDefault();
			setWorkspaceLayout((current) => {
				const next = Math.max(0.25, Math.min(4, current.planZoom * Math.pow(1.0015, -e.deltaY)));
				return next === current.planZoom ? current : { ...current, planZoom: Math.round(next * 100) / 100 };
			});
		};
		pane.addEventListener("wheel", onWheel, { passive: false });
		return () => pane.removeEventListener("wheel", onWheel);
	}, []);

	const [preferencesOpen, setPreferencesOpen] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [previewRanges, setPreviewRanges] = useState([]);
	const [flySpeed, setFlySpeed] = useState(1);
	const workspaceStyle = {
		"--shell-right-width": workspaceLayout.shellSidebarWidth && `${workspaceLayout.shellSidebarWidth}px`,
		"--shell-outliner-height": workspaceLayout.shellOutlinerHeight && `${workspaceLayout.shellOutlinerHeight}px`,
		"--shell-dock-height": workspaceLayout.shellDockHeight && `${workspaceLayout.shellDockHeight}px`,
		"--shell-left-width": workspaceLayout.shellLeftWidth && `${workspaceLayout.shellLeftWidth}px`,
		"--shell-agent-height": workspaceLayout.shellAgentHeight && `${workspaceLayout.shellAgentHeight}px`,
		"--shell-camera-width": workspaceLayout.shellCameraWidth && `${workspaceLayout.shellCameraWidth}px`,
		"--shot-aspect": shotOutput.aspect,
		"--hierarchy-width": `${workspaceLayout.hierarchyWidth}px`,
		"--sidebar-width": `${workspaceLayout.sidebarWidth}px`,
		"--timeline-height": `${workspaceLayout.timelineHeight}px`,
		"--inset-width": `${workspaceLayout.insetWidth}px`,
		"--inset-height": `${workspaceLayout.insetHeight}px`,
	};

	function beginWorkspaceResize(kind, e) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startY = e.clientY;
		const shell = e.currentTarget.closest(".app");
		const sidebarWidth = shell.querySelector(".studio-right-column").getBoundingClientRect().width;
		const leftWidth = shell.querySelector(".studio-left-column")?.getBoundingClientRect().width ?? 0;
		const hierarchyHeight = shell.querySelector(".hierarchy-left").getBoundingClientRect().height;
		const mainHeight = shell.querySelector(".workspace").getBoundingClientRect().height;
		const dockHeight = shell.querySelector(".bottom-window").getBoundingClientRect().height;
		const agentHeight = shell.querySelector(".studio-agent-inspector")?.getBoundingClientRect().height ?? 0;
		const rightHeight = shell.querySelector(".studio-right-column").getBoundingClientRect().height;
		const cameraWidth = Number.parseFloat(getComputedStyle(shell).getPropertyValue("--shell-camera-width")) || 340;
		const onMove = (ev) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			setWorkspaceLayout((current) => {
				if (kind === "left") {
					return { ...current, shellLeftWidth: Math.max(200, Math.min(window.innerWidth * 0.3, leftWidth + dx)) };
				}
				if (kind === "agent") {
					return { ...current, shellAgentHeight: Math.max(160, Math.min(rightHeight - 200, agentHeight - dy)) };
				}
				if (kind === "camera") {
					return { ...current, shellCameraWidth: Math.max(240, Math.min(560, cameraWidth - dx)) };
				}
				if (kind === "sidebar") {
					return {
						...current,
						shellSidebarWidth: Math.max(280, Math.min(window.innerWidth * 0.5, sidebarWidth - dx)),
					};
				}
				if (kind === "hierarchy") {
					return {
						...current,
						shellOutlinerHeight: Math.max(120, Math.min(mainHeight - 120, hierarchyHeight + dy)),
					};
				}
				return {
					...current,
					shellDockHeight: Math.max(110, Math.min(window.innerHeight * 0.58, dockHeight - dy)),
				};
			});
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", `resize-${kind}`);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", `resize-${kind}`);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Double-clicking the inset body folds it (like a window titlebar). The
	// tag keeps its own double-click (snap back to the corner); the old
	// Scene↔Top-View big-pane swap on double-click is gone — the Top-View is
	// always the inset, folded or not. Pane divs are pointer-events:none off
	// the plan board, so this hit-tests the rect instead of DOM targeting.
	useEffect(() => {
		const onDblClick = (event) => {
			const pane = insetPaneRef.current;
			if (!pane) return;
			if (event.target.closest?.(".vp-inset-tag")) return; // the tag's own gesture
			if (Date.now() - insetToggledAtRef.current < 450) return; // a tag gesture already folded this double-click
			const rect = pane.getBoundingClientRect();
			if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
			setWorkspaceLayout((current) => ({ ...current, insetCollapsed: !current.insetCollapsed }));
		};
		window.addEventListener("dblclick", onDblClick);
		return () => window.removeEventListener("dblclick", onDblClick);
	}, []);

	// Drag the inset pane by its tag chip. Window-level listeners so a fast
	// drag off the chip keeps moving the pane; bounds clamp to the stage.
	function beginInsetDrag(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const grabX = e.clientX - paneRect.left;
		const grabY = e.clientY - paneRect.top;
		// Dragging the collapsed pill clamps against the EXPANDED size, so a
		// pill parked at an edge can never expand out from under the sidebar.
		const effW = workspaceLayout.insetCollapsed ? workspaceLayout.insetWidth : paneRect.width;
		const effH = workspaceLayout.insetCollapsed ? workspaceLayout.insetHeight : paneRect.height;
		// Foldout semantics on the tag strip: a click without movement folds,
		// a drag past the threshold moves the pane — same gesture family as the
		// inspector's foldout headers.
		let moved = false;
		const onMove = (ev) => {
			if (!moved && Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
			moved = true;
			setInsetPos({
				x: Math.max(8, Math.min(ev.clientX - stageRect.left - grabX, stageRect.width - effW - 8)),
				y: Math.max(8, Math.min(ev.clientY - stageRect.top - grabY, stageRect.height - effH - 8)),
			});
		};
		const onUp = (ev) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			// A double-click is one deliberate fold, not two: the second click's
			// pointerup carries detail=2 and is ignored, so rapid clicking never
			// flicker-toggles the inset.
			if (!moved && ev.detail <= 1) {
				insetToggledAtRef.current = Date.now();
				runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed });
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Expanding reclamps the parked position against the restored size: a
	// pill dragged to the stage edge must expand INTO the stage, not under
	// the inspector sidebar.
	function expandInset() {
		const stage = stageRef.current;
		if (stage) {
			const stageRect = stage.getBoundingClientRect();
			const maxX = Math.max(8, stageRect.width - workspaceLayout.insetWidth - 8);
			const maxY = Math.max(8, stageRect.height - workspaceLayout.insetHeight - 8);
			setInsetPos((pos) => (pos ? { x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) } : pos));
		}
		setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
	}
	/** Fold or unfold the Top-View inset: the Top button, the inset's own
	 * toggle, its tag click and run_action view.setInset. */
	function setInsetCollapsed(collapsed) {
		if (collapsed) setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
		else expandInset();
	}
	/** The View menu's part colours: "off", "flat" or "shaded". */
	function choosePartColours(mode) {
		setPartColoursEnabled(mode !== "off");
		if (mode !== "off") setPartColoursMode(mode);
	}

	function beginInsetResize(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const originX = paneRect.left - stageRect.left;
		const originY = paneRect.top - stageRect.top;
		if (!insetPos) setInsetPos({ x: originX, y: originY });
		const onMove = (ev) => {
			const width = Math.max(190, Math.min(stageRect.width - originX - 8, paneRect.width + ev.clientX - startX));
			const height = Math.max(150, Math.min(stageRect.height - originY - 8, paneRect.height + ev.clientY - startY));
			setWorkspaceLayout((current) => ({ ...current, insetWidth: width, insetHeight: height }));
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", "resize-inset");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", "resize-inset");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	const castDomain = useCast(appContext.forRender({
		get beginGestureUndo() { return beginGestureUndo; },
		get bufferRef() { return bufferRef; },
		get clearMotion() { return clearMotion; },
		get committedIkEdits() { return committedIkEdits; },
		get environment() { return environment; },
		get environmentImage() { return environmentImage; },
		get frameCountRef() { return frameCountRef; },
		get gestureUndoRef() { return gestureUndoRef; },
		get hasEnvSheet() { return hasEnvSheet; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get keyLight() { return keyLight; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motion() { return motion; },
		get motionFullRef() { return motionFullRef; },
		
		get publishStudioCharacters() { return publishStudioCharacters; },
		get rigReportersRef() { return rigReportersRef; },
		get rigWaitersRef() { return rigWaitersRef; },
		get runStudioAction() { return runStudioAction; },
		get setCommittedIkEdits() { return setCommittedIkEdits; },
		get setIkTick() { return setIkTick; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setShots() { return setShots; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get shots() { return shots; },
		get snapshotIkKeys() { return snapshotIkKeys; },
		get stageDomain() { return stageDomain; },
		get startupShotState() { return startupShotState; },
		get startupStage() { return startupStage; },
		get style() { return style; },
		get tlFps() { return tlFps; },
		get tlFrame() { return tlFrame; },
		get tlFrameCount() { return tlFrameCount; },
		get editShots() { return editShots; },
		get publishStudioCamera() { return publishStudioCamera; },
		get publishStudioDomain() { return publishStudioDomain; },
		get publishStudioStage() { return publishStudioStage; },
		get sceneRevisionRef() { return sceneRevisionRef; },
		get snapshotCast() { return snapshotCast; },
		get snapshotStudioDomain() { return snapshotStudioDomain; },
		get storeRef() { return storeRef; },
		get studioActionGroupRef() { return studioActionGroupRef; },
		get studioHistoryRef() { return studioHistoryRef; },
		get syncStudioLayerBuffer() { return syncStudioLayerBuffer; },
		get ikMode() { return ikMode; },
		get leaveIkMode() { return leaveIkMode; },
		get motionDomain() { return motionDomain; },
		get objectDeleteUndo() { return objectDeleteUndo; },
		get readStudioState() { return readStudioState; },
		get selectedSceneObjectId() { return selectedSceneObjectId; },
		get setObjectDeleteUndo() { return setObjectDeleteUndo; },
		get snapshotExportRig() { return snapshotExportRig; },
		get studioBindingRef() { return studioBindingRef; },
		get objectsDomain() { return objectsDomain; },
		
		get shotsDomain() { return shotsDomain; },
	}));
	const {
		characters, customPoses, posing, posingClosing, studioPick, setStudioPick,
		rigs, rigMountEpoch, setRigMountEpoch, setPoseTick, charA, charB, showB, poseA, poseB, subject, subject2,
		updateCharacterAt, setShowB, moveCharacter, removeCharacter, reportRig, spawnCharacter,
		charKeyToHierarchyId, charIdFromHierarchyId, activeCharacterId, setActiveCharacterId, rowIdForCharIndex,
		activeChar, selectActiveCharacterInHierarchy, activeCharIndex, activeRig, waitForRig, ghostLayers,
		snapshotCast, changeInspectorCharacter, hasCharSheet, setHasCharSheet,
		waypointMode, setWaypointMode, waypoints, setWaypoints,
		activeWaypointId, setActiveWaypointId, pendingWaypointFrame, setPendingWaypointFrame, allPoses, selectablePoses, posingIndex, posingChar, posedRig, setPosed, rootStart, commitPosedPose,
		queueRootWaypointFrame, castMemberOf, addCharacterWaypoint, moveCharacterWaypoint,
		removeCharacterWaypoint, clearCharacterWaypoints, addFloorWaypoint, moveWaypoint, removeWaypoint,
		toggleWaypointMode, openStudio, closeStudio, saveCurrentPose, savePose, removePose,
		
	} = castDomain;
	const { publishStudioCharacters, syncStudioLayerBuffer, undoScene, redoScene, snapshotStudioDomain } = castDomain;
	// The cast as of this render, for async handlers: an extraction that
	// started three renders ago must place its takes against the CURRENT cast,
	// not the one its closure captured.
	appContext.publishCharacters(characters);

	// Per-character rig report: stable callback identity per character so
	// the Character effect does not re-fire on every App render.
	const rigReportersRef = useRef(new Map());
	const rigWaitersRef = useRef(new Map());

	/* --------------------------- asset dragging ---------------------------- */

	// A grabbed asset card follows the pointer as a DOM ghost; dropping over
	// the shot pane raycasts to the floor and spawns the payload there. The
	// payload is discriminated — {kind:'character'|'object'|'image'|'mesh'} — so one
	// drag seam serves the whole shelf.
	const [assetDrag, setAssetDrag] = useState(null);

	function beginAssetDrag(payload, event) {
		const start = { x: event.clientX, y: event.clientY };
		setAssetDrag({ payload, x: start.x, y: start.y });
		const onMove = (move) => setAssetDrag((drag) => (drag ? { ...drag, x: move.clientX, y: move.clientY } : drag));
		const onUp = (up) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			setAssetDrag(null);
			const host = mainPaneRef.current;
			const cam = (lookThroughShot ? shotCamRef : editorCamRef).current;
			if (!host || !cam) return;
			const rect = host.getBoundingClientRect();
			if (up.clientX < rect.left || up.clientX > rect.right || up.clientY < rect.top || up.clientY > rect.bottom) return;
			const pointer = new THREE.Vector2(
				((up.clientX - rect.left) / rect.width) * 2 - 1,
				-((up.clientY - rect.top) / rect.height) * 2 + 1,
			);
			const raycaster = new THREE.Raycaster();
			raycaster.setFromCamera(pointer, cam);
			const hit = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
			// Dispatch on the payload kind (asset-drop.js): same ray, one spawner per kind.
			dropAssetAt(payload, hit, { spawnCharacter, addSceneObject, spawnCutoutAt, spawnMeshAt, runStudioAction, select: setSelectedHierarchyId });
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	const motionDomain = useMotion(appContext.forRender({
		get attachFrameRef() { return attachFrameRef; },
		
		get activeChar() { return activeChar; },
		get activeCharIndex() { return activeCharIndex; },
		get activeRig() { return activeRig; },
		
		get bufferRef() { return bufferRef; },
		get cameraPreviewEndRef() { return cameraPreviewEndRef; },
		get castDomain() { return castDomain; },
		get castMemberOf() { return castMemberOf; },
		get charA() { return charA; },
		get characters() { return characters; },
		get fovDeg() { return fovDeg; },
		get frameCountRef() { return frameCountRef; },
		get ikBodyDragRef() { return ikBodyDragRef; },
		get ikFrames() { return ikFrames; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get look() { return look; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motionFullRef() { return motionFullRef; },
		get poseMemberAtFrame() { return poseMemberAtFrame; },
		get posedRig() { return posedRig; },
		// Pose mode enters from the view the author is looking through (motion.js toggleIkMode).
		get poserCamRef() { return poserCamRef; }, get editorCamRef() { return editorCamRef; }, get editorLook() { return editorLook; },
		get poserLook() { return poserLook; },
		get posing() { return posing; },
		get posingChar() { return posingChar; },
		
		
		get publishStudioCharacters() { return publishStudioCharacters; },
		
		
		
		get rigs() { return rigs; },
		get rowIdForCharIndex() { return rowIdForCharIndex; },
		get runStudioAction() { return runStudioAction; },
		get sceneObjects() { return sceneObjects; },
		get selectActiveCharacterInHierarchy() { return selectActiveCharacterInHierarchy; },
		get setProjectManifest() { return setProjectManifest; },
		
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setTlFps() { return setTlFps; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get setTlPlaying() { return setTlPlaying; },
		get shot() { return shot; },
		get shotCamRef() { return shotCamRef; },
		get tlFps() { return tlFps; },
		get tlFrame() { return tlFrame; },
		get tlFrameCount() { return tlFrameCount; },
		get tlFrameRef() { return tlFrameRef; },
		get propFrameRef() { return propFrameRef; },
		
		
		get waitForRig() { return waitForRig; },
		get waypointMode() { return waypointMode; },
		get waypoints() { return waypoints; },
		get captureCurrentFraming() { return captureCurrentFraming; },
		get enterShotLook() { return enterShotLook; },
		get captureLiveFraming() { return liveQueries.capture_framing_png; },
		get lookThroughShot() { return lookThroughShot; },
		
		get readStudioState() { return readStudioState; },
		get restoreExportRig() { return restoreExportRig; },
		get setCameraPos() { return setCameraPos; },
		get setFovDeg() { return setFovDeg; },
		get setResult() { return setResult; },
		get setResultOpen() { return setResultOpen; },
		get setWaypoints() { return setWaypoints; },
		get shotCameraPosRef() { return shotCameraPosRef; },
		get snapshotExportRig() { return snapshotExportRig; },
	}));
	const {
		ikMode, ikChains, setIkChains, ikFkJoints, setIkFkJoints, ikFocus, setIkFocus, footSnap, setFootSnap,
		bodyContact, setBodyContact, IK_CORRECTION_BLEND_FRAMES,
		ikTick, setIkTick, committedIkEdits, setCommittedIkEdits, ikEditTool, setIkEditTool, focusIkHandle, snapshotIkKeys,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		rangePins, rangePinResiduals, rangePinSelection, setRangePinSelection, rangePinPartPick, setRangePinPartPick, rangePinPreview, previewRangePinDraft, applyRangePinDraft, deleteRangePin,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys,
		motion,
		advanceFrame, stepFrame,
		leaveIkMode, clearMotion, poseOtherCastMembers, toggleIkMode, ikSolve,
		ikDragEnd, ikAddKeyframe, autoKey, setAutoKey,
		ikDeleteKeyframe, ikMoveKeyframe, ikApplyPoseAsKey,
	} = motionDomain;
	const { handFingers, fingerEditing, setFingerEdit, exposureProbeRef: fingerExposureRef } = useFingerEdit(ikFocus, ikFkJoints);
	const [partColoursEnabled, setPartColoursEnabled] = useState(false);
	const [partColoursMode, setPartColoursMode] = useState("shaded");

	const [selectedHierarchyId, setSelectedHierarchyId] = useState("characterA");
	// The studio is easier to read when the operator chooses a department first.
	// Keep the underlying selection model intact, but use this small workflow
	// state to surface only the tools that belong to the current job.
	const [workflowMode, setWorkflowMode] = useState("scene");
	const [poseObjectOpacity, setPoseObjectOpacityState] = useState(readPoseFadeOpacity);
	const setPoseObjectOpacity = (value) => { setPoseObjectOpacityState(value); writePoseFadeOpacity(value); };
	// Pose mode IS IK editing (#521): with no rig to solve there is nothing to
	// pose, so the mode refuses with the reason instead of opening empty.
	// A capsule figure has no rig at all, so it gets its own reason rather than
	// the "load a character" one, which would read as a loading problem.
	const activeCapabilities = characterCapabilities(activeChar);
	const poseRefusal = !activeCapabilities.pose ? kindRefusal("pose", isKo, isZh) : ikChains ? null : ko("Load a character to pose it — Pose mode edits its rig with IK", "캐릭터를 불러와야 포즈를 잡을 수 있어요 — 포즈 모드는 IK로 리그를 편집합니다", "加载角色后才能摆姿势 — 姿势模式用 IK 编辑其骨骼");
	// False when the mode refuses (its reason shows as a toast): the 1-5 keys report that as shortcut:ignored.
	function selectWorkflowMode(next) {
		if (next === "pose" && poseRefusal) {
			setToast(poseRefusal);
			return false;
		}
		// A storyboard is stills: there is no Motion department to open.
		if (next === "motion" && storyboardProject) {
			setToast(ko(STORYBOARD_MOTION_REFUSAL.en, STORYBOARD_MOTION_REFUSAL.ko, STORYBOARD_MOTION_REFUSAL.zh));
			return false;
		}
		setWorkflowMode(next);
		// A user's switch (tab, key, a shot or camera pick) toward nav:thrash; the agent's view.setMode does not come here.
		if (next !== workflowMode) noteNavSwitch("mode");
		// Picking a department leaves the chrome-free player. Shot-look is
		// camera work, so it only yields when the operator leaves Camera.
		if (preview) exitPreview();
		else if (lookThroughShot && next !== "camera") exitPreview();
		if (next === "camera") setSelectedHierarchyId("camera");
		// The active character's ROW, not the group: the placement gizmo only
		// renders for a specific cast member, so selecting the group used to
		// drop the operator into Motion with nothing to drag.
		else if (next === "motion") setSelectedHierarchyId(rowIdForCharIndex(activeCharIndex));
		// Pose lands on the active character's rig: its Rig Control panel holds
		// the IK tools that W/E/R switch between.
		else if (next === "pose") setSelectedHierarchyId(`${rowIdForCharIndex(activeCharIndex)}.rig`);
		// Sculpt keeps the selection: a selected sculpt is the one it opens on.
		else if (next !== "sculpt") setSelectedHierarchyId("shot");
	}
	// Every door into the mode (tab, 1-4 keys, view.setMode on the bus) moves
	// IK with it through the motion domain's own entry/exit path...
	useEffect(() => {
		if ((workflowMode === "pose") !== ikMode) toggleIkMode();
	}, [workflowMode]);
	// ...and whatever else ends IK (a take starting playback, the rig going
	// away) hands the operator back to Motion instead of a dead Pose mode.
	useEffect(() => {
		if (!ikMode && workflowMode === "pose") setWorkflowMode(storyboardProject ? "scene" : "motion");
	}, [ikMode]);

	const toggleHierarchyHidden = (hierarchyId) => {
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (objectId) {
			const object = sceneObjects.find((item) => item.id === objectId);
			if (!object) return;
			changeSceneObject(objectId, { hidden: object.hidden !== true });
			return;
		}
		const charId = charIdFromHierarchyId(hierarchyId);
		if (!charId) return;
		castDomain.toggleCharacterHidden(charId);
	};

	useEffect(() => {
		// A rig node id resolves through its row (#76): selecting any bone
		// activates the body it belongs to, so IK and the timeline buffer
		// follow the character the user is pointing at.
		const id = charIdFromHierarchyId(selectedHierarchyId)
			?? charIdFromHierarchyId(parseRigNodeId(selectedHierarchyId)?.rowId);
		if (id && characters.some((entry) => entry.id === id)) setActiveCharacterId(id);
	}, [selectedHierarchyId, characters]);

	// Right-sidebar tab. "inspector" shows the selection's properties; "shot"
	// holds shot-global settings (type presets, prompt); "motion" holds the
	// ARDY workflow in pipeline order. Selecting anything in the scene routes
	// to the inspector tab; the root SHOT row routes to the shot tab.
	const [inspectorActionsOpen, setInspectorActionsOpen] = useState(false);

	const objectsDomain = useObjects(appContext.forRender({
		get animatedSceneObjects() { return animatedSceneObjects; }, get attachFrameRef() { return attachFrameRef; },
		get castMemberOf() { return castMemberOf; },
		get charIdFromHierarchyId() { return charIdFromHierarchyId; },
		get characters() { return characters; },
		get editorCamRef() { return editorCamRef; },
		get editorLook() { return editorLook; },
		get frameWorldTarget() { return frameWorldTarget; },
		get look() { return look; },
		get lookThroughShot() { return lookThroughShot; },
		get markCraftAction() { return markCraftAction; },
		get markSemanticEdit() { return markSemanticEdit; },
		get matteEditorRef() { return matteEditorRef; },
		get propWorldRef() { return propWorldRef; },
		get selectedHierarchyId() { return selectedHierarchyId; },
		get setInspectorActionsOpen() { return setInspectorActionsOpen; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get shotCamRef() { return shotCamRef; },
		get startupScene() { return startupScene; },
		get runStudioAction() { return runStudioAction; },
		get studioHistoryRef() { return studioHistoryRef; },
	}));
	const {
		recentObjectColors, objectColorDraft, setObjectColorDraft, rememberSceneObjectColor, objectDeleteUndo,
		setObjectDeleteUndo, sceneObjects, storeRef, store, selectedSceneObjectId, selectedSceneObject,
		beginSceneTransaction, endSceneTransaction, changeSceneObject, deleteSelectedSceneObject,
		deleteSceneObject, dropSelectedSceneObject, matteTolerance, setMatteTolerance, matteBrush, setMatteBrush,
		matteShrink, setMatteShrink, matteFeather, setMatteFeather, matteMode, setMatteMode, matteStats,
		setMatteStats, matteBusy, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled, addSceneObject,
		importCutout, importCutouts, spawnCutoutAt, persistMeshAsset, importMesh, importMeshes, spawnMeshAt,
		applyMatte, duplicateSelectedSceneObject, frameSelection, groupObjectUnderNewEmpty, renameRequest, renameSceneObject, sceneObjectWorldMatrix,
		attachTargetForRow, attachTargetLabel, attachSceneObject,
	} = objectsDomain;

	const { sculptMode, sculptCamRef, sculptView, sculptReference, setSculptReference, sculptRun, setSculptRun, sculptRunRef, sculptAgentStatus, sculptChatgpt, sculptModels, sculptModelPick, chooseSculptModel, sculptTransport, sculptTap, sculptTarget, setSculptTargetId, requestSculptView, sculptBlueprint, setSculptBlueprint, generateSculptBlueprint, cancelSculptBlueprint, sculptParts } = useSculptMode({ workflowMode, sceneObjects, selectedSceneObjectId, appContext });
	async function chooseSculptReference(file) {
		try {
			// A new reference makes the old sheet a drawing of something else.
			cancelSculptBlueprint();
			setSculptBlueprint((current) => ({ ...current, state: "idle", sheet: null, error: null }));
			setSculptReference(await objectsDomain.storeSculptReference(file));
		} catch (error) {
			setToast(ko(`Could not read that image: ${error.message}`, `이미지를 읽지 못했어요: ${error.message}`, `无法读取该图片：${error.message}`));
		}
	}
	function startSculptRun() {
		if (!sculptReference) return;
		sculptRunRef.current?.cancel();
		const run = createSculptRun({
			bus: { subscribe: (listener) => sculptTap.subscribe(listener, studioBindingRef.current?.bus) },
			agent: createAgentPort(sculptAgentClient(sculptTransport, () => buildStudioAgentContext())),
			reference: sculptReference,
			// The blueprint's side and back crops, when a sheet was drawn (#970).
			views: blueprintRunViews(sculptBlueprint.sheet),
			sculptId: sculptTarget?.id ?? null,
			score: (args) => appContext.bus.run("sculpt.compare", args, { origin: "ui" }),
			measure: async (reference) => measureReferenceOutline(await browserSculptImages.decode(reference)),
			model: sculptModelPick.model || undefined,
			effort: sculptModelPick.effort || undefined,
			modelLabel: sculptModelLabel(sculptModels, sculptModelPick.model) || undefined,
		});
		sculptRunRef.current = run;
		let shownId = sculptTarget?.id ?? null;
		const hadTarget = Boolean(sculptTarget);
		let reported = false;
		run.subscribe((state) => {
			// Before the current-run gate: a run replaced by a new Start still ends (cancelled) once.
			const telemetry = reported ? null : sculptRunTelemetry(state, { hadTarget });
			if (telemetry) { reported = true; track("sculpt_run", telemetry); }
			// A finished run's bus listener outlives it; only the current run speaks.
			if (sculptRunRef.current !== run) return;
			setSculptRun(state);
			if (state.sculptId && state.sculptId !== shownId) {
				shownId = state.sculptId;
				setSculptTargetId(state.sculptId);
				setSelectedHierarchyId(`object:${state.sculptId}`);
			}
		});
		setSculptRun(run.getState());
		void run.start();
	}
	/** Place in scene: on the ground in front of the scene camera, selected,
	 * back on Stage. The move is one object.update, so one undo. */
	function placeSculptInScene() {
		if (!sculptTarget) return;
		try {
			selectWorkflowMode("scene");
			objectsDomain.placeSculptInScene(sculptTarget.id);
		} catch (error) {
			if (!(error instanceof StudioProtocolError)) throw error;
			setToast(error.uiMessage ?? error.message);
		}
	}

	// The record whose route the studio shows for the selection: the selected
	// record itself, or the routed record inside the group it stands for (a car
	// Empty over its Chassis). Selection stays on the group; only the route's
	// source moves. With no route anywhere a new stroke lands on the selection.
	const routeOwner = useMemo(() => routeOwnerFor(sceneObjects, selectedSceneObjectId), [sceneObjects, selectedSceneObjectId]);
	const pathTarget = routeOwner ?? selectedSceneObject;

	// An undo offer is an offer, not a banner: without a window it sits on the
	// screen for the rest of the session. Long enough to notice and reach, then
	// gone — the deletion is still reversible through Undo history afterwards.
	useEffect(() => {
		if (!objectDeleteUndo) return undefined;
		const timer = setTimeout(() => setObjectDeleteUndo(null), OBJECT_DELETE_UNDO_MS);
		return () => clearTimeout(timer);
	}, [objectDeleteUndo]);

	const scenesDomain = useScenes(appContext.forRender({
		get activeSceneIdRef() { return activeSceneIdRef; },
		get actorStageRef() { return actorStageRef; },
		get customPoses() { return customPoses; },
		get dirtyRef() { return dirtyRef; },
		get exportShotIdRef() { return exportShotIdRef; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get manualCameraOverrideRef() { return manualCameraOverrideRef; },
		get markSemanticEdit() { return markSemanticEdit; },
		
		get motionFullRef() { return motionFullRef; },
		get playgroundMode() { return playgroundMode; },
		get projectHandleRef() { return projectHandleRef; },
		
		get projectSnapshotRef() { return projectSnapshotRef; },
		get projectStateRef() { return projectStateRef; },
		
		get runStudioAction() { return runStudioAction; },
		get saveBlockedRef() { return saveBlockedRef; },
		get saveFailureToastRef() { return saveFailureToastRef; },
		get setActiveCharacterId() { return setActiveCharacterId; },
		get setActiveWaypointId() { return setActiveWaypointId; },
		get setFirstSuccessGuideOpen() { return setFirstSuccessGuideOpen; },
		get setHasCharSheet() { return setHasCharSheet; },
		get setMovePlaying() { return setMovePlaying; },
		get setPendingWaypointFrame() { return setPendingWaypointFrame; },
		
		get setRailDraw() { return setRailDraw; },
		get setRigMountEpoch() { return setRigMountEpoch; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		
		get setShots() { return setShots; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get setWaypoints() { return setWaypoints; },
		get setWorkspaceLayout() { return setWorkspaceLayout; },
		get shotDocumentRef() { return shotDocumentRef; },
		get shots() { return shots; },
		get stageDomain() { return stageDomain; },
		get startup() { return startup; },
		get storeRef() { return storeRef; },
		get studioDocumentEpochRef() { return studioDocumentEpochRef; },
		get studioHistoryRef() { return studioHistoryRef; },
		get studioSceneEpochRef() { return studioSceneEpochRef; },
		get castDomain() { return castDomain; },
		get objectsDomain() { return objectsDomain; },
	}));
	const {
		scenes, activeSceneId, sceneSaveError, snapshotActiveScene, persistScenes, projectName, previsMode, projectDirty,
		setProjectDirty, projectSaveState, setProjectSaveState, projectMenuOpen, setProjectMenuOpen,
		projectBrowserOpen, setProjectBrowserOpen, projectNameDialog, setProjectNameDialog, projectStartupOpen,
		setProjectStartupOpen, projectManifest, setProjectManifest, saveBlockedReasons, setSaveBlockedReasons,
		workflowRevision, setWorkflowRevision, collectProjectSnapshot, collectProjectSerialized,
		projectProblemsNotice, rehydrateProjectAssets, saveProject, applyProject, openStarterScene, openProject,
		openProjectByHandle, requestNewProject, newProject, restoreOffer, setRestoreOffer, restoreStoredProject,
		flushScenes, openScene, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi,
		renameSceneDocumentFromUi, deleteSceneDocumentFromUi, switchSceneDocument, addSceneDocument,
		duplicateSceneDocument, renameSceneDocument, deleteSceneDocument,
	} = scenesDomain;
	// A sculpt run belongs to Sculpt mode and the scene it started in: leaving
	// either cancels it, so no paid turn runs unseen and nothing reselects.
	useEffect(() => {
		if (!sculptMode) sculptRunRef.current?.cancel();
	}, [sculptMode]);
	useEffect(() => () => sculptRunRef.current?.cancel(), [activeSceneId]);
	// A storyboard project has no Motion department: a project opened while
	// Motion was up lands on Stage instead.
	const storyboardProject = scenesDomain.previsMode === "storyboard";
	useEffect(() => {
		if (storyboardProject && workflowMode === "motion") setWorkflowMode("scene");
	}, [storyboardProject, workflowMode]);

	const saveBlockedRef = useRef(startup.saveBlocked);
	const dirtyRef = useRef(false);
	// One-shot save-failure toast: the persistent line stays for the session,
	// the toast fires once per failure episode (not on every failed tick).
	const saveFailureToastRef = useRef(false);

	const ikBodyDragRef = useRef(false); // true while a body drag is active

	const ikStateRef = useRef(createIkState());

	// Sorted full-body key frames for the timeline markers. Derived from the
	// ref state; ikTick re-derives after every key add/remove.
	const ikFrames = useMemo(() => ikKeyframes(ikStateRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ikTick]);

	 

	function selectHierarchy(id) {
		// A selection switch is the user starting something else: settle any open
		// drag so its applied travel becomes one committed entry first (plan §6.3).
		// This MUST stay inside the handler, never in the render body: a settle
		// during render runs the producer's cancel teardown, and since the first
		// applied tick re-renders, every drag would die after exactly one tick.
		// Resolve the live store at event time: opening a scene replaces the
		// coordinator in storeRef before the next hierarchy click, while a
		// render-captured store can still settle the scene that was left.
		objectsDomain.settleObjects();
		setSelectedHierarchyId(id);
		// Selecting the camera IS the request to frame a shot (#193). The camera
		// bar owns FOV/Recenter/presets and is CSS-gated to Camera mode, so a
		// camera picked from Scene mode would otherwise select a subject whose
		// controls are all hidden. selectWorkflowMode re-selects the camera
		// itself, so this cannot bounce back here.
		if (id === "camera" && workflowMode !== "camera") selectWorkflowMode("camera");
		// Moving the focus anywhere but the camera releases the crane dot too:
		// a press on the floor or the sky must not leave a mark selected.
		if (id !== "camera") setCraneSelectedIndex(null);
		const focus = RIG_HIERARCHY_FOCUS[parseRigNodeId(id)?.token];
		if (focus && ikMode) setIkFocus(focus);
	}

	/** The hidden file inputs behind the Props import buttons. */
	const cutoutInputRef = useRef(null);
	const meshInputRef = useRef(null);
	// One drop zone shared by every surface that accepts a picture: the Props
	// branch of the hierarchy, the Props inspector, and the shot view itself.
	// One per surface, so only the thing under the cursor lights up.
	// Paste is the path to a picture on the web: "Copy image" hands over bytes,
	// while dragging one hands over a cross-origin URL the matte could never read
	// back. Bound to the document because there is no one field to focus first —
	// the gesture is "paste into the studio", not "paste into this box".
	useEffect(() => {
		const onPaste = (event) => {
			// The Agent composer takes a picture pasted anywhere on it first.
			if (event.defaultPrevented) return;
			const target = event.target;
			// Never steal a paste aimed at somewhere text goes.
			if (target instanceof HTMLElement) {
				if (target.isContentEditable) return;
				if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
			}
			const files = imageFilesFromClipboard(event.clipboardData);
			if (!files.length) {
				// A clipboard that carried a file but no supported image (HEIC is
				// the mainline iPhone case) gets a named rejection, not silence.
				const carriedFile = Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === "file");
				if (carriedFile) setToast(ko("That picture format is not supported — use PNG, JPG, WebP or GIF", "지원하지 않는 사진 형식이에요 — PNG, JPG, WebP, GIF만 가능해요"));
				return;
			}
			event.preventDefault();
			importCutouts(files);
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const rejectUnsupportedDrop = (count) => setToast(ko(
		`${count} file${count > 1 ? "s" : ""} not supported — use PNG, JPG, WebP, GIF or a .glb / .obj / .fbx (iPhone HEIC photos need converting first)`,
		`지원하지 않는 파일 ${count}개 — PNG, JPG, WebP, GIF 또는 .glb / .obj / .fbx만 가능해요 (아이폰 HEIC 사진은 먼저 변환해 주세요)`, `不支持 ${count} 个文件 — 请使用 PNG、JPG、WebP、GIF 或 .glb / .obj / .fbx（iPhone HEIC 照片需先转换）`,
	));
	const stageDrop = {
		onImages: (files) => importCutouts(files),
		onMeshes: (files) => importMeshes(files),
	};
	const propsDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });
	const inspectorDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });
	const viewportDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });

	const matteCanvasRef = useRef(null);
	const matteEditorRef = useRef(null);
	// The editor always works on the photograph, never on the cut picture the
	// set renders — that is what makes a cut re-editable rather than a one-way
	// door. The saved purple comes back with it.
	const matteSourceId = selectedSceneObject?.renderer === CUTOUT_KIND
		? selectedSceneObject.sourceAssetId || selectedSceneObject.assetId
		: null;
	const matteSelectionId = selectedSceneObject?.renderer === CUTOUT_KIND ? selectedSceneObject.matteAssetId || "" : "";

	useEffect(() => {
		const canvas = matteCanvasRef.current;
		if (!canvas || !matteSourceId) return undefined;
		const editor = createMatteEditor(canvas, { onChange: setMatteStats });
		matteEditorRef.current = editor;
		editor.setTolerance(matteTolerance);
		editor.setMode(matteMode);
		let cancelled = false;
		(async () => {
			const asset = await assetRecord(matteSourceId);
			if (!asset || cancelled) return;
			await editor.load(asset);
			if (cancelled || !matteSelectionId) return;
			const stored = await assetRecord(matteSelectionId);
			if (!stored || cancelled) return;
			const { mask, width, height } = await decodeMask(stored);
			if (!cancelled) editor.setMask(mask, width, height);
		})().catch(() => setMatteStats({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false }));
		return () => {
			cancelled = true;
			editor.dispose();
			if (matteEditorRef.current === editor) matteEditorRef.current = null;
		};
		// Tolerance and mode are pushed by their own handlers below; re-running
		// this effect for them would throw away the selection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [matteSourceId, matteSelectionId]);

	// True while the right mouse button is flying the camera. Tool hotkeys stand
	// down during a flythrough, because W/A/S/D belong to the camera then.
	const flyingRef = useRef(false);

	/** Frame the selection: fly the shot camera to a comfortable distance along
	 * the current view direction, the way Unity's F key does. Defaults to the
	 * selection; the hierarchy context menu passes a specific row's id. */
	/** Dolly-and-aim onto a world point. The editor camera glides; the shot
	 * camera (look-through) still cuts, because reframing the RECORDING lens
	 * is a deliberate act, not a tour. */
	function frameWorldTarget(target, reach) {
		const camera = (lookThroughShot ? shotCamRef : editorCamRef).current;
		const paneLook = lookThroughShot ? look : editorLook;
		if (!camera) return;
		const distance = reach * 2.4 + 0.6;
		const back = forwardFrom(paneLook.current.yaw, paneLook.current.pitch).multiplyScalar(-distance);
		const position = {
			x: target.x + back.x,
			y: Math.max(target.y + back.y, 0.3),
			z: target.z + back.z,
		};
		if (!lookThroughShot) {
			setCamGlide({ position, target });
			return;
		}
		camera.position.set(position.x, position.y, position.z);
		const angles = aimAt(camera.position, target);
		paneLook.current.yaw = angles.yaw;
		paneLook.current.pitch = angles.pitch;
		camera.rotation.order = "YXZ";
		camera.rotation.set(angles.pitch, angles.yaw, 0);
	}

	function wholeSceneFrame() {
		const rows = [
			...characters.map(entry => ({ x: entry.x, y: (entry.y ?? 0) + 0.9 * (entry.scale ?? 1), z: entry.z, radius: entry.scale ?? 1 })),
			...sceneObjects.filter(entry => !isEffectivelyHidden(entry, sceneObjects, characters)).map(entry => ({ x: entry.x, y: (entry.y ?? 0) + (entry.height ?? 1) / 2, z: entry.z,
				radius: Math.max(entry.height ?? 1, entry.footprint?.width ?? 1, entry.footprint?.depth ?? 1) / 2 })),
		];
		if (!rows.length) return { target: { x: 0, y: 1, z: 0 }, radius: 2 };
		const target = rows.reduce((sum, row) => ({ x: sum.x + row.x / rows.length, y: sum.y + row.y / rows.length, z: sum.z + row.z / rows.length }), { x: 0, y: 0, z: 0 });
		const radius = Math.max(1, ...rows.map(row => Math.hypot(row.x - target.x, row.y - target.y, row.z - target.z) + row.radius));
		return { target, radius };
	}
	function frameAll() { const { target, radius } = wholeSceneFrame(); frameWorldTarget(target, radius); }
	function setAxisView(axis) {
		const { target, radius } = wholeSceneFrame(), distance = radius * 2.4 + 0.6;
		const offsets = { front: { x: 0, y: radius * 0.2, z: distance }, side: { x: distance, y: radius * 0.2, z: 0 }, top: { x: 0, y: distance, z: 0.001 } };
		const offset = offsets[axis];
		if (!offset || lookThroughShot || ikMode) return;
		setCamGlide({ position: { x: target.x + offset.x, y: Math.max(0.3, target.y + offset.y), z: target.z + offset.z }, target });
	}
	// Viewport/plan camera framing would otherwise push an entry per pointermove.
	const framingSessionRef = useRef(null);
	// A colour picker streams values for as long as its dialog is open.
	const tintSessionRef = useRef(null);
	/* One Ctrl+Z entry per GESTURE for the surfaces that write cast-snapshot
	 * state without a store transaction of their own: the key light (foldout
	 * sliders, sun puck, move gizmo) and the character Transform rows. Every
	 * tick of a drag or a scrub reopens the same session while its entry is
	 * still the newest one, and the pointer/key release below closes it, so the
	 * next gesture starts a fresh entry instead of extending the last one. */
	const gestureUndoRef = useRef(null);
	function beginGestureUndo(key) {
		// NumberField hands this token back on every tick of a scrub. These edits
		// are not store transactions, so the scrub runs with a null token.
		return null;
	}
	function endGestureUndo() {
		stageDomain.finishGesture();
		gestureUndoRef.current = null;
	}
	useEffect(() => {
		const end = () => endGestureUndo();
		window.addEventListener("pointerup", end, true);
		window.addEventListener("pointercancel", end, true);
		window.addEventListener("keyup", end, true);
		return () => {
			window.removeEventListener("pointerup", end, true);
			window.removeEventListener("pointercancel", end, true);
			window.removeEventListener("keyup", end, true);
		};
	}, []);

	/** True while a framing capture for `shotId` is the newest history entry. */
	function framingSessionOpen(shotId) {
		return Boolean(framingSessionRef.current)
			&& framingSessionRef.current.key === `framing:${shotId}`
			&& appContext.historyEntry() === framingSessionRef.current.historyEntryId;
	}

	function undoObjectDeletion() {
		if (!objectDeleteUndo) return;
		if (store.depths().past !== objectDeleteUndo.pastDepth) {
			setObjectDeleteUndo(null);
			setToast(ko("A newer edit comes after this deletion. Use Undo history instead.", "삭제 이후의 편집이 있어요. 실행 취소 기록을 사용해 주세요."));
			return;
		}
		undoScene("button");
	}

	useEffect(() => {
		const onKeyDown = (event) => {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target instanceof HTMLSelectElement ||
				target?.isContentEditable
			) return;
			// While the right button is flying the camera, W/A/S/D/Q/E are the
			// camera's; a tool switch mid-flight would be a surprise.
			if (flyingRef.current) return;
			// Undo/redo (plan §6.5). The input guard above keeps Ctrl/Cmd+Z in
			// the Name field or the ARDY prompt as the browser's text undo.
			// Placed before the selection gate: undo works with nothing
			// selected, and mid-drag the store's settle commits then steps.
			if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				// Nothing to undo or redo, or a refused undo, is shortcut:ignored: the bus receipt says which.
				if (event.shiftKey) noteHistoryKey("redo", redoScene()); else noteHistoryKey("undo", undoScene("key"));
				return;
			}
			// 1-4 pick the workflow mode; pose is refused (with its reason) when
			// there is no rig to solve. The embedded player has no modes to pick.
			const modeKey = { Digit1: "scene", Digit2: "pose", Digit3: "camera", Digit4: "motion", Digit5: "sculpt" }[event.code];
			if (modeKey && !embedMode && !event.ctrlKey && !event.metaKey && !event.altKey) {
				// A storyboard has no key 4: it does nothing, not even a refusal.
				if (modeKey === "motion" && storyboardProject) return;
				event.preventDefault();
				if (modeKey !== workflowMode && selectWorkflowMode(modeKey) === false) noteShortcutIgnored("mode", "workflow_mode");
				return;
			}
			// Sculpt mode's W/E/R swing the turntable to front, side and back, or drive a selected part's gizmo.
			if (workflowMode === "sculpt" && GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				sculptParts.onKey(event.code);
				return;
			}
			// Pose mode's W/R are the IK tools, gated like their Rig Control
			// buttons: the range pin needs a take.
			if (workflowMode === "pose" && GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				// E has no IK tool: a pose-mode E does nothing (shortcut:ignored).
				if (event.code === "KeyW") setIkEditTool("ik");
				else if (event.code === "KeyR" && motion) { setIkEditTool("pin"); setRangePinPartPick(null); } else if (event.code === "KeyE") noteShortcutIgnored("transform", "wrong_mode");
				return;
			}
			if (GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				setGizmoMode(GIZMO_HOTKEYS[event.code]);
				return;
			}
			if (event.code === "Home") {
				event.preventDefault(); frameAll(); return;
			}
			if (event.code === "KeyF") {
				// Frame whatever is selected — Unity's F, not just for props: the
				// sun and the cast are selections the eye wants to travel to too.
				if (selectedSceneObjectId) {
					event.preventDefault();
					frameSelection();
					return;
				}
				if (selectedHierarchyId === "light") {
					event.preventDefault();
					frameWorldTarget({ x: keyLight.x, y: keyLight.y, z: keyLight.z }, 0.8);
					return;
				}
				// Rig node ids carry their row (#76), so `characterB.rig.head`
				// frames character B — startsWith on the row prefix covers both
				// the character row and every rig node under it.
				const framedChar = selectedHierarchyId.startsWith("characterB") ? (showB ? charB : null)
					: selectedHierarchyId.startsWith("characterA") ? charA
					: selectedHierarchyId.startsWith("character:") ? (() => {
						const rowId = parseRigNodeId(selectedHierarchyId)?.rowId ?? selectedHierarchyId;
						return characters.find((entry) => `character:${entry.id}` === rowId) ?? null;
					})()
					: null;
				if (framedChar) {
					event.preventDefault();
					frameWorldTarget({ x: framedChar.x, y: 1, z: framedChar.z }, 1.8);
					return;
				}
			}
			if (event.code === "KeyD" && (event.ctrlKey || event.metaKey) && selectedSceneObjectId) {
				event.preventDefault();
				runStudioAction("object.duplicate");
				return;
			}
			if (event.key === "Escape" && selectedSceneObjectId && !event.defaultPrevented) {
				setSelectedHierarchyId("props");
				return;
			}
			if (event.code === "End" && selectedSceneObjectId) {
				event.preventDefault();
				dropSelectedSceneObject();
				return;
			}
			// F, Ctrl/Cmd+D and Delete with nothing to act on reach here: shortcut:ignored, no_selection.
			if (!selectedSceneObjectId) return noteUnselectedKey(event);
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			// A selected path point owns Delete: the route's handles are the
			// finer target, and deleting the whole prop out from under a point
			// edit is never what the press meant.
			if (pathPointIndex != null) return;
			event.preventDefault();
			deleteSelectedSceneObject();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	// Deps are identities, not the entry objects: charA/charB are rebuilt as
	// fresh fallback objects on EVERY render when the cast is short (748-749),
	// so depending on the objects fired this on each render and the actions
	// menu closed the instant it opened.
	useEffect(() => {
		setInspectorActionsOpen(false);
	}, [selectedSceneObjectId, selectedHierarchyId, charA.id, charB.id, showB]);
	// A point index belongs to one object's route; carrying it to the next
	// selection would point the gizmo at a stale dot.
	useEffect(() => {
		setPathPointIndex(null);
	}, [selectedSceneObjectId, routeOwner?.id]);

	useEffect(() => {
		if (!inspectorActionsOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".inspector-actions-wrap")) return;
			setInspectorActionsOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") setInspectorActionsOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [inspectorActionsOpen]);

	const [mode, setMode] = useState("image");
	const [imageModel, setImageModel] = useState("gpt_image_2");

	// Object travel-path drawing: the same Top-View stroke gesture as the rail,
	// aimed at the selected object instead of the shot camera.
	const [pathDraw, setPathDraw] = useState(false);
	// Root-path (waypoint) authoring and Top-View path drawing are motion
	// tooling; a storyboard never leaves either switched on.
	useEffect(() => {
		if (!storyboardProject) return;
		if (waypointMode) setWaypointMode(false);
		if (pathDraw) setPathDraw(false);
	}, [storyboardProject, waypointMode, pathDraw]);
	const [pathPointIndex, setPathPointIndex] = useState(null);
	const pathDragTokenRef = useRef(null);
	const planPathTokenRef = useRef(null);
	const timingTokenRef = useRef(null);
	// The frame props follow. Live playback keeps it at the playhead; the
	// offscreen export drives it per captured frame without re-rendering.
	const propFrameRef = useRef(0);
	const [cameraPos, setCameraPos] = useState(DEFAULT_CAMERA_POSITION);
	const [subjectVisible, setSubjectVisible] = useState(true);
	const subjectVisibleRef = useRef(true);
	const mcpCaptureRef = useRef(null);
	const liveControlRef = useRef(null);
	const [liveWorkspaceHandle, setLiveWorkspaceHandle] = useState(null);
	const liveWorkspaceHandleRef = useRef(null);
	// One identity per tab, kept in sessionStorage so a reload reconnects as the
	// same workspace instead of orphaning the hub's retained motion outcomes.
	const liveWorkspaceIdRef = useRef("");
	if (!liveWorkspaceIdRef.current) liveWorkspaceIdRef.current = loadLiveWorkspaceId();
	const [result, setResult] = useState(null);
	const [resultOpen, setResultOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [recordedVideoName, setRecordedVideoName] = useState(null);
	const [toast, showToast] = useState(startup.toast ?? "");
	// While a Studio action runs editor work, the toasts it shows are collected
	// so run_action can give the agent the reason the user was shown.
	const toastSinkRef = useRef(new Set());
	const setToast = useCallback((value, english) => {
		const toast = resolveStudioToast(value, isKo, ko, isZh);
		if (english !== undefined) toast.message = english;
		if (typeof toast.uiMessage === "string" && toast.uiMessage) for (const sink of toastSinkRef.current) sink(toast);
		showToast(toast.uiMessage);
	}, []);
	// The dots on a route are found by double-clicking the line, a gesture
	// nothing hints at: say it once, the first time a route is selected.
	const routeHintShownRef = useRef(false);
	// The route shown may belong to a routed record inside the selected group.
	const selectedRouteId = routeOwner?.path ? routeOwner.id : null;
	useEffect(() => {
		if (!selectedRouteId || routeHintShownRef.current) return;
		routeHintShownRef.current = true;
		setToast(ko("Double-click the line to add a dot", "선을 더블클릭하면 점이 추가돼요"));
	}, [selectedRouteId, setToast]);
	// The PWA's "a newer studio is waiting" registration, once one arrives.
	const [pwaUpdate, setPwaUpdate] = useState(null);
	useEffect(() => {
		const onUpdate = (event) => setPwaUpdate(event.detail ?? null);
		window.addEventListener(PWA_UPDATE_EVENT, onUpdate);
		return () => window.removeEventListener(PWA_UPDATE_EVENT, onUpdate);
	}, []);
	const [glContextLost, setGlContextLost] = useState(false);
	const webGlAvailable = useWebGlAvailable();



	 // default clip length in seconds; aligned with the recommended 3-5 s block range


	const [bottomTab, setBottomTab] = useState("timeline");
	const { shelfImageIds, setShelfImageIds, shelfMeshIds, setShelfMeshIds, manageAssetStorage, setManageAssetStorage, unusedAssetIds, setUnusedAssetIds, usedAssetIds, setUsedAssetIds, usageCounts, setUsageCounts, assetShelfScanTokenRef, legacyDerivedIdsRef, assetTrash, setAssetTrash, assetUndoOffered, setAssetUndoOffered, deletingAssetId, setDeletingAssetId, cutoutLineage, meshLineage, projectCutoutLineage, projectAssetGraphSignature } = useAssetShelf({ scenes, activeSceneId, sceneObjects });
	useEffect(() => {
		const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
		const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
		const ids = derivedAssetIds(allScenes);
		for (const id of ids) legacyDerivedIdsRef.current.add(id);
		if (ids.size === 0) return;
		let db = null;
		async function backfillLegacyAssetRoles() {
			try {
				db = await openAssetDb();
				for (const id of ids) {
					const record = await getAsset(db, id);
					if (!record || record.role === "derived") continue;
					await putAsset(db, { ...record, role: "derived" });
				}
			} catch (error) {
				console.warn("Could not backfill legacy asset roles", error);
			} finally {
				db?.close?.();
			}
		}
		void backfillLegacyAssetRoles();
	}, [projectCutoutLineage]);
	async function refreshAssetShelf(isAlive = () => true) {
		const scanToken = ++assetShelfScanTokenRef.current;
		const current = () => isAlive() && scanToken === assetShelfScanTokenRef.current;
		let db = null;
		try {
			db = await openAssetDb();
			const stored = await listAssetIds(db);
			const records = await Promise.all(stored.map((id) => getAsset(db, id)));
			const derivedIds = new Set([
				...legacyDerivedIdsRef.current,
				...records.filter((record) => record?.role === "derived").map((record) => record.id),
			]);
			// The active scene's live objects override its saved snapshot. That
			// includes an unsaved matte or cutout edit in the reachability closure.
			const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
			const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
			const latestUsageCounts = assetUsageCounts(allScenes);
			const latestUsedAssetIds = stored.filter((id) => latestUsageCounts.has(id));
			if (!current()) return;
			const sourceIds = sourceAssetIds(stored, allScenes, derivedIds);
			setShelfImageIds(sourceIds.filter(isImageAssetId));
			setShelfMeshIds(sourceIds.filter(isMeshAssetId));
			setUnusedAssetIds(unreachableAssetIds(stored, allScenes));
			setUsedAssetIds(latestUsedAssetIds);
			setUsageCounts(latestUsageCounts);
		} catch {
			// No IndexedDB means no imports can exist either; both honest views are
			// empty rather than presenting an unverifiable deletion target.
			if (current()) {
				setShelfImageIds([]);
				setShelfMeshIds([]);
				setUnusedAssetIds([]);
				setUsedAssetIds([]);
				setUsageCounts(new Map());
			}
		} finally {
			db?.close?.();
		}
	}
	useEffect(() => {
		if (bottomTab !== "assets") return undefined;
		let alive = true;
		void refreshAssetShelf(() => alive);
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bottomTab, scenes, activeSceneId, cutoutLineage, meshLineage]);

	async function deleteUnusedAsset(id, expectedUsageCount, expectedGraphSignature) {
		if (deletingAssetId) return false;
		setDeletingAssetId(id);
		let db = null;
		let deleted = false;
		let graphConflict = false;
		try {
			db = await openAssetDb();
			const stored = await listAssetIds(db);
			const record = await getAsset(db, id);
			if (!record) {
				setToast(ko("That image is no longer in storage", "이 이미지는 이미 저장소에 없습니다"));
				return false;
			}
			// Rebuild this at the destructive boundary rather than trusting the
			// displayed list: a just-created cutout can make its image reachable.
			const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
			const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
			const currentUsageCount = assetUsageCounts(allScenes).get(id) ?? 0;
			const currentGraphSignature = assetGraphSignature(allScenes);
			if (expectedUsageCount !== undefined && (!Number.isInteger(expectedUsageCount) || expectedUsageCount !== currentUsageCount)) {
				setToast(ko("This image's usage changed, so it was not deleted. Please review it again.", "이 이미지의 사용량이 바뀌어서 삭제하지 않았어요. 다시 확인해 주세요."));
				return false;
			}
			if (expectedGraphSignature !== undefined && expectedGraphSignature !== currentGraphSignature) {
				setToast(ko("This image's scene references changed, so it was not deleted. Please review it again.", "이 이미지의 씬 참조가 변경되어 삭제하지 않았어요. 다시 확인해 주세요."));
				return false;
			}
			if (currentUsageCount > 0 && expectedUsageCount === undefined) {
				setToast(ko("That image is used by a scene and was not deleted", "이 이미지는 씬에서 사용 중이어서 삭제하지 않았어요"));
				return false;
			}
			if (currentUsageCount === 0 && !unreachableAssetIds(stored, allScenes).includes(id)) {
				setToast(ko("That image is now used by a scene and was not deleted", "이 이미지는 이제 씬에서 사용 중이어서 삭제하지 않았어요"));
				return false;
			}
			const authorizedGraph = expectedGraphSignature ?? currentGraphSignature;
			const committed = await deleteAssetWithGraphGuard({
				expectedGraphSignature: authorizedGraph,
				deleteRecord: () => deleteAsset(db, id),
				restoreRecord: () => putAsset(db, record),
				readGraphSignature: () => {
					const { scenes: afterScenes, activeSceneId: afterActiveSceneId, sceneObjects: afterObjects } = projectStateRef.current;
					const afterAllScenes = afterScenes.map((scene) => (scene.id === afterActiveSceneId ? { ...scene, objects: afterObjects } : scene));
					return assetGraphSignature(afterAllScenes);
				},
			});
			if (!committed) {
				graphConflict = true;
				setToast(ko("The scene changed while deleting, so the image was kept. Please review storage again.", "삭제하는 동안 씬이 변경되어 이미지를 보존했어요. 저장소를 다시 확인해 주세요."));
				return false;
			}
			evictAssetTexture(id);
			evictMeshScene(id);
			setAssetTrash((current) => [...current.filter((asset) => asset.id !== record.id), record]);
			setAssetUndoOffered(true);
			deleted = true;
			return true;
		} catch (error) {
			setToast(ko(`Could not delete that image — ${error.message}`, `이미지를 삭제하지 못했어요 — ${error.message}`, `无法删除该图片 — ${error.message}`));
			return false;
		} finally {
			db?.close?.();
			if (deleted || graphConflict) await refreshAssetShelf();
			setDeletingAssetId(null);
		}
	}

	async function undoDeletedAsset() {
		const record = assetTrash.at(-1);
		if (!record || deletingAssetId) return;
		setDeletingAssetId(record.id);
		let restored = false;
		try {
			if (isMeshAssetId(record.id) || isSupportedMeshType(record.type)) {
				await persistMeshAsset(record);
			} else {
				await rememberAsset(record);
			}
			setAssetTrash((current) => current.filter((asset) => asset.id !== record.id));
			setAssetUndoOffered(false);
			restored = true;
			setToast(ko(`${record.name || "Image"} restored`, `${record.name || "이미지"} 복원됨`, `${record.name || "图片"}已恢复`));
		} catch (error) {
			setToast(ko(`Could not restore that image — ${error.message}`, `이미지를 복원하지 못했어요 — ${error.message}`, `无法恢复该图片 — ${error.message}`));
		} finally {
			if (restored) await refreshAssetShelf();
			setDeletingAssetId(null);
		}
	}


	const renderActive = useRenderActivity(tlPlaying || movePlaying, { playing: tlPlaying, commit: shotsDomain.commitPlaybackFrame, onStop: () => {
		const position = shotCameraPosRef.current;
		if (position) setCameraPos(position);
		setSubjectVisible(subjectVisibleRef.current);
	} });
	 // the clip length on the production clock

	// Keep the imperative frame in step with the playhead for live playback;
	// the export overwrites it per captured frame and restores nothing, which
	// is correct — the next render puts it back.
	propFrameRef.current = tlFrame;
	// A held object's gizmo drag edits its motion; its live preview rides the take tracks (held-object-edit.jsx).
	const heldEdit = useHeldObjectEdit({ selected: selectedSceneObject, objects: sceneObjects, tracks: objectTracksOf(appContext.storeDomain("motion"), appContext.live.characters), frame: tlFrame, frameCount: tlFrameCount, fps: tlFps, motion: appContext.storeDomain("motion"), run: runStudioAction });
	// Routed records and everything grouped under them (object-travel.js).
	const objectTracks = heldEdit.tracks, animatedSceneObjects = useMemo(
		() => sceneObjectsAt(sceneObjects, tlFrame, { frameCount: tlFrameCount, fps: tlFps, objectTracks }),
		[sceneObjects, tlFrame, tlFrameCount, tlFps, objectTracks],
	);

	// The selection as it is DRAWN at this frame, for the transform gizmo to sit
	// on: a routed record, the group under one, and the Empty that rides its
	// routed descendant all stand away from their authored numbers while the
	// playhead is off frame 0. Drags still read the authored records (the gizmo
	// is handed those separately), so they stay delta-based on authored numbers.
	// A take-drawn object also gets `heldEdit.gizmo`: the exact drawn centre and rotation.
	const gizmoSceneObject = selectedSceneObject ? animatedSceneObjects.find((object) => object.id === selectedSceneObject.id) ?? selectedSceneObject : null;

	// Auto color: Blender's viewport "Random" mode. A DISPLAY-ONLY marker rides
	// each non-cutout object into the renderers; the authored `color`, the scene
	// document, undo history and the MCP view never change — toggling OFF makes
	// this list the animated list again, byte for byte. Meshes take the same
	// override as a cube: the renderer tints the visible material (file or clay).
	const [autoColor, setAutoColor] = useState(loadAutoColor);
	const displaySceneObjects = useMemo(() => {
		if (!autoColor) return animatedSceneObjects;
		return animatedSceneObjects.map((object) => {
			if (object.renderer === CUTOUT_KIND) return object;
			return { ...object, autoColor: autoColorHex(object.id) };
		});
	}, [animatedSceneObjects, autoColor]);
	const stageSceneObjects = useMemo(
		() => displaySceneObjects.filter((object) => !isEffectivelyHidden(object, sceneObjects, characters)),
		[displaySceneObjects, sceneObjects, characters],
	);

	/* ------------------------ carried props (attachment) ------------------- */
	// A prop attached to a character rides a LIVE frame in the scene graph, so
	// it tracks playback, scrubbing and the offscreen export — none of which
	// re-render React. The renderer resolves the frame through this ref on every
	// rendered frame; the App keeps it pointed at the mounted rigs. A ref, not a
	// prop value, so a fresh rig map never re-renders the set.
	const attachFrameRef = useRef(null);
	attachFrameRef.current = (characterId, bone, out) => attachFrameMatrix(rigs[characterId] ?? null, bone, out);
	// The recorder renders through gl.render() directly, which never runs the
	// r3f frame loop — so it asks the set for one placement pass itself, right
	// after it has written that frame's bones.
	const propSyncRef = useRef(null);
	// Characters grouped under a scene object ride it inside an ObjectCarrier.
	// The carriers read the AUTHORED records by id, and register a placement
	// pass the recorder runs before the props' (a prop carried on a riding
	// character's hand needs the carrier placed first).
	const carrierRegistryRef = useRef(new Set());
	const sceneObjectLookupRef = useRef(null);
	sceneObjectLookupRef.current = useMemo(() => new Map(sceneObjects.map((object) => [object.id, object])), [sceneObjects]);
	const syncCarriers = () => { for (const place of carrierRegistryRef.current) place(); };
	// Where a prop actually IS, read off its live group: the one authority on
	// the transform currently on screen, and so the only honest starting point
	// for a no-jump conversion.
	const propWorldRef = useRef(null);

	/**
	 * Hierarchy row drag policy (the panel holds none). An object row dropped on
	 * another object GROUPS; on a character or one of its bone rows it ATTACHES;
	 * on Props it comes back to the world. A character row dropped on an object
	 * row is GROUPED under it and rides its travel; dropped on the scene root it
	 * stands in the world again. Anything else is not a drop.
	 */
	function characterGroupMove(sourceRowId, targetRowId) {
		const characterId = charIdFromHierarchyId(sourceRowId);
		const entry = characterId ? characters.find((item) => item.id === characterId) : null;
		if (!entry) return null;
		if (targetRowId === "shot") return (entry.parent ?? null) !== null ? { characterId, parent: null } : null;
		const objectId = sceneObjectIdFromHierarchy(String(targetRowId ?? ""));
		const object = objectId ? sceneObjects.find((item) => item.id === objectId) : null;
		if (!object || object.attach || entry.parent === objectId) return null;
		return { characterId, parent: objectId };
	}
	const hierarchyReparent = {
		canDrop: (source, target) => (charIdFromHierarchyId(source)
			? characterGroupMove(source, target) !== null
			: objectsDomain.canReparentSceneObject(source, target)),
		onDrop: (source, target) => {
			if (!charIdFromHierarchyId(source)) return objectsDomain.reparentSceneObject(source, target);
			const move = characterGroupMove(source, target);
			if (move) runStudioAction("character.update", { characterId: move.characterId, patch: { parent: move.parent } });
		},
	};

	useEffect(() => {
		setCraneSelectedIndex(null);
	}, [activeShot?.id, craneActive]);

	const frameCountRef = useRef(DEFAULT_DURATION_S * TIMELINE_FPS);
	frameCountRef.current = tlFrameCount;

	useEffect(castDomain.removeLegacyRootWaypoint, []);

	// Shot trims also trim their local Rail Follow card once. Growing a shot
	// later never resurrects time that the editor already cut away.
	useEffect(shotsDomain.clampShotRailRanges, [tlFrameCount, shots.map((shot) => shot.startFrame).join(":")]);

	/* --------------------------- Scene documents --------------------------- */
	// Refs make a Scene switch synchronous: the outgoing room is sealed with
	// its latest objects and camera department envelope before React opens the
	// destination room.
	const activeSceneIdRef = useRef(activeSceneId);
	// The shot document and the stage's cast are read from the stores when used,
	// not rebuilt here: a render-time copy lagged a synchronous command by one
	// render and moved the scene revision after its receipt (document-mirrors.js).
	const [{ shotDocumentRef, actorStageRef }] = useState(() => createDocumentMirrors(appContext));
	appContext.publishScenes(scenes);
	activeSceneIdRef.current = activeSceneId;
	// The motion layers (IK edits ride into the saved stage with each
	// character): a change to them is a reason to autosave.
	const motionLayers = appContext.storeDomain("motion")?.read() ?? null;
	actorStageRef.current = {
		hasCharSheet,
		environmentImage,
		shotAspect: shotAspectKey,
		cameraPresetId,
		sensorId,
		keyLight, lighting,
		// What this location IS and how it should look. Session state until #345:
		// a reopened scene came back with another room's description.
		environment,
		style,
		hasEnvSheet,
	};

	const { firstSuccessGuideOpen, setFirstSuccessGuideOpen, useCaseAskOpen, setUseCaseAskOpen } = useFirstSuccessPrompt();

	// Dismissal mirrors the inspector-actions menu: only listen while open,
	// ignore presses inside the wrap (the trigger's own click keeps toggling),
	// close on any outside pointerdown or Escape, and tear down on close.
	useEffect(() => {
		if (!projectMenuOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".project-menu-wrap")) return;
			setProjectMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") setProjectMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [projectMenuOpen]);
	// The PlayView reference-export menu (#165) dismisses the same way.
	const [exportMenuOpen, setExportMenuOpen] = useState(false);
	const [exportMenuAnchor, setExportMenuAnchor] = useState({ top: 0, right: 0 });
	useEffect(() => {
		if (!exportMenuOpen) return undefined;
		if (exportShotIdRef.current) document.querySelector('[data-testid="export-video"]')?.focus();
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".export-menu-wrap")) return;
			exportShotIdRef.current = null;
			setExportMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				exportShotIdRef.current = null;
				setExportMenuOpen(false);
				exportMenuTriggerRef.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [exportMenuOpen]);
	// `View ▾` on the viewport bar (#194): one home for the display-only
	// toggles that used to be scattered across the topbar, the scene bar and
	// the inspector. Same dismissal as the two menus above, plus focus
	// returning to the trigger on Escape — the bar is a keyboard stop.
	const [viewMenuOpen, setViewMenuOpen] = useState(false);
	const [viewMenuAnchor, setViewMenuAnchor] = useState({ top: 0, right: 0 });
	const viewMenuTriggerRef = useRef(null);
	useEffect(() => {
		if (!viewMenuOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".view-menu-wrap")) return;
			setViewMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			setViewMenuOpen(false);
			viewMenuTriggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [viewMenuOpen]);
	// The agent panel keeps owning its own collapsed flag (the rail button and
	// Cmd/Ctrl+B both live inside it); the studio only mirrors the flag so the
	// View ▾ item can render a checkmark. It boots collapsed here: the studio
	// opens on the stage, not on a chat column.
	const [agentCollapsed, setAgentCollapsed] = useState(true);
	// Studio Agent is an Inspector peer, not an additional dock. Keeping this
	// host-owned flag separate from the Workflow dock preserves the latter's
	// session and layout while Cmd/Ctrl+B switches the existing Inspector row.
	const studioAgentMode = !agentCollapsed;
	const setStudioAgentMode = (enabled) => setAgentCollapsed(!enabled);
	const studioDocumentEpochRef = useRef(crypto.randomUUID());
	const studioSceneEpochRef = useRef(crypto.randomUUID());
	// The one Studio action registry, built from the command modules
	// (src/commands), and the one generic port object they register over. Every
	// render refreshes the port members in place, so a run always reaches the
	// latest handlers; the UI controls and run_action share both.
	const studioActionsRef = useRef(null);
	const renderWaitersRef = useRef([]);
	const studioHistoryRef = useRef(new Map());
	const studioActionGroupRef = useRef(null);
	const studioIkStampsRef = useRef(new Map());
	const [studioAgentError, setStudioAgentError] = useState(null);
	// A receipt already names the entities it changed. Showing that only as a
	// card at the bottom of the chat leaves the author hunting for what moved,
	// so the hierarchy rows the receipt names light up where they already are
	// and the first one scrolls into view. The chat card stays: one is the
	// record, the other is the pointer.
	const [agentTouchedRows, setAgentTouchedRows] = useState([]);
	const agentTouchTimerRef = useRef(null);
	useEffect(() => () => clearTimeout(agentTouchTimerRef.current), []);
	const hierarchyRowsForAgentTarget = (targetId) => {
		const castIndex = appContext.live.characters.findIndex((entry) => entry.id === targetId);
		if (castIndex !== -1) return [rowIdForCharIndex(castIndex)];
		if (storeRef.current.objects.some((object) => object.id === targetId)) return [`object:${targetId}`];
		// A stage edit is addressed by the scene itself; the rows it can change
		// are the stage's own.
		if (targetId === activeSceneIdRef.current) return ["light", "environment"];
		return [];
	};
	const highlightAgentTargets = (receipt) => {
		const rows = [...new Set((receipt?.affectedIds ?? []).flatMap(hierarchyRowsForAgentTarget))];
		if (!rows.length) return;
		clearTimeout(agentTouchTimerRef.current);
		setAgentTouchedRows(rows);
		agentTouchTimerRef.current = setTimeout(() => setAgentTouchedRows([]), AGENT_RECEIPT_HIGHLIGHT_MS);
	};
	const buildStudioAgentContext = () => {
		if (!liveWorkspaceHandleRef.current) {
			setStudioAgentError(ko("The live editor is disconnected. Reconnect before sending.", "라이브 편집기가 연결되지 않았어요. 연결 후 보내 주세요."));
			return null;
		}
		try { const value = studioBindingRef.current.context(); setStudioAgentError(null); return value; }
		catch (error) { setStudioAgentError(`${error.code ?? "INVALID_CONTEXT"}: ${error.message}`); return null; }
	};
	const agentCollapsedRef = useRef(agentCollapsed);
	useEffect(() => { agentCollapsedRef.current = agentCollapsed; }, [agentCollapsed]);
	useEffect(() => {
		if (embedMode) return;
		// The toolbar control and Workflow's button dispatch the event; Cmd/Ctrl+B calls toggle with the keydown.
		const toggle = (event) => { notePanelToggled(agentCollapsedRef.current, event?.type === "keydown" ? "key" : "button"); noteNavSwitch("agent_panel"); setAgentCollapsed(value => !value); };
		const key = event => { if ((event.metaKey || event.ctrlKey) && event.code === "KeyB") { event.preventDefault(); toggle(event); } };
		window.addEventListener("cozyclay:agent-panel-toggle", toggle); window.addEventListener("keydown", key);
		return () => { window.removeEventListener("cozyclay:agent-panel-toggle", toggle); window.removeEventListener("keydown", key); };
	}, [embedMode]);
	const projectHandleRef = useRef(null);
	

	const projectSnapshotRef = useRef("");
	const projectStateRef = useRef(null);
	projectStateRef.current = { workspaceLayout, customPoses, scenes, activeSceneId, sceneObjects };

	useEffect(() => {
		const onStorage = (event) => {
			if (event.key === WORKFLOW_STORAGE_KEY) setWorkflowRevision((value) => value + 1);
		};
		const onWorkflowChange = () => setWorkflowRevision((value) => value + 1);
		window.addEventListener("storage", onStorage);
		window.addEventListener("cozyclay:workflow-change", onWorkflowChange);
		return () => {
			window.removeEventListener("storage", onStorage);
			window.removeEventListener("cozyclay:workflow-change", onWorkflowChange);
		};
	}, []);

	const starterOpened = useRef(false);
	useEffect(() => {
		if (starterOpened.current || playgroundMode) return;
		const requested = new URLSearchParams(globalThis.location?.search || "").get("scene");
		if (!requested) return;
		starterOpened.current = true;
		// An id this build does not ship (a removed starter, a typo) is ignored:
		// the studio opens as it would without ?scene=.
		if (!resolveSceneParam(requested)) {
			console.warn(`cozyclay: ?scene=${requested} is not a starter scene in this build; ignored.`);
			return;
		}
		void openStarterScene(requested, "launch");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Re-open the last project on launch when the browser still grants access.
	// A handle Chromium demoted to "prompt" cannot be re-requested here (no
	// user gesture), so it becomes a one-click restore offer instead (#51).
	const projectAutoOpenedRef = useRef(false);

	useEffect(() => {
		if (projectAutoOpenedRef.current) return;
		projectAutoOpenedRef.current = true;
		loadStoredProjectHandle().then(async (record) => {
			if (!record?.handle) return;
			const permission = await queryHandlePermission(record.handle);
			if (permission === "granted") {
				await restoreStoredProject(record);
				return;
			}
			if (permission === "prompt") setRestoreOffer(record);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Workflow runs in a separate tab/route. Scene writes therefore arrive as
	// either a same-tab CustomEvent or a cross-tab storage event. Keep the
	// Studio's live editor in sync without writing the event back in a loop:
	// compare against the current snapshot first, then replace only the active
	// scene's objects/cast or open the newly selected scene.
	const externalSceneApplyRef = useRef(null);
	externalSceneApplyRef.current = scenesDomain.applyExternalScene;
	useEffect(() => subscribeToSceneDocuments((document) => externalSceneApplyRef.current?.(document)), []);
	useEffect(() => subscribeToScenePlayback((command) => {
		if (command?.activeSceneId && command.activeSceneId !== activeSceneIdRef.current) return;
		if (Number.isFinite(Number(command?.frame))) {
			setTlFrame((frame) => Math.max(0, Math.min(Math.round(Number(command.frame)), Math.max(0, frameCountRef.current - 1))));
		}
		if (typeof command?.playing === "boolean") {
			cameraPreviewEndRef.current = null;
			manualCameraOverrideRef.current = false;
			setTlPlaying(command.playing);
		}
	}), []);
	// The Workflow Scene node's frame slider used to guess the take length, so
	// its own preview clock ran on past the end of a shorter shot (#218). The
	// embed announces the take it actually holds — on load and whenever the
	// scene or its length changes — and the node follows it.
	useEffect(() => {
		if (!embedMode) return;
		window.parent.postMessage({ type: "cozyclay:scene-timeline", activeSceneId, frameCount: tlFrameCount, fps: tlFps }, "*");
	}, [embedMode, activeSceneId, tlFrameCount, tlFps]);

	// Commands are a sequential transport boundary, while React commits on a
	// later turn. Keep its read model current synchronously so the next frame
	// observes the mutation that the previous frame just acknowledged.
	appContext.publishLive({
		scenes,
		activeSceneId,
		camera: cameraPos,
		fovDeg,
		filmback,
		// keyLight rides the live stage envelope: it is authored, undoable and
		// patchable state, so every reader sees the body the save path writes.
		stage: { shotAspect: shotAspectKey, cameraPresetId, sensorId, hasCharSheet, environmentImage, environment, style, hasEnvSheet, keyLight, lighting },
		timeline: { currentFrame: tlFrame, frameCount: tlFrameCount, fps: tlFps },
		activeCharacterId: characters.length ? activeCharacterId : null,
		partColours: partColoursEnabled ? PART_COLOURS : null,
		waypoints,
		characters,
		objects: sceneObjects,
		rigs,
		commitManualCameraFraming,
		removeCharacter,
		persistScenes,
		openScene,
		// The framing-capture pair the agent commands call. Both are per-render
		// closures (captureFramingPng sizes its canvas off the render's own
		// shotOutput), so the ref must always hold THIS render's instance — a
		// stale one would letterbox a pull taken after the shot aspect changed.
		activeShotId: activeShot?.id ?? null,
		captureCurrentFraming,
		captureFramingPng,
		// The Top View pull (verify_result visual "plan", capture_plan_png).
		capturePlanPng,
		captureShotMeta,
		// The identity / environment reference pictures a capture carries (#167).
		captureShotReferences,
		// Reference exports (#165): the embed message handler and the QA hooks
		// both go through this render's closures, so a pack always describes the
		// cut as it stands now.
		buildShotKeyframePack,
		shotIndexForPack,
		renderPassDataUrls,
		exportShotVideo,
		generate,
		shots,
	});
	const liveQueries = {
		ping: () => ({ pong: true }),
		describe: () => {
			const live = appContext.live.state;
			return {
				document: {
					version: SCENES_VERSION,
					activeSceneId: activeSceneIdRef.current,
					scenes: snapshotActiveScene(),
				},
				sceneName: live.scenes.find((scene) => scene.id === live.activeSceneId)?.name ?? "",
				camera: {
					...live.camera,
					focalMm: Math.round(fovToFocalMm(
						(live.fovDeg * Math.PI) / 180,
						live.filmback.sensorId,
						live.filmback.aspectRatio,
					) * 100) / 100,
					sensorId: live.filmback.sensorId,
					aspectRatio: live.filmback.aspectRatio,
				},
				stage: live.stage,
				previsMode: scenesDomain.metadata().previsMode,
				timeline: live.timeline,
				activeCharacterId: live.activeCharacterId,
				characters: castDomain.read(),
				objects: objectsDomain.read(),
			};
		},
		capture_frame: async () => {
				const live = appContext.live.state;
				return captureMcpFrame({
					partColours: live.partColours,
					capture: mcpCaptureRef.current,
					camera: shotCamRef.current,
					characters: live.characters,
					activeCharacterId: live.activeCharacterId,
					objects: live.objects,
					rigs: live.rigs,
					readAuthoredState: () => ({
						scenes: appContext.live.state.scenes,
						activeSceneId: appContext.live.state.activeSceneId,
						camera: appContext.live.state.camera,
						fovDeg: appContext.live.state.fovDeg,
						filmback: appContext.live.state.filmback,
						stage: appContext.live.state.stage,
						timeline: appContext.live.state.timeline,
						activeCharacterId: appContext.live.state.activeCharacterId,
						waypoints: appContext.live.state.waypoints,
						characters: appContext.live.state.characters,
						objects: appContext.live.state.objects,
					}),
				});
			},
			// The full-resolution shot-camera pull the editor's own exports use —
		// not capture_frame's 640x360 preview, which stays exactly as it is.
			capture_framing_png: (args = {}) => {
				const live = appContext.live.state;
				const output = requestedCaptureOutput(args) ?? SHOT_ASPECT_PRESETS[live.stage.shotAspect] ?? SHOT_ASPECT_PRESETS["16:9"];
				const dataUrl = live.captureFramingPng(live.captureCurrentFraming(), output);
				if (!dataUrl) throw new Error("The shot renderer is not ready");
				return {
					dataUrl,
					width: output.width,
					height: output.height,
					frame: live.timeline.currentFrame,
					shotId: live.activeShotId,
					partColours: live.partColours,
					// The production notes the PNG cannot carry: lens, delivery
					// aspect, cast and the video model this shot is aimed at.
					meta: live.captureShotMeta(live.timeline.currentFrame),
					// Identity sheets per cast member plus the environment reference.
					references: live.captureShotReferences(),
				};
			},
			// The Top View as the agent's plan picture: a 2D diagram of the cast,
			// footprints and every shot camera drawn from state (src/plan-diagram.js).
			capture_plan_png: (args = {}) => appContext.live.state.capturePlanPng(requestedCaptureOutput(args) ?? undefined),
	};

	const liveSceneName = scenes.find((entry) => entry.id === activeSceneId)?.name ?? "";
	const liveMeta = () => ({
		project: projectName ?? "Untitled", scene: liveSceneName, cast: appContext.live.characters.length,
		// The Workflow page's embedded preview is a live editor too; mark it apart from the authoring tab.
		// Commands: what this editor answers; a stale tab from an older build answers a different set.
		...(embedMode ? { embed: true } : {}), commands: [...Object.keys(liveQueries), ...Object.keys(studioBindingRef.current.handlers)],
	});
	// The client is created once; opening a project must still relabel the tab
	// in live status and the --workspace <project> selector (#864).
	useEffect(() => { liveControlRef.current?.setMeta(liveMeta()); }, [projectName, liveSceneName, appContext.live.characters.length]);

	useEffect(() => {
		const enabled = import.meta.env.DEV || window.__COZYCLAY_LIVE__ === true;
		if (!enabled) return undefined;
		// StrictMode replays effects in development. Delaying the open lets the
		// replay cleanup cancel its first pass, so one tab owns one socket.
		const timer = setTimeout(() => {
			if (!liveControlRef.current) {
				liveControlRef.current = createLiveControl({
					// Tapped so a sculpt run hears the agent's object.sculpt / sculpt.compare.
					handlers: sculptTap.wrap({ ...liveQueries, ...studioBindingRef.current.handlers }),
					workspaceId: liveWorkspaceIdRef.current,
					meta: liveMeta(),
					// The shared client intentionally has no disconnect UI callback.
					// Observe only this owned socket; a stale handle must never be sent.
					WebSocketImpl: class extends WebSocket {
						constructor(url) {
							super(url);
							this.addEventListener("close", () => {
								liveWorkspaceHandleRef.current = null;
								setLiveWorkspaceHandle(null);
							});
						}
					},
					onWorkspace: (handle) => {
						liveWorkspaceHandleRef.current = handle;
						setLiveWorkspaceHandle(handle);
					},
					// Duplicating a tab copies its sessionStorage, so both tabs claim one
					// id and the hub refuses the second. Take a fresh id for this tab.
					onDuplicate: () => {
						const minted = mintLiveWorkspaceId();
						liveWorkspaceIdRef.current = minted;
						return minted;
					},
					onEvent: (name, payload) => {
						if (name !== "motion_job" || typeof payload.taskId !== "string") return;
						if (["failed", "cancelled", "expired"].includes(payload.status)) {
							setToast(payload.outcome?.message ?? `Motion job ${payload.status}.`);
						}
					},
				});
			}
		}, 0);
		return () => {
			clearTimeout(timer);
			liveControlRef.current?.close();
			liveControlRef.current = null;
			liveWorkspaceHandleRef.current = null;
			setLiveWorkspaceHandle(null);
		};
	}, []);

	// One debounced Scene-document save owns both departments. Switching calls
	// persistScenes directly, so no outgoing edit can be overtaken by a render.
	useEffect(() => {
		dirtyRef.current = true;
		const timer = setTimeout(flushScenes, 400);
		return () => clearTimeout(timer);
	}, [sceneObjects, shots, waypoints, tlFrameCount, charA, charB, showB, poseA, poseB, hasCharSheet, environmentImage, environment, style, hasEnvSheet, subject, subject2, shotAspectKey, sensorId, keyLight, scenes, activeSceneId, motionLayers]);
	useEffect(() => {
		const onPageHide = () => flushScenes();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flushScenes();
		};
		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
			flushScenes();
		};
	}, []);

	// These hooks are declared after the liveStateRef assignment above runs, so
	// they join the live read model here — same render, no TDZ.
	appContext.patchLive({ setTlFrameCount });

	// Dirty tracking: any divergence from the last saved file lights the dot.
	useEffect(scenesDomain.refreshProjectDirty, [scenes, activeSceneId, workspaceLayout, customPoses, characters, shots, waypoints, projectName, keyLight, sceneObjects, shotAspectKey, environmentImage, environment, style, hasEnvSheet, sensorId, tlFrameCount, workflowRevision]);

	// The untrimmed take per CHARACTER. Trims are non-destructive views of the
	// full take, so re-trimming and "restore full" always cut from the
	// original — and because each cast member owns its own layer, one shared
	// ref would hand Subject 2's take to Subject 1 on the next switch.
	const motionFullRef = useRef(new Map()); // charId -> untrimmed take

	


	// Cast render props, memoized with Character itself (React.memo): during
	// playback the playhead ticks 24 times a second, and a character whose
	// props did not change must not re-render its subtree.
	const characterViews = useMemo(() => characters.flatMap((entry, index) => {
		if (entry.hidden) return [];
		const pickId = index === 0 ? "A" : index === 1 ? "B" : entry.id;
		// Each cast member is driven by ITS OWN clip: the active one reads
		// the editing buffer, the others their stored session motion.
		const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
		const placement = placementAt(entry, tlFrame, {
			shotAt: frame => shotAtFrame(shots, frame),
			takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, tlFrame).subject : null,
		});
		return [{
			id: entry.id,
			entry,
			clip,
			model: entry.model,
			...(isProxyFigure(entry) ? {} : { url: characterModelUrl(entry.model) }),
			position: [placement.x, entry.y ?? 0, placement.z],
			rot: placement.rot,
			tint: entry.tint ?? defaultCharacterTint(entry, index),
			partColoursEnabled,
			partColoursMode,
			pose: clip ? null : (placement.pose ?? DEFAULT_POSE),
			posture: placement.posture,
			// The stature the entry's take was extracted at. It rides with the
			// clip, never separately — see Character for why.
			scale: entry.scale ?? 1,
			...(isProxyFigure(entry) ? {} : { onRig: reportRig(entry.id) }),
			pickId,
			parent: entry.parent ?? null,
		}];
	}), [characters, activeChar.id, motion, shots, tlFrame, partColoursEnabled, partColoursMode]);
	// Where the selection gizmo stands: same driving rules as the render,
	// for the active (selected) cast member only. Gated on the HIERARCHY
	// selection, not the sticky active layer — the layer stays on the last
	// character so the motion tab keeps working, but a move gizmo hanging in
	// the viewport while the camera or a prop is selected reads as a stray
	// widget.
	const gizmoView = characterGizmoView({
		selected: Boolean(charIdFromHierarchyId(selectedHierarchyId)), characters, activeCharacterId,
		activeCharacter: activeChar, motion, shots, activeId: activeChar.id, frame: tlFrame,
	});
	// The cast rides the SAME gizmo as scene objects — one movement grammar
	// for everything on stage. The proxy hands ObjectGizmo the object shape
	// it expects; `height` puts the pivot at the hips like a prop's centre.
	const characterGizmoObject = buildCharacterGizmoObject(gizmoView, characters.find((item) => item.id === activeChar.id));

	/* --------------------- per-character layer buffers ---------------------
	 * waypoints / motion above are the EDITING BUFFER of the
	 * active character's animation layer. On a character switch the buffer is
	 * committed back into the previous character's entry and the new one's
	 * layer is loaded, so each cast member keeps its own schedule. The
	 * generated clip is session-only; paths and prompt blocks persist in the
	 * stage envelope via the characters array. */
	const bufferRef = useRef({ waypoints: [], motion: null, ik: null });
	bufferRef.current = { waypoints, motion, ik: ikStateRef.current };
	const loadedLayerCharRef = useRef(activeChar.id);
	const ikStatesRef = useRef(new Map()); // charId -> ikState, one per layer
	useEffect(castDomain.switchActiveCharacterLayer, [activeChar.id]);
	

	const shotCamRef = useRef(null);
	const captureRef = useRef(null);
	const look = useRef({ yaw: 0, pitch: 0 });
	// The poser camera is the IK-mode working view: orbit/dolly/WASD freely
	// while posing WITHOUT touching the shot camera, which stays frozen on
	// the framing and shows in the inset. Two separate screens by design.
	const poserCamRef = useRef(null);
	const poserLook = useRef({ yaw: 0, pitch: 0 });
	// The editor camera: the free working view the operator flies. Playback,
	// follow, rail and capture never touch it — that is the whole split.
	const editorCamRef = useRef(null);
	const editorLook = useRef({ yaw: 0, pitch: 0 });

	/* The shot camera as a manipulable object in the editor view: the proxy
	 * mirrors the live camera, gizmo patches write straight back to it and
	 * commit manual framing — the same contract as dragging its plan puck. */
	const shotCameraSelected = selectedHierarchyId === "camera";
	const cameraGizmoObject = useMemo(() => {
		if (lookThroughShot || ikMode || !shotCameraSelected) return null;
		return {
			id: "__shotcam__",
			x: cameraPos.x,
			y: Math.max(0, cameraPos.y - 0.12),
			z: cameraPos.z,
			height: 0.24,
			footprint: { width: 0.34, depth: 0.34 },
			rotY: THREE.MathUtils.radToDeg(look.current.yaw),
			scaleX: 1,
			scaleY: 1,
			scaleZ: 1,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cameraPos, lookThroughShot, ikMode, shotCameraSelected]);
	function changeShotCameraFromGizmo(_id, patch) {
		const cam = shotCamRef.current;
		if (!cam) return;
		if (patch.x !== undefined) cam.position.x = THREE.MathUtils.clamp(patch.x, -30, 30);
		if (patch.y !== undefined) cam.position.y = Math.max(0.12, patch.y + 0.12);
		if (patch.z !== undefined) cam.position.z = THREE.MathUtils.clamp(patch.z, -30, 30);
		if (patch.rotY !== undefined) look.current.yaw = THREE.MathUtils.degToRad(patch.rotY);
		cam.rotation.order = "YXZ";
		cam.rotation.set(look.current.pitch, look.current.yaw, 0);
		commitManualCameraFraming();
	}

	/* The key light as a manipulable object: same proxy contract as the shot
	 * camera — the sun puck mirrors the light, gizmo patches write straight
	 * back to the stage's keyLight. Move only; brightness lives in the
	 * Inspector. */
	const keyLightSelected = selectedHierarchyId === "light";
	const lightGizmoObject = useMemo(() => {
		if (!keyLightSelected || ikMode) return null;
		return {
			id: "__keylight__",
			x: keyLight.x,
			y: keyLight.y - 0.2,
			z: keyLight.z,
			height: 0.4,
			footprint: { width: 0.4, depth: 0.4 },
			rotY: 0,
			scaleX: 1,
			scaleY: 1,
			scaleZ: 1,
		};
	}, [keyLightSelected, ikMode, keyLight]);
	/* Selecting the Light from the hierarchy must SHOW the light: the sun sits
	 * high above the stage and the default view often does not contain it, so
	 * the editor camera glides in place to face it (position untouched). */
	function aimEditorAtKeyLight() {
		if (!editorCamRef.current || lookThroughShot || ikMode) return;
		setCamGlide({ target: { x: keyLight.x, y: keyLight.y, z: keyLight.z } });
	}
	function changeKeyLightFromGizmo(_id, patch) {
		changeKeyLight("gizmo", (current) => ({
			...current,
			x: patch.x !== undefined ? patch.x : current.x,
			y: patch.y !== undefined ? patch.y + 0.2 : current.y,
			z: patch.z !== undefined ? patch.z : current.z,
		}));
	}

	const shot = useMemo(
		() => deriveShot(cameraPos, charA, (fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback),
		[cameraPos, charA, fovDeg, filmback],
	);

	// The derived move sequence: what the keyframings geometrically prove
	// segment by segment, not what a dropdown claims. Present from two keys.
	const moveSequence = useMemo(() => {
		if (cameraKeys.length < 2) return null;
		const segs = [];
		for (let i = 0; i < cameraKeys.length - 1; i++) {
			segs.push(
				classifyMove(cameraKeys[i].framing, cameraKeys[i + 1].framing, charA, {
					durationS: (cameraKeys[i + 1].frame - cameraKeys[i].frame) / tlFps,
					...filmback,
				}),
			);
		}
		return {
			segs,
			slate: moveSequenceSlate(segs),
			displaySlate: moveSequenceSlateKo(segs),
			phrase: moveSequencePhrase(segs),
			fromShot: segs[0].from,
			spanS: Math.round(((cameraKeys[cameraKeys.length - 1].frame - cameraKeys[0].frame) / tlFps) * 10) / 10,
		};
	}, [cameraKeys, charA, filmback, tlFps]);
	// With Follow armed, Preview means "watch the shot": it plays the timeline
	// from frame 0 so character motion and the camera move share one clock.
	// Follow off keeps the camera-only preview on its own clock.
	const followPreviewArmed = moveFollow && hasCameraKeys && !ikMode && !waypointMode && !posing;
	const previewActive = movePlaying || (followPreviewArmed && tlPlaying);

	/* --------------------------- shot video export --------------------------- */
	// Record is an offline frame-addressed export. It never starts playback and
	// never samples a wall clock: sampleAt applies one absolute timeline frame,
	// CaptureRig reads the shot camera's WebGLRenderTarget, and WebCodecs receives
	// exactly one VideoFrame for every address in the inclusive export range.
	const [recState, setRecState] = useState("idle"); // "idle" | "recording"
	const recRef = useRef(null), cameraPerformanceRef = useRef(null), cameraPerformanceShotRef = useRef(null);
	const tlFrameRef = useRef(0);
	tlFrameRef.current = tlFrame;
	const [exportStatus, setExportStatus] = useState(null);
	const [cameraPerformanceRecording, setCameraPerformanceRecording] = useState(false);
	const retryExportRef = useRef(null);
	const frameExportRef = useRef(null);
	function startCameraPerformance() {
		if (!activeShot || cameraPerformanceRef.current?.active) return false;
		if (!cameraPerformanceRef.current) {
			cameraPerformanceRef.current = createCameraPerformance({ sample: () => framingFromCamera(shotCamRef.current, look.current) });
		}
		const started = cameraPerformanceRef.current.start({ startFrame: activeShot.startFrame, endFrame: activeShot.endFrame, fps: tlFps });
		if (!started) return false;
		enterShotLook();
		cameraPerformanceShotRef.current = activeShot.id; manualCameraOverrideRef.current = true;
		setCameraPerformanceRecording(true);
		setToast(ko("Recording camera performance — right-drag and WASD to shoot; Stop saves editable keys", "퍼포먼스 녹화 중 — 오른쪽 드래그와 WASD로 촬영하고 Stop으로 키를 저장하세요"));
		return true;
	}
	function stopCameraPerformance() {
		const shotId = cameraPerformanceShotRef.current, keys = cameraPerformanceRef.current?.stop() ?? []; cameraPerformanceShotRef.current = null;
		setCameraPerformanceRecording(false);
		manualCameraOverrideRef.current = false;
		if (!shotId || !keys.length) { setToast(ko("No camera performance was recorded", "녹화된 퍼포먼스가 없습니다")); return null; }
		setTlFrame(keys.at(-1).frame);
		runStudioAction("shot.recordKeys", { shotId, keys });
		setToast(ko(`Camera performance saved as ${keys.length} editable keys`, `퍼포먼스를 편집 가능한 키 ${keys.length}개로 저장했어요`));
		return keys;
	}
	useEffect(() => () => cameraPerformanceRef.current?.cancel(), []);
	// Snapshot authored inputs once, not when Retry is pressed. Runtime render
	// resources are acquired per attempt; they are never part of the snapshot.
	function exportRequest(kind, run, { exportShots = shots, external = false, download = true } = {}) {
		// IK's cached chains contain live Three bones/functions, not cloneable
		// authored data. Retain that binding and copy only the evaluated keys.
		const copyIk = (state) => state ? { ...state, keys: snapshotIkKeys(state), tracked: new Set(state.tracked) } : state;
		const context = kind === "frame" ? null : {
			...structuredClone({ shots: exportShots, playbackScene, characters, activeId: activeChar.id, motion,
				framing: captureCurrentFraming(), output: shotOutput }),
			ikState: copyIk(ikStateRef.current),
			ikStates: new Map([...ikStatesRef.current].map(([id, state]) => [id, copyIk(state)])),
			rigStates: Object.values(rigs).filter(Boolean).map(snapshotExportRig),
		};
		return Object.freeze({ kind, format: kind === "frame" || kind === "contact_sheet" ? "png" : kind === "keyframe_pack" || kind === "panel_pack" ? "zip" : "mp4",
			context, run, external, download, handedOff: new Set() });
	}

	function exportRecovery(code) {
		switch (code) {
			case "unsupported_codec": return ko("MP4 encoding is unavailable. Use a current browser with H.264 WebCodecs support (such as Chrome or Edge), enable hardware acceleration, then retry.", "MP4 인코딩을 사용할 수 없어요. H.264 WebCodecs를 지원하는 최신 Chrome·Edge 등에서 하드웨어 가속을 켠 뒤 다시 시도하세요.");
			case "encode_failed": return ko("Video encoding failed. Retry the same request. If resources are tight, shorten the shot range or lower output resolution before starting a new export.", "영상 인코딩에 실패했어요. 같은 요청을 다시 시도하세요. 리소스가 부족하면 샷 범위를 줄이거나 출력 해상도를 낮춘 뒤 새로 내보내세요.");
			case "render_failed": return ko("Frame rendering failed. Let the scene finish loading, then retry. If it repeats, shorten the range or reduce output resolution for a new export.", "프레임 렌더링에 실패했어요. 장면 로딩이 끝난 뒤 다시 시도하세요. 반복되면 범위나 출력 해상도를 줄여 새로 내보내세요.");
			case "aborted": return ko("Export cancelled. No further files will be handed off.", "내보내기를 취소했어요. 추가 파일은 전달하지 않아요.");
			default: return ko("Export could not finish. Retry the same request. For memory or resource problems, close other heavy tabs or use a shorter range / lower output resolution in a new export.", "내보내기를 완료하지 못했어요. 같은 요청을 다시 시도하세요. 메모리·리소스 문제라면 무거운 탭을 닫거나 범위·출력 해상도를 줄여 새로 내보내세요.");
		}
	}

	function updateExportStatus(job, phase, details = {}) {
		if (recRef.current !== job) return;
		job.cancellable = details.cancellable ?? false; if (!job.controller.signal.aborted) job.attempt?.note(phase, details);
		setExportStatus({ kind: job.request.kind, phase, label: job.label, ...details });
	}

	// Yield to input between real work units, not a progress timer. This also
	// lets the preparing state render before synchronous PNG/ZIP work begins.
	function exportBoundary(job) {
		job.controller.signal.throwIfAborted();
		return new Promise((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
			channel.port2.postMessage(null);
		}).then(() => job.controller.signal.throwIfAborted());
	}

	async function executeExportRequest(request) {
		// A synchronous ref, shared by ALL four kinds and retry, is authoritative.
		// React's busy state alone cannot guard two calls in the same event turn.
		if (recRef.current) {
			if (request.external) throw new Error(ko("An export is already running", "이미 내보내기 중입니다"));
			return null;
		}
		const job = { request, controller: new AbortController(), capture: null, cancellable: false, attempt: request.external ? null : startExportAttempt({ export_kind: request.kind, format: request.format, surface: embedMode ? "embed" : "studio", objects: sceneObjects.length, request }) };
		recRef.current = job;
		retryExportRef.current = request;
		setRecState("recording");
		updateExportStatus(job, "preparing", { cancellable: request.kind !== "frame" });
		try {
			await exportBoundary(job);
			if (request.context) {
				if (!captureRef.current || !shotCamRef.current) throw Object.assign(new Error("The shot renderer is not ready"), { exportFailureCode: "render_failed" });
				job.capture = captureRef.current.createExportCapture(request.context.output);
			}
			const output = await request.run(job);
			job.controller.signal.throwIfAborted();
			job.attempt?.succeed();
			updateExportStatus(job, "completed", { message: request.download
				? ko("Export completed. Check your export folder or browser downloads; the OS save is not confirmed.", "내보내기를 완료했어요. 내보내기 폴더나 브라우저 다운로드를 확인하세요. OS 저장 완료는 확인할 수 없어요.")
				: ko("Export pipeline completed. The requesting tool handles the file handoff.", "내보내기 처리를 완료했어요. 요청한 도구에서 파일 전달을 처리합니다.") });
			if (!request.external) {
				if (request.kind === "video") { track("export:video_succeeded", { format: "mp4" }); trackFeature("export_video"); }
				if (request.kind === "depth_video") trackFeature("export_depth_video");
				if (request.kind === "keyframe_pack") trackFeature("export_keyframe_pack");
				if (request.kind === "frame") {
					track("export:blocking_frame_succeeded", { format: "png" });
					trackFeature("export_frame"); trackActivation("export");
				}
				// A real deliverable is the moment the use-case question is worth
				// asking; never in embeds, and only while telemetry is on.
				try {
					if (!embedMode && !playgroundMode && ["video", "frame", "depth_video"].includes(request.kind) && shouldAskUseCase()) setUseCaseAskOpen(true);
				} catch {
					// The optional question can never turn a finished export into a failure.
				}
			}
			return output;
		} catch (error) {
			const code = exportFailureCode(error, request.kind === "depth_video" ? "render_failed" : "unknown");
			job.attempt?.fail(error, code, request.handedOff.size);
			const message = exportRecovery(code);
			updateExportStatus(job, code === "aborted" ? "cancelled" : "failed", {
				code, message, retryable: !request.external, handedOff: request.handedOff.size,
			});
			setToast(message);
			if (request.external) throw error;
			return null;
		} finally {
			try { job.capture?.dispose(); }
			finally { if (recRef.current === job) recRef.current = null; setRecState("idle"); }
		}
	}

	function retryExport() {
		if (recRef.current || !retryExportRef.current || retryExportRef.current.external) return;
		return executeExportRequest(retryExportRef.current);
	}

	function applyExportFrame(frame) {
		// Props on a travel path read this ref inside their own useFrame, so a
		// recorded frame shows the same placement the preview would.
		propFrameRef.current = frame;
		const context = recRef.current?.request.context;
		for (const entry of context?.characters ?? characters) {
			if (isProxyFigure(entry)) continue;
			const activeId = context?.activeId ?? activeChar.id;
			const clip = entry.id === activeId ? (context ? context.motion : motion) : entry.sessionMotion;
			const state = context
				? (entry.id === activeId ? context.ikState : context.ikStates.get(entry.id))
				: (entry.id === activeChar.id ? ikStateRef.current : ikStatesRef.current.get(entry.id));
			const placement = placementAt(entry, frame, {
				shotAt: at => shotAtFrame(context?.shots ?? shots, at),
				takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
			});
			poseMemberAtFrame(rigs[entry.id], clip, state, frame, IK_CORRECTION_BLEND_FRAMES, placement.pose ?? null);
		}
		// The bones for this frame are now written, so a carried prop can take
		// its place on them. gl.render() never runs the r3f frame loop, so this
		// pass is the recorder's stand-in for the useFrame the preview gets.
		// Riding characters move with their object first, then the props.
		syncCarriers();
		propSyncRef.current?.(); syncPhysicsOverlays(frame);
		const shotForFrame = shotAtFrame(context?.shots ?? shots, frame);
		const sampled = sampleAt(context?.playbackScene ?? playbackScene, shotForFrame, frame);
		const framing = sampled.camera ?? context?.framing;
		const cam = shotCamRef.current;
		if (cam && framing) {
			cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
			cam.rotation.order = "YXZ";
			cam.rotation.set(framing.pitch, framing.yaw, 0);
			look.current.yaw = framing.yaw;
			look.current.pitch = framing.pitch;
			cam.fov = framing.fovDeg;
			applyCameraOptics(cam, shotForFrame?.optics);
		}
		return (recRef.current?.capture ?? captureRef.current)?.render() ?? null;
	}

	function snapshotExportRig(rig) {
		return { rig, bones: snapshotPlaybackBones(rig), scale: rig.scale.clone(),
			parent: rig.parent ? { node: rig.parent, position: rig.parent.position.clone(), quaternion: rig.parent.quaternion.clone() } : null };
	}

	function restoreExportRig(snapshot) {
		snapshot.rig.scale.copy(snapshot.scale);
		if (snapshot.parent) {
			snapshot.parent.node.position.copy(snapshot.parent.position);
			snapshot.parent.node.quaternion.copy(snapshot.parent.quaternion);
			snapshot.parent.node.updateMatrixWorld(true);
		}
		restorePlaybackBones(snapshot.rig, snapshot.bones);
	}

	// Restore at each synchronous capture boundary, including the depth
	// prepass, rather than holding an export pose across a hash/codec await.
	function withExportFrame(frame, render = null) {
		const cam = shotCamRef.current;
		if (!cam) throw Object.assign(new Error("The shot renderer is not ready"), { exportFailureCode: "render_failed" });
		const cameraSnapshot = { position: cam.position.clone(), quaternion: cam.quaternion.clone(),
			rotationOrder: cam.rotation.order, fov: cam.fov, view: cam.view?.enabled ? structuredClone(cam.view) : null, yaw: look.current.yaw, pitch: look.current.pitch };
		const rigSnapshots = Object.values(rigs).filter(Boolean).map(snapshotExportRig);
		const proxySnapshots = [];
		const context = recRef.current?.request.context;
		const cast = context?.characters ?? characters;
		const scene = (recRef.current?.capture ?? captureRef.current)?.scene;
		const pickIdByCharacter = new Map(characterViews.map(view => [view.id, view.pickId]));
		if (typeof scene?.traverse === "function") scene.traverse(node => {
			const index = cast.findIndex(entry => isProxyFigure(entry) && node.userData.characterPick === pickIdByCharacter.get(entry.id));
			if (index < 0) return;
			proxySnapshots.push({ node, entry: cast[index], position: node.position.clone(), quaternion: node.quaternion.clone() });
		});
		const propFrame = propFrameRef.current;
		try {
			// Character stature lives on the rig and placement/yaw on its parent,
			// not in playback bones. Retry temporarily restores both, plus the
			// original held pose, then puts the CURRENT editor transforms back.
			for (const snapshot of recRef.current?.request.context?.rigStates ?? []) restoreExportRig(snapshot);
			for (const { node, entry } of proxySnapshots) {
				const clip = entry.id === (context?.activeId ?? activeChar.id) ? (context ? context.motion : motion) : entry.sessionMotion;
				const placement = placementAt(entry, frame, {
					shotAt: at => shotAtFrame(context?.shots ?? shots, at),
					takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
				});
				node.position.set(placement.x, entry.y ?? 0, placement.z);
				node.rotation.y = proxyYaw(placement.rot, placement.posture);
				node.updateMatrixWorld(true);
			}
			const plate = applyExportFrame(frame);
			return render ? render() : plate;
		} catch (error) {
			throw Object.assign(new Error(error?.message || String(error), { cause: error }), { exportFailureCode: exportFailureCode(error, "render_failed") });
		} finally {
			for (const snapshot of rigSnapshots) restoreExportRig(snapshot);
			for (const { node, position, quaternion } of proxySnapshots) {
				node.position.copy(position);
				node.quaternion.copy(quaternion);
				node.updateMatrixWorld(true);
			}
			cam.position.copy(cameraSnapshot.position);
			cam.rotation.order = cameraSnapshot.rotationOrder;
			cam.quaternion.copy(cameraSnapshot.quaternion);
			cam.fov = cameraSnapshot.fov;
			if (cameraSnapshot.view) cam.view = cameraSnapshot.view; else cam.clearViewOffset();
			cam.updateProjectionMatrix();
			look.current.yaw = cameraSnapshot.yaw;
			look.current.pitch = cameraSnapshot.pitch;
			propFrameRef.current = propFrame;
			syncCarriers();
			propSyncRef.current?.(); syncPhysicsOverlays();
		}
	}

	function currentRecordFrameCount() {
		const contentExtent = timelineContentExtent(
			characters,
			activeChar.id,
			motion,
			null,
		);
		// Camera-only scenes still use their authored production duration. Once
		// motion exists, content is the authoritative record
		// range even if an older timeline count was left behind.
		return contentExtent > 0 ? contentExtent : tlFrameCount;
	}

	function exportReviewDecoration(frame, pixels) {
		const context = recRef.current?.request.context;
		const shotForFrame = shotAtFrame(context?.shots ?? shots, frame);
		if (!shotForFrame?.review?.burnIn) return pixels;
		const sampled = sampleAt(context?.playbackScene ?? playbackScene, shotForFrame, frame).camera;
		const targetId = shotForFrame.optics?.focusTargetId;
		const targetCharacter = (context?.characters ?? characters).find(entry => entry.id === targetId);
		const targetObject = sceneObjects.find(entry => entry.id === targetId);
		const at = targetCharacter ? placementAt(targetCharacter, frame, {
			shotAt: value => shotAtFrame(context?.shots ?? shots, value),
			takeRoot: targetCharacter.id === (context?.activeId ?? activeChar.id) && (context?.motion ?? motion)
				? sampleAt({ frameCount: (context?.motion ?? motion).frames, motion: context?.motion ?? motion }, null, frame).subject : null,
		}) : null;
		const target = at ? { x: at.x, y: 1.3 * (targetCharacter.scale ?? 1), z: at.z }
			: targetObject ? { x: targetObject.x, y: (targetObject.y ?? 0) + (targetObject.height ?? 0) / 2, z: targetObject.z } : null;
		const output = recRef.current?.request.context?.output ?? shotOutput;
		return burnInRgba(pixels, output.width, output.height, reviewSlate({ shot: shotForFrame, frame, fps: TIMELINE_FPS,
			focalMm: sampled?.focalMm, projectName, focusDistance: focusDistance(sampled?.pos, target) }));
	}
	async function runShotExport({ startFrame = 0, endFrame, download = true, passKind = null, depthRange = null, fileName = null } = {}, job = null) {
		const resolvedEndFrame = endFrame ?? Math.max(0, currentRecordFrameCount() - 1);
		// Preserve the download-free browser seam, without a nested lifecycle.
		if (!job) return executeExportRequest(exportRequest(passKind === "depth" ? "depth_video" : "video",
			(ownedJob) => runShotExport({ startFrame, endFrame: resolvedEndFrame, download, passKind, depthRange, fileName }, ownedJob),
			{ external: true, download }));
		job.controller.signal.throwIfAborted();
		const output = job.request.context.output;
		const result = await exportOffscreenVideo({
			startFrame, endFrame: resolvedEndFrame, fps: TIMELINE_FPS,
			width: output.width, height: output.height,
			capture: (frame, kind) => withExportFrame(frame, kind
				? () => renderPass(job.capture, job.capture.scene, shotCamRef.current, kind, null, { depthRange }) : null),
			decorate: passKind ? null : exportReviewDecoration,
			passKind, signal: job.controller.signal,
			onFrame: ({ index, frameCount }) => updateExportStatus(job, "encoding", {
				completedFrames: index + 1, frameCount, cancellable: true,
			}),
			onPhase: ({ phase, stage, cancellable }) => updateExportStatus(job, phase, { stage, cancellable }),
		});
		job.controller.signal.throwIfAborted();
		if (download) {
			const slate = (moveSequence?.slate ?? "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shot";
			// Default plate filename: const name = `cozyclay-${slate}.mp4`
			const name = fileName ?? `cozyclay-${slate}.mp4`;
			await saveExport(result.blob, name);
			setRecordedVideoName(name);
			setToast((isKo, ko) => ko(`${name} exported · ${result.frameCount} frames`, `${name} 내보내기 완료 · ${result.frameCount}프레임`, `${name} 已导出 · ${result.frameCount} 帧`));
			return { ...result, fileName: name };
		}
		return result;
	}

	function stopShotRecording() {
		const job = recRef.current;
		if (!job?.cancellable) return;
		job.controller.abort();
		updateExportStatus(job, "preparing", { message: ko("Cancelling at the current work boundary…", "현재 작업 경계에서 취소 중…") });
	}

	async function exportDepthVideo(shotId = null) {
		if (recRef.current) return null;
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		const target = shotId ? shots.find((entry) => entry.id === shotId) : shots[atPlayhead >= 0 ? atPlayhead : 0] ?? null;
		if (shotId && !target) return null;
		const startFrame = target && (shotId || !motion) ? target.startFrame : 0;
		const endFrame = target && (shotId || !motion) ? target.endFrame : Math.max(0, currentRecordFrameCount() - 1);
		return executeExportRequest(exportRequest("depth_video", async (job) => {
			if (!target) throw Object.assign(new Error("Add a shot before exporting depth video"), { exportFailureCode: "render_failed" });
			let depthRange = null;
			if (endFrame > startFrame) {
				const samples = [];
				for (let frame = startFrame; frame <= endFrame; frame += 1) {
					job.controller.signal.throwIfAborted();
					const depth = withExportFrame(frame, () => renderPass(job.capture, job.capture.scene, shotCamRef.current, "depth"));
					if (!depth) throw Object.assign(new Error("Depth capture failed"), { exportFailureCode: "render_failed" });
					let minGrey = 255;
					let maxGrey = 0;
					for (let index = 0; index < depth.length; index += 256) {
						minGrey = Math.min(minGrey, depth[index]);
						maxGrey = Math.max(maxGrey, depth[index]);
					}
					samples.push({ min: DEPTH_RANGE_M * (1 - maxGrey / 255), max: DEPTH_RANGE_M * (1 - minGrey / 255) });
					updateExportStatus(job, "preparing", { stage: "depth", completedFrames: frame - startFrame + 1,
						frameCount: endFrame - startFrame + 1, cancellable: true });
					await exportBoundary(job);
				}
				depthRange = depthRangeFromFrames(samples, shotCamRef.current.near, DEPTH_RANGE_M);
			}
			return runShotExport({ startFrame, endFrame, passKind: "depth", depthRange, fileName: "blocking-depth.mp4" }, job);
		}));
	}

	function exportPhaseLabel(phase) {
		return ({ preparing: ko("Preparing", "준비 중"), encoding: ko("Encoding", "인코딩 중"),
			finalizing: ko("Finalizing", "마무리 중"), completed: ko("Completed", "완료"),
			failed: ko("Failed", "실패"), cancelled: ko("Cancelled", "취소됨") })[phase] ?? "";
	}

	function exportFeedback() {
		if (!exportStatus) return null;
		const { phase, kind, message, completedFrames, frameCount, stage, cancellable, retryable, handedOff, label } = exportStatus;
		const busy = ["preparing", "encoding", "finalizing"].includes(phase);
		return (
			<section className="export-status" data-testid="export-status" data-phase={phase} data-kind={kind} role="status" aria-live="polite" aria-atomic="true">
				<strong>{exportPhaseLabel(phase)}{label ? ` · ${label}` : ""}</strong>
				{busy && <progress aria-label={exportPhaseLabel(phase)} max={frameCount} value={completedFrames} />}
				{frameCount && <p>{stage === "depth" ? ko("Depth range sampled", "뎁스 범위 샘플링") : ko("Frames submitted to encoder", "인코더에 전달한 프레임")}: {completedFrames} / {frameCount}</p>}
				{message && <p>{message}</p>}
				{busy && !message && <p>{stage === "mux"
					? ko("Finalizing MP4. Progress is indeterminate; this stage cannot be interrupted.", "MP4 마무리 중이에요. 진행률은 알 수 없으며 이 단계는 중단할 수 없어요.")
					: stage === "flush" ? ko("Finishing encoder output. Progress is indeterminate.", "인코더 출력을 마무리하고 있어요. 진행률은 알 수 없어요.")
					: kind === "frame" ? ko("Handing off existing PNGs. The file handoff cannot be cancelled.", "기존 PNG를 전달하고 있어요. 파일 전달은 취소할 수 없어요.")
					: stage === "archive" ? ko("Building the ZIP. Cancel takes effect after the current work unit, before the file handoff.", "ZIP을 만드는 중이에요. 취소는 현재 작업이 끝난 뒤 파일 전달 전에 적용돼요.")
					: stage === "depth" || stage === "frames" ? ko("Cancel stops at the next frame boundary, before the file handoff.", "취소하면 파일 전달 전 다음 프레임 경계에서 멈춰요.")
					: phase === "preparing" ? ko("Preparing the renderer and checking MP4 support…", "렌더러를 준비하고 MP4 지원을 확인하고 있어요…")
					: ko("Encoding the requested frames, not yet a completed file.", "요청한 프레임을 인코딩 중이에요. 아직 파일이 완성되지 않았어요.")}</p>}
				{retryable && <p>{ko("Retry keeps the original shot, camera, range and settings; it does not change your edits.", "다시 시도하면 원래 샷·카메라·범위·설정을 사용하며 편집 내용은 바꾸지 않아요.")}</p>}
				{handedOff > 0 && <p>{ko(`${handedOff} file(s) already handed off. Retry skips those files; check your export folder or browser downloads because OS saves cannot be confirmed.`, `파일 ${handedOff}개는 이미 전달했어요. 다시 시도할 때 해당 파일은 건너뛰어요. OS 저장은 확인할 수 없으니 내보내기 폴더나 브라우저 다운로드를 확인하세요.`, `已交付 ${handedOff} 个文件。重试时会跳过这些文件；由于无法确认系统保存，请检查导出文件夹或浏览器下载。`)}</p>}
				<div className="export-status-actions">
					{busy && cancellable && <button type="button" data-testid="export-cancel" onClick={stopShotRecording}>{ko("Cancel export", "내보내기 취소")}</button>}
					{retryable && <button type="button" data-testid="export-retry" disabled={recState === "recording"} onClick={() => void retryExport()}>{ko("Retry same export", "같은 내보내기 재시도")}</button>}
				</div>
			</section>
		);
	}

	async function downloadOtioCutList() {
		if (!shots.length) {
			setToast(ko("Add at least one Shot before exporting OTIO", "OTIO를 내보내려면 샷을 하나 이상 추가하세요"));
			return;
		}
		const attempt = startExportAttempt({ export_kind: "otio", format: "otio", surface: embedMode ? "embed" : "studio", objects: sceneObjects.length });
		try {
			const activeScene = scenes.find((scene) => scene.id === activeSceneId);
			const exportScene = {
				...playbackScene,
				name: activeScene?.name,
				activeCharacterId: activeChar.id,
				characters: characters.map((entry) => ({
					...entry,
					sessionMotion: entry.id === activeChar.id ? motion : entry.sessionMotion,
				})),
				objects: sceneObjects,
			};
			const serialized = serializeOtio(exportScene, shots);
			const blob = new Blob([serialized], { type: "application/json" });
			const slug = (activeScene?.name ?? "cut-list").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cut-list";
			await saveExport(blob, `cozyclay-${slug}.otio`); attempt.succeed();
			const frameCount = shots.reduce((total, shot) => total + shot.endFrame - shot.startFrame + 1, 0);
			setToast(ko(`OTIO saved · ${shots.length} shots · ${frameCount} frames`,
				`OTIO 저장됨 · ${shots.length}샷 · ${frameCount}프레임`,
				`OTIO 已保存 · ${shots.length} 个镜头 · ${frameCount} 帧`));
		} catch (error) {
			attempt.fail(error); setToast(error?.message || String(error));
		}
	}

	/* ======================= reference-pack exports (#165) =================
	 * Three deliverables a video model actually asks for, all built from the
	 * SAME offscreen capture rig the MP4 export uses, so what ships matches
	 * what the editor previewed:
	 *   - a per-shot keyframe pack (first/last frame, clip, camera, prompt),
	 *   - depth + normal conditioning passes of the current framing,
	 *   - a storyboard contact sheet of the whole cut.
	 */

	function loadImage(dataUrl) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("A captured frame could not be decoded"));
			image.src = dataUrl;
		});
	}

	function dataUrlToBytes(dataUrl) {
		const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	}

	// One frame of the shot as the recorder would draw it: applyExportFrame
	// poses every cast member and parks the shot camera for that absolute
	// frame, exactly as the MP4 pass does. Bones and camera are put back
	// afterwards, so a pack built mid-session leaves the viewport untouched.
	function captureShotFramePng(frame) {
		const buffer = withExportFrame(frame);
		try { return buffer ? bufferToPng(buffer) : null; }
		catch (error) {
			throw Object.assign(new Error(error?.message || String(error), { cause: error }), { exportFailureCode: exportFailureCode(error, "render_failed") });
		}
	}

	// The framing the shot camera stands in at a frame, in the same shape the
	// camera keys use — camera.json carries it so a tool can rebuild the pull.
	function shotFramingAtFrame(entry, frame) {
		const context = recRef.current?.request.context;
		const sampled = sampleAt(context?.playbackScene ?? playbackScene, entry, frame).camera ?? context?.framing;
		if (!sampled) return null;
		return { pos: { x: sampled.pos.x, y: sampled.pos.y, z: sampled.pos.z }, yaw: sampled.yaw, pitch: sampled.pitch, fovDeg: sampled.fovDeg };
	}

	function packMetaForShot(entry, shotIndex) {
		return shotCaptureMeta({
			shot: entry,
			shotIndex,
			stage: { keyLight },
			cast: characters,
			fps: tlFps,
			aspectKey: shotAspectKey,
			size: { width: shotOutput.width, height: shotOutput.height },
			frame: entry.startFrame,
			// The shot's camera block stores the MOVE; the lens lives on the
			// stage, so the live focal length fills in when the block has none.
			lens: { focalMm: shot.focalMm, fovDeg },
		});
	}

	// Build one shot's pack: both endpoint frames, the clip between them, the
	// camera state and the prompt. Returns the archive bytes plus the entry
	// names, so the download path, the embed message and QA all share it.
	async function buildShotKeyframePack(entry, index, onProgress = null, job = null) {
		// Embed/Workflow and the public QA API already own their lifecycle. The
		// shared lock still covers their endpoint captures and archive stages.
		if (!job) {
			const snapshot = structuredClone(entry);
			return executeExportRequest(exportRequest("keyframe_pack",
				(ownedJob) => buildShotKeyframePack(snapshot, index, onProgress, ownedJob), { external: true, download: false }));
		}
		updateExportStatus(job, "preparing", { stage: "frames", cancellable: true });
		await exportBoundary(job);
		const packShot = { title: entry.name, index: index + 1, startFrame: entry.startFrame, endFrame: entry.endFrame };
		onProgress?.(ko(`Rendering frames for "${entry.name}"`, `"${entry.name}" 프레임 렌더링 중`, `正在渲染“${entry.name}”的帧`));
		const firstUrl = captureShotFramePng(entry.startFrame);
		if (!firstUrl) throw Object.assign(new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요")), { exportFailureCode: "render_failed" });
		await exportBoundary(job);
		const lastUrl = entry.endFrame > entry.startFrame ? captureShotFramePng(entry.endFrame) : null;
		await exportBoundary(job);
		onProgress?.(ko(`Recording the clip for "${entry.name}"`, `"${entry.name}" 클립 녹화 중`, `正在录制“${entry.name}”的片段`));
		const recorded = await runShotExport({ startFrame: entry.startFrame, endFrame: entry.endFrame, download: false }, job);
		updateExportStatus(job, "finalizing", { stage: "archive", cancellable: true });
		await exportBoundary(job);
		const clipBytes = new Uint8Array(await recorded.blob.arrayBuffer());
		job.controller.signal.throwIfAborted();
		const meta = packMetaForShot(entry, index);
		const entries = keyframePackEntries({
			shot: packShot,
			fps: tlFps,
			firstFramePng: dataUrlToBytes(firstUrl),
			lastFramePng: lastUrl ? dataUrlToBytes(lastUrl) : null,
			clip: { data: clipBytes, ext: recorded.mimeType === "video/webm" ? "webm" : "mp4" },
			camera: {
				...meta,
				framing: {
					start: shotFramingAtFrame(entry, entry.startFrame),
					end: shotFramingAtFrame(entry, entry.endFrame),
				},
			},
			prompt: buildShotPrompt(meta, { target: "video" }),
		});
		const bytes = buildZip(entries);
		// ZIP construction is synchronous: cancellation takes effect after that
		// work unit, before any file is handed off or the next shot is started.
		await exportBoundary(job);
		return { name: keyframePackName(packShot), entries, bytes };
	}

	// The shot a pack is built for: an explicit id, else the one under the
	// playhead, else the first authored shot.
	function shotIndexForPack(shotId = null) {
		if (shotId) {
			const index = shots.findIndex((entry) => entry.id === shotId);
			if (index < 0) throw new Error(`Unknown shots ID: ${shotId}`);
			return index;
		}
		if (!shots.length) throw new Error(ko("Add at least one Shot before exporting a keyframe pack", "키프레임 팩을 내보내려면 샷을 하나 이상 추가하세요"));
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		return atPlayhead >= 0 ? atPlayhead : 0;
	}

	/** Download the keyframe pack for one shot, or (Shift) for every shot. */
	async function exportKeyframePacks(everyShot = false, shotId = null) {
		if (recRef.current) return null;
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		const current = shotId ? shots.findIndex((entry) => entry.id === shotId) : atPlayhead >= 0 ? atPlayhead : 0;
		if (shotId && current < 0) return null;
		const targets = everyShot ? shots.map((_, index) => index) : [current];
		return executeExportRequest(exportRequest("keyframe_pack", async (job) => {
			if (!job.request.context.shots.length) throw new Error(ko("Add at least one Shot before exporting a keyframe pack", "키프레임 팩을 내보내려면 샷을 하나 이상 추가하세요"));
			for (const [order, index] of targets.entries()) {
				if (job.request.handedOff.has(index)) continue;
				job.label = ko(`Shot ${order + 1} of ${targets.length}`, `샷 ${order + 1} / ${targets.length}`, `镜头 ${order + 1} / ${targets.length}`);
				const pack = await buildShotKeyframePack(job.request.context.shots[index], index, null, job);
				job.controller.signal.throwIfAborted();
				await saveExport(new Blob([pack.bytes], { type: "application/zip" }), pack.name);
				job.request.handedOff.add(index);
				setToast(ko(`${pack.name} exported · ${pack.entries.length} files`, `${pack.name} 내보내기 완료 · 파일 ${pack.entries.length}개`, `${pack.name} 已导出 · ${pack.entries.length} 个文件`));
				await exportBoundary(job);
			}
		}));
	}

	/** Depth and normal conditioning passes of the framing on screen now. */
	async function exportRenderPasses() {
		const attempt = startExportAttempt({ export_kind: "render_pass", format: "png", surface: embedMode ? "embed" : "studio", objects: sceneObjects.length });
		let handedOff = 0;
		try {
			const dataUrls = renderPassDataUrls();
			for (const kind of ["depth", "normal"]) { await saveExport(dataUrls[kind], passFileName(kind)); handedOff += 1; }
			setToast(ko("Depth and normal passes exported", "뎁스·노멀 패스를 내보냈어요"));
			attempt.succeed(); trackFeature("export_render_pass");
		} catch (error) {
			attempt.fail(error, "render_failed", handedOff); setToast(error?.message || String(error));
		}
	}

	// Both passes of the framing the shot camera stands in right now, as PNG
	// data URLs. The rig draws through that same camera for the RGB plate, so
	// the three images register pixel for pixel.
	function renderPassDataUrls(kinds = ["depth", "normal"]) {
		const capture = captureRef.current;
		const cam = shotCamRef.current;
		if (!capture || !cam) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
		const output = {};
		for (const kind of kinds) {
			const dataUrl = renderPass(capture, capture.scene, cam, kind, bufferToPng);
			if (!dataUrl) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
			output[kind] = dataUrl;
		}
		return output;
	}

	// One storyboard panel as a picture: the shot's first frame through the
	// offscreen capture rig, as a PNG data URL (null while the renderer has no
	// frame). The contact sheet and the Board dock tab share it.
	function capturePanelThumbnail(entry) {
		return captureShotFramePng(entry.startFrame);
	}

	/** Contact sheet of the whole cut: one thumbnail and prompt per shot. */
	async function exportStoryboard() {
		const attempt = startExportAttempt({ export_kind: "storyboard", format: "png", surface: embedMode ? "embed" : "studio", objects: sceneObjects.length });
		try {
			if (!shots.length) throw new Error(ko("Add at least one Shot before exporting a storyboard", "스토리보드를 내보내려면 샷을 하나 이상 추가하세요"));
			setToast(ko("Composing the storyboard…", "스토리보드 구성 중…"));
			const cells = [];
			for (const [index, entry] of shots.entries()) {
				const dataUrl = capturePanelThumbnail(entry);
				const meta = packMetaForShot(entry, index);
				cells.push({
					title: storyboardLine(`${index + 1}. ${entry.name}`),
					durationSeconds: Number(((entry.endFrame - entry.startFrame + 1) / tlFps).toFixed(2)),
					// The sheet gives each shot one caption line, and the composer draws
					// it unwrapped: the labelled prompt is folded down to the two lines a
					// board is read for (what the shot is, and on what lens), cut to what
					// fits the cell. The pack's prompt.txt keeps the full block.
					prompt: storyboardCaption(buildShotPrompt(meta, { target: "image" })),
					image: dataUrl ? await loadImage(dataUrl) : null,
				});
			}
			const canvas = composeStoryboard({
				shots: cells,
				columns: Math.min(3, cells.length),
				// 480x300 leaves a 464x164 thumbnail box (16:9 lands at 464x261 before
				// the fit, so the frame is scaled to height) and a caption block wide
				// enough for the 90 characters the composer draws at this size.
				cell: { width: 480, height: 300 },
				createCanvas: storyboardCanvas,
			});
			await saveExport(canvas.toDataURL("image/png"), "cozyclay-storyboard.png");
			setToast(ko(`Storyboard saved · ${cells.length} shots`, `스토리보드 저장됨 · ${cells.length}샷`, `故事板已保存 · ${cells.length} 个镜头`));
			attempt.succeed(); trackFeature("export_storyboard");
		} catch (error) {
			attempt.fail(error); setToast(error?.message || String(error));
		}
	}

	function storyboardCanvas(width, height) {
		const element = document.createElement("canvas");
		element.width = width;
		element.height = height;
		const ctx = element.getContext("2d");
		// The sheet is a deliverable, so it uses the studio's own type
		// stack rather than the canvas default (10px sans-serif).
		ctx.font = STORYBOARD_FONT;
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		return element;
	}

	/* ===================== storyboard exports (#644) =======================
	 * A storyboard project's panels are its stills, in still order. Each
	 * export runs as one export job (status panel, cancel, retry, analytics
	 * export_kind contact_sheet | panel_pack | animatic) and draws its frames
	 * through withExportFrame, so per-panel cast overrides and proxy paths
	 * land exactly as the preview shows them.
	 */

	function storyboardPanels(list = shots) {
		return list.filter((entry) => entry.kind === "still").sort((a, b) => a.startFrame - b.startFrame);
	}

	const noPanelsMessage = () => ko("Add a panel first — storyboard exports describe panels", "패널을 먼저 추가하세요 — 스토리보드 내보내기는 패널을 담습니다");

	// The panel's stylized picture as PNG bytes, or null when it has none (or
	// its asset is gone from this browser).
	async function panelStylizedPng(entry) {
		if (!entry.stylizedAssetId) return null;
		const record = await assetRecord(entry.stylizedAssetId);
		if (!record) {
			console.warn(`[cozyclay] stylized panel ${entry.stylizedAssetId} is missing; exporting the greybox only`);
			return null;
		}
		const bytes = new Uint8Array(record.bytes);
		if (record.type === "image/png") return bytes;
		const bitmap = await createImageBitmap(new Blob([bytes], { type: record.type }));
		try {
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
			return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
		} finally {
			bitmap.close();
		}
	}

	async function loadPngBytes(bytes) {
		const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
		try { return await loadImage(url); }
		finally { URL.revokeObjectURL(url); }
	}

	const panelFolder = (order) => `panel-${String(order + 1).padStart(2, "0")}`;

	/** Contact sheet of the storyboard: the stylized picture with the greybox
	 * inset when a panel has one, and the panel caption under it. */
	async function exportContactSheet() {
		if (recRef.current) return null;
		if (!storyboardPanels().length) { setToast(noPanelsMessage()); return null; }
		return executeExportRequest(exportRequest("contact_sheet", async (job) => {
			const all = job.request.context.shots;
			const panels = storyboardPanels(all);
			updateExportStatus(job, "preparing", { stage: "frames", cancellable: true });
			const cells = [];
			for (const [order, entry] of panels.entries()) {
				const dataUrl = captureShotFramePng(entry.startFrame);
				if (!dataUrl) throw Object.assign(new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요")), { exportFailureCode: "render_failed" });
				const stylized = await panelStylizedPng(entry);
				const meta = packMetaForShot(entry, all.indexOf(entry));
				cells.push({
					title: storyboardLine(`${order + 1}. ${entry.name}`),
					durationSeconds: Number(((entry.endFrame - entry.startFrame + 1) / tlFps).toFixed(2)),
					prompt: storyboardCaption(buildShotPrompt(meta, { target: "image" })),
					caption: storyboardLine((entry.caption ?? "").trim()),
					image: await loadImage(dataUrl),
					stylized: stylized ? await loadPngBytes(stylized) : null,
				});
				await exportBoundary(job);
			}
			const canvas = composeStoryboard({ shots: cells, columns: Math.min(3, cells.length), cell: { width: 480, height: 300 }, createCanvas: storyboardCanvas });
			job.controller.signal.throwIfAborted();
			await saveExport(canvas.toDataURL("image/png"), "cozyclay-storyboard.png");
			setToast(ko(`Contact sheet exported · ${cells.length} panels`, `콘택트 시트 내보내기 완료 · 패널 ${cells.length}개`, `缩略图总览已导出 · ${cells.length} 个面板`));
			return { fileName: "cozyclay-storyboard.png", panelCount: cells.length };
		}));
	}

	// One panel's pack: the greybox as first.png, the stylized picture when
	// there is one, the still's camera and hold, and the image prompt plus caption.
	async function panelPackArgs(entry, order, all) {
		const firstUrl = captureShotFramePng(entry.startFrame);
		if (!firstUrl) throw Object.assign(new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요")), { exportFailureCode: "render_failed" });
		const meta = packMetaForShot(entry, all.indexOf(entry));
		const caption = (entry.caption ?? "").trim();
		return {
			shot: { title: entry.name, index: order + 1, startFrame: entry.startFrame, endFrame: entry.endFrame, kind: "still" },
			fps: tlFps,
			firstFramePng: dataUrlToBytes(firstUrl),
			lastFramePng: null,
			clip: null,
			stylizedPng: await panelStylizedPng(entry),
			camera: { ...meta, framing: { start: shotFramingAtFrame(entry, entry.startFrame) } },
			prompt: buildShotPrompt(meta, { target: "image" }) + (caption ? `\nCAPTION: ${caption}` : ""),
			folder: panelFolder(order),
		};
	}

	/** Panel pack (zip) for one panel — the given one, else the selected one,
	 * else the one under the playhead, else the first — or, with `every`, one
	 * zip holding a panel-NN/ folder per panel. */
	async function exportPanelPacks(every = false, shotId = null) {
		if (recRef.current) return null;
		const panels = storyboardPanels();
		if (!panels.length) { setToast(noPanelsMessage()); return null; }
		const target = shotId ? panels.find((entry) => entry.id === shotId)
			: panels.find((entry) => entry.id === activeShot?.id)
			?? panels.find((entry) => tlFrame >= entry.startFrame && tlFrame <= entry.endFrame) ?? panels[0];
		if (!target) return null;
		return executeExportRequest(exportRequest("panel_pack", async (job) => {
			const all = job.request.context.shots;
			const contextPanels = storyboardPanels(all);
			const targets = every ? contextPanels : contextPanels.filter((entry) => entry.id === target.id);
			updateExportStatus(job, "preparing", { stage: "frames", cancellable: true });
			const packs = [];
			for (const [step, entry] of targets.entries()) {
				job.label = ko(`Panel ${step + 1} of ${targets.length}`, `패널 ${step + 1} / ${targets.length}`, `面板 ${step + 1} / ${targets.length}`);
				packs.push(await panelPackArgs(entry, contextPanels.indexOf(entry), all));
				await exportBoundary(job);
			}
			updateExportStatus(job, "finalizing", { stage: "archive", cancellable: true });
			await exportBoundary(job);
			const entries = packs.flatMap((args) => keyframePackEntries(args));
			const bytes = every ? buildZip(entries) : buildKeyframePack(packs[0]);
			const name = every ? "cozyclay-panels.zip" : `cozyclay-${packs[0].folder}-${slugifyTitle(target.name)}.zip`;
			await exportBoundary(job);
			await saveExport(new Blob([bytes], { type: "application/zip" }), name);
			setToast(ko(`${name} exported · ${entries.length} files`, `${name} 내보내기 완료 · 파일 ${entries.length}개`, `${name} 已导出 · ${entries.length} 个文件`));
			return { fileName: name, entries: entries.map((entry) => entry.name) };
		}));
	}

	/** Animatic (mp4): every panel held for its hold, from frame 0 to the last
	 * still's end, at the production fps. */
	async function exportAnimatic() {
		if (recRef.current) return null;
		const panels = storyboardPanels();
		if (!panels.length) { setToast(noPanelsMessage()); return null; }
		const endFrame = panels.at(-1).endFrame;
		return executeExportRequest(exportRequest("animatic",
			(job) => runShotExport({ startFrame: 0, endFrame, fileName: "cozyclay-animatic.mp4" }, job)));
	}

	function captureCurrentFraming() {
		const cam = shotCamRef.current;
		const pos = cam ? cam.position : cameraPos;
		return captureFraming({ pos: { x: pos.x, y: pos.y, z: pos.z }, yaw: look.current.yaw, pitch: look.current.pitch, fovDeg });
	}

	// What a framing capture says about the shot it came from: lens, delivery
	// aspect, cast, cut range and the video model the shot is aimed at. Both
	// capture paths (the live command and the embed message) attach this, so a
	// still handed to a generator arrives with its production notes.
	// A frame that falls in a gap between shots describes the first shot — a
	// pull still belongs to the piece even when the playhead sits outside a cut.
	/**
	 * The reference pictures a capture travels with (#167): every visible cast
	 * member's identity sheet, then the set's environment reference. Slots that
	 * are empty simply do not appear — the array is the pictures that EXIST,
	 * never a fixed-length list with holes in it, so a consumer can attach the
	 * whole thing without filtering.
	 */
	function captureShotReferences() {
		const references = characters
			.filter((entry) => !entry.hidden && typeof entry.identityImage === "string" && entry.identityImage)
			.map((entry) => ({ role: "character", name: entry.subject || entry.id, dataUrl: entry.identityImage }));
		if (typeof environmentImage === "string" && environmentImage) {
			references.push({ role: "environment", dataUrl: environmentImage });
		}
		return references;
	}

	function captureShotMeta(frame) {
		const index = shotIndexAtFrame(shots, frame);
		const resolvedIndex = index >= 0 ? index : shots.length ? 0 : null;
		return shotCaptureMeta({
			shot: resolvedIndex == null ? null : shots[resolvedIndex],
			shotIndex: resolvedIndex,
			stage: { keyLight },
			cast: characters,
			fps: tlFps,
			aspectKey: shotAspectKey,
			size: { width: shotOutput.width, height: shotOutput.height },
			frame,
			lens: { focalMm: shot.focalMm, fovDeg },
		});
	}

	// The Inspector is driven by the hierarchy selection alone — there are no
	// sidebar tabs. Every panel belongs to the thing that owns it: the scene
	// owns what gets generated, the camera owns the lens, and a character owns
	// its pose and its motion.
	const isCameraSelection = selectedHierarchyId === "camera";
	const isCharacterSelection = selectedHierarchyId === "characters"
		|| selectedHierarchyId === "characterA"
		|| selectedHierarchyId === "characterB"
		|| selectedHierarchyId.startsWith("character:");
	// The View menu's three toggles, as the menu reads them: one radio choice
	// for the part colours, and a dot on the trigger whenever the viewport is
	// showing something other than the plain stage.
	const partColoursChoice = partColoursEnabled ? partColoursMode : "off";
	const viewLooksActive = gridView || autoColor || partColoursEnabled || guideMode !== "off";
	const rigSelection = parseRigNodeId(selectedHierarchyId);
	const isRigSelection = rigSelection !== null;
	// The scene row owns no settings of its own, so it leaves the empty-panel hint up rather than a blank column.
	const inspectorHasContent = isCameraSelection || isCharacterSelection || isRigSelection
		|| selectedHierarchyId === "environment" || selectedHierarchyId === "props" || selectedHierarchyId === "light" || Boolean(selectedSceneObject) || sculptMode;

	// Startup idle work, once.
	const startupWarmed = useRef(false);
	useEffect(() => {
		if (startupWarmed.current) return;
		startupWarmed.current = true;
		// Parse the thumbnail rigs during startup idle so the first pose-studio
		// open starts rendering immediately instead of paying a 100ms+ FBX parse.
		warmPoseThumbnails();
		if (startupCreatedScene) track("scene:created", { scene_source: "startup" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Drive every cast member from ITS OWN clip on the shared playhead. The
	// active character's buffer motion and the stored session motions of the
	// others all advance together; characters without a clip keep their pose.
	// Without the inactive pass a focus switch silently reverted everyone else
	// to their uncorrected take.
	useEffect(() => {
		// The ACTIVE member's clip only: its own corrections are applied by the
		// evaluate effect below, after its editing state settles.
		if (activeCapabilities.rig) poseMemberAtFrame(rigs[activeChar.id], motion, null, tlFrame);
		poseOtherCastMembers(tlFrame);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [characters, activeChar.id, motion, rigs, tlFrame, ikTick]);

	// The shared timeline spans the longest CURRENT content on the production
	// clock. Recomputing both directions matters: deleting Subject 2 or
	// shortening its take must pull the end back in instead of leaving the
	// recorder with frozen tail frames (#80).
	useEffect(shotsDomain.syncTimelineExtent, [characters, activeChar.id, motion, shots]);

	/* ------------------------------ IK logic ------------------------------ */

	// Resolve the IK rig (chains + FK swing joints) whenever the ACTIVE
	// character's rig (re)loads. A rig missing any bone resolves to null and
	// IK mode stays unavailable.
	useEffect(() => {
		const resolved = activeCapabilities.ik ? resolveIkRig(activeRig) : null;
		const chains = resolved ? resolved.chains : null;
		setIkChains(chains);
		setIkFkJoints(resolved ? resolved.fkJoints : null);
		ikStateRef.current.chains = chains;
		// Cached on the state so this character's corrections stay evaluable
		// after a focus switch (#77) — the playback and export loops read them.
		ikStateRef.current.fkJoints = resolved ? resolved.fkJoints : null;
		ikStateRef.current.rig = chains ? activeRig : null;
		if (!chains) leaveIkMode();
	}, [activeRig, activeCapabilities.ik]);

	// Keyed-pose playback: the IK layer's keyed bone rotations apply at the
	// current frame whether or not IK edit mode is on — IK-authored keys are
	// the source of truth (the user designs first/end keys and ARDY in-
	// betweens them), so scrubbing/playing with IK OFF must still show them.
	// With a motion loaded the clip is the base layer: this effect runs
	// AFTER the motion-apply effect above (definition order), so the keys
	// override the generated pose exactly where corrections were authored —
	// and ONLY there: the blend window eases each correction back to the
	// clip outside its keyed range, so keying frame 39 alone no longer
	// stomps every earlier frame. Skipped while the pose studio is open (FK
	// edits there would be stomped). With no keys at all and IK off there is
	// nothing to apply — pure FK posing / pure motion playback stays
	// untouched.
	useEffect(() => {
		// On a selection switch this runs once before the resolve effect's
		// setIkChains lands: the chains still pose the previous character.
		if (!ikChains || !activeRig || posing || ikChains.values().next().value?.rig !== activeRig) return;
		// Preview changes may re-run this effect without a playhead change.
		// Always re-establish the motion base before adding a correction.
		if (motion) poseMemberAtFrame(activeRig, motion, null, tlFrame);
		const layer = pendingIkEdit?.characterId === activeChar.id ? pendingIkEdit.candidate : ikStateRef.current;
		if (ikMode || layer.keys.size > 0) {
			ikEvaluate(ikChains, layer, tlFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints, pendingIkEdit, activeChar.id]);

	// Re-seat the handles on the keyed pose when the FRAME changes with IK
	// on — scrubbing to frame 39 shows that frame's interpolated pose AND
	// places the handles on its effectors, ready to edit into a new key.
	// Deliberately NOT in the evaluate effect above: a gizmo axis drag can
	// leave the target offset from the effector on purpose, and re-seeding
	// after every bake would wipe that relationship mid-workflow.
	const ikPrevFrameRef = useRef(tlFrame);
	useEffect(() => {
		const frameChanged = ikPrevFrameRef.current !== tlFrame;
		ikPrevFrameRef.current = tlFrame;
		if (!ikMode || !ikChains || !activeRig || posing || ikChains.values().next().value?.rig !== activeRig) return;
		if (!frameChanged) return; // pure toggle-on: evaluate already ran
		ikSeedTargets(ikChains, ikStateRef.current);
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints]);

	// QA hook: lets headless visual checks read the live rig/motion state
	// (test/motion3/qa-motion3-*-browser.mjs). Harmless in normal use.
	useEffect(() => {
	window.__cozyclay = {
			runStudioAction, setFrame: setTlFrame, setPlaying: setTlPlaying,
			rigA: activeRig, motion, tlFrame, frameCount: tlFrameCount, playing: tlPlaying, ikMode, ikChains, ikFocus, contactRadii: ikChains?.values().next().value?.contactRadii ?? null, ik: ikStateRef.current,
			rangePins, rangePinResiduals,
			rangePinApplySpec: motionDomain.rangePinApplySpec,
			rangePinEffector: (track) => {
				const chain = ikChains?.get(track), bone = chain?.bones?.[2];
				if (!bone) return null;
				const point = new THREE.Vector3(); bone.getWorldPosition(point);
				return point.toArray();
			},
			committedIkEdits, waypoints, rigs, characters, // rigs/characters: every cast member (QA reads a second rig)
			// Scene props as the stage sees them, for QA that places a box and
			// waits for its transform to land before fitting to it.
			objects: sceneObjects,
			// the camera the main view renders through (poser in IK mode) — QA
			// projections must use this one, not the frozen shot camera
			activeCam: ikMode ? poserCamRef.current : lookThroughShot ? shotCamRef.current : editorCamRef.current,
			shotCam: shotCamRef.current,
			poserCam: poserCamRef.current,
			planCam: planCamRef.current,
			editorCam: editorCamRef.current,
			// QA-only: swap the active character's body ("x-bot-tpose" / "y-bot-tpose")
			// or stature, so a browser QA run can check every shipped rig.
			setCharacterModel: (id) => updateCharacterAt(activeCharIndex, { model: id }),
			setPartColours: (enabled, mode = "shaded") => {
				setPartColoursEnabled(!!enabled);
				setPartColoursMode(mode === "flat" ? "flat" : "shaded");
			},
			setCharacterScale: (scale) => updateCharacterAt(activeCharIndex, { scale }),
			// QA-only: the production notes a framing capture carries (lens,
			// delivery aspect, cast, cut range, target video model) for the frame
			// the playhead is on — the same object both capture paths attach.
			// Read through liveStateRef, which every render refreshes: this hook's
			// effect does not depend on the shot list, so a closure over it would
			// answer with the cut as it stood when the effect last ran.
			captureMeta: (frame) => appContext.live.state.captureShotMeta(frame ?? appContext.live.state.timeline.currentFrame),
			activeShotId: () => appContext.live.state.activeShotId, shotCameraKeyCount: (shotId) => appContext.live.state.shots.find(entry => entry.id === shotId)?.cameraKeys.length ?? 0,
			// QA-only reference slots (#167): set the pictures a headless run cannot
			// reach through a file dialog, then take the capture the live
			// capture_framing_png command returns — references included.
			setCharacterIdentityImage: (index, dataUrl) => {
				updateCharacterAt(index, { identityImage: normalizeReferenceImage(dataUrl) });
				return true;
			},
			setEnvironmentImage: (dataUrl) => {
				runStudioAction("stage.setEnvironment", { environmentImage: normalizeReferenceImage(dataUrl) });
				return true;
			},
			captureWithReferences: () => liveQueries.capture_framing_png({}),
			importAsset: async ({ dataUrl: source, ...args }) => (await appContext.bus.run("asset.import", { source, ...args })).output,
			sceneObject: { place: ({ kind, name, parent, ...placement }) => ({ id: appContext.bus.run("object.add", { kind, ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { parent }), placement }).affectedIds[0] }), update: ({ id, scale, ...patch }) => appContext.bus.run("object.update", { id, patch: { ...(scale === undefined ? {} : { scaleX: scale, scaleY: scale, scaleZ: scale }), ...patch } }) },
			// QA-only reference exports (#165): the production builders without the
			// download, so a headless run can unzip a real pack and diff the passes
			// instead of driving a file dialog. Same liveStateRef reasoning as
			// captureMeta — the effect does not depend on the shot list.
			exportKeyframePack: async (shotId) => {
				const live = appContext.live.state;
				const index = live.shotIndexForPack(shotId ?? null);
				const pack = await live.buildShotKeyframePack(live.shots[index], index);
				// base64: a pack holds an MP4, and a megabyte-scale JS number array
				// is not something to hand a CDP evaluate.
				let binary = "";
				for (const byte of pack.bytes) binary += String.fromCharCode(byte);
				return { name: pack.name, entries: pack.entries.map((entry) => entry.name), byteLength: pack.bytes.byteLength, bytes: btoa(binary) };
			},
			renderPass: (kind) => appContext.live.state.renderPassDataUrls([kind])[kind],
			// QA-only video export (#193): the Export menu's Video item without the
			// download, so a headless run can assert that a keyless 40-frame static
			// shot yields 40 frames. Same liveStateRef reasoning as captureMeta.
			exportShotVideo: (options = {}) => appContext.live.state.exportShotVideo(options),
			// Open the production result modal so QA clicks its real download.
			prepareFrameExport: () => { appContext.live.state.generate(); },
			// The RGB plate the passes are compared against — same rig, same
			// framing, no material override.
			capturePlate: () => appContext.live.state.captureFramingPng(appContext.live.state.captureCurrentFraming()),
			captureFraming: (framing, output) => appContext.live.state.captureFramingPng(framing, output),
			characterScale: activeChar?.scale ?? 1,
			characterModel: activeChar?.model ?? null,
			// QA framing: the same move as run_action view.frame, without leaving Look Through.
			frameEditorCam: (position, target) => frameEditorView(editorCamRef.current, editorLook.current, position, target),
			lookThroughShot,
			setLookThrough: (value) => setLookThroughShot(!!value),
			charA,
			insetPane: insetPaneRef.current,
			mainPane: mainPaneRef.current,
			// the selected prop's route, so QA can aim a gesture at the line
			objectPath: routeOwner?.path ?? null,
			objectPathOwnerId: routeOwner?.id ?? null,
			pathPointIndex,
			pathHandlesEnabled: !preview && !lookThroughShot && !ikMode && !posing && !!routeOwner?.path,
			addSceneObject: (kind, placement = {}) => addSceneObject(kind, placement),
			scrub: (frame) => setTlFrame(Math.max(0, Math.min(tlFrameCount - 1, Math.round(frame)))),
			pause: () => setTlPlaying(false),
			
			// QA-only IK drag seam: resolves the same production solve/end path as
			// the viewport manipulator, with a deterministic world-space offset.
			ikPreviewApply: (track = "leftHand", offset = { x: 0.02, y: 0, z: 0 }) => {
				const chain = ikChains?.get(track), bone = chain?.bones?.[2];
				if (!bone) return false;
				const target = bone.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(offset.x ?? 0, offset.y ?? 0, offset.z ?? 0));
				ikSolve("chain", track, target);
				ikDragEnd();
				return true;
			},
			preview,
			pathDraw,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeRig, motion, tlFrame, tlFrameCount, ikMode, ikChains, ikFocus, ikTick, charA, rangePins, rangePinResiduals, committedIkEdits, waypoints, lookThroughShot, selectedSceneObject, sceneObjects, rigs, characters, pathPointIndex, preview, posing, playMode, pathDraw, pendingIkEdit, ikEditTool]);
	// QA hook (plan §6.5): exposes history depth and the present === objects
	// invariant so the browser suite can assert undo entry counts directly.
	// Reads live store state at call time; re-registered after every render.
	useEffect(() => {
		window.__sceneHistory = () => ({ ...store.depths(), settled: store.present() === store.objects });
	});
	// QA-only project-file seam: browser acceptance tests still exercise the
	// production serializer/parser and apply path without depending on native
	// file-picker UI, which headless Chrome does not expose consistently.
	useEffect(() => {
		window.__cozyclayProject = {
			export: (name = "QA Project") => collectProjectSerialized(name),
			open: async (text) => {
				const result = readProjectDocument(text);
				if (!result.ok) return result;
				await rehydrateProjectAssets(result.project, result.warnings);
				applyProject(result.project);
				setToast(`${ko(`Project opened: ${result.project.name}`, `프로젝트 열림: ${result.project.name}`, `项目已打开：${result.project.name}`)}${projectProblemsNotice(result.problems)}`);
				return result;
			},
			manifest: () => projectManifest,
			saveBlocked: () => saveBlockedReasons,
		};
		return () => {
			if (window.__cozyclayProject?.export) delete window.__cozyclayProject;
		};
	});

	

	const playbackSceneBase = useMemo(() => ({
		frameCount: tlFrameCount,
		fps: tlFps,
		subject: charA,
		motion,
		cameraAnchor: charA,
		fovDeg,
		filmback,
	}), [tlFrameCount, tlFps, charA, motion, fovDeg, filmback]);
	// The camera's subject grouped under a routed object (#655) stands where
	// that object carries it: its played root through the object's carry,
	// frame by frame — the same carry the renderer gives the body. Null when it
	// rides nothing, so every reader below keeps the plain played root.
	const subjectCarry = useMemo(() => {
		if (!charA.parent) return null;
		const objects = new Map(sceneObjects.map((object) => [object.id, object]));
		const take = { frameCount: tlFrameCount, fps: tlFps };
		return (point, frame) => {
			if (!point) return point;
			const at = carriedPointAt(objects, charA.parent, { x: point.x, y: charA.y ?? 0, z: point.z }, frame, take);
			return { x: at.x, z: at.z };
		};
	}, [charA.parent, charA.y, sceneObjects, tlFrameCount, tlFps]);
	const motionPos = usePlaybackSubjectPosition({ motion, subjectCarry, scene: playbackSceneBase, frame: tlFrame });

	// The subject's full per-frame scene trajectory — what the follow camera
	// is derived from. Without a loaded motion, and riding nothing, the subject
	// stands still and the follow camera simply composes a static frame.
	const subjectTrack = useMemo(() => {
		if (!shots.some((shot) => shot.camera?.mode === "follow" || shot.camera?.mode === "rail")) return null;
		const frames = Math.max(tlFrameCount, 1);
		return Array.from({ length: frames }, (_, frame) => {
			const subject = sampleAt(playbackSceneBase, null, frame).subject;
			return subjectCarry ? subjectCarry(subject, frame) : subject;
		});
	}, [shots, playbackSceneBase, tlFrameCount, subjectCarry]);

	// The dense rail (spline through the drawn control points) — shared by
	// the follow controller and the Top-View display.
	const railCurve = useMemo(() => (cameraRail ? buildRail(cameraRail) : null), [cameraRail]);

	// A rail shot with an aim holds its cast (or a world point) instead of the subject.
	const followTrack = useShotCameraTracks({ shots, subjectTrack, subjectId: charA.id, fps: tlFps, yawDeg: charA.rot, filmback, characters, objects: sceneObjects, frameCount: tlFrameCount, activeId: activeChar.id, motion });

	const playbackScene = useMemo(() => playbackSceneWithTrack(playbackSceneBase, subjectTrack, followTrack), [playbackSceneBase, subjectTrack, followTrack]);

	// Browser acceptance seam: it invokes the exact production exporter but
	// suppresses the download, returning only serializable evidence.
	useEffect(() => {
		const api = async (options = {}) => {
			const { probeMetadata = false, ...range } = options;
			const { blob, ...result } = await runShotExport({ ...range, download: false });
			if (!probeMetadata) return { ...result, blobSize: blob.size };
			const url = URL.createObjectURL(blob);
			const video = document.createElement("video");
			let metadata;
			try {
				metadata = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("exported MP4 metadata timed out")), 5000);
					video.onloadedmetadata = () => {
						clearTimeout(timer);
						resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
					};
					video.onerror = () => {
						clearTimeout(timer);
						reject(new Error("browser could not decode exported MP4 metadata"));
					};
					video.preload = "metadata";
					video.src = url;
				});
			} finally {
				video.removeAttribute("src");
				video.load();
				URL.revokeObjectURL(url);
			}
			return { ...result, blobSize: blob.size, metadata };
		};
		window.__exportOffscreen = api;
		return () => {
			if (window.__exportOffscreen === api) delete window.__exportOffscreen;
		};
	});

	// The follow camera owns the shot camera in the same situations key
	// following would: never while an authoring mode holds the viewport.
	const followCamActive = followCameraActive(activeCamera.mode, followTrack, tlPlaying ? playbackFrame() : tlFrame, preview, ikMode, waypointMode, posing);

	// Implied locomotion speed per authored segment, on the timeline clock
	// (m/s is physical, so the judge always uses tlFps). Shown in the
	// timeline hint so a path that forces a crawl or a sprint is visible
	// before spending a generation on it.
	const pathSpeed = useMemo(() => {
		if (waypoints.length < 1) return null;
		let min = Infinity;
		let max = 0;
		const path = [rootStart(), ...[...waypoints].sort((a, b) => a.frame - b.frame)];
		for (let i = 1; i < path.length; i += 1) {
			const a = path[i - 1];
			const b = path[i];
			const seconds = (b.frame - a.frame) / tlFps;
			if (seconds <= 0) continue;
			const speed = Math.hypot(b.x - a.x, b.z - a.z) / seconds;
			min = Math.min(min, speed);
			max = Math.max(max, speed);
		}
		if (!Number.isFinite(min)) return null;
		return { min, max, warn: min < 0.5 || max > 3 };
	}, [activeChar.x, activeChar.z, tlFps, waypoints]);

	// A loaded take needs no badge: its clip on the Body lane already says so.
	const stateBadge = !motion && waypointMode ? { label: ko("ROOT PATH", "루트 경로"), kind: "root" } : null;

	function bufferToPng(buffer, output = shotOutput, decorate = null) {
		const canvas = document.createElement("canvas");
		if (output === shotOutput) {
			canvas.width = shotOutput.width;
			canvas.height = shotOutput.height;
		} else {
			canvas.width = output.width;
			canvas.height = output.height;
		}
		const ctx = canvas.getContext("2d");
		const image = ctx.createImageData(output.width, output.height);
		// WebGL reads bottom-up; flip into canvas order.
		for (let row = 0; row < output.height; row += 1) {
			const from = (output.height - 1 - row) * output.width * 4;
			image.data.set(
				buffer.subarray(from, from + output.width * 4),
				row * output.width * 4
			);
		}
		ctx.putImageData(image, 0, 0);
		decorate?.(ctx);
		return canvas.toDataURL("image/png");
	}

	/** Park the shot camera on a framing, read back an offscreen PNG, and put
	    everything back before the next paint — the viewport never sees it. */
	function captureFramingPng(framing, output = shotOutput) {
		const cam = shotCamRef.current;
		if (!cam || !captureRef.current) return null;
		const prev = { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: look.current.yaw, pitch: look.current.pitch, fov: cam.fov };
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		cam.rotation.order = "YXZ";
		cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg;
		const prevAspect = cam.aspect;
		const offset = framing.viewOffset;
		if (offset) {
			cam.aspect = offset.fullWidth / offset.fullHeight;
			cam.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
		}
		cam.updateProjectionMatrix();
		const needsOwnTarget = output.width !== shotOutput.width || output.height !== shotOutput.height;
		const capture = needsOwnTarget && typeof captureRef.current.createExportCapture === "function"
			? captureRef.current.createExportCapture(output)
			: captureRef.current;
		try {
			const buffer = capture.render();
			return buffer ? bufferToPng(buffer, output) : null;
		} finally {
			if (needsOwnTarget) capture.dispose?.();
			cam.position.set(prev.x, prev.y, prev.z);
			cam.rotation.set(prev.pitch, prev.yaw, 0);
			look.current.yaw = prev.yaw;
			look.current.pitch = prev.pitch;
			cam.fov = prev.fov;
			if (offset) {
				cam.clearViewOffset();
				cam.aspect = prevAspect;
			}
			cam.updateProjectionMatrix();
		}
	}

	/** A live capture command's requested `output` size, or null to use its default. */
	function requestedCaptureOutput(args) {
		const requested = args?.output;
		return Number.isFinite(requested?.width) && Number.isFinite(requested?.height)
			? { width: Math.round(requested.width), height: Math.round(requested.height) }
			: null;
	}

	/** The Top View as a PNG: a 2D data diagram drawn from editor state by
	    src/plan-diagram.js (grid, footprints, cast, every shot camera, the current
	    shot's action line and blocked sight lines). No render is involved. */
	function capturePlanPng(output = { width: 1280, height: 720 }) {
		const live = appContext.live.state, s = readStudioState();
		const canvas = document.createElement("canvas");
		canvas.width = output.width;
		canvas.height = output.height;
		drawPlanDiagram(canvas.getContext("2d"), { frame: s.view.frame, frameCount: s.frameCount, objects: s.objects, characters: s.characters, shotDocument: { shots: s.shots }, camera: s.camera },
			{ width: output.width, height: output.height, ports: { bounds: studioBounds }, currentShotId: live.activeShotId, aspect: shotOutput.width / shotOutput.height });
		return { dataUrl: canvas.toDataURL("image/png"), width: output.width, height: output.height, frame: live.timeline.currentFrame, shotId: live.activeShotId };
	}

	/** The canvas runs under the floating panels, so "what I see" is only the uncovered middle.
	    Returns the largest centred `aspect` rectangle inside that region as a camera view offset. */
	function visibleViewOffset(aspect) {
		const canvas = document.querySelector(".viewport canvas");
		if (!canvas) return null;
		const box = canvas.getBoundingClientRect();
		const edge = (selector, side) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			return rect && rect.width > 0 && rect.height > 0 ? rect[side] : null;
		};
		const left = Math.max(box.left, edge(".studio-left-column", "right") ?? box.left);
		const right = Math.min(box.right, edge(".studio-right-column", "left") ?? box.right);
		const top = Math.max(box.top, edge(".topbar", "bottom") ?? box.top);
		const bottom = Math.min(box.bottom, edge(".studio-dock-slot", "top") ?? box.bottom);
		if (right - left < 50 || bottom - top < 50) return null;
		const width = Math.min(right - left, (bottom - top) * aspect);
		const height = width / aspect;
		return {
			fullWidth: box.width, fullHeight: box.height,
			x: (left + right) / 2 - width / 2 - box.left, y: (top + bottom) / 2 - height / 2 - box.top,
			width, height,
		};
	}

	/** Pose mode's image generation: the shot camera's view of the pose as it stands, at the
	    delivery size, plus the scene's identity/environment references. The pose-mode object
	    fade is lifted for this draw only (props are re-synced right after, so a demand frame loop keeps it), and editor
	    overlays such as motion trails are hidden around it. */
	function capturePoseImage(source = "view") {
		const viewCam = source === "view" ? poserCamRef.current : null;
		let framing = captureCurrentFraming();
		if (viewCam) {
			const dir = viewCam.getWorldDirection(new THREE.Vector3());
			const pos = viewCam.getWorldPosition(new THREE.Vector3());
			framing = captureFraming({ pos, yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), fovDeg: viewCam.fov });
			framing.viewOffset = visibleViewOffset(shotOutput.width / shotOutput.height);
		}
		const scene = captureRef.current?.scene;
		const overlays = [];
		scene?.traverse((node) => {
			if (node.userData.editorOverlay && node.visible) { node.visible = false; overlays.push(node); }
		});
		try {
			const dataUrl = withPoseFadeLifted(propSyncRef.current, () => captureFramingPng(framing, shotOutput));
			return dataUrl ? { dataUrl, references: captureShotReferences() } : null;
		} finally {
			for (const node of overlays) node.visible = true;
		}
	}

	function copyPrompt(prompt) {
		const write = navigator.clipboard?.writeText(prompt);
		if (!write) return;
		write
			.then(() => {
				setCopied(true);
				setToast(ko("Prompt copied to clipboard", "프롬프트를 클립보드에 복사했어요"));
			})
			.catch(() => {});
	}

	function generate() {
		const model = mode === "image" ? IMAGE_MODELS.find((m) => m.id === imageModel) : null;
		// Generation follows the Camera Block owned by the Shot under the playhead.
		// Keys use their authored endpoints; Follow/Rail use the deterministic
		// track already used by playback, so prompt and conditioning describe the
		// same camera department instruction the editor previews.
		const movePlan = mode === "video" && activeCamera.mode === "keys" ? moveSequence : null;
		const trackedFramings = activeShot && activeCamera.mode !== "keys"
			? followTrack
				?.slice(activeShot.startFrame, activeShot.endFrame + 1)
				.filter(Boolean)
				.map((sample) => ({ ...sample, fovDeg })) ?? []
			: [];
		const blockFramings = activeCamera.mode === "keys"
			? cameraKeys.map((key) => key.framing)
			: trackedFramings;
		const framingA = blockFramings[0] ?? null;
		const framingB = blockFramings.length > 1 ? blockFramings[blockFramings.length - 1] : null;
		const promptSubject = activeShot && subjectTrack?.[activeShot.startFrame]
			? { ...charA, ...subjectTrack[activeShot.startFrame] }
			: charA;
		const blockMove = mode === "video" && activeShot && activeCamera.mode !== "keys"
			? activeCamera.mode === "rail"
				? "a continuous rail tracking move following the subject"
				: "a continuous follow-camera move maintaining the authored framing"
			: null;
		const prompt = composePrompt({
			mode,
			model,
			shot: movePlan?.fromShot ?? (framingA
				? deriveShot(framingA.pos, promptSubject, (framingA.fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback)
				: shot),
			subject,
			subject2: showB ? subject2 : null,
			posePhrase: poseA?.prompt ?? "",
			pose2Phrase: showB ? (poseB?.prompt ?? "") : "",
			environment,
			style,
			cameraMove: movePlan || blockMove ? CUSTOM_MOVE : cameraMove,
			customMove: movePlan?.phrase ?? blockMove ?? customMove,
			hasCharSheet,
			hasEnvSheet,
		});
		let frame = null;
		let frameB = null;
		if (activeCamera.mode === "keys" && cameraKeys.length) {
			frame = captureFramingPng(cameraKeys[0].framing);
			frameB = cameraKeys.length > 1 ? captureFramingPng(cameraKeys[cameraKeys.length - 1].framing) : null;
		} else if (framingA) {
			frame = captureFramingPng(framingA);
			frameB = framingB ? captureFramingPng(framingB) : null;
		} else {
			const buffer = captureRef.current?.render();
			frame = buffer ? bufferToPng(buffer) : null;
		}
		const nextResult = {
			prompt,
			frame,
			frameB,
			partColours: partColoursEnabled ? PART_COLOURS : null,
			move: movePlan,
			mode,
			modelLabel: model?.label,
			downloaded: false,
			shot: activeShot ? {
				id: activeShot.id,
				name: activeShot.name,
				startFrame: activeShot.startFrame,
				endFrame: activeShot.endFrame,
			} : null,
			fps: tlFps,
			aspectRatio: shotOutput.label,
			camera: activeShot ? {
				mode: activeCamera.mode,
				followCam: activeCamera.followCam,
				cameraRail: activeCamera.cameraRail,
				railFollow: activeCamera.railFollow,
				keys: cameraKeys,
			} : null,
			subjects: characters.filter((entry) => !entry.hidden).map((entry) => entry.subject ?? "a person"),
		};
		setResult(nextResult);
		setResultOpen(true);
		setCopied(false);
		setRecordedVideoName(null);
		copyPrompt(prompt);
		return nextResult;
	}

	function download() {
		if (recRef.current || result?.downloaded) return null;
		if (frameExportRef.current?.source === result) {
			if (frameExportRef.current.done) return null;
			return executeExportRequest(frameExportRef.current.request);
		}
		const snapshot = structuredClone(result);
		const frameJob = { source: result, done: false, request: null };
		frameJob.request = exportRequest("frame", async (job) => {
			if (!snapshot?.frame) throw Object.assign(new Error("The captured frame is not ready"), { exportFailureCode: "render_failed" });
			updateExportStatus(job, "finalizing", { stage: "download", cancellable: false });
			const save = async (source, name) => {
				if (job.request.handedOff.has(name)) return;
				await saveExport(source, name);
				job.request.handedOff.add(name);
			};
			if (snapshot.partColours && !job.request.handedOff.has("blocking-frame-palette.json")) {
				await save(new Blob([JSON.stringify({ partColours: snapshot.partColours }, null, 2)], { type: "application/json" }), "blocking-frame-palette.json");
			}
			if (snapshot.frameB) {
				await save(snapshot.frame, "blocking-frame-A-start.png");
				await save(snapshot.frameB, "blocking-frame-B-end.png");
			} else await save(snapshot.frame, "blocking-frame.png");
			frameJob.done = true;
			setResult((current) => current === frameJob.source ? { ...current, downloaded: true } : current);
			setToast(ko("Frame export finished. Check your export folder or browser downloads.", "프레임 내보내기가 끝났어요. 내보내기 폴더나 브라우저 다운로드를 확인하세요."));
		});
		frameExportRef.current = frameJob;
		return executeExportRequest(frameJob.request);
	}

	// Studio native ports. Kept together so the binding test executes these exact
	// publication/history functions, not a substitute editor or parallel journal.
	function readStudioCamera() {
		const live = appContext.live.state, camera = shotCamRef.current;
		if (!camera) return null;
		const position = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
		const direction = forwardFrom(look.current.yaw, look.current.pitch);
		return { position, lookAt: { x: position.x + direction.x, y: position.y + direction.y, z: position.z + direction.z },
			focalMm: fovToFocalMm(camera.fov * Math.PI / 180, live.filmback.sensorId, live.filmback.aspectRatio),
			sensorId: live.filmback.sensorId, slate: "Shot camera" };
	}
	function readStudioState() {
		const live = appContext.live.state;
		const list = appContext.live.characters.map(c => c.id === loadedLayerCharRef.current ? {
			...c, layer: { ...c.layer, waypoints: bufferRef.current.waypoints }, sessionMotion: bufferRef.current.motion,
		} : c);
		const targets = new Map(list.map(c => [c.id, { rig: live.rigs[c.id], motion: c.sessionMotion ?? null,
			ikState: c.id === loadedLayerCharRef.current ? ikStateRef.current : ikStatesRef.current.get(c.id),
			calibration: c.sessionMotion?.sceneCalibration, protectedFrames: [],
			preserveAuthoredMotion: Boolean(c.layer?.waypoints?.length) }]));
		return { host: { workspaceId: liveWorkspaceIdRef.current, documentEpoch: studioDocumentEpochRef.current,
				sceneId: activeSceneIdRef.current, sceneEpoch: studioSceneEpochRef.current }, workspaceHandle: liveWorkspaceHandleRef.current,
			sceneName: live.scenes.find(s => s.id === activeSceneIdRef.current)?.name ?? "Untitled Scene", previsMode: scenesDomain.previsMode, castStyle: scenesDomain.castStyle, aspect: live.stage.shotAspect, stage: live.stage,
			objects: storeRef.current.objects, characters: list, targets, shots: live.shots, frameCount: live.timeline.frameCount,
			selection: live.studioSelection, activeCharacterId: live.activeCharacterId, selectedShotId: live.studioShotId,
			view: live.studioView, camera: live.studioCamera ?? readStudioCamera(), filmback: live.filmback, manual: manualCameraOverrideRef.current,
			// The user's drag transaction is added by the binding (studio-busy.js); clicks, orbit, scrubbing and playback never count.
			bridgeReady: false, busy: studioBusy({ ikBodyDrag: ikBodyDragRef.current, recording: recRef.current }) };
	}
	function sampleStudioStateAt(frame, current = readStudioState()) {
		const shot = shotAtFrame(current.shots ?? current.shotDocument?.shots ?? [], frame);
		const sampledPlayback = sampleAt(playbackScene, shot, frame);
		const sampledSubject = sampledPlayback.subject;
		const primaryId = current.activeCharacterId ?? current.characters[0]?.id;
		const characters = sampledSubject && primaryId
			? current.characters.map(character => character.id === primaryId ? { ...character, x: sampledSubject.x, z: sampledSubject.z } : character)
			: current.characters;
		const sampled = sampledPlayback.camera;
		if (!sampled) return { ...current, frame, characters, view: { ...current.view, frame } };
		const position = { x: sampled.pos.x, y: sampled.pos.y, z: sampled.pos.z };
		const direction = forwardFrom(sampled.yaw, sampled.pitch);
		return { ...current, frame, characters, view: { ...current.view, frame }, camera: {
			position,
			lookAt: { x: position.x + direction.x, y: position.y + direction.y, z: position.z + direction.z },
			focalMm: fovToFocalMm(sampled.fovDeg * Math.PI / 180, current.filmback.sensorId, current.filmback.aspectRatio),
			sensorId: current.filmback.sensorId,
		} };
	}

	/** The authored stage envelope (key light, environment, filmback) published
	 * as one body: the live read model first, so the next synchronous read sees
	 * it, then the React state the foldouts and the save path own. */

	/** All surfaces share the facade's owned sessions and store histories. */
	function beginStudioAction(domain, targetId = null) {
		return appContext.beginAction(domain, targetId);
	}
	function recordStudioAction(domain, run, targetId = null, nested = false) {
		return appContext.recordAction(domain, run, targetId, nested);
	}
	function publishStudioDomain(domain, targetId, state) {
		return appContext.storeDomain(domain).publish(state, targetId);
	}
	function canUndoStudioReceipt(receipt) {
		const owned = appContext.storeDomainForReceipt(receipt);
		return Boolean(owned && appContext.nextStoreHistory(false) === owned && owned.canUndo(receipt.undo.historyEntryId));
	}
	function isStudioHistoryRetained(receipt) {
		return Boolean(appContext.storeDomainForReceipt(receipt));
	}

	function finishStudioHistoryGesture() {
		for (const owner of appContext.storeDomains()) { owner.finishGesture?.(); owner.settle?.(); }
	}
	function stepStudioHistory(redo) {
		const before = storeRef.current.objects;
		const owned = appContext.nextStoreHistory(redo);
		if (!owned?.stepHistory(redo)) return false;
		const restored = storeRef.current.objects;
		if (before !== restored) {
			if (!redo && objectDeleteUndo?.id && restored.some(object => object.id === objectDeleteUndo.id)) {
				setSelectedHierarchyId(`object:${objectDeleteUndo.id}`); setObjectDeleteUndo(null); noteDeleteUndone(objectDeleteUndo.id);
			} else if (selectedSceneObjectId && !restored.some(object => object.id === selectedSceneObjectId)) setSelectedHierarchyId("props");
		}
		setToast(redo ? ko("Redone", "다시 실행됨") : ko("Undone", "실행 취소됨"));
		return true;
	}
	function commitStudioDraft(payload) {
		const owned = appContext.storeDomain(payload.domain);
		const session = owned.beginAction();
		try { session.run(() => owned.commitDraft(payload.draft)); return session.commit(); }
		catch (error) { session.cancel(); throw error; }
	}

	function studioBounds({ entity, frame, state }) {
		if (entity.renderer) {
			if (entity.attach) {
				// A carried prop's numbers are local to the frame it rides; measure it
				// where it is drawn, the frame the arrange is evaluated at.
				const world = sceneObjectWorldMatrix(entity);
				if (!world) throw new StudioProtocolError("TARGET_NOT_READY", "Attached bounds require an evaluated attachment frame.");
				const carried = new THREE.Box3(new THREE.Vector3(-entity.footprint.width / 2, 0, -entity.footprint.depth / 2), new THREE.Vector3(entity.footprint.width / 2, entity.height, entity.footprint.depth / 2));
				carried.applyMatrix4(world); return { min: { ...carried.min }, max: { ...carried.max } };
			}
			const at = objectTransformAt(entity, frame, { frameCount: state.frameCount, fps: 24 });
			const object = at ? { ...entity, ...at } : entity;
			const matrix = new THREE.Matrix4().compose(new THREE.Vector3(object.x, object.y ?? 0, object.z),
				new THREE.Quaternion().setFromEuler(new THREE.Euler((object.rotX ?? 0) * Math.PI / 180, (object.rot ?? 0) * Math.PI / 180, (object.rotZ ?? 0) * Math.PI / 180)),
				new THREE.Vector3(object.scaleX, object.scaleY, object.scaleZ));
			const box = new THREE.Box3(new THREE.Vector3(-object.footprint.width / 2, 0, -object.footprint.depth / 2), new THREE.Vector3(object.footprint.width / 2, object.height, object.footprint.depth / 2));
			box.applyMatrix4(matrix); return { min: { ...box.min }, max: { ...box.max } };
		}
		const raw = readStudioState();
		const original = raw.characters.find(c => c.id === entity.id) ?? raw.characters.find(c => c.model === entity.model);
		const target = original && raw.targets.get(original.id);
		if (isProxyFigure(original)) {
			const clip = target?.motion;
			const placement = placementAt(original, frame, {
				shotAt: at => shotAtFrame(raw.shots, at),
				takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
			});
			return proxyFigureBounds(original, placement);
		}
		if (!target?.rig) throw new StudioProtocolError("TARGET_NOT_READY", "Character bounds require its loaded rig.");
		const rig = cloneSkeleton(target.rig), parent = new THREE.Group();
		const originals = [], copies = [];
		target.rig.traverse(node => originals.push(node)); rig.traverse(node => copies.push(node));
		rig.userData.poseBind = new Map(originals.flatMap((node, index) => {
			const bind = target.rig.userData.poseBind?.get(node);
			return bind ? [[copies[index], structuredClone(bind)]] : [];
		}));
		parent.matrixAutoUpdate = false; parent.matrix.copy(target.rig.parent?.matrixWorld ?? new THREE.Matrix4()); parent.add(rig);
		try {
			if (target.motion) applyTakeFrame(rig, target.motion, sampleAt({ frameCount: target.motion.frames, motion: target.motion }, null, frame).motionFrame);
			// The clone shares the source rig's bind pose, so its contact radii
			// and heights are the same numbers: measure the source once and
			// hand them over instead of re-scanning every vertex per query (#413).
			resolveIkRig(target.rig);
			shareContactMeasurements(target.rig, rig);
			const resolved = resolveIkRig(rig);
			if (resolved && target.ikState?.keys.size) ikEvaluate(resolved.chains, target.ikState, frame, resolved.fkJoints, target.motion ? IK_CORRECTION_BLEND_FRAMES : 0);
			parent.updateMatrixWorld(true);
			const transform = c => new THREE.Matrix4().compose(new THREE.Vector3(c.x, c.y ?? 0, c.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (c.rot ?? 0) * Math.PI / 180), new THREE.Vector3().setScalar(c.scale ?? 1));
			const delta = transform(entity).multiply(transform(original).invert());
			const box = new THREE.Box3().setFromObject(rig, true).applyMatrix4(delta);
			return { min: { ...box.min }, max: { ...box.max } };
		} finally {
			const skeletons = new Set(); rig.traverse(n => { if (n.isSkinnedMesh) skeletons.add(n.skeleton); });
			for (const skeleton of skeletons) skeleton.dispose(); parent.remove(rig);
		}
	}
	function operateStudio({ selection, view, shotId, modeSet = true }) {
		const { frame } = view;
		appContext.patchLive({ studioSelection: selection, studioView: view, studioShotId: shotId });
		appContext.patchTimeline({ currentFrame: frame }); tlFrameRef.current = frame;
		if (selection && ["character", "rig"].includes(selection.kind)) { appContext.patchLive({ activeCharacterId: selection.id }); setActiveCharacterId(selection.id); }
		setSelectedHierarchyId(selection ? selection.kind === "object" ? `object:${selection.id}` : ["character", "rig"].includes(selection.kind) ? `character:${selection.id}` : selection.kind === "camera" ? "camera" : "shot" : "");
		// Sculpt is UI-only and publishes as Stage (below): a view write that
		// names no mode keeps the editor in it.
		setTlFrame(frame); setWorkflowMode((current) => (current === "sculpt" && !modeSet && view.mode === "scene" ? current : view.mode)); setLookThroughShot(view.lookThrough); setGridView(view.grid); setAutoColor(view.autoColor); setTlPlaying(view.playing);
	}
	// The Studio turn authors the scene through its own families and never
	// returns an image, so there is no image action for this host to accept.
	// The Workflow dock keeps its half of that contract.
	const selectedStudioChar = charIdFromHierarchyId(parseRigNodeId(selectedHierarchyId)?.rowId ?? selectedHierarchyId);
	appContext.patchLive({
		studioSelection: selectedSceneObjectId ? { kind: "object", id: selectedSceneObjectId, hierarchyId: selectedHierarchyId } :
			selectedStudioChar ? { kind: "character", id: selectedStudioChar, hierarchyId: selectedHierarchyId } : selectedHierarchyId === "camera" ? { kind: "camera", id: "camera" } : { kind: "scene", id: activeSceneId },
		studioShotId: activeShot?.id ?? null,
		// The agent's mode vocabulary is four (studio-agent-protocol.js): the
		// sculpt turntable is the Stage's scene seen in isolation.
		studioView: { mode: sculptMode ? "scene" : workflowMode, frame: tlFrame, playing: tlPlaying, lookThrough: lookThroughShot, grid: gridView, autoColor },
	});
	appContext.updatePorts({
		read: readStudioState, revision: sceneRevisionRef, bounds: studioBounds, commit: commitStudioDraft,
		operate: operateStudio, undo: () => stepStudioHistory(false), redo: () => stepStudioHistory(true),
		sampleStateAt: sampleStudioStateAt,
		history: redo => appContext.historyEntry(redo), finishHistoryGesture: finishStudioHistoryGesture,
		stepHistory: stepStudioHistory, capture: () => liveQueries.capture_framing_png({}), capturePlan: () => liveQueries.capture_plan_png({}),
		// One shot frame as raw read-back pixels (rows bottom-up), from the export
		// path captureShotFramePng uses; an export in flight renders at its output.
		// With a view (verify_result's own cameras) the posed frame is seen by that
		// camera instead, at view.output; the shot camera is left as it is.
		renderFrameBuffer: (frame, view = null) => {
			const output = view?.output ?? (recRef.current?.capture ? recRef.current.request.context.output : shotOutput), data = withExportFrame(frame, view && (() => captureRef.current.renderView(view)));
			if (!data) throw new Error("The shot renderer is not ready");
			return { data, width: output.width, height: output.height };
		},
		encodePng: (buffer, output) => bufferToPng(buffer, output),
		// The pose library a character.pose patch resolves its id against.
		poses: () => [DEFAULT_POSE, ...customPoses],
		
		ikRevision: (id, stamp) => {
			const prior = studioIkStampsRef.current.get(id);
			if (!prior || prior.stamp !== stamp) studioIkStampsRef.current.set(id, { stamp, revision: (prior?.revision ?? 0) + 1 });
			return studioIkStampsRef.current.get(id).revision;
		},
		isRetained: isStudioHistoryRetained,
		canUndo: canUndoStudioReceipt,		actions: () => studioActionsRef.current,
		recordAction: recordStudioAction, beginAction: beginStudioAction,
		captureToasts: listener => { toastSinkRef.current.add(listener); return () => toastSinkRef.current.delete(listener); },
		showRefusal: appContext.notify,
		emitCommandEvent: detail => window.dispatchEvent(new CustomEvent("cozyclay:command", { detail })),
	});
	appContext.updateActionPorts({
		// Shots and objects come from the synchronously published read model, so
		// an action sees its own edit before React renders it.
		state: () => ({
			shots: appContext.live.state.shots, objects: storeRef.current.objects, characters: appContext.live.characters, frame: tlFrame, frameCount: tlFrameCount,
			selectedObjectId: selectedSceneObjectId, activeCharacterId: characters.length ? activeChar.id : null,
			
			generating: false,
			motionReady: false,
			// The Export menu offers Video (mp4) on exactly these conditions.
			exporting: Boolean(recRef.current), canExportVideo: shots.length > 0 || hasCameraKeys || Boolean(motion),
			// The scene refs move synchronously with every scene handler.
			scenes: appContext.live.scenes.map(({ id, name }) => ({ id, name })), activeSceneId: activeSceneIdRef.current,
			// What a save needs: a name, a file this session, and (to pick or
			// re-grant a file) the user's click still active.
			project: { name: projectName, previsMode, hasFile: Boolean(projectHandleRef.current), fileAccess: hasFileSystemAccess(),
				gesture: globalThis.navigator?.userActivation?.isActive === true },
			// What generate() reads for the Send-to-AI package, as this render has it.
			aiShot: { mode, imageModel },
			// AI-video motion: the account's Fal access, the card's job state and
			// the daily generations left (null until the server says).
		}),
		addTimelineShot, splitTimelineShot, duplicateTimelineShot, removeTimelineShot, setTimelineShotRange, moveTimelineShot,
		duplicateSelectedSceneObject,
		addCharacterWaypoint, moveCharacterWaypoint, removeCharacterWaypoint, clearCharacterWaypoints, setWaypointMode,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys, attachSceneObject, setShotCameraRail, clearShotCameraRail,
		choosePartColours, setGuideMode, setInsetCollapsed, exportShotVideo,
		frameEditorView: (position, target) => { setLookThroughShot(false); return frameEditorView(editorCamRef.current, editorLook.current, position, target); },
		readView: readStudioState, publishView: operateStudio, canPose: () => !poseRefusal,
		switchSceneDocument, addSceneDocument, duplicateSceneDocument, renameSceneDocument, deleteSceneDocument,
		afterRender: () => new Promise(resolve => renderWaitersRef.current.push(resolve)),
		saveProject, projectFileGranted: async () => (await queryHandlePermission(projectHandleRef.current)) === "granted",
		importAsset: (args, context) => objectsDomain.importAsset(args, context), fetchImportSource,
		setAiShotMode: setMode, setAiImageModel: setImageModel, generate,
	});
	if (!studioActionsRef.current) studioActionsRef.current = createStudioAppActions(appContext.actionPorts);
	/** UI door into the shared registry. Refusal messages are written for the
	 * model, so a person only ever sees the localized `uiMessage` a thrower
	 * attached (studioActionRefusal); any other refusal stays silent, as the
	 * controls always were. */
	function runStudioAction(id, args = {}) {
		const refused = error => {
			if (!(error instanceof StudioProtocolError)) throw error;
			if (error.uiMessage) setToast(error.uiMessage);
			return null;
		};
		try {
			// A long-running action answers with a promise that refuses the same way.
			const result = appContext.bus.run(id, args, { origin: "ui" });
			const answer = receipt => receipt.ok ? receipt : null;
			return typeof result?.then === "function" ? result.then(answer, refused) : answer(result);
		} catch (error) {
			return refused(error);
		}
	}
	if (!studioBindingRef.current) {
		studioBindingRef.current = createStudioAppBinding(appContext.ports);
		studioBindingRef.current.stepHistory = redo => appContext.ports.stepHistory(redo);
		studioBindingRef.current.publishSemantic = (domain, after) => {
			if (domain === "characters" && Array.isArray(after)) { appContext.publishCharacters(after); appContext.patchLive({ characters: after }); }
			if (domain === "shots") appContext.patchLive({ shots: after });
			
		};
	}
	useEffect(() => () => studioBindingRef.current?.dispose(), []);
	// Every commit releases the actions waiting for React to render their edit
	// (a scene switch answers once the new room is on stage).
	useEffect(() => { for (const resolve of renderWaitersRef.current.splice(0)) resolve(); });

	const projectStatus = projectSaveState === "saving"
		? ko("Saving…", "저장 중…")
		: projectSaveState === "error"
			? ko("Save failed", "저장 실패")
			: projectName === null
				? ko("Not saved", "저장되지 않음")
				: projectDirty
					? ko("Unsaved changes", "저장되지 않은 변경사항")
					: ko("Saved", "저장됨");

	// Sculpt mode's panel heads the Details column (DetailsSlot mounts it).
	const sculptPanel = sculptMode && !embedMode ? (
		<SculptPanel
			run={sculptRun} parts={sculptParts}
			reference={sculptReference}
			onReference={(file) => void chooseSculptReference(file)}
			onStart={startSculptRun}
			onCancel={() => sculptRunRef.current?.cancel()}
			onPlaceInScene={placeSculptInScene}
			onSaveToShelf={() => void saveSculptToShelf(sculptTarget).then(setToast)}
			canStart={Boolean(sculptReference) && sculptAgentStatus === "ready" && Boolean(liveWorkspaceHandle) && Boolean(sculptModelPick.model)}
			blueprint={{
				...sculptBlueprint,
				prompt: buildBlueprintPrompt({ pose: sculptBlueprint.pose, notes: sculptBlueprint.notes }),
				layout: BLUEPRINT_LAYOUT,
				// The image model is ChatGPT-only: without a ChatGPT token the button is hidden and this says why (#970).
				refusal: !sculptChatgpt ? ko("Sign in with ChatGPT in the Agent panel to generate a blueprint.", "도면을 생성하려면 에이전트 패널에서 ChatGPT로 로그인하세요.") : null,
				onPose: (pose) => setSculptBlueprint((current) => ({ ...current, pose })),
				onNotes: (notes) => setSculptBlueprint((current) => ({ ...current, notes })),
				onGenerate: () => void generateSculptBlueprint(),
				onCancel: cancelSculptBlueprint,
			}}
			modelPicker={{
				...sculptModels,
				model: sculptModelPick.model,
				effort: sculptModelPick.effort,
				// A new model starts at its own default effort.
				onModel: (model) => chooseSculptModel({ model, effort: null }),
				onEffort: (effort) => chooseSculptModel({ effort }),
			}}
			startRefusal={sculptAgentStatus === "signed-out"
				? ko("Sign in to the Agent (⌘B) to sculpt from an image.", "이미지로 조형하려면 에이전트(⌘B)에 로그인하세요.")
				: sculptAgentStatus === "ready" && !liveWorkspaceHandle
					? ko("The live editor is disconnected — reconnect to sculpt.", "라이브 편집기가 연결되지 않았어요 — 연결 후 조형하세요.")
					: sculptAgentStatus === "ready" && sculptModels.state === "failed"
						? ko("No model is available — add a provider key in the Agent panel.", "사용할 모델이 없어요 — 에이전트 패널에서 제공자 키를 추가하세요.")
						: null}
			sculptName={sculptTarget?.name ?? null}
		/>
	) : null;
	// The single shell snapshot keeps subsequent region work out of App.
	const shellContext = {
		sculptPanel,
		projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, previsMode, castStyle: scenesDomain.castStyle, projectStartupOpen,
		requestNewProject, setProjectStartupOpen, setProjectBrowserOpen, runStudioAction, saveProject,
		projectManifest, projectSaveState, recState, exportMenuTriggerRef, exportMenuOpen,
		exportShotIdRef, setExportMenuAnchor, setExportMenuOpen, exportPhaseLabel,
		exportMenuAnchor, resultOpen, exportFeedback, shots, exportKeyframePacks,
		hasCameraKeys, motion, exportRenderPasses, exportDepthVideo, exportStoryboard,
		exportContactSheet, exportPanelPacks, exportAnimatic,
		capturePanelThumbnail, packMetaForShot, previsMode: scenesDomain.previsMode, sceneRevision: sceneRevisionRef.current,
		downloadOtioCutList, projectStatus, liveWorkspaceHandle, selectedHierarchyId, selectHierarchy,
		aimEditorAtKeyLight, characters, showB, ikFrames, ikMode,
		rowIdForCharIndex, activeCharIndex, waypoints, sceneObjects, scenes,
		activeSceneId, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi, renameSceneDocumentFromUi,
		deleteSceneDocumentFromUi, addSceneObject, renameSceneObject, deleteSceneObject, frameSelection, groupObjectUnderNewEmpty, renameRequest,
		toggleHierarchyHidden, propsDrop, hierarchyReparent, agentTouchedRows, workflowMode,
		selectWorkflowMode, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled, sculptView, requestSculptView, sculptParts,
		preset, applyPreset, cameraPresetId, shotAspectKey,
		fovDeg, shotsDomain, shot, setNonce, workspaceLayout,
		viewMenuTriggerRef, viewMenuOpen, setViewMenuAnchor, setViewMenuOpen, viewLooksActive,
		viewMenuAnchor, gridView, setGridView, autoColor, setAutoColor,
		guideMode,
		isCharacterSelection, partColoursChoice, embedMode, agentCollapsed, sceneSaveError,
		studioAgentError, studioAgentMode, setStudioAgentMode, AgentPanel, setAgentCollapsed,
		buildStudioAgentContext, highlightAgentTargets, selectedSceneObject, rigSelection,
		inspectorActionsOpen, setInspectorActionsOpen, deleteSelectedSceneObject, inspectorHasContent, keyLightSelected,
		keyLight, lighting, changeKeyLight, resetKeyLight, isCameraSelection, moveSequence,
		cameraKeys, activeShot, changeShotTargetModel, updateCharacterAt, openStudio,
		posing, removeCharacter, setShowB, activeChar, changeInspectorCharacter,
		selectablePoses, ikApplyPoseAsKey,
		setStudioPick, appContext, removePose, activeRig, saveCurrentPose,
		setTlFrame, tlFrameCount,
		tlFrame, isRigSelection, ikChains, ikFocus, footSnap, poseObjectOpacity, setPoseObjectOpacity, capturePoseImage,
		ikEditTool, setIkEditTool, ikSolve, ikDragEnd, ikTick, autoKey, setAutoKey, ikMoveKeyframe, handFingers, fingerEditing, setFingerEdit,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		rangePins, rangePinResiduals, rangePinSelection, rangePinPartPick,
		rangePinPreview, setRangePinSelection, setRangePinPartPick, previewRangePinDraft, applyRangePinDraft,
		deleteRangePin, hasEnvSheet, environment, style, environmentImage,
		inspectorDrop, cutoutInputRef, meshInputRef, importCutout, importMesh,
		changeSceneObject, attachTargetLabel, store, beginSceneTransaction, endSceneTransaction,
		matteCanvasRef, matteStats, matteMode, setMatteMode, matteEditorRef,
		matteTolerance, setMatteTolerance, matteBrush, setMatteBrush, matteShrink,
		setMatteShrink, matteFeather, setMatteFeather, matteBusy, applyMatte,
		recentObjectColors, rememberSceneObjectColor, objectColorDraft, setObjectColorDraft,
		posingIndex, posingChar, charA, allPoses, studioPick,
		posingClosing, closeStudio, castDomain, setToast, savePose,
		bottomTab, setBottomTab, beginAssetDrag, shelfImageIds, shelfMeshIds,
		manageAssetStorage, setManageAssetStorage, unusedAssetIds, usedAssetIds, usageCounts,
		projectAssetGraphSignature, assetTrash, deleteUnusedAsset, undoDeletedAsset, deletingAssetId,
		waypointMode,
		craneSelectedIndex,
		addActiveCranePoint, deleteSelectedCranePoint, setCraneSelectedIndex, tlFps, ghostLayers,
		pathSpeed, tlPlaying, pendingWaypointFrame, stateBadge, bodyContact,
		activeShotIdx, railDraw, pathDraw, pathTarget, setPathDraw, setRailDraw,
		setWorkspaceLayout, timingTokenRef, railCurve, ikAddKeyframe, ikDeleteKeyframe, pathPointIndex, setPathPointIndex,
		setBodyContact, setFootSnap, advanceFrame, stepFrame, cameraPreviewEndRef,
		manualCameraOverrideRef, setTlPlaying, setWaypointMode, selectActiveCharacterInHierarchy,
		toggleWaypointMode: storyboardProject ? undefined : toggleWaypointMode,
		setActiveWaypointId, setPendingWaypointFrame, removeWaypoint, queueRootWaypointFrame, setSelectedHierarchyId, addCameraKeyframe,
		moveCameraKeyframe, removeCameraKeyframe, syncActiveCameraFraming, activeCamera, activeShotDuration,
		changeActiveCamera, cameraRail, previewCameraShot, toggleCameraRailDraw, deleteCameraRail,
		selectTimelineShot, clearMotion,
		spawnCharacter, exportShotVideo, stopShotRecording, retryExport, poseRefusal,
		beginWorkspaceResize, frameAll, setAxisView,
		preferencesOpen, setPreferencesOpen, statusText, setStatusText, previewRanges, setPreviewRanges,
		flySpeed, liveHubStatus: liveWorkspaceHandle ? "connected" : "disconnected",
		agentOpen: !agentCollapsed,
		toggleAgent: () => window.dispatchEvent(new CustomEvent("cozyclay:agent-panel-toggle")),
		saveStatus: { state: projectSaveState, text: projectStatus, dirty: projectDirty, name: projectName },
		exportStatus: exportStatus && { ...exportStatus, cancel: stopShotRecording, retry: retryExport },
		subscribeToasts: (listener) => { toastSinkRef.current.add(listener); return () => toastSinkRef.current.delete(listener); },
		enterShotLook, startCameraPerformance, stopCameraPerformance, cameraPerformanceRecording,
		lookThroughShot, exitShotLook: exitPreview,
	};

	return (
		<AppContext.Provider value={appContext}>
		<StudioShellContext.Provider value={shellContext}>
		<StudioShell className={"app" + (renderActive ? "" : " render-idle")} style={workspaceStyle} data-workflow-mode={workflowMode} data-previs-mode={scenesDomain.previsMode} data-embed-mode={embedMode ? "playview" : playgroundMode ? "playground" : undefined} data-rail-draw={railDraw ? 1 : undefined} data-shot-look={lookThroughShot && !embedMode ? 1 : undefined} data-plan-draw={railDraw || pathDraw || waypointMode ? 1 : undefined}
			viewport={
				<div className="viewport" data-drop={viewportDrop.over ? "over" : undefined} {...viewportDrop.handlers}
					onWheel={(event) => {
						// Read-only UI mirror of FlyControls' persistent wheel multiplier.
						// Its native canvas listener handles navigation before this bubbles.
						if (flyingRef.current && event.target.tagName === "CANVAS") {
							setFlySpeed((speed) => THREE.MathUtils.clamp(speed * (event.deltaY > 0 ? 0.9 : 1.1), 0.15, 6));
						}
					}}>
				<ViewportToolbar />
				<ReviewOverlay />
				{(embedMode || playgroundMode) && <CompositionGuideButton guideMode={guideMode} onCycle={(mode) => runStudioAction("view.setGuideMode", { mode })} />}
				{sculptMode && !sculptTarget && (
					<div className="vp-sculpt-hint" role="status" data-testid="sculpt-empty">
						<strong>{ko("New sculpt", "새 조형물")}</strong>
						<span>{ko("Add a reference image in the Sculpt panel and press Start — or select a sculpt and press 5.", "조형 패널에 참조 이미지를 넣고 시작을 누르세요 — 또는 조형물을 선택하고 5를 누르세요.")}</span>
					</div>
				)}

					<div className="stage" id="stage" ref={stageRef} data-render-loop={renderActive ? "always" : "demand"}>
						{/* Shadows were off, so every castShadow in props.jsx was inert and
						    nothing on the open stage ever touched the floor. A contact
						    shadow is the cue that says a subject stands ON the deck rather
						    than floats above it — without walls it is the only one left. */}
						{/* "percentage" = THREE.PCFShadowMap. Bare `shadows` asks fiber for
						    PCFSoftShadowMap, which three r185 deprecated — it already falls
						    back to PCFShadowMap at runtime, minus one console.warn per
						    frame burst. Same pixels, silent console. */}
						<Canvas
							shadows="percentage"
							frameloop={renderActive ? "always" : "demand"}
							dpr={[1, 2]}
							// Measure the layout box, not the transformed one: stageIn's scale()
							// at mount used to leave the buffer short of the box in every mode.
							resize={{ offsetSize: true }}
							gl={{ preserveDrawingBuffer: true, antialias: true }}
							onCreated={({ gl }) => {
								gl.domElement.addEventListener("webglcontextlost", (event) => {
									event.preventDefault();
									setToast(ko(
										"The graphics context was lost — restoring the stage. If it stays black, reload the page; your work is autosaved.",
										"그래픽 컨텍스트가 끊겼어요 — 무대를 복구합니다. 검게 남으면 새로고침하세요. 작업은 자동 저장돼 있습니다.",
									));
								});
								gl.domElement.addEventListener("webglcontextrestored", () => {
									setToast(ko("Graphics restored.", "그래픽이 복구됐어요."));
								});
							}}
						>
							<ContextLossGuard onLostChange={setGlContextLost} />
							<RenderLoopController stageRef={stageRef} />
							<ViewportLayoutInvalidator
								insetX={insetPos?.x ?? null}
								insetY={insetPos?.y ?? null}
								insetWidth={workspaceLayout.insetWidth}
								insetHeight={workspaceLayout.insetHeight}
								hierarchyWidth={workspaceLayout.hierarchyWidth}
								sidebarWidth={workspaceLayout.sidebarWidth}
								timelineHeight={workspaceLayout.timelineHeight}
								planZoom={workspaceLayout.planZoom}
							/>
							{/* Sky, fog and exposure of the stage look (stage-sky.jsx), for every pane and export. */}
							<StageAtmosphere lighting={lighting} keyLight={keyLight} theme={uiTheme} grid={gridView} />
							<StageLights keyLight={keyLight} lighting={lighting} neutral={gridView} light={uiTheme === "light"} />
							<KeyLightPuck
								keyLight={keyLight}
								selected={keyLightSelected}
								visible={!preview && !lookThroughShot && !sculptMode}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={() => selectHierarchy("light")}
								/* The puck has no drag-start hook: the first move of a drag
								   opens the entry and the drag end closes that gesture. */
								onChange={(patch) => changeKeyLight("puck", patch)}
								onDragEnd={endGestureUndo}
							/>
							{gridView ? <GridFloor layer={GIZMO_LAYER} /> : <Room light={uiTheme === "light" && !lighting.sky && !(lighting.hdr && lighting.hdrBackground)} />}
							<SetProps
								objects={stageSceneObjects}
								authoredObjects={sceneObjects}
								selectedId={selectedSceneObjectId}
								frameRef={propFrameRef}
								take={{ frameCount: tlFrameCount, fps: tlFps, objectTracks }}
								attachFrameRef={attachFrameRef}
								syncRef={propSyncRef}
								worldRef={propWorldRef}
								fadeOpacity={workflowMode === "pose" ? poseObjectOpacity : null}
							/>

							<PerspectiveCamera
								ref={shotCamRef}
								makeDefault={!ikMode && lookThroughShot}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* the EDITOR camera: the user's working eye. Fixed lens — the
							    shot's focal length belongs to the recording, not to the
							    operator's own view of the set. */}
							<PerspectiveCamera
								ref={editorCamRef}
								makeDefault={!ikMode && !lookThroughShot && !sculptMode}
								fov={55}
								near={0.1}
								far={100}
								position={[3.6, 2.7, 5.4]}
							/>
							{/* the poser camera is the default (event/raycast) camera in
							    IK mode so handle hit-testing matches what you see */}
							<PerspectiveCamera
								ref={poserCamRef}
								makeDefault={ikMode}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* a plan is a plan: orthographic, framed to the working area, so
							    pucks stay the same size wherever they sit */}
							<OrthographicCamera
								ref={planCamRef}
								near={0.1}
								far={80}
								position={[0, 24, 0]}
								rotation={[-Math.PI / 2, 0, 0]}
							/>
							{/* Sculpt mode's own orbit camera and turntable; it owns the main
							    pane (DualRender's editor slot) while the shot preview keeps
							    drawing the whole scene. Unmounting restores normal rendering. */}
							{sculptMode && (
								<SculptTurntable
									camRef={sculptCamRef}
									objects={sceneObjects} parts={sculptParts}
									target={sculptTarget}
									size={sculptTarget ? objectSize(sculptTarget) : null}
									view={sculptView}
									light={uiTheme === "light"}
									busy={["measure", "draft", "score", "refine"].includes(sculptRun?.stage)}
									changedParts={sculptRun?.changedParts ?? null}
								/>
							)}

							{characterViews.map((view) => (
								// Always wrapped, grouped or not: giving or taking a parent
								// must not remount the rig the playback effects hold.
								<ObjectCarrier
									key={`${view.id}:${rigMountEpoch}`}
									objectId={view.parent}
									objectsRef={sceneObjectLookupRef}
									frameRef={propFrameRef}
									take={{ frameCount: tlFrameCount, fps: tlFps, objectTracks }}
									registryRef={carrierRegistryRef}
								>
									<PlaybackCharacter
										entry={view.entry}
										clip={view.clip}
										shots={shots}
										url={view.url}
										{...{ model: view.model, posture: view.posture }}
										position={view.position}
										rot={view.rot}
										tint={view.tint}
										partColoursEnabled={view.partColoursEnabled}
										partColoursMode={view.partColoursMode}
										pose={view.pose}
										scale={view.scale}
										onRig={view.onRig} pickId={view.pickId}
									/>
								</ObjectCarrier>
							))}
							<ViewGhosts rig={rigs[activeChar.id]} take={motion} frame={tlFrame} objects={sceneObjects} propTake={{ frameCount: tlFrameCount, fps: tlFps, objectTracks }} /><DraftGhost rigs={rigs} objects={sceneObjects} /><SculptSketch objects={sceneObjects} /><PhysicsOverlayLayer rig={rigs[activeChar.id]} take={motion} objects={sceneObjects} />

							{/* Selection marker: XYZ tripod + ring on the picked cast
							    member; the X/Z arrows drag it across the deck. */}
							{gizmoView && !playMode && !posing && !ikMode && (
								<ObjectGizmo
									pickOnly
									object={characterGizmoObject}
									objects={characterGizmoObject ? [characterGizmoObject] : []}
									mode={gizmoMode}
									snap={snapEnabled}
									enabled={!planIsMain && !posing && !ikMode && !playMode && !sculptMode && !!characterGizmoObject}
									paneRef={mainPaneRef}
									camRef={lookThroughShot ? shotCamRef : editorCamRef}
									shotAspect={lookThroughShot ? shotOutput.aspect : null}
									onChange={(id, patch) => moveCharacter(activeChar.id, () => {
										const next = {};
										if (patch.x !== undefined) next.x = THREE.MathUtils.clamp(patch.x, CHARACTER_POSITION_BOUNDS.min.x, CHARACTER_POSITION_BOUNDS.max.x);
										// Lift floors at the deck but has no ceiling — a crane
										// shot may hoist the body as high as the move needs
										// (the inspector's Height scrub agrees).
										if (patch.y !== undefined) next.y = Math.max(CHARACTER_POSITION_BOUNDS.min.y, patch.y);
										if (patch.z !== undefined) next.z = THREE.MathUtils.clamp(patch.z, CHARACTER_POSITION_BOUNDS.min.z, CHARACTER_POSITION_BOUNDS.max.z);
										// a body only yaws — the X/Z rings and the screen ring's
										// other channels have nowhere to go on a character
										if (patch.rotY !== undefined) next.rot = patch.rotY;
										// one stature knob: any scale axis reads as uniform
										const s = patch.scaleX ?? patch.scaleY ?? patch.scaleZ;
										if (s !== undefined) next.scale = THREE.MathUtils.clamp(s, CHARACTER_SCALE_BOUNDS.min, CHARACTER_SCALE_BOUNDS.max);
										return next;
									})}
								/>
							)}

							<ShotRig
								preset={preset}
								nonce={nonce}
								appliedPresetRef={shotPresetAppliedRef}
								lastPosRef={shotCameraPosRef}
								fovDeg={fovDeg}
								charA={charA}
								charB={charB}
								showB={showB}
								probe={{ scene: playbackSceneBase, frameRef: propFrameRef, carry: subjectCarry }}
								camRef={shotCamRef}
								look={look}
								onMetrics={(p, visible) => updateShotMetrics({ position: p, visible, playing: tlPlaying, setCameraPos, setSubjectVisible, cameraRef: shotCameraPosRef, visibleRef: subjectVisibleRef })}
							/>
							<MoveRig
								playing={movePlaying}
								// Authoring modes own the viewport: placing or dragging a root
								// waypoint scrubs the playhead as a side effect, and follow
								// must not turn that scrub into a camera lurch. Same for IK
								// and pose studio, where the shot camera is deliberately frozen.
								// Preview is the finished-output player: the move always rides
								// the playhead there. The Follow toggle and authoring-mode gates
								// only protect the editor view's manipulation surfaces.
								// This shot's Camera Block owns the camera while Follow or Rail is active;
								// editorial camera keys resume when the block returns to Keys mode.
								following={!followCamActive && hasCameraKeys && (preview || (moveFollow && !ikMode && !waypointMode && !posing))}
								followFrame={tlFrame}
								frameRef={propFrameRef}
								fps={tlFps}
								keys={cameraKeys}
								shots={shots}
								scene={playbackScene}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => (lookThroughShot && flyingRef.current) || manualCameraOverrideRef.current}
								onDone={shotsDomain.finishCameraMove}
							/>
							<FollowCamRig
								enabled={followCamActive && !movePlaying}
								frame={tlFrame}
								frameRef={propFrameRef}
								scene={playbackScene}
								shot={activeShot}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => (lookThroughShot && flyingRef.current) || manualCameraOverrideRef.current}
							/>
							{/* Camera stays live in IK mode but drives the POSER camera,
							    never the shot camera: the handle layer only consumes
							    pointerdowns that hit a handle, so empty-space drags orbit
							    and the wheel dollies without wrecking the framing. */}
							<FlyControls
								enabled={!posing && !playMode && !sculptMode}
								camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef}
								look={ikMode ? poserLook : lookThroughShot ? look : editorLook}
								getPivot={() => {
									if (!selectedSceneObject) return null;
									const size = objectSize(selectedSceneObject);
									return { x: selectedSceneObject.x, y: (selectedSceneObject.y ?? 0) + size.height / 2, z: selectedSceneObject.z };
								}}
							onFlyStateChange={(flying) => {
								flyingRef.current = flying;
								if (flying) trackFeature("camera_fly");
							}}
								onCameraChange={lookThroughShot && !ikMode ? commitManualCameraFraming : undefined}
							/>
							<PoseHandles
								root={posedRig()}
								enabled={!!posing && !planIsMain && !playMode}
								onChange={(before, after) => {
									markSemanticEdit("pose", before, after);
									setPoseTick((n) => n + 1);
								}}
								onCommit={commitPosedPose}
							/>
							<IkHandles
								chains={ikChains}
								fkJoints={ikFkJoints}
								ikState={ikStateRef.current}
								enabled={ikMode && (ikEditTool === "ik" || ikEditTool === "pin") && !posing && !playMode}
								selectionOnly={ikEditTool === "pin"}
								onPartPick={(track) => { setRangePinPartPick(track); setRangePinSelection(null); }}
								focus={ikFocus}
								onFocus={focusIkHandle}
								onSolve={ikSolve}
								onDragEnd={ikDragEnd}
								focusToolsHidden={fingerEditing} exposureProbeRef={fingerExposureRef}
							/>
							<FingerHandles fingers={handFingers} enabled={fingerEditing && ikMode && ikEditTool === "ik" && !posing && !playMode} onSolve={ikSolve} onDragEnd={ikDragEnd} exposureProbeRef={fingerExposureRef} />
							<RangePinMarker
								chains={ikChains}
								track={rangePinPreview?.track}
								target={rangePinPreview?.target}
								enabled={ikMode && ikEditTool === "pin" && Boolean(rangePinPreview?.target)}
							/>
							{/* The landing playground's top view: camera, cast and the rail
							    only, so a rail is drawn on a clean floor. */}
							<PlanBoard
								minimal={playgroundMode}
								hostRef={planHostRef}
								planCamRef={planCamRef}
								shotCamRef={shotCamRef}
								look={look}
								fovDeg={fovDeg}
								characters={characters}
								characterPlacements={characterViews}
								onMoveCharacter={moveCharacter}
								onCameraGestureStart={beginCameraFramingGesture}
								pathStart={activeChar}
								waypoints={waypoints}
								activeWaypointId={activeWaypointId}
								onSelectWaypoint={(id) => { const waypoint = waypoints.find((entry) => entry.id === id); if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`); setActiveWaypointId(id); setTlFrame(Math.min(waypoint.frame, tlFrameCount - 1)); setWaypointMode(true); }}
								onMoveWaypoint={moveWaypoint}
								// Selection switch first, then the producer begins its
								// transaction (plan §6.4): the settle here commits any
								// previously open drag as one entry so the fresh token
								// issued by onObjectMoveStart cannot leak.
								onSelectEntity={(id) => {
									objectsDomain.settleObjects();
									setSelectedHierarchyId(id.startsWith("object:") ? id : id === "cam" ? "camera" : charKeyToHierarchyId(id));
								}}
								sceneObjects={stageSceneObjects}
								selectedSceneObjectId={selectedSceneObjectId}
								onMoveSceneObject={changeSceneObject}
								onObjectMoveStart={beginSceneTransaction}
								onObjectMoveEnd={endSceneTransaction}
								cameraRailPoints={railCurve ? railCurve.points : null}
								railDraw={railDraw}
								pathDraw={pathDraw}
								objectPath={routeOwner?.path ?? null}
								objectPathSelectedIndex={pathPointIndex}
								onObjectPathPointSelect={setPathPointIndex}
								onObjectPathChange={(patch) => {
									const path = routeOwner?.path;
									if (!path) return;
									// Inside the gesture's own transaction (planPathTokenRef), like
									// the 3D view. The board bends the floor route only; a point's
									// height is the scene's business, so y rides through untouched.
									changeSceneObject(routeOwner.id, { path: { ...path, ...patch } }, planPathTokenRef.current);
								}}
								onObjectPathMarkInsert={(t) => {
									const path = routeOwner?.path;
									if (!path) return;
									// The new dot is born with the lean the route already has there,
									// and it goes to the record that owns the route (the selected
									// group may only contain it).
									const added = insertPathMark(path, t);
									if (!added) return;
									const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
									changeSceneObject(routeOwner.id, { path: { ...path, marks: added.marks } }, token);
									endSceneTransaction(token, { commit: true });
									setPathPointIndex(added.index);
									setToast(ko("Dot added — drag it to bend the route", "점을 추가했어요 — 끌어서 경로를 휘세요"));
								}}
								onObjectPathGestureStart={() => {
									planPathTokenRef.current = beginSceneTransaction({ owner: "object-path", cancel: () => { planPathTokenRef.current = null; } });
								}}
								onObjectPathGestureEnd={(commit) => {
									if (planPathTokenRef.current != null) endSceneTransaction(planPathTokenRef.current, { commit });
									planPathTokenRef.current = null;
								}}
								subjectTrack={motion ? subjectTrack : null}
								keyLight={keyLight}
								onRailStroke={shotsDomain.drawCameraRail}
								onPathStroke={(stroke) => {
									if (!pathTarget) return;
									// The stroke keeps its shape, as the camera rail's does; the
									// operator adds the dots they want to hold by double-clicking
									// the line. The route starts at the height
									// the object stands at, so a raised body (a chassis on its
									// wheels, a prop on a table) travels where it is instead of
									// dropping to the floor; changing height comes later, from
									// dragging a point in the scene.
									const height = pathTarget.attach ? 0 : pathTarget.y ?? 0;
									const points = strokeToPathPoints(stroke, simplifyStroke).map((point) => ({ ...point, y: height }));
									if (points.length < 2) return;
									const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
									// A new stroke is a new shape: marks belong to the old one.
									changeSceneObject(pathTarget.id, { path: { ...(pathTarget.path ?? {}), points, marks: [] } }, token);
									endSceneTransaction(token, { commit: true });
									setPathPointIndex(null);
									setPathDraw(false);
									const metrics = pathMetrics(createObjectPath({ points }));
									setToast(ko(`Travel path drawn — ${metrics.length.toFixed(1)} m, ${points.length} points`,
										`이동 경로 완성 — ${metrics.length.toFixed(1)} m, 점 ${points.length}개`,
										`移动路径已完成 — ${metrics.length.toFixed(1)} m，${points.length} 个点`));
								}}
								onCameraChange={commitManualCameraFraming}
							/>
							{/* Object gizmo: the shot pane's direct manipulation. Off while
							    the plan owns the big pane (the pucks are the handles there)
							    and while posing/IK owns the pointer. */}
							<ObjectGizmo
								object={cameraGizmoObject ?? lightGizmoObject ?? (selectedSceneObject && !isEffectivelyHidden(selectedSceneObject, sceneObjects, characters) ? gizmoSceneObject : null)}
								objects={sceneObjects}
								held={cameraGizmoObject || lightGizmoObject ? null : heldEdit.gizmo}
								mode={lightGizmoObject ? "move" : cameraGizmoObject ? (gizmoMode === "scale" ? "move" : gizmoMode) : gizmoMode}
								snap={snapEnabled}
								enabled={!planIsMain && !posing && !ikMode && !playMode && !sculptMode}
								paneRef={mainPaneRef}
								camRef={lookThroughShot ? shotCamRef : editorCamRef}
								shotAspect={lookThroughShot ? shotOutput.aspect : null}
								// The token MUST round-trip: dropping it sends every drag tick
								// through applyAtomic, whose settle cancels the open drag after
								// its first move (the gizmo hands its teardown as the cancel).
								onChange={(id, patch, token) => (id === "__shotcam__" ? changeShotCameraFromGizmo(id, patch) : id === "__keylight__" ? changeKeyLightFromGizmo(id, patch) : changeSceneObject(id, patch, token))}
								onDragStart={(...args) => (cameraGizmoObject || lightGizmoObject ? undefined : beginSceneTransaction(...args))}
								onDragEnd={(...args) => {
									if (lightGizmoObject) endGestureUndo();
									else if (!cameraGizmoObject) endSceneTransaction(...args);
								}}
								onSelect={(id) =>
									selectHierarchy(
										id === "__shotcam__" ? "camera" : id === "__keylight__" ? "light" : id?.startsWith("char:") ? charKeyToHierarchyId(id) : id ? `object:${id}` : "props",
									)
								}
								onGroundClick={waypointMode && !planIsMain ? addFloorWaypoint : undefined}
							/>
							{!preview && railCurve && (
								<CameraRailScenePreview
									points={railCurve.points}
									cumLen={railCurve.cumLen}
									length={railCurve.length}
									crane={activeCamera.craneHeight}
								/>
							)}
							<ObjectPathHandles
								path={routeOwner?.path ?? null}
								selectedIndex={pathPointIndex}
								mode={gizmoMode}
								enabled={!preview && !lookThroughShot && !ikMode && !posing && !!routeOwner?.path}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={setPathPointIndex}
								onChangePath={(patch) => {
									if (!routeOwner) return;
									// Inside the drag's own transaction, like the Top-View mark
									// move: a plain update while the transaction is open is
									// refused, so the dot never moved in the 3D view.
									changeSceneObject(routeOwner.id, { path: patch === null ? null : { ...routeOwner.path, ...patch } }, pathDragTokenRef.current);
								}}
								onDragStart={() => {
									pathDragTokenRef.current = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
								}}
								onDragEnd={() => {
									if (pathDragTokenRef.current) endSceneTransaction(pathDragTokenRef.current, { commit: true });
									pathDragTokenRef.current = null;
								}}
							/>
							<CraneHandles
								rail={railCurve}
								crane={activeCamera.craneHeight}
								controlPoints={activeCamera.cameraRail}
								selectedIndex={craneSelectedIndex}
								enabled={!preview && !lookThroughShot && !ikMode && !posing && !!railCurve && !!activeCamera.craneHeight}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={setCraneSelectedIndex}
								onChangePoints={shotsDomain.changeCranePoints}
								onChangeRail={shotsDomain.changeCraneRail}
							/>
							<EditorCamSeed camRef={editorCamRef} lookRef={editorLook} shotCamRef={shotCamRef} subject={charA} />
							<CameraGlide glide={camGlide} camRef={editorCamRef} lookRef={editorLook} onDone={() => setCamGlide(null)} />
							<ViewportMeasurement camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef} />
							<ShotLookApplier camRef={shotCamRef} look={look} />
							<ShotCameraGhost
								camRef={shotCamRef}
								fovDeg={fovDeg}
								aspect={shotOutput.aspect}
								visible={!preview && !lookThroughShot && !ikMode && !posing}
								selected={shotCameraSelected}
							/>
							{waypointMode && !preview && (
								<ShotPathPreview waypoints={waypoints} start={charA} activeWaypointId={activeWaypointId} />
							)}
							<CaptureRig
								apiRef={captureRef}
								camRef={shotCamRef}
								width={shotOutput.width}
								height={shotOutput.height}
							/>
							<CaptureRig apiRef={mcpCaptureRef} camRef={shotCamRef} width={MCP_CAPTURE_W} height={MCP_CAPTURE_H} />
							
							<DualRender
								stageRef={stageRef}
								mainRef={mainPaneRef}
								insetRef={insetPaneRef}
								shotPreviewRef={shotPreviewRef}
								shotCamRef={shotCamRef}
								planCamRef={planCamRef}
								poserCamRef={poserCamRef}
								editorCamRef={sculptMode ? sculptCamRef : editorCamRef}
								// The studio and the landing playground hide the facing marks on
								// screen; the Workflow embed shows the scene as exported. Captures
								// render outside this loop and keep them everywhere.
								editorLook={!embedMode}
								ikMode={ikMode}
								planIsMain={planIsMain}
								// Preview IS PlayView's render path: DualRender tests this branch
								// first, so the embed and playground rail land in the letterboxed
								// player. Studio look-through keeps playMode false and flies the
								// shot camera in the editing draw instead.
								playMode={preview}
								lookThrough={lookThroughShot}
								insetCollapsed={workspaceLayout.insetCollapsed || workflowMode === "motion" || workflowMode === "pose" || workflowMode === "sculpt"}
								planZoom={workspaceLayout.planZoom}
								shotAspect={shotOutput.aspect}
								shotOptics={activeShot?.optics ?? null}
							/>
						</Canvas>

						{/* Line editing (C6): the path overlay. A plain 2D canvas stacked
						    on the stage — it never enters the three.js scene graph, so an
						    edit cannot disturb picking, playback or the render loop, and it
						    behaves the same in every view mode.
						    It carries NO pointer handlers and is `pointer-events: none`:
						    the mode must not take the viewport hostage, so the listeners
						    live on the stage container (capture phase) and consume a
						    pointer only when it actually grabs the curve. Everything else
						    — orbit, pan, click-to-select — reaches the WebGL canvas
						    untouched while the mode is on. */}

						{!webGlAvailable && (
							<div className="gl-lost-overlay" role="alert" data-testid="webgl-unavailable">
								<div className="gl-lost-card">
									<strong>{ko("3D graphics (WebGL) is turned off in this browser", "이 브라우저에서 3D 그래픽(WebGL)이 꺼져 있어요")}</strong>
									<p>{ko("Quit the browser completely (Cmd+Q) and reopen it, or turn on \"Use graphics acceleration when available\" in its settings. chrome://gpu shows the WebGL status.", "브라우저를 완전히 종료(Cmd+Q)했다가 다시 열거나, 설정에서 '가능한 경우 그래픽 가속 사용'을 켜세요. chrome://gpu 에서 WebGL 상태를 확인할 수 있어요.")}</p>
								</div>
							</div>
						)}

						{glContextLost && (
							<div className="gl-lost-overlay" role="alert">
								<div className="gl-lost-card">
									<strong>{ko("The 3D view lost its graphics context", "3D 뷰가 그래픽 컨텍스트를 잃었어요")}</strong>
									<p>{ko("Waiting for the browser to restore it. If this stays, reload the studio — scenes autosave.", "브라우저가 복구하기를 기다리는 중이에요. 계속 멈춰 있으면 새로고침하세요 — 장면은 자동 저장됩니다.")}</p>
									<button type="button" onClick={() => window.location.reload()}>{ko("Reload", "새로고침")}</button>
								</div>
							</div>
						)}

						<div ref={mainPaneRef} className={"vp-pane vp-main" + (planIsMain ? " plan" : "")} />
						<div
							ref={insetPaneRef}
							hidden={playMode}
							className={"vp-pane vp-inset" + (planIsMain || ikMode ? " shot" : " plan") + (workspaceLayout.insetCollapsed ? " collapsed" : "")}
							style={{
								"--shot-aspect": shotOutput.aspect,
								...(insetPos ? { left: insetPos.x, top: insetPos.y, right: "auto" } : {}),
							}}
						>
							<span
								className="vp-inset-tag"
								title={workspaceLayout.insetCollapsed ? ko("Click or ▸ to expand · drag to move", "클릭 또는 ▸로 펼치기 · 드래그로 이동") : ko("Click or ▾ to fold · drag to move", "클릭 또는 ▾로 접기 · 드래그로 이동")}
								onPointerDown={beginInsetDrag}
							>
								<span
									className="vp-inset-caret"
									role="button"
									tabIndex={-1}
									aria-expanded={!workspaceLayout.insetCollapsed}
									aria-label={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									title={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									onPointerDown={(e) => e.stopPropagation()}
									// Same one-fold-per-gesture rule as the tag: ignore the
									// second click of a double-click (detail=2).
									onClick={(e) => {
										if (e.detail > 1) return;
										insetToggledAtRef.current = Date.now();
										runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed });
									}}
								>
									{workspaceLayout.insetCollapsed ? "▸" : "▾"}
								</span>
								{planIsMain || ikMode ? ko("Shot view", "샷 뷰") : ko("Top-View", "탑뷰")}
								{!planIsMain && !ikMode && workspaceLayout.planZoom !== 1 && !workspaceLayout.insetCollapsed && (
									<em className="vp-inset-zoom">{workspaceLayout.planZoom.toFixed(2).replace(/\.?0+$/, "")}×</em>
								)}
							</span>
							{!workspaceLayout.insetCollapsed && (
								<span
									className="vp-inset-resize"
									role="separator"
								aria-label={ko("Resize inset view", "인셋 보기 크기 조절")}
									onPointerDown={beginInsetResize}
								/>
							)}
						</div>

						<div
							ref={shotPreviewRef}
							hidden={playMode || lookThroughShot}
							className="vp-pane vp-shot-preview"
							style={{ "--shot-aspect": shotOutput.aspect }}
						>
							<ShotGuideOverlay mode={guideMode} aspect={shotOutput.aspect} />
							<span className="vp-inset-tag vp-shot-preview-tag">
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot", "샷")}
								<button
									type="button"
									className="vp-look-through"
									aria-label={ko("Look through the shot camera", "샷 카메라 시점으로 보기")}
									title={ko("Look through the shot camera — right-drag, WASD and orbit set the recording lens (Esc returns)", "샷 카메라 시점으로 보기 — 오른쪽 드래그, WASD, 궤도로 촬영 렌즈를 맞춥니다 (Esc로 복귀)")}
									onClick={enterShotLook}
								>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
										<path d="M15 3h6v6" />
										<path d="M21 3l-8 8" />
										<path d="M9 21H3v-6" />
										<path d="M3 21l8-8" />
									</svg>
									{ko("Look through", "샷 시점")}
								</button>
							</span>
						</div>
						{/* The player's only visible affordance: without it Esc would be
						    the sole way back, and the embed has no way back at all — the
						    Workflow node's preview is meant to stay in the shot view. */}
						{lookThroughShot && !ikMode && !embedMode && (
							<button
								type="button"
								className="vp-inset-tag vp-look-through-exit"
								title={ko("Return to the editor view (Esc)", "에디터 시점으로 돌아가기 (Esc)")}
								onClick={exitPreview}
							>
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot camera", "샷 카메라")}
								<span className="vp-exit-hint">{ko("Esc · exit", "Esc · 나가기")}</span>
							</button>
						)}

						{/* Composition guides are an opt-in viewer preference (default off),
						    so they follow the shot camera into the player rather than being
						    counted as chrome. */}
						{lookThroughShot && !ikMode && (
							<ShotGuideOverlay mode={guideMode} aspect={shotOutput.aspect} className="lookthrough" />
						)}
						<div className="film-frame" hidden={playMode || !lookThroughShot}>
							<span />
							<span />
							<span />
							<span />
						</div>
						<div className={"caption" + (subjectVisible ? "" : " off")} hidden={playMode || !lookThroughShot}>
							{subjectVisible ? slateLineKo(shot) : ko("SUBJECT OUT OF FRAME", "피사체가 프레임 밖에 있어요")}
						</div>

						</div>
					</div>
			}
		>

			{result && resultOpen && (
				<ResultModal
					result={result}
					copied={copied}
					recordedVideoName={result.mode === "video" ? recordedVideoName : null}
					onClose={() => setResultOpen(false)}
					onCopy={() => copyPrompt(result.prompt)}
					onDownload={download}
					downloadDisabled={recState === "recording" || Boolean(result.downloaded)}
					exportFeedback={exportStatus?.kind === "frame" ? exportFeedback() : null}
				/>
			)}

			{(projectBrowserOpen || projectStartupOpen) && (
				<ProjectBrowser
					startup={projectStartupOpen}
					currentName={projectName}
					onOpen={(entry) => openProjectByHandle(entry.handle)}
					onOpenFile={() => {
						setProjectBrowserOpen(false);
						openProject();
					}}
					starters={STARTER_SCENES}
					onStarter={(id, name, options) => {
						setProjectBrowserOpen(false);
						void openStarterScene(id, "starter", name, options?.castStyle);
					}}
					onNew={(name, options) => {
						setProjectBrowserOpen(false);
						requestNewProject(false, options);
					}}
					onClose={() => {
						setProjectBrowserOpen(false);
						setProjectStartupOpen(false);
					}}
				/>
			)}
			<ProjectNameDialog
				open={Boolean(projectNameDialog)}
				initialName={projectNameDialog?.initialName}
				onCancel={() => setProjectNameDialog(null)}
				onSubmit={(name) => {
					const kind = projectNameDialog?.kind;
					if (kind === "save") void saveProject(false, name);
					else newProject(name);
				}}
			/>
			<FirstSuccessGuide open={firstSuccessGuideOpen} previsMode={scenesDomain.previsMode} onDismiss={() => setFirstSuccessGuideOpen(false)} />
			<UseCaseQuestion
				open={useCaseAskOpen}
				isKo={isKo} isZh={isZh}
				onAnswer={(useCase, team) => {
					recordUseCase(useCase, team);
					setUseCaseAskOpen(false);
				}}
			/>
			{saveBlockedReasons && <SaveBlockedDialog reasons={saveBlockedReasons} onClose={() => setSaveBlockedReasons(null)} />}
			<Toast message={toast} onDone={() => showToast((current) => current === toast ? "" : current)} />
			{pwaUpdate && (
				<div className="scene-delete-toast" role="status">
					<span>{ko("A new version of CozyClay is ready.", "CozyClay 새 버전이 준비됐어요.")}</span>
					<button
						type="button"
						onClick={() => {
							// The worker is waiting; tell it to take over, which the
							// controllerchange listener turns into one reload.
							pwaUpdate.waiting?.postMessage({ type: "SKIP_WAITING" });
							setPwaUpdate(null);
						}}
					>
						{ko("Reload to update", "새로고침해 업데이트")}
					</button>
					<button type="button" className="ghost" onClick={() => setPwaUpdate(null)}>
						{ko("Later", "나중에")}
					</button>
				</div>
			)}
			{objectDeleteUndo && (
				<div className="scene-delete-toast" role="status">
					<span>{ko("Object deleted.", "오브젝트를 삭제했어요.")}</span>
					<button type="button" aria-label={ko("Undo object deletion", "오브젝트 삭제 실행 취소")} onClick={undoObjectDeletion}>
						{ko("Undo", "실행 취소")}
					</button>
				</div>
			)}
			{restoreOffer && (
				<div className="asset-delete-toast" role="status">
					<span>{ko(`Restore last project${restoreOffer.name ? `: ${restoreOffer.name}` : ""}`, `마지막 프로젝트 복원${restoreOffer.name ? `: ${restoreOffer.name}` : ""}`, `恢复上次项目${restoreOffer.name ? `：${restoreOffer.name}` : ""}`)}</span>
					<button
						type="button"
						onClick={async () => {
							const record = restoreOffer;
							setRestoreOffer(null);
							if ((await requestHandlePermission(record.handle)) !== "granted") {
								setToast(ko("Project access was not granted.", "프로젝트 접근이 허용되지 않았어요."));
								return;
							}
							await restoreStoredProject(record);
						}}
					>
						{ko("Restore", "복원")}
					</button>
					<button type="button" onClick={() => setRestoreOffer(null)} aria-label={ko("Dismiss", "닫기")}>✕</button>
				</div>
			)}
			{assetTrash.length > 0 && assetUndoOffered && (
				<div className="asset-delete-toast" role="status">
					<span>{ko("Image deleted. This session can undo it.", "이미지를 삭제했어요. 이 세션에서 실행 취소할 수 있어요.")}</span>
					<button type="button" onClick={undoDeletedAsset} disabled={Boolean(deletingAssetId)}>{ko("Undo", "실행 취소")}</button>
				</div>
			)}
			{assetDrag && (
				<div className="asset-drag-ghost" style={{ left: assetDrag.x, top: assetDrag.y }} aria-hidden="true">
					{assetDrag.payload.kind === "image" && assetDrag.payload.thumb ? (
						<img className="asset-drag-ghost-thumb" src={assetDrag.payload.thumb} alt="" />
					) : (
						<span
							className="asset-card-swatch"
							data-model={assetDrag.payload.kind === "character" ? assetDrag.payload.id : undefined}
							style={assetDrag.payload.kind === "object" ? { background: assetDrag.payload.color } : undefined}
						/>
					)}
					<span>{assetDrag.payload.label}</span>
				</div>
			)}
		</StudioShell>
		</StudioShellContext.Provider>
		</AppContext.Provider>
	);
}
