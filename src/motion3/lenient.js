// Mechanical input mistakes are fixed, not refused, when the fix cannot change what was meant; each
// fix is one short note the answer carries in output.adjusted (commands/motion3.js). Refused as before:
// anything that changes timing or meaning (keys past the clip, tol on above, a window wholly past it).
//   relaxSpec        on the expanded spec before validation (pipeline.js): a goal window partly past the
//                    clip is cut to it; an object key with only pos takes the turn of the key before it
//                    (else after it, else its scene pose: rot for a free entry, aim for a carry so the
//                    arm picks the roll); a rot of length strictly between 0.5 and 2 is normalized; a knee
//                    pole that points backward in the body frame but forward read as a world direction at
//                    the root yaw of its frame (a body turned 90 deg or more) is that world direction; a bare
//                    name in goals near / above that is exactly one ref (refs.js bareRefs) is that ref
//   (spelling and placement slips in the sent spec: correct.js, before it is stored)
//   clampProbe       a probe window partly past the take is cut to it (probes.js)
//   fitEvery         a position probe's every grows to fit its 16 rows (probes.js)
//   clampFrames      contact-sheet frames past the range are pulled into it (studio-motion-visual.js)
//   normalizeCompileArgs  install spellings ("always", "if_clean", ...) and repair: { rounds: 0 } / true
//                    (the registry's normalizeArgs, before the schema check)
import { quatFromMat, apply, ry } from "./compiler/math.js";
import { stateAt } from "./compiler/walk.js";
import { groupsOf } from "./scene.js";
import { isCarried } from "./carried.js";
import { isFree } from "./free-motion.js";
import { bareRefs } from "./refs.js";

const fmtRange = r => `[${r[0]},${r[1]}]`;
/** Adds note to notes once (search trials expand the same spec again). */
const note = (notes, text) => { if (notes && !notes.includes(text)) notes.push(text); };

/** [f0, f1] cut to 0..last when it overlaps it; null when nothing is left or it is not a frame range. */
function clampRange(range, last) {
	if (!(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] <= range[1])) return null;
	const lo = Math.max(0, range[0]), hi = Math.min(last, range[1]);
	return lo <= hi ? [lo, hi] : null;
}

/** goals[].at partly outside 0..frames-1 is cut to the clip; a window wholly outside is left for validation to refuse. */
function relaxGoals(spec, notes) {
	if (!Array.isArray(spec.goals) || !Number.isInteger(spec.frames)) return;
	const last = spec.frames - 1;
	spec.goals.forEach((g, i) => {
		if (!g || typeof g !== "object" || !Array.isArray(g.at)) return;
		const cut = clampRange(g.at, last);
		if (!cut || (cut[0] === g.at[0] && cut[1] === g.at[1])) return;
		note(notes, `goals[${i}]${g.name ? ` "${g.name}"` : ""} at ${fmtRange(g.at)} -> ${fmtRange(cut)}: the clip is 0..${last}`);
		g.at = cut;
	});
}

const turnOf = k => (k.rot !== undefined ? { rot: k.rot } : { aim: k.aim, ...(k.roll !== undefined ? { roll: k.roll } : {}), ...(k.lean !== undefined ? { lean: k.lean } : {}) });
const hasTurn = k => k && (k.rot !== undefined || k.aim !== undefined);
const bare = k => k && typeof k === "object" && !Array.isArray(k) && !hasTurn(k) && k.roll === undefined && k.lean === undefined;

/** A key that gives pos only holds the turn it has: the key before it, else after it, else the scene pose. */
function fillTurns(id, o, scene, notes) {
	const keys = o.keys.map((k, i) => ({ k, i })).filter(({ k }) => k && Number.isInteger(k.f)).sort((a, b) => a.k.f - b.k.f);
	const missing = keys.filter(({ k }) => bare(k));
	if (!missing.length) return;
	const rest = scene?.objects?.[id] ?? groupsOf(scene ?? {})[id];
	const fromRest = rest ? (isCarried(o) ? { aim: [rest.R[0][1], rest.R[1][1], rest.R[2][1]].map(v => Math.round(v * 1e4) / 1e4) } : { rot: quatFromMat(rest.R) }) : null;
	// sources are the keys that gave a turn, so a filled key never passes its fill on
	const given = keys.filter(e => hasTurn(e.k)), held = [], restIdx = [];
	for (const { k, i } of missing) {
		const from = given.filter(e => e.k.f < k.f).at(-1) ?? given.find(e => e.k.f > k.f);
		if (from) { Object.assign(k, turnOf(from.k)); held.push(i); }
		else if (fromRest) { Object.assign(k, fromRest); restIdx.push(i); }
	}
	if (held.length) note(notes, `objects.${id}.keys[${held.join(",")}] had no rot or aim: each holds the turn of the nearest key before it (else after)`);
	if (restIdx.length) note(notes, `objects.${id}.keys[${restIdx.join(",")}] had no rot or aim: ${fromRest.aim ? `+Y as in the scene, aim [${fromRest.aim}]` : "turned as in the scene"}`);
}

/** A rot that is a quaternion off unit length (strictly between 0.5 and 2) is normalized. */
function normalizeRots(id, o, notes) {
	o.keys.forEach((k, i) => {
		if (!Array.isArray(k?.rot) || k.rot.length !== 4 || !k.rot.every(Number.isFinite)) return;
		const n = Math.hypot(...k.rot);
		if (Math.abs(n - 1) <= 0.01 || n <= 0.5 || n >= 2) return;
		k.rot = k.rot.map(v => v / n);
		note(notes, `objects.${id}.keys[${i}].rot had length ${n.toFixed(3)}: normalized`);
	});
}

const r3 = v => v.map(x => Math.round(x * 1000) / 1000);
/** A knee pole sent as a world direction (agents facing -Z write [0, 0, -1] for "forward"): its body-frame reading at the root yaw. */
function worldPoles(spec, notes) {
	if (!Array.isArray(spec.keys)) return;
	spec.keys.forEach((key, i) => {
		for (const ch of ["knee_l", "knee_r"]) {
			const v = key?.set?.[ch];
			if (!(Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) continue;
			const l = Math.hypot(...v);
			if (!(l > 1e-6 && v[2] < -0.7 * l)) continue;
			const yaw = stateAt(spec.keys, key.f).yaw;
			if (!(Number.isFinite(yaw) && Math.abs(((yaw % 360) + 540) % 360 - 180) >= 90)) continue;
			const body = r3(apply(ry(-yaw), v));
			if (body[2] < 0.7 * l) continue;
			key.set[ch] = body;
			note(notes, `corrected: ${key.src?.startsWith("keys[") ? key.src : `keys[${i}]`} (f${key.f}) ${ch} [${r3(v)}] is a world direction at root yaw ${Math.round(yaw)}: body frame [${body}] (a pole is +z forward)`);
		}
	});
}

/** goals[i].near / above: a bare name with one reading in the expanded spec, rig and scene takes it ("LeftHand" -> joint:LeftHand). */
function bareGoalRefs(spec, ctx, notes) {
	if (!Array.isArray(spec.goals)) return;
	spec.goals.forEach((g, i) => {
		for (const kind of ["near", "above"]) (Array.isArray(g?.[kind]) ? g[kind] : []).forEach((ref, j) => {
			if (typeof ref !== "string" || /^[a-z]+:/.test(ref)) return;
			const known = bareRefs(spec, ctx, ref);
			if (known.length !== 1) return;
			g[kind][j] = known[0];
			note(notes, `corrected: goals[${i}].${kind}[${j}] "${ref}" -> "${known[0]}"`);
		});
	});
}

/**
 * relaxSpec(spec, scene, notes, sk): the fixes above, in place on the expanded spec (a plain JSON copy the
 * compile measures; the stored spec stays as sent). notes collects one line per fix.
 */
export function relaxSpec(spec, scene, notes, sk) {
	if (!spec || typeof spec !== "object") return spec;
	relaxGoals(spec, notes);
	bareGoalRefs(spec, { sk, scene }, notes);
	worldPoles(spec, notes);
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		if (!o || typeof o !== "object" || !Array.isArray(o.keys) || !(isCarried(o) || isFree(o))) continue;
		fillTurns(id, o, scene, notes);
		normalizeRots(id, o, notes);
	}
	return spec;
}

/** A probe window cut to the take (frames: one frame or [f0, f1]); null (refused) when nothing is left. */
export function clampProbe(frames, last, at, notes) {
	const range = Number.isInteger(frames) ? [frames, frames] : frames, cut = clampRange(range, last);
	if (cut && (cut[0] !== range[0] || cut[1] !== range[1])) note(notes, `${at}.frames ${fmtRange(range)} -> ${fmtRange(cut)}: the take is 0..${last}`);
	return cut;
}

/** The every a position probe needs to answer at most max rows over span frames (the asked one if it fits). */
export function fitEvery(every, span, max, at, notes) {
	if (Math.ceil(span / every) <= max) return every;
	const fit = Math.ceil(span / max);
	note(notes, `${at}.every ${every} -> ${fit}: a position probe answers at most ${max} rows`);
	return fit;
}

/** Contact-sheet frames pulled into lo..hi, in order, each once: { frames, adjusted? }. */
export function clampFrames(frames, [lo, hi]) {
	const outside = frames.filter(f => f < lo || f > hi);
	const kept = [...new Set(frames.map(f => Math.min(hi, Math.max(lo, f))))].sort((a, b) => a - b);
	return outside.length ? { frames: kept, adjusted: `frames ${outside.join(", ")} lie outside ${lo}..${hi}: drawn at ${kept.filter(f => f === lo || f === hi).join(", ")}` } : { frames: kept };
}

const INSTALL_WORDS = { always: true, yes: true, true: true, on: true, never: "never", no: "never", false: "never", off: "never", none: "never",
	ifclean: "ifClean", whenclean: "ifClean", onlyifclean: "ifClean", clean: "ifClean" };

/** motion.compile args with the obvious other spellings turned into the declared ones (meaning unchanged). */
export function normalizeCompileArgs(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	let out = args;
	if (typeof args.install === "string" && args.install !== "ifClean" && args.install !== "never") {
		const word = INSTALL_WORDS[args.install.toLowerCase().replace(/[^a-z]/g, "")];
		if (word !== undefined) out = { ...out, install: word };
	}
	if (args.repair === true) out = { ...out, repair: {} };
	// repair: false (or { rounds: 0 }) is the explicit opt-out: repair runs by default (motion3.js), so it is kept as false
	else if (args.repair === false || (args.repair && typeof args.repair === "object" && args.repair.rounds === 0 && Object.keys(args.repair).length === 1))
		out = { ...out, repair: false };
	return out;
}
