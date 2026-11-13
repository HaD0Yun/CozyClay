#!/usr/bin/env node
// C11 (docs/motion-api-v3.1.md): verify_result contact_sheet frames "beats" and visual "trace".
// The frame choice runs on synthetic timeline and QA inputs (lanes B and C fill the real ones);
// the trace and the binding path run on a real compile of the cup scene. Then explicit frames and
// views of its own (front/side/three-quarter/top, focus, trail) on a cup pick-up, and the view a
// sheet adds when the asked ones look along nearly one line (depthViews).
import * as THREE from "three";
import { viewCameras, trailPoints, projectPoint, depthViews } from "../../src/motion3/views.js";
import { beatFrames, grabReleases, traceSeries } from "../../src/motion3/beats.js";
import { studioVisual, traceRgba } from "../../src/studio-motion-visual.js";
import { sampleContactSheetFrames, CONTACT_SHEET_LAYOUT } from "../../src/studio-contact-sheet.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = JSON.stringify;
const spaced = frames => frames.every((f, i) => i === 0 || f - frames[i - 1] > 3);

// ---- beats on synthetic inputs ------------------------------------------------------------
const timeline = [
	{ beat: "standIdle", src: "use[0]", f: [0, 11], events: [] },
	{ beat: "walkTo", src: "use[1]", f: [12, 86], events: [] },
	{ beat: "reachGrip", src: "use[2]", f: [87, 140], events: [{ f: 104, object: "empty-2", event: "grab" }, { f: 106, object: "empty-2", event: "show" }] },
	{ beat: "keys", src: "keys", f: [141, 279], events: [{ f: 160, object: "empty-2", event: "release" }] },
];
const groups = [
	{ kind: "GOAL", subject: "cup at mouth: 0.31 m at f150 (needs <= 0.06)", worstFrame: 150 },
	{ kind: "COLLIDE", subject: "thigh_r x cube", worstFrame: 62 },
	{ kind: "SLIDE", subject: "foot_l", worstFrame: 200 },
];
const even = sampleContactSheetFrames("whole_clip", 280);
const beats = beatFrames({ range: [0, 279], even, timeline, groups });
expect("beats: at most 6 frames, ascending, inside the range", beats.frames.length === 6 && json(beats.frames) === json([...beats.frames].sort((a, b) => a - b)) && beats.frames.every(f => f >= 0 && f <= 279), json(beats.frames));
expect("beats: one pick per frame with its reason", json(beats.picks.map(p => p.f)) === json(beats.frames) && beats.picks.every(p => typeof p.why === "string" && p.why));
const why = Object.fromEntries(beats.picks.map(p => [p.f, p.why]));
expect("beats: grab and release frames come first", why[104] === "grab empty-2" && why[160] === "release empty-2", json(beats.picks));
expect("beats: then beat starts (frame 0, 12, 87, 141)", why[0] === "start standIdle" && why[12] === "start walkTo" && why[87] === "start reachGrip" && why[141] === "start keys", json(beats.picks));
expect("beats: no two picks within +-3 frames", spaced(beats.frames), json(beats.frames));
expect("beats: the same inputs pick the same frames", json(beatFrames({ range: [0, 279], even, timeline, groups })) === json(beats));

const worst = beatFrames({ range: [0, 279], even, timeline: [], groups });
expect("beats: the top 2 groups' worstFrame, then even fill", worst.picks.some(p => p.f === 150 && p.why === "worst GOAL cup at mouth") && worst.picks.some(p => p.f === 62 && p.why === "worst COLLIDE thigh_r x cube")
	&& !worst.frames.includes(200) && worst.picks.filter(p => p.why === "even").length === 4, json(worst.picks));
expect("beats: even fill keeps clear of the picks", worst.frames.length === 6 && spaced(worst.frames), json(worst.frames));

const dup = beatFrames({ range: [0, 279], even, timeline: [{ beat: "keys", f: [102, 120], events: [{ f: 104, object: "cup", event: "grab" }] }], groups: [{ kind: "GOAL", subject: "x", worstFrame: 106 }] });
expect("beats: a beat start or worst frame within 3 of the grab is dropped", dup.picks.filter(p => p.f >= 100 && p.f <= 108).length === 1 && why[104] === "grab empty-2", json(dup.picks));

const crowded = beatFrames({ range: [0, 279], even, timeline: Array.from({ length: 10 }, (_, i) => ({ beat: `b${i}`, f: [i * 25, i * 25 + 20], events: [] })), groups });
expect("beats: never more than 6 even with 10 beat starts", crowded.frames.length === 6 && crowded.picks.every(p => p.why.startsWith("start ")), json(crowded.picks));

const outside = beatFrames({ range: [24, 71], even: sampleContactSheetFrames({ startFrame: 24, endFrameExclusive: 72 }, 280), timeline, groups });
expect("beats: frames outside the requested range are never picked", outside.frames.every(f => f >= 24 && f <= 71) && outside.picks.some(p => p.f === 62), json(outside.picks));

const empty = beatFrames({ range: [0, 279], even });
expect("beats: with no timeline, events or QA it answers the even frames", json(empty.frames) === json(even) && empty.picks.every(p => p.why === "even"), json(empty.frames));
expect("beats: undefined inputs (a take that did not compile) degrade to even", json(beatFrames({ range: [0, 279], even, timeline: undefined, groups: undefined, objects: undefined }).frames) === json(even));
expect("grabReleases: timeline events, then spec.objects grab/release", json(grabReleases(timeline, { cylinder: { prop: "grip", grab: 20, release: 40 }, door: { pivot: [0, 0, 0] } }).map(r => r.why))
	=== json(["grab cylinder", "release cylinder", "grab empty-2", "release empty-2"]));

// ---- trace on a real compile --------------------------------------------------------------
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 48, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"] } },
	keys: [{ f: 10, set: { armw_r: 1, hand_r: [-0.25, 0.95, 0.25] } }, { f: 30, set: { armw_r: 1, hand_r: [-0.2, 1.4, 0.3] } }],
	objects: { cylinder: { prop: "grip", grab: 20, release: 40 } },
	goals: [{ name: "cup up", near: ["object:cylinder.top", "landmark:mouth"], tol: 0.06, at: [30, 40] }] };
const r = compileSpec(spec, { sk, scene }, { lenient: true });
const trace = traceSeries(r.out, r.expanded, [0, 99]);
const named = Object.fromEntries(trace.series.map(s => [s.name, s]));
expect("trace: the range is clamped to the compiled frames", json(trace.range) === "[0,47]", json(trace.range));
expect("trace: hand heights, the near goal and the carried object's grip", json(Object.keys(named)) === json(["hand_l.y", "hand_r.y", "near cup up", "grip to cylinder"]), json(Object.keys(named)));
const hand = named["hand_r.y"];
expect("trace: min/max with the frames they happen at", hand && hand.max === Math.max(...hand.values) && hand.values[hand.maxAt] === hand.max && hand.values[hand.minAt] === hand.min && hand.maxAt === 30 && Math.abs(hand.max - 1.4) < 0.02, json({ ...hand, values: undefined }));
expect("trace: one value per frame, colours and units", trace.series.every(s => s.values.length === 48 && /^#[0-9a-f]{6}$/.test(s.color) && s.unit === "m") && named["hand_l.y"].color === "#d1495b");

const plot = traceRgba(trace.series, trace.range, { width: 200, height: 100, marks: [20] });
const px = (x, y) => Array.from(plot.data.subarray((y * plot.width + x) * 4, (y * plot.width + x) * 4 + 4));
const colourRows = hex => { const [cr, cg, cb] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)), rows = []; for (let y = 0; y < plot.height; y++) for (let x = 0; x < plot.width; x++) { const [pr, pg, pb] = px(x, y); if (pr === cr && pg === cg && pb === cb) rows.push({ x, y }); } return rows; };
expect("trace raster: RGBA of the asked size, opaque", plot.width === 200 && plot.height === 100 && plot.data.length === 200 * 100 * 4 && px(0, 0)[3] === 255 && px(199, 99)[3] === 255);
const right = colourRows(hand.color), atX = x => right.filter(p => p.x === x).map(p => p.y);
const x0 = 12, x30 = Math.round(12 + (30 / 47) * 176);
expect("trace raster: the right hand's line is drawn in its colour", right.length > 100, String(right.length));
expect("trace raster: rows run bottom-up, so the raised hand sits at a higher row", Math.min(...atX(x30)) > Math.max(...atX(x0)), json({ start: atX(x0), raised: atX(x30) }));
const bare = traceRgba([], trace.range, { width: 200, height: 100, marks: [20] }), markX = Math.round(12 + (20 / 47) * 176);
const light = Array.from({ length: 76 }, (_, i) => Array.from(bare.data.subarray(((12 + i) * 200 + markX) * 4, ((12 + i) * 200 + markX) * 4 + 3))).filter(p => json(p) === "[150,154,164]").length;
expect("trace raster: a mark draws a light vertical inside the plot margins", light === 76, String(light));
expect("trace raster: no series still draws an empty plot", traceRgba([], [0, 0], { width: 10, height: 10 }).data.length === 400);

// ---- the binding path: studioVisual with ports and a state as the binding passes them -----
const take = { schema: "cozyclay.take.v3", rig: sk.model, spec };
const state = (motion = take) => ({ revision: 7, frameCount: 48, objects: SCENE_OBJECTS, characters: [CHARACTER], targets: new Map([[CHARACTER.id, { motion }]]) });
const rendered = [], encoded = [];
const ports = {
	renderFrameBuffer: frame => { rendered.push(frame); return { data: new Uint8Array(8 * 4 * 4).fill(frame), width: 8, height: 4 }; },
	encodePng: (data, size) => { encoded.push({ length: data.length, width: size.width, height: size.height }); return "data:image/png;base64,AAAA"; },
	capture: () => ({ dataUrl: "data:image/png;base64,BBBB", width: 4, height: 4 }),
};
const run = (args, s = state()) => {
	const images = new Map(), result = { receiptId: null, visualRefs: [] };
	rendered.length = 0; encoded.length = 0;
	studioVisual({ visual: "none", ...args }, { s, receipt: null, result, images, ports });
	return { images, ref: result.visualRefs[0] };
};
const evenRun = run({ visual: "contact_sheet", targets: [CHARACTER.id], range: "whole_clip" });
const evenFrames = sampleContactSheetFrames("whole_clip", 48);
expect("even (default): the same frames, layout and image record as before", json(evenRun.ref.frames) === json(evenFrames) && evenRun.ref.layout === CONTACT_SHEET_LAYOUT && !("picks" in evenRun.ref)
	&& json(Object.keys(evenRun.images.get(evenRun.ref.imageId))) === json(["dataUrl", "width", "height", "frames", "layout", "revision", "receiptId"]) && json(rendered) === json(evenFrames), json(evenRun.ref));
const beatRun = run({ visual: "contact_sheet", frames: "beats", targets: [CHARACTER.id], range: "whole_clip" });
expect("beats: the installed take's spec is compiled again; its grab and release are picked", beatRun.ref.picks.some(p => p.f === 20 && p.why === "grab cylinder") && beatRun.ref.picks.some(p => p.f === 40 && p.why === "release cylinder")
	&& beatRun.ref.frames.length <= 6 && json(rendered) === json(beatRun.ref.frames), json(beatRun.ref));
const noTake = run({ visual: "contact_sheet", frames: "beats", targets: [CHARACTER.id], range: "whole_clip" }, state(null));
expect("beats without a take: the even frames", json(noTake.ref.frames) === json(evenFrames) && noTake.ref.picks.every(p => p.why === "even"), json(noTake.ref));
const traceRun = run({ visual: "trace", targets: [CHARACTER.id] });
expect("trace: visualRefs[0] = { imageId, kind, range, series } without the raw values", traceRun.ref.kind === "trace" && json(traceRun.ref.range) === "[0,47]" && traceRun.ref.series.length === 4
	&& traceRun.ref.series.every(s => !("values" in s) && "minAt" in s && "maxAt" in s), json(traceRun.ref));
expect("trace: one PNG through the encodePng port, kept for resolve_studio_image", encoded.length === 1 && encoded[0].length === encoded[0].width * encoded[0].height * 4 && traceRun.images.get(traceRun.ref.imageId)?.kind === "trace", json(encoded));
let refused = "";
try { run({ visual: "trace", targets: [CHARACTER.id] }, state(null)); } catch (error) { refused = `${error.code}: ${error.message}`; }
expect("trace without a take is TARGET_NOT_READY", refused.startsWith("TARGET_NOT_READY"), refused);
const frameRun = run({ visual: "frame", targets: [CHARACTER.id] });
expect("frame: the capture port, unchanged", frameRun.ref && Object.keys(frameRun.ref).length === 1 && frameRun.images.get(frameRun.ref.imageId)?.revision === 7);

// ---- explicit frames ----------------------------------------------------------------------
const chosen = run({ visual: "contact_sheet", frames: [40, 5, 20], targets: [CHARACTER.id], range: "whole_clip" });
expect("frames [f, ...]: those frames, ascending, rendered in order, 3x2 like even", json(chosen.ref.frames) === "[5,20,40]" && json(rendered) === "[5,20,40]" && chosen.ref.layout === CONTACT_SHEET_LAYOUT && !("picks" in chosen.ref), json(chosen.ref));
const eight = run({ visual: "contact_sheet", frames: [0, 6, 12, 18, 24, 30, 36, 42], targets: [CHARACTER.id] });
expect("frames: 7-8 frames tile 4x2", eight.ref.layout === "4x2 row-major" && eight.ref.frames.length === 8 && encoded[0].width === 32 && encoded[0].height === 8, json({ ref: eight.ref, encoded }));
// a frame past the range is drawn at its nearest end and the ref says so (lenient.js), instead of a refused call
const pastEnd = run({ visual: "contact_sheet", frames: [10, 60, 70], targets: [CHARACTER.id], range: { startFrame: 0, endFrameExclusive: 48 } });
expect("frames outside the range are drawn at its end, named in ref.adjusted", json(pastEnd.ref.frames) === "[10,47]" && pastEnd.ref.adjusted === "frames 60, 70 lie outside 0..47: drawn at 47", json(pastEnd.ref));

// ---- views of its own on a cup pick-up ----------------------------------------------------
// The left hand's fingers land on the cup handle and the cup group rides the hand 34..80
// (the spec of verify-motion3-cup.mjs).
const cupSpec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100, use: [{ skill: "standIdle", args: { at: [0.15, 0.3], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } },
	anchors: { cupHandle: { kind: "object", object: "cube-6", local: [0, 0.03, 0] } },
	fits: [{ side: "l", anchor: "cupHandle", effector: { prop: "grip", point: "fingers" } }],
	keys: [{ f: 10, set: { pitch: 0, armw_l: 0, w_cupHandle_l: 0 } }, { f: 30, set: { pitch: 25, armw_l: 1, w_cupHandle_l: 1, hand_l: [0.3, 1, 0.7] } },
		{ f: 36, set: { w_cupHandle_l: 1, pitch: 25, hand_l: [0.3, 1, 0.7] } }, { f: 60, set: { w_cupHandle_l: 0, pitch: 10, hand_l: [0.3, 1.2, 0.6] } }, { f: 99, set: {} }],
	objects: { [CUP.group]: { prop: "grip", grab: 34, release: 80 } } };
const cup = compileSpec(cupSpec, { sk, scene }, { lenient: true }), cupFrames = [20, 34, 50, 70];
const cupTrail = [{ ref: `object:${CUP.group}`, points: trailPoints(cup.out, `object:${CUP.group}`, [0, 99]) }];
const focus = [`object:${CUP.group}`, "joint:LeftHand"];
const VIEW_NAMES = ["front", "side", "three-quarter", "top"];
const cams = viewCameras(cup.out, { views: VIEW_NAMES, frames: cupFrames, focus, trails: cupTrail });
const byName = Object.fromEntries(cams.map(c => [c.name, c]));
expect("views: the same compile and arguments give the same cameras", json(viewCameras(cup.out, { views: VIEW_NAMES, frames: cupFrames, focus, trails: cupTrail })) === json(cams));
const towards = (c, axis) => (c.eye[axis] - c.target[axis]) / Math.hypot(...c.eye.map((v, i) => v - c.target[i]));
expect("views: front stands before the character (it faces +Z)", towards(byName.front, 2) > 0.9, json(byName.front.eye));
expect("views: side and three-quarter look from the cup's side (its left, +X)", towards(byName.side, 0) > 0.9 && towards(byName["three-quarter"], 0) > 0.5 && towards(byName["three-quarter"], 2) > 0.5, json([byName.side.eye, byName["three-quarter"].eye]));
expect("views: top looks straight down", towards(byName.top, 1) > 0.999, json(byName.top.eye));
const inside = (c, p) => { const q = projectPoint(c, p, 400, 400); return q && q[0] > 0 && q[0] < 400 && q[1] > 0 && q[1] < 400; };
const cupAt = f => cupTrail[0].points.find(q => q.f === f).p, handAt = f => cup.out.frames[f].s.P[sk.index.LeftHand];
expect("views: the cup and the hand are inside every view at every frame", cams.every(c => cupFrames.every(f => inside(c, cupAt(f)) && inside(c, handAt(f)))));
const span = c => { const qs = cupFrames.flatMap(f => [cupAt(f), handAt(f)]).map(p => projectPoint(c, p, 400, 400)); return Math.max(...qs.map(q => q[1])) - Math.min(...qs.map(q => q[1])) + Math.max(...qs.map(q => q[0])) - Math.min(...qs.map(q => q[0])); };
const wide = viewCameras(cup.out, { views: ["front"], frames: cupFrames })[0];
expect("views: a focus fills the tile (the cup and hand span over twice what the whole-character framing gives)", span(byName.front) > 2 * span(wide), `${span(byName.front).toFixed(0)} vs ${span(wide).toFixed(0)} px`);
const body = viewCameras(cup.out, { views: ["top"], frames: cupFrames })[0], depths = cupFrames.flatMap(f => cup.out.frames[f].s.P).map(p => -((p[0] - body.eye[0]) * body.back[0] + (p[1] - body.eye[1]) * body.back[1] + (p[2] - body.eye[2]) * body.back[2]));
expect("views: a deep subject (the body from above) keeps perspective mild: far side <= 1.8x the near side, a longer lens", Math.max(...depths) / Math.min(...depths) <= 1.8 + 1e-6 && body.fovDeg < 35 && body.fovDeg >= 12, json({ ratio: Math.max(...depths) / Math.min(...depths), fov: body.fovDeg }));
const three = new THREE.PerspectiveCamera(byName["three-quarter"].fovDeg, 1, 0.1, 100);
three.position.set(...byName["three-quarter"].eye); three.quaternion.set(...byName["three-quarter"].quaternion); three.updateMatrixWorld();
const ndc = new THREE.Vector3(...cupAt(50)).project(three), mine = projectPoint(byName["three-quarter"], cupAt(50), 400, 400);
expect("views: the quaternion is the camera the projection uses (three.js agrees)", Math.abs((ndc.x + 1) * 200 - mine[0]) < 1e-6 && Math.abs((ndc.y + 1) * 200 - mine[1]) < 1e-6, json({ ndc, mine }));

// The binding path: a strip of 2 views x 6 frames, square tiles, a trail painted on each tile.
const cupState = () => ({ ...state({ schema: "cozyclay.take.v3", rig: sk.model, spec: cupSpec }), frameCount: 100 });
const views = [], tiles = [];
ports.renderFrameBuffer = (frame, view) => { rendered.push(frame); views.push(view); const data = new Uint8Array(view.output.width * view.output.height * 4).fill(40); tiles.push(data); return { data, width: view.output.width, height: view.output.height }; };
const viewRun = run({ visual: "contact_sheet", frames: [10, 30, 34, 50, 70, 90], views: ["front", "side"], focus, trail: `object:${CUP.group}`, targets: [CHARACTER.id] }, cupState());
expect("views: a row per view, a column per frame, one render per cell", viewRun.ref.layout === "6x2 row-major, a row per view" && json(rendered) === json([10, 30, 34, 50, 70, 90, 10, 30, 34, 50, 70, 90]), json(viewRun.ref));
expect("views: every cell is a square of 266 px, so the sheet is 1596x532 (within 1600x900)", views.every(v => v.output.width === 266 && v.output.height === 266 && v.fovDeg >= 12 && v.fovDeg <= 35 && v.quaternion.length === 4) && encoded[0].width === 1596 && encoded[0].height === 532, json(encoded));
expect("views: visualRefs name the views, the focus and the trail colour; front and side add nothing", json(viewRun.ref.views.map(v => v.name)) === '["front","side"]' && !("addedView" in viewRun.ref) && viewRun.ref.views.every(v => v.eye.length === 3 && v.target.length === 3)
	&& json(viewRun.ref.focus) === json(focus) && json(viewRun.ref.trails) === json([{ ref: `object:${CUP.group}`, color: "#d1495b" }]), json(viewRun.ref));
const painted = data => { let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i] === 209 && data[i + 1] === 73 && data[i + 2] === 91) n++; return n; };
expect("views: the trail is painted on every tile (solid dots up to the tile's frame)", tiles.every(t => painted(t) > 20) && painted(tiles[5]) > painted(tiles[0]), json(tiles.map(painted)));
// One view hides depth along its own line: top alone gets side, a row each (it was a 3x2 grid of top).
const topRun = run({ visual: "contact_sheet", views: ["top"], targets: [CHARACTER.id] }, cupState());
expect("views: top alone also renders side, a row per view over 6 even frames, at most 1600x900", topRun.ref.layout === "6x2 row-major, a row per view" && json(topRun.ref.views.map(v => v.name)) === '["top","side"]'
	&& topRun.ref.addedView?.view === "side" && topRun.ref.focus === "character" && encoded[0].width === 1596 && encoded[0].height === 532, json({ ref: topRun.ref, encoded }));

// ---- the view a sheet adds -------------------------------------------------------------------
// Session df388a9b looked at a guitarist with front and three-quarter only (45 degrees apart):
// the right hand 20 cm in front of the guitar showed in neither. A sheet holds two views at
// least 60 degrees apart, adding the first of side, front and top that does it.
const added = views => { const d = depthViews(views); return `${json(d.views)} ${d.added?.view ?? "-"}`; };
expect("depthViews: front and three-quarter get side; front, side or top alone get side or front; three-quarter alone gets top", added(["front", "three-quarter"]) === '["front","three-quarter","side"] side'
	&& added(["front"]) === '["front","side"] side' && added(["side"]) === '["side","front"] front' && added(["top"]) === '["top","side"] side' && added(["three-quarter"]) === '["three-quarter","top"] top'
	&& added(["side", "three-quarter"]) === '["side","three-quarter","front"] front', json(["front", "side", "top", "three-quarter"].map(v => added([v]))));
expect("depthViews: two views 60+ degrees apart are kept as asked", added(["front", "side"]) === '["front","side"] -' && added(["front", "top"]) === '["front","top"] -' && added(["three-quarter", "top"]) === '["three-quarter","top"] -' && added(["side", "top"]) === '["side","top"] -');
expect("depthViews: the reason names the asked views, their angle and the added view", /^front and three-quarter look along nearly one line \(45 degrees apart\), .*; side looks across it$/.test(depthViews(["front", "three-quarter"]).added.reason), depthViews(["front", "three-quarter"]).added.reason);
views.length = 0; rendered.length = 0;
const guitarLike = run({ visual: "contact_sheet", frames: [10, 30, 34, 50, 70, 90], views: ["front", "three-quarter"], focus, targets: [CHARACTER.id] }, cupState());
expect("views: front and three-quarter render a third row, side, and say why in visualRefs[0].addedView", guitarLike.ref.layout === "6x3 row-major, a row per view" && rendered.length === 18
	&& json(guitarLike.ref.views.map(v => v.name)) === '["front","three-quarter","side"]' && guitarLike.ref.addedView.view === "side" && /45 degrees apart/.test(guitarLike.ref.addedView.reason), json(guitarLike.ref));
expect("views: the three rows stay within 1600x900 (266 px tiles, 1596x798)", views.every(v => v.output.width === 266) && encoded[0].width === 1596 && encoded[0].height === 798, json(encoded));
const sideCam = viewCameras(cup.out, { views: ["side"], frames: [10, 30, 34, 50, 70, 90], focus })[0], sideEye = guitarLike.ref.views[2].eye;
expect("views: the added side is the same camera side gives when asked", json(sideEye) === json(sideCam.eye.map(v => Math.round(v * 100) / 100)), json([sideEye, sideCam.eye]));
const refusal = (args, s = cupState()) => { try { run(args, s); return ""; } catch (error) { return `${error.code}: ${error.message}`; } };
expect("views: focus without views is refused, naming views", /^INVALID_ARGUMENT: focus and trail are drawn by views/.test(refusal({ visual: "contact_sheet", focus: "joint:LeftHand", targets: [CHARACTER.id] })));
expect("views: views on another visual are refused", /^INVALID_ARGUMENT: views, focus and trail shape a contact sheet/.test(refusal({ visual: "frame", views: ["front"], targets: [CHARACTER.id] })));
expect("views: an unknown ref is refused with the ref grammar's message", /^INVALID_ARGUMENT: focus\[0\] "object:mug"/.test(refusal({ visual: "contact_sheet", views: ["front"], focus: "object:mug", targets: [CHARACTER.id] })), refusal({ visual: "contact_sheet", views: ["front"], focus: "object:mug", targets: [CHARACTER.id] }));
expect("views: no take is TARGET_NOT_READY", /^TARGET_NOT_READY/.test(refusal({ visual: "contact_sheet", views: ["front"], targets: [CHARACTER.id] }, state(null))));

if (failures) process.exit(1);
console.log("verify-motion3-visual: all checks PASS");
