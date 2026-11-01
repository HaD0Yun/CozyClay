#!/usr/bin/env node
// The opt-in native MotionBricks fill (src/motion3/bricks/fill-native*.js) without the model: a stub runner answers every request
// with a still SOMA pose and the longest token count the request allows. Checks the engines' endpoint correction (the corrected
// motion starts on the context pose and ends on the target), the target count (4 at a pass-through key, 1 at the last), and the
// four timings: exact keeps the authored frames, free time-warps, retime moves the later keys to where the model arrives, and
// playground runs one chain whose middle key is a guide (not a key of the result) and whose last key is reached.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { somaPose } from "../../src/motion3/bricks/reverse.js";
import { decodeMotion, MIN_TOKENS } from "../../src/motion3/bricks/model-io.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";
import { STEP } from "../../src/motion3/bricks/fill.js";
import { correctMotion, stepFeet } from "../../src/motion3/bricks/fill-native-core.js";
import { fillSpecNative } from "../../src/motion3/bricks/fill-native.js";
import { carryHands } from "../../src/motion3/bricks/fill-carry.js";
import { holdStance } from "../../src/motion3/bricks/fill-stance.js";
import { fillBrief, declarations } from "../../src/commands/motion3-fill.js";
import { validateStudioSchema } from "../../src/studio-agent-protocol.js";
import { fillRequest } from "../../mcp/motionbricks/service.mjs";
import { blockOf, primitiveRequest } from "../../mcp/motionbricks/primitive.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const FEAT = 366, ROT0 = 5 + 29 * 3;
/** A runner that always answers a still pose (identity rotations, hips 0.95 m up) at the longest allowed token count. */
function stubRunner(log = []) {
	return async feed => {
		const allowed = Array.from(feed.allowed_pred_num_tokens.data).map((on, i) => (on ? MIN_TOKENS + i : 0)).filter(Boolean);
		const tokens = Math.max(...allowed), out = new Float32Array(64 * FEAT);
		for (let f = 0; f < 64; f++) {
			const o = f * FEAT;
			out[o + 1] = 0.95;
			for (let j = 0; j < 30; j++) out.set([1, 0, 0, 0, 1, 0], o + ROT0 + j * 6);
			out.fill(1, o + FEAT - 4, o + FEAT);
		}
		log.push({ tokens, targets: Array.from(feed.has_local_poses.data).reduce((n, v) => n + v, 0) - 4 });
		return { out, tokens };
	};
}

const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]), compile = s => compileSpec(s, { sk, scene });
const demo = JSON.parse(readFileSync(new URL("../../mcp/motionbricks/demo/sit.json", import.meta.url), "utf8"));
const authoredFrames = spec => [...new Set(spec.keys.filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// endpoint correction: start on the context pose, end on the target, both exactly
{
	const r = compile(demo), start = somaPose(sk, r.out.frames[0].s), end = somaPose(sk, r.out.frames[20].s);
	const { out } = await stubRunner()({ allowed_pred_num_tokens: { data: Int32Array.from({ length: 11 }, (_, i) => +(i === 4)) }, has_local_poses: { data: new Int32Array(8) } });
	const motion = correctMotion(decodeMotion(out, 10, { Ap: [0, 0, 0], AR: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }), start, end);
	const worst = (a, b) => Math.max(...a.P.map((p, j) => dist(p, b.P[j])));
	expect("correctMotion: the first frame is the context pose", worst(motion[0], start) < 1e-6, `off by ${worst(motion[0], start)}`);
	expect("correctMotion: the last frame is the target pose", worst(motion.at(-1), end) < 1e-6, `off by ${worst(motion.at(-1), end)}`);
	expect("correctMotion: 34 valid frames for 10 tokens", motion.length === 34, `${motion.length}`);
}

// exact: authored frames stay, 4 targets at the middle key and 1 at the last, the model's longer length is a timing hint
{
	const log = [], r = await fillSpecNative(demo, { sk, compile, run: stubRunner(log) }, { timing: "exact", gate: false });
	expect("exact: the authored key frames stay 0, 20, 42", JSON.stringify(authoredFrames(r.spec)) === "[0,20,42]", JSON.stringify(authoredFrames(r.spec)));
	expect("exact: two gaps generated", r.calls === 2, `${r.calls}`);
	expect("exact: 4 target poses at the pass-through key, 1 at the last", JSON.stringify(r.gaps.map(g => g.targets)) === "[4,1]", JSON.stringify(r.gaps.map(g => g.targets)));
	expect("exact: fill keys between the authored keys", r.spec.keys.some(isFillKey));
	expect("exact: a timing hint when the model wants longer", (r.warnings ?? []).some(w => w.startsWith("timing f0-f20")), JSON.stringify(r.warnings));
	expect("exact: the filled spec compiles", compile(r.spec).out.frames.length === 43, `${compile(r.spec).out.frames.length}`);
}

// retime: each gap takes the model's length, the later keys move by the difference
{
	const r = await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "retime" });
	const fs = authoredFrames(r.spec), len = Math.round((14 * 4 - 6) * STEP);
	expect("retime: every gap is the model's length", fs[1] - fs[0] === len && fs[2] - fs[1] === len, JSON.stringify(fs));
	expect("retime: reported as authored -> model frames", r.retimed?.length === 2 && r.retimed[0].authored === 20 && r.retimed[0].model === len, JSON.stringify(r.retimed));
	expect("retime: the take grows to the last key", r.spec.frames >= fs[2] + 1, `${r.spec.frames}`);
}

// playground: one chain, the middle key is a guide, the last key is reached where the chain arrives
{
	const r = await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "playground" });
	const fs = authoredFrames(r.spec);
	expect("playground: the middle key is not a key of the result (a guide)", fs.length === 2 && !fs.includes(20), JSON.stringify(fs));
	expect("playground: the guide is reported with where it was passed", r.guides?.[0]?.authored === 20 && r.guides[0].at > 20, JSON.stringify(r.guides));
	expect("playground: the last key closes the take", fs[1] === r.spec.frames - 1 && r.guides.at(-1).at === fs[1], `${fs} / ${r.spec.frames}`);
	expect("playground: the guide step hands over 8 frames early", r.gaps[0].early === 8 && r.gaps[1].early === 0, JSON.stringify(r.gaps));
	expect("playground: installs as is (fix: false)", r.spec.fix === false && compile(r.spec).out.frames.length === r.spec.frames, `${compile(r.spec).out.frames.length} vs ${r.spec.frames}`);
}

// a sit whose feet the model keeps planted while the authored keys put the legs out: hold, then one foot after the other
{
	const n = 23, out = Array.from({ length: n }, (_, i) => ({ root: [0, 0.99 - 0.82 * i / (n - 1), 0], foot_l: [0.1, 0.105, 0.4 * i / (n - 1)], foot_r: [-0.1, 0.105, 0.4 * i / (n - 1)] }));
	out.holds = { l: [[0, n - 1]], r: [[0, n - 1]] };
	stepFeet(out);
	const moving = side => out.map((o, i) => i > 0 && Math.abs(o[`foot_${side}`][2] - out[i - 1][`foot_${side}`][2]) > 1e-6);
	const L = moving("l"), Rr = moving("r"), firstL = L.indexOf(true);
	expect("stepFeet: the feet hold until the hips are most of the way down", firstL > 8 && out[firstL - 1].foot_l[2] === 0, `${firstL}`);
	expect("stepFeet: never both feet moving on one frame", !L.some((m, i) => m && Rr[i]), JSON.stringify([L, Rr].map(a => a.map(Number).join(""))));
	expect("stepFeet: both end on the authored key, lifted in between", out.at(-1).foot_r[2] === 0.4 && out.some(o => o.foot_l[1] > 0.105), JSON.stringify(out.at(-1)));
}

// motion.fill's answer: a brief that fits the receipt, with the keys the fill moved; timing is checked by the dev server's route
{
	const r = await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "playground" }), b = fillBrief(r, demo);
	expect("brief: the playground's last key move and guides are named", b.moved?.[0] === `f${authoredFrames(demo).at(-1)} -> f${authoredFrames(r.spec).at(-1)}` && b.guides?.[0]?.startsWith("f20 reached"), JSON.stringify(b));
	const many = { ...r, gaps: Array.from({ length: 30 }, (_, i) => ({ f: [i, i + 20], tokens: 10, targets: 4, modelWants: { exact: 12 }, ms: 20 })), warnings: Array.from({ length: 30 }, () => "x".repeat(400)), spans: Array.from({ length: 200 }, (_, i) => [i, i + 1]) };
	const bytes = JSON.stringify(fillBrief(many, demo)).length;
	expect("brief: 30 gaps and 30 long warnings stay under 1.5 KB (6 lines each, spans left out)", bytes < 1500, `${bytes}`);
	const exact = fillBrief(await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "exact" }), demo);
	expect("brief: exact moves no key", !exact.moved && exact.mode === "native", JSON.stringify(exact));
	const args = validateStudioSchema(declarations[0].input, { characterId: "c", base: "spec-0123456789ab", timing: "exact", gate: false }, "INVALID_ARGUMENT", "args");
	expect("action: motion.fill takes timing and gate", args.timing === "exact" && args.gate === false, JSON.stringify(args));
	const bad = (() => { try { validateStudioSchema(declarations[0].input, { characterId: "c", base: "spec-0123456789ab", timing: "fast" }, "INVALID_ARGUMENT", "args"); return null; } catch (e) { return e.code; } })();
	expect("action: an unknown timing is refused with INVALID_ARGUMENT", bad === "INVALID_ARGUMENT", String(bad));
	const refused = await fillRequest({ spec: demo, timing: "fast" }).then(() => null, e => e.code);
	expect("route: an unknown timing is INVALID_ARGUMENT", refused === "INVALID_ARGUMENT", String(refused));
}

// motion.primitive's route: the block's box from the editor row, refused unless opted in (the poses are evaluation-licensed)
{
	const b = blockOf({ id: "cube", x: 0, y: 0, z: 3, rot: 0, scaleX: 2, scaleY: 0.75, scaleZ: 0.4, footprint: { width: 1, depth: 1 }, height: 1 });
	expect("primitive: a cube row is a 2 x 0.4 x 0.75 m block at z 3", b.w === 2 && Math.abs(b.d - 0.4) < 1e-9 && b.h === 0.75 && b.z === 3, JSON.stringify(b));
	const saved = process.env.COZYCLAY_MB_PRIMITIVES; delete process.env.COZYCLAY_MB_PRIMITIVES;
	const off = await primitiveRequest({ kind: "vault", objectId: "cube", objects: [] }).then(() => null, e => e.code);
	if (saved !== undefined) process.env.COZYCLAY_MB_PRIMITIVES = saved;
	expect("primitive: off unless COZYCLAY_MB_PRIMITIVES=1 (CAPABILITY_MISSING)", off === "CAPABILITY_MISSING", String(off));
}

{ // carry: the hand holding a carried object (and the other hand when both gap ends key it) follows the author's curve, not the model
	const rows = n => Array.from({ length: n }, () => ({ hand_r: [9, 9, 9], hand_l: [9, 9, 9], root: [0, 1, 0] }));
	const baked = { hand_r: Array.from({ length: 40 }, (_, f) => [-0.2, 1, f / 100]), hand_l: Array.from({ length: 40 }, (_, f) => [0.2, 1, f / 100]) };
	const spec = { props: { grip: { hand: "r" } }, objects: { box: { prop: "grip", grab: 10, release: 30 } } };
	const ik = f => ({ f, set: { armw_l: 1, armw_r: 1, hand_l: [0.2, 1, 0], hand_r: [-0.2, 1, 0] } });
	const inside = carryHands(rows(21), 10, 30, spec, [ik(10), ik(30)], baked), near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
	expect("carry: the carrying hand takes the author's curve after the grab ease", near(inside[10].hand_r, baked.hand_r[20]));
	expect("carry: the other hand, keyed at both ends, follows too", near(inside[10].hand_l, baked.hand_l[20]));
	expect("carry: the body stays the model's", JSON.stringify(inside[10].root) === "[0,1,0]");
	const inherited = carryHands(rows(21), 10, 30, spec, [{ f: 0, set: { armw_l: 1, armw_r: 1 } }, { f: 10, set: { hand_l: [0.2, 1, 0], hand_r: [-0.2, 1, 0] } }, { f: 30, set: { hand_l: [0.2, 1, 0], hand_r: [-0.2, 1, 0] } }], baked);
	expect("carry: armw set on an earlier key still makes it a two-hand hold", near(inherited[20].hand_l, inside[20].hand_l), inherited[20].hand_l);
	const released = carryHands(rows(21), 10, 30, spec, [{ f: 0, set: { armw_l: 1 } }, { f: 10, set: { armw_l: 0, hand_l: [0.2, 1, 0] } }, { f: 30, set: { hand_l: [0.2, 1, 0] } }], baked);
	expect("carry: a later key that sets armw to 0 ends the two-hand hold", JSON.stringify(released[20].hand_l) === JSON.stringify(rows(21)[20].hand_l), released[20].hand_l);
	const before = carryHands(rows(10), 0, 9, spec, [ik(0), ik(9)], baked);
	expect("carry: a gap before the grab keeps the model's hands", JSON.stringify(before[5].hand_r) === "[9,9,9]");
	const oneHand = carryHands(rows(21), 10, 30, spec, [{ f: 10, set: { armw_r: 1, hand_r: [-0.2, 1, 0] } }, { f: 30, set: {} }], baked);
	expect("carry: a free other hand (no IK keys at the gap ends) keeps the model's swing", JSON.stringify(oneHand[10].hand_l) === "[9,9,9]");
	const ease = carryHands(rows(21), 10, 30, spec, [ik(10), ik(30)], baked);
	expect("carry: the grab frame blends in, not a jump", ease[0].hand_r[0] > -0.2 && ease[0].hand_r[0] < 9);
	{ // body frame: keyed 0.4 m in front at yaw 0 and at yaw 90, the hand rides the model's body through the turn (not the chord)
		const b = { root: Array.from({ length: 21 }, () => [0, 1, 0]), yaw: Array.from({ length: 21 }, (_, f) => (f <= 10 ? 0 : 90)), hand_r: Array.from({ length: 21 }, (_, f) => (f <= 10 ? [0, 1, 0.4] : [0.4, 1, 0])) };
		const turning = Array.from({ length: 11 }, (_, i) => ({ hand_r: [9, 9, 9], root: [0, 1, 0], yaw: i * 9 }));
		const out = carryHands(turning, 10, 20, { props: { grip: { hand: "r" } }, objects: { box: { prop: "grip", grab: 0 } } }, [], b);
		expect("carry: through a turn the hand stays 0.4 m from the body (rides the yaw)", Math.abs(Math.hypot(out[5].hand_r[0], out[5].hand_r[2]) - 0.4) < 1e-6, JSON.stringify(out[5].hand_r));
		expect("carry: at the turn's middle the hand is ahead at 45 degrees", Math.abs(out[5].hand_r[0] - out[5].hand_r[2]) < 1e-6);
	}
	expect("carry: no carried object, nothing changes", JSON.stringify(carryHands(rows(3), 0, 2, {}, [], baked)[1].hand_r) === "[9,9,9]");
}

{ // stance: the foot keyed at one spot at both gap ends stays there; the stepping foot keeps the model's swing
	const rows = Array.from({ length: 5 }, (_, i) => ({ foot_l: [0.1, 0.1 + i / 50, i / 100], foot_r: [-0.1, 0.1 + (i === 2 ? 0.2 : 0), i / 10] }));
	const keys = [{ f: 10, set: { foot_l: [0.1, 0.1, 0], foot_r: [-0.1, 0.1, 0] } }, { f: 14, set: { foot_l: [0.1, 0.1, 0], foot_r: [-0.1, 0.1, 0.4] } }];
	rows[4].foot_l = [0.1, 0.1, 0]; rows[0].foot_l = [0.1, 0.1, 0];
	holdStance(rows, 10, 14, keys);
	expect("stance: the support foot does not leave its spot", rows.every(r => Math.abs(r.foot_l[1] - 0.1) < 1e-9 && Math.abs(r.foot_l[2]) < 1e-9));
	expect("stance: the stepping foot keeps its lift", rows[2].foot_r[1] > 0.25);
	const swing = Array.from({ length: 5 }, (_, i) => ({ foot_r: [0, 0.1, i], fyaw_r: [170, 30, 60, 100, -175][i], fpitch_r: [0, 30, 55, 30, 0][i] }));
	holdStance(swing, 0, 4, [{ f: 0, set: { foot_r: [0, 0.1, 0] } }, { f: 4, set: { foot_r: [0, 0.1, 4] } }]);
	expect("swing: the heading turns the short way across +-180", swing.every(r => r.fyaw_r >= 170 && r.fyaw_r <= 185), JSON.stringify(swing.map(r => r.fyaw_r)));
	expect("swing: the toe-down stops before the foot flips", swing.every(r => r.fpitch_r <= 40));
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
