#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { elementByPath } from "../src/studio-elements.js";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const app = readStudioSource()
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/timeline-defaults.js", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-startup-defaults.js", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-characters.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-canvas-rigs.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/document-mirrors.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const planview = readFileSync(new URL("../src/planview.jsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/motion/timeline.jsx", import.meta.url), "utf8");
const takeSegments = readFileSync(new URL("../src/motion/take-segments.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
const offscreenExport = readFileSync(new URL("../src/offscreen-export.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8");
const workflowBuilder = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");
// The sidecar request helper agent-client.js uses lives in the shared module.
const agentClient = readFileSync(new URL("../src/agent-image-client.js", import.meta.url), "utf8");

expect("workspace layout persists across reloads", app.includes("WORKSPACE_LAYOUT_KEY") && app.includes("localStorage.setItem"));
expect("H3 lock evidence is visible on successful video takes", workflowBuilder.includes('data-testid="h3-preservation-receipt"') && workflowBuilder.includes("H3 scene/camera lock verified"));
expect("H3 drift evidence is visible when a take is rejected", workflowBuilder.includes('data-testid="h3-preservation-failed"') && workflowBuilder.includes("H3 output rejected: background/camera drift"));
expect("failed H3 takes cannot leave a stale video preview visible", workflowBuilder.includes("videoUrl: null, resultUrl: null, outputs: [], preservation: error?.preservation || null"));
expect("failed H3 outputs stay cleared in the returned workflow graph", workflowBuilder.includes('hasPatchedOutputs') && workflowBuilder.includes('Object.prototype.hasOwnProperty.call(patch, "outputs")'));
expect("video requests preserve structured H3 rejection metrics", agentClient.includes("error.preservation = detail.preservation") && agentClient.includes("error.status = response.status"));
expect("sidebar width has a pointer resize path", app.includes('beginWorkspaceResize("sidebar"'));
expect("frame monitor height has a pointer resize path", app.includes('beginWorkspaceResize("timeline"'));
expect("inset view has a diagonal resize path", app.includes("beginInsetResize") && app.includes("vp-inset-resize"));
expect("inset view collapses to its tag pill", app.includes("insetCollapsed") && app.includes("vp-inset-caret") && css.includes(".vp-inset.collapsed"));
expect("collapse toggle lives inside the tag strip", !app.includes("vp-inset-collapse\"") && css.includes(".vp-inset-caret"));
expect("the tag drags the inset in both states", app.includes("onPointerDown={beginInsetDrag}"));
expect("inset collapse state persists with the workspace layout", app.includes("insetCollapsed: false") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("collapsed inset skips its render pass", dualview.includes("insetCollapsed = false") && dualview.includes("const insetOff = insetCollapsed ||") && dualview.includes("if (!insetOff) draw("));
expect("resize handle hides while collapsed", app.includes("{!workspaceLayout.insetCollapsed && ("));
expect("resize grip is visible on the clay viewport", css.includes(".vp-inset-resize:before,") && css.includes("rgba(255, 252, 247, .85)"));
expect("Top-View plan zooms with the wheel over the inset", app.includes('pane.addEventListener("wheel", onWheel, { passive: false })') && app.includes("current.planZoom * Math.pow"));
expect("plan zoom persists with the workspace layout", app.includes("planZoom: 1,") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("zoom shrinks the ortho extent, not the pane", dualview.includes("planZoom = 1") && dualview.includes("PLAN_EXTENT / Math.max(0.25, planZoom)"));
expect("demand loop wakes on mount and model commit", dualview.includes("requestAnimationFrame(() => requestAnimationFrame(invalidate))") && app.includes("const frame = requestAnimationFrame(invalidate);"));
expect("double-click no longer swaps Scene and Top-View", !app.includes('setViewMode((current) => (current === "plan" ? "shot" : "plan"))'));
expect("Scene toolbar exposes shot preset, aspect, FOV, recenter, and Top-View controls", app.includes("viewport-toolbar-field shot-field") && app.includes("SHOT_ASPECT_PRESETS") && app.includes("viewport-fov-control") && app.includes("Recenter on subject") && app.includes('ko("Top", "탑")'));
// #193 (R1): the viewport camera bar is the ONLY home for lens and recentring.
// The camera inspector used to carry a second copy of both.
expect(
	"lens and recentring live once, in the viewport camera bar",
	app.includes('aria-label={ko("Recenter on subject", "피사체 다시 맞추기")}') &&
	!app.includes('ko("Lens (FOV)", "렌즈 (FOV)")') &&
	!app.includes('<button className="btn ghost" onClick={() => setNonce((n) => n + 1)}>'),
);
// #195: the title bar is one horizontal strip — mode tabs plus the scene
// tools, rendered unconditionally. The Scene/PlayView centre tabs are gone.
expect(
	"the viewport title bar is one horizontal strip without centre tabs",
	app.includes('className="viewport-titlebar"') &&
	css.includes(".viewport-titlebar") &&
	css.includes("position: static") &&
	app.includes('className="vp-mode-toolbar"') &&
	!app.includes('className="pane-tabs"') &&
	!css.includes(".pane-tabs"),
);
// #193 emptied the PlayView bar down to two readouts; #195 removed the bar
// itself along with the tab that reached it — the framed player is an internal
// preview state now, and it carries no toolbar at all.
expect(
	"the PlayView toolbar is gone, markup and styles alike",
	!app.includes("editor-toolbar play-tools") &&
	!css.includes(".editor-toolbar.play-tools") &&
	!app.includes("toggleShotRecording") &&
	!app.includes("viewport-readout") &&
	!css.includes(".viewport-readout"),
);
expect(
	"one File › Export menu leads with the keyframe pack",
	app.includes('data-testid="topbar-export"') &&
	app.includes('id="export-menu-trigger"') &&
	app.includes('className="menubar-item export-menu-primary"') &&
	app.includes('data-testid="export-video"') &&
	app.includes('data-testid="export-otio"'),
);
// Letterbox bars are editor chrome. Painting them with the scene background
// put a sheet of near-white either side of the frame the moment a narrower
// aspect was picked; they wear the editor's own tone now, and the scene draw
// is scissored to the image so the sky inside the frame is unchanged.
expect(
	"letterbox bars are painted in the editor's tone, not the sky",
	dualview.includes('export const LETTERBOX = new THREE.Color("#1e1e1e");') &&
	dualview.includes('export const LETTERBOX_LIGHT = new THREE.Color("#dcdde1");') &&
	dualview.includes('uiTheme === "light" ? LETTERBOX_LIGHT : LETTERBOX') &&
	dualview.includes("gl.setClearColor(letterbox, 1);") &&
	// v2 tokens: the editor background is --bg (mapped to --surface-0); the
	// letterbox keeps the viewport tone the renderer clears with.
	css.includes("--bg: var(--surface-0)"),
);
expect(
	"the scene draw is scissored to the image so the bars survive it",
	dualview.includes("gl.setScissor(img.x, imgY, img.w, img.h);\n\t\t\tgl.setViewport(img.x, imgY, img.w, img.h);"),
);
expect("selected aspect reaches the shot renderer", app.includes("shotAspect={shotOutput.aspect}") && dualview.includes("shotAspect = SHOT_ASPECT") && dualview.includes("fitAspect(mainRect, shotAspect)"));
expect("video and still capture use the selected output dimensions", app.includes("width: shotOutput.width") && app.includes("width={shotOutput.width}") && app.includes("canvas.width = shotOutput.width"));
expect("double-clicking the inset body folds it", app.includes('event.target.closest?.(".vp-inset-tag")') && app.includes("insetCollapsed: !current.insetCollapsed"));
expect("the tag strip works like a foldout header", app.includes("if (!moved && ev.detail <= 1) {") && app.includes("insetToggledAtRef"));
expect("one fold per gesture, even on a double-click", app.includes("if (e.detail > 1) return;") && app.includes("ev.detail <= 1"));
expect("body double-click skips tag-started gestures", app.includes("Date.now() - insetToggledAtRef.current < 450"));
expect("workspace has a dedicated left hierarchy window", app.includes('className="panel hierarchy-left"') && !app.includes("<LibrarySlot />"));
expect("the dock switches between Animation and Assets", app.includes('data-testid={`dock-tab-${entry.key}`}') && app.includes('<LibrarySlot active={tab === "assets"} />'));
expect("inspector is always visible beside the scene", app.includes("inspector-sidebar") && !app.includes("rightPanelTab"));
expect("legacy hierarchy/inspector splitter is removed", !app.includes("hierarchy-splitter"));
expect("bottom dock drops the Animation/Assets tab strip for the Content pane", !app.includes("bottom-window-tabs") && app.includes('setBottomTab(visible ? "assets" : "timeline")') && !app.includes("console-pane") && !app.includes('bottomTab === "console"'));
// The sidebar has no tabs: one Inspector, driven by the hierarchy selection,
// so every panel is reached by selecting the thing that owns it.
expect("the sidebar has no mode tabs left", !app.includes("sidebarTab") && !app.includes("inspector-tabs") && !css.includes(".inspector-tabs"));
expect("the legacy ARDY motion inspector card is removed", !app.includes('title={ko("ARDY motion", "ARDY 모션")}'));
expect("the camera owns the lens controls", app.includes('<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>'));
expect(
	"the legacy image/video generation prompt inspector is removed",
	!app.includes('<Foldout hidden={!(isSceneSelection || isCharacterSelection)} title={ko("Prompt", "프롬프트")}>'),
);
expect(
	"the prompt does not leak onto selections that do not own it",
	!app.includes('hidden={!isCameraSelection} title={ko("Prompt"') && app.includes('<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>'),
);
expect("selection routing is derived once, not repeated per foldout", app.includes("const isCharacterSelection = selectedHierarchyId ===") && app.includes("const inspectorHasContent ="));
expect("an unowned selection explains itself instead of showing a blank column", app.includes("data-inspector-empty") && css.includes(".inspector-empty"));
expect("the heavy motion pipeline starts collapsed", app.includes("function Foldout({ title, hidden, defaultOpen = true, openSignal = 0, children })") && app.includes("useState(defaultOpen)"));
expect(
	"recording captures the clean render without a frame stamp",
	app.includes("capture: (frame, kind) => withExportFrame(frame, kind") &&
		app.includes("const plate = applyExportFrame(frame);") &&
		!app.includes("burnInCapture") &&
		// #276 retains #193's preflight shot list in the immutable request.
		// The executable export-recovery tests verify selection and retry.
		app.includes("structuredClone({ shots: exportShots, playbackScene") &&
		app.includes("sampleAt(context?.playbackScene ?? playbackScene, shotAtFrame(context?.shots ?? shots, frame), frame)"),
);
expect(
	"recording uses current motion content instead of a stale timeline tail",
	app.includes("currentRecordFrameCount") &&
		app.includes("timelineContentExtent(") &&
		app.includes("endFrame: resolvedEndFrame"),
);
expect("recording uses WebCodecs with explicit timestamps and frame count", offscreenExport.includes("new VideoEncoderClass") && offscreenExport.includes("timestamp: Math.round(index * frameDurationUs)") && offscreenExport.includes("chunks.length !== range.frameCount"));
expect("recording no longer uses MediaRecorder or a wall-clock capture loop", !app.includes("MediaRecorder") && !offscreenExport.includes("performance.now()") && !app.includes("captureStream"));
expect("pre-motion timeline initializes to 15 seconds", app.includes("const DEFAULT_DURATION_S = 15"));
expect("motion preview stays at native 1x speed", app.includes("const DEFAULT_PLAYBACK_SPEED = 1") && app.includes("playbackSpeed={DEFAULT_PLAYBACK_SPEED}"));
expect("timeline cadence and v2 readout expose native preview speed", timeline.includes("fps * playbackSpeed") && timeline.includes('data-testid="sequencer-frame-readout"') && timeline.includes('padStart(4, "0")'));
expect("legacy greeting demo migration is removed", !app.includes("GREETING_DEMO_MIGRATION_KEY") && !app.includes('id: "demo-rise"'));
// v2 removed the Details "Generate all blocks" button, so the top bar is the only generate home and runs the blocks when any has text.
// The pin decision moved into ardy/pose-pin.js so it can be tested directly
// (test/ardy/verify-pose-pin.mjs); the call site only has to route it.
// Prompt Blocks starts collapsed and can sit below the fold, so selecting a
// block on the timeline has to open it AND bring it on screen — otherwise the
// click reads as doing nothing at all.
expect(
	"a collapsed panel can be revealed from outside the Inspector",
	app.includes("openSignal = 0") && app.includes("if (openSignal <= 0) return undefined;") && app.includes('scrollIntoView({ block: "nearest" })'),
);
// A compiled take is installed by motion.compile through the motion owner's
// replace(); no npz loader, prompt schedule or async completion is left.
expect(
	"motion installs only through the motion owner, never a raw setter",
	app.includes("function replace(id, take, { ikKeys = [], ikPins = [], ikPinResiduals = [] } = {})") && !/\bsetMotion\(/.test(app)
		&& !app.includes("loadMotion(") && !app.includes("commitLoadedTake"),
);
expect("individual block generation action is removed", !app.includes("Generate selected block"));
expect("desktop stage fills the remaining viewport", css.includes("aspect-ratio: auto") && css.includes("height: 100%"));
expect("sidebar width is bounded", css.includes("min-width: 280px") && css.includes("max-width: 50vw"));
expect("timeline height is bounded", css.includes("min-height: 110px") && css.includes("max-height: 58vh"));
expect("timeline IK text controls size to their labels", css.includes(".tl-btn.ik {") && css.includes("min-width: 48px") && css.includes("white-space: nowrap"));
// Floor-click authoring: waypoints are placed by clicking the set floor, so
// frame 0 is owned implicitly — the request prepends Subject 1's position and
// authored pins can never claim frame 0 or earlier.
expect("returned playback has no CozyClay root coordinate warp", !app.includes("warpMotionRootToPath"));
expect("Top-View root path draws from Subject 1 without a duplicate marker", planview.includes("[{ x: start.x, z: start.z }, ...waypoints]") && planview.includes("waypoints.map((w, i)"));
expect(
	"Top-View characters use their real meshes without covering hex pucks",
	planview.includes("<Puck color={color} showBody={false} {...state(puckId)} />") &&
	planview.includes("listIndex === 0 ? SUBJECT_ONE_COLOR : SUBJECT_TWO_COLOR") &&
	planview.includes("stem: makes the handle read as attached"),
);
expect(
	"Top-View uses saturated role colors and readable path widths",
	planview.includes('const CAMERA_COLOR = "#007f9e"') &&
	planview.includes('const SUBJECT_ONE_COLOR = "#2457d6"') &&
	planview.includes('const RAIL_COLOR = "#7137c8"') &&
	planview.includes("lineWidth={3}") && planview.includes("lineWidth={live ? 2.5 : 3.5}"),
);
expect(
	"Top-View props recede so the camera, cast and rail read first",
	planview.includes('const OBJECT_COLOR = "#f3f0ea"') &&
	planview.includes("const capY = (object.y ?? 0) + height + 0.02") &&
	planview.includes("muted={!selected}") &&
	planview.includes("<CastRing color={color} />"),
);
expect(
	"Top-View shows path endpoints and direction while composing a rail",
	planview.includes("function SubjectMovementGuide") &&
	planview.includes("directionTriangle") &&
	planview.includes('ko("PATH START", "경로 시작")') &&
	planview.includes('ko("PATH END", "경로 끝")') &&
	planview.includes("point.x.toFixed(1)") &&
	planview.includes('ko("PLAYER STILL", "플레이어 정지")') &&
	planview.includes("(railDraw || cameraRailPoints) && <SubjectMovementGuide"),
);
expect(
	"only generated ARDY motion drives the player guide",
	app.includes("subjectTrack={motion ? subjectTrack : null}") &&
	!app.includes("subjectTrackStart=") &&
	!app.includes("subjectTrackEnd="),
);
// Subject Height is world lift: floored at the deck, unbounded above. The
// control keeps its compact .cslider body — the track stays a useful 0..4
// band — while `softMax` lets the head scrub past 4 like a NumberField axis
// and the readout shows the true stored value. Both write paths (head
// scrub, viewport gizmo) agree on max(0, y).
expect(
	"Subject transforms have one inspector home with the direct tools",
	app.includes('title={workflowMode === "motion" ? ko("Placement", "배치") : ko("Transform", "변환")}') &&
	app.includes('{ axis: "X", value: shown.x, step: 0.05') &&
	app.includes('{ axis: "Y", value: activeChar.y ?? 0, step: 0.05') &&
	app.includes('{ axis: "Z", value: shown.z, step: 0.05') &&
	app.includes('label={ko("Rotation", "회전")}') &&
	app.includes('label={ko("Scale", "크기")}') &&
	app.includes('data-transform-controls'),
);
expect(
	"installed takes keep the authored character transform as a stage offset",
	app.includes("position: [placement.x, entry.y ?? 0, placement.z]") &&
	app.includes("rot: placement.rot") &&
	!app.includes("position: clip ? [clip.anchorX, entry.y ?? 0, clip.anchorZ]") &&
	!app.includes("rot: clip ? clip.rotationDeg : entry.rot"),
);
// Motion mode hides Move/Rotate/Scale, so the same foldout becomes the open
// Placement row (stage X/Z + turn) and Scene mode folds the full form away
// behind the gizmo (#194). Foldout reads defaultOpen once, hence the key.
expect(
	"the character transform is mode-aware",
	app.includes('key={workflowMode === "motion" ? "placement" : "transform"}') &&
	app.includes('defaultOpen={workflowMode === "motion"}') &&
	app.includes('ko("Stage position — does not change the take", "무대 위치 — 테이크는 바꾸지 않습니다")'),
);
// Entering Motion selects the active character's ROW: the placement gizmo only
// renders for a specific cast member, never for the group.
expect(
	"Motion mode lands on a character the gizmo can draw",
	app.includes("setSelectedHierarchyId(rowIdForCharIndex(activeCharIndex));"),
);
expect(
	"the character gizmo no longer caps lift at 4 m",
	elementByPath("character.position").gizmo.min.y === 0 &&
	elementByPath("character.position").gizmo.max.y >= 4 &&
	app.includes("next.y = Math.max(CHARACTER_POSITION_BOUNDS.min.y, patch.y)") &&
	!app.includes("clamp(patch.y, 0, 4)"),
);
expect(
	"the head scrub is floored at min with no upper clamp",
	ui.includes("onChange(Math.max(min, drag.base + (e.clientX - drag.x) * step * multiplier));"),
);
expect(
	"a soft-max readout shows the true stored value past the track",
	ui.includes("const shown = softMax ? floored : snapped;"),
);
expect("resize handles opt out on compact layouts", css.includes(".workspace-splitter,") && css.includes("display: none"));

/* ----------------------------- video capture ---------------------------- */
// Footage → takes → cast. The pins below hold the invariants that make an
// extracted take play at the right size, on the right layer, at the right
// place — each of them was a bug in the two-character prototype.
expect(
	"the Studio has no Advanced mode toggle",
	!app.includes("advanced-toggle") && !app.includes("cozyclay.advanced"),
);
expect(
	"the Studio's Window menu returns to Workflow",
	app.includes('className="menubar-item workflow-topbar-link" href="/workflow/"'),
);
expect(
	"expert foldouts stay enabled in the always-advanced Studio",
	app.includes('hidden={!isCharacterSelection}'),
);
// A take v3 persists as its source: the baked arrays are stripped from the
// stage, and the motion layer compiles the saved source again on load.
expect(
	"the save keeps the layer's IK edits (placement keys ride them) and the take v3 source, never the baked arrays",
	app.includes("cast().map(({ sessionMotion, placementKeys, ...entry }) => {") && app.includes("ikEdits: ikEditsOf(row), motionTake: savedTakeSource(row?.take)") && app.includes("characters: stageCharacters() }") &&
	app.includes("const saved = normalizeTakeSource(entry.motionTake), take = saved ? restoredTake(entry.id, saved) : null;") &&
	app.includes("compileTakeSource(take.source)"),
);
expect(
	"the timeline draws the active take as timing segments: Cut, an amber retime grip, trim grips and right-click remove",
	app.includes('motion={timelineTake(motion, characters[activeCharIndex]?.id, runStudioAction)}') &&
	timeline.includes("<TakeSegmentClips") && timeline.includes("<TakeSegmentTools") && takeSegments.includes('className={"tl-motion-clip"') &&
	takeSegments.includes('grip("speed"') && takeSegments.includes('grip("start"') && takeSegments.includes('grip("end"') && takeSegments.includes("motion.remove(segment.id)"),
);
// Foot snap and Body contact only reinterpret an IK drag (R7).
expect(
	"foot snap and body contact stay under IK, as two independent toggles",
	timeline.includes("{ikMode && (<>") &&
	timeline.includes('"tl-btn ik snap"') &&
	timeline.includes('"tl-btn ik contact"') &&
	timeline.includes('ko("Load a rig to edit poses"'),
);
expect("a deleted character takes its full take with it", app.includes("motionFullRef.current.delete(charId);"));

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
/** The body of the LAST rule with this exact selector, so later overrides win. */
function readRule(selector) {
  const needle = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(needle + "\\s*\\{([^}]*)\\}", "g");
  let last = "", m;
  while ((m = re.exec(CSS))) last = m[1];
  return last;
}

/* ---------------------------------------------------- inspector overflow --- */
// The last open section used to carry `flex: 1` — a zero basis that squeezed a
// tall section (the matte editor and its help text) down to whatever space was
// left, where the card's own `overflow: hidden` then cut it off. The scroll
// container above saw nothing to scroll, so the cut text was unreachable.

const lastCardRule = readRule(".inspector-scroll > .card.foldout.open:last-child");
expect(
  "the last inspector section may grow but never shrink below its content",
  /flex:\s*1\s+0\s+auto/.test(lastCardRule),
  lastCardRule,
);
expect(
  "the last inspector section does not clip what it should hand upward",
  /overflow:\s*visible/.test(lastCardRule),
  lastCardRule,
);
// `overflow: auto` is set in the base rule and never revoked, so assert across
// every `.inspector-scroll` block rather than only the last one.
const scrollRules = [...CSS.matchAll(/\.inspector-scroll\s*\{([^}]*)\}/g)].map((m) => m[1]);
expect(
  "the inspector scroll container still owns the scrolling",
  scrollRules.some((body) => /overflow:\s*auto/.test(body)) &&
    !scrollRules.some((body) => /overflow(-y)?:\s*(hidden|clip)/.test(body)),
  scrollRules.join(" | ").slice(0, 200),
);

// #650: the project's previs mode gates the shell. A storyboard drops Motion
// from the mode pill, key 4, the Generate group, root-path authoring and the
// motion timeline tools; the root carries the mode for the CSS gates.
const shellSource = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const appSource = shellSource("../src/App.jsx");
const viewportToolbar = shellSource("../src/shell/ViewportToolbar.jsx");
const topBar = shellSource("../src/shell/TopBar.jsx");
const modeCss = shellSource("../src/shell/mode.css");
expect("the studio root carries data-previs-mode beside data-workflow-mode", appSource.includes("data-workflow-mode={workflowMode} data-previs-mode={scenesDomain.previsMode}"));
expect("the mode pill drops Motion in a storyboard", viewportToolbar.includes('previsMode === "storyboard" ? MODES.filter((mode) => mode.id !== "motion") : MODES') && viewportToolbar.includes("modesFor(previsMode).map("));
expect("key 4 is ignored in a storyboard", appSource.includes('if (modeKey === "motion" && storyboardProject) return;'));
expect("selectWorkflowMode refuses Motion in a storyboard with the shared toast", appSource.includes('if (next === "motion" && storyboardProject) {') && appSource.includes("setToast(ko(STORYBOARD_MOTION_REFUSAL.en, STORYBOARD_MOTION_REFUSAL.ko, STORYBOARD_MOTION_REFUSAL.zh))"));
expect("the project head always shows the mode badge", topBar.includes('data-testid="topbar-previs-mode"') && topBar.includes("<PrevisModeBadge mode={previsMode} />") && !topBar.includes("previsEnabled"));
expect("waypoint authoring and Top-View path drawing stay off in a storyboard", appSource.includes("toggleWaypointMode: storyboardProject ? undefined : toggleWaypointMode") && appSource.includes("if (waypointMode) setWaypointMode(false);") && appSource.includes("if (pathDraw) setPathDraw(false);"));
expect(
	"storyboard CSS hides the take bar, motion/pose tools, the waypoint switch and the prop path track",
	[".take-bar", ".tl-motion-tools", ".tl-pose-tools", ".tl-btn.wp", ".tl-wp-hint", ".tl-track.objmo"].every((selector) => modeCss.includes(`.app[data-previs-mode="storyboard"] ${selector}`)),
);

// Add > Camera toasts the shot it made (its name and start frame); a refusal leaves the toast to runStudioAction.
const addCameraShot = readFileSync(new URL("../src/shell/add-camera-shot.js", import.meta.url), "utf8");
expect("Add > Camera toasts the new shot from its receipt", addCameraShot.includes("affectedIds") && addCameraShot.includes("setToast(") && addCameraShot.includes("startFrame") && viewportToolbar.includes("onClick={() => { addCameraShot({ appContext, runStudioAction, setToast }); menu.close(); }}"));

if (failures) process.exit(1);
console.log("all resizable workspace checks PASS");
