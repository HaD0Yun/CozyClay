// Slips the validator corrects instead of refusing the whole spec (#1126), when the spec has one reading.
// They run on the expanded spec the validator checks (a plain JSON copy the compile bakes; the stored spec
// stays as sent, so every compile corrects it again), and each one is a "corrected: ..." note the answer
// carries in output.adjusted (pipeline.js, commands/motion3.js):
//   a knee pole that points backward (z < -0.7 |v|; knees bend toward +z) is mirrored forward, [x, y, -z], on an
//   upright body; on a body turned past upright (pose.js tiltFrame: pitch or roll past 60 deg) the pole turns with
//   the body, so the x and y the agent sent read in another frame too: there the pole is left out and the knee
//   follows the poles keyed around it (v2 bench replay, 16 refused specs: on a turned body mirroring gave 3 of 11 a
//   QA group the agent's own fix did not have, leaving the pole out 1; upright, mirroring 1 of 5, leaving it out 2)
//   an agent key 1..3 frames past the last frame (f = frames .. frames + 2: frames read as the last frame)
//   goes on the last frame; refused as before when an agent key there sets one of its channels (the two
//   would merge, and one value the agent sent would be lost), or when an object key, grab or release lies
//   past the end too (the take is short of the motion, not off by one)
//   an anchor named <name>_l / <name>_r is <name>_left / <name>_right, with every anchor ref, fit, appear
//   and weight channel that names it; refused as before when the new name is taken
// Anything else stays for the validator to refuse with its message.
import { isVec3, fmt } from "./vocab.js";
import { mergeProblems } from "./validate-common.js";
import { stateAt } from "./walk.js";
import { tiltFrame } from "./pose.js";

const PAST = 2;
const plain = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nameOf = (key, i) => (key.src ? (key.src.startsWith("keys[") ? key.src : `${key.src} key`) : `keys[${i}]`);
const own = key => !key.src || key.src.startsWith("keys[");

const finite = v => (Number.isFinite(v) ? v : 0);
function mendKnees(spec, notes) {
	const keys = Array.isArray(spec.keys) ? spec.keys : [];
	keys.forEach((key, i) => {
		for (const ch of ["knee_l", "knee_r"]) {
			const v = key?.set?.[ch];
			if (!isVec3(v) || !(v[2] < -0.7 * Math.hypot(...v))) continue;
			const st = stateAt(keys.filter(plain), key.f), said = `corrected: ${nameOf(key, i)} (f${key.f}) ${ch} = ${fmt(v)} points backward (knees bend toward +z)`;
			if (tiltFrame(0, finite(st.pitch), finite(st.roll))) {
				delete key.set[ch];
				if (Array.isArray(key.step)) key.step = key.step.filter(s => s !== ch);
				notes.push(`${said} on a body turned past upright, where a pole turns with the body: left out, so the knee follows the poles keyed around it`);
			} else {
				key.set[ch] = [v[0], v[1], -v[2]];
				notes.push(`${said}: mirrored forward to ${fmt(key.set[ch])}`);
			}
		}
	});
}

function clampLastKeys(spec, notes) {
	const frames = spec.frames, keys = Array.isArray(spec.keys) ? spec.keys : [];
	if (!Number.isInteger(frames) || frames < 1) return;
	const last = frames - 1, past = keys.map((k, i) => ({ k, i })).filter(({ k }) => plain(k) && plain(k.set) && own(k) && Number.isInteger(k.f) && k.f > last && k.f <= last + 1 + PAST);
	const objectFrames = Object.values(plain(spec.objects) ? spec.objects : {}).flatMap(o => (plain(o) ? [o.grab, o.release, ...(Array.isArray(o.keys) ? o.keys.map(k => k?.f) : [])] : []));
	if (!past.length || objectFrames.some(f => Number.isFinite(f) && f > last)) return;
	const taken = new Set(keys.filter(k => plain(k) && plain(k.set) && own(k) && k.f === last).flatMap(k => Object.keys(k.set)));
	for (const { k, i } of past.sort((a, b) => a.k.f - b.k.f)) {
		const channels = Object.keys(k.set);
		if (channels.some(ch => taken.has(ch))) continue;
		channels.forEach(ch => taken.add(ch));
		notes.push(`corrected: ${nameOf(k, i)}.f = ${k.f} -> ${last}, the last frame (spec.frames ${frames} runs 0..${last})`);
		k.f = last;
	}
}

/** value with every anchor:<from> ref, anchor: <from> field and w_<from>_l / _r channel (as a string or a key) renamed to `to`. */
function renameRefs(value, from, to) {
	const weight = new RegExp(`^w_${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_([lr])$`);
	const str = s => (s === `anchor:${from}` ? `anchor:${to}` : s.replace(weight, `w_${to}_$1`));
	const walk = v => {
		if (typeof v === "string") return str(v);
		if (Array.isArray(v)) return v.map(walk);
		if (!plain(v)) return v;
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), k === "anchor" && x === from ? to : walk(x)]));
	};
	return walk(value);
}

function renameSidedAnchors(spec, notes) {
	if (!plain(spec.anchors)) return;
	const names = Object.keys(spec.anchors), plan = new Map();
	for (const name of names.filter(n => /_[lr]$/.test(n))) {
		const to = `${name.slice(0, -2)}_${name.endsWith("_l") ? "left" : "right"}`;
		if (!names.includes(to) && ![...plan.values()].includes(to)) plan.set(name, to);
	}
	for (const [from, to] of plan) {
		for (const field of Object.keys(spec)) if (field !== "anchors") spec[field] = renameRefs(spec[field], from, to);
		spec.anchors = Object.fromEntries(Object.entries(spec.anchors).map(([n, a]) => [n === from ? to : n, a]));
		notes.push(`corrected: anchors.${from} -> anchors.${to}, and every ref to it (an anchor name may not end in _l or _r; the side goes on its weight channel, w_${to}_l / w_${to}_r)`);
	}
}

/** mendSpec(spec, notes): the corrections above, in place on spec; notes gets one line per correction (keys that differ only in their index share one). */
export function mendSpec(spec, notes) {
	if (!plain(spec)) return;
	const said = [];
	mendKnees(spec, said);
	clampLastKeys(spec, said);
	renameSidedAnchors(spec, said);
	for (const line of mergeProblems(said)) if (!notes.includes(line)) notes.push(line);
}
