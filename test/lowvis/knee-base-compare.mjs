#!/usr/bin/env node
// By hand, not in the suite: the leg solver of a base commit against this tree's, on the inputs of knee-sweep.mjs and
// every demo spec. Prints, for each side, how many knees bend the wrong way, the largest wrong-way twist, the largest
// knee jump on a path whose target moves a little each step, and which inputs differ between the two with the reason.
//   node test/lowvis/knee-base-compare.mjs <base-sha> [--quick]
// The base tree is this tree's src/lowvis with solve.js and size.js taken from the base commit (the only files the
// knee change touches), copied to a temporary folder.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIMBS, directInputs, directPaths, frameOf, limbSide, specInputs } from "./knee-sweep.mjs";

const sha = process.argv[2], quick = process.argv.includes("--quick");
if (!sha) throw new Error("usage: knee-base-compare.mjs <base-sha>");
const root = new URL("../../", import.meta.url).pathname, tmp = mkdtempSync(join(tmpdir(), "knee-base-"));
cpSync(join(root, "src/lowvis"), join(tmp, "src/lowvis"), { recursive: true });
for (const f of ["solve.js", "size.js"]) writeFileSync(join(tmp, "src/lowvis/engine-simple", f), execFileSync("git", ["show", `${sha}:src/lowvis/engine-simple/${f}`], { cwd: root }));
const load = async base => ({
	...(await import(pathToFileURL(join(base, "src/lowvis/engine-simple/engine.js")).href)),
	...(await import(pathToFileURL(join(base, "src/lowvis/engine-simple/size.js")).href)),
});
const sides = { base: await load(tmp), new: await load(root) };
const { DEMOS } = await import(pathToFileURL(join(root, "src/lowvis/demos.js")).href);

const KNEES = LIMBS.filter(l => l.leg), ELBOWS = LIMBS.filter(l => !l.leg);
const stat = () => ({ n: 0, wrong: 0, worst: 0, worstTag: "", undef: 0, over60: 0 });
const count = (S, tw, tag) => { S.n++; if (tw === null) { S.undef++; return; } if (tw > 60) S.over60++; if (tw > 90) S.wrong++; if (tw > S.worst) { S.worst = tw; S.worstTag = tag; } };
const R = Object.fromEntries(["base", "new"].map(k => [k, { direct: stat(), spec: stat(), elbow: stat(), path: { steps: 0, worst: 0, worstTag: "", over: 0 }, frames: { steps: 0, worst: 0, worstTag: "", over: 0 } }]));
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || v === b[i]);
const flat = r => [...r.pos.flat(), ...r.quat.flat(), r.assist.bend, r.assist.drop, ...r.slow, ...r.late, ...r.lift];
const diffs = { direct: { equal: 0, n: 0, list: [] }, spec: { equal: 0, n: 0, list: [] } };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
// the base's pole for one leg (pelvis forward plus half the foot's forward), read from an output pose: its part along
// the hip-ankle direction x the pelvis's left (made a unit), which knee.js keeps at 0.25 or more
const rotZ = q => [2 * (q[0] * q[2] + q[3] * q[1]), 2 * (q[1] * q[2] - q[3] * q[0]), 1 - 2 * (q[0] * q[0] + q[1] * q[1])];
const rotX = q => [1 - 2 * (q[1] * q[1] + q[2] * q[2]), 2 * (q[0] * q[1] + q[3] * q[2]), 2 * (q[0] * q[2] - q[3] * q[1])];
function poleAcross(pose, L) {
	const p = rotZ(pose.quat[0]).map((v, i) => v + 0.5 * rotZ(pose.quat[L.end])[i]), d = sub(pose.pos[L.end], pose.pos[L.root]), x = rotX(pose.quat[0]);
	const g = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
	return (p[0] * g[0] + p[1] * g[1] + p[2] * g[2]) / len(g);
}
const reasonOf = (pose, s) => {
	const tw = KNEES.map(L => limbSide(pose.pos, pose.quat, L).twist), across = KNEES.map(L => poleAcross(pose, L));
	if (tw.some(t => !(t <= 90))) return `base knee wrong-way or unread (twist ${tw.map(t => t?.toFixed(1)).join(", ")} deg)`;
	if (across.some(a => a < 0.25)) return `the base pole's part along leg x pelvis-left under 0.25 (${across.map(a => a.toFixed(3)).join(", ")})`;
	return `OTHER (twist ${tw.map(t => t?.toFixed(1)).join(", ")}, across ${across.map(a => a.toFixed(3)).join(", ")}, s ${s})`;
};

// 1. direct inputs
for (const inp of directInputs(quick ? { dirs: 24, scales: [1] } : {})) {
	const out = {};
	for (const k of ["base", "new"]) {
		const r = sides[k].solveSized(structuredClone(inp.B), {}, inp.s);
		out[k] = r;
		for (const L of KNEES) count(R[k].direct, limbSide(r.pos, r.quat, L).twist, `${inp.tag} ${L.name}`);
	}
	diffs.direct.n++;
	if (same(flat(out.base), flat(out.new))) diffs.direct.equal++;
	else diffs.direct.list.push({ tag: inp.tag, why: reasonOf(out.base, inp.s), knee: Math.max(...KNEES.map(L => len(sub(out.base.pos[L.mid], out.new.pos[L.mid])))), ankle: Math.max(...KNEES.map(L => len(sub(out.base.pos[L.end], out.new.pos[L.end])))) });
}
// 2. paths: the knee's step against the ankle's, in the pelvis frame (the pelvis does not move here)
// A step over the bound is cut into 64 and the largest sub-step is kept: a knee that turns fast but continuously moves
// 1/64 as far in a sub-step; a flip moves as far as in the whole step. jump = that sub-step (m) over the 20 mm bound.
const BOUND = (dk, da) => dk > 4 * da + 0.02;
const N = quick ? 240 : 720;
for (const path of directPaths()) for (const k of ["base", "new"]) {
	const solveAt = u => { const st = path.at(u); return sides[k].solveSized(st.B, {}, st.s); };
	let prev = solveAt(0);
	for (let n = 1; n <= N; n++) {
		const r = solveAt(n / N);
		KNEES.forEach(L => {
			const dk = len(sub(r.pos[L.mid], prev.pos[L.mid])), da = len(sub(r.pos[L.end], prev.pos[L.end])), P = R[k].path;
			P.steps++;
			if (!BOUND(dk, da)) return;
			P.over++;
			let sp = prev, big = 0;
			for (let m = 1; m <= 64; m++) { const sr = solveAt((n - 1 + m / 64) / N); big = Math.max(big, len(sub(sr.pos[L.mid], sp.pos[L.mid])) - 4 * len(sub(sr.pos[L.end], sp.pos[L.end]))); sp = sr; }
			if (big > 0.02) P.jumps = (P.jumps ?? 0) + 1;
			if (big > P.worst) { P.worst = big; P.worstTag = `${path.tag} ${L.name} u ${(n / N).toFixed(4)}: sub-step knee ${(big * 1000).toFixed(0)} mm (whole step ${(dk * 1000).toFixed(0)} mm, ankle ${(da * 1000).toFixed(1)} mm)`; }
		});
		prev = r;
	}
}
// 3. specs compiled whole, and every demo
const specs = [...specInputs(), ...Object.keys(DEMOS).map(d => ({ tag: `demo ${d}`, def: DEMOS[d], spec: null, demo: d }))];
const demoSpecs = Object.fromEntries(await Promise.all(Object.keys(DEMOS).map(async d => { try { return [d, (await import(pathToFileURL(join(root, `src/lowvis/engine-simple/demos/${d}.js`)).href)).default]; } catch { return [d, null]; } })));
const local = (pose, j, L) => { const q = pose.quat[0], c = [-q[0], -q[1], -q[2], q[3]], v = sub(pose.pos[j], pose.pos[L.root]); const t = [2 * (c[1] * v[2] - c[2] * v[1]), 2 * (c[2] * v[0] - c[0] * v[2]), 2 * (c[0] * v[1] - c[1] * v[0])]; return [v[0] + c[3] * t[0] + c[1] * t[2] - c[2] * t[1], v[1] + c[3] * t[1] + c[2] * t[0] - c[0] * t[2], v[2] + c[3] * t[2] + c[0] * t[1] - c[1] * t[0]]; };
for (const inp of specs) {
	const spec = inp.demo ? demoSpecs[inp.demo] : { demo: "sweep", ...inp.spec };
	if (!spec) continue;
	const clips = {};
	for (const k of ["base", "new"]) {
		const { clip } = sides[k].buildClip(structuredClone(spec), inp.def);
		clips[k] = clip;
		for (const c of clip.characters) {
			let prev = null;
			for (let f = 0; f < clip.frameCount; f++) {
				const pose = frameOf(c, f);
				for (const L of KNEES) count(R[k].spec, limbSide(pose.pos, pose.quat, L).twist, `${inp.tag} ${c.id} f${f} ${L.name}`);
				for (const L of ELBOWS) count(R[k].elbow, limbSide(pose.pos, pose.quat, L).twist, `${inp.tag} ${c.id} f${f} ${L.name}`);
				if (prev) KNEES.forEach(L => {
					const dk = len(sub(local(pose, L.mid, L), local(prev, L.mid, L))), da = len(sub(local(pose, L.end, L), local(prev, L.end, L))), P = R[k].frames;
					P.steps++;
					if (BOUND(dk, da)) P.over++;
					if (dk - 4 * da > P.worst) { P.worst = dk - 4 * da; P.worstTag = `${inp.tag} f${f} ${L.name} knee ${(dk * 1000).toFixed(0)} mm, ankle ${(da * 1000).toFixed(1)} mm`; }
				});
				prev = pose;
			}
		}
	}
	diffs.spec.n++;
	const cb = clips.base.characters, cn = clips.new.characters;
	if (cb.every((c, i) => same(c.pos, cn[i].pos) && same(c.quat, cn[i].quat))) { diffs.spec.equal++; continue; }
	const c = cb[0], f0 = Array.from({ length: clips.base.frameCount }, (_, f) => f).find(f => !same(frameOf(c, f).pos.flat(), frameOf(cn[0], f).pos.flat()) || !same(frameOf(c, f).quat.flat(), frameOf(cn[0], f).quat.flat()));
	const frames = Array.from({ length: clips.base.frameCount }, (_, f) => f).filter(f => !same(frameOf(c, f).pos.flat(), frameOf(cn[0], f).pos.flat()) || !same(frameOf(c, f).quat.flat(), frameOf(cn[0], f).quat.flat()));
	const whys = new Set(frames.map(f => reasonOf(frameOf(c, f), 1).replace(/ \(.*$/, "")));
	const notLegs = frames.some(f => { const a = frameOf(c, f), b = frameOf(cn[0], f); return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].some(j => !same(a.pos[j], b.pos[j]) || !same(a.quat[j], b.quat[j])); });
	diffs.spec.list.push({ tag: inp.tag, frames: frames.length, first: f0, whys: [...whys], upperBodyChanged: notLegs, why: reasonOf(frameOf(c, f0), 1) });
}

const out = { sha, quick, R, diffs: { direct: { ...diffs.direct, byReason: tally(diffs.direct.list), maxAnkleMove: diffs.direct.list.reduce((m, d) => Math.max(m, d.ankle), 0) }, spec: { ...diffs.spec, byReason: tally(diffs.spec.list.flatMap(d => d.whys)) } } };
function tally(list) { const t = {}; for (const d of list) { const k = (typeof d === "string" ? d : d.why).replace(/ \(.*$/, ""); t[k] = (t[k] ?? 0) + 1; } return t; }
const file = process.env.KNEE_OUT ?? join(tmp, "result.json");
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ R, direct: { n: diffs.direct.n, equal: diffs.direct.equal, byReason: out.diffs.direct.byReason, maxAnkleMove: out.diffs.direct.maxAnkleMove }, spec: { n: diffs.spec.n, equal: diffs.spec.equal, byReason: out.diffs.spec.byReason } }, null, 1));
console.log("full result:", file);
