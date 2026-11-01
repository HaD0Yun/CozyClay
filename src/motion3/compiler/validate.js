// Strict motion spec validation with exact messages, run before every compile through the
// pipeline (after skills expand, with open parameters at a trial value). Every problem found is
// listed at once, one per line (problems that differ only in their first index share a line), so the
// agent fixes them in one edit.
import { VEC_CHANNELS, POLE_CHANNELS, NUM_CHANNELS, MAP_CHANNELS, FINGER_PRESETS, rangeOf, CONVENTIONS, didYouMean, suggestField, isVec3, fmt } from "./vocab.js";
import { validateParts } from "./validate-parts.js";
import { SPEC_FIELDS, KEY_FIELDS } from "../schema/fields.js";
const MAX_ERRORS = 12, MAX_FOUND = 60;

/**
 * Problems that differ only in their first index (and its key frame) said once: "objects.box.keys[0].rot must be
 * ..." and keys[3] with the same words become "objects.box.keys[0,3].rot must be ...", so every problem fits one answer.
 */
function mergeProblems(lines) {
	const groups = new Map();
	for (const line of lines) {
		const m = /\[(\d+)\]( \(f(\d+)\))?/.exec(line), key = m ? `${line.slice(0, m.index)}[#]${m[2] ? " (f#)" : ""}${line.slice(m.index + m[0].length)}` : line;
		if (!groups.has(key)) groups.set(key, { line, idx: [], fs: [] });
		if (m) { groups.get(key).idx.push(m[1]); if (m[3]) groups.get(key).fs.push(`f${m[3]}`); }
	}
	return [...groups.entries()].map(([key, g]) => (g.idx.length > 1 ? key.replace("[#]", `[${g.idx.join(",")}]`).replace(" (f#)", ` (${g.fs.join(", ")})`) : g.line));
}


/** Channels other than the body's own: hinge channels, visible and level channels (C15), channels a check names, *_vis switches, spec.channels. */
export function customChannels(spec) {
	const out = new Set(spec.channels ?? []);
	for (const o of Object.values(spec.objects ?? {})) for (const ch of [o?.channel, o?.visible, o?.level]) if (typeof ch === "string" && ch) out.add(ch);
	const c = spec.checks ?? {};
	const list = v => (Array.isArray(v) ? v.filter(k => k && typeof k === "object") : []);
	for (const k of [c.contacts, c.orient, c.below, c.clearance].flatMap(list)) if (typeof k.when === "string") out.add(k.when);
	for (const k of list(c.appear)) if (typeof k.channel === "string") out.add(k.channel);
	return out;
}

function checkValue(err, at, ch, v) {
	if (VEC_CHANNELS.has(ch)) {
		if (!isVec3(v)) return err(`${at} ${ch} must be [x, y, z] (3 finite numbers), got ${fmt(v)}`);
		if (POLE_CHANNELS.has(ch)) {
			const l = Math.hypot(...v);
			if (l < 1e-6) return err(`${at} ${ch} = ${fmt(v)} has no direction; a pole is a ${CONVENTIONS.pole}`);
			if (ch.startsWith("knee") && v[2] < -0.7 * l) err(`${at} ${ch} = ${fmt(v)} points backward; knees bend toward +z. A pole is a ${CONVENTIONS.pole}`);
		}
		if (ch.startsWith("foot") && v[1] < 0.04) err(`${at} ${ch} y = ${v[1]} puts the ankle into the floor; foot_* is the ${CONVENTIONS.foot}`);
		return;
	}
	if (MAP_CHANNELS.has(ch)) {
		if (!v || typeof v !== "object" || Array.isArray(v)) return err(`${at} ${ch} must be { preset: weight }, presets ${FINGER_PRESETS.join(", ")}; got ${fmt(v)}`);
		for (const [p, w] of Object.entries(v)) {
			if (!FINGER_PRESETS.includes(p)) err(`${at} ${ch} preset "${p}" is unknown${didYouMean(p, FINGER_PRESETS)} (presets: ${FINGER_PRESETS.join(", ")})`);
			else if (!(Number.isFinite(w) && w >= 0 && w <= 1)) err(`${at} ${ch}.${p} must be a weight within 0..1, got ${fmt(w)}`);
		}
		return;
	}
	if (!Number.isFinite(v)) {
		const conv = ch === "yaw" ? ` (degrees; ${CONVENTIONS.yaw})` : ch.startsWith("fyaw") ? ` (${CONVENTIONS.fyaw})` : "";
		return err(`${at} ${ch} must be a finite number${conv}, got ${fmt(v)}`);
	}
	const r = rangeOf(ch);
	if (r && (v < r[1] || v > r[2])) err(`${at} ${ch} = ${v} is outside ${r[1]}..${r[2]} (${r[3]})`);
}

const list = v => (Array.isArray(v) ? v : []);
const lastOf = r => (Array.isArray(r) ? r[1] : r);

/**
 * The advice an "outside 0..frames-1" message ends with: the length every frame the spec names
 * needs (keys, walk starts, check windows, goals), and frames: "auto" when that covers it ("auto"
 * counts keys and walks, not check windows or goals; skills/frames-auto.js).
 */
function pastEndAdvice(spec, frames) {
	const counted = [...list(spec.keys).map(k => k?.f), ...list(spec.generators).map(g => g?.f0)].filter(Number.isInteger);
	const c = spec.checks ?? {};
	const windows = [...["contacts", "orient", "below"].flatMap(n => list(c[n]).map(k => lastOf(k?.when))), ...list(c.clearance).map(k => lastOf(k?.frames)),
		...list(spec.goals).map(g => lastOf(g?.at))].filter(Number.isInteger);
	const need = Math.max(frames - 1, ...counted, ...windows) + 1;
	return `; set frames >= ${need}${Math.max(0, ...counted) + 1 >= need ? " or frames: \"auto\"" : ""}`;
}

function validateKeys(spec, err, frames, unknown, past = "") {
	if (spec.keys !== undefined && !Array.isArray(spec.keys)) return err("spec.keys must be an array of { f, set, step? }");
	const anchors = Object.keys(spec.anchors ?? {}), custom = customChannels(spec);
	const known = [...VEC_CHANNELS, ...NUM_CHANNELS, ...MAP_CHANNELS, ...custom, ...anchors.flatMap(a => [`w_${a}_l`, `w_${a}_r`])];
	(spec.keys ?? []).forEach((key, i) => {
		const name = key?.src ? (key.src.startsWith("keys[") ? key.src : `${key.src} key`) : `keys[${i}]`;
		if (!key || typeof key !== "object") return err(`${name} must be { f, set, step? }`);
		for (const field of Object.keys(key)) if (!KEY_FIELDS.includes(field)) unknown(`${name} has unknown field "${field}"${suggestField(field, KEY_FIELDS)}; a key is { f, set, step? }`);
		if (!Number.isInteger(key.f)) return err(`${name}.f must be an integer frame, got ${fmt(key.f)}`);
		if (key.f < 0 || key.f > frames - 1) err(`${name}.f = ${key.f} is outside 0..${frames - 1} (spec.frames ${frames})${key.f > 0 ? past : ""}`);
		const at = `${name} (f${key.f})`;
		if (!key.set || typeof key.set !== "object" || Array.isArray(key.set)) return err(`${at} needs set: { channel: value }`);
		for (const [ch, v] of Object.entries(key.set)) {
			const w = /^w_(.+)_([lr])$/.exec(ch);
			if (w && !anchors.includes(w[1])) err(`${at} sets ${ch}, but there is no anchor "${w[1]}"${didYouMean(ch, known)}`);
			else if (w) checkValue(err, at, ch, v);
			else if (VEC_CHANNELS.has(ch) || NUM_CHANNELS.has(ch) || MAP_CHANNELS.has(ch)) checkValue(err, at, ch, v);
			else if (custom.has(ch) || ch.endsWith("_vis")) { if (!Number.isFinite(v)) err(`${at} ${ch} must be a finite number, got ${fmt(v)}`); }
			else err(`${at} sets unknown channel "${ch}"${didYouMean(ch, known)}`);
		}
		for (const ch of key.step ?? []) if (!(ch in key.set)) err(`${at} step names "${ch}", which this key does not set`);
		if (key.step !== undefined && !Array.isArray(key.step)) err(`${at} step must be an array of channel names`);
	});
}

/**
 * Throws MOTION_SPEC_INVALID listing every problem (problems: ones found before, listed first); scene objects are
 * checked when given.
 * lenient (a saved take compiled again, take-source.js) ignores unknown fields.
 */
/** spec.flow: false, or { smooth?: boolean, lag?: false | 0..6 frames | { spine?, head?, arms? }, overlap?: boolean | 0..2, headLead?: boolean | 0..12 frames } (channels.js, overlap.js, head-lead.js). */
function validateFlow(flow, err, unknown) {
	if (flow === undefined || flow === false) return;
	if (!flow || typeof flow !== "object" || Array.isArray(flow)) return err(`spec.flow must be false or { smooth?, lag?, overlap?, headLead? }, got ${fmt(flow)}`);
	for (const k of Object.keys(flow)) if (!["smooth", "lag", "overlap", "headLead"].includes(k)) unknown(`spec.flow has unknown field "${k}" (fields: smooth, lag, overlap, headLead)`);
	if (flow.smooth !== undefined && typeof flow.smooth !== "boolean") err(`spec.flow.smooth must be true or false, got ${fmt(flow.smooth)}`);
	const o = flow.overlap;
	if (o !== undefined && typeof o !== "boolean" && !(Number.isFinite(o) && o >= 0 && o <= 2)) err(`spec.flow.overlap must be true, false or a scale 0..2, got ${fmt(o)}`);
	const h = flow.headLead;
	if (h !== undefined && typeof h !== "boolean" && !(Number.isInteger(h) && h >= 0 && h <= 12)) err(`spec.flow.headLead must be true, false or 0..12 whole frames, got ${fmt(h)}`);
	const frames = v => Number.isFinite(v) && v >= 0 && v <= 6, lag = flow.lag, LAG = "false, 0..6 frames or { spine?, head?, arms? }";
	if (lag === undefined || lag === false || frames(lag)) return;
	if (!lag || typeof lag !== "object" || Array.isArray(lag)) return err(`spec.flow.lag must be ${LAG}, got ${fmt(lag)}`);
	for (const [k, v] of Object.entries(lag)) {
		if (!["spine", "head", "arms"].includes(k)) unknown(`spec.flow.lag has unknown field "${k}" (fields: spine, head, arms)`);
		else if (!frames(v)) err(`spec.flow.lag.${k} must be 0..6 frames, got ${fmt(v)}`);
	}
}

export function validateSpec(spec, { sk, scene, lenient = false, problems = [] } = {}) {
	const errors = [...problems], err = m => { if (errors.length < MAX_FOUND) errors.push(m); }, unknown = lenient ? () => {} : err;
	if (!spec || typeof spec !== "object") throw new Error("MOTION_SPEC_INVALID: spec must be an object");
	if (spec.schema !== "cozyclay.motion-spec.v1") err(`spec.schema must be "cozyclay.motion-spec.v1", got ${fmt(spec.schema)}`);
	for (const k of Object.keys(spec)) if (!SPEC_FIELDS.includes(k)) unknown(`spec.${k} is not a spec field${didYouMean(k, SPEC_FIELDS)} (fields: ${SPEC_FIELDS.join(", ")})`);
	if (spec.fps !== undefined && spec.fps !== 24) err(`spec.fps must be 24, the timeline rate, got ${fmt(spec.fps)}`);
	validateFlow(spec.flow, err, unknown);
	if (spec.fill !== undefined && typeof spec.fill !== "boolean") err(`spec.fill must be true or false (false: motion.compile does not fill between key poses with MotionBricks), got ${fmt(spec.fill)}`);
	const frames = spec.frames;
	if (!Number.isInteger(frames) || frames < 1 || frames > 20000) err(`spec.frames must be an integer 1..20000 or "auto", got ${fmt(frames)}`);
	const past = Number.isInteger(frames) ? pastEndAdvice(spec, frames) : "";
	validateKeys(spec, err, Number.isInteger(frames) ? frames : 20000, unknown, past);
	validateParts(spec, err, { sk, scene, frames: Number.isInteger(frames) ? frames : 20000, lenient, unknown, past });
	if (!errors.length) return;
	const lines = mergeProblems(errors), more = lines.length > MAX_ERRORS || errors.length >= MAX_FOUND;
	throw new Error(`MOTION_SPEC_INVALID: ${lines.slice(0, MAX_ERRORS).join("\n")}${more ? `\n(${lines.length > MAX_ERRORS ? `${lines.length - MAX_ERRORS}` : "more"}${errors.length >= MAX_FOUND ? "+" : ""} more problems not listed)` : ""}`);
}
