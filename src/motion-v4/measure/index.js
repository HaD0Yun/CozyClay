// The v4 measure tool's tables over a frame range of an Out (the track's out(), or takeOut plus
// diag/c in tests): penetration, contacts, balance, limits, speed. measureTake gives every row (what
// a js caller gets); measureText gives the model a short worst-first TSV of each table.
import { penetrationRows } from "./penetration.js";
import { contactRuns } from "./contacts.js";
import { balanceRows } from "./balance.js";
import { limitRows, speedPeaks } from "./limits.js";
import { PART_NAMES, END_NAMES } from "./probes.js";

const TABLES = ["penetration", "contacts", "balance", "limits", "speed"];
const KNOWN = ["from", "to", "step", "what", "parts", "against", "skin", "tolerance", "maxRows"];
const BUDGET = 6000, MORE = "(call from js for all rows)";
const now = () => globalThis.performance?.now?.() ?? Date.now();

function intArg(args, key, lo, hi) {
	const v = args[key];
	if (v === undefined || v === null) return undefined;
	if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`measure: ${key} must be an integer from ${lo} to ${hi}, got ${JSON.stringify(v)}.`);
	return v;
}

function namesArg(args, key, valid) {
	const v = args[key];
	if (v === undefined || v === null) return null;
	if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new Error(`measure: ${key} must be an array of strings.`);
	const bad = v.filter(x => !valid.includes(x));
	if (bad.length) throw new Error(`measure: unknown ${key} ${bad.join(", ")}. Valid: ${valid.join(", ")}.`);
	return new Set(v);
}

/** The names of `set` a table knows, or null (no filter) when it knows none of them. */
const narrow = (set, vocab) => (set && vocab.some(n => set.has(n)) ? new Set(vocab.filter(n => set.has(n))) : null);

/**
 * measureTake(out, { from, to, step, what, parts, against, skin, tolerance }) -> MeasureData
 * { range: [from, to], step, tables: { penetration, contacts, balance, limits, speed }, ms }
 * Throws on a bad argument with a message that lists the valid values.
 */
export function measureTake(out, args = {}) {
	const t0 = now(), F = out.frames.length, unknown = Object.keys(args).filter(k => !KNOWN.includes(k));
	if (unknown.length) throw new Error(`measure: unknown argument ${unknown.join(", ")}. Valid: ${KNOWN.join(", ")}.`);
	const from = intArg(args, "from", 0, F - 1) ?? 0, to = Math.min(intArg(args, "to", 0, Infinity) ?? F - 1, F - 1);
	if (from > to) throw new Error(`measure: from ${from} is after to ${to} (the track has ${F} frames, f0-f${F - 1}).`);
	const step = intArg(args, "step", 1, 24) ?? 1, what = namesArg(args, "what", TABLES) ?? new Set(TABLES);
	const surfaces = ["floor", ...new Set([...Object.keys(out.ctx.scene?.objects ?? {}), ...Object.keys(out.objectsAt(from))])];
	const parts = namesArg(args, "parts", [...new Set([...PART_NAMES, ...END_NAMES])]), against = namesArg(args, "against", surfaces);
	const tolerance = args.tolerance ?? 0.01;
	if (typeof tolerance !== "number" || !(tolerance >= 0 && tolerance <= 0.1)) throw new Error("measure: tolerance must be a number from 0 to 0.1 (m).");
	const range = { from, to }, tables = {};
	if (what.has("penetration")) tables.penetration = penetrationRows(out, { ...range, parts: narrow(parts, PART_NAMES), against, skin: args.skin === true, tolerance });
	if (what.has("contacts")) tables.contacts = contactRuns(out, { ...range, parts: narrow(parts, END_NAMES), against });
	if (what.has("balance")) tables.balance = balanceRows(out, { ...range, step });
	if (what.has("limits")) tables.limits = limitRows(out, range);
	if (what.has("speed")) tables.speed = speedPeaks(out, range);
	return { range: [from, to], step, tables, ms: Math.round(now() - t0) };
}

const fx = (v, d = 3) => (v === null || v === undefined ? "-" : (Math.abs(v) < 0.5 / 10 ** d ? 0 : Number(v)).toFixed(d));
const xyz = p => p.map(v => fx(v)).join(",");

/** Each table as { head, cols, rows (TSV lines, worst first) }. */
function sections(data) {
	const t = data.tables, out = [];
	if (t.penetration) {
		const p = t.penetration, worst = p.worstByPart.slice(0, 8).map(w => `${w.part} ${w.against} ${fx(w.depth)} f${w.f}`).join(", ");
		out.push({ head: `penetration: ${p.rows.length} rows deeper than ${fx(p.tolerance ?? 0.01)} m${worst ? `; worst by part: ${worst}` : ""}`, cols: "f\tpart\tagainst\tdepth\tpoint",
			rows: [...p.rows].sort((a, b) => b.depth - a.depth).map(r => `${r.f}\t${r.part}\t${r.against}\t${fx(r.depth)}\t${xyz(r.point)}`) });
	}
	if (t.contacts) out.push({ head: `contacts: ${t.contacts.runs.length} runs (skin gap <= 0.02 m for 2+ frames), most slide first`, cols: "end\tagainst\tfrom\tto\tminGap\tslide",
		rows: [...t.contacts.runs].sort((a, b) => b.slide - a.slide || a.from - b.from).map(r => `${r.end}\t${r.against}\t${r.from}\t${r.to}\t${fx(r.minGap)}\t${fx(r.slide)}`) });
	if (t.balance) {
		const b = t.balance, air = b.rows.filter(r => r.margin === null).length, runs = b.outside.slice(0, 6).map(r => `f${r.from}-f${r.to} ${fx(r.worstMargin)}`).join(", ");
		out.push({ head: `balance: ${b.rows.length} rows, ${air} in the air; COM outside the support on ${b.outside.length} runs${runs ? `: ${runs}` : ""}; lowest margin first`, cols: "f\tsupport\tmargin\txcomMargin\tcom",
			rows: b.rows.filter(r => r.margin !== null).sort((x, y) => x.margin - y.margin).map(r => `${r.f}\t${r.support.join("+")}\t${fx(r.margin)}\t${fx(r.xcomMargin)}\t${xyz(r.com)}`) });
	}
	if (t.limits) out.push({ head: `limits: ${t.limits.runs.length} runs past a joint limit (deg), worst first`, cols: "joint\tfrom\tto\tf\tangle\tlimit\tpast",
		rows: t.limits.runs.map(r => `${r.joint}\t${r.from}\t${r.to}\t${r.f}\t${fx(r.angle, 1)}\t${r.limit}\t${fx(r.past, 1)}`) });
	if (t.speed) {
		const peak = (list, key, d) => list.filter(p => p[key] >= 0.005).map(p => `${fx(p[key], d)}@f${p.f}`).join(" ") || "none";
		const s = t.speed, lin = ["hips", "com"].map(k => `${k} speed ${peak(s.linear[k].speed, "v", 2)}; ${k} accel ${peak(s.linear[k].accel, "a", 1)}`).join("; ");
		out.push({ head: `speed: ${s.peaks.length} runs over the bone limits (deg/s); peaks m/s, m/s^2: ${lin}`, cols: "bone\tfrom\tto\tf\tspeed\tlimit",
			rows: s.peaks.map(r => `${r.bone}\t${r.from}\t${r.to}\t${r.f}\t${r.speed}\t${r.limit}`) });
	}
	return out;
}

function render(data, list, n) {
	const lines = [`measure f${data.range[0]}-f${data.range[1]}, step ${data.step}, ${data.ms} ms. Metres, degrees, TSV rows worst first.`];
	for (const s of list) {
		lines.push(s.head);
		if (!s.rows.length) continue;
		lines.push(s.cols, ...s.rows.slice(0, n));
		if (s.rows.length > n) lines.push(`... ${s.rows.length - n} more ${MORE}`);
	}
	return lines.join("\n");
}

/** The model's text of MeasureData: per table a header line, up to maxRows worst-first TSV rows; at most 6,000 chars. */
export function measureText(data, maxRows = 20) {
	const list = sections(data);
	for (let n = maxRows; n >= 0; n--) {
		const text = render(data, list, n);
		if (text.length <= BUDGET) return text;
	}
	const text = render(data, list, 0);
	return `${text.slice(0, BUDGET - 60)}\n... cut at ${BUDGET} chars ${MORE}`;
}
