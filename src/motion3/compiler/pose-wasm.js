// pose()'s bone edits in WebAssembly (native/pose-rs, built into pose-rs.wasm by `npm run build:pose-wasm`): the rest
// state, the subtree turns, the two-bone IK, the feet, the wrists and the fingers. The hooks stay in JS: before a hook the
// bones the module changed get fresh JS arrays (as rotateSubtree assigns them), after it the whole state goes back. The
// module keeps JS's float order and the host's Math, so a take is the same bit for bit (verify-motion3-pose-wasm.mjs).
// Node loads it at import; a browser fetches it and pose.js runs the JS path until it is ready or if it fails to load.
// CCLAY_POSE_WASM=0 keeps Node on the JS path.
import { add, sub, scale, norm, apply, ry } from "./math.js";
import { fingerCurl, shares, SPREAD, THUMB_WRAP, KNEE_FOLD, ELBOW_FOLD } from "./limbs.js";
import { holdHand } from "./hold.js";
import { closeOnShape } from "./finger-close.js";
import { clampWrist } from "./wrist-clamp.js";
import { ELBOW_REST } from "./arm-orient.js";
import { forgetCentres } from "../body.js";

const K = 27, MAXN = 128, FINGERS = ["Index", "Middle", "Ring", "Pinky", "Thumb"];
// the bone table per side, in the order native/pose-rs/src/lib.rs reads it (ARM .. THUMB4)
const NAMES = ["Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase", "Toe_End", "HandMiddle1", "HandIndex1", "HandPinky1",
	...FINGERS.flatMap(f => [1, 2, 3].map(k => `Hand${f}${k}`)), "HandThumb4"];
const url = new URL("./pose-rs.wasm", import.meta.url), imports = { m: { sin: Math.sin, cos: Math.cos, acos: Math.acos } };
let X = null, scratch = null, views = null, current = null;

function ready(exports) {
	scratch = { ss: exports.alloc(4 * (MAXN + 1)), si: exports.alloc(4 * MAXN * MAXN), rp: exports.alloc(8 * MAXN * 3), rr: exports.alloc(8 * MAXN * 9), bones: exports.alloc(4 * 2 * K) };
	X = exports;
}
const failed = error => console.warn(`pose-wasm: the WebAssembly pose did not load, the JS pose runs (${error?.message ?? error})`);
const fs = globalThis.process?.getBuiltinModule?.("node:fs"), off = globalThis.process?.env?.CCLAY_POSE_WASM === "0";
if (!off && fs) { try { ready(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(url)), imports).exports); } catch (error) { failed(error); } }
else if (!off && typeof fetch === "function") fetch(url).then(r => r.arrayBuffer()).then(b => WebAssembly.instantiate(b, imports)).then(m => ready(m.instance.exports), failed);

/** Whether pose() can run on the module now. */
export const poseWasmReady = () => X !== null;

const view = () => {
	if (!views || views.buf !== X.memory.buffer) {
		const buf = X.memory.buffer;
		views = { buf, io: new Float64Array(buf, X.io_ptr(), 64), P: new Float64Array(buf, X.p_ptr(), MAXN * 3), R: new Float64Array(buf, X.r_ptr(), MAXN * 9), D: new Uint8Array(buf, X.dirty_ptr(), MAXN) };
	}
	return views;
};

function loadRig(sk) {
	if (current === sk) return;
	const n = sk.names.length, idx = [];
	const starts = [];
	for (let b = 0; b < n; b++) { starts.push(idx.length); idx.push(...sk.subtree[b]); }
	starts.push(idx.length);
	const buf = X.memory.buffer;
	new Int32Array(buf, scratch.ss, n + 1).set(starts);
	new Int32Array(buf, scratch.si, idx.length).set(idx);
	new Float64Array(buf, scratch.rp, n * 3).set(sk.restWorldPos.flat());
	new Float64Array(buf, scratch.rr, n * 9).set(sk.restWorldRot.flatMap(m => m.flat()));
	new Int32Array(buf, scratch.bones, 2 * K).set(["Left", "Right"].flatMap(side => NAMES.map(name => sk.index[`${side}${name}`] ?? -1)));
	X.init(n, scratch.ss, idx.length, scratch.si, scratch.rp, scratch.rr, scratch.bones, sk.index.Spine2 ?? sk.index.Hips, sk.index.Hips);
	views = null;
	current = sk;
}

function toJS(s) {
	const { P, R, D } = view();
	for (let j = 0; j < s.P.length; j++) {
		if (!D[j]) continue;
		const p = j * 3, r = j * 9;
		s.P[j] = [P[p], P[p + 1], P[p + 2]];
		s.R[j] = [[R[r], R[r + 1], R[r + 2]], [R[r + 3], R[r + 4], R[r + 5]], [R[r + 6], R[r + 7], R[r + 8]]];
		D[j] = 0;
	}
	return s;
}
function toWasm(s) {
	const { P, R } = view();
	for (let j = 0; j < s.P.length; j++) {
		const p = s.P[j], r = s.R[j], o = j * 9;
		P[j * 3] = p[0]; P[j * 3 + 1] = p[1]; P[j * 3 + 2] = p[2];
		R[o] = r[0][0]; R[o + 1] = r[0][1]; R[o + 2] = r[0][2]; R[o + 3] = r[1][0]; R[o + 4] = r[1][1]; R[o + 5] = r[1][2]; R[o + 6] = r[2][0]; R[o + 7] = r[2][1]; R[o + 8] = r[2][2];
	}
}
const setIO = (at, v) => { const { io } = view(); io[at] = v[0]; io[at + 1] = v[1]; io[at + 2] = v[2]; };
const weighed = (weights, table, part) => Object.entries(weights ?? {}).reduce((acc, [p, w]) => acc + (w || 0) * (table[p]?.[part] ?? 0), 0);

/** pose.js pose() on the module: the same arguments and answer; `ctx` carries pose.js's own helpers. */
export function poseWasm(sk, c, hooks, { num, v3, hangOf, tiltFrame, softReach, turnWeight, KNEE_REST, SIDES }) {
	loadRig(sk);
	X.rest();
	const n = sk.names.length, s = { P: new Array(n), R: new Array(n) }, side = { l: 0, r: 1 }, diag = {};
	const down = num(c.arm_rest, 72), hang = num(c.arm_hang) && num(c.arm_hang) * hangOf(sk, down);
	for (const [name, sg, k] of [["Left", -1, "l"], ["Right", 1, "r"]]) {
		const h = hang * (1 - Math.min(1, Math.max(0, num(c[`armw_${k}`]) + num(c[`hangoff_${k}`]))));
		X.rot1(sk.index[`${name}Arm`], 2, sg * (down - (hooks.fkArm?.(k)?.out ?? 0)));
		if (h) X.rot1(sk.index[`${name}ForeArm`], 2, sg * h);
	}
	for (const [k, name] of Object.entries(SIDES)) {
		const bd = num(c[`abend_${k}`]) + (hooks.fkArm?.(k)?.bend ?? 0), sw = num(c[`aswing_${k}`]);
		if (bd) { X.rot1(sk.index[`${name}ForeArm`], 0, -bd); X.limit_fold(side[k]); }
		if (sw) X.rot1(sk.index[`${name}Arm`], 0, -sw);
	}
	X.spread(2, sk.index.Neck, sk.index.Head, num(c.head_yaw), num(c.head_pitch), num(c.head_roll), 2);
	const sy = num(c.spine_yaw), sp = num(c.spine_pitch), sr = num(c.spine_roll);
	X.spread(2, sk.index.Spine, sk.index.Spine1, sy, sp, sr, 3);
	X.spread(1, sk.index.Spine2, 0, num(c.chest_yaw, sy), num(c.chest_pitch, sp), num(c.chest_roll, sr), 3);
	const yaw = num(c.yaw);
	X.rot_xyz(sk.index.Hips, yaw, num(c.pitch), num(c.roll));
	const root = Array.isArray(c.root) || ArrayBuffer.isView(c.root);
	if (root) setIO(0, v3(c.root));
	X.shift(root ? 1 : 0);
	const tilt = tiltFrame(yaw, num(c.pitch), num(c.roll)), body = tilt?.R ?? ry(yaw);
	if (tilt) { const { io } = view(); for (let i = 0; i < 9; i++) io[9 + i] = tilt.R[i / 3 | 0][i % 3]; }
	for (const [k, name] of Object.entries(SIDES)) {
		if (!c[`foot_${k}`]) continue;
		const target = v3(c[`foot_${k}`]);
		setIO(0, target); setIO(3, apply(body, v3(c[`knee_${k}`], KNEE_REST))); setIO(6, KNEE_REST);
		diag[`leg_miss_${k}`] = X.two_bone(sk.index[`${name}UpLeg`], sk.index[`${name}Leg`], sk.index[`${name}Foot`], 2);
		setIO(0, target);
		const fold = X.asked_fold(side[k], 1);
		if (fold > KNEE_FOLD) diag[`leg_fold_${k}`] = fold;
		X.orient_foot(side[k], num(c[`fyaw_${k}`], yaw), num(c[`fpitch_${k}`]), tilt ? 1 : 0, tilt ? tilt.yaw : 0);
	}
	for (const k of hooks.armOrder ?? ["r", "l"]) {
		const name = SIDES[k], w = num(c[`armw_${k}`]);
		const a = sk.index[`${name}Arm`], fa = sk.index[`${name}ForeArm`], h = sk.index[`${name}Hand`];
		const poleIk = norm(apply(body, v3(c[`elbow_${k}`], [0, -1, -0.3])));
		diag[`arm_miss_${k}`] = 0;
		if (w > 1e-4 && hooks.handTarget) {
			toJS(s);
			const fkHand = s.P[h].slice();
			const goal = hooks.handTarget(k, s, diag) ?? fkHand;
			let target = add(fkHand, scale(sub(goal, fkHand), w));
			if (hooks.keepOut) target = hooks.keepOut(k, s, target);
			const push = hooks.push?.(k);
			if (push) target = add(target, push);
			const sag = hooks.sag?.(k, s, target);
			if (sag) target = add(target, sag);
			const skinPush = hooks.skinPush?.(k);
			if (skinPush) target = add(target, scale(skinPush, turnWeight(w)));
			if (hooks.softReach) target = softReach(sk, s, a, fa, h, target, diag, k);
			const poleFk = norm(sub(s.P[fa], scale(add(s.P[a], fkHand), 0.5)));
			const pole = add(scale(poleFk, 1 - w), scale(poleIk, w));
			toWasm(s);
			setIO(0, target); setIO(3, pole); setIO(6, ELBOW_REST);
			diag[`arm_miss_${k}`] = X.two_bone(a, fa, h, hooks.foldFree ? 0 : 1);
			forgetCentres(s);
			setIO(0, target);
			const fold = X.asked_fold(side[k], 0);
			if (fold > ELBOW_FOLD && !hooks.foldFree) diag[`arm_fold_${k}`] = fold;
		}
		X.wrist(side[k], num(c[`wtwist_${k}`]), num(c[`wflex_${k}`]));
		const weights = shares(hooks.fingerWeights?.(k) ?? c[`fingers_${k}`]), { io } = view();
		["Index", "Middle", "Ring", "Pinky"].forEach((f, i) => { io[i] = weighed(weights, SPREAD, f); });
		FINGERS.forEach((f, i) => { for (let q = 0; q < 3; q++) io[4 + i * 3 + q] = fingerCurl(weights, f, q); });
		for (let i = 0; i < 4; i++) io[19 + i] = weighed(weights, THUMB_WRAP, i);
		X.fingers(side[k]);
		if (!(hooks.hold || hooks.grip || hooks.swivel || hooks.heldShapes || hooks.afterArm)) continue;
		toJS(s);
		const held = hooks.hold?.(k, s);
		if (!held || held.w < 1) hooks.grip?.(k, s, diag);
		if (held) holdHand(sk, s, name, held, ELBOW_REST, diag, k);
		const turn = hooks.swivel?.(k);
		if (turn) { toWasm(s); X.swivel(side[k], turn * turnWeight(w)); toJS(s); if (!held) clampWrist(sk, s, name); }
		const grasped = hooks.heldShapes?.(k, s);
		if (grasped) diag[`closed_${k}`] = closeOnShape(sk, s, name, grasped).touched;
		hooks.afterArm?.(k, s, diag);
		forgetCentres(s);
		toWasm(s);
	}
	return { s: toJS(s), diag };
}
