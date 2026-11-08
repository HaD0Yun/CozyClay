// Style quantities: how fast a joint moves, how hard it speeds up, how far the centre of mass
// leaves the feet and how deep a knee or elbow bends. They depend on what the motion is for (a
// bat swing moves the wrists at 9 m/s), so QA measures them (output.observations) and does not
// judge them. A spec that names a style limit in checks.limits asks for that quantity to be a
// check again: speedCore/speedLimb -> SPEED, accCore/accLimb -> ACC, knee -> KNEE (bend),
// balance -> BALANCE. A pop is not style: one frame whose acceleration stands out from the
// frames around it is an artifact (a step key, a pole flip, a snapped anchor), so POP stays a
// QA error, and so is a FLOAT: the body off the ground without falling (floatChecks). A pop is a
// spike, not a large value: a hard but continuous acceleration (a swing's launch) is style.
// See docs/motion-api-v3.1.md C13.
import { sub, len, dot, angle } from "../compiler/math.js";
import { capsulesFor, segPoints, sdBox } from "./geometry.js";
import { groundSole, groundY } from "./ground.js";
import { balanceAt } from "./com.js";
import { skinCarries } from "./support.js";
import { relaxedChecks } from "./relaxed.js";

const SPEED_JOINTS = ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot", "LeftLeg", "RightLeg", "LeftForeArm", "RightForeArm"];
const CORE = new Set(["Hips", "Head"]);
const BENDS = [["knee_l", "LeftUpLeg", "LeftLeg", "LeftFoot"], ["knee_r", "RightUpLeg", "RightLeg", "RightFoot"],
	["elbow_l", "LeftArm", "LeftForeArm", "LeftHand"], ["elbow_r", "RightArm", "RightForeArm", "RightHand"]];
/** A pop's acceleration is more than this many times the level around it (popLevel). */
const POP_RATIO = 2;
/** FLOAT: the share of gravity an airborne run may miss (0.75: the hips fall at a quarter of g). */
const FLOAT_LIMIT = 0.75;
/** Peak speed (m/s) under which a joint counts as still and peaks leaves it out. */
const STILL = 0.05;
const r2 = x => Math.round(x * 100) / 100;

/**
 * Per SPEED_JOINT: speed v[f] (m/frame, from f-1), acceleration a[f] (m/frame^2, from f-2) and
 * its vector A[f]; 0 where undefined.
 */
function kinematics(sk, out) {
	const F = out.frames, n = F.length;
	return SPEED_JOINTS.map(j => {
		const X = F.map(fr => fr.s.P[sk.index[j]]), v = new Float64Array(n), a = new Float64Array(n), A = X.map(() => [0, 0, 0]);
		for (let f = 1; f < n; f++) v[f] = len(sub(X[f], X[f - 1]));
		for (let f = 2; f < n; f++) { A[f] = sub(sub(X[f], X[f - 1]), sub(X[f - 1], X[f - 2])); a[f] = len(A[f]); }
		return { j, core: CORE.has(j), v, a, A };
	});
}

/**
 * The acceleration level around frame f that a pop is measured against (m/frame^2), the larger of
 *   far    the largest acceleration 2 and 3 frames away. A one-frame event shows in up to three
 *          neighbouring frames (a step key in f and f+1, a one-frame glitch in f-1..f+1), so the
 *          frames next to f are not read here;
 *   burst  what the frames next to f carry in f's own direction, less what the other one turns
 *          back. At 24 fps a hard move gathers its acceleration into 2 or 3 frames that all push
 *          the same way (a swing's launch, the hips turning round): a burst, not a pop, however
 *          hard. A glitch pushes back on both sides (+1, -2, +1), a step on one (+1, -1), and a
 *          jitter turns back on one side as the other follows (+, -, -, +): those carry none.
 * k = { a, A } (kinematics).
 */
function popLevel({ a, A }, f) {
	let far = 0;
	for (const q of [f - 3, f - 2, f + 2, f + 3]) if (q >= 2 && q < a.length) far = Math.max(far, a[q]);
	const along = a[f] > 0 ? [f - 1, f + 1].filter(q => q >= 2 && q < a.length).map(q => dot(A[q], A[f]) / a[f]) : [];
	return along.length ? Math.max(far, Math.max(...along) + Math.min(0, ...along)) : far;
}

/** True when k.a[f] (m/frame^2) is a pop: above floor and POP_RATIO times popLevel(k, f); k = { a, A } (kinematics). */
export const isPop = (k, f, floor) => k.a[f] > floor && k.a[f] > POP_RATIO * popLevel(k, f);

/** Hard POP issues (limits L: accCore, accLimb are the floor); push(kind, msg, f, value, limit). */
export function popChecks(sk, out, L, push) {
	for (const k of kinematics(sk, out)) {
		const floor = k.core ? L.accCore : L.accLimb;
		for (let f = 2; f < k.a.length; f++) if (isPop(k, f, floor)) push("POP", `${k.j} accel ${(k.a[f] * 100).toFixed(2)} cm/f^2 in one frame`, f, k.a[f], floor);
	}
}

/** Trunk capsules that rest a body on the floor (lying, sitting on it): within this of the floor, the floor carries it. */
const FLOOR_REST = ["hips", "torso_lo", "torso_hi"], FLOOR_TOL = 0.04;
/** True when the floor under the trunk or a declared support (checks.supports) carries the body at frame f. */
function supported(out, f, supports) {
	const { P } = out.frames[f].s, I = out.ctx.sk.index, caps = capsulesFor(out.ctx.sk);
	if (caps.some(([part, a, b, r]) => FLOOR_REST.includes(part) && Math.min(P[I[a]][1], P[I[b]][1]) - r < FLOOR_TOL)) return true;
	return supports.some(sp => {
		const box = out.objectsAt(f)[sp.object], cap = caps.find(c => c[0] === (sp.part ?? "hips"));
		return box && cap && Math.min(...segPoints(P[I[cap[1]]], P[I[cap[2]]]).map(p => sdBox(p, box))) - cap[3] < (sp.tol ?? 0.04);
	});
}

/**
 * Per frame: null where a declared support carries the body, else balanceAt (com.js): "air" with
 * no foot on the ground, or { margin, ... } with margin in metres: how far the mass-weighted
 * centre of mass sits inside the support polygon of the feet on the ground, the floor or an
 * object's top (ground.js; < 0: outside it).
 */
export const balanceFrames = (out, supports = []) => out.frames.map((_, f) => (supported(out, f, supports) ? null : balanceAt(out, f)));

/** True when a hand rests on the ground at frame f: its wrist or knuckles within HAND_DOWN of the ground under them. */
const HAND_DOWN = 0.06;
function handDown(out, f) {
	const { P } = out.frames[f].s, I = out.ctx.sk.index;
	return ["Left", "Right"].some(S => [`${S}Hand`, `${S}HandMiddle1`].some(j => I[j] !== undefined && P[I[j]][1] - groundY(out, f, P[I[j]]) < HAND_DOWN));
}

/**
 * Runs [a, b] (indexes of out.frames) with both soles 2 cm or more above the ground (ground.js), no hand on it, no
 * declared support and no skin on a surface (support.js: a knee, the back or a forearm on the floor, a hand on a bar).
 */
export function airRuns(out, supports = []) {
	const n = out.frames.length, runs = [];
	const air = out.frames.map((_, f) => ["Left", "Right"].every(S => { const sp = groundSole(out, f, S); return Math.min(sp.heel[1], sp.ball[1]) >= 0.02; })
		&& !handDown(out, f) && !supported(out, f, supports) && !skinCarries(out, f));
	for (let a = 0; a < n; a++) {
		if (!air[a]) continue;
		let b = a;
		while (b + 1 < n && air[b + 1]) b++;
		runs.push([a, b]);
		a = b;
	}
	return runs;
}

/**
 * Hard FLOAT issues: 4 or more frames off the ground (airRuns) in which the hips do not fall.
 * A jump or a drop is ballistic: over the run the hips' vertical speed drops by gravity (the
 * speed into the run minus the speed out of it, per frame, is g). A body held up by nothing
 * keeps it; under a quarter of g is a float. value = the share of g missing (1 = no fall).
 */
export function floatChecks(out, checks = {}) {
	const F = out.frames, n = F.length, I = out.ctx.sk.index, g = 9.81 / (out.fps ?? 24) ** 2, f0 = out.f0 ?? 0, issues = [];
	const y = f => F[Math.max(0, Math.min(n - 1, f))].s.P[I.Hips][1];
	for (const [a, b] of airRuns(out, checks.supports)) {
		const frames = b - a + 1;
		if (frames < 4) continue;
		const vin = a > 0 ? y(a) - y(a - 1) : y(a + 1) - y(a), vout = b < n - 1 ? y(b + 1) - y(b) : y(b) - y(b - 1);
		const missing = 1 - (vin - vout) / frames / g;
		if (missing <= FLOAT_LIMIT) continue;
		for (let f = a; f <= b; f++) issues.push({ kind: "FLOAT", msg: `no foot on the ground f${a + f0}-f${b + f0}, hips fall at ${Math.round(Math.max(0, 1 - missing) * 100)}% of g`, frame: f, value: +missing.toFixed(4), limit: FLOAT_LIMIT });
	}
	return issues;
}

const bendAt = (sk, s, [, a, b, c]) => angle(sub(s.P[sk.index[b]], s.P[sk.index[a]]), sub(s.P[sk.index[c]], s.P[sk.index[b]]));

/**
 * The style checks the spec opted into by naming their limit in checks.limits (own keys only);
 * L is QA_LIMITS merged with them. Issues as generalChecks makes them (f indexes out.frames).
 */
export function styleChecks(sk, out, checks, L) {
	const own = checks?.limits ?? {}, on = k => Object.hasOwn(own, k), issues = [];
	const push = (kind, msg, f, value, limit) => issues.push({ kind, msg, frame: f, value: +value.toFixed(4), limit });
	for (const k of kinematics(sk, out)) {
		const { j, core, v, a } = k, vk = core ? "speedCore" : "speedLimb", ak = core ? "accCore" : "accLimb";
		for (let f = 1; f < v.length; f++) {
			if (on(vk) && v[f] > L[vk]) push("SPEED", `${j} ${(v[f] * 100).toFixed(1)} cm/frame`, f, v[f], L[vk]);
			// a pop is already a POP group
			if (on(ak) && f > 1 && a[f] > L[ak] && !isPop(k, f, L[ak])) push("ACC", `${j} accel ${(a[f] * 100).toFixed(2)} cm/f^2`, f, a[f], L[ak]);
		}
	}
	if (on("knee")) out.frames.forEach(({ s }, f) => {
		for (const bend of BENDS.slice(0, 2)) {
			const deg = bendAt(sk, s, bend);
			if (deg > L.knee) push("KNEE", `${bend[0] === "knee_l" ? "Left" : "Right"} knee bent ${deg.toFixed(0)}deg`, f, deg, L.knee);
		}
	});
	if (on("balance")) balanceFrames(out, checks.supports).forEach((b, f) => {
		if (b === "air") push("BALANCE", "no foot on the ground", f, 0, 0);
		// one subject whatever the direction: a lean that swings from ahead to left stays one group; the hint says how far and which way
		else if (b && -b.margin > L.balance) push("BALANCE", "centre of mass outside the feet", f, -b.margin, L.balance);
	});
	return issues;
}

/**
 * output.observations: measurements, not verdicts. Frames are absolute (out.f0 added).
 * { units, peaks: { <joint>: { speed: [m/s, f], accel: [m/s^2, f] } } (joints that move: STILL),
 *   balance: { min: [m, f], outside?: [f0, f1], air?: [[f0, f1], ...] (at most 4 runs with both
 *   feet off the ground: the floor or an object's top) }, bend: { knee_l: [deg, f], ... },
 *   relaxed?: [line] (relaxed.js: the limits raised past their defaults, the declared supports that carry nothing true) }
 */
export function observeMotion(sk, out, checks = {}) {
	const f0 = out.f0 ?? 0, fps = out.fps ?? 24, peak = (arr, k) => {
		let at = 0;
		for (let f = 1; f < arr.length; f++) if (arr[f] > arr[at]) at = f;
		return [Math.round(arr[at] * k * 100) / 100, at + f0];
	};
	const peaks = Object.fromEntries(kinematics(sk, out).map(({ j, v, a }) => [j, { speed: peak(v, fps), accel: peak(a, fps * fps) }]).filter(([, p]) => p.speed[0] >= STILL));
	const margins = balanceFrames(out, checks.supports).map(b => (b && b !== "air" ? b.margin : b)), span = test => {
		const fs = margins.map((m, f) => (test(m) ? f + f0 : -1)).filter(f => f >= 0);
		return fs.length ? [fs[0], fs[fs.length - 1]] : null;
	}, air = airRuns(out, checks.supports).slice(0, 4).map(([a, b]) => [a + f0, b + f0]);
	let min = null;
	margins.forEach((m, f) => { if (typeof m === "number" && (!min || m < min[0])) min = [r2(m), f + f0]; });
	const outside = span(m => typeof m === "number" && m < 0);
	const bend = Object.fromEntries(BENDS.map(b => {
		let best = [0, f0];
		out.frames.forEach(({ s }, f) => { const d = bendAt(sk, s, b); if (d > best[0]) best = [d, f + f0]; });
		return [b[0], [Math.round(best[0]), best[1]]];
	}));
	const relaxed = relaxedChecks(out, checks);
	return { units: "[value, frame]; speed m/s, accel m/s^2, balance m inside the feet (< 0 outside), bend deg (0 straight)",
		peaks, balance: { min, ...(outside ? { outside } : {}), ...(air.length ? { air } : {}) }, bend, ...(relaxed.length ? { relaxed } : {}) };
}

/**
 * Per frame, how many times too fast the motion is by what QA reports (fix/retime.js): a pop
 * against its surroundings (square root: acceleration falls with the square of the stretch) and
 * the speed or acceleration limits the spec opted into. L = QA_LIMITS merged with own.
 */
export function speedExcess(sk, out, own, L) {
	const on = k => Object.hasOwn(own ?? {}, k), e = new Float64Array(out.frames.length);
	for (const k of kinematics(sk, out)) {
		const { core, v, a } = k, vk = core ? "speedCore" : "speedLimb", ak = core ? "accCore" : "accLimb";
		for (let f = 1; f < v.length; f++) {
			if (on(vk)) e[f] = Math.max(e[f], v[f] / L[vk]);
			if (f < 2) continue;
			if (isPop(k, f, L[ak])) e[f] = Math.max(e[f], Math.sqrt(a[f] / Math.max(L[ak], POP_RATIO * popLevel(k, f))));
			if (on(ak)) e[f] = Math.max(e[f], Math.sqrt(a[f] / L[ak]));
		}
	}
	return e;
}
