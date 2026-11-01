#!/usr/bin/env node
// Experiment: a Smart Primitive played the upstream way on a CozyClay block. The SOMA target windows of one sequence
// (default jump_0_75m NoHandsJump: Entry -> Action -> Exit, 4 poses each with the document's early / token settings) are
// aligned so the Action hips sit over the block's crossing point and the clip's travel runs across the block. The chain
// starts from the Y Bot standing at the clip's start spot, ends with a standing stop past the Exit, the next context is
// always the last 4 played poses, and both ends of every generation are corrected like the engines do. The played motion
// becomes a dense motion spec (written to --out) that installs as is.
// usage: node tools/motionbricks/vault.mjs --block x,z,width,depth,height [--doc jump_0_75m] [--seq NoHandsJump] [--lane x] [--out spec.json]
import { readFileSync, writeFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { somaFK, toCozyPoint, toSomaPoint, SID, SOMA_JOINTS } from "../../src/motion3/bricks/soma.js";
import { solePoints } from "../../src/motion3/qa/geometry.js";
import { somaPose } from "../../src/motion3/bricks/reverse.js";
import { encodePoses, decodeMotion } from "../../src/motion3/bricks/model-io.js";
import { frameChannels, unwrapSeries, roundChannels } from "../../src/motion3/bricks/forward.js";
import { STEP, sparseKeys, poseAt } from "../../src/motion3/bricks/fill.js";
import { correctMotion, saneChannels } from "../../src/motion3/bricks/fill-native-core.js";
import { mul, ry, apply } from "../../src/motion3/compiler/math.js";
import { createRunner } from "../../mcp/motionbricks/model.mjs";
import { RAW, MEDIA, resolve, cached, parseBvh, bvhPose } from "./bvh.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const [bx, bz, bw, bd, bh] = arg("block", "-0.4,3.2,2.1,0.4,0.75").split(",").map(Number);
const docName = arg("doc", "jump_0_75m"), seqName = arg("seq", "NoHandsJump"), lane = Number(arg("lane", "0")), out = arg("out", "/tmp/mb-vault-spec.json");
const standSpec = JSON.parse(readFileSync(arg("stand", new URL("../../mcp/motionbricks/demo/sit.json", import.meta.url).pathname), "utf8"));

const objects = arg("objects") ? JSON.parse(readFileSync(arg("objects"), "utf8")) : [];
const sk = skeletonFor("y-bot-tpose"), scene = motionScene(objects), compile = s => compileSpec(s, { sk, scene }), run = await createRunner();
const docPath = `assets/smart_primitives/soma/${docName}.smart_primitive.json`, doc = JSON.parse(await cached(RAW + docPath, `${docName}.smart_primitive.json`));
const nodes = new Map(); const walk = n => { for (const c of n.components ?? []) if (c.type === "target_pose") nodes.set(n.id, { name: n.name, c }); (n.children ?? []).forEach(walk); }; walk(doc.root);
const seq = doc.sequences.find(s => s.name === seqName) ?? doc.sequences[0];
const steps = seq.node_ids.map(id => nodes.get(id));
const clipPath = resolve(docPath, steps[0].c.clip), bvh = parseBvh(await cached(MEDIA + clipPath, clipPath.split("/").pop()));
const timeOf = c => (c.playback_mode === "frames" ? c.frame_index * bvh.dt : c.sample_time_seconds);
const withFK = p => ({ ...p, P: somaFK(p.root, p.R) });
const windowAt = t => [0, 1, 2, 3].map(k => withFK(bvhPose(bvh, t + k / 30)));

// clip -> scene: the clip's travel (Entry hips -> Exit hips) turned onto the crossing direction, the Action hips over the crossing point
const ground = p => [p.root[0], p.root[2]];
const [e, a, x] = [steps[0], steps[1], steps.at(-1)].map(s => ground(withFK(bvhPose(bvh, timeOf(s.c)))));
const dirClip = [x[0] - e[0], x[1] - e[1]];
const cross = toSomaPoint([lane, 0, bz]), crossAhead = toSomaPoint([lane, 0, bz + 1]);
const dirScene = [crossAhead[0] - cross[0], crossAhead[2] - cross[2]];
const theta = (Math.atan2(dirScene[0], dirScene[1]) - Math.atan2(dirClip[0], dirClip[1])) * 180 / Math.PI, Ry = ry(theta);
const aR = apply(Ry, [a[0], 0, a[1]]), shift = [cross[0] - aR[0], 0, cross[2] - aR[2]];
const placed = p => { const root = apply(Ry, p.root); root[0] += shift[0]; root[2] += shift[2]; return withFK({ root, R: p.R.map(r => mul(Ry, r)) }); };
// --hand right: the clips plant the left hand, so the run is mirrored about the crossing line (left and right joints swapped; a
// joint's frame mirrors in z on the centre line and wholly on a side chain, as the SOMA rig's offsets do: 1.2 cm off at the fingers)
const mirror = arg("hand", "left") === "right", nM = (l => [dirScene[1] / l, 0, -dirScene[0] / l])(Math.hypot(...dirScene));
const MM = [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) - 2 * nM[i] * nM[j])), LC = [[1, 0, 0], [0, 1, 0], [0, 0, -1]], LS = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
const SWAP = SOMA_JOINTS.map(nm => SID[nm.replace(/^(Left|Right)/, m => (m === "Left" ? "Right" : "Left"))]);
const mirrored = p => { const d = p.root.map((v, i) => v - cross[i]), root = apply(MM, d).map((v, i) => v + cross[i]); return withFK({ root, R: SOMA_JOINTS.map((nm, j) => mul(mul(MM, p.R[SWAP[j]]), /^(Left|Right)/.test(nm) ? LS : LC)) }); };
const place = p => (mirror ? mirrored(placed(p)) : placed(p));

// the Y Bot standing (first key of the demo spec), as a SOMA pose turned to face the crossing and moved to a ground spot
const stand0 = somaPose(sk, compile({ ...standSpec, keys: standSpec.keys.slice(0, 1), frames: 2 }).out.frames[0].s);
const standAt = (spot, faceDir) => {
	const h = (() => { const l = stand0.P[22], r = stand0.P[26]; return Math.atan2(r[2] - l[2], -(r[0] - l[0])); })(); // forward = up x (right hip - left hip)
	const want = Math.atan2(faceDir[0], faceDir[1]), R2 = ry((want - h) * 180 / Math.PI);
	const root = apply(R2, [stand0.root[0], stand0.root[1], stand0.root[2]]);
	return withFK({ root: [spot[0], root[1], spot[1]], R: stand0.R.map(r => mul(R2, r)) });
};
const firstClip = place(withFK(bvhPose(bvh, 0)));
let ctx = Array(4).fill(standAt([firstClip.root[0], firstClip.root[2]], dirScene));
// the chain: the sequence's targets, then a standing stop 1.2 m past the Exit
const exitPlaced = place(withFK(bvhPose(bvh, timeOf(steps.at(-1).c))));
const len = Math.hypot(...dirScene), dn = [dirScene[0] / len, dirScene[1] / len];
const swapPins = m => (mirror ? ((m & 1) << 1) | ((m & 2) >> 1) | ((m & 4) << 1) | ((m & 8) >> 1) : m);
const plan = steps.map(s => ({ label: s.name, pins: swapPins(s.c.ik_pin_mask ?? 0), targets: windowAt(timeOf(s.c)).map(place).slice(0, s.c.num_poses_to_use), early: s.c.transition_early_by_frames ?? 0,
	tokens: Array.from({ length: (s.c.max_tokens ?? 14) - (s.c.min_tokens ?? 6) + 1 }, (_, i) => (s.c.min_tokens ?? 6) + i) }));
plan.push({ label: "Stand", targets: [standAt([exitPlaced.root[0] + dn[0] * 1.2, exitPlaced.root[2] + dn[1] * 1.2], dirScene)], early: 0, tokens: Array.from({ length: 9 }, (_, i) => 6 + i) });

// The chain runs like the upstream runtime: each step generates from what was actually shown, plays up to its transition point,
// is corrected (target pose IK pin, block overlaps), and the corrected, shown frames are the context of the next step. So a fix
// in one step is something the next generation continues from, not a patch over finished motion.
const lerp = (p, q, u) => (Array.isArray(p) ? p.map((v, i) => v + (q[i] - v) * u) : p + (q - p) * u);
const smoothstep = (a0, b0, v) => { const t = Math.max(0, Math.min(1, (v - a0) / (b0 - a0))); return t * t * (3 - 2 * t); };
const HAND_CLEAR = 0.09;
const PINS = [[1, "hand_l", "LeftHand"], [2, "hand_r", "RightHand"], [4, "foot_l", "LeftFoot"], [8, "foot_r", "RightFoot"]];
const PART = { foot_l: ["foot_l", ["LeftFoot", "LeftToeBase", "LeftToe_End"], 0.08], foot_r: ["foot_r", ["RightFoot", "RightToeBase", "RightToe_End"], 0.08],
	shin_l: ["foot_l", ["LeftLeg", "LeftFoot"], 0.09], shin_r: ["foot_r", ["RightLeg", "RightFoot"], 0.09],
	hand_l: ["hand_l", ["LeftHand", "LeftHandMiddle4", "LeftHandIndex4"], 0.04], hand_r: ["hand_r", ["RightHand", "RightHandMiddle4", "RightHandIndex4"], 0.04],
	forearm_l: ["hand_l", ["LeftForeArm", "LeftHand"], 0.06], forearm_r: ["hand_r", ["RightForeArm", "RightHand"], 0.06],
	thigh_l: ["root", ["LeftUpLeg", "LeftLeg"], 0.11], thigh_r: ["root", ["RightUpLeg", "RightLeg"], 0.11], hips: ["root", ["Hips"], 0.14] };
const blockOf = id => { const o = scene.objects[id]; return o && { x0: o.pos[0] - o.half[0], x1: o.pos[0] + o.half[0], z0: o.pos[2] - o.half[2], z1: o.pos[2] + o.half[2], top: o.pos[1] + 2 * o.half[1] }; };
const clean = !process.argv.includes("--no-clear") && objects.length > 0;

const shown = [frameChannels(ctx[3].P.map(toCozyPoint))]; // channels per spec frame (24 fps): what was shown
const build = () => {
	const F = shown.length - 1;
	shown.forEach(saneChannels);
	const first = { f: 0, set: { ...roundChannels(shown[0]), armw_l: 1, armw_r: 1 } }, last = { f: F, set: roundChannels(shown[F]) };
	// the planting hand rests the body on the block (QA's supports: its frames are not flight)
	const hand = plan.some(st => st.pins & 2) ? "hand_r" : plan.some(st => st.pins & 1) ? "hand_l" : null, blockId = arg("object");
	return { schema: "cozyclay.motion-spec.v1", label: `MotionBricks ${docName} ${seq.name} over the block`, frames: F + 1, flow: false, fix: false,
		...(hand && blockId ? { checks: { supports: [{ object: blockId, part: hand, tol: 0.05 }] } } : {}), keys: [first, ...(F > 1 ? sparseKeys(shown, 0, "vault", 0.15) : []), ...(F > 0 ? [last] : [])] };
};
/** Moves the parts QA calls COLLIDE in frames >= from clear of the block, on the compiled body; up to `rounds` compiles. */
function clearBlock(from, rounds = 6) {
	const log = [];
	for (let round = 0; round < rounds; round++) {
		const r = compile(build()), hits = (r.qa?.groups ?? []).filter(g => g.kind === "COLLIDE" && g.last >= from);
		if (!hits.length) break;
		const moves = shown.map(() => ({}));
		for (const g of hits) {
			const [part, objId] = g.subject.split(" x "), rule = PART[part], b = blockOf(objId);
			if (!rule || !b) continue;
			const [ch, joints, m] = rule;
			for (let f = Math.max(from, g.first - 1); f <= Math.min(shown.length - 1, g.last + 1); f++) {
				const P = r.out.frames[f].s.P;
				let need = [0, 0, 0];
				for (const q of joints.map(j => P[sk.index[j]]).filter(Boolean)) {
					if (!(q[0] > b.x0 - m && q[0] < b.x1 + m && q[2] > b.z0 - m && q[2] < b.z1 + m) || q[1] >= b.top + m) continue;
					const inside = q[0] > b.x0 && q[0] < b.x1 && q[2] > b.z0 && q[2] < b.z1;
					const d = inside || q[1] > b.top - 0.25 ? [0, b.top + m + 0.01 - q[1], 0]
						: [[b.x0 - m - q[0], 0, 0], [b.x1 + m - q[0], 0, 0], [0, 0, b.z0 - m - q[2]], [0, 0, b.z1 + m - q[2]]].sort((x, y) => Math.hypot(...x) - Math.hypot(...y))[0];
					if (Math.hypot(...d) > Math.hypot(...need)) need = d;
				}
				if (Math.hypot(...need) > (moves[f][ch] ? Math.hypot(...moves[f][ch]) : 0)) moves[f][ch] = need;
			}
		}
		for (const ch of new Set(moves.flatMap(mv => Object.keys(mv)))) {
			const own = moves.map(mv => mv[ch] ?? [0, 0, 0]);
			own.forEach((_, f) => {
				if (f < from) return;
				const sm = [0, 1, 2].map(i => { let w = 0, v = 0; for (let k = -3; k <= 3; k++) { const gg = own[f + k]; if (!gg) continue; const kw = 4 - Math.abs(k); w += kw; v += gg[i] * kw; } const avg = v / w; return Math.abs(own[f][i]) > Math.abs(avg) ? own[f][i] : avg; });
				if (sm.some(v => Math.abs(v) > 1e-4)) shown[f][ch] = shown[f][ch].map((v, i) => v + sm[i]);
			});
		}
		log.push(hits.map(g => `${g.subject} f${g.first}-${g.last}`));
	}
	return log;
}

const report = [];
let releasePin = null;
for (const step of plan) {
	const { feed, align } = encodePoses([...ctx, ...step.targets], step.tokens);
	const res = await run(feed);
	const motion = correctMotion(decodeMotion(res.out, res.tokens, align), ctx[3], step.targets[0]);
	const early = Math.min(step.early, motion.length - 4), seg = motion.slice(0, motion.length - early);
	// this step's 30 fps frames -> spec frames after the last shown one; the first generated frame is the context end, so any
	// difference from the shown frame (retarget round trip) fades out over 6 frames
	const s0 = shown.length - 1, n = seg.length, gen = seg.map(m => frameChannels(m.P.map(toCozyPoint))), add = [];
	const span = Math.round((n - 1) * STEP);
	for (let k = 1; k <= span; k++) { const x = Math.min(n - 1, k / STEP), i = Math.min(Math.floor(x), n - 2), u = x - i; add.push(Object.fromEntries(Object.keys(gen[0]).map(c => [c, lerp(gen[i][c], gen[i + 1][c], u)]))); }
	unwrapSeries(add, shown[s0]);
	const diff = Object.fromEntries(Object.keys(gen[0]).map(c => [c, Array.isArray(gen[0][c]) ? shown[s0][c].map((v, i) => v - gen[0][c][i]) : shown[s0][c] - gen[0][c]]));
	add.forEach((ch, k) => { const w = Math.max(0, 1 - (k + 1) / 6); if (w > 0) for (const c of Object.keys(ch)) ch[c] = Array.isArray(ch[c]) ? ch[c].map((v, i) => v + diff[c][i] * w) : ch[c] + diff[c] * w; });
	shown.push(...add);
	const f0 = s0, f1 = shown.length - 1;
	// a pin from the previous step lets go over 6 frames
	if (releasePin) { const { ch, goal } = releasePin; for (let k = 1; k <= 6 && f0 + k <= f1; k++) shown[f0 + k][ch] = lerp(shown[f0 + k][ch], goal, 1 - k / 6); releasePin = null; }
	// target pose IK pin (upstream TargetPoseIKCorrector): pull from halfway through the step to its transition point
	let pinned = null;
	for (const [bit, ch, joint] of PINS) {
		if (!(step.pins & bit)) continue;
		const goal = toCozyPoint(step.targets[0].P[SID[joint]]);
		if (ch.startsWith("hand")) goal[1] = bh + HAND_CLEAR; // a hand plants on this block's top (the clip's wall differs)
		for (let f = f0 + 1; f <= f1; f++) shown[f][ch] = lerp(shown[f][ch], goal, smoothstep(0.5, 1, (f - f0) / Math.max(1, f1 - f0)));
		releasePin = { ch, goal }; pinned = { [ch]: goal.map(v => +v.toFixed(3)), frames: [f0, f1] };
	}
	const fixes = clean ? clearBlock(Math.max(1, f0 - 2)) : [];
	// the next context: the last 4 shown frames (30 fps) of the corrected, compiled take
	const r = compile(build()), cache = new Map();
	ctx = [3, 2, 1, 0].map(k => poseAt(sk, r.out.frames, cache, Math.max(0, f1 - k * STEP)));
	report.push({ step: step.label, poses: step.targets.length, early: step.early, tokens: res.tokens, frames: [f0, f1], ...(pinned ? { pinned } : {}), ...(fixes.length ? { fixes } : {}) });
}
// joint pops only: QA's POP / FLIP name a bone; on the compiled body find the frames where that bone's acceleration jumps
// (> POP_LIMIT m/frame^2) and relax the channels that drive it over +-3 frames around each (neighbour averaging, ends fixed).
// The block stays clear (re-checked after each pass). Nothing outside those frames changes.
const POP_LIMIT = 0.06;
const DRIVES = { Hips: ["root", "yaw", "pitch", "roll"], Head: ["root", "head_yaw", "head_pitch", "head_roll", "spine_yaw", "spine_pitch", "spine_roll"], Spine: ["root", "spine_yaw", "spine_pitch", "spine_roll"],
	Left: { Leg: ["root", "foot_l", "knee_l"], Foot: ["root", "foot_l", "knee_l", "fpitch_l", "fyaw_l"], ToeBase: ["foot_l", "fpitch_l"], Arm: ["hand_l", "elbow_l"], ForeArm: ["hand_l", "elbow_l"], Hand: ["hand_l", "elbow_l"] },
	Right: { Leg: ["root", "foot_r", "knee_r"], Foot: ["root", "foot_r", "knee_r", "fpitch_r", "fyaw_r"], ToeBase: ["foot_r", "fpitch_r"], Arm: ["hand_r", "elbow_r"], ForeArm: ["hand_r", "elbow_r"], Hand: ["hand_r", "elbow_r"] } };
const drivesOf = bone => { const m = /^(Left|Right)(.+)$/.exec(bone); return m ? DRIVES[m[1]][m[2]] ?? [] : DRIVES[bone] ?? DRIVES[bone.replace(/\d+$/, "")] ?? ["root"]; };
const popLog = [];
for (let round = 0; round < 5; round++) {
	const r = compile(build()), pops = (r.qa?.groups ?? []).filter(g => g.kind === "POP" || g.kind === "FLIP");
	if (!pops.length) break;
	const mark = new Map(); // channel -> Set(frames)
	for (const g of pops) {
		const bone = g.subject.split(" ")[0], j = sk.index[bone], chans = drivesOf(bone);
		const frames = [];
		if (j !== undefined) for (let f = 1; f < shown.length - 1; f++) {
			const [a, b, c] = [f - 1, f, f + 1].map(k => r.out.frames[k].s.P[j]);
			if (Math.hypot(...a.map((v, i) => v - 2 * b[i] + c[i])) > POP_LIMIT) frames.push(f);
		}
		if (!frames.length && Number.isFinite(g.worstFrame)) frames.push(g.worstFrame);
		if (g.kind === "FLIP") frames.push(g.first);
		for (const ch of g.kind === "FLIP" ? chans.filter(c => /knee|elbow/.test(c)) : chans) {
			const set = mark.get(ch) ?? new Set();
			for (const f of frames) for (let k = -3; k <= 3; k++) if (f + k > 0 && f + k < shown.length - 1) set.add(f + k);
			mark.set(ch, set);
		}
	}
	for (const [ch, set] of mark) for (let it = 0; it < 4; it++) {
		const prev = shown.map(d => d[ch]);
		for (const f of set) { const avg = lerp(prev[f - 1], prev[f + 1], 0.5); shown[f][ch] = lerp(prev[f], avg, 0.6); }
	}
	popLog.push(pops.map(g => g.subject.split(" in one")[0]));
	if (clean) clearBlock(1, 3);
}
// soles under the floor are raised by their depth on the compiled body (the clip's skeleton is not the rig's)
for (let pass = 0; pass < 2; pass++) {
	const fr = compile(build()).out.frames;
	shown.forEach((ch, f) => { for (const [k, S] of [["l", "Left"], ["r", "Right"]]) { const sp = solePoints(sk, fr[f].s, S), low = Math.min(sp.heel[1], sp.ball[1], sp.tip[1]); if (low < 0) ch[`foot_${k}`] = [ch[`foot_${k}`][0], ch[`foot_${k}`][1] - low + 0.003, ch[`foot_${k}`][2]]; } });
}
const spec = build(), F = spec.frames - 1;
const finalQa = objects.length ? (compile(spec).qa?.groups ?? []).filter(g => g.kind === "COLLIDE").map(g => `${g.subject} f${g.first}-${g.last}`) : null;
writeFileSync(out, JSON.stringify(spec));
const at = label => report.find(r => r.step === label)?.frames[1] ?? null;
console.log(JSON.stringify({ popRounds: popLog, collideAfter: finalQa, seq: seq.name, clip: clipPath.split("/").pop(), frames: F + 1, keys: spec.keys.length, report, actionAtFrame: at(steps[1].name), block: { x: bx, z: bz, w: bw, d: bd, h: bh }, out }, null, 1));
process.exit(0);
