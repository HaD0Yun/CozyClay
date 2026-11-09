#!/usr/bin/env node
// v4 rig: rig facts, the rig library (Node, node:vm and QuickJS give the same numbers as motion3),
// and the persistent js session and tool.
import vm from "node:vm";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fk, restState, toLocal } from "../../src/motion3/compiler/skeleton.js";
import { quatFromMat, mul, ry, apply, add } from "../../src/motion3/compiler/math.js";
import { solePoints } from "../../src/motion3/qa/geometry.js";
import { centerOfMass } from "../../src/motion3/qa/com.js";
import { palmAxes } from "../../src/motion3/compiler/limbs.js";
import { rigFacts } from "../../src/motion-v4/rig/facts.js";
import { buildRig, rigLibrarySource } from "../../src/motion-v4/rig/library.js";
import { createJsSession } from "../../bin/agent/v4/js-session.mjs";
import { createJsTool } from "../../bin/agent/v4/js-tool.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const group = name => console.log(`\n# ${name}`);

// Seeded random numbers (mulberry32), so every run checks the same poses.
function rng(seed) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(20261108);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const unitQuat = () => { const q = [gauss(), gauss(), gauss(), gauss()], l = Math.hypot(...q); return q.map(v => v / l); };
const maxDiff = (a, b) => {
	if (typeof a === "number") return Math.abs(a - b);
	if (Array.isArray(a)) return a.reduce((m, x, i) => Math.max(m, maxDiff(x, b?.[i])), a.length === b?.length ? 0 : Infinity);
	if (a && typeof a === "object") return Object.keys(a).reduce((m, k) => Math.max(m, maxDiff(a[k], b?.[k])), 0);
	return a === b ? 0 : Infinity;
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const norm3 = a => { const l = len3(a); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// atan2 keeps precision near 0 degrees, where acos does not
const angleDeg = (a, b) => (Math.atan2(len3(cross3(a, b)), dot3(a, b)) * 180) / Math.PI;

const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
const RECORDS = [
	{ ...base, id: "barbell", name: "Barbell", renderer: "empty", x: 0, y: 0.225, z: 0.35, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, footprint: { width: 0, depth: 0 }, height: 0, supportY: 0 },
	{ ...base, id: "barbell-bar", name: "Barbell bar", renderer: "cylinder", x: -1, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.028, scaleY: 2, scaleZ: 0.028, parent: "barbell" },
	{ ...base, id: "barbell-plate-l", name: "Barbell plate left", renderer: "cylinder", x: 0.77, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
	{ ...base, id: "barbell-plate-r", name: "Barbell plate right", renderer: "cylinder", x: -0.83, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
	{ ...base, id: "crate", name: "Crate", renderer: "cube", x: 1.6, y: 0, z: 2, scaleX: 0.5, scaleY: 0.6, scaleZ: 0.5, parent: null },
];

const sk = skeletonFor("y-bot-tpose");
const character = { id: "char-a", model: "y-bot-tpose", position: [1, 0, 2], yaw: 90 };
const facts = rigFacts(sk, character, RECORDS);
const rig = buildRig(facts);

group("1 rig facts");
{
	const json = JSON.stringify(facts);
	expect("65 names in sk.names order", facts.names.length === 65 && facts.names.every((n, i) => n === sk.names[i]));
	expect("parents equal sk.parent", facts.parent.every((p, i) => p === sk.parent[i]));
	expect("facts are plain JSON", JSON.stringify(JSON.parse(json)) === json);
	console.log(`  facts: ${json.length} bytes`);
	expect("scene boxes from motionScene", ["barbell-bar", "barbell-plate-l", "barbell-plate-r", "crate"].every(id => facts.scene.objects[id]?.half?.length === 3) && facts.scene.groups.barbell?.children.length === 3);
	expect("limits from motion3", facts.limits.elbow.fold[1] === 150 && facts.limits.knee.fold[1] === 160 && facts.limits.wrist.flex[0] === -70);
	expect("hand length is to the middle knuckle", Math.abs(facts.lengths[sk.index.LeftHand] - len3(sk.restLocalPos[sk.index.LeftHandMiddle1])) < 1e-12 && facts.lengths[sk.index.HeadTop_End] === 0);
}

/** The numbers checks 2-5 compare across realms: FK, IK, sole, COM, palm, flight. */
function sample(R, poses) {
	const out = { fk: [], ik: [], sole: [], com: [], palm: [], fly: [] };
	for (const p of poses) {
		const s = R.fk(p);
		out.fk.push(s.P, s.R);
		out.sole.push(R.sole(s, "l"), R.sole(s, "r"));
		out.com.push(R.com(s));
		out.palm.push(R.palm(s, "l"), R.palm(s, "r"));
	}
	const p0 = R.pose();
	for (const chain of ["arm_l", "arm_r", "leg_l", "leg_r"]) {
		const p = R.clone(p0), A = R.world(p, chain.startsWith("arm") ? (chain === "arm_l" ? "LeftArm" : "RightArm") : (chain === "leg_l" ? "LeftUpLeg" : "RightUpLeg")).p;
		const res = R.ik2(p, chain, [A[0] + 0.15, A[1] - 0.35, A[2] - 0.1]);
		out.ik.push(res, p.q);
	}
	const f = R.clone(p0);
	R.move(f, [0, -0.25, 0]);
	out.ik.push(R.plantFoot(f, "l", { yaw: 100 }), R.plantHand(f, "r", { point: [1.3, 1.0, 2.25] }), f.q);
	const v0 = R.launch([0, 1, 0], [1.2, 0.8, 0.4], 0.6);
	out.fly.push(v0, R.ballistic([0, 1, 0], v0, 0.6), R.arc([0, 1, 0], [1, 0.9, 0], 1.6));
	return out;
}
const poses = Array.from({ length: 50 }, () => ({ q: sk.names.map(() => unitQuat()), hips: [gauss(), 1 + gauss() * 0.2, gauss()] }));

group("2 FK equals motion3 fk");
{
	const p = rig.pose(), s = rig.fk(p);
	const quats = toLocal(sk, restState(sk)).quats;
	quats[sk.index.Hips] = quatFromMat(mul(ry(90), sk.restWorldRot[sk.index.Hips]));
	const ref = fk(sk, quats, add([1, 0, 2], apply(ry(90), sk.restWorldPos[sk.index.Hips])));
	expect("rest pose at the placement equals fk(sk, quats, hips) within 1e-9", maxDiff(s.P, ref.P) < 1e-9 && maxDiff(s.R, ref.R) < 1e-9, `P ${maxDiff(s.P, ref.P)} R ${maxDiff(s.R, ref.R)}`);
	const placed = sk.restWorldPos.map(q => add([1, 0, 2], apply(ry(90), q)));
	expect("rest pose sits on the placement (feet on the floor, facing +X)", maxDiff(s.P, placed) < 1e-9 && Math.abs(rig.axes(p).fwd[0] - 1) < 1e-9);
	let e = 0, w = 0;
	for (const q of poses) {
		const a = rig.fk(q), b = fk(sk, q.q, q.hips);
		e = Math.max(e, maxDiff(a.P, b.P), maxDiff(a.R, b.R));
		const bone = Math.floor(rand() * 65), one = rig.world(q, bone);
		w = Math.max(w, maxDiff(one.p, b.P[bone]), maxDiff(one.R, b.R[bone]));
	}
	expect("50 random poses: fk within 1e-9", e < 1e-9, `max ${e}`);
	expect("50 random poses: world(pose, bone) within 1e-9", w < 1e-9, `max ${w}`);
	const r = rig.clone(p);
	rig.rotate(r, "LeftForeArm", [0, 1, 0], 30);
	const before = rig.fk(p), after = rig.fk(r), I = sk.index;
	expect("rotate turns about the joint; children follow", maxDiff(after.P[I.LeftForeArm], before.P[I.LeftForeArm]) < 1e-12 && len3(sub3(after.P[I.LeftHand], before.P[I.LeftHand])) > 0.1);
	const aimed = rig.clone(p), goal = [1.4, 1.0, 1.6];
	rig.aim(aimed, "LeftArm", goal);
	const sa = rig.fk(aimed);
	expect("aim points the bone at the target", angleDeg(sub3(sa.P[I.LeftForeArm], sa.P[I.LeftArm]), sub3(goal, sa.P[I.LeftArm])) < 1e-6);
}

group("3 two-bone IK");
{
	const p0 = rig.pose(), ax = rig.axes(p0), I = sk.index;
	const CH = { arm_l: ["LeftArm", "LeftForeArm", "LeftHand", 1], arm_r: ["RightArm", "RightForeArm", "RightHand", -1], leg_l: ["LeftUpLeg", "LeftLeg", "LeftFoot", 1], leg_r: ["RightUpLeg", "RightLeg", "RightFoot", -1] };
	const cone = (dir, deg) => {
		for (;;) {
			const v = [gauss(), gauss(), gauss()], u = norm3(v);
			if (angleDeg(u, dir) <= deg) return u;
		}
	};
	for (const [chain, [u, l, e, side]] of Object.entries(CH)) {
		const arm = chain.startsWith("arm"), hi = arm ? 150 : 160, s0 = rig.fk(p0);
		const A = s0.P[I[u]], a = len3(sk.restLocalPos[I[l]]), b = len3(sk.restLocalPos[I[e]]);
		const dir0 = arm ? norm3(sub3(ax.left.map(x => x * side), ax.up)) : ax.up.map(x => -x);
		const near = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos((hi * Math.PI) / 180));
		let worstErr = 0, badFold = 0, badSign = 0, notReached = 0, worstEnd = 0;
		for (let k = 0; k < 200; k++) {
			const d = Math.max(near, 0.3 * (a + b)) + 0.01 + rand() * (0.98 * (a + b) - Math.max(near, 0.3 * (a + b)) - 0.01);
			const target = add(A, cone(dir0, arm ? 50 : 35).map(x => x * d)), p = rig.clone(p0);
			const end = k % 4 === 0 ? rig.q.norm(unitQuat()) : null;
			const res = rig.ik2(p, chain, target, end ? { end } : {});
			const s = rig.fk(p), B = s.P[I[l]], C = s.P[I[e]];
			worstErr = Math.max(worstErr, len3(sub3(C, target)));
			if (!res.reached) notReached++;
			const fold = angleDeg(sub3(B, A), sub3(C, B));
			if (fold > hi + 1e-6 || Math.abs(fold - res.fold) > 1e-6) badFold++;
			const ud = norm3(sub3(C, A)), apex = sub3(sub3(B, A), ud.map(x => x * dot3(sub3(B, A), ud)));
			if (arm ? dot3(apex, ax.fwd) >= 0 : dot3(apex, ax.fwd) <= 0) badSign++;
			if (end) worstEnd = Math.max(worstEnd, maxDiff(s.R[I[e]], rig.q.toMat(end)));
		}
		expect(`${chain}: 200 reachable targets, error < 1 mm`, worstErr < 1e-3 && notReached === 0, `worst ${worstErr}, not reached ${notReached}`);
		expect(`${chain}: fold within 0-${hi} and equal to the report`, badFold === 0, `${badFold} bad`);
		expect(`${chain}: ${arm ? "elbow bends backward" : "knee bends forward"} against the facing`, badSign === 0, `${badSign} bad`);
		expect(`${chain}: end rotation is applied`, worstEnd < 1e-9, `${worstEnd}`);
		const far = add(A, dir0.map(x => x * (a + b) * 1.6)), p = rig.clone(p0), res = rig.ik2(p, chain, far), s = rig.fk(p);
		const C = s.P[I[e]], fold = angleDeg(sub3(s.P[I[l]], A), sub3(C, s.P[I[l]]));
		expect(`${chain}: unreachable target gives reached false and a straight limb toward it`, !res.reached && fold < 1e-6 && angleDeg(sub3(C, A), sub3(far, A)) < 1e-6 && Math.abs(len3(sub3(C, A)) - (a + b)) < 1e-9, JSON.stringify(res));
		const pole = add(A, ax.left.map(x => x * side * 2)), pp = rig.clone(p0), dn = add(A, dir0.map(x => x * 0.7 * (a + b)));
		rig.ik2(pp, chain, dn, { pole });
		const sp = rig.fk(pp), ud = norm3(sub3(dn, A)), ab = sub3(sp.P[I[l]], A), apex = sub3(ab, ud.map(x => x * dot3(ab, ud)));
		expect(`${chain}: an explicit pole decides the bend side`, dot3(apex, sub3(pole, A)) > 0);
	}
	let solo = 0, sideHit = 0;
	for (let k = 0; k < 50; k++) {
		const p = rig.pose();
		rig.move(p, [0, -0.15 - rand() * 0.2, 0]);
		const n = norm3([gauss() * 0.15, 1, gauss() * 0.15]), point = [1 + gauss() * 0.05, 0.05 * rand(), 1.9 + gauss() * 0.05], yaw = 90 + gauss() * 20;
		const res = rig.plantFoot(p, "l", { point, normal: n, yaw }), so = rig.sole(rig.fk(p), "l");
		if (!res.reached) continue;
		solo = Math.max(solo, Math.abs(dot3(sub3(so.heel, point), n)), Math.abs(dot3(sub3(so.ball, point), n)));
		const toes = sub3(so.ball, so.heel), want = [Math.sin((yaw * Math.PI) / 180), 0, Math.cos((yaw * Math.PI) / 180)];
		if (angleDeg([toes[0], 0, toes[2]], want) > 5) sideHit++;
	}
	expect("plantFoot: heel and ball on the plane within 1e-9, toes along yaw", solo < 1e-9 && sideHit === 0, `plane ${solo}, yaw misses ${sideHit}`);
	const h = rig.pose(), target = [1.25, 1.15, 1.8], nrm = norm3([0.2, 1, 0]), hr = rig.plantHand(h, "l", { point: target, normal: nrm, forward: [1, 0, 0] }), pl = rig.palm(rig.fk(h), "l");
	expect("plantHand: palm centre gap off the point, palm facing the surface, fingers forward", hr.reached && len3(sub3(pl.p, add(target, nrm.map(x => x * 0.02)))) < 1e-9 && dot3(pl.n, nrm) < -0.999999 && dot3(pl.d, [1, 0, 0]) > 0.9, JSON.stringify(hr));
}

group("4 sole, COM and palm equal motion3");
{
	let es = 0, ec = 0, ep = 0;
	for (const p of [rig.pose(), ...poses]) {
		const s = rig.fk(p);
		for (const [k, S] of [["l", "Left"], ["r", "Right"]]) {
			const a = rig.sole(s, k), b = solePoints(sk, s, S);
			es = Math.max(es, maxDiff(a.heel, b.heel), maxDiff(a.ball, b.ball), maxDiff(a.tip, b.tip));
			const pa = rig.palm(s, k), pb = palmAxes(sk, s, S), sign = S === "Left" ? 1 : -1;
			ep = Math.max(ep, maxDiff(pa.d, pb.d), maxDiff(pa.l, pb.l), maxDiff(pa.n, pb.n.map(x => x * sign)));
		}
		ec = Math.max(ec, maxDiff(rig.com(s), centerOfMass(sk, s)));
	}
	expect("rig.sole equals solePoints within 1e-9 (rest + 50 poses)", es < 1e-9, `${es}`);
	expect("rig.com equals centerOfMass within 1e-9", ec < 1e-9, `${ec}`);
	expect("rig.palm axes equal palmAxes (n facing out of the palm)", ep < 1e-9, `${ep}`);
	const rest = rig.fk(rig.pose());
	expect("rest left palm normal points down (y < -0.9)", rig.palm(rest, "l").n[1] < -0.9 && rig.palm(rest, "r").n[1] < -0.9);
	expect("rest sole down normal points down", rig.sole(rest, "l").n[1] < -0.9);
	const segs = rig.segments(rest), total = segs.reduce((m, g) => m + g.mass, 0);
	const c = [0, 1, 2].map(k => segs.reduce((m, g) => m + g.mass * g.p[k], 0) / total);
	expect("segments weight to the COM", maxDiff(c, rig.com(rest)) < 1e-12 && segs.length === 11);
	const x = rig.xcom([0, 1, 0], [0.1 / 24, 1, 0]);
	expect("xcom = com + v / omega", Math.abs(x.omega - Math.sqrt(9.8)) < 1e-12 && Math.abs(x.xcom[0] - (0.1 / 24 + 0.1 / Math.sqrt(9.8))) < 1e-12);
}

group("5 free flight");
{
	let e = 0, ea = 0;
	for (let k = 0; k < 50; k++) {
		const p0 = [gauss(), 1 + rand(), gauss()], p1 = [gauss(), rand(), gauss()], T = 0.2 + rand();
		e = Math.max(e, maxDiff(rig.ballistic(p0, rig.launch(p0, p1, T), T), p1));
		const apex = Math.max(p0[1], p1[1]) + 0.1 + rand() * 0.5, { v0, T: Ta } = rig.arc(p0, p1, apex);
		ea = Math.max(ea, maxDiff(rig.ballistic(p0, v0, Ta), p1), Math.abs(rig.ballistic(p0, v0, v0[1] / 9.8)[1] - apex));
	}
	expect("launch then ballistic lands on p1 within 1e-9", e < 1e-9, `${e}`);
	expect("arc lands on p1 and tops out at apex", ea < 1e-9, `${ea}`);
	const keys = [{ f: 0, v: 0 }, { f: 10, v: 1 }, { f: 20, v: 0 }];
	expect("curve passes through its keys and holds past the ends", rig.curve(keys, 10) === 1 && rig.curve(keys, 0) === 0 && rig.curve(keys, 30) === 0 && rig.curve(keys, 5) > 0.4);
	expect("ease ends at 0 and 1", ["linear", "in", "out", "inOut", "smooth", "smoother"].every(k => rig.ease(0, k) === 0 && Math.abs(rig.ease(1, k) - 1) < 1e-12));
	const qa = rig.q.fromAxisAngle([0, 1, 0], 30), qb = rig.q.fromAxisAngle([0, 1, 0], 90);
	expect("slerp halfway turns 60 degrees", maxDiff(rig.slerp(qa, qb, 0.5), rig.q.fromAxisAngle([0, 1, 0], 60)) < 1e-12);
	expect("q.mul matches matrix products", maxDiff(rig.q.toMat(rig.q.mul(qa, rig.q.fromEuler([10, 20, 30]))), mul(rig.q.toMat(qa), rig.q.toMat(rig.q.fromEuler([10, 20, 30])))) < 1e-12);
	const A = { pos: [1, 2, 3], R: rig.q.toMat(qa) }, Bp = { pos: [0, 1, 0], R: rig.q.toMat(qb) };
	expect("compose(a, relative(a, b)) = b", maxDiff(rig.compose(A, rig.relative(A, Bp)), Bp) < 1e-12);
	const hand = rig.world(rig.pose(), "RightHand"), held = { pos: [1, 1, 2.5], quat: qa }, rel = rig.relative(hand, held);
	expect("compose and relative take rig.world's { p, R } and { pos, quat }", maxDiff(rig.compose(hand, rel).pos, held.pos) < 1e-12 && maxDiff(rig.compose(hand, rel).R, rig.q.toMat(qa)) < 1e-12);
}

group("6 the library source is self-contained (node:vm, QuickJS)");
const ref = sample(rig, poses.slice(0, 10));
{
	const src = rigLibrarySource(facts);
	const vrig = vm.runInContext(src, vm.createContext({}));
	const got = sample(vrig, JSON.parse(JSON.stringify(poses.slice(0, 10))));
	expect("node:vm with no globals gives the same numbers as buildRig", maxDiff(got, ref) === 0, `max ${maxDiff(got, ref)}`);
	expect("node:vm rig has the same API", Object.keys(vrig).sort().join() === Object.keys(rig).sort().join());
	console.log(`  library source: ${src.length} chars`);
}

group("7 js session and tool");
const images = [];
const host = {
	track: async args => ({ data: { echoed: args, n: Array.isArray(args.rot) ? args.rot.length : 0 }, text: "stored" }),
	render: async () => { const img = { data: "iVBORw0KGgo=", mimeType: "image/png", label: "judge f0-f9" }; images.push(img); return { data: { sheets: 1 }, text: "sheet 1", images: [img] }; },
	measure: async () => { throw new Error("No track yet: call track set first."); },
	qa: async () => ({ data: null, text: "qa failed", isError: true }),
};
const js = createJsTool({ facts, host });
{
	const run = (code, extra = {}) => js.run({ code, ...extra }, { from: "model" });
	expect("description <= 9000 chars and schema as designed", js.name === "js" && js.description.length <= 9000 && js.inputSchema.required[0] === "code" && js.inputSchema.additionalProperties === false && js.inputSchema.properties.timeoutMs.maximum === 600000, `${js.description.length}`);
	let r = await run("const a = 2;\nfunction f(x) { return x * a; }\nlet counter = (() => { let n = 0; return () => ++n; })();\ncounter();\nconsole.log('hi', a, [1, 2]);\nreturn f(3);");
	expect("number return comes back as { value: n }", r.data.ok && r.data.value?.value === 6 && r.text.includes("return: {\"value\":6}"), r.text);
	expect("stdout is captured", r.data.stdout[0] === "hi 2 [1,2]" && r.text.includes("stdout:\nhi 2 [1,2]"), JSON.stringify(r.data.stdout));
	expect("const, function and let are kept", ["a", "f", "counter"].every(n => r.data.kept.includes(n)), r.text);
	r = await run("return { f: f(10), c: counter(), a };");
	expect("kept names and closure state persist across calls", r.data.value?.f === 20 && r.data.value?.c === 2 && r.data.value?.a === 2, JSON.stringify(r.data.value));
	r = await run("const x = 1;\nconst y = 2;\n  throw new Error('boom');");
	expect("a throw on line 3 reports line 3", !r.data.ok && r.data.error?.line === 3 && r.data.error?.message === "boom" && r.isError === true && r.text.startsWith("error at line 3"), r.text);
	r = await run("const t = await track({ op: 'set', rot: [0, 0, 0, 1] });\nreturn t;");
	expect("host track returns its data", r.data.ok && r.data.value?.echoed?.op === "set" && r.data.value?.n === 4 && r.data.calls[0]?.name === "track", r.text);
	r = await run("const sheet = await render({ views: ['judge'] });\nreturn sheet;");
	expect("render's image is attached to the js result", r.images?.length === 1 && r.images[0].data === images[0].data && r.images[0].mimeType === "image/png" && r.data.value?.sheets === 1 && !("images" in r.data), r.text);
	r = await run("try { await measure({}); } catch (e) { return e.message; }");
	expect("a host error rejects inside the script with its message", r.data.value?.value === "No track yet: call track set first." && r.data.calls[0]?.ok === false, r.text);
	r = await run("await qa({});");
	expect("a host isError result throws in the script", !r.data.ok && /qa failed/.test(r.data.error?.message ?? ""), r.text);
	r = await run("const self = { n: 1, f: function named() {}, a: new Float32Array([1, 2]) };\nself.me = self;\nreturn self;");
	expect("functions, typed arrays and cycles come back as JSON", r.data.value?.f === "[function named]" && r.data.value?.a?.join() === "1,2" && r.data.value?.me === "[circular]", JSON.stringify(r.data.value));
	r = await run("return undefined;");
	expect("undefined comes back as null", r.data.ok && r.data.value === null);
	const order = [];
	const p1 = run("let s = 0;\nfor (let i = 0; i < 3e5; i++) s += i;\nglobalThis.firstDone = s;\nreturn 1;").then(x => { order.push(1); return x; });
	const p2 = run("return globalThis.firstDone ?? 'missing';").then(x => { order.push(2); return x; });
	const [r1, r2] = await Promise.all([p1, p2]);
	expect("two parallel calls run in order", order.join() === "1,2" && r1.data.ok && r2.data.value?.value === 44999850000, `${order} ${JSON.stringify(r2.data.value)}`);
	const t0 = performance.now();
	r = await run("while (true) {}", { timeoutMs: 2000 });
	const tms = Math.round(performance.now() - t0);
	expect("a while (true) cell with timeoutMs 2000 times out and resets", !r.data.ok && r.data.error?.name === "Timeout" && /reset/.test(r.data.reset ?? "") && tms < 6000, `${tms} ms ${r.text}`);
	r = await run("return { rig: typeof rig, bones: rig.bones.length, counter: typeof counter, track: typeof track };");
	expect("the next call works with rig present and kept names gone", r.data.ok && r.data.value?.rig === "object" && r.data.value?.bones === 65 && r.data.value?.counter === "undefined" && r.data.value?.track === "function", r.text);
	r = await run("const z = ;");
	expect("a syntax error reports its line and column", !r.data.ok && r.data.error?.name === "SyntaxError" && r.data.error?.line === 1 && r.data.error?.column === 11, JSON.stringify(r.data.error));
	let threw = false;
	try { await js.run({ code: "" }, {}); } catch { threw = true; }
	expect("empty code throws", threw);
	const pattern = js.description.split("Pattern: ")[1];
	r = await run(`${pattern}\nreturn "done";`);
	expect("the description's pattern runs (a 48-frame squat sent to track)", r.data.ok && r.data.calls.some(c => c.name === "track" && c.ok), r.text);
}
{
	// The session alone: reset(reason) and close().
	const s = createJsSession({ prelude: "globalThis.seed = 7;" });
	let r = await s.run("const kept = seed * 2;\nreturn kept;");
	expect("session prelude runs once per VM", r.ok && r.value.value === 14);
	s.reset("test");
	r = await s.run("return typeof kept;");
	expect("reset(reason) drops kept names and says why", r.ok && r.value.value === "undefined" && /reset \(test\)/.test(r.reset ?? ""), JSON.stringify(r));
	await s.close();
	let threw = false;
	try { await s.run("return 1;"); } catch (e) { threw = /closed/.test(e.message); }
	expect("a closed session refuses new cells", threw);
}
{
	// Abort: a cell that ends within the grace keeps its answer and the VM; a spinning one is stopped.
	const s = createJsSession({ host: { slow: async () => { await new Promise(r => setTimeout(r, 300)); return { data: 5, text: "" }; } } });
	let ac = new AbortController();
	setTimeout(() => ac.abort(), 100);
	let r = await s.run("const keep = 1;\nreturn await slow({});", { signal: ac.signal });
	expect("an aborted cell that ends within the grace keeps its answer", r.ok && r.value.value === 5 && !r.reset, JSON.stringify(r));
	ac = new AbortController();
	setTimeout(() => ac.abort(), 100);
	const t0 = performance.now();
	r = await s.run("while (true) {}", { signal: ac.signal });
	const ms = Math.round(performance.now() - t0);
	expect("an aborted spinning cell is stopped after the grace and resets", !r.ok && r.error?.name === "Aborted" && /reset/.test(r.reset ?? "") && ms < 4000, `${ms} ms ${JSON.stringify(r)}`);
	r = await s.run("return typeof keep;");
	expect("the next cell runs on a fresh VM", r.ok && r.value.value === "undefined");
	await s.close();
}

group("8 speed in QuickJS");
{
	const t0 = performance.now();
	const r = await js.run({ code: `const t0 = Date.now();
const base = rig.pose(), s0 = rig.fk(base), I = rig.index;
const T = rig.track(120);
T.fill(0, 119, f => {
  const p = rig.clone(base), t = rig.ease(f / 119, "smooth");
  rig.move(p, [0, -0.35 * Math.sin(Math.PI * t), 0]);
  const hl = rig.v.add(s0.P[I.LeftHand], [-0.2, -0.4 * t, 0.15]), hr = rig.v.add(s0.P[I.RightHand], [-0.2, -0.4 * t, -0.15]);
  rig.ik2(p, "arm_l", hl); rig.ik2(p, "arm_r", hr);
  rig.ik2(p, "leg_l", rig.v.add(s0.P[I.LeftFoot], [0, 0, 0])); rig.ik2(p, "leg_r", rig.v.add(s0.P[I.RightFoot], [0, 0, 0]));
  return p;
});
const built = Date.now() - t0;
const pl = T.payload();
const ms = Date.now() - t0;
const stored = await track(pl);
const fkCheck = rig.fk(T.get(60));
return { built, payloadMs: ms - built, ms, n: stored.n, frames: pl.frames, hips60: fkCheck.P[I.Hips], hand60: fkCheck.P[I.LeftHand] };` }, {});
	const total = Math.round(performance.now() - t0), v = r.data.value ?? {};
	console.log(`  QuickJS: build ${v.built} ms, payload ${v.payloadMs} ms, cell ${r.data.ms} ms, host total ${total} ms`);
	expect("120 frames x 65 bones, ik2 on 4 limbs per frame, payload() under 5 s", r.data.ok && v.n === 120 * 65 * 4 && v.frames === 120 && total < 5000, r.text);
	// The same pose in Node: QuickJS math gives the same numbers.
	const base = rig.pose(), s0 = rig.fk(base), I = rig.index, p = rig.clone(base), t = rig.ease(60 / 119, "smooth");
	rig.move(p, [0, -0.35 * Math.sin(Math.PI * t), 0]);
	rig.ik2(p, "arm_l", rig.v.add(s0.P[I.LeftHand], [-0.2, -0.4 * t, 0.15]));
	const s = rig.fk(p);
	expect("QuickJS frame 60 equals buildRig in Node within 1e-6 (payload rounding)", maxDiff(v.hips60, s.P[I.Hips]) < 1e-6 && maxDiff(v.hand60, s.P[I.LeftHand]) < 1e-5, `${maxDiff(v.hand60, s.P[I.LeftHand])}`);
	const q = await js.run({ code: `const poses = ${JSON.stringify(poses.slice(0, 10))};\n${sample.toString()}\nreturn sample(rig, poses);` }, {});
	const d = maxDiff(q.data.value, ref);
	expect("QuickJS gives the same FK, IK, sole, COM, palm and flight numbers as buildRig (1e-9)", q.data.ok && d < 1e-9, `max ${d} ${q.text.slice(0, 300)}`);
	console.log(`  QuickJS vs Node max difference: ${d}`);
}
await js.close();

console.log(failures ? `\n${failures} FAIL` : "\nall PASS");
process.exit(failures ? 1 : 0);
