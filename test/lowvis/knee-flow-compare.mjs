#!/usr/bin/env node
// By hand, not in the suite: a base checkout's engine against this tree's, on the specs of knee-sweep.mjs, every demo,
// knee-flow-inputs.mjs (foot targets that move slowly through and around the two leg directions where knee.js's side has
// no direction), and the solver's direct paths. Everything is measured from the output with this file's own arithmetic.
//   node test/lowvis/knee-flow-compare.mjs <base checkout folder> [out.json]
// Per tree: one-frame knee jumps (the knee moves more than JUMP x scale in the world while its hip and its ankle each
// move less than STEP x scale), the lane's older jump measure (pelvis frame: knee step over 4 x ankle step + 20 mm),
// knee frames wrong by every reading of knee-sweep.mjs, unread ones, the same for elbows, and the lowest knee and the
// lowest joint over all frames. Between the trees: bit-equal clips, knees right on the base and wrong here, differing
// frames with what moved (legs only or not), the largest knee and ankle move, bone lengths, and the largest turn of a
// knee's side about the hip-ankle line from one frame to the next on this tree.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INDEX as J, OFFSET } from "../../src/lowvis/rig17.js";
import { LIMBS, directPaths, frameOf, limbSide, specInputs } from "./knee-sweep.mjs";
import { nearInputs } from "./knee-flow-inputs.mjs";

const baseDir = resolve(process.argv[2] ?? "lowvis-out/fix-kneeflow-base"), root = new URL("../../", import.meta.url).pathname;
const load = async dir => ({
	...(await import(pathToFileURL(join(dir, "src/lowvis/engine-simple/engine.js")).href)),
	...(await import(pathToFileURL(join(dir, "src/lowvis/engine-simple/size.js")).href)),
	DEMOS: (await import(pathToFileURL(join(dir, "src/lowvis/demos.js")).href)).DEMOS,
});
const T = { base: await load(baseDir), new: await load(root) };
const STEP = 0.01, JUMP = 0.03;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 1e-12 ? a.map(v => v / l) : null; };
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => { const t = cross(q, v).map(x => 2 * x), u = cross(q, t); return [v[0] + q[3] * t[0] + u[0], v[1] + q[3] * t[1] + u[1], v[2] + q[3] * t[2] + u[2]]; };
const KNEES = LIMBS.filter(l => l.leg), ELBOWS = LIMBS.filter(l => !l.leg);
const L1 = len(OFFSET[J.LeftLeg]), L2 = len(OFFSET[J.LeftFoot]);
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** The knee's side across the hip-ankle line, pelvis frame, that line, and the knee's distance from it at scale 1:
 *  { d, side, h } or null for a straight leg. */
function sideOf(pose, L) {
	const inv = conj(pose.quat[0]), d = unit(rot(inv, sub(pose.pos[L.end], pose.pos[L.root]))), k = rot(inv, sub(pose.pos[L.mid], pose.pos[L.root]));
	const off = sub(k, d.map(v => v * dot(k, d))), s = unit(off);
	return s && { d, side: s, h: len(off) / (pose.scale ?? 1), dist: len(rot(inv, sub(pose.pos[L.end], pose.pos[L.root]))) / (pose.scale ?? 1) };
}
/** The angle (rad) about the line between the side of frame a carried to frame b's line and frame b's side. */
function turnBetween(a, b) {
	if (!a || !b) return null;
	const c = dot(a.d, b.d), k = cross(a.d, b.d);
	if (1 + c < 1e-9) return null;
	const v = a.side, w = [0, 1, 2].map(i => v[i] * c + cross(k, v)[i] + k[i] * dot(k, v) / (1 + c));
	const from = unit(sub(w, b.d.map(x => x * dot(w, b.d))));
	return from && Math.atan2(len(cross(from, b.side)), dot(from, b.side));
}
const stat = () => ({ frames: 0, jumps: 0, jumpWorst: 0, jumpWorstTag: "", older: 0, wrong: 0, unread: 0, elbowWrong: 0, elbowJumps: 0, lowKnee: Infinity, lowJoint: Infinity, lowKneeTag: "", kneesUnder: 0 });
const sets = {};
const cmp = () => ({ inputs: 0, equal: 0, differ: [], rightToWrong: 0, rightToWrongTags: [], wrongToRight: 0, notLegs: 0, kneeMove: 0, ankleMove: 0, bone: 0, maxTurnNew: 0, maxTurnBase: 0, cappedFrames: 0, moreJumps: [], moreUnder: [], lowerKnee: [], moreWrong: [], moreOlder: [], biggerJump: [] });

/** One clip's frames, measured: per character the per-frame knee readings, jumps. */
function measure(clip, tag, S) {
	const per = [];
	for (const c of clip.characters) {
		const sc = c.scale ?? 1, frames = [];
		for (let f = 0; f < clip.frameCount; f++) {
			const pose = { ...frameOf(c, f), scale: sc }, prev = f ? frames[f - 1].pose : null, k = KNEES.map(L => limbSide(pose.pos, pose.quat, L).twist);
			S.frames++;
			k.forEach(t => { if (t === null) S.unread++; else if (t > 90) S.wrong++; });
			ELBOWS.forEach(L => { const t = limbSide(pose.pos, pose.quat, L).twist; if (t !== null && t > 90) S.elbowWrong++; });
			for (const L of KNEES) {
				const ky = pose.pos[L.mid][1];
				if (ky < S.lowKnee) { S.lowKnee = ky; S.lowKneeTag = `${tag} ${c.id} f${f} ${L.name}`; }
				if (ky < 0) S.kneesUnder++;
			}
			S.lowJoint = Math.min(S.lowJoint, ...pose.pos.map(p => p[1]));
			const sides = KNEES.map(L => sideOf(pose, L));
			if (prev) {
				for (const L of [...KNEES, ...ELBOWS]) {
					const dk = len(sub(pose.pos[L.mid], prev.pos[L.mid])), dh = len(sub(pose.pos[L.root], prev.pos[L.root])), da = len(sub(pose.pos[L.end], prev.pos[L.end]));
					const jump = dh < STEP * sc && da < STEP * sc && dk > JUMP * sc;
					if (!L.leg) { if (jump) S.elbowJumps++; continue; }
					if (jump) { S.jumps++; if (dk / sc > S.jumpWorst) { S.jumpWorst = dk / sc; S.jumpWorstTag = `${tag} ${c.id} f${f} ${L.name}: knee ${(dk * 1000).toFixed(0)} mm, hip ${(dh * 1000).toFixed(1)}, ankle ${(da * 1000).toFixed(1)}`; } }
					const inv = conj(pose.quat[0]), invP = conj(prev.quat[0]), loc = (P, q, j) => rot(q, sub(P.pos[j], P.pos[L.root]));
					if (len(sub(loc(pose, inv, L.mid), loc(prev, invP, L.mid))) > 4 * len(sub(loc(pose, inv, L.end), loc(prev, invP, L.end))) + 0.02) S.older++;
				}
			}
			frames.push({ pose, k, sides, turn: prev ? sides.map((sd, i) => { const t = turnBetween(frames[f - 1].sides[i], sd); return t === null ? null : t * sd.h - sd.dist * Math.acos(Math.min(1, dot(sd.d, frames[f - 1].sides[i].d))); }) : [null, null], legTurn: prev ? KNEES.map((L, i) => sides[i] && frames[f - 1].sides[i] ? Math.acos(Math.min(1, dot(sides[i].d, frames[f - 1].sides[i].d))) : null) : [null, null] });
		}
		per.push({ c, frames });
	}
	return per;
}

function compareSpec(name, tag, spec, def) {
	const S = sets[name] ??= { base: stat(), new: stat(), cmp: cmp() }, C = S.cmp, out = {}, one = {};
	for (const k of ["base", "new"]) {
		const { clip } = T[k].buildClip(structuredClone(spec), def);
		one[k] = stat();
		out[k] = { clip, per: measure(clip, tag, one[k]) };
		for (const [f, v] of Object.entries(one[k])) {
			if (f === "jumpWorst" && v > S[k].jumpWorst) { S[k].jumpWorst = v; S[k].jumpWorstTag = one[k].jumpWorstTag; }
			else if (f === "lowKnee" && v < S[k].lowKnee) { S[k].lowKnee = v; S[k].lowKneeTag = one[k].lowKneeTag; }
			else if (f === "lowJoint") S[k].lowJoint = Math.min(S[k].lowJoint, v);
			else if (typeof v === "number" && !["jumpWorst", "lowKnee"].includes(f)) S[k][f] += v;
		}
	}
	// per input: more one-frame jumps, more knee frames under the floor, or a lower knee than on the base
	if (one.new.jumps > one.base.jumps) C.moreJumps.push(`${tag}: ${one.base.jumps} -> ${one.new.jumps}`);
	if (one.new.jumpWorst > one.base.jumpWorst + 1e-9) C.biggerJump.push(`${tag}: largest jump ${(one.base.jumpWorst * 1000).toFixed(0)} -> ${(one.new.jumpWorst * 1000).toFixed(0)} mm at scale 1 (${one.base.jumps} -> ${one.new.jumps} jumps; ${one.new.jumpWorstTag})`);
	if (one.new.kneesUnder > one.base.kneesUnder) C.moreUnder.push(`${tag}: ${one.base.kneesUnder} -> ${one.new.kneesUnder} frames, lowest knee ${(one.base.lowKnee * 1000).toFixed(0)} -> ${(one.new.lowKnee * 1000).toFixed(0)} mm`);
	if (one.new.lowKnee < one.base.lowKnee - 1e-9) C.lowerKnee.push(`${tag}: ${(one.base.lowKnee * 1000).toFixed(1)} -> ${(one.new.lowKnee * 1000).toFixed(1)} mm`);
	if (one.new.wrong > one.base.wrong) C.moreWrong.push(`${tag}: ${one.base.wrong} -> ${one.new.wrong}`);
	if (one.new.older > one.base.older) C.moreOlder.push(`${tag}: ${one.base.older} -> ${one.new.older}`);
	C.inputs++;
	const cb = out.base.clip.characters, cn = out.new.clip.characters;
	const eq = cb.every((c, i) => same(c.pos, cn[i].pos) && same(c.quat, cn[i].quat));
	if (eq) C.equal++;
	out.base.per.forEach((pb, ci) => {
		const pn = out.new.per[ci], sc = pb.c.scale ?? 1;
		let diff = 0, first = -1;
		pb.frames.forEach((fb, f) => {
			const fn = pn.frames[f];
			fb.turn.forEach((t, i) => { if (t !== null && fb.legTurn[i] < 0.2) C.maxTurnBase = Math.max(C.maxTurnBase, t); });
			fn.turn.forEach((t, i) => { if (t !== null && fn.legTurn[i] < 0.2) C.maxTurnNew = Math.max(C.maxTurnNew, t); });
			fb.k.forEach((t, i) => {
				const r = t !== null && t <= 90, w = fn.k[i] === null || fn.k[i] > 90;
				if (r && w) { C.rightToWrong++; if (C.rightToWrongTags.length < 20) C.rightToWrongTags.push(`${tag} ${pb.c.id} f${f} ${KNEES[i].name} ${t.toFixed(1)} -> ${fn.k[i]?.toFixed(1)}`); }
				if (t !== null && t > 90 && fn.k[i] !== null && fn.k[i] <= 90) C.wrongToRight++;
			});
			if (same(fb.pose.pos.flat(), fn.pose.pos.flat()) && same(fb.pose.quat.flat(), fn.pose.quat.flat())) return;
			diff++; if (first < 0) first = f;
			if ([...Array(11).keys()].some(j => !same(fb.pose.pos[j], fn.pose.pos[j]) || !same(fb.pose.quat[j], fn.pose.quat[j]))) C.notLegs++;
			for (const L of KNEES) {
				C.kneeMove = Math.max(C.kneeMove, len(sub(fb.pose.pos[L.mid], fn.pose.pos[L.mid])) / sc);
				C.ankleMove = Math.max(C.ankleMove, len(sub(fb.pose.pos[L.end], fn.pose.pos[L.end])) / sc);
				C.bone = Math.max(C.bone, Math.abs(len(sub(fn.pose.pos[L.mid], fn.pose.pos[L.root])) - L1 * sc), Math.abs(len(sub(fn.pose.pos[L.end], fn.pose.pos[L.mid])) - L2 * sc));
			}
			if (fn.turn.some((t, i) => t !== null && fn.legTurn[i] < 0.2 && t > 0.0149)) C.cappedFrames++;
		});
		if (diff) {
			// why: on the base, at or before the first differing frame, some knee moved by turning about its hip-ankle line in
			// one frame more than 30 mm (at scale 1, twice knee.js's SWING) further than its ankle went round the hip, while
			// the leg turned under 0.2 rad (the case in which knee.js takes a knee off the side chosen)
			const why = pb.frames.slice(0, first + 1).some(fb => fb.turn.some((t, i) => t !== null && t > 0.03 && fb.legTurn[i] < 0.2)) ? "base knee turned > 30 mm past its ankle in a frame" : "OTHER";
			C.differ.push({ tag, who: pb.c.id, frames: diff, first, why });
		}
	});
}

// 1. specs: the lane's sweep, every demo, the slow foot targets near the two directions (alone and with a second figure)
for (const inp of specInputs()) compareSpec("sweep", inp.tag, { demo: "sweep", ...inp.spec }, inp.def);
const DEMOS = T.new.DEMOS;
for (const d of Object.keys(DEMOS)) compareSpec("demos", d, (await import(pathToFileURL(join(root, `src/lowvis/engine-simple/demos/${d}.js`)).href)).default, DEMOS[d]);
for (const inp of nearInputs()) compareSpec(inp.two ? "near, two figures" : "near", inp.tag, { demo: "near", ...inp.spec }, inp.def);

// 2. direct paths: the solver alone, one step after another; this tree is given the step before's knee (as engine.js does)
const paths = { base: { steps: 0, older: 0, worst: 0 }, new: { steps: 0, older: 0, worst: 0 }, rightToWrong: 0, ankle: 0, notLegs: 0 };
for (const path of directPaths()) {
	const N = 360, prev = { base: null, new: null };
	for (let n = 0; n <= N; n++) {
		const st = path.at(n / N), r = {};
		for (const k of ["base", "new"]) r[k] = T[k].solveSized(structuredClone(st.B), k === "new" && prev.new ? { knee: prev.new.knee } : {}, st.s);
		KNEES.forEach(L => {
			const tb = limbSide(r.base.pos, r.base.quat, L).twist, tn = limbSide(r.new.pos, r.new.quat, L).twist;
			if (tb !== null && tb <= 90 && (tn === null || tn > 90)) paths.rightToWrong++;
			paths.ankle = Math.max(paths.ankle, len(sub(r.base.pos[L.end], r.new.pos[L.end])));
		});
		if ([...Array(11).keys()].some(j => !same(r.base.pos[j], r.new.pos[j]) || !same(r.base.quat[j], r.new.quat[j]))) paths.notLegs++;
		if (prev.base) for (const k of ["base", "new"]) KNEES.forEach(L => {
			const dk = len(sub(r[k].pos[L.mid], prev[k].pos[L.mid])), da = len(sub(r[k].pos[L.end], prev[k].pos[L.end]));
			paths[k].steps++; if (dk > 4 * da + 0.02) paths[k].older++;
			paths[k].worst = Math.max(paths[k].worst, dk - 4 * da);
		});
		prev.base = r.base; prev.new = r.new;
	}
}

// 3. the same spec gives the same bytes: built twice, and after another spec
const probe = nearInputs().filter((_, i) => i % 97 === 0), bytes = inp => { const { clip } = T.new.buildClip(structuredClone({ demo: "near", ...inp.spec }), inp.def); return clip.characters.map(c => [...c.pos, ...c.quat]); };
let repeatable = 0;
for (const [i, inp] of probe.entries()) { const a = bytes(inp); bytes(probe[(i + 1) % probe.length]); const b = bytes(inp); if (a.every((x, j) => same(x, b[j]))) repeatable++; }

const summary = { STEP, JUMP, sets: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, { base: v.base, new: v.new, cmp: { ...v.cmp, moreJumps: v.cmp.moreJumps.length, moreUnder: v.cmp.moreUnder.length, lowerKnee: v.cmp.lowerKnee.length, moreWrong: v.cmp.moreWrong.length, moreOlder: v.cmp.moreOlder.length, biggerJump: v.cmp.biggerJump.length, differ: v.cmp.differ.length, differWhy: v.cmp.differ.reduce((t, d) => ((t[d.why] = (t[d.why] ?? 0) + 1), t), {}) } }])), paths, repeatable: `${repeatable} of ${probe.length}` };
writeFileSync(process.argv[3] ?? join(root, "lowvis-out/knee-flow.json"), JSON.stringify({ summary, differ: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.cmp.differ])), worse: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, { moreJumps: v.cmp.moreJumps, moreUnder: v.cmp.moreUnder, lowerKnee: v.cmp.lowerKnee, moreWrong: v.cmp.moreWrong, moreOlder: v.cmp.moreOlder, biggerJump: v.cmp.biggerJump }])) }, null, 1));
console.log(JSON.stringify(summary, null, 1));
