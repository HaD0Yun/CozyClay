// Measured, not judged (output.observations.asked): what the spec asked against what the take did, the
// quantities agents probed or re-compiled for right after a compile (session study: the root where a walk
// ended, the mouth and the cup top on the drink frame, when the fingers met the cup), one line each:
//   use[i] <skill>[ <side> <anchor>] f<a>-<b>: at [x, z] yaw <deg>[ (asked <deg>)][; to [x, z]: <m> m short|past[, <m> m aside][, ...]]
//       at = the feet's midpoint at the skill's last frame (what walkTo.to and standIdle.at place), yaw = the
//       body's heading there; a walkTo whose steps are given only aims at to (the steps set the distance)
//   <contact name> f<a>-<b>: gap <cm> f<f> .. <cm> f<f> (tol <cm>)   checks.contacts (reachGrip adds "fingers
//       on <anchor>"): the frames its when holds, the closest and the farthest gap; "never on" when it never holds
//       [; palm centre <cm> .. <cm> (needs <= 4)]   on a power grip's anchor, the palm centre's gap on those frames too
//       (grasp-checks.js PALM_GAP): the fingers' point sits on a bar while the palm stays 7 cm off it
//   goal <name> f<f>: <ref> [x, y, z], <ref> [x, y, z][; best <m> f<f>]   the goal's points on the frame its
//       result names (near and above; moved and still when they fail); best: the closest frame of a near goal
//       held on every frame
// An object ref is a point of the AABB of its boxes (refs.js), so a line names which: (box top) is the top-face
// centre, not a rim or an opening; (box base) the bottom-face centre; (box centre) the centre; a bare object in
// a near goal is its surface. Frames are absolute and follow a retime (out.timeMap); metres to 3 decimals.
import { refPoint, refDistance } from "../refs.js";
import { active, contactGap } from "./spec-checks.js";
import { palmGapAt } from "./grasp-checks.js";
import { goalKinds, goalName, movedRef } from "./goals.js";
import { m3 } from "./fmt.js";

const MAX_SKILLS = 8, MAX_CONTACTS = 6, MAX_GOALS = 8, OFF = 0.05, YAW_OFF = 5;

const v3 = p => `[${p.map(m3).join(", ")}]`;
const cm = v => `${Math.round(v * 1000) / 10}`;
const wrap = d => ((d % 360) + 540) % 360 - 180;
const meaning = { top: " (box top)", base: " (box base)", center: " (box centre)", rim: " (opening)" };

/** A ref with what an object point is: "object:cup.top (box top)". */
function named(ref, bare) {
	const m = /^object:.+?(?:\.(center|top|base|rim))?$/s.exec(ref);
	if (!m) return ref;
	return `${ref}${m[1] ? meaning[m[1]] : bare ? " (surface)" : meaning.center}`;
}

/** The feet's midpoint [x, z] and the heading at absolute frame f, or null outside the compiled window. */
function standAt(out, f) {
	const fr = out.frames[f - (out.f0 ?? 0)];
	if (!fr) return null;
	const { P } = fr.s, I = out.ctx.sk.index, l = P[I.LeftFoot], r = P[I.RightFoot];
	return { at: [(l[0] + r[0]) / 2, (l[2] + r[2]) / 2], yaw: fr.c?.yaw ?? 0 };
}

function skillLine(out, u, i, use, map) {
	const last = out.frameCount - 1, clamp = f => Math.max(0, Math.min(last, Math.round(map(f))));
	const a = clamp(u.f0), b = clamp(u.end ?? u.f0), end = standAt(out, b), args = use?.args ?? {};
	if (!end) return null;
	const side = args.side ? ` ${args.side}` : "", anchor = args.anchor ? ` ${args.anchor}` : "";
	let line = `use[${i}] ${u.skill}${side}${anchor} f${a}-${b}: at ${v3(end.at)} yaw ${Math.round(wrap(end.yaw))}`;
	const heading = Array.isArray(args.heading) ? args.heading[args.heading.length - 1] : args.heading;
	if (typeof heading === "number" && Math.abs(wrap(end.yaw - heading)) > YAW_OFF) line += ` (asked ${heading})`;
	const goal = Array.isArray(args.to) ? [args.to[0], args.to[args.to.length - 1]] : Array.isArray(args.at) && !u.placed ? args.at : null;
	if (goal) {
		const d = [end.at[0] - goal[0], end.at[1] - goal[1]], off = Math.hypot(...d);
		if (off > OFF) {
			const start = args.to && standAt(out, a), dir = start && Math.hypot(goal[0] - start.at[0], goal[1] - start.at[1]) > 1e-6
				? [goal[0] - start.at[0], goal[1] - start.at[1]].map((x, _, v) => x / Math.hypot(...v)) : null;
			const along = dir ? d[0] * dir[0] + d[1] * dir[1] : null, aside = dir ? Math.abs(d[0] * dir[1] - d[1] * dir[0]) : null;
			const how = dir ? `${m3(Math.abs(along))} m ${along < 0 ? "short" : "past"}${aside > OFF ? `, ${m3(aside)} m aside` : ""}` : `${m3(off)} m off`;
			line += `; ${args.to ? "to" : "at"} ${v3(goal)}: ${how}${args.to && args.steps !== undefined ? ", args.steps set the distance (to only aims)" : ""}`;
		}
	}
	return line;
}

/** The hand and the object of a power grip a contact's target anchor takes ({ k, id }), or null. */
function powerGrip(out, k) {
	const { spec } = out.ctx, a = spec.anchors?.[/^anchor:(.+)$/s.exec(k.target ?? "")?.[1]], hand = spec.props?.[/^prop:([^.]+)\./.exec(k.point ?? "")?.[1]]?.hand;
	return a?.kind === "object" && a.grasp === "power" && (hand === "l" || hand === "r") ? { k: hand, id: a.object } : null;
}

function contactLine(out, k) {
	const f0 = out.f0 ?? 0, grip = powerGrip(out, k);
	let lo = null, hi = null, first = null, lastOn = null, palm = null;
	for (let f = 0; f < out.frames.length; f++) {
		if (!active(out, f, k.when)) continue;
		first ??= f + f0; lastOn = f + f0;
		const p = grip && palmGapAt(out, grip.k, grip.id, f + f0);
		if (p !== null && p !== undefined) palm = [Math.min(palm?.[0] ?? p, p), Math.max(palm?.[1] ?? p, p)];
		const e = contactGap(out, f, k);
		if (e === null) continue;
		if (!lo || e < lo[0]) lo = [e, f + f0];
		if (!hi || e > hi[0]) hi = [e, f + f0];
	}
	if (first === null) return `${k.name}: never on${typeof k.when === "string" ? ` (${k.when} never > 0.99)` : ""}`;
	return `${k.name} f${first}-${lastOn}: gap ${lo ? `${cm(lo[0])} cm f${lo[1]} .. ${cm(hi[0])} cm f${hi[1]}` : "unknown"} (tol ${cm(k.tol ?? 0.01)})${palm ? `; palm centre ${cm(palm[0])} .. ${cm(palm[1])} cm (needs <= 4)` : ""}`;
}

function goalLine(out, g, i, result) {
	const kind = goalKinds(g)[0];
	if (!result || result.at === null || !(kind === "near" || kind === "above" || (!result.ok && (kind === "moved" || kind === "still")))) return null;
	const refs = kind === "near" || kind === "above" ? g[kind] : [movedRef(g[kind].includes(":") ? g[kind] : `object:${g[kind]}`)];
	const pts = refs.map(r => [r, refPoint(out, result.at, r)]);
	if (pts.some(([, p]) => !p)) return null;
	let line = `goal ${goalName(g, i)} f${result.at}: ${pts.map(([r, p]) => `${named(r, kind === "near")} ${v3(p)}`).join(", ")}`;
	if (kind === "near" && Array.isArray(g.at) && g.at[0] !== g.at[1] && (g.mode ?? "all") === "all") {
		const f0 = out.f0 ?? 0;
		let best = null;
		for (let f = Math.max(g.at[0], f0); f <= Math.min(g.at[1], f0 + out.frames.length - 1); f++) {
			const d = refDistance(out, f, g.near[0], g.near[1]);
			if (d !== null && (!best || d < best[0])) best = [d, f];
		}
		if (best && best[1] !== result.at) line += `; best ${m3(best[0])} f${best[1]}`;
	}
	return line;
}

/**
 * observeAsked(out, { used, use, checks, goals, results }) -> string[] | null
 * @param {object} out  compileMotion result
 * @param {{ used: object[], use?: object[], checks?: object, goals?: object[], results?: object[] }} ctx  used = the skills
 *   expandUse ran, use = the spec's own use entries (their args are what was asked), checks = the measured checks,
 *   goals = the expanded spec's goals and results = qa.goals (same order, by name)
 */
export function observeAsked(out, { used = [], use = [], checks = {}, goals = [], results = [] }) {
	const map = out.timeMap ?? (f => f), byName = new Map(results.map(r => [r.name, r]));
	const lines = [
		...used.slice(0, MAX_SKILLS).map((u, i) => skillLine(out, u, i, use[i], map)),
		...(checks.contacts ?? []).slice(0, MAX_CONTACTS).map(k => contactLine(out, k)),
		...goals.map((g, i) => goalLine(out, g, i, byName.get(goalName(g, i)))).filter(Boolean).slice(0, MAX_GOALS),
	].filter(Boolean);
	return lines.length ? lines : null;
}
