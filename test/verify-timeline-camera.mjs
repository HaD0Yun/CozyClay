#!/usr/bin/env node
// Unified Shot block contract: shot-camera keyframings render as dots on
// the Shot lane, each block's key strip authors framing on click, dots re-time
// by dragging, playback rides the keys segment by segment, and PlayView
// always plays the move with the motion. Ruler labels and lane gridlines
// share one 10-frame cadence.
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const app = readStudioSource()
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-canvas-rigs.jsx", import.meta.url), "utf8")
	// the per-shot follow/rail tracks the app plays
	+ readFileSync(new URL("../src/camera-direction.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const v2Css = readFileSync(new URL("../src/motion/timeline.css", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/motion/timeline.jsx", import.meta.url), "utf8");
const camMove = readFileSync(new URL("../src/camera-move.js", import.meta.url), "utf8");
const commands = readFileSync(new URL('../src/commands/shot.js', import.meta.url), 'utf8');

expect("timeline has one combined Shot/Camera track", timeline.includes('const SHOTS_LANE = "Shots";') && !timeline.includes('const CAMERA_LANE = "Camera";') && !timeline.includes('"Camera",'));
expect("v2 sequencer root and scoped stylesheet are wired", timeline.includes('className={"timeline v2-sequencer"') && timeline.includes('import "./timeline.css";') && v2Css.includes('.v2-sequencer .tl-head') && v2Css.includes('var(--select, #e8a33d)'));
expect("v2 lane labels expose Body, IK keys, Camera Cuts, Rail and Crane", ["Body", "IK keys", "Camera Cuts", "Rail", "Crane"].every((label) => timeline.includes(`data-lane-label="${label}"`)) && timeline.includes('ko("Root path", "루트 경로")'));
expect("ruler labels step in 10-frame units", timeline.includes("const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];"));
expect("lane gridlines ride one 10-frame cadence", timeline.includes("const GRID_STEP_FRAMES = 10;") && timeline.includes("f += GRID_STEP_FRAMES"));
expect("gridlines render from the ruler's framePct", timeline.includes('className="tl-grid"') && timeline.includes('style={{ "--tl-f": framePct(f, displayFrameCount) }}'));
expect("the take strip and markers share one frame scale", !timeline.includes("promptFramePct") && timeline.includes("clipPct={clipPct}"));

expect("camera keys render as dots, not a chip", timeline.includes('className="tl-marker cam"') && !timeline.includes("tl-chip camera"));
expect("block key strip keys framing while a dedicated crane graph authors Rail points", timeline.includes("handlers.current.onCameraKeyframeAdd?.(target, shot.id)") && timeline.includes("onCranePointAdd?.(t, shot.id)") && timeline.includes('className="tl-crane-editor"') && app.includes("onCameraKeyframeAdd={addCameraKeyframe}"));
expect("key strip is a crosshair affordance", css.includes(".tl-shot-key-surface") && css.includes("cursor: crosshair"));
expect("dot click jumps the playhead and selects the camera", timeline.includes("handlers.current.onScrub?.(key.frame)") && timeline.includes("handlers.current.onCameraMoveSelect?.();"));
expect("dot right-click removes the key", timeline.includes("handlers.current.onCameraKeyframeRemove?.(shot.id, key.id)") && commands.includes("removeCameraKey(shot.cameraKeys, keyId)"));
expect("dot drag re-times the key", timeline.includes("handlers.current.onCameraKeyframeMove?.(active.shotId, active.keyId, from, next)") && app.includes("onCameraKeyframeMove={moveCameraKeyframe}"));
expect("keys stay frame-unique on re-time", commands.includes("moveCameraKey(shot.cameraKeys, keyId,"));
expect("re-keying a frame overwrites its framing", commands.includes("shot.cameraKeys.filter(key => key.frame !== target)") && commands.includes("createStableItemId('camera-key')"));

expect("the move model is per-shot N keys, not A/B", app.includes("useDocumentDomain(domain.documentStore, 'shot')") && app.includes("const cameraKeys = activeShot?.cameraKeys ?? []") && !app.includes("setMoveA") && !app.includes("setMoveB"));
expect("interpolation samples keys segment by segment", camMove.includes("export function cameraMoveAt") && camMove.includes("interpolateFraming(a.framing, b.framing, anchor"));
expect("MoveRig plays and follows keys through the pure frame sampler", app.includes("keys={cameraKeys}") && app.includes("sampleAt(scene, sampledShot, frame).camera"));
expect("sequence slate and phrase derive per segment", app.includes("moveSequenceSlate(segs)") && app.includes("moveSequencePhrase(segs)"));
expect("generation exports first/last key conditioning frames", app.includes("captureFramingPng(cameraKeys[0].framing)") && app.includes("captureFramingPng(cameraKeys[cameraKeys.length - 1].framing)"));
expect("the duration slider is gone — dots own timing", !app.includes("moveDurationS"));

// #195: the Scene/PlayView tabs are gone. The framed player is the `preview`
// state, entered from the Workflow embed and the playground rail. Studio
// look-through flies the shot camera instead of opening that player.
expect(
	"entering preview restarts the piece from frame 0 and plays it when there is motion",
	/function enterPreview\(\) \{[^}]*setPreview\(true\);[^}]*setLookThroughShot\(true\);[^}]*setTlFrame\(0\);[^}]*if \(motion\) setTlPlaying\(true\);/s.test(app),
);
expect(
	"leaving preview restores the editor view and pauses",
	/function exitPreview\(\) \{[^}]*setPreview\(false\);[^}]*setLookThroughShot\(false\);[^}]*setTlPlaying\(false\);/s.test(app),
);
expect(
	"look-through flies the shot camera instead of opening the player",
	app.includes("function enterShotLook()") &&
	app.includes("onClick={enterShotLook}") &&
	app.includes('if (event.key === "Escape") exitPreview();'),
);
expect(
	"look-through keeps fly controls on the shot camera outside preview",
	app.includes("camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef}") &&
	app.includes("enabled={!posing && !playMode && !sculptMode}") &&
	app.includes("onCameraChange={lookThroughShot && !ikMode ? commitManualCameraFraming : undefined}"),
);
expect("preview always rides the camera move", app.includes("preview || (moveFollow && !ikMode && !waypointMode && !posing)"));
expect("the editor view keeps the authoring gates on Follow mode", app.includes("moveFollow && !ikMode && !waypointMode && !posing"));
expect(
	"Draw Rail row owns the distance Follow On Off toggle",
	timeline.includes('aria-pressed={mode === "follow"}') &&
	timeline.includes('mode === "follow" ? ko("Follow On", "팔로우 켜짐") : ko("Follow Off", "팔로우 꺼짐")') &&
	timeline.includes('patchCamera({ mode: mode === "follow" ? "keys" : "follow" })') &&
	!app.includes('ko("Follow On", "팔로우 켜짐")') &&
	app.includes('if (patch.mode === "follow") syncActiveCameraFraming()'),
);

expect("surface lays out four tracks, and the Shot row is never the one that falls off", css.includes("grid-template-rows: 28px repeat(3, minmax(18px, 1fr)) minmax(68px, 1.7fr)") && css.includes("height: 100%;"));
expect("lane gridlines are frame-based, not width-based", css.includes(".tl-grid {") && !css.includes("100% / 23"));
expect("camera dots have a distinct violet identity", css.includes(".tl-marker.cam {") && css.includes("#a78bfa"));
expect("the Rail Follow ribbon is gone; the crane height editor owns the card interaction", timeline.includes("shot.camera?.railFollow") && timeline.includes('className="tl-crane-editor"') && timeline.includes('className="tl-crane-editor-hit"') && !timeline.includes('className="tl-crane-strip"') && !timeline.includes('className={"tl-rail"') && !timeline.includes("name === CAMERA_LANE"));
expect("no ribbon editing gestures survive in the timeline", !["beginRailMove", "beginRailResize", "onRailKeyDown", "railDragRef"].some((name) => timeline.includes(name)));
expect("the rail schedule model still resolves per shot in the app", app.includes("resolveRailSchedule({ railFollow: camera.railFollow"));
expect("Rail range playback is resolved per shot", app.includes("resolveRailSchedule({ railFollow: camera.railFollow") && app.includes("subjectSlice.slice(schedule.startFrame, schedule.endFrame + 1)"));
expect("the crane graph itself selects, adds, and vertically drags height points", timeline.includes("function CraneHeightEditor") && timeline.includes("onSelect?.(nearest.index)") && timeline.includes("onChangePoints?.(drag.points)") && timeline.includes("onAddPoint?.(drag.addAt)"));
expect(
	"authoring a crane point shows it: the box switches to the curve it just edited",
	// the box draws one curve at a time, so adding a crane point while it drew
	// SPEED put the new point where the card could not draw it — it appeared in
	// the scene and nowhere near the hand that placed it
	timeline.includes('setCameraCurve("height");') &&
	timeline.indexOf('setCameraCurve("height");') < timeline.indexOf("onCranePointAdd?.(t, shot.id);"),
);
expect(
	"the crane line is sampled from the model that flies the camera",
	// craneHeightAt runs a monotone cubic; straight segments drew a motion the
	// rig never performs
	timeline.includes("function craneCurvePath(points, xFor, yFor)") &&
	timeline.includes("craneHeightAt(crane, t)") &&
	timeline.includes('import { buildRail, craneHeightAt } from "../camera-follow.js";') &&
	!timeline.includes('<polyline className="tl-crane-line"'),
);
expect(
	"curves drag at a fixed rate, not at the surface's height",
	// a curve inside a 39px Shot box mapped its whole range onto 39px, so a
	// twitch swung it a quarter of the way; the drag is units-per-pixel now,
	// and the height axis is frozen for the gesture so the scale cannot feed back
	timeline.includes("const DRAG_TRAVEL_PX = 220;") &&
	timeline.includes("const FINE_DRAG_FACTOR = 0.25;") &&
	timeline.includes("function dragValue(start, event, unitsPerPx)") &&
	timeline.includes("event.shiftKey ? FINE_DRAG_FACTOR : 1") &&
	timeline.includes("yMax / DRAG_TRAVEL_PX") &&
	timeline.includes("maxHeight / DRAG_TRAVEL_PX") &&
	timeline.includes("const maxHeight = heldScale ??"),
);

expect(
	"unified lane renders exactly one block from each shot geometry",
	timeline.includes("name === SHOTS_LANE && shots.map((shot, index)") &&
	timeline.includes("shotBlockGeometry(shots, index, frameCount, displayFrameCount)"),
);
expect("unified blocks preserve the violet camera identity", css.includes(".tl-shot-block {") && css.includes("border: 1px solid #735ba0"));
expect(
	"camera blocks summarize authored state",
	timeline.includes('"FREE" : "LOCKED"') &&
	timeline.includes("`KEYS ${keyCount}`") &&
	timeline.includes('? "RAIL" : mode === "follow" ? "FOLLOW"') &&
	timeline.includes('"HEAD" : "NEAREST"') &&
	timeline.includes("m/s") && timeline.includes("PITCH"),
);
expect(
	"camera block selection also selects its owning shot",
	timeline.includes("handlers.current.onCameraBlockSelect?.(shot.id)") &&
	timeline.includes("handlers.current.onShotSelect?.(shot.id)") &&
	timeline.includes("handlers.current.onCameraMoveSelect?.()"),
);
expect(
	"one add button creates a separate shared shot-camera card",
	!timeline.includes('className="tl-track-add cut camera"') &&
	timeline.includes('ko("+ Add shot", "+ 샷 추가")') &&
	timeline.includes("handlers.current.onShotCut?.()"),
);
expect(
	"one edge set owns shot and camera boundaries",
	!timeline.includes('className="tl-camera-edge') &&
	timeline.includes('className="tl-shot-edge start"') &&
	timeline.includes('className="tl-shot-edge end"') &&
	timeline.includes('beginShotBoundaryDrag(e, index, "start")') &&
	timeline.includes('beginShotBoundaryDrag(e, index, "end")'),
);
expect(
	"selected camera mini editor sits above the lane body",
	timeline.indexOf("<CameraBlockEditor") > 0 &&
	timeline.indexOf("<CameraBlockEditor") < timeline.indexOf('<div className="tl-body"'),
);
expect(
	"mini editor exposes preview, rail drawing and director controls",
	!timeline.includes('["keys", ko("Keys", "키")]') &&
	!timeline.includes('["follow", ko("Follow", "팔로우")]') &&
	!timeline.includes('["rail", ko("Rail", "레일")]') &&
	timeline.includes('ko("Preview", "미리보기")') &&
	timeline.includes('ko("Draw rail", "레일 그리기")') &&
	timeline.includes('ko("Follow On", "팔로우 켜짐")') &&
	timeline.includes('ko("Speed", "속도")') &&
	timeline.includes('ko("Pitch", "피치")') &&
	timeline.includes('ko("Distance", "거리")') &&
	timeline.includes('ko("Height", "높이")'),
);
// Scope the count to CameraBlockEditor: other editors in this file (the
// object travel path) reuse the same readout class, so a file-wide count
// would break every time the strip grows a neighbour.
const cameraEditorSource = timeline.slice(
	timeline.indexOf("function CameraBlockEditor("),
	timeline.indexOf("function ", timeline.indexOf("function CameraBlockEditor(") + 1),
);
// The bar now carries a Speed/Height curve switch as well as the Height
// READOUT, so measure from the last Height mention before Pitch: it is the
// readout's own label the pin is about.
const pitchAt = cameraEditorSource.indexOf('ko("Pitch", "피치")');
const heightReadoutAt = cameraEditorSource.lastIndexOf('ko("Height", "높이")', pitchAt);
expect(
	"height and pitch are adjacent in the camera bar",
	heightReadoutAt > 0 && heightReadoutAt < pitchAt &&
	(cameraEditorSource.slice(heightReadoutAt, pitchAt).match(/<label/g) ?? []).length === 1,
);
expect(
	"distance, height and pitch are measured from viewport manipulation instead of typed",
	cameraEditorSource.includes('className="tl-camera-metric"') &&
	(cameraEditorSource.match(/className="tl-camera-metric"/g) ?? []).length === 3 &&
	app.includes("followFramingFromCamera(") &&
	app.includes("cam.position,") &&
	app.includes("look.current.pitch,") &&
	app.includes("onCameraChange={commitManualCameraFraming}"),
);
expect(
	"manual viewport framing stays put until preview or playback",
	app.includes("function cameraPatch(camera, manual = true)") && app.includes("shared.manualCameraOverrideRef.current = manual") &&
	// flying only interrupts playback while look-through hands the fly
	// controls the shot camera itself; editor-camera flights never touch it
	(app.match(/\(lookThroughShot && flyingRef\.current\) \|\| manualCameraOverrideRef\.current/g) ?? []).length === 2 &&
	app.includes("manualCameraOverrideRef.current = false"),
);
expect(
	"the rail crane is always on, with a per-point height input",
	// no toggle: a rail block is always craned (camera-block.js normalizes a
	// stored null to the flat profile), so the on/off button is gone
	!timeline.includes('ko("Crane On", "\ud06c\ub808\uc778 \ucf1c\uc9d0")') &&
	!timeline.includes('ko("Crane Off", "\ud06c\ub808\uc778 \uaebc\uc9d0")') &&
	timeline.includes('ko("Point height", "\uc810 \ub192\uc774")') &&
	// a missing stored value seeds the same flat two-mark profile inline
	timeline.includes("{ points: [{ t: 0, height: follow.height }, { t: 1, height: follow.height }] }") &&
	// the scene dots are the primary editor; the bar edits the SELECTED point
	timeline.includes("craneSelectedIndex"),
);
expect(
	"crane points are added on the Shot key strip only, removed explicitly",
	// no Add point button: the Shot block's key strip is the single authoring
	// surface for new crane marks (plus double-clicking the lifted curve)
	!timeline.includes('ko("Add point", "점 추가")') &&
		timeline.includes('ko("Remove point", "점 삭제")') &&
		timeline.includes("onCranePointAdd") &&
		timeline.includes("onCranePointDelete"),
);
expect(
	"rail crane points are authored and selected directly in the crane graph",
	timeline.includes("function CraneHeightEditor") &&
	timeline.includes("tl-crane-knob") &&
	timeline.includes("tl-crane-editor") &&
	timeline.includes("onAddPoint?.(drag.addAt)") &&
	timeline.includes("onChangePoints?.(drag.points)") &&
	timeline.includes("onCranePointSelect"),
);
expect(
	"waypoint mode replaces camera controls with one clear message",
	timeline.includes("blocked={waypointMode}") &&
	timeline.includes('className="tl-camera-blocked"') &&
	timeline.includes('ko("Turn Waypoint off to edit or preview this camera.'),
);
expect(
	"damping and look-ahead stay behind advanced disclosure",
	timeline.includes('className="tl-camera-advanced"') &&
	timeline.includes('ko("Damping", "댐핑")') &&
	timeline.includes('ko("Look-ahead", "조준 선행")'),
);
expect(
	"timeline editor is the single follow-camera settings surface",
	!app.includes('<Slider label={ko("Distance", "거리")}') &&
	!app.includes('<Slider label={ko("Dolly speed", "돌리 속도")}') &&
	app.includes('className="camera-editor-pointer"') &&
	timeline.includes('ko("Draw rail", "레일 그리기")') &&
	!timeline.includes('ko("Clear rail", "레일 지우기")'),
);
expect(
	"Draw Rail exposes an explicit delete action",
	timeline.includes('ko("Delete rail", "레일 삭제")') &&
	timeline.includes("onRailDelete") &&
	commands.includes("removeCameraRail(shot.camera)"),
);
expect(
	"preview starts at the selected shot and stops at its end",
	app.includes("function previewCameraShot(shotId)") &&
	app.includes("cameraPreviewEndRef.current = selected.endFrame") &&
	app.includes("setTlFrame(selected.startFrame)") &&
	app.includes("tlFrameRef.current + count >= previewEnd") &&
	app.includes("setTlFrame(previewEnd)"),
);
expect(
	"rail ribbon cannot cover the shot frame range",
	css.includes(".tl-shot-label {") && css.includes("z-index: 5") &&
	css.includes(".tl-shot-label small {") && css.includes("background: rgba(68, 54, 93, .86)") &&
	css.includes("minmax(68px, 1.7fr)"),
);
expect(
	"the bottom window never grows for camera, rail, or path content",
	!css.includes("has(.tl-camera-advanced[open])") &&
	!css.includes("has(.tl-camera-editor)") &&
	!css.includes("has(.tl-track.sg-row)") &&
	css.includes("min-height: 156px"),
);
expect(
	"camera editor emits shot-camera patches without owning global state",
	timeline.includes("handlers.current.onCameraBlockChange?.(patch)") &&
	!timeline.includes("localStorage") && !timeline.includes("setFollowCam"),
);
expect(
	"key dots remain overlaid above unified blocks and draggable",
	css.includes(".tl-marker.cam {") && css.includes("z-index: 5") &&
	timeline.includes("onPointerMove={moveCameraKeyDrag}"),
);

if (failures) process.exit(1);
console.log("all timeline camera checks PASS");
