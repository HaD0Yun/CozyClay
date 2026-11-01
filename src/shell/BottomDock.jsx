import { useEffect, useLayoutEffect, useRef, useState } from "react"; import PoseKeyBar from "./PoseKeyBar.jsx";
import { useStudioPlaybackFrame, useStudioShell } from "./studio-shell-context.js";
import { logStore } from "./log-store.js";
import "./dock.css";
import LibrarySlot from "./LibrarySlot.jsx";
import BoardSlot from "./BoardSlot.jsx";
import LensScrub from "./lens-scrub.jsx";
import { ko } from "../locale.js";
import Timeline, { timelineTake } from "../motion/timeline.jsx";
import { DEFAULT_PLAYBACK_SPEED, sceneObjectNameDisplayKo } from "../app-stage.jsx";

import { trackFeature } from "../analytics.js";
import { defaultRailRange } from "../camera-rail-schedule.js";
import { insertPathMark, pathMarks } from "../object-path.js";

// G11: the dock resizes within [220, 480] px, and never so far that the 3D
// viewport drops under 480 px (top bar 44 + status bar 24 + three 1 px gaps).
// Never below the sequencer's own grid (shell.css --shell-dock-default, 276
// px): a shorter dock would have to scroll its lanes.
const DOCK_MIN_HEIGHT = 276;
const DOCK_MAX_HEIGHT = 480;
const VIEWPORT_MIN_HEIGHT = 480;
const SHELL_FIXED_ROWS = 44 + 24 + 3;
// v2: v1 heights were clamped to a 324px floor that left an empty band under
// the lanes; they are dropped so the dock opens at its real grid height.
const DOCK_HEIGHT_KEY = "cozyclay.dock.height.v2";

function clampDockHeight(height) {
	const roomy = Math.min(DOCK_MAX_HEIGHT, window.innerHeight - SHELL_FIXED_ROWS - VIEWPORT_MIN_HEIGHT);
	return Math.round(Math.min(Math.max(DOCK_MIN_HEIGHT, roomy), Math.max(DOCK_MIN_HEIGHT, height)));
}

function readStored(key) {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStored(key, value) {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch (error) {
		console.warn(`[cozyclay] could not store ${key}`, error);
	}
}

function readDockHeight() {
	const stored = Number(readStored(DOCK_HEIGHT_KEY));
	return Number.isFinite(stored) && stored > 0 ? stored : null;
}

const DOCK_TABS = [
	{ key: "board", label: () => ko("Board", "보드") },
	{ key: "animation", label: () => ko("Animation", "애니메이션") },
	{ key: "assets", label: () => ko("Assets", "에셋") },
];

/** The dock's tabs for a project mode: a storyboard works in panels
 * (Board | Assets), an animation in the Sequencer (Animation | Assets). */
function dockTabsFor(previsMode) {
	const keys = previsMode === "storyboard" ? ["board", "assets"] : ["animation", "assets"];
	return keys.map((key) => DOCK_TABS.find((entry) => entry.key === key));
}

/** Animation | Assets (Board | Assets in a storyboard): all stay mounted, so
 * switching keeps the Sequencer's scroll and zoom and the Library's folder
 * and search. Any stored tab the mode does not offer opens its first tab. */
export default function BottomDock({ tab: requestedTab = "animation", onTabChange, embedded = false }) {
	const { previsMode } = useStudioShell(), liveFrame = useStudioPlaybackFrame();
	const tabs = embedded ? dockTabsFor(null) : dockTabsFor(previsMode);
	const tab = tabs.some((entry) => entry.key === requestedTab) ? requestedTab : tabs[0].key;
	const {
		motion, waypointMode, craneSelectedIndex,
		isCameraSelection, addActiveCranePoint, deleteSelectedCranePoint, setCraneSelectedIndex, tlFrameCount,
		tlFps, characters, activeCharIndex, ghostLayers, pathSpeed,
		tlPlaying, workflowMode, waypoints, pendingWaypointFrame,
		stateBadge, ikMode, ikChains, ikFrames,
		rangePins, rangePinSelection, ikEditTool, rangePinPreview, footSnap,
		bodyContact, shots, shotAspectKey, activeShotIdx, railDraw,
		pathDraw, pathTarget, setPathDraw, setRailDraw, setWorkspaceLayout,
		changeSceneObject, timingTokenRef, beginSceneTransaction, endSceneTransaction, railCurve,
		posing, ikAddKeyframe, ikDeleteKeyframe, setRangePinSelection, setIkEditTool,
		setBodyContact, setToast, setFootSnap, setTlFrame, advanceFrame,
		stepFrame, cameraPreviewEndRef, manualCameraOverrideRef, setTlPlaying, toggleWaypointMode,
		setWaypointMode, selectActiveCharacterInHierarchy, setActiveWaypointId, setPendingWaypointFrame, removeWaypoint,
		queueRootWaypointFrame, setSelectedHierarchyId,
		selectWorkflowMode, addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, syncActiveCameraFraming,
		activeCamera, activeShotDuration, changeActiveCamera, cameraRail, previewCameraShot,
		toggleCameraRailDraw, deleteCameraRail, selectTimelineShot, shotsDomain, runStudioAction,
		clearMotion, subscribeToasts, exportStatus, exportPhaseLabel,
		pathPointIndex, setPathPointIndex,
	} = useStudioShell();
	const dockRef = useRef(null);
	const [dockHeight, setDockHeight] = useState(readDockHeight);
	const dockHeightRef = useRef(dockHeight);
	dockHeightRef.current = dockHeight;

	// The dock height is the shell row's --shell-dock-height. null keeps the
	// shell's responsive default; a stored size is re-clamped on every window
	// resize so the viewport never drops under its minimum height.
	useLayoutEffect(() => {
		const app = dockRef.current?.closest(".app");
		if (!app) return undefined;
		const apply = () => {
			if (dockHeightRef.current === null) app.style.removeProperty("--shell-dock-height");
			else app.style.setProperty("--shell-dock-height", `${clampDockHeight(dockHeightRef.current)}px`);
		};
		apply();
		window.addEventListener("resize", apply);
		return () => window.removeEventListener("resize", apply);
	}, [dockHeight]);

	function commitDockHeight(next) {
		const height = clampDockHeight(next);
		setDockHeight(height);
		writeStored(DOCK_HEIGHT_KEY, String(height));
	}

	function beginDockResize(event) {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const startY = event.clientY;
		const startHeight = dockRef.current.getBoundingClientRect().height;
		let latest = startHeight;
		const onMove = (move) => {
			latest = clampDockHeight(startHeight - (move.clientY - startY));
			setDockHeight(latest);
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", "resize-timeline");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			commitDockHeight(latest);
		};
		document.body.classList.add("is-resizing", "resize-timeline");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	function onDockResizeKey(event) {
		const step = event.shiftKey ? 48 : 16;
		const current = dockRef.current.getBoundingClientRect().height;
		if (event.key === "ArrowUp") commitDockHeight(current + step);
		else if (event.key === "ArrowDown") commitDockHeight(current - step);
		else if (event.key === "Home") commitDockHeight(DOCK_MIN_HEIGHT);
		else if (event.key === "End") commitDockHeight(DOCK_MAX_HEIGHT);
		else return;
		event.preventDefault();
	}

	// Session Log: every toast (App fans each one out to subscribeToasts),
	// generation jobs and export phases. The toast sink set lives for the
	// whole session, so one subscription on mount is enough.
	useEffect(() => subscribeToasts((toast) => logStore.push({ kind: "toast", text: toast.uiMessage })),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[]);
	const exportPhase = exportStatus?.phase, exportLabel = exportStatus?.label, exportMessage = exportStatus?.message;
	const exportDone = exportStatus?.completedFrames, exportTotal = exportStatus?.frameCount;
	useEffect(() => {
		if (!exportPhase) return;
		const progress = exportPhase === "encoding" && exportTotal ? ` ${exportDone ?? 0}/${exportTotal}` : "";
		const detail = ["completed", "failed", "cancelled"].includes(exportPhase) && exportMessage ? ` — ${exportMessage}` : "";
		logStore.push({
			kind: "export",
			key: `export:${exportLabel}:${exportPhase}`,
			text: `${ko("Export", "내보내기")} ${exportPhaseLabel(exportPhase)}${exportLabel ? ` · ${exportLabel}` : ""}${progress}${detail}`,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [exportPhase, exportLabel, exportMessage, exportDone, exportTotal]);

	return (
		<div className="bottom-window v2-dock" ref={dockRef}>
			<div
				className="v2-dock-resize"
				data-testid="dock-resize-handle"
				role="separator"
				tabIndex={0}
				aria-orientation="horizontal"
				aria-label={ko("Resize bottom dock", "하단 도크 크기 조절")}
				aria-valuemin={DOCK_MIN_HEIGHT}
				aria-valuemax={DOCK_MAX_HEIGHT}
				aria-valuenow={dockHeight ?? undefined}
				onPointerDown={beginDockResize}
				onKeyDown={onDockResizeKey}
			/>
			{!embedded && <div className="dock-tabs" role="tablist" aria-label={ko("Dock", "도크")}>
				{tabs.map((entry) => (
					<button
						type="button"
						role="tab"
						key={entry.key}
						data-testid={`dock-tab-${entry.key}`} data-fid={`dock_tab_${entry.key}`}
						aria-selected={tab === entry.key}
						onClick={() => onTabChange?.(entry.key)}
					>
						{entry.label()}
					</button>
				))}
			</div>}
			{!embedded && <LibrarySlot active={tab === "assets"} />}
			{!embedded && previsMode === "storyboard" && <BoardSlot active={tab === "board"} />}
			<div className="bottom-timeline" hidden={tab !== "animation"}><PoseKeyBar frame={liveFrame} frameCount={tlFrameCount} poseMode={Boolean(ikMode)} keyedFrames={ikFrames ?? []} characterId={characters[activeCharIndex]?.id ?? null} />
			<Timeline
				frame={liveFrame}
				craneSelectedIndex={craneSelectedIndex}
				cameraSelected={isCameraSelection}
				onCranePointAdd={addActiveCranePoint}
				onCranePointDelete={deleteSelectedCranePoint}
				onCranePointSelect={setCraneSelectedIndex}
				frameCount={tlFrameCount}
				fps={tlFps}
				playbackSpeed={DEFAULT_PLAYBACK_SPEED}
			trackOwner={characters.length > 1 ? `S${activeCharIndex + 1}` : null}
			ghostLayers={ghostLayers}
			pathSpeed={pathSpeed}
			playing={tlPlaying}
			workflowMode={workflowMode === "pose" ? "motion" : workflowMode}
			waypointMode={waypointMode}
			waypoints={waypoints}
			pendingWaypointFrame={pendingWaypointFrame}
			badge={stateBadge}
			ikMode={ikMode}
			ikDisabled={!ikChains}
			motion={timelineTake(motion, characters[activeCharIndex]?.id, runStudioAction)}
			ikFrames={ikFrames}
			rangePins={rangePins}
			selectedPinId={rangePinSelection}
			pendingPinRange={ikMode && ikEditTool === "pin" ? rangePinPreview?.draft ?? null : null}
			footSnap={footSnap}
			bodyContact={bodyContact}
				shots={shots}
				shotAspect={shotAspectKey}
				activeShotIdx={activeShotIdx}
				railDraw={railDraw}
				pathDraw={pathDraw}
				pathObject={pathTarget ? { id: pathTarget.id, name: sceneObjectNameDisplayKo(pathTarget.name), path: pathTarget.path } : null}
				onObjectPathDrawToggle={() => {
					setPathDraw((current) => !current);
					if (!pathDraw) setRailDraw(false);
					setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
				}}
				onObjectPathChange={(path) => {
					if (pathTarget) changeSceneObject(pathTarget.id, { path }, timingTokenRef.current ?? undefined);
				}}
				objectPathPointIndex={pathPointIndex}
				onObjectMarkAdd={(t) => {
					const path = pathTarget?.path;
					const added = path ? insertPathMark(path, t) : null;
					if (!added) return;
					const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
					changeSceneObject(pathTarget.id, { path: { ...path, marks: added.marks } }, token);
					endSceneTransaction(token, { commit: true });
					setPathPointIndex(added.index);
				}}
				onObjectMarkLean={(key, value, token) => {
					const path = pathTarget?.path;
					if (!path || pathPointIndex == null || (key !== "bank" && key !== "pitch")) return;
					const marks = pathMarks(path);
					if (pathPointIndex < 1 || pathPointIndex > marks.length) return;
					const next = { ...path, marks: marks.map((mark, i) => (i + 1 === pathPointIndex ? { ...mark, [key]: value } : mark)) };
					// A scrub hands its own transaction; a typed value is one entry.
					if (token != null) {
						changeSceneObject(pathTarget.id, { path: next }, token);
						return;
					}
					const own = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
					changeSceneObject(pathTarget.id, { path: next }, own);
					endSceneTransaction(own, { commit: true });
				}}
				onObjectMarkScrubStart={beginSceneTransaction}
				onObjectMarkScrubEnd={endSceneTransaction}
				onObjectPathClear={() => {
					if (!pathTarget) return;
					const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
					changeSceneObject(pathTarget.id, { path: null }, token);
					endSceneTransaction(token, { commit: true });
				}}
				onObjectTimingGestureStart={() => {
					timingTokenRef.current = beginSceneTransaction({ owner: "object-timing", cancel: () => { timingTokenRef.current = null; } });
				}}
				onObjectTimingGestureEnd={() => {
					if (timingTokenRef.current != null) endSceneTransaction(timingTokenRef.current, { commit: true });
					timingTokenRef.current = null;
				}}
				cameraRailLength={railCurve?.length ?? null}
			shotCutDisabled={!!posing || ikMode || waypointMode}
			onIkKeyframeAdd={ikAddKeyframe}
			onIkKeyframeRemove={ikDeleteKeyframe}
			onPinSelect={(id) => { setRangePinSelection(id); setIkEditTool("pin"); }}
			onBodyContactToggle={() => {
				setBodyContact((v) => {
					setToast(v ? ko("Body contact off — floor constraints are disabled", "바닥 접촉 꺼짐 — 바닥 제약이 비활성화됩니다") : ko("Body contact on — body markers stay above the floor", "바닥 접촉 켜짐 — 신체 접촉점이 바닥 아래로 내려가지 않습니다"));
					return !v;
				});
			}}
			onFootSnapToggle={() => {
				setFootSnap((v) => {
			setToast(v ? ko("Foot snap off — the feet follow the body", "발 스냅 꺼짐 — 발이 몸을 따라갑니다") : ko("Foot snap on — the feet stay planted while the body moves", "발 스냅 켜짐 — 몸이 움직여도 발은 바닥에 고정됩니다"));
					return !v;
				});
			}}
			onScrub={(frame) => { trackFeature("timeline_scrub"); setTlFrame(frame); }}
			onAdvance={advanceFrame}
			onStep={stepFrame}
			onPlayToggle={() => {
				cameraPreviewEndRef.current = null;
				manualCameraOverrideRef.current = false;
				setTlPlaying((v) => !v);
			}}
			onWaypointToggle={toggleWaypointMode}
			onMarkerSelect={(id) => {
				const waypoint = waypoints.find((entry) => entry.id === id);
				if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
				setTlFrame(Math.min(waypoint.frame, tlFrameCount - 1));
				setWaypointMode(true);
				selectActiveCharacterInHierarchy();
				setActiveWaypointId(id);
				setPendingWaypointFrame(null);
			}}
			onMarkerRemove={removeWaypoint}
			onRootKeyframeAdd={queueRootWaypointFrame}
			
			onCameraMoveSelect={() => {
				setSelectedHierarchyId("camera");
				if (workflowMode !== "camera") selectWorkflowMode("camera");
			}}
			onCameraKeyframeAdd={addCameraKeyframe}
			onCameraKeyframeMove={moveCameraKeyframe}
				onCameraKeyframeRemove={removeCameraKeyframe}
				onCameraBlockSelect={(shotId) => {
					const selected = shots.find((entry) => entry.id === shotId);
					if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
					setTlFrame(selected.startFrame);
					setSelectedHierarchyId("camera");
					if (workflowMode !== "camera") selectWorkflowMode("camera");
				}}
				onCameraBlockChange={(patch, shotId) => {
					if (patch.mode === "follow") syncActiveCameraFraming();
					const nextPatch = patch.mode === "rail" && activeCamera.railFollow?.mode === "off"
						? { ...patch, railFollow: defaultRailRange(activeShotDuration) }
						: patch;
					// The embedded dolly graph edits the shot it sits in; the
					// camera bar above edits the selected one.
					changeActiveCamera(nextPatch, shotId);
					if (patch.mode === "follow" && !motion) {
						setToast(ko(
							"Follow rides the subject's motion — without a loaded motion the camera composes a static frame",
							"팔로우 카메라는 인물 모션을 따라 움직입니다 — 모션이 없으면 카메라는 정지 구도를 유지합니다",
						));
					}
					if (patch.mode === "rail" && !cameraRail) {
						setRailDraw(true);
						setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
						setToast(ko("Draw this Camera Block's rail in the Top-View", "탑뷰에서 이 카메라 블록의 레일을 그리세요"));
					}
				}}
				onCameraPreview={previewCameraShot}
				onCameraRailDrawToggle={toggleCameraRailDraw}
				onCameraRailDelete={deleteCameraRail}
			onShotSelect={selectTimelineShot}
			onShotBoundaryMove={shotsDomain.resizeTimelineShot}
			onShotRename={shotsDomain.renameTimelineShot}
			onShotRemove={(shotId) => runStudioAction("shot.remove", { shotId })}
			onShotDuplicate={(shotId) => runStudioAction("shot.duplicate", { shotId })}
			onShotCut={() => runStudioAction("shot.create")}
			onShotSplit={(shotId) => runStudioAction("shot.split", { shotId })}
			onShotMove={(shotId, targetFrame) => runStudioAction("shot.reorder", { shotId, startFrame: Math.max(0, Math.round(targetFrame)) })}
			onClearMotion={motion ? clearMotion : null}
		/>
			</div>
			{/* Embeds keep their own shot monitor in the viewport (.vp-shot-preview);
			    the card is styled for the full studio only. */}
			{(tab === "animation" || tab === "board") && !embedded && <ShotCard />}
		</div>
	);
}

// #570: the ratios offered on the card; the rest stay in Camera mode's menu.
const CARD_RATIOS = [
	{ key: "16:9", label: "16:9" },
	{ key: "2.39:1", label: "2.39" },
	{ key: "4:3", label: "4:3" },
	{ key: "1:1", label: "1:1" },
	{ key: "9:16", label: "9:16" },
];

/** The shot camera's card at the dock's right end. The camera itself is drawn
 * into the stage canvas under `.vp-shot-preview`, which sits over the card's
 * frame slot (see glass.css); the card holds its title, lens, ratio and look-through. */
function ShotCard() {
	const { activeShot, shot, fovDeg, shotsDomain, shotAspectKey, runStudioAction, enterShotLook, exitShotLook, lookThroughShot, tlFps, embedMode } = useStudioShell();
	if (embedMode) return null;
	const frames = activeShot && Number.isFinite(activeShot.startFrame) && Number.isFinite(activeShot.endFrame)
		? `${activeShot.startFrame}–${activeShot.endFrame} · ${((activeShot.endFrame - activeShot.startFrame + 1) / (tlFps || 24)).toFixed(1)}s`
		: null;
	return (
		<section className="dock-shot-card" aria-label={ko("Shot Camera", "샷 카메라")}>
			<header className="dock-shot-head">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.75A1.5 1.5 0 0 1 3.5 4.25h6A1.5 1.5 0 0 1 11 5.75v4.5a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 10.25z M11 7l3-1.5v5L11 9" /></svg>
				<span className="dock-shot-title">{ko("Shot Camera", "샷 카메라")}</span>
				<LensScrub fovDeg={fovDeg} sensorHeightMm={shot?.usedSensorHeightMm} shotsDomain={shotsDomain} disabled={!shot} />
			</header>
			{/* While the main view looks through this camera the card has nothing
			    of its own to show (the preview pass is off): it says where the
			    picture went instead of leaving a hole onto the stage. */}
			<div className="dock-shot-frame" aria-hidden={!lookThroughShot || undefined}>
				{lookThroughShot && (
					<span className="dock-shot-live">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z M8 6.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 1 1 0-3.5z" /></svg>
						{ko("Viewing in the main view", "메인 뷰에서 보는 중")}
					</span>
				)}
			</div>
			<div className="dock-shot-ratios" role="radiogroup" aria-label={ko("Shot aspect ratio", "샷 화면 비율")}>
				{CARD_RATIOS.map((entry) => (
					<button
						type="button"
						role="radio"
						key={entry.key}
						data-aspect={entry.key}
						aria-checked={shotAspectKey === entry.key}
						onClick={() => runStudioAction("stage.setFilmback", { shotAspect: entry.key })}
					>
						{entry.label}
					</button>
				))}
			</div>
			<footer className="dock-shot-foot">
				<span className="dock-shot-name">
					{activeShot?.name ?? ko("No shot yet", "샷 없음")}
					{frames && <span className="dock-shot-range"> · {frames}</span>}
				</span>
				{lookThroughShot ? (
					<button type="button" className="dock-shot-look" data-active="true" aria-pressed="true" onClick={exitShotLook} title={ko("Back to the editor view (Esc)", "편집 시점으로 돌아가기 (Esc)")}>
						{ko("Exit", "나가기")}
						<kbd>Esc</kbd>
					</button>
				) : activeShot ? (
					<button type="button" className="dock-shot-look" aria-pressed="false" onClick={enterShotLook} title={ko("Look through the shot camera (Esc returns)", "샷 카메라 시점으로 보기 (Esc로 복귀)")}>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z M8 6.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 1 1 0-3.5z" /></svg>
						{ko("Look through", "샷 시점")}
					</button>
				) : null}
			</footer>
		</section>
	);
}
