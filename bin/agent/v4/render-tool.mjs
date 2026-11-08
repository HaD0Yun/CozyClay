// The v4 render tool (design 3.4): pictures of the installed take from cameras the model picks.
// It commits a changed track first (the editor renders the installed take), picks frames, builds a
// camera per cell, splits the cells into sheets no longer than longEdge, and asks the editor for each
// sheet through the live query v4_render (src/motion-v4/render/editor-render.js).
import { judgeCameras, trackingCameras, closeUpCamera, lookAt } from "../../../src/motion-v4/render/cameras.js";
import { pickFrames, contactPoints } from "../../../src/motion-v4/render/events.js";
import { blockersAt } from "../../../src/motion3/sightline.js";
import { projectPoint } from "../../../src/motion3/views.js";
import { centerOfMass } from "../../../src/motion3/qa/com.js";

const WIDE = { width: 500, height: 281 }, SQUARE = { width: 400, height: 400 };
const LONG_EDGE = 2000, MAX_CELLS = 32, MAX_COLUMNS = 8, MAX_TOTAL = 96, TEXT_MAX = 2000, TOUCH = 0.02, SINK = 0.01, SLIDE = 0.01, TRAIL_DOTS = 120;
const NAMED = ["judge", "side", "front", "track", "hands", "feet"];
const CLOSE = { hands: { palm_l: "hand_l", palm_r: "hand_r" }, feet: { sole_l: "foot_l", sole_r: "foot_r" } };
const COLORS = { com: [255, 210, 0], ok: [40, 200, 60], bad: [230, 40, 40], trail: [0, 190, 255] };
const r3 = v => v.map(x => Math.round(x * 1000) / 1000);

const vec = { type: "array", items: { type: "number" } };
const INPUT_SCHEMA = { type: "object", additionalProperties: false, required: [],
	properties: {
		views: { type: "array", items: { anyOf: [
			{ enum: NAMED },
			{ type: "object", additionalProperties: false, required: ["eye", "target"],
				properties: { name: { type: "string" }, eye: vec, target: vec, fovDeg: { type: "number" }, up: vec } }] } },
		frames: { anyOf: [{ type: "array", items: { type: "integer", minimum: 0 } }, { enum: ["events", "even"] }] },
		count: { type: "integer", minimum: 1, maximum: 24 },
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 },
		tile: { type: "object", additionalProperties: false, required: ["width", "height"],
			properties: { width: { type: "integer", minimum: 64, maximum: 1280 }, height: { type: "integer", minimum: 64, maximum: 1280 } } },
		longEdge: { type: "integer", minimum: 256, maximum: 2576 },
		labels: { type: "boolean" },
		overlay: { type: "object", additionalProperties: false,
			properties: { com: { type: "boolean" }, contacts: { type: "boolean" }, trail: { type: "boolean" } } } } };

const DESCRIPTION = [
	"Render the installed take and look at it. A changed track is committed first (the editor renders the installed take).",
	"views (default [\"judge\"]): \"judge\" = \"side\" + \"front\", the two fixed cameras of the judge's videos (the same placement as the bench renderer, framing the whole take);",
	"\"track\" follows the smoothed hips from the body's left; \"hands\" / \"feet\" are close-ups at the contact frames of those ends;",
	"or a custom { name, eye, target, fovDeg = 40, up }. Scene bodies between a camera and the character draw see-through.",
	"frames (default \"events\"): takeoff, apex and landing of each flight, palm and sole contact on/off, COM low and high, first and last, at least 3 frames apart, filled with even frames up to count;",
	"\"even\"; or a list of frame numbers. count (default 8), from/to limit the range.",
	"tile: tile size (default 500x281; close-ups 400x400). longEdge (default 2000): the sheet's long edge; the Claude Code binary shrinks any image above 2000 px.",
	"labels (default true): each tile names its view, frame and why. overlay: com (yellow ball and its floor point), contacts (green; red when sliding or 1 cm inside), trail (hips path, the current frame ringed).",
	"Layout: a row block per view, a column per frame. Units: metres, +Y up, the character faces +Z at yaw 0.",
].join(" ");

/** The arguments with defaults; throws on what the schema cannot say (js calls skip the schema). */
function checkArgs(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("render takes an object of arguments.");
	const known = Object.keys(INPUT_SCHEMA.properties), extra = Object.keys(args).filter(k => !known.includes(k));
	if (extra.length) throw new Error(`render: unknown argument ${extra.join(", ")}; known: ${known.join(", ")}.`);
	const int = (k, lo, hi, d) => {
		const v = args[k] ?? d;
		if (v !== undefined && !(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`render: ${k} must be an integer from ${lo} to ${hi}.`);
		return v;
	};
	const xyz = (v, what) => { if (!(Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) throw new Error(`render: ${what} must be 3 numbers.`); };
	const views = [];
	for (const v of [].concat(args.views ?? ["judge"])) {
		if (typeof v === "string") {
			if (!NAMED.includes(v)) throw new Error(`render: unknown view ${v}; views are ${NAMED.join(", ")} or { eye, target }.`);
			for (const name of v === "judge" ? ["side", "front"] : [v]) if (!views.includes(name)) views.push(name);
			continue;
		}
		xyz(v?.eye, "a custom view's eye"); xyz(v.target, "a custom view's target");
		if (v.up !== undefined) xyz(v.up, "a custom view's up");
		if (v.fovDeg !== undefined && !(v.fovDeg >= 1 && v.fovDeg <= 170)) throw new Error("render: a custom view's fovDeg must be from 1 to 170.");
		views.push(v);
	}
	if (!views.length) throw new Error("render: views is empty.");
	const frames = args.frames ?? "events";
	if (Array.isArray(frames) ? !frames.length || !frames.every(f => Number.isInteger(f) && f >= 0) : !["events", "even"].includes(frames)) throw new Error("render: frames must be \"events\", \"even\" or a non-empty list of frame numbers.");
	const tile = args.tile ?? null;
	if (tile && ![tile.width, tile.height].every(n => Number.isInteger(n) && n >= 64 && n <= 1280)) throw new Error("render: tile width and height must be integers from 64 to 1280.");
	const overlay = args.overlay && Object.values(args.overlay).some(Boolean) ? args.overlay : null;
	return { views, frames, tile, overlay, labels: args.labels ?? true, count: int("count", 1, 24, 8), from: int("from", 0, 1e9, 0), to: int("to", 0, 1e9), longEdge: int("longEdge", 256, 2576, LONG_EDGE) };
}

/** The tile scaled down (aspect kept) so one tile fits within longEdge. */
function fitTile(tile, longEdge) {
	const k = Math.min(1, longEdge / Math.max(tile.width, tile.height));
	return k === 1 ? tile : { width: Math.max(64, Math.floor(tile.width * k)), height: Math.max(64, Math.floor(tile.height * k)) };
}

/** Overlay dots of one cell in tile pixels (y from the bottom row, as paintDots reads them). */
function dotsFor(out, cam, f, tile, overlay, [lo, hi]) {
	const dots = [], put = (p, r, color, extra = {}) => { const q = p && projectPoint(cam, p, tile.width, tile.height); if (q) dots.push({ x: q[0], y: q[1], r, color, ...extra }); };
	if (overlay.trail) {
		const hips = out.ctx.sk.index.Hips, step = Math.max(1, Math.ceil((hi - lo + 1) / TRAIL_DOTS));
		for (let g = lo; g <= hi; g += step) put(out.frames[g].s.P[hips], 1.5, COLORS.trail, { alpha: g <= f ? 1 : 0.35 });
		put(out.frames[f].s.P[hips], 4, COLORS.trail, { ring: true });
	}
	if (overlay.contacts) {
		const before = f > 0 ? contactPoints(out, f - 1) : null;
		contactPoints(out, f).forEach((c, i) => {
			if (c.gap > TOUCH) return;
			const b = before?.[i], slide = b && b.gap <= TOUCH && b.key === c.key && Math.hypot(c.p[0] - b.p[0], c.p[2] - b.p[2]) > SLIDE;
			put(c.p, 4, slide || c.gap < -SINK ? COLORS.bad : COLORS.ok, { ring: true });
		});
	}
	if (overlay.com) {
		const c = centerOfMass(out.ctx.sk, out.frames[f].s);
		if (c) { put(c, 6, COLORS.com, { ring: true }); put([c[0], 0, c[2]], 3, COLORS.com); }
	}
	return dots;
}

/** The row blocks of one view: [{ view, tile, cells }], a cell { frame, view, why, cam, wire }. */
function blocksOf(state, view, picks) {
	const { out, a, aspect, span } = state, wide = fitTile(a.tile ?? WIDE, a.longEdge);
	const cell = (cam, f, why, tile) => {
		const fade = blockersAt(state.sight, cam.eye, f).by;
		const wire = { frame: f, eye: cam.eye, quaternion: cam.quaternion, fovDeg: cam.fovDeg, fade,
			...(a.labels ? { label: `${cam.name} f${f} ${why}` } : {}), ...(a.overlay ? { dots: dotsFor(out, cam, f, tile, a.overlay, span) } : {}) };
		return { frame: f, view: cam.name, why, cam, wire };
	};
	if (view === "side" || view === "front") {
		state.judge ??= judgeCameras(out, { aspect: wide.width / wide.height, position: state.position });
		const cam = state.judge.find(c => c.name === view);
		return [{ view, tile: wide, cells: picks.map(p => cell(cam, p.f, p.why, wide)) }];
	}
	if (view === "track") {
		const cams = trackingCameras(out, picks.map(p => p.f), { aspect: wide.width / wide.height });
		return [{ view, tile: wide, cells: picks.map((p, i) => cell(cams[i], p.f, p.why, wide)) }];
	}
	if (CLOSE[view]) {
		const tile = fitTile(a.tile ? { width: Math.min(a.tile.width, a.tile.height), height: Math.min(a.tile.width, a.tile.height) } : SQUARE, a.longEdge), ends = Object.keys(CLOSE[view]);
		let shots = Array.isArray(a.frames) ? [] : pickFrames(out, { mode: "events", count: a.count, from: span[0], to: span[1], ends });
		if (!shots.length) shots = picks.flatMap(p => ends.map(end => ({ ...p, end })));
		return [{ view, tile, cells: shots.map(p => cell(closeUpCamera(out, p.f, CLOSE[view][p.end]), p.f, p.why, tile)) }];
	}
	const cam = lookAt(view.eye, view.target, view.up ?? [0, 1, 0], { name: view.name ?? "custom", fovDeg: view.fovDeg ?? 40, aspect });
	return [{ view: cam.name, tile: wide, cells: picks.map(p => cell(cam, p.f, p.why, wide)) }];
}

/** Rows of `columns` cells per block, packed into sheets of one tile size within longEdge and 32 cells. */
function layout(blocks, longEdge) {
	const sheets = [], groups = new Map();
	for (const b of blocks) { const key = `${b.tile.width}x${b.tile.height}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(b); }
	for (const group of groups.values()) {
		const tile = group[0].tile, most = Math.max(...group.map(b => b.cells.length));
		const columns = Math.max(1, Math.min(most, MAX_COLUMNS, Math.floor(longEdge / tile.width)));
		const maxRows = Math.max(1, Math.min(Math.floor(longEdge / tile.height), Math.floor(MAX_CELLS / columns)));
		let sheet = null;
		for (const b of group) for (let i = 0; i < b.cells.length; i += columns) {
			if (!sheet || sheet.rows.length >= maxRows) sheets.push(sheet = { tile, columns, rows: [] });
			sheet.rows.push({ view: b.view, cells: b.cells.slice(i, i + columns) });
		}
	}
	return sheets;
}

/** One text line for a sheet: its size, the views by row, the frames. */
function sheetLine(n, meta, sheet) {
	const views = [], lists = new Map(), name = c => `f${c.frame} ${c.why}`;
	for (const row of sheet.rows) {
		if (views.at(-1)?.view === row.view) views.at(-1).rows++; else views.push({ view: row.view, rows: 1 });
		lists.set(row.view, [...(lists.get(row.view) ?? []), ...row.cells.map(name)]);
	}
	const rows = views.map(v => (v.rows > 1 ? `${v.view} (${v.rows})` : v.view)).join(", "), all = [...lists.values()].map(l => l.join(", "));
	const frames = all.every(l => l === all[0]) ? `columns ${all[0]}` : [...lists].map(([v, l]) => `${v}: ${l.join(", ")}`).join("; ");
	return `sheet ${n} ${meta.width}x${meta.height}: rows ${rows}; ${frames}`;
}

async function run(ctx, args, call = {}) {
	const a = checkArgs(args ?? {});
	const committed = ctx.track.dirty ? await ctx.track.commit() : null;
	const out = await ctx.track.out();
	if (!out) throw new Error("No track yet: call track set first.");
	const last = out.frames.length - 1, span = [Math.min(a.from, last), Math.min(a.to ?? last, last)];
	if (span[0] > span[1]) throw new Error(`render: from ${a.from} is after to ${span[1]}.`);
	const picks = pickFrames(out, { mode: a.frames, count: a.count, from: span[0], to: span[1] });
	const sight = out.ctx.objectsAt ? out : { ...out, ctx: { ...out.ctx, objectsAt: out.objectsAt } };
	const wide = fitTile(a.tile ?? WIDE, a.longEdge), state = { out, a, span, sight, aspect: wide.width / wide.height, position: ctx.character?.position ?? null };
	const blocks = a.views.flatMap(view => blocksOf(state, view, picks)), total = blocks.reduce((n, b) => n + b.cells.length, 0);
	if (total > MAX_TOTAL) throw new Error(`render: ${total} tiles is too many for one call (at most ${MAX_TOTAL}); ask fewer views or frames.`);
	const images = [], sheets = [], lines = [], hidden = new Map();
	for (const [i, sheet] of layout(blocks, a.longEdge).entries()) {
		if (call.signal?.aborted) throw new Error("render stopped: the turn was aborted.");
		const cells = sheet.rows.flatMap(row => [...row.cells, ...Array(sheet.columns - row.cells.length).fill(null)]);
		const answer = await ctx.studio.command("v4_render", { characterId: ctx.character?.id, tile: sheet.tile, columns: sheet.columns, cells: cells.map(c => c && c.wire) }, { timeoutMs: 120000 });
		const match = /^data:(image\/(?:png|jpeg));base64,/.exec(answer?.dataUrl ?? "");
		if (!match) throw new Error("render: the editor answered no image (v4_render gave no PNG data URL).");
		const real = cells.filter(Boolean), views = [...new Set(sheet.rows.map(r => r.view))], fs = real.map(c => c.frame);
		const label = `${views.join(",") === "side,front" ? "judge" : views.join("+")} f${Math.min(...fs)}-f${Math.max(...fs)}`;
		const meta = { label, width: answer.width, height: answer.height, columns: sheet.columns, rows: sheet.rows.length,
			cells: real.map(c => ({ frame: c.frame, view: c.view, why: c.why, camera: { eye: r3(c.cam.eye), target: r3(c.cam.target), fovDeg: Math.round(c.cam.fovDeg * 100) / 100 } })) };
		for (const c of real) for (const id of c.wire.fade) hidden.set(id, [...(hidden.get(id) ?? []), `${c.view} f${c.frame}`]);
		images.push({ data: answer.dataUrl.slice(match[0].length), mimeType: match[1], label });
		sheets.push(meta);
		lines.push(sheetLine(i + 1, meta, sheet));
	}
	if (committed) lines.unshift(`committed the track first: r${committed.revision}, ${committed.frames} frames.`);
	for (const [id, where] of hidden) lines.push(`see-through: ${id} (${where.slice(0, 6).join(", ")}${where.length > 6 ? ", ..." : ""})`);
	if (a.longEdge > 2000) lines.push("note: the Claude Code binary shrinks images above 2000 px on the long edge.");
	const text = lines.join("\n");
	return { data: { committed: Boolean(committed), sheets }, text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 4)} ...` : text, images };
}

/** createRenderTool(ctx) -> V4Tool "render" (design 2.1, 3.4). ctx: V4Context (track, studio, character). */
export function createRenderTool(ctx) {
	return { name: "render", description: DESCRIPTION, inputSchema: INPUT_SCHEMA, run: (args, call) => run(ctx, args, call) };
}
