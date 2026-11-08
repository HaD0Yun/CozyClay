// Body probes for the v4 measure tool: points on the body with a skin radius, named by body part.
// A probe { part, p, r } touches a surface when its signed distance to the surface is below r.
//   capsules   5 points from joint to joint, the QA capsule radius (qa/geometry.js CAPSULES)
//   head       5 points Head to HeadTop_End, radius 0.09
//   sole_<k>   the QA sole points (heel, ball, tip), radius 0
//   tips_<k>   the five fingertips, radius 0.008
//   palm_<k>   midway from the wrist to the middle knuckle (the bench palm landmark)
//   skin       optional: the cells of the fitted skin grid (motion3/body.js) that lie on the skin,
//              carried by their bone, radius 0, named by the bone's part (foot_<k>, fingers_<k> too)
// Contact ends are the points the contacts and balance tables follow (contactEnds).
import { CAPSULES, segPoints, solePoints } from "../../motion3/qa/geometry.js";
import { bodyFor } from "../../motion3/body.js";
import { bonePoint } from "../../motion3/compiler/skeleton.js";
import { apply, T } from "../../motion3/compiler/math.js";

const SIDES = [["l", "Left"], ["r", "Right"]];
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const HEAD_R = 0.09, TIP_R = 0.008, PALM_R = 0.02, KNEE_R = 0.05, ELBOW_R = 0.04;
// The buttocks sit 8 cm below and 11 cm behind the hips joint at rest (bench take.mjs landmark).
const BUTTOCKS = [0, -0.08, -0.11];

// Every part name a probe can carry. foot_<k> and fingers_<k> come from skin points only.
export const PART_NAMES = [...CAPSULES.map(c => c[0]), "head",
	...SIDES.flatMap(([k]) => [`sole_${k}`, `tips_${k}`, `palm_${k}`, `foot_${k}`, `fingers_${k}`])];
// Every contact end name (contactEnds).
export const END_NAMES = [...SIDES.flatMap(([k]) => [`palm_${k}`, `tips_${k}`, `heel_${k}`, `ball_${k}`, `tip_${k}`, `knee_${k}`, `elbow_${k}`]), "buttocks", "head_top"];

const rigs = new WeakMap();

// Bone indexes the probes read, cached per skeleton.
function rigOf(sk) {
	let r = rigs.get(sk);
	if (r) return r;
	const I = sk.index, has = (...names) => names.every(n => I[n] !== undefined);
	r = {
		capsules: CAPSULES.filter(([, a, b]) => has(a, b)).map(([part, a, b, rad]) => [part, I[a], I[b], rad]),
		head: has("Head", "HeadTop_End") ? [I.Head, I.HeadTop_End] : null,
		sides: SIDES.filter(([, S]) => has(`${S}Hand`, `${S}HandMiddle1`, `${S}Foot`, `${S}ToeBase`, `${S}Leg`, `${S}ForeArm`)).map(([k, S]) => ({
			k, S, hand: I[`${S}Hand`], mid1: I[`${S}HandMiddle1`], knee: I[`${S}Leg`], elbow: I[`${S}ForeArm`],
			tips: FINGERS.map(f => I[`${S}Hand${f}4`]).filter(b => b !== undefined),
		})),
		hips: I.Hips,
		buttocks: apply(T(sk.restWorldRot[I.Hips]), BUTTOCKS),
		headTop: I.HeadTop_End,
	};
	rigs.set(sk, r);
	return r;
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// The part a skin point of bone `name` belongs to.
function partOfBone(name) {
	const m = /^(Left|Right)(.*)$/.exec(name);
	if (!m) return { Hips: "hips", Spine: "torso_lo", Spine1: "torso_lo", Spine2: "torso_hi", Neck: "neck" }[name] ?? "head";
	const k = m[1] === "Left" ? "l" : "r", rest = m[2];
	if (/^Hand./.test(rest)) return `fingers_${k}`;
	const parts = { Shoulder: "torso_hi", Arm: `uarm_${k}`, ForeArm: `farm_${k}`, Hand: `hand_${k}`, UpLeg: `thigh_${k}`, Leg: `shin_${k}` };
	return parts[rest] ?? `foot_${k}`;
}

const skins = new WeakMap();

// Skin points of the fitted body, one group per grid: cells within half a cell of the skin, in their
// bone's bind frame, with the grid's centre and reach (a sphere holding every cell).
function skinOf(sk) {
	if (skins.has(sk)) return skins.get(sk);
	const body = bodyFor(sk), groups = [];
	for (const g of body?.grids ?? []) {
		const [nx, ny, nz] = g.dims, step = body.step, locals = [];
		for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
			// grid values are millimetres; |d| < step / 2 in metres
			if (Math.abs(g.data[(x * ny + y) * nz + z]) >= step * 500) continue;
			locals.push([g.min[0] + x * step, g.min[1] + y * step, g.min[2] + z * step]);
		}
		groups.push({ b: g.b, part: partOfBone(sk.names[g.b]), centre: g.centre, reach: g.reach, locals });
	}
	skins.set(sk, groups);
	return groups;
}

/**
 * Probes { part, p, r } of world pose s ({ P, R }); skin adds the fitted skin points. near(centre, reach),
 * when given, keeps only the skin of bones whose sphere it accepts (a fast skip far from every surface).
 */
export function bodyProbes(sk, s, { skin = false, near = null } = {}) {
	const R = rigOf(sk), out = [];
	for (const [part, a, b, r] of R.capsules) for (const p of segPoints(s.P[a], s.P[b], 5)) out.push({ part, p, r });
	if (R.head) for (const p of segPoints(s.P[R.head[0]], s.P[R.head[1]], 5)) out.push({ part: "head", p, r: HEAD_R });
	for (const side of R.sides) {
		const sole = solePoints(sk, s, side.S);
		for (const key of ["heel", "ball", "tip"]) out.push({ part: `sole_${side.k}`, p: sole[key], r: 0 });
		for (const b of side.tips) out.push({ part: `tips_${side.k}`, p: s.P[b], r: TIP_R });
		out.push({ part: `palm_${side.k}`, p: mid(s.P[side.hand], s.P[side.mid1]), r: PALM_R });
	}
	if (skin) for (const g of skinOf(sk)) {
		if (near && !near(bonePoint(s, g.b, g.centre), g.reach)) continue;
		for (const local of g.locals) out.push({ part: g.part, p: bonePoint(s, g.b, local), r: 0 });
	}
	return out;
}

/**
 * Contact ends of world pose s: [{ end, pts, r, kind }]. kind is the balance support kind
 * (feet, hands, knees, hips) or null for an end that never supports the body.
 */
export function contactEnds(sk, s) {
	const R = rigOf(sk), out = [];
	for (const side of R.sides) {
		const { k } = side, sole = solePoints(sk, s, side.S);
		out.push({ end: `palm_${k}`, pts: [mid(s.P[side.hand], s.P[side.mid1])], r: PALM_R, kind: "hands" });
		if (side.tips.length) out.push({ end: `tips_${k}`, pts: side.tips.map(b => s.P[b]), r: TIP_R, kind: null });
		for (const key of ["heel", "ball", "tip"]) out.push({ end: `${key}_${k}`, pts: [sole[key]], r: 0, kind: "feet" });
		out.push({ end: `knee_${k}`, pts: [s.P[side.knee]], r: KNEE_R, kind: "knees" });
		out.push({ end: `elbow_${k}`, pts: [s.P[side.elbow]], r: ELBOW_R, kind: null });
	}
	if (R.hips !== undefined) out.push({ end: "buttocks", pts: [bonePoint(s, R.hips, R.buttocks)], r: 0, kind: "hips" });
	if (R.headTop !== undefined) out.push({ end: "head_top", pts: [s.P[R.headTop]], r: 0, kind: null });
	return out;
}
