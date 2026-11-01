// verify_result's visual: the one image the agent asks to see. "frame" and "plan" are captures;
// "contact_sheet" tiles frames spread evenly, picked from the installed take's beats
// (frames: "beats") or named (frames: [f, ...]), seen by the shot camera or by views of its own
// (views, focus, trail); "trace" plots hand heights and distances of the take over the range (C11).
// The beats, the views and the trace read one lenient compile of the take's stored spec, as motion.qa does.
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { buildContactSheet, paintDots, sampleContactSheetFrames, sheetGrid, viewTileSide } from "./studio-contact-sheet.js";
import { compileSpec } from "./motion3/pipeline.js";
import { motionScene } from "./motion3/scene.js";
import { skeletonFor } from "./motion3/rigs/index.js";
import { actionFrames, beatFrames, grabReleases, traceSeries, TRACE_COLORS } from "./motion3/beats.js";
import { blockersAt } from "./motion3/sightline.js";
import { cameraAt, depthViews, focusPoints, projectPoint, trailPoints, viewCameras } from "./motion3/views.js";
import { checkRef } from "./motion3/refs.js";
import { renderWithGhosts } from "./ghost-set.js";
import { GHOST_COLORS, sheetGhostSettings } from "./view-ghosts.js";
import { publishSheet } from "./agent-progress.js";
import { clampFrames } from "./motion3/lenient.js";
import { sheetCaption } from "./workflow/agent-progress-view.js";
// verify_result's lighting check also reads the rendered shot frame; the binding imports it from here.
export { verifyLighting } from "./studio-lighting-check.js";

const HIDDEN_SHARE = 0.5, TIMELINE_FPS = 24, TRACE_WIDTH = 960, TRACE_HEIGHT = 360, PAD = 12;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** [first, last] absolute frames of a verify_result range ("whole_clip" or none: the timeline). */
const rangeOf = (range, frameCount) => range && range !== "whole_clip" ? [range.startFrame, range.endFrameExclusive - 1] : [0, frameCount - 1];

/** The first subject character with a compiled take, compiled again (null when none or it fails). */
function takeCompile(args, s, receipt) {
	for (const id of args.targets ?? receipt?.affectedIds ?? []) {
		const character = s.characters.find(c => c.id === id), take = s.targets.get(id)?.motion;
		const sk = take?.schema === "cozyclay.take.v3" && take.spec ? skeletonFor(take.rig ?? character?.model) : null;
		if (!character || !sk) continue;
		try {
			return { ...compileSpec({ fps: TIMELINE_FPS, ...take.spec }, { sk, scene: motionScene(s.objects) }, { lenient: true }), characterId: id };
		} catch { return null; }
	}
	return null;
}

/**
 * Line series on a dark plot, as RGBA rows bottom-up (WebGL read-back order, what the encodePng
 * port flips): x is frames lo..hi, y one metre scale for every series. Grey lines mark each second
 * and every 0.1 m; `marks` are frames drawn as light verticals (beat starts, grab, release).
 */
export function traceRgba(series, [lo, hi], { width = TRACE_WIDTH, height = TRACE_HEIGHT, marks = [] } = {}) {
	const data = new Uint8Array(width * height * 4);
	const put = (x, y, [r, g, b]) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const i = (y * width + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
	};
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, [22, 24, 29]);
	let bottom = Math.min(...series.map(s => s.min)), top = Math.max(...series.map(s => s.max));
	if (!(top > bottom)) { bottom = (Number.isFinite(bottom) ? bottom : 0) - 0.05; top = bottom + 0.1; }
	const X = f => Math.round(PAD + ((f - lo) / Math.max(1, hi - lo)) * (width - 2 * PAD));
	const Y = v => Math.round(PAD + ((v - bottom) / (top - bottom)) * (height - 2 * PAD));
	for (let m = Math.ceil(bottom * 10); m <= top * 10; m++) for (let x = PAD; x < width - PAD; x++) put(x, Y(m / 10), m === 0 ? [90, 94, 104] : [44, 47, 55]);
	for (let f = Math.ceil(lo / TIMELINE_FPS) * TIMELINE_FPS; f <= hi; f += TIMELINE_FPS) for (let y = PAD; y < height - PAD; y++) put(X(f), y, [44, 47, 55]);
	for (const f of marks) if (f >= lo && f <= hi) for (let y = PAD; y < height - PAD; y++) put(X(f), y, [150, 154, 164]);
	for (const s of series) {
		const color = rgb(s.color);
		for (let i = 1; i < s.values.length; i++) {
			const a = s.values[i - 1], b = s.values[i];
			if (a === null || b === null) continue;
			const x0 = X(lo + i - 1), y0 = Y(a), x1 = X(lo + i), y1 = Y(b), n = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
			for (let k = 0; k <= n; k++) {
				const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
				put(x, y, color); put(x + 1, y, color); put(x, y + 1, color); put(x + 1, y + 1, color);
			}
		}
	}
	return { data, width, height };
}

const listOf = value => value === undefined ? [] : [value].flat();
const round2 = p => p.map(v => Math.round(v * 100) / 100);

/**
 * A contact sheet from views of its own (motion3/views.js), a row per view, never the shot
 * camera: each view is placed once for every frame, framed on args.focus (default the whole
 * character) and the trails. A trail is a dot per frame of its ref over the range, so spacing is
 * speed: frames up to the tile's frame solid, later ones faint, the tile's frame ringed. With
 * args.ghosts every tile also draws the take's poses around its frame (ghost-set.js). args.views
 * are the rendered ones (depthViews); `added` names the view added to them and why.
 */
function viewSheet(args, r, { s, frames, span, grid, picks, ports, added }) {
	if (!r) throw new StudioProtocolError("TARGET_NOT_READY", "views frame a character's compiled take; name a character that has one (run motion.compile first).");
	const focus = listOf(args.focus), refs = listOf(args.trail), ctx = { sk: r.out.ctx.sk, scene: r.out.ctx.scene };
	for (const [field, list] of [["focus", focus], ["trail", refs]]) list.forEach((ref, i) => checkRef(r.expanded, message => { throw new StudioProtocolError("INVALID_ARGUMENT", message); }, ctx, `${field}[${i}]`, ref));
	const trails = refs.map((ref, i) => ({ ref, color: TRACE_COLORS[i], points: trailPoints(r.out, ref, span) }));
	const side = viewTileSide(grid), cameras = viewCameras(r.out, { views: args.views, frames, focus, trails });
	if (!cameras.length) throw new StudioProtocolError("TARGET_NOT_READY", "views found no compiled frame of the take in the range.");
	const cells = cameras.flatMap(cam => frames.map(frame => ({ cam, frame }))), target = args.ghosts ? s.targets.get(r.characterId) : null;
	if (args.ghosts && !target?.rig) throw new StudioProtocolError("TARGET_NOT_READY", "ghosts pose a copy of the character's rig; it has not loaded in the editor yet.");
	const seen = [];
	const sheet = buildContactSheet(cells, ({ cam: view, frame }) => {
		const cam = cameraAt(view, frame), { by: fade } = blockersAt(r.out, cam.eye, frame, focusPoints(r.out, frame, focus));
		if (fade.length) seen.push({ view: view.name, frame, objects: fade });
		const render = () => ports.renderFrameBuffer(frame, { eye: cam.eye, quaternion: cam.quaternion, fovDeg: cam.fovDeg, output: { width: side, height: side }, fade });
		const tile = target ? renderWithGhosts({ rig: target.rig, take: target.motion, objects: s.objects }, frame, render) : render();
		const dots = trails.flatMap(t => t.points.map(({ f, p }) => [f, projectPoint(cam, p, tile.width, tile.height), rgb(t.color)])
			.filter(([, q]) => q).map(([f, [x, y], color]) => ({ x, y, color, r: f === frame ? 4 : 1.5, alpha: f <= frame ? 1 : 0.35, ring: f === frame })));
		return { ...tile, data: paintDots(tile.data, tile.width, tile.height, dots) };
	}, grid);
	const views = cameras.map(cam => ({ name: cam.name, eye: round2(cam.eye), target: round2(cam.target), ...(cam.ride ? { rides: "focus" } : {}) }));
	const ref = { frames, layout: grid.layout, views, ...(added ? { addedView: added } : {}), focus: focus.length ? focus : "character", ...(trails.length ? { trails: trails.map(({ ref: of, color }) => ({ ref: of, color })) } : {}), ...(picks ? { picks } : {}),
		...(seen.length ? { seeThrough: seen } : {}),
		...(target ? { ghosts: { ...sheetGhostSettings(), ...GHOST_COLORS } } : {}) };
	return [{ dataUrl: ports.encodePng(sheet.data, sheet), width: sheet.width, height: sheet.height, frames, layout: grid.layout, views: views.map(v => v.name) }, ref];
}

/** The sheet frames a scene body hides at least HIDDEN_SHARE of the character from the shot camera: { hidden, hint }, or nothing. */
function shotHidden(r, frames, ports, scene) {
	if (!r || !scene || typeof ports.sampleStateAt !== "function") return {};
	const hidden = frames.flatMap(f => {
		const at = (ports.sampleStateAt(f, scene)?.camera ?? scene.camera)?.position;
		if (!at) return [];
		const { share, by } = blockersAt(r.out, [at.x, at.y, at.z], f);
		return share >= HIDDEN_SHARE ? [{ f, share, by }] : [];
	});
	return hidden.length ? { hidden, hint: "Scene bodies hide the character from the shot camera on these frames, so these tiles do not show the motion. Add views (own cameras draw what blocks them see-through) to check it, and move the shot camera if the export must show it." } : {};
}

/** Answers args.visual into result.visualRefs and keeps the image for resolve_studio_image. */
export function studioVisual(args, { s, receipt, result, images, ports, scene }) {
	const keep = (image, ref) => {
		const imageId = crypto.randomUUID();
		images.set(imageId, { ...image, revision: s.revision, receiptId: result.receiptId });
		result.visualRefs.push({ imageId, ...ref });
		// the user sees what the agent looked at (agent-progress.js: the agent panel's progress card)
		const kind = image.kind ?? (args.visual === "contact_sheet" ? "contact sheet" : args.visual);
		publishSheet({ characterId: args.targets?.[0] ?? receipt?.affectedIds?.[0] ?? null, dataUrl: image.dataUrl, width: image.width, height: image.height,
			caption: sheetCaption({ kind, views: image.views ?? [], frames: image.frames ?? [] }), frames: image.frames ?? [] });
	};
	if (args.visual !== "contact_sheet" && (args.views || args.focus || args.trail)) throw new StudioProtocolError("INVALID_ARGUMENT", 'views, focus and trail shape a contact sheet; send visual: "contact_sheet".');
	if (args.ghosts && (args.visual !== "contact_sheet" || !args.views)) throw new StudioProtocolError("INVALID_ARGUMENT", 'ghosts are drawn on a contact sheet from views of its own; send visual: "contact_sheet" with views, e.g. ["side"].');
	if (!args.views && (args.focus || args.trail)) throw new StudioProtocolError("INVALID_ARGUMENT", 'focus and trail are drawn by views of its own; add views, e.g. ["front", "side"] (the shot camera stays the user\'s).');
	if (args.visual === "contact_sheet") {
		// One image of frames across the range, each rendered through the export
		// path, which puts the playhead pose, shot camera and props back.
		const span = rangeOf(args.range, s.frameCount), r = args.frames === "beats" || args.views ? takeCompile(args, s, receipt) : null;
		let frames = sampleContactSheetFrames(args.range, s.frameCount), picks, adjusted;
		// named frames past the range are drawn at its nearest end, and visualRefs[0].adjusted says so (lenient.js)
		if (Array.isArray(args.frames)) ({ frames, adjusted } = clampFrames(args.frames, span));
		else if (args.frames === "beats") ({ frames, picks } = beatFrames({ range: span, even: frames, timeline: r?.timeline, groups: r?.qa.groups, objects: r?.expanded.objects, actions: r ? actionFrames(r.out, span, TIMELINE_FPS) : [] }));
		// Views of its own always include two that look across each other (motion3/views.js depthViews).
		const depth = args.views ? depthViews(args.views) : null, grid = sheetGrid(frames.length, depth?.views.length ?? 0);
		const said = ref => (adjusted ? { ...ref, adjusted } : ref);
		if (depth) { const [image, ref] = viewSheet({ ...args, views: depth.views }, r, { s, frames, span, grid, picks, ports, added: depth.added }); return keep(image, said(ref)); }
		const sheet = buildContactSheet(frames, ports.renderFrameBuffer, grid), hidden = shotHidden(r ?? takeCompile(args, s, receipt), frames, ports, scene);
		return keep({ dataUrl: ports.encodePng(sheet.data, sheet), width: sheet.width, height: sheet.height, frames, layout: grid.layout }, said({ frames, layout: grid.layout, ...(picks ? { picks } : {}), ...hidden }));
	}
	if (args.visual === "trace") {
		const r = takeCompile(args, s, receipt);
		if (!r) throw new StudioProtocolError("TARGET_NOT_READY", "visual trace plots a character's compiled take; name a character that has one (run motion.compile first).");
		const { range, series } = traceSeries(r.out, r.expanded, rangeOf(args.range, s.frameCount));
		const marks = [...(r.timeline ?? []).map(entry => entry.f?.[0]), ...grabReleases(r.timeline, r.expanded.objects).map(row => row.f)];
		const plot = traceRgba(series, range, { marks });
		return keep({ dataUrl: ports.encodePng(plot.data, plot), width: plot.width, height: plot.height, kind: "trace" },
			{ kind: "trace", range, series: series.map(({ values, ...summary }) => summary) });
	}
	// A frame is the shot camera's view; a plan is the Top View, the set from above
	// with names and the shot camera's wedge.
	const capture = args.visual === "plan" ? (ports.capturePlan ?? (() => { throw new StudioProtocolError("CAPABILITY_MISSING", "This editor cannot render the top view."); }))() : ports.capture();
	keep(capture, args.visual === "plan" ? { kind: "plan" } : {});
}
