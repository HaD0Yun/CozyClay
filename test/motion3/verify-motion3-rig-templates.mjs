#!/usr/bin/env node
// Rig templates (src/motion3/rigs/adapt.js): a skeleton in each supported naming convention, built here from the X Bot
// bind (x-bot-tpose.json) renamed to that convention, its segments rescaled by 0.85-1.15, four of them in an A-pose,
// each with extra bones (twist bones in and out of the limb chains, IK targets, metacarpals, spine and neck joints the
// canonical rig has no place for, face bones) and a root above the hips (two of them Z-up, one in metres, one listed
// children first, every bone in an axis convention of its own), is detected as its template, adapted to the canonical
// rig, registered (rigs/index.js registerRig) and compiled: standIdle + walkTo, a reachGrip and the flip skill's back
// tuck with QA no worse than the X Bot's plus TOL pop frames (and no issue of any other kind). The X Bot and
// Y Bot takes stay byte-identical to the takes before rig templates (sha256 pinned at 3804b63b).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { adaptRig } from "../../src/motion3/rigs/adapt.js";
import { TEMPLATES } from "../../src/motion3/rigs/templates.js";
import { skeletonFor, registerRig } from "../../src/motion3/rigs/index.js";
import { createSkeleton } from "../../src/motion3/compiler/skeleton.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { bodyFor } from "../../src/motion3/body.js";
import { add, sub, scale, mul, apply, T, rx, rz, angle, dist, matFromQuat, quatFromMat } from "../../src/motion3/compiler/math.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const xBot = JSON.parse(readFileSync(new URL("../../src/motion3/rigs/x-bot-tpose.json", import.meta.url), "utf8"));
const REF = createSkeleton(xBot), SIDES = ["Left", "Right"];

// --- synthetic skeletons --------------------------------------------------------------------------------------------
/** Segment group of a canonical bone, for its rescale factor. */
const group = n => (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(n) ? "hand" : /Toe/.test(n) ? "foot" : /(UpLeg|Leg|Foot)$/.test(n) ? "leg"
	: /(Arm|ForeArm|Hand)$/.test(n) ? "arm" : /Shoulder$/.test(n) ? "width" : /^(Neck|Head|HeadTop_End)$/.test(n) ? "neck" : "spine");

/** The canonical source name per bone for template t (first name, first prefix), or null where t has none. */
function namesFor(t) {
	const out = {}, fill = (n, S) => n.replace(/\{(\w+)\}/g, (_, k) => t.sides[S][k]), pre = (t.prefixes ?? [""])[0];
	for (const [key, names] of Object.entries(t.bones)) {
		if (key.includes("{Side}")) for (const S of SIDES) out[key.replace("{Side}", S)] = pre + fill(names[0], S);
		else out[key] = pre + names[0];
	}
	for (const S of SIDES) for (const [f, joints] of Object.entries(t.fingers)) joints.forEach((j, i) => { out[`${S}Hand${f}${i + 1}`] = pre + fill([j].flat()[0], S); });
	return out;
}

/**
 * A raw skeleton for template c.id from the X Bot bind: { raw, expect } (expect: the leg and arm lengths, the ankle
 * height and the canonical bones the template has no name for).
 */
function synth(c) {
	const t = TEMPLATES[c.id], names = namesFor(t), f = c.scale, P = {}, R = {};
	REF.names.forEach((n, j) => {
		const p = REF.parent[j];
		P[n] = p < 0 ? REF.restWorldPos[j].slice() : add(P[REF.names[p]], scale(sub(REF.restWorldPos[j], REF.restWorldPos[p]), f[group(n)]));
		R[n] = REF.restWorldRot[j];
	});
	for (const [S, sg] of [["Left", -1], ["Right", 1]]) {
		const Rm = rz(sg * (c.aPose ?? 0)), pivot = P[`${S}Arm`];
		for (const j of REF.subtree[REF.index[`${S}Arm`]]) { const n = REF.names[j]; P[n] = add(pivot, apply(Rm, sub(P[n], pivot))); R[n] = mul(Rm, R[n]); }
	}
	const floor = Math.min(P.LeftToeBase[1], P.RightToeBase[1]);
	for (const n of REF.names) P[n] = sub(P[n], [0, floor, 0]);
	// bones: canonical ones the template names (a canonical bone it lacks hands its children to its parent), then extras
	const list = [{ name: "root", up: null, P: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }], at = {};
	const keep = REF.names.filter(n => names[n] && !(c.drop ?? []).includes(n));
	for (const n of keep) {
		let p = REF.parent[REF.index[n]];
		while (p >= 0 && !keep.includes(REF.names[p])) p = REF.parent[p];
		at[n] = list.length;
		list.push({ name: names[n], up: p < 0 ? "root" : REF.names[p], P: P[n], R: R[n], canon: n });
	}
	for (const e of c.extras) {
		// { name, between: [canonical parent, [canonical children]], t } in the chain; or { name, under, t?, to? } a leaf
		const parent = e.between ? e.between[0] : e.under, p = parent === "root" ? [0, 0, 0] : P[parent];
		const q = e.between ? P[e.between[1][0]] : e.to ? P[e.to] : add(p, [0, 0.03, 0]);
		at[e.name] = list.length;
		P[e.name] = add(p, scale(sub(q, p), e.t ?? 0.5));
		R[e.name] = parent === "root" ? list[0].R : R[parent];
		list.push({ name: e.name, up: parent, P: P[e.name], R: R[e.name] });
		for (const child of e.between?.[1] ?? []) list[at[child]].up = e.name;
	}
	const index = name => (name === "root" ? 0 : at[name]);
	// a Z-up source: the root turns the Y-up body up onto +Z; each bone in its own axis convention (C)
	const Rroot = c.zUp ? rx(90) : list[0].R, k = c.units === "m" ? 1 : 100, C = rz(c.axisTurn ?? 0);
	const W = list.map((b, i) => (i === 0 ? Rroot : mul(mul(Rroot, b.R), C))), WP = list.map((b, i) => (i === 0 ? [0, 0, 0] : apply(Rroot, b.P)));
	let bones = list.map((b, i) => {
		const p = i === 0 ? -1 : index(b.up);
		return { name: b.name, parent: p, localPos: p < 0 ? [0, 0, 0] : scale(apply(T(W[p]), sub(WP[i], WP[p])), k), localQuat: quatFromMat(p < 0 ? W[i] : mul(T(W[p]), W[i])) };
	});
	if (c.reversed) {
		const order = bones.map((_, i) => bones.length - 1 - i);
		bones = order.map(i => ({ ...bones[i], parent: bones[i].parent < 0 ? -1 : bones.length - 1 - bones[i].parent }));
	}
	const len = (a, b, d) => dist(P[a], P[b]) + dist(P[b], P[d]);
	return { raw: { units: c.units ?? "cm", bones }, expect: { leg: len("LeftUpLeg", "LeftLeg", "LeftFoot"), arm: len("LeftArm", "LeftForeArm", "LeftHand"), ankle: P.LeftFoot[1],
		missing: REF.names.filter(n => !keep.includes(n)) } };
}

const twist = (S, s) => [{ name: `upperarm_twist_01_${s}`, under: `${S}Arm`, to: `${S}ForeArm` }, { name: `lowerarm_twist_01_${s}`, under: `${S}ForeArm`, to: `${S}Hand` }];
const CASES = [
	{ id: "mixamo", scale: { spine: 1.05, neck: 0.95, width: 1.1, arm: 0.9, hand: 0.92, leg: 1.12, foot: 1.08 },
		extras: [{ name: "mixamorig:Root", between: ["root", ["Hips"]], t: 0 }, { name: "mixamorig:LeftHandIK", under: "root" }, { name: "mixamorig:RightHandIK", under: "root" }, { name: "mixamorig:Jaw", under: "Head" }] },
	{ id: "ue5", zUp: true, axisTurn: 90, scale: { spine: 0.92, neck: 1.08, width: 0.95, arm: 1.12, hand: 1.1, leg: 0.88, foot: 0.9 },
		extras: [{ name: "spine_02", between: ["Spine", ["Spine1"]] }, { name: "spine_04", between: ["Spine1", ["Spine2"]] }, { name: "neck_02", between: ["Neck", ["Head"]] },
			...twist("Left", "l"), ...twist("Right", "r"), { name: "index_metacarpal_l", between: ["LeftHand", ["LeftHandIndex1"]], t: 0.4 },
			{ name: "ik_foot_root", under: "root" }, { name: "ik_foot_l", under: "ik_foot_root" }, { name: "thigh_twist_01_l", under: "LeftUpLeg", to: "LeftLeg" }] },
	{ id: "vrm", units: "m", aPose: 40, drop: ["Spine1"], scale: { spine: 1.1, neck: 1.0, width: 0.9, arm: 0.95, hand: 0.88, leg: 1.05, foot: 1.0 },
		extras: [{ name: "J_Sec_Hair1", under: "Head" }, { name: "J_Sec_L_Bust1", under: "Spine2" }, { name: "leftEye", under: "Head" }, { name: "rightEye", under: "Head" }] },
	{ id: "unity-humanoid", aPose: 35, axisTurn: -90, scale: { spine: 0.88, neck: 0.9, width: 1.05, arm: 1.08, hand: 1.0, leg: 0.95, foot: 1.12 },
		extras: [{ name: "Armature", between: ["root", ["Hips"]], t: 0 }, { name: "LeftUpperArmTwist", under: "LeftArm", to: "LeftForeArm" }, { name: "Jaw", under: "Head" }] },
	{ id: "rigify", units: "m", aPose: 45, reversed: true, scale: { spine: 1.0, neck: 1.12, width: 1.0, arm: 0.86, hand: 0.95, leg: 1.15, foot: 0.95 },
		extras: [{ name: "DEF-upper_arm.L.001", between: ["LeftArm", ["LeftForeArm"]] }, { name: "DEF-upper_arm.R.001", between: ["RightArm", ["RightForeArm"]] },
			{ name: "DEF-thigh.L.001", between: ["LeftUpLeg", ["LeftLeg"]] }, { name: "DEF-palm.01.L", between: ["LeftHand", ["LeftHandIndex1"]], t: 0.3 }, { name: "DEF-breast.L", under: "Spine2" }] },
	{ id: "cc4", scale: { spine: 1.12, neck: 1.0, width: 1.12, arm: 1.0, hand: 1.05, leg: 0.9, foot: 0.92 },
		extras: [{ name: "CC_Base_BoneRoot", between: ["root", ["Hips"]], t: 0 }, { name: "CC_Base_Pelvis", between: ["Hips", ["LeftUpLeg", "RightUpLeg"]], t: 0 },
			{ name: "CC_Base_NeckTwist02", between: ["Neck", ["Head"]] }, { name: "CC_Base_L_UpperarmTwist01", under: "LeftArm", to: "LeftForeArm" }, { name: "CC_Base_JawRoot", under: "Head" }] },
	{ id: "daz-genesis8", zUp: true, aPose: 30, scale: { spine: 0.95, neck: 0.88, width: 0.88, arm: 1.15, hand: 1.12, leg: 1.0, foot: 1.05 },
		extras: [{ name: "pelvis", between: ["Hips", ["LeftUpLeg", "RightUpLeg"]], t: 0 }, { name: "chestLower", between: ["Spine1", ["Spine2"]] },
			{ name: "lThighTwist", between: ["LeftUpLeg", ["LeftLeg"]] }, { name: "lShldrTwist", between: ["LeftArm", ["LeftForeArm"]] }, { name: "rForearmTwist", between: ["RightForeArm", ["RightHand"]] },
			{ name: "lMetatarsals", between: ["LeftFoot", ["LeftToeBase"]], t: 0.4 }, { name: "neckUpper", between: ["Neck", ["Head"]] }] },
	{ id: "daz-genesis9", scale: { spine: 1.08, neck: 1.1, width: 0.92, arm: 0.92, hand: 0.86, leg: 0.86, foot: 0.88 },
		extras: [{ name: "spine3", between: ["Spine1", ["Spine2"]] }, { name: "neck2", between: ["Neck", ["Head"]] }, { name: "l_metatarsal", between: ["LeftFoot", ["LeftToeBase"]], t: 0.4 },
			{ name: "l_upperarm_twist1", under: "LeftArm", to: "LeftForeArm" }, { name: "r_shin_twist1", under: "RightLeg", to: "RightFoot" }] },
];

// --- the motions -------------------------------------------------------------------------------------------------
const SPEC = "cozyclay.motion-spec.v1", stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
/** The three motions on skeleton sk; the reach point follows the rig's hips height (k = its hips over the X Bot's). */
const MOTIONS = {
	walk: () => ({ schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to: [1, 2] } }] }),
	grip: k => ({ schema: SPEC, fps: 24, frames: 100, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }, { skill: "reachGrip", f0: 10, args: { anchor: "bar", side: "r", define: { kind: "world", p: [-0.2 * k, 1.2 * k, 0.33 * k] } } }] }),
	tuck: () => ({ schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }] }),
};
const run = (sk, motion, k = 1) => compileSpec(MOTIONS[motion](k), { sk, scene: motionScene([]) });
const issues = r => r.qa.groups.map(g => `${g.kind} ${g.subject} f${g.first}-${g.last} n${g.count}`);
// TOL: how many more issue frames than the X Bot an adapted rig may have, all of them single-frame acceleration pops
// (POP); any other kind (a collision, a float, a reach miss, a slide, the ground) is never tolerated. The pops are the
// compiler's answer to the proportions, not the adapter's: a reach or a flip on longer arms moves the hands farther a
// frame, and the X Bot rescaled directly to the same segments (no template, no adapter) pops on the same frames by the
// same amounts (cc4 reach 8.2 cm/f^2 at f18, Genesis 9 reach 7.25 at f58, Genesis 8 tuck 5.09 at f52; 2026-11-09)
const TOL = 3, SOFT = new Set(["POP"]);

// 1. X Bot through the mixamo template: the same rig
{
	const { rig, report } = adaptRig({ units: "cm", bones: xBot.bones.map(b => ({ name: `mixamorig:${b.name}`, parent: b.parent, localPos: b.localPos, localQuat: b.localQuat })) });
	const dp = Math.max(...rig.bones.flatMap((b, i) => b.worldPos.map((v, k) => Math.abs(v - xBot.bones[i].worldPos[k]))));
	const dq = Math.max(...rig.bones.map((b, i) => angle(apply(matFromQuat(b.worldQuat), [1, 2, 3]), apply(matFromQuat(xBot.bones[i].worldQuat), [1, 2, 3]))));
	expect("X Bot as a raw mixamorig: skeleton: detected mixamo, nothing missing or extra, a T-pose on the source's floor",
		report.detected.id === "mixamo" && report.detected.score === 1 && !report.missing.length && !report.extra.length && report.restPose === "T" && report.grounded === "source", JSON.stringify(report).slice(0, 300));
	expect("  ... and adapted it is the X Bot rig: joints within 1e-5 cm, bone frames within 1e-5 deg", dp < 1e-5 && dq < 1e-5, `${dp} cm, ${dq} deg`);
	expect("  ... with the X Bot's measurements (height 1.82 m, legs 0.889 m, arms 0.562 m, ankle 0.087 m)",
		Math.abs(report.measured.heightM - 1.8197) < 1e-3 && Math.abs(report.measured.legLengthM - 0.889) < 1e-3 && Math.abs(report.measured.armLengthM - 0.5617) < 1e-3 && Math.abs(report.measured.ankleHeightM - 0.0873) < 1e-3, JSON.stringify(report.measured));
	registerRig("test-xbot-adapted", rig);
	const a = bodyFor(skeletonFor("test-xbot-adapted")), b = bodyFor(skeletonFor("x-bot-tpose"));
	const same = a.grids.length === b.grids.length && a.grids.every((g, i) => g.b === b.grids[i].b && g.dims.join() === b.grids[i].dims.join() && g.data.every((v, k) => v === b.grids[i].data[k]));
	expect("  ... and its refitted collision body is the X Bot's, cell for cell", same);
}

// 2. the X Bot's QA on the three motions (the bar for the adapted rigs)
const xb = skeletonFor("x-bot-tpose"), base = Object.fromEntries(Object.keys(MOTIONS).map(m => [m, run(xb, m)]));
for (const [m, r] of Object.entries(base)) expect(`X Bot ${m}: compiles, QA ${r.qa.total} (the bar for the adapted rigs) ${JSON.stringify(issues(r))}`, Number.isInteger(r.qa.total));

// 3. every template
for (const c of CASES) {
	const { raw, expect: want } = synth(c), extras = c.extras.length;
	let out;
	try { out = adaptRig(raw); } catch (e) { expect(`${c.id}: adapts`, false, e.message); continue; }
	const { rig, report } = out, m = report.measured;
	expect(`${c.id}: detected as ${c.id} (score ${report.detected.score})${c.aPose ? `, an A-pose of ${c.aPose} deg read as one` : ", a T-pose"}`,
		report.detected.id === c.id && out.template === c.id && report.restPose === (c.aPose ? "A" : "T") && (!c.aPose || Math.abs(m.upperArmDownDeg - c.aPose) < 0.5), JSON.stringify({ detected: report.detected, restPose: report.restPose, down: m.upperArmDownDeg }));
	expect(`${c.id}: the root and the ${extras} extra bones are skipped, the bones it has no name for made up`,
		report.extra.includes("root") && c.extras.every(e => report.extra.includes(e.name)) && JSON.stringify(report.missing) === JSON.stringify(want.missing), JSON.stringify({ extra: report.extra, missing: report.missing, want: want.missing }));
	expect(`${c.id}: measured legs ${m.legLengthM} m, arms ${m.armLengthM} m, ankle ${m.ankleHeightM} m as built (1 mm)`,
		Math.abs(m.legLengthM - want.leg) < 1e-3 && Math.abs(m.armLengthM - want.arm) < 1e-3 && Math.abs(m.ankleHeightM - want.ankle) < 1e-3 && report.grounded === "source", JSON.stringify({ m, want }));
	const sk = createSkeleton(rig), I = sk.index;
	const armDir = sub(sk.restWorldPos[I.LeftForeArm], sk.restWorldPos[I.LeftArm]), xDir = sub(REF.restWorldPos[REF.index.LeftForeArm], REF.restWorldPos[REF.index.LeftArm]);
	expect(`${c.id}: the canonical bind is the X Bot's T-pose (upper arm within 0.5 deg of it)`, angle(armDir, xDir) < 0.5 && sk.names.join() === REF.names.join(), angle(armDir, xDir).toFixed(3));
	registerRig(`test-${c.id}`, rig);
	const rsk = skeletonFor(`test-${c.id}`);
	expect(`${c.id}: registered, skeletonFor gives it with a refitted body`, rsk?.model === `test-${c.id}` && bodyFor(rsk)?.grids.length === bodyFor(xb).grids.length);
	const k = rsk.restWorldPos[I.Hips][1] / xb.restWorldPos[I.Hips][1];
	for (const motion of Object.keys(MOTIONS)) {
		let r;
		try { r = run(rsk, motion, k); } catch (e) { expect(`${c.id} ${motion}: compiles`, false, e.message.slice(0, 300)); continue; }
		const extra = r.qa.total - base[motion].qa.total, hard = r.qa.groups.filter(g => !SOFT.has(g.kind));
		expect(`${c.id} ${motion}: QA ${r.qa.total} (X Bot ${base[motion].qa.total}, at most ${TOL} more of ${[...SOFT].join("/")})`, extra <= TOL && hard.length <= base[motion].qa.groups.filter(g => !SOFT.has(g.kind)).length, JSON.stringify(issues(r)));
		if (motion !== "walk") continue;
		// the rig's proportions reach the compiler: standIdle's feet stand its hip width apart, the heel point sits its foot back
		const P0 = r.out.frames[0].s.P, gap = P0[I.LeftFoot][0] - P0[I.RightFoot][0], L = rsk.landmarks;
		expect(`${c.id}: standIdle's feet ${gap.toFixed(3)} m apart (0.18 m x hip width ${L.scale.hips}), heel ${L.sole.heel[0].toFixed(4)} m back (0.045 x foot ${L.scale.foot})`,
			Math.abs(gap - 0.18 * L.scale.hips) < 2e-3 && Math.abs(L.sole.heel[0] - 0.045 * L.scale.foot) < 1e-4 && Math.abs(L.scale.hips - m.hipWidthM / 0.1642) < 1e-3, JSON.stringify(L));
	}
}

// 4. registering an id again replaces the rig, its skeleton and its body
{
	const a = adaptRig(synth(CASES[1]).raw).rig, b = adaptRig(synth(CASES[7]).raw).rig;
	registerRig("test-again", a);
	const first = skeletonFor("test-again"), firstBody = bodyFor(first);
	registerRig("test-again", b);
	const second = skeletonFor("test-again");
	expect("registerRig again under the same id: a new skeleton with the new rig's hips and a new body", second !== first && Math.abs(second.restWorldPos[0][1] - b.bones[0].worldPos[1] / 100) < 1e-9 && bodyFor(second) !== firstBody);
	expect("opts.template forces the template (a UE5 skeleton read as Mixamo finds no hips)", /finds no Hips/.test((() => { try { adaptRig(synth(CASES[1]).raw, { template: "mixamo" }); return ""; } catch (e) { return e.message; } })()));
}

// 4b. a bare skeleton: no fingers, toes, collarbones, neck or chest, an A-pose, the hips at the origin (no floor)
{
	const fingers = ["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap(f => [1, 2, 3, 4].flatMap(i => SIDES.map(S => `${S}Hand${f}${i}`)));
	const bare = { ...CASES[1], aPose: 40, drop: [...fingers, "LeftToeBase", "RightToeBase", "LeftShoulder", "RightShoulder", "Neck", "Spine1"], extras: [] }, { raw } = synth(bare);
	raw.bones.find(b => b.name === "pelvis").localPos = [0, 0, 0];
	const { rig, report } = adaptRig(raw), m = report.measured;
	expect("a bare UE5 skeleton (hips at the origin): detected, an A-pose, the floor estimated (ankle 0.039 of the stature), the toes on it",
		report.template === "ue5" && report.restPose === "A" && report.grounded === "estimated" && Math.abs(m.ankleHeightM / m.heightM - 0.039) < 1e-3 && Math.abs(m.ballHeightM) < 1e-3, JSON.stringify(m));
	registerRig("test-bare", rig);
	const sk = skeletonFor("test-bare"), k = sk.restWorldPos[0][1] / xb.restWorldPos[0][1];
	for (const motion of Object.keys(MOTIONS)) {
		const r = run(sk, motion, k), hard = r.qa.groups.filter(g => !SOFT.has(g.kind));
		expect(`  ... ${motion} on its made-up fingers, toes and neck: QA ${r.qa.total} (X Bot ${base[motion].qa.total}, at most ${TOL} more pops)`, r.qa.total - base[motion].qa.total <= TOL && !hard.length, JSON.stringify(issues(r)));
	}
}

// 5. the X Bot and Y Bot takes are byte-identical to before rig templates (3804b63b)
// digests of the same three motions compiled at 3804b63b (the commit before rig templates)
const PINNED = { "x-bot-tpose walk": "7a63905bbd0640bf", "x-bot-tpose grip": "66e0ee21f64977ab", "x-bot-tpose tuck": "05dae3e107ff3052",
	"y-bot-tpose walk": "b03908164e463983", "y-bot-tpose grip": "f5f571583d9062e7", "y-bot-tpose tuck": "e4ab0f3dc4898aef" };
const digest = r => createHash("sha256").update(JSON.stringify(r.out.frames.map(({ s }) => [s.P, s.R]))).update(JSON.stringify(r.qa.groups)).digest("hex").slice(0, 16);
for (const model of ["x-bot-tpose", "y-bot-tpose"]) for (const motion of Object.keys(MOTIONS)) {
	const d = digest(model === "x-bot-tpose" ? base[motion] : run(skeletonFor(model), motion)), key = `${model} ${motion}`;
	expect(`${key}: take byte-identical to before (${d})`, PINNED[key] === d, `pinned ${PINNED[key]}`);
}

if (failures) { console.error(`${failures} rig template check(s) failed`); process.exit(1); }
