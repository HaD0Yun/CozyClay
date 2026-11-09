#!/usr/bin/env node
// The engine side of driving a character whose skeleton is not the X Bot (rigs/read-skeleton.js, rigs/retarget.js,
// rigs/posted.js, compile-job.js jobServer, compile-worker.js, bricks/fill-rig.js). Four synthetic source skeletons are
// built from the X Bot bind (x-bot-tpose.json), each renamed to a naming convention, rescaled per segment, with extra
// bones (twist bones inside the limb chains and as leaves, IK targets, metacarpals, hair) and a root above the hips:
// Mixamo T-pose in cm with its armature off the origin, UE5 A-pose Z-up in cm, VRM A-pose in metres, Rigify A-pose
// Z-up in metres listed children first; every bone in an axis convention of its own.
//   (a) read back from real three.js bones (an armature scaled 0.01 for cm, a helper group folded in) and from glTF JSON
//       (a matrix node, a helper node, a mesh node; VRM 1.0 and 0.x humanoid mappings on meaningless node names):
//       the same joints, units detected.
//   (b) a walk and a back tuck compiled on each adapted rig, retargeted frame by frame onto the source skeleton:
//       forward kinematics of the source with those locals puts every mapped joint within 1 mm of the compiled joint
//       (the take's quaternions too); without the bind offsets it does not.
//   (c, d) compile-worker.js driven in a fresh process with fs closed (as in a browser): a job carrying an adapted rig
//       answers the same take as a main-thread compile, with the body fits fetched by the preload and no synchronous
//       XHR; with the preload failing it falls back to XHR and still answers the same take. An X Bot reaching for the
//       shoulder of a person on an adapted rig compiles in the worker once the job carries that person's rig.
//   (e) the MotionBricks fill refuses an adapted rig and passes the X Bot and the Y Bot.
import * as THREE from "three";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adaptRig } from "../../src/motion3/rigs/adapt.js";
import { TEMPLATES } from "../../src/motion3/rigs/templates.js";
import { sourcePose } from "../../src/motion3/rigs/adapt-pose.js";
import { readThreeSkeleton, readGltfSkeleton } from "../../src/motion3/rigs/read-skeleton.js";
import { retargetPlan, retargetPose } from "../../src/motion3/rigs/retarget.js";
import { ensureRig } from "../../src/motion3/rigs/posted.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createSkeleton, fk } from "../../src/motion3/compiler/skeleton.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { bakeTake, takeQuat, takeHips } from "../../src/motion3/take.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { peopleOf } from "../../src/motion3/people.js";
import { fillSpec } from "../../src/motion3/bricks/fill.js";
import { fillSpecNative } from "../../src/motion3/bricks/fill-native.js";
import { add, sub, scale, apply, mul, T, rx, rz, dist, quatFromMat } from "../../src/motion3/compiler/math.js";

const SELF = fileURLToPath(import.meta.url);
let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const nano = v => Math.round(v * 1e9) / 1e9;

// --- (c, d) the worker in a fresh process -----------------------------------------------------------------------------
/** Runs compile-worker.js as a browser worker would: fs closed, fetch and XHR stubbed and counted. mode "nofetch": the preload fails. */
async function workerChild(mode) {
	const { jobs } = JSON.parse(readFileSync(0, "utf8")), counts = { fetch: 0, xhr: 0 }, answers = [];
	for (const job of jobs) for (const p of Object.values(job.scene.people ?? {})) p.P = Float64Array.from(p.P);
	globalThis.self = { postMessage: message => answers.push(message) };
	globalThis.fetch = async url => {
		counts.fetch += 1;
		if (mode === "nofetch") throw new Error("offline");
		return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(url, "utf8")) };
	};
	globalThis.XMLHttpRequest = class {
		open(method, href) { counts.xhr += 1; this.href = href; }
		send() { this.status = 200; this.responseText = readFileSync(new URL(this.href), "utf8"); }
	};
	await import("../../src/motion3/compile-worker.js");
	const builtin = process.getBuiltinModule.bind(process);
	process.getBuiltinModule = name => (/^(node:)?fs$/.test(name) ? undefined : builtin(name));
	await Promise.all(jobs.map((job, i) => self.onmessage({ data: { id: i + 1, job } })));
	const take = v => v && { frameCount: v.frameCount, rot: Array.from(v.take.rot, nano), hips: Array.from(v.take.hips, nano) };
	console.log(JSON.stringify({ counts, ids: answers.map(a => a.id), takes: answers.map(a => take(a.value)), errors: answers.map(a => a.error ?? null) }));
}

// --- synthetic source skeletons -----------------------------------------------------------------------------------------
const xBot = JSON.parse(readFileSync(new URL("../../src/motion3/rigs/x-bot-tpose.json", import.meta.url), "utf8"));
const REF = createSkeleton(xBot), SIDES = ["Left", "Right"];
const group = n => (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(n) ? "hand" : /Toe/.test(n) ? "foot" : /(UpLeg|Leg|Foot)$/.test(n) ? "leg"
	: /(Arm|ForeArm|Hand)$/.test(n) ? "arm" : /Shoulder$/.test(n) ? "width" : /^(Neck|Head|HeadTop_End)$/.test(n) ? "neck" : "spine");

/** Canonical bone -> template t's first name for it (first prefix). */
function namesFor(t) {
	const out = {}, fill = (n, S) => n.replace(/\{(\w+)\}/g, (_, k) => t.sides[S][k]), pre = (t.prefixes ?? [""])[0];
	for (const [key, names] of Object.entries(t.bones)) {
		if (key.includes("{Side}")) for (const S of SIDES) out[key.replace("{Side}", S)] = pre + fill(names[0], S);
		else out[key] = pre + names[0];
	}
	for (const S of SIDES) for (const [f, joints] of Object.entries(t.fingers)) joints.forEach((j, i) => { out[`${S}Hand${f}${i + 1}`] = pre + fill([j].flat()[0], S); });
	return out;
}

/** A raw skeleton for case c (see the head of this file). */
function synth(c) {
	const names = namesFor(TEMPLATES[c.id]), f = c.scale, P = {}, R = {};
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
	const list = [{ name: "root", up: null, P: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }], at = {};
	const keep = REF.names.filter(n => names[n]);
	for (const n of keep) {
		let p = REF.parent[REF.index[n]];
		while (p >= 0 && !keep.includes(REF.names[p])) p = REF.parent[p];
		at[n] = list.length;
		list.push({ name: names[n], up: p < 0 ? "root" : REF.names[p], P: P[n], R: R[n] });
	}
	for (const e of c.extras) {
		const parent = e.between ? e.between[0] : e.under, p = parent === "root" ? [0, 0, 0] : P[parent];
		const q = e.between ? P[e.between[1][0]] : e.to ? P[e.to] : add(p, [0, 0.03, 0]);
		at[e.name] = list.length;
		P[e.name] = add(p, scale(sub(q, p), e.t ?? 0.5));
		R[e.name] = parent === "root" ? list[0].R : R[parent];
		list.push({ name: e.name, up: parent, P: P[e.name], R: R[e.name] });
		for (const child of e.between?.[1] ?? []) list[at[child]].up = e.name;
	}
	const index = name => (name === "root" ? 0 : at[name]);
	const Rroot = c.zUp ? rx(90) : list[0].R, k = c.units === "m" ? 1 : 100, C = rz(c.axisTurn ?? 0), off = c.rootAt ?? [0, 0, 0];
	const W = list.map((b, i) => (i === 0 ? Rroot : mul(mul(Rroot, b.R), C))), WP = list.map((b, i) => add(off, i === 0 ? [0, 0, 0] : apply(Rroot, b.P)));
	let bones = list.map((b, i) => {
		const p = i === 0 ? -1 : index(b.up);
		return { name: b.name, parent: p, localPos: p < 0 ? scale(WP[i], k) : scale(apply(T(W[p]), sub(WP[i], WP[p])), k), localQuat: quatFromMat(p < 0 ? W[i] : mul(T(W[p]), W[i])) };
	});
	if (c.reversed) bones = bones.map((_, i) => bones.length - 1 - i).map(i => ({ ...bones[i], parent: bones[i].parent < 0 ? -1 : bones.length - 1 - bones[i].parent }));
	return { units: c.units ?? "cm", bones };
}

const between = (name, a, b, t) => ({ name, between: [a, [b]], ...(t === undefined ? {} : { t }) });
const CASES = [
	{ label: "mixamo T cm", id: "mixamo", axisTurn: 90, rootAt: [0.4, 0, -0.3], scale: { spine: 1.05, neck: 0.95, width: 1.1, arm: 0.9, hand: 0.92, leg: 1.12, foot: 1.08 },
		extras: [between("mixamorig:Root", "root", "Hips", 0), { name: "upperarm_twist_l", under: "LeftArm", to: "LeftForeArm" }, between("lowerarm_twist_r", "RightForeArm", "RightHand"), { name: "mixamorig:LeftHandIK", under: "root" }] },
	{ label: "ue5 A Z-up cm", id: "ue5", zUp: true, aPose: 40, axisTurn: 90, scale: { spine: 0.92, neck: 1.08, width: 0.95, arm: 1.12, hand: 1.1, leg: 0.88, foot: 0.9 },
		extras: [between("upperarm_twist_01_l", "LeftArm", "LeftForeArm"), between("upperarm_twist_01_r", "RightArm", "RightForeArm"), between("lowerarm_twist_01_l", "LeftForeArm", "LeftHand"),
			between("index_metacarpal_l", "LeftHand", "LeftHandIndex1", 0.4), { name: "ik_foot_root", under: "root" }, between("thigh_twist_01_r", "RightUpLeg", "RightLeg")] },
	{ label: "vrm A m", id: "vrm", units: "m", aPose: 35, axisTurn: -90, scale: { spine: 1.1, neck: 1.0, width: 0.9, arm: 0.95, hand: 0.88, leg: 1.05, foot: 1.0 },
		extras: [between("Armature", "root", "Hips", 0), { name: "J_Sec_Hair1", under: "Head" }, between("J_Adj_L_UpperArmTwist", "LeftArm", "LeftForeArm"), between("J_Adj_R_LowerLegTwist", "RightLeg", "RightFoot")] },
	{ label: "rigify A Z-up m", id: "rigify", units: "m", zUp: true, aPose: 45, reversed: true, scale: { spine: 1.0, neck: 1.12, width: 1.0, arm: 0.86, hand: 0.95, leg: 1.15, foot: 0.95 },
		extras: [between("DEF-upper_arm.L.001", "LeftArm", "LeftForeArm"), between("DEF-upper_arm.R.001", "RightArm", "RightForeArm"), between("DEF-thigh.L.001", "LeftUpLeg", "LeftLeg"),
			between("DEF-palm.01.L", "LeftHand", "LeftHandIndex1", 0.3), { name: "DEF-breast.L", under: "Spine2" }] },
];

// --- (a) the readers ----------------------------------------------------------------------------------------------------
/** raw as real three.js bones under a scene and an armature (scale 0.01 for cm); helper: a group folded between two bones. */
function threeOf(raw, helper) {
	const scene = new THREE.Group(), armature = new THREE.Group(), body = new THREE.Object3D();
	armature.name = "Armature"; armature.scale.setScalar(raw.units === "cm" ? 0.01 : 1); armature.rotation.x = 0.3; body.name = "Body";
	scene.add(armature, body);
	const bones = raw.bones.map(b => Object.assign(new THREE.Bone(), { name: b.name }));
	raw.bones.forEach((b, i) => { bones[i].position.fromArray(b.localPos); bones[i].quaternion.fromArray(b.localQuat); });
	raw.bones.forEach((b, i) => (b.parent < 0 ? armature : bones[b.parent]).add(bones[i]));
	if (helper) {
		const child = bones[raw.bones.findIndex(b => b.name === helper)], g = new THREE.Group(), L = new THREE.Matrix4().compose(child.position, child.quaternion, new THREE.Vector3(1, 1, 1));
		g.name = "helper"; g.position.set(0.7, 2.1, -0.4); g.quaternion.setFromEuler(new THREE.Euler(0.2, -0.5, 0.9));
		g.updateMatrix();
		const local = g.matrix.clone().invert().multiply(L), s = new THREE.Vector3();
		local.decompose(child.position, child.quaternion, s);
		child.parent.add(g); g.add(child);
	}
	return scene;
}

/** raw as glTF JSON: an armature node, the joints (a skin; one as a matrix), a helper node above `helper`, a mesh node. */
function gltfOf(raw, { helper, matrix, rename, humanoid } = {}) {
	const nodes = [{ name: "Armature", scale: [0.01, 0.01, 0.01], children: [] }], o = 1;
	raw.bones.forEach((b, i) => nodes.push({ name: rename ? `node${i}` : b.name, translation: b.localPos, rotation: b.localQuat }));
	if (matrix !== undefined) {
		const n = nodes[o + raw.bones.findIndex(b => b.name === matrix)], m = new THREE.Matrix4().compose(new THREE.Vector3(...n.translation), new THREE.Quaternion(...n.rotation), new THREE.Vector3(1, 1, 1));
		delete n.translation; delete n.rotation; n.matrix = m.elements.slice();
	}
	raw.bones.forEach((b, i) => { const p = b.parent < 0 ? nodes[0] : nodes[o + b.parent]; (p.children ??= []).push(o + i); });
	if (helper !== undefined) {
		const c = o + raw.bones.findIndex(b => b.name === helper), p = nodes.findIndex(n => n.children?.includes(c)), h = nodes.length;
		nodes.push({ name: "helper", translation: [0, 3, 0], children: [c] });
		nodes[p].children = nodes[p].children.map(x => (x === c ? h : x));
		nodes[c].translation = sub(nodes[c].translation, [0, 3, 0]);
	}
	nodes.push({ name: "Body", mesh: 0 });
	nodes[0].children.push(nodes.length - 1);
	return { asset: { version: "2.0" }, nodes, skins: [{ joints: raw.bones.map((_, i) => o + i) }], ...(humanoid ? { extensions: humanoid(n => o + raw.bones.findIndex(b => b.name === n)) } : {}) };
}

/** Largest joint distance (m) between two raws, matched by name, and whether every parent name agrees. */
function compare(a, b) {
	const A = sourcePose(a), Bp = sourcePose(b), at = new Map(Bp.names.map((n, i) => [n, i]));
	let worst = 0, parents = A.names.length === Bp.names.length;
	A.names.forEach((n, i) => {
		const j = at.get(n);
		if (j === undefined) { worst = Infinity; return; }
		worst = Math.max(worst, dist(A.P[i], Bp.P[j]));
		const pa = a.bones[i].parent, pb = b.bones[j].parent;
		if ((pa < 0 ? null : a.bones[pa].name) !== (pb < 0 ? null : b.bones[pb].name)) parents = false;
	});
	return { worst, parents };
}

function readers() {
	CASES.forEach((c, k) => {
		const raw = synth(c), viaThree = readThreeSkeleton(threeOf(raw, k === 1 ? namesFor(TEMPLATES[c.id]).Spine1 : null)), viaGltf = readGltfSkeleton(gltfOf(raw, { helper: k === 2 ? raw.bones[3].name : undefined, matrix: raw.bones[2].name }));
		for (const [how, r] of [["three.js", viaThree], ["glTF", viaGltf]]) {
			const d = compare(raw, r.raw);
			expect(`(a) ${c.label}: ${how} reads ${raw.bones.length} joints, parents and joints within 1e-9 m (worst ${d.worst.toExponential(1)})`, r.raw.bones.length === raw.bones.length && d.parents && d.worst < 1e-9, JSON.stringify(d));
			expect(`(a) ${c.label}: ${how} detects units "${raw.units}" (extent ${r.extent.toFixed(2)})`, r.unitsDetected && r.raw.units === raw.units, r.raw.units);
		}
		const given = readGltfSkeleton(gltfOf(raw), { units: "cm", model: "given" });
		expect(`(a) ${c.label}: given units and model are kept`, given.raw.units === "cm" && !given.unitsDetected && given.raw.model === "given");
	});
	// VRM: meaningless node names, the humanoid mapping names them
	const raw = synth(CASES[2]), human = new Set(Object.values(namesFor(TEMPLATES.vrm))), own = adaptRig(raw).report;
	const zero = n => n.replace(/ThumbProximal$/, "ThumbIntermediate").replace(/ThumbMetacarpal$/, "ThumbProximal");
	const forms = {
		"1.0": node => ({ VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: Object.fromEntries([...human].map(n => [n, { node: node(n) }])) } } }),
		"0.x": node => ({ VRM: { humanoid: { humanBones: [...human].map(n => ({ bone: zero(n), node: node(n) })) } } }),
	};
	for (const [form, humanoid] of Object.entries(forms)) {
		const r = readGltfSkeleton(gltfOf(raw, { rename: true, humanoid })), { report } = adaptRig(r.raw, { template: r.template });
		const sources = r.sources.filter(s => /^node\d+$/.test(s)).length;
		expect(`(a) VRM ${form} humanoid on node0..node${raw.bones.length - 1}: template vrm, ${Object.keys(report.mapped).length} bones mapped as with VRM names (${Object.keys(own.mapped).length}), sources keep the node names`,
			r.template === "vrm" && Object.keys(report.mapped).length === Object.keys(own.mapped).length && sources === raw.bones.length, `${r.template} ${Object.keys(report.mapped).length} ${sources}`);
	}
	const named = readThreeSkeleton(threeOf(raw), { humanoid: { hips: "hips", leftUpperArm: "leftUpperArm" } });
	expect("(a) three.js opts.humanoid marks the skeleton vrm", named.template === "vrm" && readThreeSkeleton(threeOf(raw)).template === null);
}

// --- (b) the retarget -------------------------------------------------------------------------------------------------
const SPEC = "cozyclay.motion-spec.v1", stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
const MOTIONS = {
	walk: { schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "walkTo", f0: 10, args: { to: [1, 2] } }] },
	tuck: { schema: SPEC, fps: 24, frames: "auto", use: [stand, { skill: "flip", f0: 6, args: { kind: "back" } }] },
};

/** Forward kinematics (m, source axes) of raw with a retargeted pose's locals. */
function fkSource(raw, pose) {
	return sourcePose({ ...raw, bones: raw.bones.map((b, i) => ({ ...b, localQuat: pose.quats[i] ?? b.localQuat, ...(i === pose.hips.bone ? { localPos: pose.hips.position } : {}) })) }).P;
}

/** Largest distance (m) of a mapped source joint from its canonical joint over states; shift: canonical = B x source + shift. */
function worstOver(raw, report, plan, states, shift) {
	const at = new Map(raw.bones.map((b, i) => [b.name, i]));
	let worst = 0;
	for (const s of states) {
		const P = fkSource(raw, retargetPose(plan, s));
		for (const source of Object.values(report.mapped)) worst = Math.max(worst, dist(add(apply(report.axes, P[at.get(source)]), shift), s.P[plan.mapped.get(at.get(source)).b]));
	}
	return worst;
}

function retargets() {
	const rows = [];
	CASES.forEach((c, k) => {
		const r = readThreeSkeleton(threeOf(synth(c))), model = `studio-test-${k}`, { rig, report } = adaptRig({ ...r.raw, model });
		const sk = ensureRig(model, rig), plan = retargetPlan(r.raw, report, sk);
		// the canonical frame of a source point: the axes, then the floor's lift (adapt.js keeps the horizontal placement)
		expect(`(b) ${c.label}: the source maps onto the rig by its axes and a vertical lift only`, Math.hypot(plan.shift[0], plan.shift[2]) < 1e-8, JSON.stringify(plan.shift));
		const shift = [0, plan.shift[1], 0];
		for (const [motion, spec] of Object.entries(MOTIONS)) {
			const out = compileSpec(structuredClone(spec), { sk, scene: motionScene([]) }).out, states = out.frames.map(f => f.s);
			const worst = worstOver(r.raw, report, plan, states, shift), mm = worst * 1000;
			rows.push(`${c.label} ${motion} ${states.length} f ${mm.toExponential(1)} mm`);
			expect(`(b) ${c.label} ${motion}: ${Object.keys(report.mapped).length} mapped joints over ${states.length} frames within 1 mm of the compiled joints (worst ${mm.toExponential(1)} mm)`, worst <= 0.001, mm);
			if (k === 1 && motion === "tuck") {
				const take = bakeTake(sk, out), viaTake = Array.from({ length: take.frameCount }, (_, f) => fk(sk, sk.names.map((_, b) => takeQuat(take, f, b)), takeHips(take, f)));
				const t = worstOver(r.raw, report, plan, viaTake, shift) * 1000;
				expect(`(b) ${c.label} tuck through the baked take (float32): within 1 mm (worst ${t.toFixed(4)} mm)`, t <= 1, t);
				const blind = { ...plan, mapped: new Map([...plan.mapped].map(([i, m]) => [i, { ...m, offset: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }])) };
				const off = worstOver(r.raw, report, blind, states, shift) * 1000;
				expect(`(b) without the bind offsets the same frames miss by ${off.toFixed(0)} mm (the check sees them)`, off > 50, off);
			}
		}
	});
	return rows;
}

// --- (c, d) the worker ----------------------------------------------------------------------------------------------
const childRun = (mode, jobs) => JSON.parse(execFileSync(process.execPath, [SELF, "--worker-child", mode], {
	input: JSON.stringify({ jobs }, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)), maxBuffer: 1 << 28 }).toString());
const takeOf = take => ({ rot: Array.from(take.rot, nano), hips: Array.from(take.hips, nano) });
const sameTake = (a, b) => Boolean(a && b) && a.rot.length === b.rot.length && a.rot.every((v, i) => v === b.rot[i]) && a.hips.every((v, i) => v === b.hips[i]);

function worker() {
	const raw = synth(CASES[2]), { rig } = adaptRig({ ...raw, model: "studio-worker" });
	const job = { model: "studio-worker", rigs: { "studio-worker": rig }, scene: motionScene([]), spec: MOTIONS.walk, bake: { position: [0, 0, 0], yaw: 0 } };
	const main = runCompileJob(structuredClone(job)).take, mainTake = takeOf(main);
	for (const mode of ["preload", "nofetch"]) {
		const got = childRun(mode, [job, job, { ...job, model: "x-bot-tpose", rigs: { "x-bot-tpose": rig } }]);
		const label = mode === "preload" ? "(c, d) worker, fits preloaded" : "(c, d) worker, preload failing";
		expect(`${label}: answers in arrival order`, got.ids.join() === "1,2,3", got.ids.join());
		expect(`${label}: the posted rig's take (${main.frameCount} frames) equals the main thread's, twice`, sameTake(got.takes[0], mainTake) && sameTake(got.takes[1], mainTake) && got.takes[0].frameCount === main.frameCount);
		expect(`${label}: a rig posted for the X Bot is refused (INVALID_ARGUMENT)`, got.errors[2]?.code === "INVALID_ARGUMENT", JSON.stringify(got.errors[2]));
		if (mode === "preload") expect(`${label}: body fits fetched ${got.counts.fetch}, synchronous XHR ${got.counts.xhr}`, got.counts.fetch >= 1 && got.counts.xhr === 0, JSON.stringify(got.counts));
		else expect(`${label}: the compile still reads the fit, by synchronous XHR (${got.counts.xhr}), so the XHR count above is live`, got.counts.xhr >= 1, JSON.stringify(got.counts));
	}
	// a person on the adapted rig (people.js): her take baked on it, an X Bot puts a hand on her shoulder
	const sk = skeletonFor("studio-worker"), bSpec = { schema: SPEC, fps: 24, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 2], heading: 180, until: 119 } }] };
	const takeB = bakeTake(sk, compileSpec(bSpec, { sk, scene: motionScene([]) }).out, { position: [0, 0, 2], yaw: 180 }, { spec: bSpec });
	const people = peopleOf([{ id: "char-b", subject: "Jiwoo", model: "studio-worker", z: 2, rot: 180 }], "char-a", () => takeB);
	const reach = { schema: SPEC, fps: 24, frames: 90, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 1.52], heading: 0 } },
		{ skill: "reachGrip", f0: 10, args: { anchor: "shoulder", side: "r", define: { kind: "person", person: "char-b", bone: "LeftArm" }, hold: 30 } }] };
	const pJob = { model: "x-bot-tpose", scene: { ...motionScene([]), people }, spec: reach, bake: { position: [0, 0, 0], yaw: 0 } };
	const pMain = runCompileJob({ ...pJob, rigs: { "studio-worker": rig } });
	const got = childRun("preload", [pJob, { ...pJob, rigs: { "studio-worker": rig } }]);
	expect(`(c) a person on an adapted rig: the worker needs her rig (without: ${got.errors[0]?.name ?? "no error"}), with it the take equals the main thread's (QA ${pMain.qa.total})`,
		Object.keys(people).join() === "char-b" && got.errors[0] !== null && got.errors[1] === null && sameTake(got.takes[1], takeOf(pMain.take)), JSON.stringify(got.errors));
	// ensureRig registers a rig once per JSON
	const a = ensureRig("studio-once", rig), b = ensureRig("studio-once", structuredClone(rig)), moved = structuredClone(rig);
	moved.bones[0].worldPos[1] += 1;
	moved.bones[0].localPos[1] += 1;
	const c = ensureRig("studio-once", moved);
	expect("(c) ensureRig: the same rig JSON keeps its skeleton, a changed one replaces it", a === b && c !== a && skeletonFor("studio-once") === c);
	let code = null;
	try { ensureRig("y-bot-tpose", rig); } catch (error) { code = error.code; }
	expect("(c) ensureRig refuses a built-in model", code === "INVALID_ARGUMENT" && skeletonFor("y-bot-tpose").names.length === REF.names.length);
}

// --- (e) the MotionBricks gate ----------------------------------------------------------------------------------------
async function gate() {
	const spec = { schema: SPEC, fps: 24, frames: 60, keys: [{ f: 0, set: {} }, { f: 40, set: {} }] };
	for (const [name, fill] of [["fillSpec", fillSpec], ["fillSpecNative", fillSpecNative]]) {
		for (const model of ["x-bot-tpose", "y-bot-tpose", "studio-test-0"]) {
			let compiles = 0, outcome;
			const compile = () => { compiles += 1; throw new Error("REACHED_COMPILE"); }, run = async () => { throw new Error("REACHED_MODEL"); };
			try { await fill(structuredClone(spec), { sk: skeletonFor(model), compile, run }); outcome = "resolved"; } catch (error) { outcome = error.code ?? error.message; }
			const builtIn = model !== "studio-test-0";
			expect(`(e) ${name} on ${model}: ${builtIn ? "passes the gate" : "refused TARGET_NOT_READY before any compile"} (${outcome}, ${compiles} compiles)`,
				builtIn ? outcome !== "TARGET_NOT_READY" && compiles > 0 : outcome === "TARGET_NOT_READY" && compiles === 0, outcome);
		}
	}
}

async function main() {
	readers();
	const rows = retargets();
	worker();
	await gate();
	console.log(`retarget worst joint error: ${rows.join("; ")}`);
	console.log(failures ? `FAILED ${failures}` : "all PASS");
	process.exit(failures ? 1 : 0);
}

if (process.argv[2] === "--worker-child") await workerChild(process.argv[3]);
else await main();
