// What the engine has computed of a motion's compile that the Studio agent needs for its own work, as numbers read from
// the clip and the spec (rule 6): when each id's actions run, where each body is at those frames, and the rows the
// writer's tool told for that compile. Only geometry, frames and the tool's own lines.
//   factsOf({ clip, spec, told, ids })   -> { frames, seconds, actions, bodies, rows? }
//   factsAnswer(job, done, first), stateOf(job)  what the Studio agent is told of them (motion-door.mjs)
import { JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";

const MAX_FRAMES = 8, MAX_ROWS = 8; // frames told per body; rows told
const UPRIGHT = 0.5; // the level part of a body's forward direction under which it faces up or down, not a way round
const r2 = v => Math.round(v * 100) / 100;

/** The frames of the actions of one spec entry ([[frame, verb, options], ...]) -> [[frame, [verbs]]], by frame. */
function framesOf(actions, last) {
	const at = new Map();
	for (const a of Array.isArray(actions) ? actions : []) if (Array.isArray(a) && Number.isFinite(a[0]) && typeof a[1] === "string") {
		const f = Math.max(0, Math.min(last, Math.round(a[0])));
		at.set(f, [...(at.get(f) ?? []), a[1]]);
	}
	return [...at].sort((a, b) => a[0] - b[0]);
}

/** Where body `c` is at frame f: "hips [x, y, z] facing <deg>" (metres; degrees about Y, 0 faces +Z), or "facing up" /
 *  "facing down" while its forward direction is nearer the vertical than the floor (a body that lies). */
function hipsAt(c, f) {
	const p = f * JOINT_COUNT * 3, q = f * JOINT_COUNT * 4, ahead = qRotate([c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3]], [0, 0, 1]);
	const facing = Math.hypot(ahead[0], ahead[2]) < UPRIGHT ? (ahead[1] > 0 ? "up" : "down") : (Math.round(Math.atan2(ahead[0], ahead[2]) * 180 / Math.PI) + 360) % 360;
	return `hips [${[c.pos[p], c.pos[p + 1], c.pos[p + 2]].map(r2).join(", ")}] facing ${facing}`;
}

/** At most n of the frames, the first and the last kept. */
const thin = (frames, n) => (frames.length <= n ? frames : Array.from({ length: n }, (_, k) => frames[Math.round(k * (frames.length - 1) / (n - 1))]));

/**
 * The facts of one compile: clip (lowvis.clip.v1), spec (the writer's), told (the tool's row lines of that compile), ids
 * ({ <writer id>: <Studio id> } of what the Studio has already). actions: { <id>: "<from>-<to> <verbs>; ..." }, each
 * stretch from an action's frame to the frame before the next one; bodies: { <id>: "f<frame> hips [x, y, z] facing <deg>; ..." }
 * at the frames its actions start and the last frame (at most MAX_FRAMES of them); rows: the told lines (the first
 * MAX_ROWS, then how many more).
 */
export function factsOf({ clip, spec, told = [], ids = {} }) {
	const F = clip?.frameCount ?? 0, last = Math.max(0, F - 1), name = id => (ids[id] && ids[id] !== id ? `${id} (${ids[id]})` : id);
	const actions = {}, bodies = {};
	for (const [id, list] of Object.entries(spec ?? {})) {
		const at = framesOf(list, last);
		if (at.length) actions[name(id)] = at.map(([f, verbs], k) => `${f}-${k + 1 < at.length ? Math.max(f, at[k + 1][0] - 1) : last} ${verbs.join(", ")}`).join("; ");
	}
	for (const c of clip?.characters ?? []) {
		if (!F || (c.pos?.length ?? 0) < F * JOINT_COUNT * 3 || (c.quat?.length ?? 0) < F * JOINT_COUNT * 4) continue;
		const frames = thin([...new Set([0, ...framesOf(spec?.[c.id], last).map(([f]) => f), last])].sort((a, b) => a - b), MAX_FRAMES);
		bodies[name(c.id)] = frames.map(f => `f${f} ${hipsAt(c, f)}`).join("; ");
	}
	const rows = told.length > MAX_ROWS ? [...told.slice(0, MAX_ROWS), `and ${told.length - MAX_ROWS} more`] : told;
	return { frames: F, seconds: Math.round(F / (clip?.fps ?? 24) * 10) / 10, actions, bodies, ...(rows.length ? { rows } : {}) };
}

/** Which of the facts `now` differ from the facts `was` told before: { frames?: "<was> to <now>", bodies?: [ids],
 *  actions?: [ids] } (an id either has and the other lacks differs), or { same: true }. */
function factsSince(was, now) {
	const differ = key => [...new Set([...Object.keys(was[key] ?? {}), ...Object.keys(now[key] ?? {})])].filter(id => was[key]?.[id] !== now[key]?.[id]);
	const bodies = differ("bodies"), actions = differ("actions"), frames = was.frames !== now.frames;
	return frames || bodies.length || actions.length ? { ...(frames ? { frames: `${was.frames} to ${now.frames}` } : {}), ...(bodies.length ? { bodies } : {}), ...(actions.length ? { actions } : {}) } : { same: true };
}

/**
 * The facts of a motion's compiles (job.facts: the latest { n, facts }) as the Studio agent is told them (motion-door.mjs).
 * first: while the motion is written, once, those of the latest compile then, without its rows (the writer still works
 * on them). Else, with the result `done` of a motion that compiled: those of its last compile with its rows, and
 * factsSince when facts were told before: the compile they were of and which differ; facts that are the same are not
 * told again (their compile and its rows are). -> the fields of the answer.
 */
export function factsAnswer(job, done = null, first = false) {
	const latest = job.facts, told = job.toldFacts;
	if (!latest || (first ? told : !done?.frames)) return {};
	job.toldFacts = latest;
	const { rows, ...facts } = latest.facts;
	if (first) return { facts: { compile: latest.n, ...facts } };
	if (!told) return { facts: { compile: latest.n, ...latest.facts } };
	const since = factsSince(told.facts, latest.facts);
	return { facts: { compile: latest.n, ...(since.same ? {} : facts), ...(rows ? { rows } : {}) }, factsSince: { compile: told.n, ...since } };
}

/** While a motion is written, its state as another tool's answer tells it when it changed since last told. */
export const stateOf = job => (job.ended ? "the writer has ended; the install waits for the scene, and motion_result answers it" : `being written, not installed: ${job.drafted && !job.told ? "draft made (motion_result answers it), " : ""}${job.facts ? `compile ${job.facts.n} went through` : "no compile yet"}`);
