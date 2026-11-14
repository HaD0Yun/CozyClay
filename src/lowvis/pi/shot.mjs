// The one tool of the lowvis authoring harness. Every call compiles the scene and spec with engine-simple,
// validates and checks the clip, and renders contact sheets; the caller asks for none of that.
//   const shot = createShot({ name });   const result = shot.call({ scene?, spec?, look? });
// result: { status: "ok" | "rejected", text, images: [{ data (base64 png), mimeType }], error?, buildMs, renderMs,
//           scene, spec, shown: [{ frames, view, focus }] (one per sheet but the spike rows), rows, files }
// A call may send only what changed; the last scene and spec are kept. A thrown engine error comes back as text.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIP_FPS, serializeClip, validateClip } from "../clip.js";
import { JOINT_COUNT, INDEX as J, qRotate } from "../rig17.js";
import { checkClip } from "../engine-simple/checks.js";
import { NOTES, buildClip } from "../engine-simple/engine.js";
import { badness, checkValue, isSpike, measure } from "./measure.mjs";
import { VIEWS, drawSheet, encodePng, stackSheets } from "./render.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const MAX_FRAMES = 1440, MAX_LOOK = 12, SHEET = 8, SMALL_FIGURE = 105; // px: under this the default sheet gets a close row
const MOVERS = new Set(["carry", "hold", "release", "place"]);
const ASKED = /^(carryGap|carryIn|gripDrift|gripTurn|cut:|place:)/; // the rows that are a difference between what the spec asked and what came out
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fromText = v => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
const num = (v, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

/** Reasons a scene or spec cannot go to the engine, in plain words; empty when it can. */
function problems(scene, spec) {
	const out = [];
	if (!isObject(scene)) return ["scene: missing. Send scene: { frames, characters: [{ id, at: [x, z], heading }], props: [...] }"];
	if (!isObject(spec)) return ["spec: missing. Send spec: { <characterId>: [[frame, verb, options], ...] }"];
	if (!Number.isInteger(scene.frames) || scene.frames < 2 || scene.frames > MAX_FRAMES) out.push(`scene.frames: want a whole number from 2 to ${MAX_FRAMES}, got ${JSON.stringify(scene.frames)}`);
	const pair = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite), ids = new Set();
	if (!Array.isArray(scene.characters) || !scene.characters.length) out.push("scene.characters: want at least one { id, at: [x, z], heading }");
	for (const [kind, list] of [["characters", scene.characters], ["props", scene.props ?? []]]) {
		if (!Array.isArray(list)) { out.push(`scene.${kind}: want a list`); continue; }
		list.forEach((e, i) => {
			const where = `scene.${kind}[${i}]`;
			if (!isObject(e) || typeof e.id !== "string" || !e.id) { out.push(`${where}: want an object with a text id`); return; }
			if (ids.has(e.id) || e.id === "demo") out.push(`${where}: id "${e.id}" is taken`);
			ids.add(e.id);
			if (kind === "characters") {
				if (!pair(e.at, 2)) out.push(`${where}.at: want [x, z], got ${JSON.stringify(e.at)}`);
				if (!Number.isFinite(e.heading)) out.push(`${where}.heading: want degrees, got ${JSON.stringify(e.heading)}`);
			} else {
				if (!pair(e.size, 3) || e.size.some(v => v <= 0)) out.push(`${where}.size: want [w, h, d] over 0, got ${JSON.stringify(e.size)}`);
				if (!pair(e.at, 3)) out.push(`${where}.at: want the centre [x, y, z], got ${JSON.stringify(e.at)}`);
			}
		});
	}
	for (const [key, acts] of Object.entries(spec)) {
		if (key === "demo") continue;
		if (!ids.has(key)) { out.push(`spec.${key}: no character or prop has this id (scene ids: ${[...ids].join(", ")})`); continue; }
		if (!Array.isArray(acts)) { out.push(`spec.${key}: want a list of [frame, verb, options]`); continue; }
		acts.forEach((a, i) => {
			const where = `spec.${key}[${i}] = ${JSON.stringify(a)}`;
			if (!Array.isArray(a) || !Number.isInteger(a[0]) || typeof a[1] !== "string" || (a[2] !== undefined && !isObject(a[2]))) out.push(`${where}: want [frame, verb, options]`);
			else if (a[0] < 0 || a[0] >= scene.frames) out.push(`${where}: frame ${a[0]} is outside 0..${scene.frames - 1}`);
		});
	}
	return out;
}

/** The scene with moves: true on every prop the spec moves (the engine stores one frame of a prop without it). */
function withMovers(scene, spec) {
	const moved = new Set();
	for (const [key, acts] of Object.entries(spec)) {
		if (!Array.isArray(acts)) continue;
		if (scene.props?.some(p => p.id === key) && acts.length) moved.add(key);
		for (const a of acts) if (MOVERS.has(a[1]) && typeof a[2]?.prop === "string") moved.add(a[2].prop);
	}
	const set = (scene.props ?? []).filter(p => moved.has(p.id) && !p.moves).map(p => p.id);
	return { def: { ...scene, props: (scene.props ?? []).map(p => set.includes(p.id) ? { ...p, moves: true } : p) }, set };
}

/** Builds and validates. Returns { clip, aux, parsed, valid, buildMs } or { error, where }. */
function compile(spec, def, name) {
	try {
		const t0 = performance.now(), { clip, aux } = buildClip(structuredClone({ ...spec, demo: name }), def), buildMs = Math.round((performance.now() - t0) * 10) / 10;
		const parsed = JSON.parse(serializeClip(clip)), valid = validateClip(parsed);
		return valid.ok ? { clip, aux, parsed, valid, buildMs } : { error: `the clip is not valid: ${valid.errors.join("; ")}` };
	} catch (error) {
		const at = /\(?([^()\s]*\/src\/lowvis\/[^()\s]+:\d+):\d+\)?/.exec(String(error?.stack ?? ""))?.[1]?.split("/src/lowvis/")[1];
		return { error: String(error?.message ?? error), where: at ? `src/lowvis/${at}` : undefined };
	}
}

/** The likely cause of an engine error: the action without which the spec compiles, or, when no single action is
 *  the cause, the first action in frame order whose arrival breaks the build. */
function offender(spec, def, name) {
	const all = Object.entries(spec).flatMap(([key, acts]) => Array.isArray(acts) ? acts.map((a, i) => ({ key, i, a })) : []);
	const show = e => `${e.key}[${e.i}] = ${JSON.stringify(e.a)}`, only = list => { const s = { ...spec }; for (const key of new Set(all.map(e => e.key))) s[key] = list.filter(e => e.key === key).map(e => e.a); return s; };
	const single = all.filter(e => !compile(only(all.filter(o => o !== e)), def, name).error).slice(0, 3);
	if (single.length) return `offending action (the spec compiles without it): ${single.map(show).join(" | ")}`;
	const order = all.slice().sort((x, y) => x.a[0] - y.a[0]);
	let lo = 0, hi = order.length; // the first lo actions compile, the first hi do not
	if (compile(only([]), def, name).error) return "offending action: none; the scene alone does not compile";
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (compile(only(order.slice(0, mid)), def, name).error) hi = mid; else lo = mid; }
	return `first offending action in frame order (the actions before it compile; later ones may fail the same way): ${show(order[hi - 1])}`;
}

/** Up to `max` frames at the action boundaries of the spec: first and last frame always, the closest pairs thinned, wide gaps filled. */
export function boundaryFrames(spec, F, max = SHEET) {
	const set = new Set([0, F - 1]);
	for (const acts of Object.values(spec)) if (Array.isArray(acts)) for (const a of acts) if (Number.isInteger(a?.[0]) && a[0] >= 0 && a[0] < F) set.add(a[0]);
	const frames = [...set].sort((a, b) => a - b);
	while (frames.length > max) { let k = 1; for (let i = 2; i < frames.length - 1; i++) if (frames[i + 1] - frames[i - 1] < frames[k + 1] - frames[k - 1]) k = i; frames.splice(k, 1); }
	while (frames.length < max) {
		let k = 0;
		for (let i = 1; i < frames.length - 1; i++) if (frames[i + 1] - frames[i] > frames[k + 1] - frames[k]) k = i;
		if (frames[k + 1] - frames[k] < 12) break;
		frames.splice(k + 1, 0, Math.round((frames[k] + frames[k + 1]) / 2));
	}
	return frames;
}

/** Where the characters and the props that travel are at the given frames, as a small table. */
function stateTable(clip, frames) {
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return `${num(c.pos[i])} ${num(c.pos[i + 1])} ${num(c.pos[i + 2])}`; };
	const yaw = (c, f) => { const i = f * JOINT_COUNT * 4, d = qRotate([c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]], [0, 0, 1]); return String(Math.round(Math.atan2(d[0], d[2]) * 180 / Math.PI)); };
	const travel = p => { let d = 0; for (let i = 3; i < p.pos.length; i += 3) d = Math.max(d, Math.hypot(p.pos[i] - p.pos[0], p.pos[i + 1] - p.pos[1], p.pos[i + 2] - p.pos[2])); return d; };
	const movers = clip.props.filter(p => p.pos.length > 3 && travel(p) > 0.01).sort((a, b) => travel(b) - travel(a)).slice(0, 4);
	const head = ["f", ...clip.characters.flatMap(c => [`${c.id} hips`, "yaw", `${c.id} L wrist`, `${c.id} R wrist`]), ...movers.map(p => p.id)];
	const lines = frames.map(f => [String(f), ...clip.characters.flatMap(c => [at(c, f, J.Hips), yaw(c, f), at(c, f, J.LeftHand), at(c, f, J.RightHand)]), ...movers.map(p => `${num(p.pos[f * 3])} ${num(p.pos[f * 3 + 1])} ${num(p.pos[f * 3 + 2])}`)]);
	const width = head.map((h, k) => Math.max(h.length, ...lines.map(l => l[k].length)));
	return [head, ...lines].map(l => l.map((v, k) => v.padEnd(width[k])).join("  ").trimEnd()).join("\n");
}

const rowText = r => `${r.label}: ${num(r.value, r.unit === "m/s" ? 2 : 1)} ${r.unit}${r.frame != null ? ` @f${r.frame}` : ""}${r.who ? ` ${r.who}` : ""}${r.note ? ` (${r.note})` : ""}`;
/** " (was X)" and whether the row got worse, against the same row of the previous compile. */
function against(row, prev) {
	if (!prev) return { text: " [new]", worse: false };
	if (Math.abs(row.value - prev.value) < 0.05) return { text: " [same]", worse: false };
	const worse = badness(row) - badness(prev) > Math.max(0.05, 0.05 * badness(prev));
	return { text: ` [was ${num(prev.value, row.unit === "m/s" ? 2 : 1)}${worse ? `, ${row.word ?? "worse"}` : ""}]`, worse };
}

/** The spikes to show: up to three rows, the worst first, one per neighbourhood of frames. */
function spikes(rows, F) {
	const picked = [];
	for (const r of rows.filter(isSpike).sort((a, b) => badness(b) / b.spike - badness(a) / a.spike)) {
		const near = picked.find(p => Math.abs(p.frame - r.frame) <= 2 && p.who === r.who);
		if (near) { if (!near.label.includes(r.short) && near.label.length < 22) near.label += `+${r.short}`; continue; }
		if (picked.length < 3) picked.push({ frame: r.frame, who: r.who, label: r.short, frames: [...new Set([r.frame - 1, r.frame, r.frame + 1].map(f => Math.max(0, Math.min(F - 1, f))))], focus: [r.who, r.prop].filter(Boolean) });
	}
	return picked;
}

/** variant "lean": the model is told only the ASKED rows; every row is still measured and kept for the run record. */
export function createShot({ name, outDir = join(ROOT, "lowvis-out/pi", name), clipFile = join(ROOT, "public/lowvis/clips/pi", `${name}.json`), variant = "base" }) {
	const state = { scene: null, spec: null, calls: 0, compiles: 0, prevRows: null, notesSaid: false, moversSaid: "", last: null };
	mkdirSync(outDir, { recursive: true });

	function call(args = {}) {
		const n = ++state.calls, t0 = performance.now(), sent = { scene: fromText(args.scene), spec: fromText(args.spec), look: fromText(args.look) };
		if (sent.scene !== undefined && sent.scene !== null) state.scene = sent.scene;
		if (sent.spec !== undefined && sent.spec !== null) state.spec = sent.spec;
		const base = { n, scene: state.scene, spec: state.spec, shown: null, images: [], files: [], buildMs: 0, renderMs: 0 };
		const reject = (error, lines) => ({ ...base, status: "rejected", error, text: [`shot ${n}: rejected, nothing compiled`, ...lines, state.last ? "The last compiled clip is unchanged." : ""].filter(Boolean).join("\n"), ms: performance.now() - t0 });
		const bad = problems(state.scene, state.spec);
		if (bad.length) return reject(bad[0], bad.slice(0, 8));
		const look = isObject(sent.look) ? sent.look : null;
		if (look?.view !== undefined && !VIEWS[look.view]) return reject(`look.view "${look.view}"`, [`look.view: want one of ${Object.keys(VIEWS).join(", ")}, got ${JSON.stringify(look.view)}`]);
		if (look?.frames !== undefined && (!Array.isArray(look.frames) || !look.frames.length || look.frames.length > MAX_LOOK || !look.frames.every(Number.isInteger))) return reject("look.frames", [`look.frames: want 1 to ${MAX_LOOK} whole frame numbers, got ${JSON.stringify(look.frames)}`]);
		const ids = [...state.scene.characters, ...(state.scene.props ?? [])].map(e => e.id), focus = look?.focus == null ? null : [].concat(look.focus);
		if (focus?.some(id => !ids.includes(id))) return reject("look.focus", [`look.focus: no character or prop has the id ${JSON.stringify(look.focus)} (scene ids: ${ids.join(", ")})`]);

		const { def, set } = withMovers(state.scene, state.spec), built = compile(state.spec, def, name);
		if (built.error) {
			return reject(built.error, [`engine error: ${built.error}${built.where ? ` (${built.where})` : ""}`, offender(state.spec, def, name)]);
		}
		const { clip, aux, parsed, valid, buildMs } = built, F = parsed.frameCount, checks = checkClip(parsed, aux);
		const rows = measure(parsed, aux, { stretch: valid.stretch });
		for (const r of rows) { const v = checkValue(r.key, checks); if (v !== undefined && Math.abs(v - r.value) > 1e-6) { r.value = v; r.frame = undefined; } } // checks.js is the reference
		Object.assign(clip.stats, { buildMs, stretch: valid.stretch, checks: Object.fromEntries(rows.map(r => [r.key, { value: r.value, unit: r.unit, frame: r.frame }])) });
		mkdirSync(resolve(clipFile, ".."), { recursive: true });
		writeFileSync(clipFile, serializeClip(clip));

		// sheets: after a change always the overview (the action boundaries, a close row when the figure is small) and the
		// frames around each spike; the look that was asked on top, or alone when nothing changed
		const key = JSON.stringify([def, state.spec]), changed = state.last?.key !== key, t1 = performance.now(), sheets = [], shown = [];
		const add = (file, options, says) => { const sheet = drawSheet(parsed, options); sheets.push({ file, sheet, says }); shown.push({ frames: sheet.frames, view: sheet.view, focus: options.focus ?? [] }); return sheet; };
		if (changed || !look) {
			const frames = boundaryFrames(state.spec, F), main = add(`sheet-${n}.png`, { frames, view: "three" }, "overview");
			sheets[0].says = `overview, frames ${main.frames.join(" ")}, view three, the whole scene in frame`;
			if (main.figurePx < SMALL_FIGURE) add(`sheet-${n}-close.png`, { frames, view: "three", focus: parsed.characters.map(c => c.id) }, "the overview's frames framed on the characters (the figure is small in the overview)");
		}
		if (look) {
			const view = look.view ?? "three", asked = drawSheet(parsed, { frames: look.frames ?? boundaryFrames(state.spec, F), view, focus: focus ?? undefined });
			sheets.push({ file: `sheet-${n}-look.png`, sheet: asked, says: `your look, frames ${asked.frames.join(" ")}, view ${view}, ${focus ? `framed on ${focus.join(" and ")}` : "the whole scene in frame"}` });
			shown.push({ frames: asked.frames, view, focus: focus ?? [] });
		}
		const told = variant === "lean" ? rows.filter(r => ASKED.test(r.key)) : rows;
		const worst = changed ? spikes(told, F) : [];
		if (worst.length) {
			const strips = worst.map(w => drawSheet(parsed, { frames: w.frames, view: "three", focus: w.focus.length ? w.focus : undefined, cols: 3, label: w.label }));
			sheets.push({ file: `sheet-${n}-worst.png`, sheet: stackSheets(strips), says: `one row per spike, the frames around its worst frame: ${worst.map(w => `"${w.label}" f${w.frames[0]}-${w.frames.at(-1)}${w.who ? ` (${w.who})` : ""}`).join(", ")}` });
		}
		const table = sheets.findIndex(x => x.file.endsWith("-look.png")) + 1 || 1, tableFrames = sheets[table - 1].sheet.frames;
		const images = sheets.map(s => { const png = encodePng(s.sheet.rgba, s.sheet.width, s.sheet.height); writeFileSync(join(outDir, s.file), png); return { data: png.toString("base64"), mimeType: "image/png" }; });
		const renderMs = Math.round((performance.now() - t1) * 10) / 10;

		const prev = state.prevRows && Object.fromEntries(state.prevRows.map(r => [r.key, r])), marks = told.map(r => prev ? against(r, prev[r.key]) : { text: "", worse: false });
		const same = prev && marks.every(m => m.text === " [same]") && told.length === state.prevRows.length, worse = marks.filter(m => m.worse).length;
		const text = [
			`shot ${n}: compiled, ${F} frames = ${num(F / CLIP_FPS, 1)} s at ${CLIP_FPS} fps, build ${buildMs} ms, clip valid`,
			set.length && set.join() !== state.moversSaid ? `note: moves: true was set on ${set.join(", ")} because the spec moves ${set.length > 1 ? "them" : "it"}` : "",
			!told.length ? "" : same ? "checks: every number is the same as in the previous compile" : `checks, each at its worst frame${prev ? `; [was ..] is the previous compile${worse ? `, ${worse} got worse` : ""}` : ""}:`,
			...(same ? [] : told.map((r, k) => `- ${rowText(r)}${marks[k].text}`)),
			`at the frames of image ${table} (world metres, yaw in degrees):`, stateTable(parsed, tableFrames),
			...sheets.map((s, k) => `image ${k + 1}: ${s.says}`),
			state.notesSaid ? "" : `engine limits (said once): ${NOTES.join("; ")}`,
		].filter(Boolean).join("\n");
		state.notesSaid = true; state.moversSaid = set.join(); state.prevRows = told; state.compiles++;
		state.last = { key, scene: def, spec: state.spec, rows, frames: F, buildMs };
		return { ...base, status: "ok", text, images, files: sheets.map(s => join(outDir, s.file)), buildMs, renderMs, rows, shown, ms: performance.now() - t0 };
	}
	return { call, state, clipFile, outDir };
}
