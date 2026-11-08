// What a spec relaxes in QA (#1125), as output.observations.relaxed (style.js observeMotion), so a workaround cannot
// clear a problem unseen. Physics bench v2 (2026-11-07): agents raised checks.limits (roof fall back r2/r3: accLimb
// 0.4 lifts the POP floor from 5 to 40 cm/f^2) and declared every body part supported (rolls r1, handstand r2/r3,
// crawl r1), and QA then read 0 with the defect still there. One line each, at most LINES:
//   limits    the checks.limits values above their defaults, with what QA no longer reports under them (a raised
//             plantH or self makes QA stricter, and speed, knee and balance limits only opt a style check in)
//   parts     checks.supports entries naming no part (CAPSULES: "thigh" has no side): they carry nothing
//   never     entries whose part's skin never comes within NEAR (support.js) of their object: a false support
//   claims    entries whose tol alone carries frames (nothing else does: support.js) where the part's skin is farther
//             than NEAR from the object
//   redundant entries the skin model carries the body on wherever they do (support.js): not needed
import { T } from "../compiler/math.js";
import { QA_LIMITS } from "./checks.js";
import { CAPSULES, segPoints, sdBox } from "./geometry.js";
import { visitSkin } from "./floor.js";
import { NEAR, boxDist, skinCarries } from "./support.js";

const NOT_RELAXED = new Set(["plantH", "self", "speedCore", "speedLimb", "knee", "balance"]);
const HIDES = { allow: "COLLIDE", groundAllow: "GROUND", reach: "REACH", slide: "SLIDE", accCore: "POP, ACC", accLimb: "POP, ACC", flip: "FLIP",
	headAllow: "FACE", body: "BODY", skin: "BODY", hands: "SELF", object: "OBJECT", grab: "GRAB" };
/** A capsule's skin lies within this (m) outside its surface (the capsules sit up to 10 cm off the skin: floor.js). */
const SKIN_OUT = 0.1, SUPPORT_TOL = 0.04, LINES = 5, LISTED = 4;
const r3 = v => Math.round(v * 1000) / 1000;
/** At most LISTED items of a list, the rest counted. */
const listed = items => items.slice(0, LISTED).join(", ") + (items.length > LISTED ? ` (+${items.length - LISTED} more)` : "");

function limitsLine(limits = {}) {
	const up = Object.entries(limits).filter(([k, v]) => typeof v === "number" && v > QA_LIMITS[k] && !NOT_RELAXED.has(k));
	if (!up.length) return null;
	const kinds = [...new Set(up.flatMap(([k]) => (HIDES[k] ?? k).split(", ")))].join(", ");
	return `checks.limits above the defaults: ${up.map(([k, v]) => `${k} ${v} (default ${QA_LIMITS[k]})`).join(", ")}: ${kinds} under them go unreported; fix the motion, not the limit`;
}

/** Per frame of out: does entry sp's capsule test (style.js supported) carry the body, and how near its part's skin comes to the object. */
function readSupport(out, sp) {
	const sk = out.ctx.sk, I = sk.index, part = sp.part ?? "hips", cap = CAPSULES.find(c => c[0] === part), tol = sp.tol ?? SUPPORT_TOL;
	const keep = /^hand_[lr]$/.test(part) ? p => p === part || p === `fingers_${part.slice(-1)}` : p => p === part;
	const frames = [];
	let nearest = Infinity, ever = false, seen = false;
	out.frames.forEach(({ s }, f) => {
		const box = out.objectsAt(f)[sp.object];
		if (!box?.half) return;
		seen = true;
		const P = s.P, gap = Math.min(...segPoints(P[I[cap[1]]], P[I[cap[2]]]).map(p => sdBox(p, box))) - cap[3], claimed = gap < tol;
		if (!claimed && (ever || gap > NEAR + SKIN_OUT)) return;
		const b = { box, RT: T(box.R) };
		let d = Infinity;
		const near = visitSkin(sk, s, (_, x, y, z, r) => { d = Math.min(d, boxDist(b, x, y, z) - r); return d < NEAR; }, keep);
		nearest = Math.min(nearest, d);
		ever ||= near;
		if (claimed) frames.push({ f, near, d });
	});
	return { part, tol, nearest, ever, seen, frames };
}

/** Frames (indexes of out.frames) as absolute runs, at most 3: "f65-66, f122-137". */
function span(fs, f0) {
	const runs = [];
	for (const f of fs) { const last = runs[runs.length - 1]; if (last && f === last[1] + 1) last[1] = f; else runs.push([f, f]); }
	return runs.slice(0, 3).map(([a, b]) => `f${a + f0}${b > a ? `-${b + f0}` : ""}`).join(", ") + (runs.length > 3 ? ", ..." : "");
}
/** How near a part came: the metres, or past what readSupport reads (its capsule farther than NEAR + SKIN_OUT), or no such body. */
const nearestOf = r => (!r.seen ? "not a scene body QA reads" : Number.isFinite(r.nearest) ? `nearest ${r3(r.nearest)} m` : `nearest over ${r3(NEAR + SKIN_OUT)} m`);

/** observations.relaxed lines for compile out and its checks ([] when the spec relaxes nothing). */
export function relaxedChecks(out, checks = {}) {
	const lines = [limitsLine(checks.limits)].filter(Boolean), f0 = out.f0 ?? 0, unknown = [], never = [], redundant = [], carried = new Map();
	const carries = f => { if (!carried.has(f)) carried.set(f, skinCarries(out, f)); return carried.get(f); };
	(checks.supports ?? []).forEach((sp, i) => {
		if (!CAPSULES.some(c => c[0] === (sp.part ?? "hips"))) { unknown.push(sp.part); return; }
		// the frames only this entry keeps out of FLOAT with its part off its object: nothing else carries the body there
		const r = readSupport(out, sp), at = `checks.supports[${i}] ${r.part} on ${sp.object}`;
		const off = r.ever ? r.frames.filter(x => !x.near && !carries(x.f)) : [];
		if (!r.ever && r.frames.length) lines.push(`${at}: ${r.part} never comes within ${NEAR} m of ${sp.object} (${nearestOf(r)}), yet tol ${r.tol} carries ${span(r.frames.map(x => x.f), f0)}`);
		else if (!r.ever) never.push(`[${i}] ${r.part} on ${sp.object} (${nearestOf(r)})`);
		else if (off.length) lines.push(`${at}: tol ${r.tol} alone carries ${span(off.map(x => x.f), f0)}, ${r.part} up to ${r3(Math.max(...off.map(x => x.d)))} m off ${sp.object}`);
		else if (r.frames.every(x => carries(x.f))) redundant.push(`[${i}] ${r.part}`);
	});
	if (unknown.length) lines.push(`checks.supports part ${listed([...new Set(unknown)])}: no such part (sides: thigh_l, thigh_r, ...; parts: ${CAPSULES.map(c => c[0]).filter(p => !/_r$/.test(p)).join(", ")}): those entries carry nothing`);
	if (never.length) lines.push(`checks.supports ${listed(never)}: never within ${NEAR} m of it: a support the body does not touch carries nothing true`);
	if (redundant.length) lines.push(`checks.supports ${listed(redundant)}: the skin on the floor or a hand on a body carries it wherever they do: not needed`);
	return lines.length > LINES ? [...lines.slice(0, LINES - 1), `${lines.length - LINES + 1} more relaxed checks`] : lines;
}
