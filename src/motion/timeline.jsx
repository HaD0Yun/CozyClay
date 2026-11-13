import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameFromClientX, groupKeyRuns, KEY_RUN_MIN, rangePinBandGeometry, shotBlockGeometry } from "./timeline-coordinates.js";
import { createPlaybackClock } from "./playback-clock.js";
import { startPlaybackRun } from "../playback-telemetry.js";

import { ko } from "../locale.js";
import { isImeComposing } from "../ime.js";
import { buildRail, craneHeightAt } from "../camera-follow.js";
import { insertPathMark, pathMarks, pathMetrics, pathProgressAt, MAX_PATH_LEAN } from "../object-path.js";
import { NumberField } from "../ui.jsx";
import { flatTiming, timingIsFlat, envelopeDrag, insertCut, removeCut, CUT_MIN_GAP } from "../speed-envelope.js";
import { checkShotAgainstPreset, presetById } from "../model-presets.js";
import { WORLD } from "../world-scale.js";
import { TakeSegmentClips, TakeSegmentTools } from "./take-segments.jsx"; import { NotePinButton, NotePins } from "./TimelineNotePins.jsx"; import { ikLanePress } from "./pose-key-door.js"; import { FixIslandBands, IkPartLabels, IkPartsToggle, useIkParts } from "./TimelineFixIslands.jsx"; import { FixTools } from "../shell/FixTools.jsx"; import { PhysicsToggle } from "../physics-toggle.jsx";
import "./timeline.css";
export { timelineTake } from "./take-segments.jsx";

/**
 * Viser-style animation timeline — the live motion workspace.
 *
 * Frame, playback, waypoints and the motion badge are owned by App: this
 * component is controlled and reports every interaction through callbacks,
 * so the scene (character rig, root path) can react to playhead moves.
 * The 2D Root lane authors temporal keyframes directly: left-clicking an empty
 * track cell creates/selects a numbered waypoint, then Top-View owns its
 * spatial position through direct marker dragging.
 * The unified Shot lane authors shot-camera keyframings directly: left-clicking
 * a block's lower strip keys the CURRENT camera framing there, dots jump
 * the playhead on click, drag to re-time, right-click to remove. Playback
 * and PlayView ride the keys segment by segment.
 */

const DEFAULT_FRAME_COUNT = 360; // 15 s @ 24 fps, the production clock the app timeline runs on
const DEFAULT_FPS = 24;
// Trackpad/wheel zoom over the FRAME ruler: the gesture changes only the
// horizontal visual scale of the time surface — never frameCount, fps,
// duration, waypoints or the generation request.
const ZOOM_MIN = 1 / 3; // show up to 3× more frames than the 1× viewport
const ZOOM_DEFAULT = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 0.25; // one wheel notch = one zoom step
// Wheel deltas are accumulated in pixels; LINE/PAGE deltas are normalized
// (a line-mode notch is ~3 lines). A step fires every 50 px, capped at 3
// steps per event so a violent flick cannot jump the whole range.
const WHEEL_STEP_PX = 50;
const MAX_WHEEL_STEPS = 3;

const TRACKS = [
	"Full-Body",
	"2D Root",
	"Shots",
];
const TRACK_LABELS_KO = {
	
	"Full-Body": ko("Body", "바디"),
	"2D Root": ko("Root path", "루트 경로"),
	Shots: ko("Camera Cuts", "카메라 컷"),
};

/** IK keys live on the Full-Body lane: one marker per keyed frame, holding
 * a sparse set of the limbs the user has moved (never every joint). */
const IK_LANE = "Full-Body";
const SHOTS_LANE = "Shots";
// Ruler labels and lane gridlines share one 10-frame cadence, so authored
// elements (camera key dots, root pins) always land on visible
// lines. Label density adapts to zoom in 10-based steps.
const GRID_STEP_FRAMES = 10;
const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];
const MAX_LABELS = 30;

const framePct = (f, count) => (count > 1 ? f / (count - 1) : 0);

// Timeline frames are addressed from zero, while the clip duration is the
// number of frames divided by its clock. Keeping this conversion local makes
// the readout honest at any loaded fps (the final frame is just shy of the
// displayed total duration, as it is in an actual frame sequence).
const CAMERA_BLOCK_DEFAULTS = {
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
};

function cameraBlockMode(shot) {
	const mode = shot?.camera?.mode;
	if (mode === "keys" || mode === "follow" || mode === "rail") return mode;
	if (shot?.camera?.cameraRail) return "rail";
	if (shot?.camera?.followCam?.enabled) return "follow";
	return "keys";
}

function cameraBlockFollow(shot) {
	return { ...CAMERA_BLOCK_DEFAULTS, ...(shot?.camera?.followCam ?? {}) };
}

function signedDegrees(value) {
	const rounded = Math.round(Number(value) || 0);
	return `${rounded >= 0 ? "+" : ""}${rounded}\u00b0`;
}

function signedValue(value) {
	const rounded = Math.round((Number(value) || 0) * 10) / 10;
	return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

/**
 * The crane's path between its points, sampled from the model that flies the
 * camera. craneHeightAt() runs a monotone cubic, so straight segments drew a
 * motion the rig never performs — an eased rise read as a mechanical ramp, and
 * a point dragged past its neighbours showed no overshoot where the real lens
 * has none either. Sampling keeps the picture honest without a second
 * implementation of the easing.
 */
function craneCurvePath(points, xFor, yFor) {
	const crane = { points };
	const steps = Math.max(24, points.length * 12);
	let d = `M ${xFor(points[0].t)} ${yFor(points[0].height)}`;
	for (let step = 1; step <= steps; step += 1) {
		const t = points[0].t + (points[points.length - 1].t - points[0].t) * (step / steps);
		d += ` L ${xFor(t)} ${yFor(craneHeightAt(crane, t))}`;
	}
	return d;
}

/**
 * The crane's height curve, drawn as a real graph: time across the take's own
 * window, metres up. It is the twin of the speed graph rather than a strip of
 * dots — same zero line, same fill, same readout — because a height profile is
 * read the same way a speed profile is, and two instruments that answer
 * different questions should still be read with one pair of eyes.
 *
 * Every gesture lands on the graph itself: press near a point to take it,
 * press anywhere else to add one there, drag to set the height. The points are
 * generous circles, not pixel dots, so a lens height is aimed at with the
 * wrist rather than with the fingertip.
 */
function CraneHeightEditor(props) { return props.crane?.points?.length && props.railRange ? <CraneHeightGraph {...props} /> : null; }
function CraneHeightGraph({ crane, railRange, durationFrames, selectedIndex, onSelect, onAddPoint, onChangePoints }) {
	const svgRef = useRef(null);
	const dragRef = useRef(null);
	const [draftPoints, setDraftPoints] = useState(null);
	// The axis is frozen for the whole gesture. A scale that grew with the draft
	// would re-map the pointer under itself on every move — one flick of the
	// wrist and the value runs away by tens of metres.
	const [heldScale, setHeldScale] = useState(null);
	const points = draftPoints ?? crane.points;
	const origin = railRange.start / Math.max(1, durationFrames - 1);
	const span = Math.max(0.001, (railRange.end - railRange.start) / Math.max(1, durationFrames - 1));
	const maxHeight = heldScale ?? Math.max(4, Math.ceil(Math.max(...crane.points.map((point) => point.height), 1) * 1.25));
	const xFor = (t) => origin + t * span;
	const yFor = (height) => 0.9 - (Math.max(0.1, Math.min(maxHeight, height)) - 0.1) / Math.max(0.1, maxHeight - 0.1) * 0.78;
	const locate = (event) => {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect || rect.width < 2 || rect.height < 2) return null;
		const takeX = (event.clientX - rect.left) / rect.width;
		const graphY = (event.clientY - rect.top) / rect.height;
		const t = Math.max(0, Math.min(1, (takeX - origin) / span));
		const height = 0.1 + (0.9 - graphY) / 0.78 * (maxHeight - 0.1);
		return { takeX, graphY, t, height: Math.max(0.1, Math.min(maxHeight, height)) };
	};
	const finishDrag = (event) => {
		const drag = dragRef.current;
		if (!drag) return;
		event.preventDefault();
		event.stopPropagation();
		dragRef.current = null;
		if (drag.points && drag.moved) onChangePoints?.(drag.points);
		else if (!drag.moved && drag.addAt != null) onAddPoint?.(drag.addAt);
		setDraftPoints(null);
		setHeldScale(null);
		event.currentTarget.releasePointerCapture?.(event.pointerId);
	};
	const onPointerDown = (event) => {
		if (event.button !== 0) return;
		const at = locate(event);
		if (!at) return;
		const nearest = points.reduce((best, point, index) => {
			const distance = Math.abs(point.t - at.t);
			return distance < best.distance ? { index, distance } : best;
		}, { index: -1, distance: 0.12 });
		event.preventDefault();
		event.stopPropagation();
		if (nearest.index >= 0 && nearest.distance <= 0.12) {
			onSelect?.(nearest.index);
			dragRef.current = {
				index: nearest.index,
				points,
				moved: false,
				start: { clientY: event.clientY, value: points[nearest.index].height },
			};
			setHeldScale(maxHeight);
			svgRef.current?.setPointerCapture?.(event.pointerId);
			return;
		}
		if (at.t > 0.01 && at.t < 0.99) dragRef.current = { index: -1, points: null, moved: false, addAt: at.t, start: { clientY: event.clientY, value: at.height } };
	};
	const onPointerMove = (event) => {
		const drag = dragRef.current;
		if (!drag) return;
		event.preventDefault();
		event.stopPropagation();
		const at = locate(event);
		if (!at) return;
		if (drag.index < 0) {
			// A press on empty time becomes an add, not a drag — but only once the
			// hand has actually travelled, so a click is still a click.
			if (Math.abs(event.clientY - (drag.start?.clientY ?? event.clientY)) > 3) dragRef.current = { ...drag, moved: true };
			return;
		}
		// Metres per pixel, not "wherever the cursor is": the box is 39 px tall,
		// so following the pointer made every twitch a metre.
		const height = Math.max(0.1, Math.min(maxHeight, dragValue(drag.start, event, maxHeight / DRAG_TRAVEL_PX)));
		const moved = drag.moved || Math.abs(height - drag.start.value) > 0.005;
		const next = points.map((point, index) => index === drag.index ? { ...point, height } : point);
		dragRef.current = { ...drag, points: next, moved };
		setDraftPoints(next);
	};
	useEffect(() => {
		const move = (event) => onPointerMove(event);
		const up = (event) => finishDrag(event);
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
		return () => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
	}, [points, origin, span, maxHeight]);
	const topLabel = maxHeight.toFixed(1);
	const midLabel = (maxHeight / 2).toFixed(1);
	return (
		<div className="tl-crane-editor" title={ko("Crane height: click to add, click a point to select, drag vertically to change height", "크레인 높이: 클릭해 추가하고, 점을 눌러 선택하고, 위아래로 끌어 높이를 바꿉니다")}>
			<svg
				ref={svgRef}
				className="tl-crane-editor-svg"
				viewBox="0 0 1 1"
				preserveAspectRatio="none"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finishDrag}
				onPointerCancel={finishDrag}
				onDoubleClick={(event) => event.stopPropagation()}
			>
				<rect className="tl-crane-editor-hit" x="0" y="0" width="1" height="1" />
				{origin > 0.001 && <rect className="sg-outside" x="0" y="0" width={origin} height="1" />}
				{origin + span < 0.999 && <rect className="sg-outside" x={origin + span} y="0" width={1 - origin - span} height="1" />}
				<line className="tl-crane-grid" x1={origin} y1={yFor(maxHeight / 2)} x2={origin + span} y2={yFor(maxHeight / 2)} />
				<line className="sg-axis" x1="0" y1=".9" x2="1" y2=".9" />
				<path
					className="tl-crane-fill"
					d={`${craneCurvePath(points, xFor, yFor)} L ${xFor(1)} 0.9 L ${xFor(0)} 0.9 Z`}
				/>
				<path className="tl-crane-line" d={craneCurvePath(points, xFor, yFor)} />
				{points.map((point, index) => (
					<line
						key={index}
						className={"tl-crane-time-pick" + (index === selectedIndex ? " selected" : "")}
						x1={xFor(point.t)}
						y1={yFor(point.height)}
						x2={xFor(point.t)}
						y2=".9"
					/>
				))}
			</svg>
			{/* The dots are HTML, not SVG: the graph's viewBox is stretched to the
			    lane, which would squash a circle into a sliver and take its hit
			    area with it. */}
			{points.map((point, index) => (
				<button
					key={index}
					type="button"
					className={"tl-crane-knob" + (index === selectedIndex ? " selected" : "")}
					// an end point sits ON the window edge; clamp it inside so the knob stays whole. The clamp is the
					// knob's own radius: a wider one pinned every knob of a 20 px Shot strip to one row, off its curve.
					style={{ left: `clamp(5px, ${xFor(point.t) * 100}%, calc(100% - 5px))`, top: `clamp(5px, ${yFor(point.height) * 100}%, calc(100% - 5px))` }}
					aria-label={ko(`Crane point ${index + 1}, ${point.height.toFixed(1)} metres`, `크레인 점 ${index + 1}, ${point.height.toFixed(1)}미터`, `摇臂点 ${index + 1}，${point.height.toFixed(1)} 米`)}
					onPointerDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onSelect?.(index);
						dragRef.current = { index, points, moved: false, start: { clientY: event.clientY, value: point.height } };
						setHeldScale(maxHeight);
						svgRef.current?.setPointerCapture?.(event.pointerId);
					}}
				/>
			))}
			<span className="sg-scale-top">{topLabel}</span>
			<span className="sg-scale-avg" style={{ top: `${yFor(maxHeight / 2) * 100}%` }}>{midLabel}</span>
			<span className="sg-scale-zero">0</span>
			{draftPoints && dragRef.current?.index >= 0 && (
				<span className="sg-readout" style={{ left: `${xFor(points[dragRef.current.index].t) * 100}%` }}>
					{points[dragRef.current.index].height.toFixed(2)} m
				</span>
			)}
		</div>
	);
}

/** The y-axis follows the data — a display clamp would flatten a real curve
 * into a ceiling plateau and break the visible area, which is the whole
 * point of the editor. Floor at 2x average so a flat route keeps sane
 * proportions; headroom 15% so the peak never kisses the frame. */
const GRAPH_MIN_SCALE = 2;

/**
 * How far the hand travels to sweep a curve's whole range, in pixels.
 *
 * Mapping the pointer's position straight onto the value ties the sensitivity
 * to the surface's height — and a curve drawn inside a Shot box is 39 px tall,
 * so a two-pixel twitch swung the value across a quarter of its range. The
 * drag is a RATE instead: a fixed number of pixels per full sweep, so the same
 * wrist movement means the same change whether the curve is in a 39 px box or
 * an 88 px strip. Hold Shift for a quarter-speed pass over fine detail.
 */
const DRAG_TRAVEL_PX = 220;
const FINE_DRAG_FACTOR = 0.25;

function dragValue(start, event, unitsPerPx) {
	const gain = unitsPerPx * (event.shiftKey ? FINE_DRAG_FACTOR : 1);
	return start.value + (start.clientY - event.clientY) * gain;
}

const sgY = (value, yMax) => 1 - Math.min(value, yMax) / yMax;

/**
 * The speed editor, designed as its own instrument rather than a lane
 * decoration: a header carrying the facts (distance, time, average) and the
 * actions (cut, reset), and a body that reads like a graph — a zero line, a
 * dashed average line, an area-filled curve. Time across, speed up, and the
 * area under the curve is the distance: dragging a stretch up visibly sinks
 * the rest of its segment, because the arrival frame is not negotiable.
 *
 * Cuts are first-class: a header button pins the playhead's instant, a
 * double-click pins the pointer's, and each pin draws an amber diamond the
 * size of a handle — click to select, Delete to remove.
 */
function SpeedGraph({
	facts = null,
	// Inside a Shot box the curve is all there is: the box already carries the
	// name, the frames and the actions live in the camera bar, so a header here
	// would only steal the height the line needs.
	bare = false,
	timing,
	windowStart = 0,
	windowFrac = 1,
	frame,
	frameCount,
	averageSpeed = 1,
	speedUnit = "m/s",
	onChange,
	onGestureStart,
	onGestureEnd,
}) {
	const svgRef = useRef(null);
	const dragRef = useRef(null);
	const [selectedCut, setSelectedCut] = useState(null);
	const [readout, setReadout] = useState(null);
	const shown = timing ?? flatTiming();
	const span = Math.max(1e-6, Math.min(1, windowFrac));
	const origin = Math.max(0, Math.min(1, windowStart));
	const hasCurve = !timingIsFlat(timing);
	// While dragging, the axis may need to grow past the envelope's own peak;
	// it never shrinks mid-gesture (that would move the curve out from under
	// the pointer), and settles back to the data on release.
	const [dragPeak, setDragPeak] = useState(0);
	const envelopePeak = useMemo(() => Math.max(1, ...shown.envelopes.flat()), [shown]);
	const yMax = Math.max(GRAPH_MIN_SCALE, Math.ceil(Math.max(envelopePeak, dragPeak) * 1.15 * 2) / 2);

	const segments = useMemo(() => {
		const bounds = [{ t: 0, d: 0 }, ...shown.cuts, { t: 1, d: 1 }];
		return shown.envelopes.map((envelope, index) => {
			const a = bounds[index].t;
			const b = bounds[index + 1].t;
			const points = envelope.map((value, i) => {
				const x = origin + (a + (b - a) * (i / (envelope.length - 1))) * span;
				return `${x.toFixed(4)},${sgY(value, yMax).toFixed(4)}`;
			});
			return { key: index, a, b, line: points.join(" ") };
		});
	}, [shown, span, origin, yMax]);

	const locate = (event) => {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect || rect.width < 2) return null;
		const takeX = (event.clientX - rect.left) / rect.width;
		const u = Math.min(1, Math.max(0, (takeX - origin) / span));
		const value = Math.max(0, (1 - (event.clientY - rect.top) / rect.height) * yMax);
		return { takeX, u, value };
	};

	/** The curve's own value at u, in multiples of the average. */
	const envelopeValueHere = (u) => {
		const bounds = [{ t: 0 }, ...shown.cuts, { t: 1 }];
		let index = 0;
		while (index < shown.cuts.length && u > shown.cuts[index].t) index += 1;
		const a = bounds[index].t;
		const b = bounds[index + 1].t;
		const local = Math.max(0, Math.min(1, (u - a) / Math.max(1e-9, b - a)));
		const envelope = shown.envelopes[index];
		const position = local * (envelope.length - 1);
		const i = Math.min(envelope.length - 2, Math.floor(position));
		const fraction = position - i;
		return envelope[i] * (1 - fraction) + envelope[i + 1] * fraction;
	};

	const segmentAt = (u) => {
		let index = 0;
		while (index < shown.cuts.length && u > shown.cuts[index].t) index += 1;
		return index;
	};

	const commit = (next, { gesture }) => {
		if (gesture) onGestureStart?.();
		onChange?.(next, { dragging: gesture });
		if (gesture) onGestureEnd?.();
	};

	const applyDrag = (at) => {
		const bounds = [{ t: 0 }, ...shown.cuts, { t: 1 }];
		const index = segmentAt(at.u);
		const a = bounds[index].t;
		const b = bounds[index + 1].t;
		const local = (at.u - a) / Math.max(1e-9, b - a);
		const radius = Math.min(0.45, 0.1 / Math.max(0.05, b - a));
		const envelopes = shown.envelopes.map((envelope, i) => (i === index ? envelopeDrag(envelope, local, at.value, radius) : envelope));
		onChange?.({ ...shown, envelopes }, { dragging: true });
		setDragPeak((peak) => Math.max(peak, at.value));
		setReadout({ x: at.takeX, value: at.value });
	};

	const onPointerDown = (event) => {
		if (event.button !== 0) return;
		const at = locate(event);
		if (!at || at.takeX > origin + span + 0.02 || at.takeX < origin - 0.02) return;
		event.preventDefault();
		try {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		} catch {
			/* an unknown pointerId must not kill the press */
		}
		// The grab starts from the curve's OWN value here, so the first pixel of
		// travel nudges the line instead of teleporting it to the cursor.
		dragRef.current = { recorded: false, start: { clientY: event.clientY, value: envelopeValueHere(at.u) } };
		setSelectedCut(null);
	};
	const onPointerMove = (event) => {
		const drag = dragRef.current;
		if (!drag) return;
		const at = locate(event);
		if (!at) return;
		if (!drag.recorded) {
			drag.recorded = true;
			onGestureStart?.();
		}
		const value = Math.max(0, dragValue(drag.start, event, yMax / DRAG_TRAVEL_PX));
		applyDrag({ ...at, value });
	};
	const onPointerUp = () => {
		const drag = dragRef.current;
		dragRef.current = null;
		setReadout(null);
		setDragPeak(0);
		if (drag?.recorded) onGestureEnd?.();
	};
	const addCutAt = (u) => {
		const next = insertCut(shown, u);
		if (next === shown || next === timing) return false;
		commit(next, { gesture: true });
		setSelectedCut(next.cuts.findIndex((cut) => Math.abs(cut.t - u) < CUT_MIN_GAP));
		return true;
	};
	const onDoubleClick = (event) => {
		const at = locate(event);
		if (!at) return;
		event.preventDefault();
		addCutAt(at.u);
	};

	// The playhead's position on the envelope's own clock — null when the
	// playhead stands outside the window the envelope shapes.
	const playheadTakeX = frameCount > 1 ? frame / (frameCount - 1) : 0;
	const playheadU = (playheadTakeX - origin) / span;
	const canCutAtPlayhead = playheadU > CUT_MIN_GAP && playheadU < 1 - CUT_MIN_GAP &&
		!shown.cuts.some((cut) => Math.abs(cut.t - playheadU) < CUT_MIN_GAP);

	useEffect(() => {
		if (selectedCut == null) return undefined;
		const onKey = (event) => {
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const next = removeCut(shown, selectedCut);
			setSelectedCut(null);
			if (next !== shown) commit(next, { gesture: true });
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	const avgY = sgY(1, yMax);
	return (
		<div className={"sg" + (bare ? " sg-bare" : "")}>
			{!bare && <header className="sg-head">
				<span className="sg-facts">{facts ?? `${averageSpeed.toFixed(1)} ${speedUnit} ${ko("average", "평균")}`}</span>
				<button
					type="button"
					className="tl-camera-tool"
					disabled={!canCutAtPlayhead}
					title={ko("Pin the instant at the playhead: the spot being walked then never moves again", "재생 위치의 순간을 고정합니다 — 그때 지나는 자리는 다시 움직이지 않습니다")}
					onClick={() => addCutAt(playheadU)}
				>
					{ko("Cut at playhead", "재생 위치에 컷")}
				</button>
				{hasCurve && (
					<button
						type="button"
						className="tl-camera-tool danger"
						title={ko("Back to constant speed — clears the curve and every cut", "등속으로 되돌립니다 — 곡선과 컷을 모두 지웁니다")}
						onClick={() => {
							setSelectedCut(null);
							commit(flatTiming(), { gesture: true });
						}}
					>
						{ko("Reset curve", "곡선 초기화")}
					</button>
				)}
			</header>}
			<div className="sg-body" title={ko("Drag the curve · double-click or the button cuts · Delete removes a cut", "곡선을 끌어 조절 · 더블클릭이나 버튼으로 컷 · 컷 선택 후 Delete로 삭제")}>
				<svg
					ref={svgRef}
					viewBox="0 0 1 1"
					preserveAspectRatio="none"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onDoubleClick={onDoubleClick}
				>
					<defs>
						<linearGradient id="sg-fade" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopOpacity="0.34" />
							<stop offset="100%" stopOpacity="0.05" />
						</linearGradient>
					</defs>
					<line className="sg-axis" x1="0" y1="1" x2="1" y2="1" />
					<line className="sg-average" x1={origin} y1={avgY} x2={origin + span} y2={avgY} />
					{origin > 0.001 && <rect className="sg-outside" x="0" y="0" width={origin} height="1" />}
					{origin + span < 0.999 && <rect className="sg-outside" x={origin + span} y="0" width={1 - origin - span} height="1" />}
					{segments.map((segment) => (
						<g key={segment.key}>
							<polygon
								className="sg-fill"
								fill="url(#sg-fade)"
								points={`${origin + segment.a * span},1 ${segment.line} ${origin + segment.b * span},1`}
							/>
							<polyline className="sg-line" points={segment.line} />
						</g>
					))}
					{shown.cuts.map((cut, index) => {
						const x = origin + cut.t * span;
						return (
							<g key={index} className={"sg-pin" + (index === selectedCut ? " selected" : "")}>
								<line className="sg-cut" x1={x} y1="0.06" x2={x} y2="1" />
								<line
									className="sg-cut-pick"
									x1={x}
									y1="0"
									x2={x}
									y2="1"
									onPointerDown={(event) => {
										event.stopPropagation();
										setSelectedCut(index === selectedCut ? null : index);
									}}
								/>
							</g>
						);
					})}
					<line className="sg-playhead" x1={playheadTakeX} y1="0" x2={playheadTakeX} y2="1" />
				</svg>
				{/* The pin heads are HTML, not SVG: the graph's 1×1 viewBox is
				    stretched to the lane, so a shape drawn inside it comes out as
				    wide as the lane is long, and a stroke on it swallowed the whole
				    graph. A positioned square keeps its size whatever the lane does. */}
				{shown.cuts.map((cut, index) => (
					<button
						key={index}
						type="button"
						className={"sg-cut-pin" + (index === selectedCut ? " selected" : "")}
						style={{ left: `${((origin + cut.t * span) * 100).toFixed(3)}%` }}
						aria-pressed={index === selectedCut}
						aria-label={ko("Cut", "컷")}
						title={ko("Cut: click to select, Delete removes it", "컷: 클릭해 선택, Delete로 삭제")}
						onPointerDown={(event) => {
							event.stopPropagation();
							event.preventDefault();
							setSelectedCut(index === selectedCut ? null : index);
						}}
					/>
				))}
				<span className="sg-scale-top">{Math.round(yMax * averageSpeed * 10) / 10}</span>
				<span className="sg-scale-avg" style={{ top: `${avgY * 100}%` }}>{averageSpeed.toFixed(1)}</span>
				<span className="sg-scale-zero">0</span>
				{readout && (
					<span className="sg-readout" style={{ left: `${readout.x * 100}%` }}>
						{(readout.value * averageSpeed).toFixed(1)} {speedUnit}
					</span>
				)}
			</div>
		</div>
	);
}

function travelSpan(path, metrics, frameCount, fps) {
	if (!path || !metrics || metrics.length <= 0) return null;
	const last = Math.max(1, frameCount - 1);
	// Speed 0 means "fill the take", which is the path's default timing.
	if (!path.speed) return { start: 0, end: last, fills: true };
	return { start: 0, end: Math.min(last, Math.round((metrics.length / path.speed) * fps)), fills: false };
}

/**
 * The selected prop's travel, drawn in the timeline's own grid.
 *
 * This REPLACES the performer's lanes rather than joining them: a prop is a
 * different subject on the same clock, and a strip that shows both makes every
 * row ask "whose?". The frame ruler and the transport above stay put, because
 * those belong to the take, not to any one subject.
 */
function ObjectTravelTrack({ object, frame, frameCount, fps, pathDraw, onPathDrawToggle, onPathChange, onPathClear, onTimingGestureStart, onTimingGestureEnd, markIndex = null, onMarkAdd, onMarkLean, onMarkScrubStart, onMarkScrubEnd }) {
	const path = object?.path ?? null;
	const metrics = useMemo(() => (path ? pathMetrics(path) : null), [path]);
	const span = useMemo(() => travelSpan(path, metrics, frameCount, fps), [path, metrics, frameCount, fps]);
	const patch = (change) => onPathChange?.({ ...path, ...change });
	const seconds = span ? (span.end - span.start) / Math.max(1, fps) : 0;
	// The dot under the playhead: where on the route the prop is this frame.
	// Null when the route is full or the prop is standing on a dot or an end.
	const playheadMark = useMemo(() => {
		if (!path) return null;
		const progress = pathProgressAt(path, frame, { frameCount, fps });
		return progress == null ? null : insertPathMark(path, progress);
	}, [path, frame, frameCount, fps]);
	const marks = useMemo(() => (path ? pathMarks(path) : []), [path]);
	const selectedMark = markIndex != null && markIndex > 0 && markIndex <= marks.length ? marks[markIndex - 1] : null;
	return (
		<>
			<div className="tl-track objmo">
				<span className="tl-track-label">
					<span className="tl-subject-kind">{ko("PROP", "소품")}</span>
					<span className="objmo-name">{object.name}</span>
				</span>
				<div className="tl-lane objmo-tools">
					<button
						type="button"
						className={"tl-camera-tool" + (pathDraw ? " active" : "")}
						onClick={() => onPathDrawToggle?.()}
					>
						{pathDraw ? ko("Drawing…", "그리는 중…") : path ? ko("Redraw path", "경로 다시 그리기") : ko("Draw path", "경로 그리기")}
					</button>
					{path ? (
						<>
							<span className="objmo-speed" title={ko("Metres per second; 0 spreads the route across the whole take", "초당 미터; 0이면 전체 길이에 맞춰 이동합니다")}>
								<span>{ko("Speed", "속도")}</span>
								<input
									type="range"
									min={0}
									max={20}
									step={0.1}
									aria-label={ko("Travel speed", "이동 속도")}
									value={path.speed ?? 0}
									onChange={(event) => patch({ speed: Number(event.currentTarget.value) })}
								/>
								<output className="objmo-speed-value">
									{(path.speed ?? 0) === 0 ? ko("fills take", "전체") : `${Number(path.speed).toFixed(1)} m/s`}
								</output>
							</span>
							<button
								type="button"
								className={"tl-camera-tool" + (path.faceTravel ? " active" : "")}
								aria-pressed={!!path.faceTravel}
								title={ko("Turn to face the direction of travel", "진행 방향을 바라보게 합니다")}
								onClick={() => patch({ faceTravel: !path.faceTravel })}
							>
								{path.faceTravel ? ko("Faces travel", "진행 방향 봄") : ko("Fixed facing", "방향 고정")}
							</button>
							<button
								type="button"
								className={"tl-camera-tool" + (path.extend ? " active" : "")}
								aria-pressed={!!path.extend}
								title={ko("Keep going in the last direction after the route ends", "경로가 끝나도 마지막 방향으로 계속 갑니다")}
								onClick={() => patch({ extend: !path.extend })}
							>
								{ko("Keep going", "계속 가기")}
							</button>
							<button
								type="button"
								className={"tl-camera-tool" + (path.loop ? " active" : "")}
								aria-pressed={!!path.loop}
								onClick={() => patch({ loop: !path.loop })}
							>
								{ko("Loop", "반복")}
							</button>
							{/* Destructive, so it sits apart at the row's end and only
							    turns red under the pointer. */}
							<button
								type="button"
								className="tl-camera-tool danger objmo-end"
								title={ko("Delete this route; the object stands still again", "경로를 지웁니다. 오브젝트는 다시 제자리에 섭니다")}
								onClick={() => onPathClear?.()}
							>
								{ko("Delete path", "경로 삭제")}
							</button>
						</>
					) : (
						<span className="tl-path-hint">
							{ko("Draw a route on the Top-View map to make this prop travel.", "위에서 본 지도에 경로를 그리면 이 소품이 이동합니다.")}
						</span>
					)}
				</div>
			</div>
			{path && (
				<div className="tl-track objmo objmo-dots">
					<span className="tl-track-label">{ko("Dots", "점")}</span>
					<div className="tl-lane objmo-tools">
						<button
							type="button"
							className="tl-camera-tool"
							data-testid="route-add-dot"
							disabled={!playheadMark}
							title={playheadMark
								? ko("Add a dot where the prop is on this frame", "지금 프레임에서 소품이 있는 곳에 점을 추가합니다")
								: ko("No room for a dot here: the route is full, or the playhead is on a dot or an end", "여기엔 점을 추가할 수 없어요: 경로가 가득 찼거나, 재생 위치가 점이나 끝에 있어요")}
							onClick={() => playheadMark && onMarkAdd?.(playheadMark.marks[playheadMark.index - 1].t)}
						>
							{ko("+ Dot", "+ 점")}
						</button>
						<span className="objmo-lean" data-testid="route-lean-fields" title={selectedMark ? undefined : ko("Ends are always level; select a dot between them to lean the prop there", "양 끝은 항상 수평이에요. 사이의 점을 선택하면 그 지점에서 기울일 수 있어요")}>
							<NumberField
								label={ko("Bank", "기울기")}
								title={ko("Roll about the direction of travel; positive leans onto the right side", "진행 방향을 축으로 한 기울기; 양수는 오른쪽이 내려갑니다")}
								value={selectedMark ? selectedMark.bank : 0}
								step={1}
								precision={1}
								scrubRange={MAX_PATH_LEAN}
								disabled={!selectedMark}
								onChange={(value, token) => onMarkLean?.("bank", value, token)}
								onScrubStart={onMarkScrubStart}
								onScrubEnd={onMarkScrubEnd}
							/>
							<NumberField
								label={ko("Pitch", "피치")}
								title={ko("Nose up (positive) or down; the prop holds this angle at the dot", "코가 위(양수) 또는 아래로 향하는 각도; 이 점에서 이 각도를 유지합니다")}
								value={selectedMark ? selectedMark.pitch : 0}
								step={1}
								precision={1}
								scrubRange={MAX_PATH_LEAN}
								disabled={!selectedMark}
								onChange={(value, token) => onMarkLean?.("pitch", value, token)}
								onScrubStart={onMarkScrubStart}
								onScrubEnd={onMarkScrubEnd}
							/>
						</span>
						{/* One short status, muted: the long form is in the tooltips. */}
						<span className="tl-path-hint">
							{selectedMark
								? ko("Eases back to level at the next dot · E shows rings on the dot", "다음 점에서 수평으로 돌아와요 · E 키로 점에 회전 링")
								: markIndex === 0 || (markIndex != null && markIndex === marks.length + 1)
									? ko("Ends stay level", "양 끝은 수평")
									: ko("Select a dot to lean the prop there", "점을 선택하면 그 지점에서 기울기")}
						</span>
					</div>
				</div>
			)}
			{path && span && (
				<div className="tl-track objmo sg-row">
					<span className="tl-track-label">{ko("Speed", "속도 곡선")}</span>
					<div className="tl-lane sg-lane">
						<SpeedGraph
							facts={metrics && span ? `${metrics.length.toFixed(1)} m · ${seconds.toFixed(1)}${ko("s", "초", "秒")}` : null}
							timing={path.timing ?? null}
							windowFrac={span.fills ? 1 : span.end / Math.max(1, frameCount - 1)}
							frame={frame}
							frameCount={frameCount}
							averageSpeed={metrics && span ? metrics.length / Math.max(1 / fps, (span.end - span.start) / fps) : 1}
							onChange={(timing) => onPathChange?.({ ...path, timing: timingIsFlat(timing) ? null : timing })}
							onGestureStart={onTimingGestureStart}
							onGestureEnd={onTimingGestureEnd}
						/>
					</div>
				</div>
			)}
		</>
	);
}

function CameraBlockEditor({
	shot,
	blocked,
	previewing,
	railDraw,
	railLength, fps = 24,
	craneSelectedIndex = null,
	// The Shot box draws the curve; this bar owns everything you DO to it.
	curve = null,
	onChange,
	onPreview,
	onRailDrawToggle,
	onRailDelete,
	onCranePointDelete,
	onWaypointToggle,
}) {
	if (!shot) return null;
	const mode = cameraBlockMode(shot);
	const follow = cameraBlockFollow(shot);
	// The crane is always on for a rail (camera-block.js normalizes a stored
	// null to the flat profile), so a missing value only means "not rail yet".
	const crane = shot?.camera?.craneHeight
		?? (mode === "rail" && shot?.camera?.cameraRail
			? { points: [{ t: 0, height: follow.height }, { t: 1, height: follow.height }] }
			: null);
	const patchCamera = (patch) => onChange?.(patch);
	const patchFollow = (patch) => onChange?.({ followCam: { ...follow, ...patch } }); const railFrames = shot.camera?.railFollow?.mode === "range" ? shot.camera.railFollow.endFrame - shot.camera.railFollow.startFrame : shot.endFrame - shot.startFrame; const speedLimit = mode === "rail" && railLength != null && railFrames > 0 ? Math.max(0.2, Math.ceil((railLength / (railFrames / fps)) * 10) / 10) : WORLD.dollySpeed; // the rail is ridden on the shot clock, so faster than length / time is never reached
	const numberValue = (event) => Number(event.currentTarget.value);
	const metric = (value, places = 1) => Number(value).toFixed(places);
	return (
		<section className="tl-camera-editor" aria-label={ko(`Camera controls for ${shot.name}`, `${shot.name} 카메라 컨트롤`, `${shot.name} 的摄影机控制`)}>
			<strong className="tl-camera-editor-title">
				<span className="tl-subject-kind">{ko("CAMERA", "카메라")}</span>
				{shot.name}
			</strong>
			{blocked ? (
				<span className="tl-camera-blocked">
					{ko("Turn Waypoint off to edit or preview this camera.", "카메라를 편집하거나 미리 보려면 Waypoint를 꺼주세요.")}
					<button type="button" className="tl-camera-tool" onClick={() => onWaypointToggle?.()}>
						{ko("Turn Waypoint off", "Waypoint 끄기")}
					</button>
				</span>
			) : (
				<>
					<button type="button" className={"tl-camera-tool" + (previewing ? " active" : "")} onClick={() => onPreview?.()}>
						{previewing ? ko("Stop", "정지") : ko("Preview", "미리보기")}
					</button>
					<button type="button" className={"tl-camera-tool tl-rail-draw" + (railDraw ? " active" : "")} onClick={() => onRailDrawToggle?.()}>
						{railDraw ? ko("Drawing…", "그리는 중…") : railLength != null ? ko("Redraw rail", "레일 다시 그리기") : ko("Draw rail", "레일 그리기")}
					</button>

					{curve && (
						<span className="cam-mode-switch" role="group" aria-label={ko("Shot curve", "샷 곡선")}>
							<button
								type="button"
								className={"tl-camera-tool" + (curve.mode === "speed" ? " active" : "")}
								aria-pressed={curve.mode === "speed"}
								title={ko("Draw dolly speed in the Shot box", "샷 박스에 돌리 속도를 그립니다")}
								onClick={() => curve.onModeChange?.("speed")}
							>
								{ko("Speed", "속도")}
							</button>
							<button
								type="button"
								className={"tl-camera-tool" + (curve.mode === "height" ? " active" : "")}
								aria-pressed={curve.mode === "height"}
								disabled={!curve.hasCrane}
								title={ko("Draw crane height in the Shot box", "샷 박스에 크레인 높이를 그립니다")}
								onClick={() => curve.onModeChange?.("height")}
							>
								{ko("Height", "높이")}
							</button>
						</span>
					)}
					{curve && curve.mode === "speed" && (curve.canCut || curve.canReset) && (
						<>
							{curve.canCut && <button
								type="button"
								className="tl-camera-tool"
								title={ko("Pin the instant at the playhead: the spot being passed then never moves again", "재생 위치의 순간을 고정합니다 — 그때 지나는 자리는 다시 움직이지 않습니다")}
								onClick={() => curve.onCut?.()}
							>
								{ko("Cut", "컷")}
							</button>}
							{curve.canReset && <button
								type="button"
								className="tl-camera-tool danger"
								title={ko("Back to constant speed — clears the curve and every cut", "등속으로 되돌립니다 — 곡선과 컷을 모두 지웁니다")}
								onClick={() => curve.onReset?.()}
							>
								{ko("Reset curve", "곡선 초기화")}
							</button>}
						</>
					)}

					<label title={ko("Read automatically from the camera position", "현재 카메라 위치에서 자동으로 읽습니다")}>
						<span>{ko("Distance", "거리")}</span>
						<output className="tl-camera-metric">{metric(follow.distance, 2)}</output>
						<small>m</small>
					</label>
					<label title={speedLimit < WORLD.dollySpeed ? ko(`Dolly speed cap, up to ${speedLimit} m/s: the rail is ridden in the shot's time, so it never goes faster. Shorten the shot to go faster.`, `돌리 최고 속도, 최대 ${speedLimit} m/s: 레일은 샷 시간 안에 지나가므로 이보다 빨라지지 않아요. 더 빠르게 하려면 샷을 줄이세요.`, `推轨速度上限，最高 ${speedLimit} m/s：轨道在镜头时长内走完，因此不会更快。要更快请缩短镜头。`) : ko("Cap dolly travel speed", "돌리의 최고 이동 속도를 제한합니다")}>
						<span>{ko("Speed", "속도")}</span>
						<input type="number" min="0.2" max={speedLimit} step="0.1" value={Math.min(follow.maxDollySpeed, speedLimit)} onChange={(event) => patchFollow({ maxDollySpeed: Math.min(speedLimit, numberValue(event)) })} />{speedLimit < WORLD.dollySpeed && <em className="tl-camera-limit" data-testid="camera-speed-limit">/ {speedLimit}</em>}
						<small>m/s</small>
					</label>
					{!(mode === "rail" && crane) && (
						<label title={ko("Read automatically from the camera position", "현재 카메라 위치에서 자동으로 읽습니다")}>
							<span>{ko("Height", "높이")}</span>
							<output className="tl-camera-metric">{metric(follow.height, 2)}</output>
							<small>m</small>
						</label>
					)}
					<label title={ko("Read automatically from the camera tilt", "현재 카메라 틸트에서 자동으로 읽습니다")}>
						<span>{ko("Pitch", "피치")}</span>
						<output className="tl-camera-metric">{signedValue(follow.pitchOffsetDeg)}</output>
						<small>°</small>
					</label>
					{mode === "rail" && crane && (() => {
						const points = crane.points;
						const index = craneSelectedIndex != null && craneSelectedIndex >= 0 && craneSelectedIndex < points.length ? craneSelectedIndex : points.length - 1;
						const patchPointHeight = (height) => {
							const next = points.map((point, i) => (i === index ? { ...point, height } : point));
							patchCamera({ craneHeight: { points: next } });
						};
						return (
							<>
								<label title={ko("Lens height of the selected crane point — click a purple dot in the scene to pick one, double-click the lifted curve to add one", "선택한 크레인 점의 렌즈 높이 — 씬의 보라 점을 클릭해 선택, 커브 더블클릭으로 추가")}>
									<span>{ko("Point height", "점 높이")}</span>
									<input type="number" min="0.1" max="12" step="0.1" value={points[index].height} onChange={(event) => patchPointHeight(numberValue(event))} />
									<small>m</small>
								</label>
								<output className="tl-camera-count" title={ko("Crane points on this rail — click the Shot block's key strip to add one", "이 레일의 크레인 점 개수 — 샷 블록 키 줄을 클릭해 추가")}>{points.length}{ko(" pts", "점")}</output>
								{/* Only while a removable point is actually held: a button that
								    is greyed out nine times in ten is just furniture. */}
								{curve?.mode === "height" && craneSelectedIndex != null && craneSelectedIndex > 0 && craneSelectedIndex < points.length - 1 && (
									<button
										type="button"
										className="tl-camera-tool danger"
										title={ko("Remove the selected interior crane point", "선택한 중간 크레인 점을 삭제합니다")}
										onClick={() => onCranePointDelete?.()}
									>
										{ko("Remove point", "점 삭제")}
									</button>
								)}
							</>
						);
					})()}
					<details className="tl-camera-advanced">
						<summary>{ko("Advanced", "고급")}</summary>
						{/* Rig behaviour you set once per shot and forget: it belongs where
						    the other set-once numbers already live, not in the row you
						    reach across every time you shape a curve. */}
						{railLength != null && (
							<button
								type="button"
								className="tl-camera-tool danger"
								title={ko("Delete this Shot's rail geometry and return to Follow", "이 샷의 레일 경로를 삭제하고 팔로우로 돌아갑니다")}
								onClick={() => onRailDelete?.()}
							>
								{ko("Delete rail", "레일 삭제")}
							</button>
						)}
						<button
							type="button"
							className={"tl-camera-tool" + (mode === "follow" ? " active" : "")}
							aria-pressed={mode === "follow"}
							title={ko("Keep the camera at the captured distance from the subject", "카메라와 피사체 사이의 현재 거리를 유지합니다")}
							onClick={() => patchCamera({ mode: mode === "follow" ? "keys" : "follow" })}
						>
							{mode === "follow" ? ko("Follow On", "팔로우 켜짐") : ko("Follow Off", "팔로우 꺼짐")}
						</button>
						<button
							type="button"
							className={"tl-camera-head" + (follow.railStartMode === "head" ? " active" : "")}
							aria-pressed={follow.railStartMode === "head"}
							title={ko("Choose whether the dolly starts at the rail head or the nearest useful point", "돌리가 레일 시작점 또는 가까운 지점에서 출발하도록 정합니다")}
							onClick={() => patchFollow({ railStartMode: follow.railStartMode === "head" ? "nearest" : "head" })}
						>
							{follow.railStartMode === "head" ? ko("Head start", "시작점 출발") : ko("Nearest", "가까운 지점")}
						</button>
						<label title={ko("Set how softly the rig catches up", "카메라가 얼마나 부드럽게 따라붙는지 정합니다")}>
							<span>{ko("Damping", "댐핑")}</span>
							<input type="number" min="0.1" max="3" step="0.05" value={follow.response} onChange={(event) => patchFollow({ response: numberValue(event) })} />
							<small>s</small>
						</label>
						<label title={ko("Aim ahead of subject travel", "피사체 진행 방향을 미리 조준합니다")}>
							<span>{ko("Look-ahead", "조준 선행")}</span>
							<input type="number" min="0" max="1" step="0.05" value={follow.lead} onChange={(event) => patchFollow({ lead: numberValue(event) })} />
							<small>s</small>
						</label>
					</details>
					<span className="tl-camera-slate">
						{mode === "rail" ? `${ko("Dolly on rail", "레일 돌리")}${railLength == null ? "" : ` · ${railLength.toFixed(1)} m`}` : ko("Camera preview", "카메라 미리보기")}
					</span>
				</>
			)}
		</section>
	);
}

export default function Timeline({
	frame,
	frameCount = DEFAULT_FRAME_COUNT,
	fps = DEFAULT_FPS,
	playbackSpeed = 1,
	playing,
	// Which cast member's animation layer these tracks edit ("S2", …).
	trackOwner = null,
	// Read-only previews of the OTHER cast members' layers: their root pins
	// render dimmed with an owner chip, so the whole cast's schedule is
	// visible while only the active layer is editable.
	ghostLayers = [], // [{ owner, waypointFrames: [] }]
	waypointMode,
	// Which department the studio is in ("scene" | "camera" | "motion"). The
	// camera-cut tools (Cut, Draw rail, + Track) belong to Scene and Camera.
	// The Root path (Waypoint) toggle stays in every mode: blocking uses it to
	// stage where a subject walks.
	workflowMode = "motion",
	waypoints = [],
	pathSpeed = null, // { min, max, warn } in m/s, shown on the 2D Root label
		badge,
	pendingWaypointFrame = null,
	ikMode = false,
	ikDisabled = false, // a loaded motion owns the rig
	// The ACTIVE cast member's loaded take, drawn as a passive strip on the
	// Full-Body lane. Frames are already on the timeline's 24 fps clock.
	motion = null, // { frames, label, segments, cut, speed, remove, trim, reset } (take-segments.jsx timelineTake) | null
	ikFrames = [], // sorted full-body key frames
	rangePins = [], // active character's inclusive pin ranges
	previewRanges = [], // amber preview spans shown under the Body track
	selectedPinId = null,
	pendingPinRange = null,
	footSnap = true, // feet stay planted while the body moves
	bodyContact = true, // body markers stay above the floor
	shots = [],
	// The stage's delivery aspect label ("16:9", "9:16", …). A shot aimed at a
	// video model is checked against it, so the badge can say when the cut
	// leaves the target's supported ratios.
	shotAspect = null,
	activeShotIdx = 0,
	selectedCameraBlockIdx,
	shotCutDisabled = false,
	onScrub,
	onAdvance,
	onStep,
	onPlayToggle,
	onWaypointToggle,
	onMarkerSelect,
	onMarkerRemove,
	onRootKeyframeAdd,
	
	onClearMotion,
	onIkKeyframeAdd,
	onIkKeyframeRemove,
	onIkKeyframeMove,
	onPinSelect,
	onFootSnapToggle,
	onBodyContactToggle,
	onCameraMoveSelect,
	onCameraKeyframeAdd,
	onCameraKeyframeMove,
	onCameraKeyframeRemove,
	onCameraBlockSelect,
	onCameraBlockChange,
	onCameraPreview,
	railDraw = false,
	pathDraw = false,
	pathObject = null,
	craneSelectedIndex = null,
	// A camera bar over a prop or a character is ten controls for a thing you
	// are not editing; the bar belongs to the camera's own selection.
	cameraSelected = true,
	onCranePointAdd,
	onCranePointDelete,
	onCranePointSelect,
	cameraRailLength = null,
	onCameraRailDrawToggle,
	onObjectPathDrawToggle,
	onObjectPathChange,
	onObjectPathClear,
	onObjectTimingGestureStart,
	onObjectTimingGestureEnd,
	objectPathPointIndex = null,
	onObjectMarkAdd,
	onObjectMarkLean,
	onObjectMarkScrubStart,
	onObjectMarkScrubEnd,
	onCameraRailDelete,
	onShotSelect,
	onShotBoundaryMove,
	onShotRename,
	onShotRemove,
	onShotDuplicate,
	onShotCut,
	onShotSplit,
	onShotMove,
	
	// One undo entry per editing GESTURE. Fired once when a continuous drag
	// (or a keyboard nudge, or a text-editing session) begins, BEFORE the
	// first mutation lands, so App can snapshot the pre-gesture state exactly
	// once instead of once per pointermove tick.
	onEditGestureStart,
}) {
	const [expanded, setExpanded] = useState(true);
	const [zoom, setZoom] = useState(ZOOM_DEFAULT);
	
	const [renamingShotId, setRenamingShotId] = useState(null);
	const [movingShotId, setMovingShotId] = useState(null);
	const [localCameraBlockIdx, setLocalCameraBlockIdx] = useState(null);
	const rulerRef = useRef(null);
	const bodyRef = useRef(null);
	const scrubbing = useRef(false);
	// Wheel zoom is driven by the pointer's live gesture: zoomRef tracks the
	// intended zoom synchronously between renders, renderedRef the zoom that
	// is actually in the DOM, and pendingScrollRef the scrollLeft to apply
	// right after the next render so the frame under the pointer stays put.
	const zoomRef = useRef(ZOOM_DEFAULT);
	const renderedRef = useRef(ZOOM_DEFAULT);
	const pendingScrollRef = useRef(null);
	// The window key/interval handlers register once; the latest callbacks
	// are read through a ref so they never go stale mid-playback.
	const handlers = useRef({});
	handlers.current = { onScrub, onAdvance, onStep, onPlayToggle, onWaypointToggle, onMarkerSelect, onMarkerRemove, onRootKeyframeAdd, onIkKeyframeAdd, onIkKeyframeRemove, onIkKeyframeMove, onPinSelect, onFootSnapToggle, onBodyContactToggle, onCameraMoveSelect, onCameraKeyframeAdd, onCameraKeyframeMove, onCameraKeyframeRemove, onCameraBlockSelect, onCameraBlockChange, onCameraPreview, onCameraRailDrawToggle, onCameraRailDelete, onObjectPathDrawToggle, onObjectPathChange, onObjectPathClear, onObjectTimingGestureStart, onObjectTimingGestureEnd, onObjectMarkAdd, onObjectMarkLean, onObjectMarkScrubStart, onObjectMarkScrubEnd, onShotSelect, onShotBoundaryMove, onShotRename, onShotRemove, onShotDuplicate, onShotCut, onShotSplit, onShotMove, onEditGestureStart };

	// Trackpad/wheel zoom over the FRAME ruler lane only. React registers
	// onWheel as passive, so a synthetic onWheel could never preventDefault —
	// attach a real non-passive listener instead, so a vertical gesture over
	// the ruler zooms the timeline instead of scrolling the page. Under Mac
	// natural scrolling the signed delta follows the physical gesture: two
	// fingers up (deltaY > 0) zooms IN, two fingers down (deltaY < 0) zooms
	// OUT. Horizontal swipes (deltaY === 0) are left alone so they scroll the
	// zoomed surface natively within .tl-body.
	useEffect(() => {
		const el = rulerRef.current;
		if (!el) return;
		let acc = 0;
		const onWheel = (e) => {
			if (e.deltaY === 0) return;
			e.preventDefault();
			const dy =
				e.deltaMode === 1 ? (e.deltaY * WHEEL_STEP_PX) / 3 : e.deltaMode === 2 ? e.deltaY * WHEEL_STEP_PX * 8 : e.deltaY;
			acc += dy;
			let steps = Math.trunc(acc / WHEEL_STEP_PX);
			steps = Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, steps));
			acc -= steps * WHEEL_STEP_PX;
			if (steps === 0) return;
			const zR = renderedRef.current;
			const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + steps * ZOOM_STEP));
			if (z1 === zR) return;
			zoomRef.current = z1;
			setZoom(z1);
			// Keep the frame under the pointer anchored. `dx` already includes
			// the sticky label offset and the body's current horizontal scroll,
			// so only add the extra scaled distance.
			const body = bodyRef.current;
			const lane = rulerRef.current;
			if (!body || !lane) return;
			const rect = lane.getBoundingClientRect();
			if (rect.width <= 0) return;
			const dx = e.clientX - rect.left;
			const labelW = parseFloat(getComputedStyle(body).getPropertyValue("--tl-label-w")) || 148;
			const surfaceR = Math.max(ZOOM_DEFAULT, zR);
			const surface1 = Math.max(ZOOM_DEFAULT, z1);
			const maxScroll = Math.max(0, labelW + (rect.width / surfaceR) * surface1 - body.clientWidth);
			const target = body.scrollLeft + dx * (surface1 / surfaceR - 1);
			pendingScrollRef.current = Math.max(0, Math.min(target, maxScroll));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
		// The ruler lane unmounts when the timeline collapses, so re-attach
		// whenever it comes back; zoom state itself lives on in the component.
	}, [expanded]);

	// Commit the gesture's scroll anchor right after the zoomed layout lands,
	// before paint — otherwise the surface would snap back to frame 0.
	useLayoutEffect(() => {
		renderedRef.current = zoom;
		if (pendingScrollRef.current == null) return;
		const body = bodyRef.current;
		if (body) {
			const max = Math.max(0, body.scrollWidth - body.clientWidth);
			body.scrollLeft = Math.max(0, Math.min(pendingScrollRef.current, max));
		}
		pendingScrollRef.current = null;
	}, [zoom]);

	function resetZoom() {
		if (renderedRef.current === ZOOM_DEFAULT && zoomRef.current === ZOOM_DEFAULT) return;
		zoomRef.current = ZOOM_DEFAULT;
		setZoom(ZOOM_DEFAULT);
		pendingScrollRef.current = 0; // at 1× the surface fits exactly: no scroll
	}

	// Rendering can delay timers. Advance by elapsed presentation time rather
	// than one frame per callback, otherwise a 24fps take becomes slow motion.
	useEffect(() => {
		if (!playing) return;
		const elapsedFrames = createPlaybackClock(fps, playbackSpeed, performance.now());
		// playback:summary: steps > 1 is a late tick (an estimate of dropped frames, not a measured one).
		const run = startPlaybackRun(fps, playbackSpeed);
		const id = window.setInterval(
			() => {
				const steps = elapsedFrames(performance.now());
				run.tick(steps);
				if (steps) handlers.current.onAdvance?.(steps);
			},
			1000 / Math.max(1, fps * playbackSpeed),
		);
		return () => { window.clearInterval(id); run.end(); };
	}, [playing, fps, playbackSpeed]);

	// Space toggles playback, j/k step the playhead, p toggles waypoint mode —
	// but only when focus is outside interactive native controls: a focused
	// input/select owns its keys, and Space on a focused button would trigger
	// the button's native activation on top of the global toggle. Focus on
	// the body or canvas keeps the shortcuts live.
	useEffect(() => {
		function onKey(e) {
			const el = document.activeElement;
			const interactive =
				el &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.tagName === "SELECT" ||
					el.tagName === "BUTTON" ||
					el.isContentEditable);
			if (interactive) return;
			// Physical key codes, not characters — Hangul IME turns j/k/p into
			// ㅓ/ㅔ/ㅔ and the shortcuts would go dead (same fix as FlyControls).
			// Space and P are toggles — ignore OS key-repeat so a held key
			// cannot flap playback or waypoint mode; j/k keep stepping.
			if (e.repeat && (e.code === "Space" || e.code === "KeyP")) return;
			const h = handlers.current;
			if (e.code === "Space") {
				e.preventDefault();
				h.onPlayToggle?.();
			} else if (e.code === "KeyJ") {
				h.onStep?.(1);
			} else if (e.code === "KeyK") {
				h.onStep?.(-1);
			} else if (e.code === "KeyP") {
				h.onWaypointToggle?.();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Below 1× the surface still fills the viewport; the ruler exposes a wider
	// virtual frame range instead of physically shrinking into the left edge.
	const displayFrameCount = zoom < ZOOM_DEFAULT ? Math.ceil(frameCount / zoom) : frameCount;
	const surfaceZoom = Math.max(ZOOM_DEFAULT, zoom);
	const labelStep = LABEL_STEPS.find((s) => (displayFrameCount - 1) / s <= MAX_LABELS) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
	const labels = useMemo(() => {
		const out = [];
		for (let f = 0; f < displayFrameCount; f += labelStep) out.push(f);
		return out;
	}, [displayFrameCount, labelStep]);
	// Lane gridlines ride the same 10-frame cadence and the same framePct as
	// the ruler ticks, so lines and labels can never drift apart at any zoom.
	const gridFrames = useMemo(() => {
		const out = [];
		for (let f = 0; f < displayFrameCount; f += GRID_STEP_FRAMES) out.push(f);
		return out;
	}, [displayFrameCount]);
	// Chips clamp into the surface; markers use framePct directly. One scale
	// for everything — the old /count chip scale drifted off the gridlines.
	const clipPct = (value) => Math.max(0, Math.min(1, framePct(value, displayFrameCount)));
	const waypointFrames = waypoints.map((waypoint) => waypoint.frame);
	// A baked correction keys EVERY frame of its span, so
	// the raw list draws a wall of diamonds. Collapse consecutive frames into
	// runs first; only runs shorter than KEY_RUN_MIN stay diamonds.
	const ikParts = useIkParts(displayFrameCount), ikRuns = useMemo(() => groupKeyRuns(ikParts.hidden.size ? ikFrames.filter((f) => !ikParts.hidden.has(f)) : ikFrames), [ikFrames, ikParts.hidden]); // ikParts: keys by body part (TimelineFixIslands.jsx); a frame of rest keys only draws no summary dot
	const pinBands = useMemo(() => rangePins.map((pin) => ({
		pin,
		geometry: rangePinBandGeometry(pin, frameCount, displayFrameCount),
	})).filter((entry) => entry.geometry), [displayFrameCount, frameCount, rangePins]);
		const camDragRef = useRef(null);
	const ikDragRef = useRef(null);
	const camSuppressClickRef = useRef(false);
	const shotBoundaryRef = useRef(null);
	const shotMoveRef = useRef(null);
	const shotSuppressClickRef = useRef(false);

	// Camera key dots re-time by dragging: the frame
	// delta comes from the pointer-down geometry so a growing timeline cannot
	// feed back into the next pointermove.
	function beginCameraKeyDrag(e, key, shotIndex) {
		if (e.button !== 0) return;
		e.stopPropagation();
		selectUnifiedShotBlock(shotIndex);
		// A 10px dot loses the pointer almost immediately without capture —
		// grab it on pointerdown so the drag survives past the marker's edge.
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		camDragRef.current = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			keyId: key.id,
			fromFrame: key.frame,
			shotId: shots[shotIndex]?.id,
			currentFrame: key.frame,
			laneWidth: rect?.width ?? 1,
			displayFrameCount,
			moved: false,
		};
		handlers.current.onEditGestureStart?.("camera-key");
	}

	function moveCameraKeyDrag(e) {
		const active = camDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moved) {
			if (Math.abs(e.clientX - active.startClientX) < 4) return;
			active.moved = true;
		}
		e.preventDefault();
		e.stopPropagation();
		const framesPerPixel = Math.max(0, active.displayFrameCount - 1) / Math.max(1, active.laneWidth);
		const raw = active.fromFrame + (e.clientX - active.startClientX) * framesPerPixel;
		const next = Math.max(0, Math.min(frameCount - 1, Math.round(raw)));
		if (next === active.currentFrame) return;
		const from = active.currentFrame;
		active.currentFrame = next;
		handlers.current.onCameraKeyframeMove?.(active.shotId, active.keyId, from, next);
	}

	function endCameraKeyDrag(e) {
		const active = camDragRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moved) {
			e.preventDefault();
			e.stopPropagation();
			camSuppressClickRef.current = true;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
			queueMicrotask(() => { camSuppressClickRef.current = false; });
		}
		camDragRef.current = null;
	}

	function beginIkKeyDrag(event, fromFrame) {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		const rect = event.currentTarget.closest('.tl-lane')?.getBoundingClientRect();
		ikDragRef.current = { pointerId: event.pointerId, startClientX: event.clientX, fromFrame, currentFrame: fromFrame,
			laneWidth: rect?.width ?? 1, displayFrameCount, moved: false };
		handlers.current.onEditGestureStart?.('ik-key');
	}
	function moveIkKeyDrag(event) {
		const active = ikDragRef.current;
		if (!active || event.pointerId !== active.pointerId) return;
		if (!active.moved && Math.abs(event.clientX - active.startClientX) < 1) return;
		active.moved = true; event.preventDefault(); event.stopPropagation();
		const framesPerPixel = Math.max(0, active.displayFrameCount - 1) / Math.max(1, active.laneWidth);
		const next = Math.max(0, Math.min(frameCount - 1, Math.round(active.fromFrame + (event.clientX - active.startClientX) * framesPerPixel)));
		if (next === active.currentFrame) return;
		const from = active.currentFrame, moved = handlers.current.onIkKeyframeMove?.(from, next);
		if (moved !== false) active.currentFrame = next;
	}
	function endIkKeyDrag(event) {
		const active = ikDragRef.current;
		if (!active || event.pointerId !== active.pointerId) return;
		if (active.moved) { event.preventDefault(); event.stopPropagation(); }
		else handlers.current.onScrub?.(active.fromFrame);
		if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		ikDragRef.current = null;
	}

	function onCameraKeyClick(e, key, shotIndex) {
		if (camSuppressClickRef.current) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		e.stopPropagation();
		selectUnifiedShotBlock(shotIndex);
		handlers.current.onScrub?.(key.frame);
	}








	function beginShotBoundaryDrag(e, shotIndex, edge) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		shotBoundaryRef.current = { shotId: shots[shotIndex]?.id, edge, pointerId: e.pointerId, left: rect?.left ?? 0, width: rect?.width ?? 1, displayFrameCount };
		handlers.current.onEditGestureStart?.("shot-boundary");
	}

	function moveShotBoundary(e) {
		const active = shotBoundaryRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const ratio = (e.clientX - active.left) / Math.max(1, active.width);
		const rawFrame = Math.round(ratio * Math.max(0, active.displayFrameCount - 1));
		handlers.current.onShotBoundaryMove?.(active.shotId, active.edge, Math.max(0, Math.min(frameCount - 1, rawFrame)));
	}

	function endShotBoundaryDrag(e) {
		const active = shotBoundaryRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		shotBoundaryRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function beginShotMove(e, shot, index) {
		if (e.button !== 0 || e.target.closest("button, input")) return;
		const lane = e.currentTarget.closest(".tl-lane");
		const rect = lane?.getBoundingClientRect();
		shotMoveRef.current = { id: shot.id, pointerId: e.pointerId, startClientX: e.clientX, left: rect?.left ?? 0, width: rect?.width ?? 1, targetFrame: shot.startFrame, moved: false };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	}

	function moveShot(e) {
		const active = shotMoveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (!active.moved && Math.abs(e.clientX - active.startClientX) < 4) return;
		active.moved = true;
		active.targetFrame = frameFromClientX(e.clientX, active.left, active.width, displayFrameCount, frameCount);
		setMovingShotId(active.id);
		e.preventDefault();
		e.stopPropagation();
	}

	function endShotMove(e) {
		const active = shotMoveRef.current;
		if (!active || e.pointerId !== active.pointerId) return;
		if (active.moved) {
			e.preventDefault();
			e.stopPropagation();
			shotSuppressClickRef.current = true;
			handlers.current.onShotMove?.(active.id, active.targetFrame);
			queueMicrotask(() => { shotSuppressClickRef.current = false; });
		}
		shotMoveRef.current = null;
		setMovingShotId(null);
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	}

	function selectUnifiedShotBlock(index) {
		if (shotSuppressClickRef.current) return;
		const shot = shots[index];
		if (!shot) return;
		setLocalCameraBlockIdx(index);
		handlers.current.onCameraBlockSelect?.(shot.id);
		handlers.current.onShotSelect?.(shot.id);
		if (!handlers.current.onShotSelect) handlers.current.onScrub?.(shot.startFrame);
		handlers.current.onCameraMoveSelect?.();
	}

	function addShotPointFromBlock(e, shot, index) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const keySurface = e.currentTarget.closest(".tl-shot-key-surface");
		if (!keySurface) return;
		selectUnifiedShotBlock(index);
		if (shot.camera?.mode === "rail" && shot.camera?.craneHeight) {
			// The ribbon is gone; map the click through the take's own clock:
			// surface x -> frame inside the shot -> t inside the follow range.
			const surfaceRect = keySurface.getBoundingClientRect();
			const frac = (e.clientX - surfaceRect.left) / Math.max(1, surfaceRect.width);
			const duration = Math.max(1, shot.endFrame - shot.startFrame);
			const frameInShot = frac * duration;
			const range = shot.camera?.railFollow?.mode === "range"
				? { start: shot.camera.railFollow.startFrame, end: shot.camera.railFollow.endFrame }
				: { start: 0, end: duration };
			if (frameInShot < range.start || frameInShot > range.end) return;
			const t = Math.max(0, Math.min(1, (frameInShot - range.start) / Math.max(1, range.end - range.start)));
			// Show what the click just made. The box draws one curve at a time, so
			// authoring a crane point while it is drawing SPEED put the new point
			// somewhere the card cannot draw — the dot appeared in the scene and
			// nowhere near the hand that placed it.
			setCameraCurve("height");
			onCranePointAdd?.(t, shot.id);
			return;
		}
		const lane = e.currentTarget.closest(".tl-lane");
		const laneRect = lane?.getBoundingClientRect();
		if (!laneRect) return;
		const target = frameFromClientX(e.clientX, laneRect.left, laneRect.width, displayFrameCount, frameCount);
		handlers.current.onCameraKeyframeAdd?.(target, shot.id);
	}

	function finishShotRename(shot, index, value) {
		const name = value.trim();
		if (name && name !== shot.name) handlers.current.onShotRename?.(shot.id, name);
		setRenamingShotId(null);
	}

	function frameFromEvent(e) {
		const el = rulerRef.current;
		if (!el) return frame;
		const rect = el.getBoundingClientRect();
		return frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
	}

	function rootFrameFromEvent(e) {
		const rect = e.currentTarget.getBoundingClientRect();
		return frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
	}

	// A run bar stands in for one diamond per frame, so every gesture on it has
	// to resolve WHICH frame the hand is over. Same lane pixel→frame transform
	// as the ruler, then clamped into the run the bar draws.
	function ikRunFrameFromEvent(e, run) {
		const rect = e.currentTarget.closest(".tl-lane")?.getBoundingClientRect();
		if (!rect || rect.width < 2) return run.start;
		const pointerFrame = frameFromClientX(e.clientX, rect.left, rect.width, displayFrameCount, frameCount);
		return Math.max(run.start, Math.min(run.end, pointerFrame));
	}

	function onRulerDown(e) {
		if (e.button !== 0) return;
		scrubbing.current = true;
		rulerRef.current?.setPointerCapture?.(e.pointerId);
		handlers.current.onScrub?.(frameFromEvent(e));
	}

	function onRulerMove(e) {
		if (!scrubbing.current) return;
		handlers.current.onScrub?.(frameFromEvent(e));
	}

	function onRulerUp(e) {
		if (!scrubbing.current) return;
		scrubbing.current = false;
		rulerRef.current?.releasePointerCapture?.(e.pointerId);
	}

	const cameraBlockIdx = selectedCameraBlockIdx === undefined ? localCameraBlockIdx : selectedCameraBlockIdx;
	const selectedCameraShot = cameraBlockIdx == null ? null : shots[cameraBlockIdx] ?? null;
	// The dolly's speed curve edits as a DRAFT and commits once on release:
	// every commit rebuilds the whole camera track and records an undo entry,
	// so streaming per-pointer-move commits would jank and spam history.
	const railLengthByShot = useMemo(() => {
		const map = new Map();
		for (const shot of shots) {
			const rail = Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2
				? buildRail(shot.camera.cameraRail)
				: null;
			if (rail) map.set(shot.id, rail.length);
		}
		return map;
	}, [shots]);
	const [dollyDraft, setDollyDraft] = useState(null); // { shotId, timing }
	const dollyDraftRef = useRef(null);
	// Which reading the Shot box draws. The box IS the graph — it already spans
	// exactly the shot's frames — so the curve needs no clock of its own, and
	// every action (switch, cut, reset, remove) belongs to the camera bar above.
	const [cameraCurve, setCameraCurve] = useState("speed");
	useEffect(() => {
		setDollyDraft(null);
		dollyDraftRef.current = null;
	}, [selectedCameraShot?.id]);
	// A curve only exists for a Shot whose camera actually rides a rail: a keyed
	// or follow camera has no dolly to time and no crane to lift.
	const curveShot = selectedCameraShot && cameraBlockMode(selectedCameraShot) === "rail" && railLengthByShot.has(selectedCameraShot.id)
		? selectedCameraShot
		: null;
	const curveRange = useMemo(() => {
		if (!curveShot) return null;
		const duration = curveShot.endFrame - curveShot.startFrame + 1;
		const stored = curveShot.camera?.railFollow;
		if (stored?.mode === "off") return null;
		const range = stored?.mode === "range"
			? { start: Math.max(0, Math.min(duration - 1, stored.startFrame)), end: Math.max(0, Math.min(duration - 1, stored.endFrame)) }
			: { start: 0, end: duration - 1 };
		return { range, duration };
	}, [curveShot]);
	// The bar's actions operate on the same pure timing model the box draws, so
	// "cut here" means the same thing whichever surface asked for it.
	const dollyTiming = curveShot ? (dollyDraft?.shotId === curveShot.id ? dollyDraft.timing : curveShot.camera?.dollyTiming ?? null) : null;
	const curvePlayheadU = curveShot && curveRange
		? (Math.min(Math.max(0, frame - curveShot.startFrame), curveRange.duration - 1) - curveRange.range.start) / Math.max(1, curveRange.range.end - curveRange.range.start)
		: null;
	const commitDolly = (timing) => {
		if (!curveShot) return;
		handlers.current.onCameraBlockChange?.({ dollyTiming: timingIsFlat(timing) ? null : timing }, curveShot.id);
	};
	const cameraCurveActions = curveShot && curveRange
		? {
			mode: cameraCurve,
			onModeChange: setCameraCurve,
			hasCrane: !!curveShot.camera?.craneHeight,
			canCut: cameraCurve === "speed" && curvePlayheadU != null && curvePlayheadU > CUT_MIN_GAP && curvePlayheadU < 1 - CUT_MIN_GAP,
			canReset: cameraCurve === "speed" ? !timingIsFlat(dollyTiming) : false,
			onCut: () => {
				const next = insertCut(dollyTiming ?? flatTiming(), curvePlayheadU);
				if (next && next !== dollyTiming) commitDolly(next);
			},
			onReset: () => commitDolly(flatTiming()),
		}
		: null;
	// Motion and Pose own the character layer; the camera-cut tools stay out of them.
	const motionTools = workflowMode === "motion";
	const tracks = TRACKS;
	const activeShotForCut = shots[activeShotIdx] ?? null;
	const canCutShot = Boolean(activeShotForCut && frame > activeShotForCut.startFrame && frame <= activeShotForCut.endFrame);
	return (
		<section className={"timeline v2-sequencer" + (expanded ? "" : " collapsed") + (!shots.length ? " empty-shots" : "")} data-testid="sequencer" aria-label={ko("Animation timeline", "애니메이션 타임라인")}>
			{expanded ? (
				<>
					<div className="tl-head">
						<strong className="tl-title">{ko("Sequencer", "시퀀서")}</strong>
						<div className="tl-transport" aria-label={ko("Playback transport", "재생 컨트롤")}>
							<button
								type="button"
								className="tl-btn"
								aria-label={ko("Previous frame", "이전 프레임")}
								title={ko("Previous frame (k)", "이전 프레임 (k)")}
								onClick={() => handlers.current.onStep?.(-1)}
							>
								‹
							</button>
							<button
								type="button"
								className={"tl-btn play" + (playing ? " on" : "")} data-fid="tl_play"
								aria-label={playing ? ko("Pause playback", "재생 일시중지") : ko("Play playback", "재생 시작")}
								title={ko("Play / pause (Space)", "재생/일시중지 (Space)")}
								onClick={() => handlers.current.onPlayToggle?.()}
							>
								{playing ? "❚❚" : "▶"}
							</button>
							<button
								type="button"
								className="tl-btn"
								aria-label={ko("Next frame", "다음 프레임")}
								title={ko("Next frame (j)", "다음 프레임 (j)")}
								onClick={() => handlers.current.onStep?.(1)}
							>
								›
							</button>
							<span className="tl-readout" data-testid="sequencer-frame-readout" aria-live="polite">
								<b>{String(Math.max(0, frame)).padStart(4, "0")}</b><span> / {String(Math.max(0, frameCount)).padStart(4, "0")} · {fps}fps</span>
							</span><NotePinButton />
						</div>
						<div className="tl-sequencer-actions" role="group" aria-label={ko("Sequencer actions", "시퀀서 작업")}>
							{motionTools || workflowMode === "pose" || ikMode ? null : (<>
								{shots.length > 0 && <button
									type="button"
									className="tl-seq-action cut"
									data-testid="sequencer-cut"
									disabled={!canCutShot}
									title={ko("Split the selected Camera Cut at the playhead", "선택한 카메라 컷을 재생 헤드에서 나눕니다")}
									onClick={() => activeShotForCut && handlers.current.onShotSplit?.(activeShotForCut.id)}
								>
									{ko("Cut", "컷")}
								</button>}
								{cameraBlockIdx != null && <button
									type="button"
									className="tl-seq-action rail"
									data-testid="sequencer-draw-rail"
									// The rail belongs to a shot: with none selected the toggle used to
									// do nothing at all, so say why instead.
									disabled={cameraBlockIdx == null}
									title={cameraBlockIdx == null ? ko("Add or select a shot first — the rail belongs to a shot", "먼저 샷을 추가하거나 선택하세요 — 레일은 샷에 속합니다") : ko("Draw or redraw the selected camera rail", "선택한 카메라 레일을 그리거나 다시 그립니다")}
									onClick={() => handlers.current.onCameraRailDrawToggle?.()}
								>
									{ko("Draw rail", "레일 그리기")}
								</button>}
								{!shotCutDisabled && <button
									type="button"
									className="tl-seq-action"
									data-testid="sequencer-add-track"
									disabled={shotCutDisabled}
									title={ko("Add a Camera Cut track block", "카메라 컷 트랙 블록 추가")}
									onClick={() => handlers.current.onShotCut?.()}
								>
									{ko("+ Track", "+ 트랙")}
								</button>}
							</>) }
						</div>
						<div className="tl-head-group tl-view-tools" role="group" aria-label={ko("Timeline view tools", "타임라인 보기 도구")}>
							<button
								type="button"
								className={"tl-btn zoom" + (zoom !== ZOOM_DEFAULT ? " on" : "")}
								aria-label={ko("Timeline zoom", "타임라인 확대 비율")}
								title={ko("Two-finger up/down over FRAME ruler to zoom — click to reset to 1×", "프레임 눈금 위에서 두 손가락으로 위아래 스크롤해 확대/축소 · 클릭하면 1×로 초기화")}
								onClick={resetZoom}
							>
								{zoom.toFixed(2)}×
							</button>
							<button
								type="button"
								className={"tl-btn wp" + (waypointMode ? " on" : "")}
								aria-pressed={waypointMode}
								aria-label={ko("Root path mode", "루트 경로 모드")}
								title={ko("Enable or disable root path constraints (P)", "루트 경로 제약 켜기/끄기 (P)")}
								onClick={() => handlers.current.onWaypointToggle?.()}
							>
								{ko(`Waypoint ${waypointMode ? "on" : "off"}`, `웨이포인트 ${waypointMode ? "켜짐" : "꺼짐"}`, `路径点${waypointMode ? "开" : "关"}`)}
							</button>
						</div>
						<div className="tl-head-group tl-pose-tools" role="group" aria-label={ko("Pose correction tools", "포즈 보정 도구")}>
							{/* No rig, no pose editing: the group says why instead of
							    offering a button that cannot do anything (R3). */}
							{ikDisabled && !ikMode ? (
								<span className="tl-pose-hint">{ko("Load a rig to edit poses", "리그를 로드하면 포즈를 편집할 수 있어요")}</span>
							) : (<>
								{/* Foot snap and Body contact only reinterpret an IK drag, so
								    they live for exactly as long as IK does (R7). Two
								    independent bits, two toggles. */}
								{ikMode && (<>
									<button
										type="button"
										className={"tl-btn ik snap" + (footSnap ? " on" : "")}
										aria-pressed={footSnap}
										aria-label={ko("Foot snap", "발 스냅")}
										title={ko("Foot snap — keep the feet planted while you move the body (hips); the knees bend instead of the feet sinking through the floor", "발 스냅 — 몸(엉덩이)을 움직여도 발을 바닥에 고정합니다. 발이 바닥으로 가라앉는 대신 무릎이 구부러집니다")}
										onClick={() => handlers.current.onFootSnapToggle?.()}
									>
										{ko(`Snap ${footSnap ? "on" : "off"}`, `스냅 ${footSnap ? "켜짐" : "꺼짐"}`, `吸附${footSnap ? "开" : "关"}`)}
									</button>
									<button
										type="button"
										className={"tl-btn ik contact" + (bodyContact ? " on" : "")}
										aria-pressed={bodyContact}
										aria-label={ko("Body contact", "바닥 접촉")}
										title={ko("Body contact — keep hands, knees, feet, head, and hips above the floor", "바닥 접촉 — 손, 무릎, 발, 머리, 엉덩이가 바닥 아래로 내려가지 않게 합니다")}
										onClick={() => handlers.current.onBodyContactToggle?.()}
									>
										{ko(`Body contact ${bodyContact ? "on" : "off"}`, `바닥 접촉 ${bodyContact ? "켜짐" : "꺼짐"}`, `身体接触${bodyContact ? "开" : "关"}`)}
									</button>
								</>)}
							</>)}
						</div>
						{onClearMotion && (
							<div className="tl-head-group tl-motion-tools" role="group" aria-label={ko("Motion controls", "모션 컨트롤")}>
								{motion?.segments && motionTools && <TakeSegmentTools motion={motion} frame={frame} />}{motionTools && <PhysicsToggle />}
								<button
									type="button"
									className="tl-btn clear"
									aria-label={ko("Clear loaded motion", "불러온 모션 지우기")}
									title={ko("Clear the compiled take, then restore the blocking pose", "컴파일된 테이크를 지우고 블로킹 포즈로 되돌리기")}
									onClick={onClearMotion}
								>
									✕ {ko("Clear motion", "모션 지우기")}
								</button>
							</div>
						)}
						{waypointMode && (
							<span className={"tl-wp-hint" + (waypointFrames.length < 2 || pathSpeed?.warn ? " warn" : "")}>
								{waypointFrames.length < 2
									? ko("Click the set floor in the Shot view to drop waypoints", "샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요", "在镜头视图中点击布景地面放置路径点")
									: ko(`${waypointFrames.length} root waypoints` + (pathSpeed ? ` · ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s${pathSpeed.warn ? " — outside the natural 0.5–3 m/s locomotion band" : ""}` : "") + " · click the set floor to add more",
										`루트 웨이포인트 ${waypointFrames.length}개` + (pathSpeed ? ` · ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s${pathSpeed.warn ? " — 자연스러운 이동 속도 0.5–3 m/s 범위를 벗어남" : ""}` : "") + " · 세트 바닥을 클릭해 더 추가",
										`${waypointFrames.length} 个根路径点` + (pathSpeed ? ` · ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s${pathSpeed.warn ? " — 超出自然行走 0.5–3 m/s 区间" : ""}` : "") + " · 点击布景地面继续添加")}
							</span>
						)}
						{badge && <span className={"tl-badge " + badge.kind}>{badge.label}</span>}
						<button
							type="button"
							className="tl-toggle"
							aria-expanded="true"
							aria-label={ko("Collapse timeline", "타임라인 접기")}
							title={ko("Collapse timeline", "타임라인 접기")}
							onClick={() => setExpanded(false)}
						>
							▾
						</button>
					</div>
					{selectedCameraShot && cameraSelected && (
						<CameraBlockEditor
							shot={selectedCameraShot}
							blocked={waypointMode}
							previewing={playing}
							railDraw={railDraw}
							railLength={cameraRailLength} fps={fps}
							craneSelectedIndex={craneSelectedIndex}
							curve={cameraCurveActions}
							onChange={(patch) => handlers.current.onCameraBlockChange?.(patch)}
							onPreview={() => handlers.current.onCameraPreview?.(selectedCameraShot.id)}
							onRailDrawToggle={() => handlers.current.onCameraRailDrawToggle?.()}
							onRailDelete={() => handlers.current.onCameraRailDelete?.()}
							onCranePointDelete={onCranePointDelete}
							onWaypointToggle={() => handlers.current.onWaypointToggle?.()}
						/>
					)}

					<div className="tl-body" ref={bodyRef}>
						<div className={"tl-surface" + (!shots.length ? " empty-shots" : "") + (pathObject ? " prop-subject" : "")} data-ik-parts={ikParts.rows || undefined} style={{ "--tl-zoom": surfaceZoom, "--tl-ik-parts": ikParts.rows }}>
						<div className="tl-ruler">
							<span className="tl-ruler-label">{ko("Frame", "프레임", "帧")}</span>
							<div
								className="tl-ruler-lane"
								ref={rulerRef}
								role="slider"
								aria-label={ko("Scrub timeline", "타임라인 탐색")}
								aria-valuemin={0}
								aria-valuemax={frameCount - 1}
								aria-valuenow={frame}
								tabIndex={0}
								onPointerDown={onRulerDown}
								onPointerMove={onRulerMove}
								onPointerUp={onRulerUp}
								onPointerCancel={onRulerUp}
								onKeyDown={(e) => {
									if (e.key === "ArrowRight") {
										e.preventDefault();
										handlers.current.onStep?.(1);
									} else if (e.key === "ArrowLeft") {
										e.preventDefault();
										handlers.current.onStep?.(-1);
									}
								}}
							>
								<span className="tl-frame-box" style={{ "--tl-f": framePct(frame, displayFrameCount) }} aria-hidden="true">
									{frame}
								</span>
								{labels.map((f) => (
									<span key={f} className="tl-tick" style={{ "--tl-f": framePct(f, displayFrameCount) }}>
										<i />
										{f}
									</span>
								))}
							</div>
						</div>

						{/* What the strip LOADS follows the selection. A prop's travel
						    is a different subject on the same clock, so selecting one
						    swaps the performer's lanes for the prop's instead of
						    stacking both and making every row ambiguous. */}
						{pathObject ? (
							<ObjectTravelTrack
								object={pathObject}
								frame={frame}
								frameCount={frameCount}
								fps={fps}
								pathDraw={pathDraw}
								onPathDrawToggle={() => handlers.current.onObjectPathDrawToggle?.()}
								onPathChange={(path) => handlers.current.onObjectPathChange?.(path)}
								onPathClear={() => handlers.current.onObjectPathClear?.()}
								onTimingGestureStart={() => handlers.current.onObjectTimingGestureStart?.()}
								onTimingGestureEnd={() => handlers.current.onObjectTimingGestureEnd?.()}
								markIndex={objectPathPointIndex}
								onMarkAdd={(t) => handlers.current.onObjectMarkAdd?.(t)}
								onMarkLean={(key, value, token) => handlers.current.onObjectMarkLean?.(key, value, token)}
								onMarkScrubStart={(...args) => handlers.current.onObjectMarkScrubStart?.(...args)}
								onMarkScrubEnd={(...args) => handlers.current.onObjectMarkScrubEnd?.(...args)}
							/>
						) : tracks.map((name) => (
							<div className={"tl-track" + (name === IK_LANE ? " ik" : "") + (name === SHOTS_LANE ? " shots" : "")} data-track-id={name} key={name}>
								<span className="tl-track-label tl-track-tree">
									{name === IK_LANE ? (
										<span className="tl-track-label-stack">
											<span className="tl-track-subrow"><span className="tl-track-chip body" data-lane-label="Body">{ko("Body", "바디")}</span></span>
											<span className="tl-track-subrow indent"><IkPartsToggle ikParts={ikParts} /><span className="tl-track-chip ik" data-lane-label="IK keys">{ko("IK keys", "IK 키")}</span>{ikMode && <FixTools />}</span><IkPartLabels ikParts={ikParts} />
										</span>
									) : name === SHOTS_LANE ? (
										<span className="tl-track-label-stack">
											<span className="tl-track-subrow"><span className="tl-track-chip camera" data-lane-label="Camera Cuts">{ko("Camera Cuts", "카메라 컷")}</span></span>
											<span className="tl-track-subrow indent"><span className="tl-track-chip rail" data-lane-label="Rail">{ko("Rail", "레일")}</span></span>
											<span className="tl-track-subrow indent"><span className="tl-track-chip crane" data-lane-label="Crane">{ko("Crane", "크레인")}</span></span>
										</span>
									) : (
										<span className="tl-track-subrow"><span className="tl-track-chip root" data-lane-label={TRACK_LABELS_KO[name]}>{TRACK_LABELS_KO[name]}</span></span>
									)}
									{trackOwner && name === "2D Root" && <em className="tl-track-owner">{trackOwner}</em>}
									{name === "2D Root" && pathSpeed && (
										<em
											className={"tl-path-speed" + (pathSpeed.warn ? " warn" : "")}
											title={ko(`Leg speeds ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s — natural gait is 0.8–1.2 m/s`, `핀 구간 속도 ${pathSpeed.min.toFixed(1)}~${pathSpeed.max.toFixed(1)} m/s — 자연 보행은 0.8~1.2 m/s`, `腿速 ${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s — 自然步态为 0.8–1.2 m/s`)}
										>
											{pathSpeed.min === pathSpeed.max
												? `${pathSpeed.min.toFixed(1)} m/s`
												: `${pathSpeed.min.toFixed(1)}–${pathSpeed.max.toFixed(1)} m/s`}
										</em>
									)}
									
									{name === SHOTS_LANE && (
										<button
											type="button"
											className="tl-track-add cut" data-fid="shot_add"
											disabled={shotCutDisabled}
											title={ko("Add a 2 second shot without changing existing shots", "기존 샷을 바꾸지 않고 2초 샷 추가")}
											onClick={() => handlers.current.onShotCut?.()}
										>
											{ko("+ Add shot", "+ 샷 추가")}
										</button>
									)}
									{name === IK_LANE && ikMode && (
										<button
											className="tl-track-add ik"
											type="button"
											title={ko(`Key the current pose at frame ${frame}`, `현재 포즈를 ${frame}프레임에 키로 저장`, `在当前帧 ${frame} 记录姿势关键帧`)}
											onClick={() => handlers.current.onIkKeyframeAdd?.()}
										>
											+
										</button>
									)}
									</span>
								<div
									className={"tl-lane" + (name === "2D Root" ? " root" : "") + (name === SHOTS_LANE ? " shots" : "")}
									onPointerDown={
										name === "2D Root"
											? (e) => {
												if (e.button !== 0 || e.target !== e.currentTarget) return;
												handlers.current.onRootKeyframeAdd?.(rootFrameFromEvent(e));
											}
											: name === IK_LANE ? (e) => ikLanePress(e, rootFrameFromEvent(e)) : undefined
									}
								>
									{gridFrames.map((f) => (
										<i key={f} className="tl-grid" style={{ "--tl-f": framePct(f, displayFrameCount) }} aria-hidden="true" />
									))}
									{name === IK_LANE && <NotePins displayFrameCount={displayFrameCount} />}{name === IK_LANE && <FixIslandBands displayFrameCount={displayFrameCount} ikParts={ikParts} onJump={(f) => handlers.current.onScrub?.(f)} />}{name === IK_LANE && previewRanges.map((range, index) => {
										const startFrame = Number.isFinite(Number(range?.startFrame)) ? Number(range.startFrame) : Number(range?.start ?? 0);
										const endFrame = Number.isFinite(Number(range?.endFrame)) ? Number(range.endFrame) : Number(range?.end ?? startFrame);
										const start = Math.max(0, Math.min(displayFrameCount - 1, Math.round(startFrame)));
										const end = Math.max(start, Math.min(displayFrameCount - 1, Math.round(endFrame)));
										return <span key={`preview:${index}`} className="tl-preview-range" style={{ "--tl-f-start": framePct(start, displayFrameCount), "--tl-f-end": framePct(end, displayFrameCount) }} aria-label={ko(`Preview range ${start}–${end}`, `미리보기 범위 ${start}–${end}`, `预览范围 ${start}–${end}`)} />;
									})}
									{name === SHOTS_LANE && shots.length === 0 && (
										<div className="tl-shot-empty">
											<span>{ko("No shots yet — use + Add shot in the lane header to create one.", "아직 샷이 없습니다 — 레인 헤더의 + 샷 추가로 만들어 보세요.")}</span>
										</div>
									)}
									{name === SHOTS_LANE && shots.map((shot, index) => {
										const geometry = shotBlockGeometry(shots, index, frameCount, displayFrameCount);
										if (!geometry) return null;
										const mode = cameraBlockMode(shot);
										const follow = cameraBlockFollow(shot);
										const keyCount = shot.cameraKeys?.length ?? 0;
										const lastFrame = shot.endFrame;
										const durationS = (lastFrame - shot.startFrame + 1) / Math.max(1, fps);
										const stateLabel = mode === "keys" && keyCount === 0 ? "FREE" : "LOCKED";
										const modeLabel = mode === "rail" ? "RAIL" : mode === "follow" ? "FOLLOW" : `KEYS ${keyCount}`;
										const detailLabel = mode === "rail"
											? `${follow.railStartMode === "head" ? "HEAD" : "NEAREST"} · ${Number(follow.maxDollySpeed).toFixed(1)} m/s · PITCH ${signedDegrees(follow.pitchOffsetDeg)}`
											: mode === "follow"
												? `${Number(follow.distance).toFixed(1)} m · PITCH ${signedDegrees(follow.pitchOffsetDeg)}`
												: null;
										const durationFrames = lastFrame - shot.startFrame + 1;
										const railAvailable = Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2 && durationFrames >= 10;
										const storedRail = shot.camera?.railFollow;
										const railRange = railAvailable
											? storedRail?.mode === "range"
												? { start: Math.max(0, Math.min(durationFrames - 1, storedRail.startFrame)), end: Math.max(0, Math.min(durationFrames - 1, storedRail.endFrame)) }
												: { start: 0, end: durationFrames - 1 }
											: null;
										const railOff = storedRail?.mode === "off" || mode !== "rail";
										const localProgress = frame - shot.startFrame;
										// A shot aimed at a video model is measured against that
										// model's clip lengths and delivery aspects. The badge is
										// advisory: nothing here trims or re-crops the cut.
										const targetPreset = shot.targetModel ? presetById(shot.targetModel) : null;
										const modelWarnings = targetPreset
											? checkShotAgainstPreset({ frames: durationFrames, fps, aspect: shotAspect }, targetPreset).warnings
											: [];
										return (
											<div
												key={shot.id}
												className={"tl-shot-block" + (index === cameraBlockIdx ? " selected" : "") + (index === activeShotIdx ? " active" : "") + (movingShotId === shot.id ? " moving" : "") + (!railOff && railRange && railLengthByShot.has(shot.id) ? " has-dolly" : "")}
												data-shot-kind={shot.kind === "still" ? "still" : undefined}
												style={{ "--tl-f-start": geometry.startPct, "--tl-f-end": geometry.endPct }}
												title={ko(`${shot.name} · frames ${shot.startFrame}–${lastFrame} · drag to reorder, trim cuts at either edge, click the empty lower strip to add a camera key`, `${shot.name} · ${shot.startFrame}–${lastFrame}프레임 · 드래그해 순서 이동, 양끝으로 컷 조절, 아래 빈 줄을 클릭해 카메라 키 추가`, `${shot.name} · 第 ${shot.startFrame}–${lastFrame} 帧 · 拖动调整顺序，拖动两端修剪剪辑，点击下方空条添加摄影机关键帧`)}
												onPointerDown={(e) => beginShotMove(e, shot, index)}
												onPointerMove={moveShot}
												onPointerUp={endShotMove}
												onPointerCancel={endShotMove}
												onClick={() => selectUnifiedShotBlock(index)}
												onDoubleClick={(e) => { e.stopPropagation(); setRenamingShotId(shot.id); }}
											>
												<button
														type="button"
														className="tl-shot-edge start"
														aria-label={ko(`Resize start of ${shot.name}`, `${shot.name} 시작점 조절`, `调整 ${shot.name} 的起点`)}
														onPointerDown={(e) => beginShotBoundaryDrag(e, index, "start")}
														onPointerMove={moveShotBoundary}
														onPointerUp={endShotBoundaryDrag}
														onPointerCancel={endShotBoundaryDrag}
													>
														⋮
													</button>
												<button
													type="button"
													className="tl-shot-edge end"
													aria-label={ko(`Resize end of ${shot.name}`, `${shot.name} 끝 길이 조절`, `调整 ${shot.name} 的终点`)}
													onPointerDown={(e) => beginShotBoundaryDrag(e, index, "end")}
													onPointerMove={moveShotBoundary}
													onPointerUp={endShotBoundaryDrag}
													onPointerCancel={endShotBoundaryDrag}
												>
													⋮
												</button>
												{renamingShotId === shot.id ? (
													<input
														className="tl-shot-name-input"
														defaultValue={shot.name}
														autoFocus
														onClick={(e) => e.stopPropagation()}
														onBlur={(e) => finishShotRename(shot, index, e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter" && !isImeComposing(e)) e.currentTarget.blur();
															if (e.key === "Escape") setRenamingShotId(null);
														}}
													/>
												) : (
													<span className="tl-shot-label">
														<b>{shot.name}</b>
														<small>{shot.startFrame}–{lastFrame} · {durationS.toFixed(1)}{ko("s", "초")}</small>
														{shot.kind === "still" && shot.caption && <small className="tl-shot-caption" title={shot.caption}>{shot.caption}</small>}
													</span>
												)}
												{modelWarnings.length > 0 && (
													<span
														className="tl-shot-warn"
														role="status"
														title={modelWarnings.join("; ")}
													>
														⚠ {targetPreset.name}
													</span>
												)}
											<span className="tl-shot-actions">
												<button type="button" title={ko("Split at the playhead", "재생 헤드에서 분할")} disabled={frame <= shot.startFrame || frame > shot.endFrame} onClick={(e) => { e.stopPropagation(); handlers.current.onShotSplit?.(shot.id); }}>{ko("Split", "분할")}</button>
												<button type="button" title={ko("Duplicate shot", "샷 복제")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotDuplicate?.(shot.id); }}>{ko("Duplicate", "복제")}</button>
													<button type="button" data-fid="shot_delete" title={ko("Delete shot and leave free-camera time", "샷을 지우고 자유 카메라 구간으로 비우기")} onClick={(e) => { e.stopPropagation(); handlers.current.onShotRemove?.(shot.id); }}>{ko("Delete", "삭제")}</button>
												</span>
												<span className="tl-shot-camera-summary">
													<span className="tl-camera-block-state">{stateLabel}</span>
													<b>{modeLabel}</b>
													{detailLabel && <small>{detailLabel}</small>}
												</span>
										{/* The card is a card again: it SHOWS the move, it does not host the
										    editor. Three instruments stacked in 61 px of a 68 px lane drew on
										    top of each other and under the shot's own name, so every gesture
										    landed on the wrong one. Editing moved to the camera instrument in
										    the strip; what stays here is one passive curve — the shape of the
										    move, at a glance. */}
										{!railOff && railRange && railLengthByShot.has(shot.id) && (
											<div
												className={"sg-shot" + (cameraCurve === "height" && shot.camera?.craneHeight ? " height" : "")}
												title={cameraCurve === "height"
													? ko("Crane height — drag a point, click empty time to add one", "크레인 높이 — 점을 끌어 조절, 빈 시간을 클릭해 추가")
													: ko("Dolly speed — drag the line; cuts and reset live in the camera bar above", "돌리 속도 — 선을 끌어 조절, 컷·초기화는 위 카메라 바에서")}
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => event.stopPropagation()}
												onDoubleClick={(event) => event.stopPropagation()}
											>
												{cameraCurve === "height" && shot.camera?.craneHeight ? (
													<CraneHeightEditor
														crane={shot.camera.craneHeight}
														railRange={railRange}
														durationFrames={durationFrames}
														selectedIndex={index === cameraBlockIdx ? craneSelectedIndex : null}
														onSelect={(pointIndex) => { selectUnifiedShotBlock(index); onCranePointSelect?.(pointIndex, shot.id); }}
														onAddPoint={(t) => { selectUnifiedShotBlock(index); onCranePointAdd?.(t, shot.id); }}
														onChangePoints={(points) => { selectUnifiedShotBlock(index); handlers.current.onCameraBlockChange?.({ craneHeight: { points } }, shot.id); }}
													/>
												) : (
													<SpeedGraph
														bare
														timing={dollyDraft?.shotId === shot.id ? dollyDraft.timing : shot.camera?.dollyTiming ?? null}
														windowStart={durationFrames > 1 ? railRange.start / (durationFrames - 1) : 0}
														windowFrac={durationFrames > 1 ? Math.max(1, railRange.end - railRange.start) / (durationFrames - 1) : 1}
														frame={Math.min(Math.max(0, localProgress), Math.max(0, durationFrames - 1))}
														frameCount={durationFrames}
														averageSpeed={railLengthByShot.get(shot.id) / Math.max(1 / fps, (railRange.end - railRange.start) / fps)}
														onChange={(timing) => {
															selectUnifiedShotBlock(index);
															dollyDraftRef.current = { shotId: shot.id, timing };
															setDollyDraft({ shotId: shot.id, timing });
														}}
														onGestureEnd={() => {
															const draft = dollyDraftRef.current;
															dollyDraftRef.current = null;
															setDollyDraft(null);
															if (draft) handlers.current.onCameraBlockChange?.({ dollyTiming: timingIsFlat(draft.timing) ? null : draft.timing }, draft.shotId);
														}}
													/>
												)}
											</div>
										)}
											{/* Camera-key authoring remains separate from the crane graph so
												    one gesture cannot both reorder a shot and edit a curve. */}
												<button
													type="button"
													className="tl-shot-key-surface" data-fid="camera_key_add"
													aria-label={shot.camera?.mode === "rail" && shot.camera?.craneHeight
														? ko(`Add crane point in ${shot.name}`, `${shot.name}에 크레인 점 추가`, `在 ${shot.name} 中添加摇臂点`)
														: ko(`Add camera key in ${shot.name}`, `${shot.name}에 카메라 키 추가`, `在 ${shot.name} 中添加摄影机关键帧`)}
													title={shot.camera?.mode === "rail" && shot.camera?.craneHeight
														? ko("Click the crane graph to add a point; click a point and drag it to change height", "크레인 그래프를 클릭해 점 추가 · 점을 눌러 끌어 높이 조절")
														: ko("Click at a frame to store the current camera framing", "프레임 위치를 클릭해 현재 카메라 프레이밍을 저장합니다")}
													onClick={(event) => addShotPointFromBlock(event, shot, index)}
													onDoubleClick={(event) => event.stopPropagation()}
												/>
											</div>
										);
									})}
									{name === IK_LANE && pinBands.map(({ pin, geometry }) => {
						return (
							<button
								key={`pin:${pin.id}`}
								type="button"
								className={`tl-pin-band${selectedPinId === pin.id ? " selected" : ""}`}
								style={{
									"--tl-f-start": geometry.startPct,
									"--tl-f-end": geometry.endPct,
									"--tl-pin-ramp-start": geometry.rampStartPct,
									"--tl-pin-ramp-end": geometry.rampEndPct,
									"--tl-pin-color": "var(--select, #e8a33d)",
								}}
								title={ko(`${pin.track} pin · frames ${pin.startFrame}–${pin.endFrame}`, `${pin.track} 고정 · ${pin.startFrame}–${pin.endFrame}프레임`, `${pin.track} 固定 · 第 ${pin.startFrame}–${pin.endFrame} 帧`)}
								onPointerDown={(event) => {
									if (event.button !== 0) return;
									event.stopPropagation();
									handlers.current.onPinSelect?.(pin.id);
								}}
							>
								<i className="tl-pin-band-ramp start" aria-hidden="true" />
								<i className="tl-pin-band-core" aria-hidden="true" />
								<i className="tl-pin-band-ramp end" aria-hidden="true" />
							</button>
						);
					})}
					{name === IK_LANE && pendingPinRange && (() => {
						const geometry = rangePinBandGeometry(pendingPinRange, frameCount, displayFrameCount);
						if (!geometry) return null;
						return <span
							className="tl-pin-pending"
							style={{ "--tl-f-start": geometry.startPct, "--tl-f-end": geometry.endPct }}
							aria-label={ko(`Pending pin range ${geometry.startFrame}–${geometry.endFrame}`, `대기 중인 고정 범위 ${geometry.startFrame}–${geometry.endFrame}`, `待定固定范围 ${geometry.startFrame}–${geometry.endFrame}`)}
						/>;
					})()}
					{name === IK_LANE && motion?.segments && <TakeSegmentClips motion={motion} frame={frame} frameCount={frameCount} displayFrameCount={displayFrameCount} clipPct={clipPct} tools={motionTools} />}

									{name === IK_LANE &&
										ikRuns.flatMap((run) => (run.length < KEY_RUN_MIN
											// One or two keys still read as keys — draw them as before.
											? Array.from({ length: run.length }, (_, i) => run.start + i).map((f) => (
												<span
													key={f}
													className={"tl-marker ik" + (f === frame ? " current" : "")}
													style={{ "--tl-f": framePct(f, displayFrameCount) }}
													title={ko(`Full-body IK key at frame ${f} — click to jump, right-click to remove`, `${f}프레임의 전신 IK 키 — 클릭해 이동, 오른쪽 클릭으로 삭제`, `第 ${f} 帧的全身 IK 键 — 点击跳转，右键删除`)}
													onPointerDown={(e) => beginIkKeyDrag(e, f)}
													onPointerMove={moveIkKeyDrag}
													onPointerUp={endIkKeyDrag}
													onPointerCancel={endIkKeyDrag}
													onContextMenu={(e) => {
														e.preventDefault();
														e.stopPropagation();
														handlers.current.onIkKeyframeRemove?.(f);
													}}
												/>
											))
											// A baked span is ONE bar. Both gestures still address a single
											// frame — the one under the pointer — so nothing a diamond could
											// do is lost, it just stops shouting.
											: [(
												<span
													key={`run:${run.start}`}
													className={"tl-ik-run" + (frame >= run.start && frame <= run.end ? " current" : "")}
													style={{ "--tl-f": framePct(run.start, displayFrameCount), "--tl-f2": framePct(run.end, displayFrameCount) }}
													title={ko(`IK keys ${run.start}–${run.end} (${run.length}) — click to jump to that frame, right-click to remove that frame's key`,
														`${run.start}–${run.end} 전신 IK 키 (${run.length}개) — 클릭해 그 프레임으로 이동, 오른쪽 클릭으로 그 프레임 키 삭제`,
														`IK 键 ${run.start}–${run.end}（${run.length} 个）— 点击跳转到该帧，右键删除该帧的键`)}
													onPointerDown={(e) => {
														if (e.button !== 0) return;
														e.stopPropagation();
														handlers.current.onScrub?.(ikRunFrameFromEvent(e, run));
													}}
													onContextMenu={(e) => {
														e.preventDefault();
														e.stopPropagation();
														handlers.current.onIkKeyframeRemove?.(ikRunFrameFromEvent(e, run));
													}}
												>
													<i className="tl-ik-run-cap start" aria-hidden="true" />
													<i className="tl-ik-run-cap end" aria-hidden="true" />
													{frame >= run.start && frame <= run.end && (
														<i
															className="tl-ik-run-at"
															style={{ "--tl-f": run.end > run.start ? (frame - run.start) / (run.end - run.start) : 0 }}
															aria-hidden="true"
														/>
													)}
												</span>
											)]))}
									{name === "2D Root" && ghostLayers.map((layer) => layer.waypointFrames.map((f) => (
										<span
											key={`${layer.owner}:${f}`}
											className="tl-marker wp ghost"
											style={{ "--tl-f": framePct(f, displayFrameCount) }}
											title={`${layer.owner} · frame ${f}`}
										/>
									)))}
									{name === "2D Root" &&
										[...waypoints.map((waypoint) => waypoint.frame), ...(pendingWaypointFrame == null || waypoints.some((waypoint) => waypoint.frame === pendingWaypointFrame) ? [] : [pendingWaypointFrame])].map((f) => (
											<span
												key={f}
												className={"tl-marker wp" + (f === pendingWaypointFrame ? " pending" : "")}
												style={{ "--tl-f": framePct(f, displayFrameCount) }}
												title={ko(`Root waypoint at frame ${f} — click to select, right-click to remove; drag marker ${waypointFrames.indexOf(f) + 1} in Top-View to move`, `${f}프레임의 루트 웨이포인트 — 클릭해 선택, 오른쪽 클릭으로 삭제. 탑뷰에서 ${waypointFrames.indexOf(f) + 1}번 마커를 드래그해 이동`, `第 ${f} 帧的根路径点 — 点击选中，右键删除；在顶视图中拖动第 ${waypointFrames.indexOf(f) + 1} 个标记移动`)}
												onPointerDown={(e) => {
													// Select only on the primary button — a right click
													// must reach contextmenu so it removes without scrubbing.
													if (e.button !== 0) return;
													e.stopPropagation();
													waypoints.find((waypoint) => waypoint.frame === f) ? handlers.current.onMarkerSelect?.(waypoints.find((waypoint) => waypoint.frame === f).id) : handlers.current.onRootKeyframeAdd?.(f);
												}}
												onContextMenu={(e) => {
													e.preventDefault();
													e.stopPropagation();
													const waypoint = waypoints.find((entry) => entry.frame === f);
											if (waypoint) handlers.current.onMarkerRemove?.(waypoint.id);
												}}
											/>
										))}
									{name === SHOTS_LANE && shots.flatMap((shot, index) => (shot.cameraKeys ?? []).map((key) => (
										<span
											key={`${shot.id}:${key.frame}`}
											className="tl-marker cam" data-edge={key.frame <= shot.startFrame ? "start" : key.frame >= shot.endFrame ? "end" : undefined}
											style={{ "--tl-f": framePct(key.frame, displayFrameCount) }}
											title={ko(`Camera key at frame ${key.frame} — click to jump, drag to re-time, right-click to remove`, `${key.frame}프레임의 카메라 키 — 클릭해 이동, 드래그로 시간 변경, 오른쪽 클릭으로 삭제`, `第 ${key.frame} 帧的摄影机关键帧 — 点击跳转，拖动改变时间，右键删除`)}
											onPointerDown={(e) => beginCameraKeyDrag(e, key, index)}
											onPointerMove={moveCameraKeyDrag}
											onPointerUp={endCameraKeyDrag}
											onPointerCancel={endCameraKeyDrag}
											onClick={(e) => onCameraKeyClick(e, key, index)}
											onContextMenu={(e) => {
												e.preventDefault();
												e.stopPropagation();
												handlers.current.onCameraKeyframeRemove?.(shot.id, key.id);
											}}
										/>
									)))}
								</div>
							</div>
						))}

						<div className="tl-playhead" style={{ "--tl-f": framePct(frame, displayFrameCount) }} aria-hidden="true" />
						</div>
					</div>
				</>
			) : (
				<div className="tl-collapsed">
					{badge && <span className={"tl-badge " + badge.kind}>{badge.label}</span>}
					{waypointMode && (
						<span className={"tl-wp-hint" + (waypointFrames.length < 2 ? " warn" : "")}>
							{waypointFrames.length < 2
								? ko("Click the set floor in the Shot view to add waypoints", "샷 뷰의 세트 바닥을 클릭해 웨이포인트를 추가하세요", "在镜头视图中点击布景地面添加路径点")
								: ko(`${waypointFrames.length} root waypoints · click the set floor to add more`, `루트 웨이포인트 ${waypointFrames.length}개 · 세트 바닥을 클릭해 더 추가`, `${waypointFrames.length} 个根路径点 · 点击布景地面继续添加`)}
						</span>
					)}
					<button
						type="button"
						className="tl-toggle"
						aria-expanded="false"
						aria-label={ko("Expand timeline", "타임라인 펼치기")}
						title={ko("Expand timeline", "타임라인 펼치기")}
						onClick={() => setExpanded(true)}
					>
						▸
					</button>
				</div>
			)}
		</section>
	);
}
