#!/usr/bin/env node
// Rig templates (src/motion3/rigs/adapt.js): a skeleton in each supported naming convention, built here from the X Bot
// bind (x-bot-tpose.json) renamed to that convention, its segments rescaled by 0.85-1.15, four of them in an A-pose,
// each with extra bones (twist bones in and out of the limb chains, IK targets, metacarpals, spine and neck joints the
// canonical rig has no place for, face bones) and a root above the hips (two of them Z-up, one in metres, one listed
// children first, every bone in an axis convention of its own), is detected as its template, adapted to the canonical
// rig, registered (rigs/index.js registerRig) and compiled: standIdle + walkTo, a reachGrip and the flip skill's back
// tuck with QA no worse than the X Bot's plus TOL pop frames (and no issue of any other kind). The X Bot and
// Y Bot takes stay byte-identical to the takes before rig templates (sha256 pinned at 3804b63b). A walkTo with arrive plans per
// skeleton: one rig's take never depends on which rig compiled that spec first (fresh processes, the plan cache lives in one).
// Skeletons posed away from the X Bot's bind (bent limbs, turned feet, rolled palms, sloped toes) go onto its directions.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adaptRig } from "../../src/motion3/rigs/adapt.js";
import { TEMPLATES, detectTemplate } from "../../src/motion3/rigs/templates.js";
import { sourcePose } from "../../src/motion3/rigs/adapt-pose.js";
import { skeletonFor, registerRig } from "../../src/motion3/rigs/index.js";
import { createSkeleton, restState, soleHeel } from "../../src/motion3/compiler/skeleton.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { bodyFor, bodyDistance } from "../../src/motion3/body.js";
import { CAPSULES, capsulesFor, solePoints } from "../../src/motion3/qa/geometry.js";
import { palmPoint } from "../../src/motion3/compiler/limbs.js";
import { standClearance } from "../../src/motion3/skills/stance.js";
import { add, sub, scale, dot, len, mul, apply, T, rx, ry, rz, angle, dist, matFromQuat, quatFromMat } from "../../src/motion3/compiler/math.js";

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
// Every joint position and rotation to 1e-9: arm64 and x86_64 differ in the last bit of a few positions (8.9e-16 m at most on
// these takes), so a digest of the raw doubles holds on one of them only.
const nano = v => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v.map(nano));
const digest = r => createHash("sha256").update(JSON.stringify(r.out.frames.map(({ s }) => nano([s.P, s.R])))).update(JSON.stringify(r.qa.groups)).digest("hex").slice(0, 16);

// --- takes in a fresh process (child mode of this file): the walk plan cache lives as long as the process ----------------
/** The X Bot rescaled through the adapter: `all` the whole body, `leg` the legs on top of it. */
const rescaled = (all, leg = 1) => adaptRig({ units: "cm", bones: xBot.bones.map(b => {
	const f = all * (/(UpLeg|Leg|Foot)$/.test(b.name) ? leg : 1);
	return { name: `mixamorig:${b.name}`, parent: b.parent, localPos: b.localPos.map(v => v * f), localQuat: b.localQuat };
}) }).rig;
if (process.argv[2] === "--takes") {
	// steps: "x" the X Bot; "hero-x", "hero-tall" registers id hero as the X Bot through the adapter or a tall rig
	const [steps, to, arrive] = JSON.parse(process.argv[3]), HERO = { "hero-x": [1], "hero-tall": [1.1, 1.2] };
	const spec = { schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to, arrive } }] };
	for (const step of steps) {
		if (HERO[step]) registerRig("hero", rescaled(...HERO[step]));
		const r = compileSpec(spec, { sk: skeletonFor(HERO[step] ? "hero" : "x-bot-tpose"), scene: motionScene([]) });
		console.log(JSON.stringify({ digest: digest(r), plan: r.observations.planned[0].replace(/ \(\d+ checked\)$/, ""), frames: r.out.frames.length, qa: r.qa.total }));
	}
	process.exit(0);
}
/** The last step's take of `steps` run in that order in a fresh process. */
const takeAfter = (steps, to, arrive) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--takes", JSON.stringify([steps, to, arrive])], { encoding: "utf8" }).trim().split("\n").at(-1));
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

// 1b. Mixamo names as three.js GLTFLoader writes them (the colon dropped: "mixamorigHips", src/poses.js) and with an underscore
for (const pre of ["mixamorig", "mixamorig_", "mixamorig1"]) {
	let out = null, err = "";
	try { out = adaptRig({ units: "cm", bones: xBot.bones.map(b => ({ name: `${pre}${b.name}`, parent: b.parent, localPos: b.localPos, localQuat: b.localQuat })) }); } catch (e) { err = e.message; }
	const dp = out ? Math.max(...out.rig.bones.flatMap((b, i) => b.worldPos.map((v, k) => Math.abs(v - xBot.bones[i].worldPos[k])))) : NaN;
	expect(`X Bot named "${pre}Hips": detected mixamo, nothing missing or extra, the X Bot's joints (1e-5 cm)`,
		out && out.report.detected.id === "mixamo" && out.report.detected.score === 1 && !out.report.missing.length && !out.report.extra.length && dp < 1e-5, err || JSON.stringify(out?.report.detected));
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
	const srcPose = sourcePose(raw), retargetOff = ["Hips", "Spine", "Head"].map(n => {
		const e = report.retarget[n], R = mul(matFromQuat(rig.bones[REF.index[n]].worldQuat), matFromQuat(e.offset)), Rs = mul(report.axes, srcPose.R[srcPose.names.indexOf(e.source)]);
		return e.source === report.mapped[n] ? Math.max(...[[1, 0, 0], [0, 1, 0]].map(v => angle(apply(R, v), apply(Rs, v)))) : Infinity;
	});
	expect(`${c.id}: report.retarget names every mapped bone's source, and bind x offset is the source's own frame (hips, spine, head; 0.01 deg)`,
		Object.keys(report.retarget).sort().join() === Object.keys(report.mapped).sort().join() && Object.entries(report.retarget).every(([n, e]) => e.source === report.mapped[n]) && Math.max(...retargetOff) < 0.01, retargetOff.join());
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
	expect("  ... and the retired skeleton keeps the body it had (a compile in flight on it reads its own rig)", bodyFor(first) === firstBody && bodyFor(first) !== bodyFor(second));
	expect("opts.template forces the template (a UE5 skeleton read as Mixamo finds no hips)", /finds no Hips/.test((() => { try { adaptRig(synth(CASES[1]).raw, { template: "mixamo" }); return ""; } catch (e) { return e.message; } })()));
}

// 4a. detection counts the exact spelling: the same bones in VRM's and Unity Humanoid's names differ only in case
{
	const ids = ["vrm", "unity-humanoid"], [a, b] = ids.map(id => namesFor(TEMPLATES[id])), core = Object.keys(a).filter(n => a[n]?.toLowerCase() === b[n]?.toLowerCase());
	const got = [a, b].map(names => detectTemplate(core.map(n => names[n])).id);
	expect(`${core.length} bones whose names differ only in case read as their own convention: ${ids.join(", ")} -> ${got.join(", ")}`, core.length > 20 && got.join() === ids.join());
}

// 4a'. a stature no body has is a wrong raw.units (the collision body's refit grows with its cube), refused by name
for (const [what, units, f] of [["a cm skeleton declared m", "m", 1], ["a m skeleton declared cm", "cm", 0.01]]) {
	const refused = (() => { try { adaptRig({ units, bones: xBot.bones.map(b => ({ name: b.name, parent: b.parent, localPos: b.localPos.map(v => v * f), localQuat: b.localQuat })) }); return ""; } catch (e) { return e.message; } })();
	expect(`${what}: refused, naming raw.units`, /stands .* m read as raw\.units/.test(refused), refused);
}

// 4b. a bare skeleton: no fingers, toes, collarbones, neck or chest, an A-pose, the hips at the origin (no floor)
{
	const fingers = ["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap(f => [1, 2, 3, 4].flatMap(i => SIDES.map(S => `${S}Hand${f}${i}`)));
	const bare = { ...CASES[1], aPose: 40, drop: [...fingers, "LeftToeBase", "RightToeBase", "LeftShoulder", "RightShoulder", "Neck", "Spine1"], extras: [] }, { raw } = synth(bare);
	raw.bones.find(b => b.name === "pelvis").localPos = [0, 0, 0];
	const { rig, report } = adaptRig(raw), m = report.measured;
	expect("a bare UE5 skeleton (hips at the origin): detected, an A-pose, the floor estimated (ankle 0.039 of the stature), the toes on it",
		report.template === "ue5" && report.restPose === "A" && report.grounded === "estimated" && Math.abs(m.ankleHeightM / m.heightM - 0.039) < 1e-3 && Math.abs(m.ballHeightM) < 1e-3, JSON.stringify(m));
	const J = n => rig.bones[REF.index[n]].worldPos.map(v => v / 100), at = n => REF.restWorldPos[REF.index[n]], width = dist(J("LeftArm"), J("RightArm")) / dist(at("LeftArm"), at("RightArm")), collar = dist(J("LeftShoulder"), J("LeftArm")) / dist(at("LeftShoulder"), at("LeftArm"));
	expect(`  ... its made-up collarbone follows its shoulder width: x ${collar.toFixed(3)} of the X Bot's, the width x ${width.toFixed(3)}`, Math.abs(collar - width) < 1e-3 && Math.abs(width - 1) > 0.01, `${collar} ${width}`);
	registerRig("test-bare", rig);
	const sk = skeletonFor("test-bare"), k = sk.restWorldPos[0][1] / xb.restWorldPos[0][1];
	for (const motion of Object.keys(MOTIONS)) {
		const r = run(sk, motion, k), hard = r.qa.groups.filter(g => !SOFT.has(g.kind));
		expect(`  ... ${motion} on its made-up fingers, toes and neck: QA ${r.qa.total} (X Bot ${base[motion].qa.total}, at most ${TOL} more pops)`, r.qa.total - base[motion].qa.total <= TOL && !hard.length, JSON.stringify(issues(r)));
	}
}

// 4c. body size: the X Bot scaled to a stature of 0.8 and 0.65, and with hips 0.8 as wide. The QA limits held in metres
// (the legs' SELF limits, the finger radius, the body capsules) scale with the rig (landmarks.scale), so these stand,
// walk, grip and flip as the X Bot does. Before, the thighs read as overlapping on every frame (hips 0.82: standIdle QA 48;
// stature 0.8: walk 165) and, from a stature of 0.7, the fingers as lying in each other (0.6: walk 1182).
{
	const idle = { schema: SPEC, fps: 24, frames: 48, use: [stand] }, idle0 = compileSpec(idle, { sk: xb, scene: motionScene([]) }).qa.total;
	for (const [id, f, hips] of [["stature 0.8", 0.8, 1], ["stature 0.65", 0.65, 1], ["hips 0.8 as wide", 1, 0.8]]) {
		const bones = xBot.bones.map(b => {
			const p = b.localPos.map(v => v * f);
			return { name: `mixamorig:${b.name}`, parent: b.parent, localPos: /UpLeg$/.test(b.name) ? [p[0] * hips, p[1], p[2]] : p, localQuat: b.localQuat };
		});
		const { rig } = adaptRig({ units: "cm", bones }), key = `test-size-${f}-${hips}`;
		registerRig(key, rig);
		const sk = skeletonFor(key), k = sk.restWorldPos[0][1] / xb.restWorldPos[0][1], s = rig.landmarks.scale;
		expect(`X Bot at ${id}: landmarks.scale hips ${s.hips}, hand ${s.hand}, girth ${s.girth}`, Math.abs(s.hips - f * hips) < 1e-3 && Math.abs(s.hand - f) < 1e-3 && Math.abs(s.girth - f) < 1e-3, JSON.stringify(s));
		const capsuleOff = Math.max(...capsulesFor(sk).map((c, i) => Math.abs(c[3] - CAPSULES[i][3] * f))), palmOff = dist(palmPoint(sk, "Right", "palm"), scale(palmPoint(xb, "Right", "palm"), f));
		const head = q => sub(q, rig.landmarks.headJoint), refHead = q => sub(q, xBot.landmarks.headJoint), L0 = xBot.landmarks, L = rig.landmarks;
		const headOff = Math.max(dist(head(L.mouth), scale(refHead(L0.mouth), f)), dist(head(L.headEllipsoid.centre), scale(refHead(L0.headEllipsoid.centre), f)), dist(L.headEllipsoid.radii, scale(L0.headEllipsoid.radii, f)));
		expect(`  ... body capsules, the palm grasp point and the head landmarks scale with it (off by ${capsuleOff.toFixed(5)} m, ${palmOff.toFixed(5)} m, ${headOff.toFixed(4)} cm)`, capsuleOff < 1e-3 && palmOff < 1e-3 && headOff < 0.01, JSON.stringify({ capsuleOff, palmOff, headOff }));
		if (hips === 1) {
			const probes = [[0, 1.3, 0.17], [0, 1.1, 0.16], [0, 1, -0.16]], sd = (body, skel, q) => bodyDistance(body, restState(skel), q).d;
			const refitOff = Math.max(...probes.map(q => Math.abs(sd(bodyFor(sk), sk, scale(q, f)) - f * sd(bodyFor(xb), xb, q))));
			expect(`  ... its refitted body's distances scale with it (off by ${refitOff.toFixed(4)} m at ${probes.map(q => sd(bodyFor(xb), xb, q).toFixed(3)).join(", ")} m off the X Bot's trunk)`, refitOff < 0.004, String(refitOff));
		}
		const r0 = compileSpec(idle, { sk, scene: motionScene([]) });
		expect(`  ... standIdle 48 f: QA ${r0.qa.total} (X Bot ${idle0})`, r0.qa.total <= idle0, JSON.stringify(issues(r0)));
		for (const motion of Object.keys(MOTIONS)) {
			const r = run(sk, motion, k), hard = r.qa.groups.filter(g => !SOFT.has(g.kind)), bar = base[motion].qa;
			expect(`  ... ${motion}: QA ${r.qa.total} (X Bot ${bar.total}; no issue of another kind, at most ${TOL} more pop frames)`,
				r.qa.total - bar.total <= TOL && hard.length <= bar.groups.filter(g => !SOFT.has(g.kind)).length, JSON.stringify(issues(r)));
		}
	}
}

// 4d. the walk's default half-width follows the hip width (feet at mid-walk, a straight walk at x 0)
{
	const straight = { schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to: [0, 3] } }] };
	const gap = sk => {
		const { frames } = compileSpec(straight, { sk, scene: motionScene([]) }).out, I = sk.index, mid = frames.slice(frames.length * 0.4 | 0, frames.length * 0.6 | 0);
		return mid.reduce((n, { s }) => n + Math.abs(s.P[I.LeftFoot][0] - s.P[I.RightFoot][0]), 0) / mid.length;
	};
	registerRig("test-narrow", adaptRig({ units: "cm", bones: xBot.bones.map(b => ({ name: `mixamorig:${b.name}`, parent: b.parent, localPos: /UpLeg$/.test(b.name) ? [b.localPos[0] * 0.8, b.localPos[1], b.localPos[2]] : b.localPos, localQuat: b.localQuat })) }).rig);
	const ratio = gap(skeletonFor("test-narrow")) / gap(xb);
	expect(`hips 0.8 as wide: the feet walk ${ratio.toFixed(3)} as far apart as the X Bot's`, Math.abs(ratio - 0.8) < 0.03, String(ratio));
}

// 4e. a walkTo with arrive plans per skeleton: which cadence walks clean depends on the rig. Each take here is the last of
// its order in a fresh process, against that rig's cold take. On this long-legged rig the plans differ from the X Bot's.
for (const [to, arrive] of [[[2, 2], 70], [[0, 3], 90]]) {
	const tag = `to ${JSON.stringify(to)}, arrive ${arrive}`, x = takeAfter(["x"], to, arrive), tall = takeAfter(["hero-tall"], to, arrive);
	expect(`${tag}: the X Bot's cold plan (${x.frames} f, QA ${x.qa}) and the tall rig's (${tall.frames} f, QA ${tall.qa}) differ, both clean`, x.plan !== tall.plan && !x.qa && !tall.qa, JSON.stringify({ x, tall }));
	expect("  ... tall rig first, then the X Bot: the X Bot's cold take", takeAfter(["hero-tall", "x"], to, arrive).digest === x.digest);
	expect("  ... the X Bot first, then the tall rig: the tall rig's cold take", takeAfter(["x", "hero-tall"], to, arrive).digest === tall.digest);
	expect("  ... an id re-registered to the tall rig: the new rig's cold take", takeAfter(["hero-x", "hero-tall"], to, arrive).digest === tall.digest);
	expect("  ... the X Bot twice: the plan cache gives the same take", takeAfter(["x", "x"], to, arrive).digest === x.digest);
}

// --- skeletons posed away from the X Bot's bind, joint by joint ---------------------------------------------------------
/**
 * A raw skeleton from the X Bot's bind after edit({ P, turn }): turn(bone, Rm) turns a subtree about its joint; P is in
 * metres. name(canonical) gives the source name (none: the bone is left out and its children hang from its parent).
 */
function posed(edit, name = n => `mixamorig:${n}`) {
	const P = {}, R = {}, keep = REF.names.filter(name);
	REF.names.forEach((n, j) => { P[n] = REF.restWorldPos[j].slice(); R[n] = REF.restWorldRot[j]; });
	const turn = (n, Rm) => { const pivot = P[n]; for (const j of REF.subtree[REF.index[n]]) { const c = REF.names[j]; P[c] = add(pivot, apply(Rm, sub(P[c], pivot))); R[c] = mul(Rm, R[c]); } };
	edit({ P, turn });
	const upOf = n => { let p = REF.parent[REF.index[n]]; while (p >= 0 && !keep.includes(REF.names[p])) p = REF.parent[p]; return p < 0 ? null : REF.names[p]; };
	return { P, raw: { units: "cm", bones: keep.map(n => {
		const up = upOf(n);
		return { name: name(n), parent: up ? keep.indexOf(up) : -1, localPos: scale(up ? apply(T(R[up]), sub(P[n], P[up])) : P[n], 100), localQuat: quatFromMat(up ? mul(T(R[up]), R[n]) : R[n]) };
	}) } };
}
const jointOf = (rig, n) => rig.bones[REF.index[n]].worldPos.map(v => v / 100), frameOf = (rig, n) => matFromQuat(rig.bones[REF.index[n]].worldQuat);
const refAt = n => REF.restWorldPos[REF.index[n]], flatXZ = v => [v[0], 0, v[2]];
const dirOff = (rig, a, b) => angle(sub(jointOf(rig, b), jointOf(rig, a)), sub(refAt(b), refAt(a)));
/** v's part across direction d. */
const acrossDir = (v, d) => { const u = scale(d, 1 / len(d)); return sub(v, scale(u, dot(v, u))); };
/** Off (deg) of the rig's bind x retarget offset from the source's own frame of bone n, in canonical axes. */
function retargetOff(raw, out, n) {
	const src = sourcePose(raw), e = out.report.retarget[n], Rs = mul(out.report.axes, src.R[src.names.indexOf(e.source)]), Rb = mul(frameOf(out.rig, n), matFromQuat(e.offset));
	return Math.max(...[[1, 0, 0], [0, 1, 0]].map(v => angle(apply(Rb, v), apply(Rs, v))));
}

// 4f. a toe segment that slopes in the source (ball 2.5 cm up, tip 1 cm lower) lies level in the rig, as the X Bot's does: toe-off
// flattens it in one frame (limbs.js orientFoot), and a sloped one dragged the heel past the SLIDE limit
{
	const { P, raw } = posed(({ P }) => {
		for (const n of REF.names) P[n] = scale(P[n], 1.75 / 1.8197);
		for (const S of SIDES) { P[`${S}ToeBase`][1] = 0.025; P[`${S}Toe_End`][1] = 0.015; }
	}), out = adaptRig(raw), { rig, report } = out;
	const slope = Math.max(...SIDES.map(S => Math.abs(jointOf(rig, `${S}Toe_End`)[1] - jointOf(rig, `${S}ToeBase`)[1])));
	expect(`a sloped toe at 1.75 m: its segment level in the rig (${slope.toFixed(5)} m), its ball where the source has it (${report.measured.ballHeightM} m)`, slope < 1e-4 && Math.abs(report.measured.ballHeightM - 0.025) < 1e-3 && report.grounded === "source", JSON.stringify({ slope, m: report.measured }));
	const toeOff = Math.max(...SIDES.map(S => retargetOff(raw, out, `${S}ToeBase`)));
	expect(`  ... report.retarget keeps the source's toe frame (${toeOff.toFixed(4)} deg), and the tip keeps its place on the floor plan`, toeOff < 0.01 && dist(flatXZ(jointOf(rig, "LeftToe_End")), flatXZ(P.LeftToe_End)) < 2e-3, String(toeOff));
	registerRig("test-sloped-toe", rig);
	const sk = skeletonFor("test-sloped-toe");
	for (const to of [[1, 2], [3, 3]]) {
		const r = compileSpec({ schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to } }] }, { sk, scene: motionScene([]) });
		expect(`  ... walk to ${JSON.stringify(to)}: QA ${r.qa.total}`, r.qa.total === 0, JSON.stringify(issues(r)));
	}
}

// 4g. a skeleton bent everywhere the normalise steps straighten: an A-pose, bent elbows and wrists, palms turned in, curled
// fingers, splayed legs, bent knees, flat feet turned out, its pelvis turned on its spine
{
	const bent = ({ turn }) => {
		turn("Hips", ry(10));
		turn("Spine", ry(-10));
		for (const [S, sg] of [["Left", 1], ["Right", -1]]) {
			const thigh = rz(sg * 8), shin = rx(12);
			turn(`${S}Arm`, rz(-sg * 40));
			turn(`${S}ForeArm`, ry(-sg * 25));
			turn(`${S}Hand`, rz(-sg * 10));
			turn(`${S}Hand`, rx(sg * 60));
			for (const f of ["Index", "Middle", "Ring", "Pinky"]) for (const i of [1, 2, 3]) turn(`${S}Hand${f}${i}`, rz(-sg * 15));
			turn(`${S}UpLeg`, thigh);
			turn(`${S}Leg`, shin);
			turn(`${S}Foot`, mul(ry(sg * 15), T(mul(shin, mul(thigh, ry(10))))));
		}
	};
	const { P, raw } = posed(bent), out = adaptRig(raw), { rig, report } = out, m = report.measured;
	const pairs = SIDES.flatMap(S => [[`${S}Arm`, `${S}ForeArm`], [`${S}ForeArm`, `${S}Hand`], [`${S}Hand`, `${S}HandMiddle1`], [`${S}UpLeg`, `${S}Leg`], [`${S}Leg`, `${S}Foot`]]);
	const off = Math.max(...pairs.map(([a, b]) => dirOff(rig, a, b)));
	expect(`bent everywhere: upper arm, forearm, hand, thigh and shin on the X Bot's directions (worst ${off.toFixed(3)} deg), read as an A-pose`, off < 0.5 && report.restPose === "A", pairs.map(([a, b]) => `${a} ${dirOff(rig, a, b).toFixed(2)}`).join());
	const palm = Math.max(...SIDES.map(S => {
		const axis = sub(refAt(`${S}HandMiddle1`), refAt(`${S}Hand`));
		return angle(acrossDir(sub(jointOf(rig, `${S}HandIndex1`), jointOf(rig, `${S}HandPinky1`)), axis), acrossDir(sub(refAt(`${S}HandIndex1`), refAt(`${S}HandPinky1`)), axis));
	}));
	const heading = Math.max(...SIDES.map(S => angle(flatXZ(sub(jointOf(rig, `${S}ToeBase`), jointOf(rig, `${S}Foot`))), flatXZ(sub(refAt(`${S}ToeBase`), refAt(`${S}Foot`))))));
	expect(`  ... the palm's knuckle line on the X Bot's (${palm.toFixed(3)} deg), the foot's heading on it (${heading.toFixed(3)} deg)`, palm < 0.5 && heading < 0.5, `${palm} ${heading}`);
	const ballSrc = (P.LeftToeBase[1] + P.RightToeBase[1]) / 2, footOff = Math.max(...SIDES.map(S => Math.abs(jointOf(rig, `${S}ToeBase`)[1] - jointOf(rig, `${S}Foot`)[1] - (P[`${S}ToeBase`][1] - P[`${S}Foot`][1]))));
	expect(`  ... the foot keeps its pitch through the leg's turns: ball ${m.ballHeightM} m where the source has it (${ballSrc.toFixed(4)} m), ankle to ball height off by ${footOff.toFixed(5)} m`, Math.abs(m.ballHeightM - ballSrc) < 1e-3 && footOff < 1e-4 && report.grounded === "source", JSON.stringify({ m, ballSrc, footOff }));
	const src = sourcePose(raw), footFrame = Math.max(...SIDES.map(S => {
		// the source foot's own vector to its ball, carried by bind x offset (report.retarget), lands on the rig's foot
		const e = report.retarget[`${S}Foot`], i = src.names.indexOf(e.source), own = apply(T(src.R[i]), sub(src.P[src.names.indexOf(report.mapped[`${S}ToeBase`])], src.P[i]));
		return angle(apply(mul(frameOf(rig, `${S}Foot`), matFromQuat(e.offset)), own), sub(jointOf(rig, `${S}ToeBase`), jointOf(rig, `${S}Foot`)));
	}));
	expect(`  ... and report.retarget's foot frame carries the source's foot onto the rig's (${footFrame.toFixed(4)} deg)`, footFrame < 0.01, String(footFrame));
	const hipLine = sub(jointOf(rig, "LeftUpLeg"), jointOf(rig, "RightUpLeg")), carriedLine = apply(mul(frameOf(rig, "Hips"), T(REF.restWorldRot[0])), sub(refAt("LeftUpLeg"), refAt("RightUpLeg")));
	expect(`  ... the pelvis turned 10 deg on its spine: the hips' frame follows the hip line (${angle(hipLine, carriedLine).toFixed(3)} deg)`, angle(hipLine, carriedLine) < 0.5 && angle(flatXZ(hipLine), [1, 0, 0]) > 5, String(angle(hipLine, carriedLine)));
	registerRig("test-bent", rig);
	const sk = skeletonFor("test-bent"), k = sk.restWorldPos[0][1] / xb.restWorldPos[0][1];
	for (const motion of ["walk", "grip"]) {
		const r = run(sk, motion, k), hard = r.qa.groups.filter(g => !SOFT.has(g.kind));
		expect(`  ... ${motion}: QA ${r.qa.total} (X Bot ${base[motion].qa.total}, at most ${TOL} more pops)`, r.qa.total - base[motion].qa.total <= TOL && !hard.length, JSON.stringify(issues(r)));
	}

	// the same pose in VRM's names: three joints a finger, so the tip is made up past the curled last phalanx
	const vrm = namesFor(TEMPLATES.vrm), v = adaptRig(posed(bent, n => vrm[n]).raw), J = n => jointOf(v.rig, n);
	const tip = angle(sub(J("LeftHandIndex4"), J("LeftHandIndex3")), sub(J("LeftHandIndex3"), J("LeftHandIndex2")));
	const ratio = dist(J("LeftHandIndex4"), J("LeftHandIndex3")) / dist(J("LeftHandIndex3"), J("LeftHandIndex2")), want = dist(refAt("LeftHandIndex4"), refAt("LeftHandIndex3")) / dist(refAt("LeftHandIndex3"), refAt("LeftHandIndex2"));
	expect(`  ... in VRM's names: a made-up fingertip continues the last phalanx (${tip.toFixed(3)} deg, length ${ratio.toFixed(3)} of it, X Bot ${want.toFixed(3)})`, v.template === "vrm" && v.report.missing.includes("LeftHandIndex4") && tip < 0.5 && Math.abs(ratio - want) < 1e-3, JSON.stringify({ tip, ratio, want }));

	// no middle finger: alignHand has no axis, so the hand keeps its roll and its frame reads it off the knuckles it has
	const three = adaptRig(posed(bent, n => (/Middle/.test(n) ? null : `mixamorig:${n}`)).raw).rig, axis = sub(jointOf(three, "LeftHandMiddle1"), jointOf(three, "LeftHand"));
	const knuckles = acrossDir(sub(jointOf(three, "LeftHandIndex1"), jointOf(three, "LeftHandPinky1")), axis);
	const frameLine = acrossDir(apply(mul(frameOf(three, "LeftHand"), T(REF.restWorldRot[REF.index.LeftHand])), sub(refAt("LeftHandIndex1"), refAt("LeftHandPinky1"))), axis);
	expect(`  ... without a middle finger: the hand's frame follows its knuckle line (${angle(knuckles, frameLine).toFixed(3)} deg)`, angle(knuckles, frameLine) < 1, String(angle(knuckles, frameLine)));
}

// 4h. names in another case, with spaces: the same bones
{
	const spaced = n => n.toLowerCase().replace(/^(left|right)/, "$1 ");
	const { rig, report } = adaptRig({ units: "cm", bones: xBot.bones.map(b => ({ name: `mixamorig:${spaced(b.name)}`, parent: b.parent, localPos: b.localPos, localQuat: b.localQuat })) });
	const dp = Math.max(...rig.bones.flatMap((b, i) => b.worldPos.map((v, k) => Math.abs(v - xBot.bones[i].worldPos[k]))));
	expect(`names as "mixamorig:left arm": detected mixamo (score ${report.detected.score}), nothing missing, the X Bot's joints`, report.template === "mixamo" && !report.missing.length && dp < 1e-5, JSON.stringify({ dp, missing: report.missing.slice(0, 5) }));
}

// 4i. the source's own landmarks, in its own axes and units: a Z-up skeleton's head radii turn with it (height and depth swap)
{
	const { raw } = posed(() => {}), Z = rx(90), hips = raw.bones[0];
	hips.localPos = apply(Z, hips.localPos);
	hips.localQuat = quatFromMat(mul(Z, matFromQuat(hips.localQuat)));
	const mouth = [1, 8, 160], centre = [0, 2, 165];
	const { rig, report } = adaptRig({ ...raw, landmarks: { mouth, headEllipsoid: { centre, radii: [8, 12, 13] }, sole: { ball: 1.5, tip: 0.5 } } }), L = rig.landmarks;
	const off = Math.max(dist(L.mouth, apply(report.axes, mouth)), dist(L.headEllipsoid.centre, apply(report.axes, centre)));
	expect(`a Z-up source's raw.landmarks: mouth and head centre in canonical axes (off ${off.toFixed(4)} cm), head radii ${JSON.stringify(L.headEllipsoid.radii)}, its sole ${JSON.stringify([L.sole.ball, L.sole.tip])}`,
		off < 1e-3 && L.headEllipsoid.radii.join() === "8,13,12" && L.sole.ball === 1.5 && L.sole.tip === 0.5, JSON.stringify(L));
}

// 4j. thumbs: VRM 1.0 names metacarpal, proximal, distal; the older VRM 0.x names proximal, intermediate, distal
{
	const vrm1 = namesFor(TEMPLATES.vrm), vrm0 = { ...vrm1 };
	for (const [S, s] of [["Left", "left"], ["Right", "right"]]) { vrm0[`${S}HandThumb1`] = `${s}ThumbProximal`; vrm0[`${S}HandThumb2`] = `${s}ThumbIntermediate`; }
	const thumb = names => { const { mapped } = adaptRig(posed(() => {}, n => names[n]).raw).report; return [1, 2, 3].map(i => mapped[`LeftHandThumb${i}`]).join(); };
	expect(`VRM 1.0 thumb: ${thumb(vrm1)}`, thumb(vrm1) === "leftThumbMetacarpal,leftThumbProximal,leftThumbDistal");
	expect(`VRM 0.x thumb: ${thumb(vrm0)}`, thumb(vrm0) === "leftThumbProximal,leftThumbIntermediate,leftThumbDistal");
}

// 4k. the heel point follows the foot's length on an adapted rig (qa/geometry.js solePoints and the walk's pivot read the same landmark)
{
	const { rig } = adaptRig(posed(({ P }) => {
		for (const S of SIDES) {
			const a = P[`${S}Foot`], t = P[`${S}ToeBase`], tip = P[`${S}Toe_End`];
			P[`${S}ToeBase`] = add(a, scale(sub(t, a), 1.2));
			P[`${S}Toe_End`] = add(P[`${S}ToeBase`], sub(tip, t));
		}
	}).raw);
	registerRig("test-long-foot", rig);
	const sk = skeletonFor("test-long-foot"), s = restState(sk), back = s.P[sk.index.LeftFoot][2] - solePoints(sk, s, "Left").heel[2];
	expect(`a foot 1.2 as long: the heel point ${back.toFixed(4)} m behind the ankle (0.045 x ${sk.landmarks.scale.foot})`, Math.abs(back - 0.045 * sk.landmarks.scale.foot) < 1e-4 && sk.landmarks.scale.foot > 1.15, JSON.stringify(sk.landmarks.sole));
}

// 4l. a long ankle-to-ball reach (1.9 m tall, the ball 0.16 m ahead of the ankle, about a tall person's): the swing heel
// comes down onto the floor, not along it. Before, the foot's pitch stepped back on the last swing frame and held the heel
// level 2-3 mm over the floor while the foot moved 1.3 cm: QA read a planted heel sliding (SLIDE 1.2-1.7 cm, 7 of 12 targets
// on a rig like this one). The heel point the strike pivots on is QA's (soleHeel): pivoting on the X Bot's, 1.5 cm forward of
// this rig's, the toes-up strike dipped the heel 1.6 mm under its flat height.
{
	const H = 1.9, { raw } = posed(({ P }) => {
		for (const n of REF.names) P[n] = scale(P[n], H / 1.8197);
		for (const S of SIDES) {
			const dz = 0.16 - (P[`${S}ToeBase`][2] - P[`${S}Foot`][2]);
			for (const t of ["ToeBase", "Toe_End"]) P[`${S}${t}`] = add(P[`${S}${t}`], [0, 0, dz]);
		}
	});
	registerRig("test-long-reach", adaptRig(raw).rig);
	const sk = skeletonFor("test-long-reach"), flat = soleHeel(sk)[1];
	for (const to of [[-1.68, 3.31], [1.94, 3.33], [-2, 1], [1, 2]]) {
		const r = compileSpec({ schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to } }] }, { sk, scene: motionScene([]) });
		const heels = SIDES.map(S => r.out.frames.map(({ s }) => solePoints(sk, s, S).heel[1])), low = Math.min(...heels.flat());
		// the frame before each strike (the heel lands on its flat height) drops a heel under QA's plant height by 1 mm or more (walk-pelvis.js HOVER)
		const drops = heels.flatMap(y => y.flatMap((v, f) => (f > 1 && Math.abs(v - flat) < 1e-4 && y[f - 1] > flat + 1e-4 && y[f - 1] < 0.012 ? [y[f - 2] - y[f - 1]] : [])));
		const drop = Math.min(Infinity, ...drops);
		expect(`ball 0.16 m ahead of the ankle at 1.9 m, walk to ${JSON.stringify(to)}: QA ${r.qa.total}, the heel no lower than its flat height (${(low * 1000).toFixed(2)} mm, flat ${(flat * 1000).toFixed(2)} mm), coming down ${(drop * 1000).toFixed(2)} mm or more the frame before a strike`,
			r.qa.total === 0 && low > flat - 2e-4 && drop >= 1e-3, JSON.stringify(issues(r)));
	}
}

// 4m. the stance search's hanging arm (skills/stance.js) is the rig's own: arms 1.25 as long hang 1.25 as far, so a low box
// just under the hand stands as close to it as one just under the X Bot's hand does to the X Bot's
{
	const { raw } = posed(({ P }) => {
		for (const S of SIDES) {
			const sh = P[`${S}Arm`];
			for (const j of REF.subtree[REF.index[`${S}ForeArm`]]) P[REF.names[j]] = add(sh, scale(sub(P[REF.names[j]], sh), 1.25));
		}
	});
	registerRig("test-long-arms", adaptRig(raw).rig);
	const near = sk => {
		const P = sk.restWorldPos, I = sk.index, sh = P[I.RightArm], hip = P[I.Hips], x = sh[0] - 0.04 - hip[0], hand = sh[1] - 0.62 * (sk.landmarks.scale?.arm ?? 1);
		const box = motionScene([{ id: "box", name: "Box", renderer: "cube", x, y: 0, z: sh[2] - hip[2], rot: 0, rotX: 0, rotZ: 0, scaleX: 0.03, scaleY: hand - 0.03, scaleZ: 0.03, footprint: { width: 1, depth: 1 }, height: 1 }]);
		return standClearance(sk, box, [0, 0], 0);
	};
	const long = skeletonFor("test-long-arms"), a = near(long), b = near(xb);
	expect(`arms ${long.landmarks.scale.arm} as long: a box 3 cm under the hanging hand clears it by ${a.toFixed(4)} m, as the X Bot's (${b.toFixed(4)} m)`, Math.abs(long.landmarks.scale.arm - 1.25) < 0.01 && Math.abs(a - b) < 1e-3, `${a} ${b}`);
}

// 4n. a non-finite bone value is refused by name (before, a finger with localPos [NaN, 0, 0] adapted with NaN joints and
// compiled a walk of NaN frames)
for (const [field, at, v] of [["localPos", "mixamorig:LeftHandIndex2", [NaN, 0, 0]], ["localQuat", "mixamorig:Spine1", [0, 0, Infinity, 1]]]) {
	const bones = xBot.bones.map(b => ({ name: `mixamorig:${b.name}`, parent: b.parent, localPos: b.localPos, localQuat: b.localQuat }));
	bones.find(b => b.name === at)[field] = v;
	const refused = (() => { try { adaptRig({ units: "cm", bones }); return ""; } catch (e) { return e.message; } })();
	expect(`${field} ${v.join(", ")} on ${at}: refused, naming the bone`, refused.includes(at) && refused.includes(field), refused);
}

// 4o. a skeleton retired by registerRig before anything asked for its body still gets its own rig's body, not the new rig's
{
	const a = adaptRig(synth(CASES[1]).raw).rig, b = adaptRig(synth(CASES[7]).raw).rig;
	registerRig("test-retired", a);
	const first = skeletonFor("test-retired");
	registerRig("test-retired", b);
	registerRig("test-retired-a", a);
	const mins = sk => bodyFor(sk).grids.map(g => g.min.join()).join(";");
	expect("a retired skeleton never asked for its body: its body is its own rig's, not the new one's", mins(first) === mins(skeletonFor("test-retired-a")) && mins(first) !== mins(skeletonFor("test-retired")));
}

// 5. the X Bot and Y Bot takes are identical to before rig templates, to 1e-9 (3804b63b)
// digests of the same three motions compiled at 3804b63b, the commit before rig templates. The same six values come out
// on macOS arm64 and Linux x86_64.
const PINNED = { "x-bot-tpose walk": "bcf9308774af68ad", "x-bot-tpose grip": "fcc1c4a0856efe4b", "x-bot-tpose tuck": "ce9e13c5ed0f2cb7",
	"y-bot-tpose walk": "4d0d119607ec6f25", "y-bot-tpose grip": "85ef0c945146d32d", "y-bot-tpose tuck": "403270dcf32aa928" };
for (const model of ["x-bot-tpose", "y-bot-tpose"]) for (const motion of Object.keys(MOTIONS)) {
	const d = digest(model === "x-bot-tpose" ? base[motion] : run(skeletonFor(model), motion)), key = `${model} ${motion}`;
	expect(`${key}: take byte-identical to before (${d})`, PINNED[key] === d, `pinned ${PINNED[key]}`);
}

if (failures) { console.error(`${failures} rig template check(s) failed`); process.exit(1); }
