// A character skeleton in any supported naming convention (templates.js), rest pose (T or A) and proportions, as a
// motion3 rig: the canonical Mixamo bones of x-bot-tpose.json, in its order and hierarchy, with this skeleton's joints,
// so createSkeleton accepts it and every skill and spec compiles on it (rigs/index.js registerRig makes it a model).
//   raw  { model?, units: "cm" | "m", bones: [{ name, parent, localPos, localQuat [x, y, z, w] }], mesh?, landmarks? }
//        parent indexes bones (-1 a root). Extra bones (twist and roll bones, IK targets, a root or armature above the
//        hips, metacarpals, face bones) are skipped: a canonical bone's joint is its source bone's, wherever that hangs.
//        landmarks (optional, raw units and axes): { mouth, headEllipsoid: { centre, radii }, sole: { ball, tip } }.
//   opts { template?: id }: forces the template; else detectTemplate picks it (report.detected).
// The take compiled on the rig drives the canonical bones; report.retarget says, per canonical bone, which source bone
// it is and the bind offset that turns a canonical world rotation into the source bone's (source = canonical x offset),
// with the source's axes (report.axes: canonical = axes x source) and its rest pose already normalised.
// The floor is the source's y 0 (z 0 in a Z-up source) when the ankles stand 2 cm or more and at most 15% of the
// height above it; otherwise the ankle is put at 0.039 of the stature, the lateral malleolus height of the published
// segment tables (Drillis & Contini 1966, as tabulated by Winter), and report.grounded says "estimated". The source's
// horizontal placement is kept: an armature at x 3 m has its hips at x 3 m in the bind (skills place the body by their
// own `at`, so the takes do not move with it).
import xBot from "./x-bot-tpose.json" with { type: "json" };
import { createSkeleton } from "../compiler/skeleton.js";
import { add, sub, scale, mul, apply, T, quatFromMat } from "../compiler/math.js";
import { TEMPLATES, detectTemplate, mapBones } from "./templates.js";
import { sourcePose, facingAxes, normalise, ratios, fillMissing, canonicalFrames } from "./adapt-pose.js";
import { measure, landmarksFor } from "./adapt-measure.js";

const REF = createSkeleton(xBot);
const SIDES = ["Left", "Right"], CM = 100;
const REQUIRED = ["Hips", "Head", ...SIDES.flatMap(S => ["Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot"].map(p => `${S}${p}`))];
const ANKLE_RATIO = 0.039, MIN_ANKLE = 0.02, MAX_ANKLE = 0.15;
// A stature outside these is a wrong raw.units, not a body. The collision body's refit grid grows with the cube of the size
// (X Bot rescaled, measured: 10 m 2.6e7 cells 1 s, 20 m 2e8 cells 7 s; 181 m, a cm skeleton declared m, did not finish in 90 s).
const MIN_STATURE = 0.1, MAX_STATURE = 10;
const r6 = v => Math.round(v * 1e6) / 1e6;

function check(raw) {
	if (!raw || !Array.isArray(raw.bones) || !raw.bones.length) throw new Error("adaptRig: raw.bones must be a non-empty array of { name, parent, localPos, localQuat }");
	if (raw.units !== "cm" && raw.units !== "m") throw new Error(`adaptRig: raw.units must be "cm" or "m", got ${JSON.stringify(raw.units)}`);
	// a non-finite value would carry NaN into every joint below the bone and through every take compiled on the rig
	for (const [i, b] of raw.bones.entries()) {
		for (const [field, n] of [["localPos", 3], ["localQuat", 4]]) {
			const v = b?.[field];
			if (v !== undefined && !(Array.isArray(v) && v.length === n && v.every(Number.isFinite))) throw new Error(`adaptRig: bone ${JSON.stringify(b?.name ?? i)} ${field} must be ${n} finite numbers, got ${Array.isArray(v) ? `[${v.join(", ")}]` : JSON.stringify(v)}`);
		}
		// a name, a 1-based index or the bone's own index would hang the bone (and its subtree) somewhere else without a word
		const p = b?.parent;
		if (!(Number.isInteger(p) && p >= -1 && p < raw.bones.length && p !== i)) throw new Error(`adaptRig: bone ${JSON.stringify(b?.name ?? i)} parent must be an index into raw.bones (-1 for a root) other than its own (${i}), got ${JSON.stringify(p)}`);
	}
}

/** The source's own landmarks in canonical metres (see the head of this file), or null. */
function ownLandmarks(raw, B, dy) {
	const L = raw.landmarks, k = raw.units === "m" ? 1 : 0.01;
	if (!L) return null;
	const point = p => (Array.isArray(p) ? add(apply(B, scale(p, k)), [0, dy, 0]) : undefined);
	const e = L.headEllipsoid;
	return { mouth: point(L.mouth), headEllipsoid: e?.centre && e?.radii ? { centre: point(e.centre), radii: apply(B, scale(e.radii, k)).map(Math.abs) } : undefined,
		sole: L.sole && { ball: Number.isFinite(L.sole.ball) ? L.sole.ball * k : undefined, tip: Number.isFinite(L.sole.tip) ? L.sole.tip * k : undefined } };
}

/** Puts the floor at y 0 (see the head of this file): shifts J; returns { dy, grounded }. ankle0 = the source's ankle height. */
function ground(J, ankle0) {
	const ankle = (J.LeftFoot[1] + J.RightFoot[1]) / 2, above = J.HeadTop_End[1] - ankle;
	const own = ankle0 >= MIN_ANKLE && ankle0 <= MAX_ANKLE * (above + ankle0);
	const dy = (own ? ankle0 : (ANKLE_RATIO * above) / (1 - ANKLE_RATIO)) - ankle;
	for (const n of Object.keys(J)) J[n] = add(J[n], [0, dy, 0]);
	return { dy, grounded: own ? "source" : "estimated" };
}

/** The rig JSON's bones: canonical order and parents, bind in cm. */
function bonesOf(J, R) {
	return REF.names.map((name, j) => {
		const p = REF.parent[j], worldPos = scale(J[name], CM).map(r6), worldQuat = quatFromMat(R[name]);
		if (p < 0) return { name, parent: -1, localPos: worldPos, localQuat: worldQuat, worldPos, worldQuat };
		const pn = REF.names[p];
		return { name, parent: p, localPos: scale(apply(T(R[pn]), sub(J[name], J[pn])), CM).map(r6), localQuat: quatFromMat(mul(T(R[pn]), R[name])), worldPos, worldQuat };
	});
}

/**
 * @param {{ model?: string, units: "cm" | "m", bones: { name: string, parent: number, localPos: number[], localQuat: number[] }[] }} raw
 * @param {{ template?: string }} [opts]
 * @returns {{ rig: object, template: string, report: object }} rig = x-bot-tpose.json's shape; report = { template,
 *   detected: { id, score }, mapped: { canonical: source name }, missing: [canonical names made up], extra: [source names
 *   skipped], restPose: "T" | "A", measured: { heightM, legLengthM, armLengthM, ankleHeightM, ... }, grounded, axes, retarget }
 */
export function adaptRig(raw, opts = {}) {
	check(raw);
	const src = sourcePose(raw), detected = detectTemplate(src.names), id = opts.template ?? detected.id, t = TEMPLATES[id];
	if (!t) throw new Error(`adaptRig: no template "${id}" (templates: ${Object.keys(TEMPLATES).join(", ")})`);
	const { mapped: idx } = mapBones(t, src.names), lacking = REQUIRED.filter(n => idx[n] === undefined);
	if (lacking.length) throw new Error(`adaptRig: the ${id} template finds no ${lacking.join(", ")} among the source bones`);
	const B = facingAxes(n => src.P[idx[n]]), pose = { J: {}, SR: {} };
	for (const [n, i] of Object.entries(idx)) { pose.J[n] = apply(B, src.P[i]); pose.SR[n] = mul(B, src.R[i]); }
	const ankle0 = (pose.J.LeftFoot[1] + pose.J.RightFoot[1]) / 2, armDown = normalise(REF, pose), mappedSet = new Set(Object.keys(idx));
	const r = ratios(REF, pose.J, mappedSet);
	fillMissing(REF, pose.J, r);
	const { dy, grounded } = ground(pose.J, ankle0), J = pose.J;
	const stature = J.HeadTop_End[1];
	if (!(stature >= MIN_STATURE && stature <= MAX_STATURE)) throw new Error(`adaptRig: the skeleton stands ${r6(stature)} m read as raw.units "${raw.units}", outside ${MIN_STATURE} to ${MAX_STATURE} m: check raw.units`);
	// a made-up ball stands on the floor as the X Bot's does; every toe segment lies as level as the X Bot's, because toe-off
	// (limbs.js orientFoot) flattens it in one frame and a sloped one would drag the heel. The source's own toe stays in report.retarget.
	for (const S of SIDES) {
		const ball = `${S}ToeBase`, tip = `${S}Toe_End`, y = n => REF.restWorldPos[REF.index[n]][1];
		if (idx[ball] === undefined) J[ball][1] = y(ball) * r.foot[S];
		J[tip][1] = J[ball][1] + (y(tip) - y(ball)) * r.foot[S];
	}
	const R = canonicalFrames(REF, J);
	const model = raw.model ?? `${id}-rig`;
	const rig = { model, units: "cm", mesh: raw.mesh ?? null, bones: bonesOf(J, R), landmarks: landmarksFor(REF, xBot.landmarks, J, R, r, ownLandmarks(raw, B, dy)) };
	const used = new Set(Object.values(idx));
	const retarget = Object.fromEntries(Object.entries(idx).map(([n, i]) => [n, { source: src.names[i], offset: quatFromMat(mul(T(R[n]), pose.SR[n])).map(r6) }]));
	const report = {
		template: id, detected,
		mapped: Object.fromEntries(REF.names.filter(n => idx[n] !== undefined).map(n => [n, src.names[idx[n]]])),
		missing: REF.names.filter(n => idx[n] === undefined), extra: src.names.filter((_, i) => !used.has(i)),
		restPose: armDown > 20 ? "A" : "T", grounded, axes: B.map(row => row.map(r6)),
		measured: measure(REF, J, r, { upperArmDownDeg: Math.round(armDown * 10) / 10, girthScale: rig.landmarks.scale.girth }),
		retarget,
	};
	return { rig, template: id, report };
}
