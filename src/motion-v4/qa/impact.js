// Ballistic landings in QA's POP groups (v4 qa). runMotionQa flags any one-frame stop as a POP
// (style.js popChecks), so an exact free fall that ends on the floor in one frame reads as an error
// (research wave-2-Vraw: Blender's roof fall, -1.00 g on every frame, then a one-frame stop). A POP
// frame f is a ballistic impact when
//   (a) an air run [a, b] of 3+ frames (air.js runsOf) ends at f - 2, f - 1 or f. A pop's
//       acceleration spans frames f-2..f, so a body that lands at b + 1 and stays shows its stop at
//       b + 2: the last air frame is f - 2 (the design named f - 1 and f only);
//   (b) on the run's inner frames the hips fall at g, each frame within 15% (air.js runG);
//   (c) at f or f + 1 a sole point, a palm, a knee or the buttocks is within 5 cm of the floor or a
//       box top (ground.js groundY).
// Such POP frames leave their group and become impact rows; every other POP frame stays.
import { popChecks } from "../../motion3/qa/style.js";
import { QA_LIMITS } from "../../motion3/qa/checks.js";
import { groundY } from "../../motion3/qa/ground.js";
import { solePoints } from "../../motion3/qa/geometry.js";
import { groupKey, LOW_IS_BAD, rankGroups } from "../../motion3/qa/severity.js";
import { add, apply, scale, T } from "../../motion3/compiler/math.js";
import { bonePoint } from "../../motion3/compiler/skeleton.js";
import { runsOf, runG } from "./air.js";

/** Each inner frame of the run falls within this share of g. */
const G_TOL = 0.15;
/** A landing point this close (m) to the ground under it takes the impact. */
const NEAR = 0.05;
/** The skin under the knee joint (m), as measure's knee contact reads it. */
const KNEE_R = 0.05;
/** The buttocks: this offset from the Hips joint in the rest pose's world axes (bench take.mjs:45). */
const BUTTOCKS = [0, -0.08, -0.11];

/**
 * Issues -> groups by kind and subject (severity.js groupKey), the way runMotionQa groups them:
 * { kind, subject, count, worst, worstFrame, first, last, limit }, ranked by severity.js.
 */
export function groupIssues(issues) {
	const groups = new Map();
	for (const i of issues) {
		const key = groupKey({ kind: i.kind, subject: i.msg });
		const g = groups.get(key) ?? { kind: i.kind, subject: i.msg, count: 0, worst: i.value, worstFrame: i.frame, first: i.frame, last: i.frame, limit: i.limit };
		g.count++; g.first = Math.min(g.first, i.frame); g.last = Math.max(g.last, i.frame);
		const worse = LOW_IS_BAD.has(i.kind) ? i.value < g.worst : i.value > g.worst;
		if (worse) { g.worst = i.value; g.worstFrame = i.frame; g.subject = i.msg; }
		groups.set(key, g);
	}
	return rankGroups([...groups.values()]);
}

/** True when a sole point, a palm centre, a knee or the buttocks is within NEAR of the ground under it at frame index i. */
function landedAt(out, i) {
	const sk = out.ctx.sk, I = sk.index, s = out.frames[i].s, points = [];
	for (const S of ["Left", "Right"]) {
		const sole = solePoints(sk, s, S);
		points.push([sole.heel, 0], [sole.ball, 0], [sole.tip, 0], [s.P[I[`${S}Leg`]], KNEE_R]);
		points.push([scale(add(s.P[I[`${S}Hand`]], s.P[I[`${S}HandMiddle1`]]), 0.5), 0]);
	}
	points.push([bonePoint(s, I.Hips, apply(T(sk.restWorldRot[I.Hips]), BUTTOCKS)), 0]);
	return points.some(([p, r]) => p[1] - r - groundY(out, i, p) <= NEAR);
}

/** POP frame index f -> { run: [a, b], gRatio } when it is a ballistic landing, else null. */
function impactFinder(out) {
	const n = out.frames.length, landings = [];
	for (const [a, b] of runsOf(out)) {
		if (b - a + 1 < 3) continue;
		const gs = runG(out, a, b);
		if (gs.length && gs.every(g => Math.abs(g - 1) <= G_TOL)) landings.push({ run: [a, b], gRatio: gs.reduce((s, g) => s + g, 0) / gs.length });
	}
	const landed = new Map(), isLanded = i => {
		if (!landed.has(i)) landed.set(i, landedAt(out, i));
		return landed.get(i);
	};
	return f => landings.find(({ run: [, b] }) => f - b >= 0 && f - b <= 2 && (isLanded(f) || (f + 1 < n && isLanded(f + 1)))) ?? null;
}

/**
 * Splits runMotionQa's groups into { groups, impacts }: POP frames that end a ballistic air run
 * leave their group (a group with none left is dropped, one with some left is rebuilt from the
 * rest); impacts: [{ joint, frame, run: [a, b], gRatio }], frames absolute.
 */
export function ballisticImpacts(out, groups) {
	const f0 = out.f0 ?? 0, find = impactFinder(out), pops = new Map(), impacts = [];
	popChecks(out.ctx.sk, out, { ...QA_LIMITS, ...out.ctx.spec?.checks?.limits }, (kind, msg, f, value, limit) => {
		const key = groupKey({ kind, subject: msg });
		if (!pops.has(key)) pops.set(key, []);
		pops.get(key).push({ kind, msg, frame: f + f0, value: +value.toFixed(4), limit, at: f });
	});
	const kept = [];
	for (const g of groups) {
		const issues = g.kind === "POP" ? pops.get(groupKey(g)) : null;
		if (!issues) { kept.push(g); continue; }
		const rest = [];
		for (const issue of issues) {
			const hit = find(issue.at);
			if (!hit) { rest.push(issue); continue; }
			impacts.push({ joint: issue.msg.split(" ")[0], frame: issue.frame, run: hit.run.map(f => f + f0), gRatio: Math.round(hit.gRatio * 1000) / 1000 });
		}
		if (rest.length === issues.length) kept.push(g);
		else kept.push(...groupIssues(rest));
	}
	impacts.sort((x, y) => x.frame - y.frame);
	return { groups: rankGroups(kept), impacts };
}
