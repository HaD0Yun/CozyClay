import { useEffect, useState } from "react";
import { useStudioPlaybackFrame, useStudioShell } from "./studio-shell-context.js";
import ShotPreviewHeader from "./ShotPreviewHeader.jsx";
import RailIcon from "./RailIcon.jsx";
import { ko } from "../locale.js";
import { PRESETS, SHOT_ASPECT_PRESETS } from "../app-stage.jsx";
import { CAMERA_PRESETS } from "../camera-move.js";
import { PRIME_SET } from "../shot.js";
import { CatalogueEntries } from "../object-catalog.jsx";
import { saveAutoColor } from "../auto-color.js";
import { trackFeature } from "../analytics.js";
import { poseTools } from "./pose-tools.js";
import { GUIDE_LABELS, nextGuideMode } from "../shot-guides.js";
import GhostsMenuGroup from "./GhostsMenuGroup.jsx"; import AddSceneEntries from "./AddSceneEntries.jsx";
import { toggleViewportTool, useViewportTools } from "../viewport-tools.js"; import AnnotateCell from "./AnnotateCell.jsx";
import "./viewport.css";

// G1: the single mode+tool pill. Keys 1-5 and W/E/R are bound in App's
// keydown handler; these buttons are the same doors for the pointer.
const MODES = [
	{ id: "scene", key: "1", label: ko("Stage", "배치") },
	{ id: "pose", key: "2", label: ko("Pose", "포즈") },
	{ id: "camera", key: "3", label: ko("Camera", "카메라") },
	{ id: "motion", key: "4", label: ko("Motion", "모션") },
	// #739: an isolated turntable for one sculpt.
	{ id: "sculpt", key: "5", label: ko("Sculpt", "조형") },
];

// The gizmo's snap increments (TRANSLATE_SNAP / ROTATE_SNAP in
// src/scene-objects.js). They are fixed, so the value group names them.
const SNAP_MOVE = "5cm", SNAP_TURN = "5°";

// Editor lens range: shotsDomain.changeLens and the FOV slider take 14-90°.
const FOV_MIN = 14, FOV_MAX = 90;

// "+ Add › Character" stands the new body one metre along X per existing
// character, inside the same stage clamp the Content drag applies.

const trimNumber = (value, digits = 2) => String(Number(value.toFixed(digits)));

/** One open overlay menu at a time; outside pointerdown or Escape closes it. */
function useOverlayMenu() {
	const [open, setOpen] = useState(null);
	useEffect(() => {
		if (!open) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(`[data-vp-menu="${open}"]`)) return;
			setOpen(null);
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			document.querySelector(`[data-vp-menu="${open}"] > button`)?.focus();
			setOpen(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	return {
		open,
		close: () => setOpen(null),
		toggle: (id) => setOpen((current) => (current === id ? null : id)),
	};
}

function MenuItem({ checked, role = "menuitemradio", className = "", children, ...props }) {
	return (
		<button type="button" role={role} aria-checked={checked} className={"vp-menu-item " + className} {...props}>
			<span className="vp-menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
			{children}
		</button>
	);
}

export default function ViewportToolbar() {
	const {
		workflowMode, selectWorkflowMode, poseRefusal, gizmoMode, setGizmoMode, snapEnabled,
		setSnapEnabled, preset, applyPreset, cameraPresetId,
		runStudioAction, shotAspectKey, fovDeg, shotsDomain, shot: sceneShot, shots, activeShot,
		setNonce, workspaceLayout, viewMenuTriggerRef, viewMenuOpen,
		setViewMenuOpen, viewLooksActive, gridView, setGridView, guideMode, toonLook, setToonLook,
		autoColor, setAutoColor, isCharacterSelection, partColoursChoice, embedMode,
		agentCollapsed, addSceneObject, flySpeed, frameAll, setAxisView,
		ikEditTool, setIkEditTool, motion, setRangePinPartPick,
		sculptView, requestSculptView, sculptParts,
		cameraReadoutAt,
	} = useStudioShell();
	const menu = useOverlayMenu(), viewportTools = useViewportTools(), shot = cameraReadoutAt(useStudioPlaybackFrame()).shot ?? sceneShot;

	const setAutoColorOn = (next) => {
		if (next === autoColor) return;
		saveAutoColor(next);
		trackFeature("auto_color");
		setAutoColor(next);
	};

	const tools = {
		scene: [
			{ key: "W", id: "move", name: ko("Move", "이동"), active: gizmoMode === "move", pick: () => setGizmoMode("move") },
			{ key: "E", id: "rotate", name: ko("Rotate", "회전"), active: gizmoMode === "rotate", pick: () => setGizmoMode("rotate") },
			{ key: "R", id: "scale", name: ko("Scale", "크기"), active: gizmoMode === "scale", pick: () => setGizmoMode("scale") },
		],
		pose: poseTools({ ikEditTool, setIkEditTool, motion, setRangePinPartPick }),
		camera: [
			{ key: "W", id: "move", name: ko("Move camera", "카메라 이동"), active: gizmoMode === "move", pick: () => setGizmoMode("move") },
			{ key: "E", id: "rotate", name: ko("Rotate camera", "카메라 회전"), active: gizmoMode === "rotate", pick: () => setGizmoMode("rotate") },
		],
		// Motion is compiled by the agent (motion.compile); the department has no tools of its own.
		motion: [],
		// Sculpt mode's W/E/R swing the turntable camera to a reference view; with a part selected they drive its gizmo.
		sculpt: sculptParts?.selected ? sculptParts.tools : [
			{ key: "W", id: "front", name: ko("Front view (with a part selected, W moves it)", "정면 보기 (부품을 선택하면 W는 이동)"), active: sculptView?.view === "front", pick: () => requestSculptView("front") },
			{ key: "E", id: "side", name: ko("Side view (with a part selected, E rotates it)", "측면 보기 (부품을 선택하면 E는 회전)"), active: sculptView?.view === "side", pick: () => requestSculptView("side") },
			{ key: "R", id: "back", name: ko("Back view (with a part selected, R scales it)", "뒷면 보기 (부품을 선택하면 R은 크기)"), active: sculptView?.view === "back", pick: () => requestSculptView("back") },
		],
	}[workflowMode] ?? [];

	// Lens choices are the real primes that fit the editor's FOV range, turned
	// into a vertical FOV on the current filmback (the shot.js lens relation).
	const lensChoices = PRIME_SET
		.map((mm) => ({ mm, fov: (2 * Math.atan(shot.usedSensorHeightMm / (2 * mm)) * 180) / Math.PI }))
		.filter(({ fov }) => fov >= FOV_MIN && fov <= FOV_MAX);
	const aspectLabel = SHOT_ASPECT_PRESETS[shotAspectKey]?.label ?? shotAspectKey;

	const valueGroup = workflowMode === "scene" ? (
		<button
			type="button"
			className={"vp-value vp-snap-value" + (snapEnabled ? " on" : "")}
			data-testid="snap-toggle"
			aria-pressed={snapEnabled}
			title={ko(
				`Grid snapping ${snapEnabled ? "on" : "off"} (${SNAP_MOVE} · ${SNAP_TURN}) — click to toggle, hold Ctrl during a drag to invert`,
				`그리드 스냅 ${snapEnabled ? "켜짐" : "꺼짐"} (${SNAP_MOVE} · ${SNAP_TURN}) — 클릭해 전환, 드래그 중 Ctrl을 누르면 반대로 작동`, `网格吸附 ${snapEnabled ? "开" : "关"}（${SNAP_MOVE} · ${SNAP_TURN}）— 点击切换，拖动时按住 Ctrl 反向`,
			)}
			onClick={() => setSnapEnabled((value) => !value)}
		>
			<span className="vp-value-part"><RailIcon name="grid" size={14} />{SNAP_MOVE}</span>
			<span className="vp-value-part"><RailIcon name="angle" size={14} />{SNAP_TURN}</span>
		</button>
	) : workflowMode === "camera" ? (
		<>
			<div className="vp-menu-wrap" data-vp-menu="lens">
				<button
					type="button"
					className="vp-value"
					data-testid="lens-value"
					aria-haspopup="menu"
					aria-expanded={menu.open === "lens"}
					title={ko("Lens — pick a prime or set the field of view", "렌즈 — 단렌즈를 고르거나 화각을 조절")}
					onClick={() => menu.toggle("lens")}
				>
					{shot.focalMm}mm
				</button>
				{menu.open === "lens" && (
					<div className="vp-menu" role="menu" aria-label={ko("Lens", "렌즈")}>
						{lensChoices.map(({ mm, fov }) => (
							<MenuItem
								key={mm}
								data-lens={mm}
								checked={shot.focalMm === mm}
								onClick={() => { shotsDomain.changeLens(fov); menu.close(); }}
							>
								{mm}mm
							</MenuItem>
						))}
						<label className="viewport-fov-control">
							<span>FOV</span>
							<input
								type="range"
								min={FOV_MIN}
								max={FOV_MAX}
								step="1"
								value={fovDeg}
								onChange={(event) => shotsDomain.changeLens(Number(event.target.value))}
							/>
							<output>{Math.round(fovDeg)}°</output>
						</label>
					</div>
				)}
			</div>
			<div className="vp-menu-wrap" data-vp-menu="ratio">
				<button
					type="button"
					className="vp-value"
					data-testid="ratio-value"
					aria-haspopup="menu"
					aria-expanded={menu.open === "ratio"}
					title={ko("Output aspect ratio", "출력 화면 비율")}
					onClick={() => menu.toggle("ratio")}
				>
					{aspectLabel.replace(/:1$/, "")}
				</button>
				{menu.open === "ratio" && (
					<div className="vp-menu" role="menu" aria-label={ko("Output aspect ratio", "출력 화면 비율")}>
						{Object.entries(SHOT_ASPECT_PRESETS).map(([key, value]) => (
							<MenuItem
								key={key}
								data-aspect={key}
								checked={key === shotAspectKey}
								title={value.title}
								onClick={() => { runStudioAction("stage.setFilmback", { shotAspect: key }); menu.close(); }}
							>
								{value.label}
							</MenuItem>
						))}
					</div>
				)}
			</div>
		</>
	) : null;

	return (
		<div className="viewport-titlebar" data-testid="viewport-overlays">
			<div className="vp-mode-toolbar" role="toolbar" data-testid="mode-toolbar" aria-label={ko("Mode and tools", "모드와 도구")}>
				<div className="vp-mode-keys" role="tablist" aria-label={ko("Mode", "모드", "模式")}>
					{MODES.map((mode) => {
						const active = workflowMode === mode.id;
						const refused = mode.id === "pose" ? poseRefusal : null;
						return (
							<button
								type="button"
								role="tab"
								key={mode.id}
								data-mode-key={mode.key}
								data-mode={mode.id} data-fid={`mode_${mode.id}`}
								className={"vp-mode-key" + (active ? " active" : "")}
								aria-selected={active}
								aria-disabled={refused ? true : undefined}
								data-disabled-reason={refused || undefined}
								aria-label={mode.label}
								title={refused || `${mode.label} (${mode.key})`}
								onClick={(event) => selectWorkflowMode(mode.id, { hinted: event.detail > 0 })}
							>
								<RailIcon name={mode.id} />
								<span className="vp-key-digit">{mode.key}</span>
								<span className="vp-mode-name">{mode.label}</span>
							</button>
						);
					})}
				</div>
			</div>

			<div className="vp-overlay-rail"><div className="vp-overlay-left">
				<div className="vp-menu-wrap" data-vp-menu="add">
					<button
						type="button"
						className="vp-pill vp-add-trigger add-object-trigger"
						data-testid="viewport-add"
						aria-haspopup="menu"
						aria-expanded={menu.open === "add"}
						title={ko("Add an object, a character or a camera", "오브젝트, 인물, 카메라 추가")}
						onClick={() => menu.toggle("add")}
					>
						<span className="vp-add-plus" aria-hidden="true"><RailIcon name="plus" /></span>
						<span className="vp-label">{ko("Add", "추가")}</span>
					</button>
					{menu.open === "add" && (
						<div className="vp-menu add-object-menu" role="menu" aria-label={ko("Add", "추가")}>
							<CatalogueEntries onPick={(kind) => { addSceneObject(kind); menu.close(); }} />
							<AddSceneEntries onDone={menu.close} />
						</div>
					)}
				</div>

				{tools.length > 0 && <span className="vp-toolbar-divider" aria-hidden="true" />}
				<div className="vp-tool-keys" role="group" aria-label={ko("Tools", "도구")} data-transform-controls>
					{tools.map((tool) => (
						<button
							type="button"
							key={tool.key}
							data-tool-key={tool.key}
							data-tool={tool.id} data-fid={`tool_${tool.id}`}
							className={"vp-tool-key" + (tool.active ? " active" : "")}
							aria-pressed={tool.active}
							aria-disabled={tool.refused ? true : undefined}
							aria-label={tool.name}
							title={tool.refused || `${tool.name} (${tool.key})`}
							onClick={() => { if (!tool.refused) tool.pick(); }}
						>
							<RailIcon name={tool.id} />
							<span className="vp-tool-letter">{tool.key}</span>
						</button>
					))}
				</div>
				<AnnotateCell />{valueGroup && (
					<>
						<span className="vp-toolbar-divider" aria-hidden="true" />
						<div className="vp-values">{valueGroup}</div>
					</>
				)}
			</div>

			<div className="vp-overlay-right">
				<div className="vp-pill vp-view-pill">
					<div className="vp-menu-wrap" data-vp-menu="camera-view">
						<button
							type="button"
							className="vp-pill-segment"
							data-testid="view-camera-trigger"
							aria-haspopup="menu"
							aria-expanded={menu.open === "camera-view"}
							title={ko("Views and shot cameras", "보기와 샷 카메라")}
							onClick={() => menu.toggle("camera-view")}
						>
							<RailIcon name="view" />
							<span className="vp-label">{ko("Perspective", "원근")}</span>
						</button>
						{menu.open === "camera-view" && (
							<div className="vp-menu" role="menu" aria-label={ko("Views and shot cameras", "보기와 샷 카메라")}>
								<span className="vp-menu-label">{ko("View", "보기")}</span>
								<MenuItem checked onClick={menu.close}>{ko("Perspective", "원근")}</MenuItem>
								<MenuItem role="menuitem" data-testid="view-frame-all" onClick={() => { frameAll(); menu.close(); }}>{ko("Frame all (Home)", "전체 프레임 (Home)")}</MenuItem>
								<MenuItem role="menuitem" data-testid="view-front" onClick={() => { setAxisView("front"); menu.close(); }}>{ko("Front", "정면")}</MenuItem>
								<MenuItem role="menuitem" data-testid="view-side" onClick={() => { setAxisView("side"); menu.close(); }}>{ko("Side", "측면")}</MenuItem>
								<MenuItem role="menuitem" data-testid="view-top-axis" onClick={() => { setAxisView("top"); menu.close(); }}>{ko("Top view", "상면")}</MenuItem>
								<MenuItem
									role="menuitemcheckbox"
									checked={!workspaceLayout.insetCollapsed}
									title={ko("Show the Top-View inset", "탑뷰 인셋 표시")}
									onClick={() => runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed })}
								>
									{ko("Top", "탑")}
								</MenuItem>
								{shots.length > 0 && <span className="vp-menu-label">{ko("Shot cameras", "샷 카메라")}</span>}
								{shots.map((entry) => (
									<MenuItem
										key={entry.id}
										checked={activeShot?.id === entry.id}
										title={ko("Show this shot's camera in the preview", "이 샷의 카메라를 미리보기에 표시")}
										onClick={() => { runStudioAction("view.select", { shotId: entry.id }); menu.close(); }}
									>
										{entry.name}
									</MenuItem>
								))}
								<span className="vp-menu-label">{ko("Shot framing", "샷 구도")}</span>
								<label className="viewport-toolbar-field shot-field">
									<span>{ko("Shot", "샷")}</span>
									<select
										aria-label={ko("Shot preset", "샷 프리셋")}
										value={preset}
										onChange={(event) => applyPreset(event.target.value)}
									>
										{Object.entries(PRESETS).map(([key, value]) => (
											<option key={key} value={key}>{value.label}</option>
										))}
									</select>
								</label>
								<label className="viewport-toolbar-field ratio-field">
									<span>{ko("Cam", "카메라")}</span>
									<select
										aria-label={ko("Camera preset", "카메라 프리셋")}
										value={cameraPresetId ?? ""}
										onChange={(event) => {
											const id = event.target.value;
											if (!id) { runStudioAction("stage.setFilmback", { cameraPresetId: null }); return; }
											runStudioAction("shot.frame", { preset: id });
										}}
									>
										<option value="">{ko("Free", "자유")}</option>
										{Object.values(CAMERA_PRESETS).map((value) => (
											<option key={value.id} value={value.id}>{value.label}</option>
										))}
									</select>
								</label>
								<button
									type="button"
									role="menuitem"
									className="vp-menu-item"
									title={ko("Recenter on subject", "피사체 다시 맞추기")}
									aria-label={ko("Recenter on subject", "피사체 다시 맞추기")}
									onClick={() => { setNonce((n) => n + 1); menu.close(); }}
								>
									<span className="vp-menu-mark" aria-hidden="true">◎</span>
									{ko("Recenter on subject", "피사체 다시 맞추기")}
								</button>
							</div>
						)}
					</div>
					<span className="vp-pill-divider" aria-hidden="true" />
					<div className="vp-menu-wrap" data-vp-menu="shading">
						<button
							type="button"
							className="vp-pill-segment"
							data-testid="shading-trigger"
							aria-haspopup="menu"
							aria-expanded={menu.open === "shading"}
							title={ko("Shading", "셰이딩")}
							onClick={() => menu.toggle("shading")}
						>
							<RailIcon name="shading" />
							<span className="vp-label">{ko("Clay Lit", "클레이 조명")}</span>
						</button>
						{menu.open === "shading" && (
							<div className="vp-menu" role="menu" aria-label={ko("Shading", "셰이딩")}>
								<MenuItem checked={!autoColor} onClick={() => { setAutoColorOn(false); menu.close(); }}>
									{ko("Clay Lit", "클레이 조명")}
								</MenuItem>
							</div>
						)}
					</div>
					<span className="vp-pill-divider" aria-hidden="true" />
					{/* G8 "Show" = the View menu: every what-is-on-screen toggle, in
					    every mode. Items keep the menu open: these are toggles you
					    compare, not commands you fire. */}
					<div className="view-menu-wrap">
						<button
							type="button"
							className="vp-pill-segment view-menu-trigger"
							data-testid="view-menu-trigger"
							ref={viewMenuTriggerRef}
							aria-haspopup="menu"
							aria-expanded={viewMenuOpen}
							title={ko("Viewport display toggles", "뷰포트 표시 토글")}
							onClick={() => setViewMenuOpen((open) => !open)}
						>
							<RailIcon name="show" />
							<span className="vp-label">{ko("Show", "표시")}</span>
							{viewLooksActive && <span className="view-menu-dot" data-testid="view-menu-dot" aria-hidden="true" />}
						</button>
						{viewMenuOpen && (
							<div
								className="vp-menu view-menu"
								role="menu"
								aria-label={ko("Viewport display", "뷰포트 표시")}
							>
								{/* aria-pressed rides along with aria-checked: the toggles
								    published that state contract in their old homes and QA
								    still reads it, so the move keeps the signpost (R9). */}
								<button
									type="button"
									role="menuitemcheckbox"
									className={"view-menu-item grid-view-switch" + (gridView ? " active" : "")}
									aria-checked={gridView}
									aria-pressed={gridView}
									title={ko("Blender-style viewport — themed background with a reference grid instead of the deck", "Blender식 뷰포트 — 데크 대신 테마 배경과 기준 그리드")}
									onClick={() => setGridView((v) => !v)}
								>
									<span className="view-menu-mark" aria-hidden="true">{gridView ? "✓" : ""}</span>
									{ko("Reference grid", "기준 그리드")}
								</button>
								<button type="button" role="menuitemcheckbox" className={"view-menu-item toon-look-switch" + (toonLook ? " active" : "")} aria-checked={toonLook} aria-pressed={toonLook}
									title={ko("Flat two-tone shading with black lines, in the viewport and in every capture and export", "검은 선과 2단 명암의 평평한 그림 — 뷰포트와 모든 캡처·내보내기에 적용")} onClick={() => setToonLook((v) => !v)}>
									<span className="view-menu-mark" aria-hidden="true">{toonLook ? "✓" : ""}</span>
									{ko("Toon look", "툰 룩")}
								</button>
								<button
									type="button"
									role="menuitemcheckbox"
									className={"view-menu-item auto-color-toggle" + (autoColor ? " active" : "")}
									aria-checked={autoColor}
									aria-pressed={autoColor}
									title={ko(
										"Distinct display colors per object — captures include them while on",
										"오브젝트별 구분 색 — 켜둔 동안 캡처에도 포함됩니다",
									)}
									onClick={() => setAutoColorOn(!autoColor)}
								>
									<span className="view-menu-mark" aria-hidden="true">{autoColor ? "✓" : ""}</span>
									{ko("Auto Color", "자동 색")}
								</button>
								<button
									type="button"
									role="menuitemcheckbox"
									className={"view-menu-item vp-guide-cycle" + (guideMode === "off" ? "" : " active")}
									aria-checked={guideMode !== "off"}
									aria-pressed={guideMode !== "off"}
									title={ko(GUIDE_LABELS[guideMode].en, GUIDE_LABELS[guideMode].ko, GUIDE_LABELS[guideMode].zh) + ko(" · click to cycle", " · 클릭으로 전환")}
									onClick={() => runStudioAction("view.setGuideMode", { mode: nextGuideMode(guideMode) })}
								>
									<span className="view-menu-mark" aria-hidden="true">{guideMode !== "off" ? "✓" : ""}</span>
									{ko("Composition guides", "구도 가이드")}
									<small>{ko(GUIDE_LABELS[guideMode].en, GUIDE_LABELS[guideMode].ko, GUIDE_LABELS[guideMode].zh)}</small>
								</button>
								<GhostsMenuGroup />
								<MenuItem role="menuitemcheckbox" data-testid="view-xray" checked={viewportTools.xray} onClick={() => toggleViewportTool("xray")}>{ko("X-Ray", "X-Ray")}</MenuItem>
								<MenuItem role="menuitemcheckbox" data-testid="surface-snap" checked={viewportTools.surfaceSnap} onClick={() => toggleViewportTool("surfaceSnap")}>{ko("Surface snap", "표면 스냅")}</MenuItem>
								<MenuItem role="menuitemcheckbox" data-testid="measure-tool" checked={viewportTools.measure} onClick={() => toggleViewportTool("measure")}>{ko("Ruler — pick two surface points", "룰러 — 표면 두 점 선택")}</MenuItem>
								{/* Part colours repaint a BODY, so the section only exists
								    while a character is selected (R2). */}
								{isCharacterSelection && (
									<div className="view-menu-group" role="group" aria-label={ko("Body part colours", "부위 색상")}>
										<span className="view-menu-label" aria-hidden="true">{ko("Body part colours", "부위 색상")}</span>
										{[
											{ value: "off", label: ko("Off", "끔") },
											{ value: "shaded", label: ko("Shaded", "음영") },
											{ value: "flat", label: ko("Flat", "평면") },
										].map((option) => {
											const checked = option.value === partColoursChoice;
											return (
												<button
													type="button"
													key={option.value}
													role="menuitemradio"
													className={"view-menu-item part-colour-option" + (checked ? " active" : "")}
													data-part-colours={option.value}
													aria-checked={checked}
													onClick={() => runStudioAction("view.setPartColours", { mode: option.value })}
												>
													<span className="view-menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
													{option.label}
												</button>
											);
										})}
									</div>
								)}
								{/* Panel visibility belongs to the same menu (R4): the
								    agent column is something you show, not a mode, so it
								    gets a checkmark here instead of a topbar button. */}
								{!embedMode && (
									<div className="view-menu-group" role="group" aria-label={ko("Panels", "패널")}>
										<span className="view-menu-label" aria-hidden="true">{ko("Panels", "패널")}</span>
										<button
											type="button"
											role="menuitemcheckbox"
											className={"view-menu-item agent-panel-toggle" + (agentCollapsed ? "" : " active")}
											aria-checked={!agentCollapsed}
											aria-pressed={!agentCollapsed}
											title={ko("Show the agent chat column (Cmd/Ctrl+B)", "에이전트 채팅 열 표시 (Cmd/Ctrl+B)")}
											onClick={() => window.dispatchEvent(new CustomEvent("cozyclay:agent-panel-toggle"))}
										>
											<span className="view-menu-mark" aria-hidden="true">{agentCollapsed ? "" : "✓"}</span>
											{ko("Agent panel", "에이전트 패널")}
										</button>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
				<span className="vp-rail-divider" aria-hidden="true" />
				<span
					className="vp-pill vp-speed"
					data-testid="fly-speed"
					title={ko("Fly speed — scroll while right-dragging to change it", "비행 속도 — 오른쪽 드래그 중 스크롤로 조절")}
				>
					<RailIcon name="speed" size={14} />
					<span className="vp-speed-value">{trimNumber(flySpeed, 1)}×</span>
				</span>
			</div></div>

			<ShotPreviewHeader name={activeShot?.name ?? ko("Shot", "샷")} lens={`${shot.focalMm}mm`} />
		</div>
	);
}
