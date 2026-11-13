// Engine m3: the demos as motion3 specs, compiled by the existing deterministic compiler (src/motion3/) and written
// as lowvis clips. Two engines share the specs:
//   m3-xbot  compiles on the 65-bone X Bot and keeps 17 of its bones (the baseline: what motion3 does today)
//   m3-17    compiles directly on the 17-joint rig (rig17.js RIG17_JSON registered as model lowvis-17)
import { compileSpec } from "../../motion3/pipeline.js";
import { skeletonFor, registerRig } from "../../motion3/rigs/index.js";
import { motionScene } from "../../motion3/scene.js";
import { mul, T, quatFromMat } from "../../motion3/compiler/math.js";
import { DEMOS } from "../demos.js";
import { JOINTS, RIG17_JSON, PARENT, OFFSET, qRotate } from "../rig17.js";
import { addCharacter, addProp, createClip, setPose } from "../clip.js";
import { SPECS } from "./specs/index.js";

export const ENGINES = Object.freeze({ "m3-xbot": "x-bot-tpose", "m3-17": "lowvis-17" });

/** The motion3 skeleton an engine compiles on. */
export function skeletonOf(engine) {
	const model = ENGINES[engine];
	if (!model) throw new Error(`unknown engine ${engine}`);
	if (model === "lowvis-17" && !skeletonFor(model)) registerRig(model, RIG17_JSON);
	return skeletonFor(model);
}

/** What a spec needs to know of the body (the same numbers on both rigs: rig17 is the X Bot's joints). */
export function bodyOf(sk) {
	const P = sk.restWorldPos, I = sk.index;
	return { hipsY: P[I.Hips][1], ankleY: P[I.LeftFoot][1] };
}

/** A solved motion3 frame { P, R } -> a clip pose: the 17 kept bones, world position and rotation from rest. */
function projector(sk) {
	const bones = JOINTS.map(n => sk.index[n]), inv = bones.map(b => T(sk.restWorldRot[b]));
	return s => ({ pos: bones.map(b => s.P[b].slice()), quat: bones.map((b, j) => quatFromMat(mul(s.R[b], inv[j]))) });
}

// What compiling on the 17-joint rig leaves out (src/motion3/ changes: compiler/skeleton.js addMarkers, compiler/pose.js,
// rigs/index.js registerRig). Written into every m3-17 clip's notes.
const RIG_NOTES = {
	"m3-17": [
		"compiled on 17 joints; toe, finger, head-top and Spine1 places are rigid marker points on the foot, hand, head and spine (no joint, no turn of their own)",
		"no toe bend: at toe-off the whole foot pitches about the ball, so the toe tip leaves the floor with the heel",
		"no finger stage: finger presets, grasp closing and thumb wrap do nothing; reachGrip and carried objects were not tried",
		"no collision body (the fitted skin is a grid per X Bot bone): fix.self, the keep-out of wrist targets and body anchors, the hanging-arm clearance and QA's BODY / FACE checks are off, so arms can pass through the trunk and the thighs",
		"the spine bends at two joints, not three: Spine takes the missing Spine1's share",
		"the JS pose runs, not the WebAssembly one (its bone table is the X Bot's)",
	],
};

/**
 * Guard for a source rig with bones between some of the 17 joints (the X Bot: Spine1 under Spine2, a shoulder before
 * each arm): their distances change when those bones turn. Measured on the four demos it stays under 0.2 mm, so this
 * does nothing there; where a pose is more than 4 mm off, the joints are put back at their rest offset under the
 * parent's rotation and what hangs under them moves along. Returns the largest move (m).
 */
function rigidify(pose) {
	let worst = 0;
	const shift = JOINTS.map(() => [0, 0, 0]);
	for (let j = 1; j < JOINTS.length; j++) {
		const p = PARENT[j], o = qRotate(pose.quat[p], OFFSET[j]);
		const want = [pose.pos[p][0] + o[0], pose.pos[p][1] + o[1], pose.pos[p][2] + o[2]];
		const here = pose.pos[j].map((v, k) => v + shift[p][k]);
		const rest = Math.hypot(...OFFSET[j]), d = Math.hypot(here[0] - pose.pos[p][0], here[1] - pose.pos[p][1], here[2] - pose.pos[p][2]);
		if (Math.abs(d - rest) > 1e-4) {
			shift[j] = want.map((v, k) => v - pose.pos[j][k]);
			worst = Math.max(worst, Math.hypot(...want.map((v, k) => v - here[k])));
			pose.pos[j] = want;
		} else { shift[j] = shift[p]; pose.pos[j] = here; }
	}
	return worst;
}

const qaLine = qa => (qa?.groups ?? []).map(g => `${g.kind} ${g.subject} x${g.count}`);

/**
 * Builds one demo on one engine: { clip, detail }. buildMs is the time inside the compiler calls only (spec
 * authoring, projection and prop tracks are left out).
 */
export function buildDemo(engine, demoId, { compile = compileSpec } = {}) {
	const def = DEMOS[demoId], sk = skeletonOf(engine), demo = SPECS[demoId](bodyOf(sk)), scene = motionScene(demo.objects ?? []);
	const clip = createClip({ demo: demoId, engine, frameCount: def.frames }), project = projector(sk), detail = {};
	let buildMs = 0, moved = 0, raw = 0;
	const qaTotal = {};
	for (const { id } of def.characters) {
		const spec = demo.characters[id], t0 = performance.now();
		const r = compile(spec, { sk, scene });
		buildMs += performance.now() - t0;
		const c = addCharacter(clip, id);
		let last = null;
		for (let f = 0; f < def.frames; f++) {
			const pose = project(r.out.frames[Math.min(f, r.out.frames.length - 1)].s);
			raw = Math.max(raw, stretchOf(pose));
			if (stretchOf(pose) > 0.004) moved = Math.max(moved, rigidify(pose));
			// keep each joint's quaternion on the side of the frame before (q and -q are the same turn)
			if (last) pose.quat.forEach((q, j) => { if (q[0] * last[j][0] + q[1] * last[j][1] + q[2] * last[j][2] + q[3] * last[j][3] < 0) pose.quat[j] = q.map(v => -v); });
			last = pose.quat;
			setPose(c, f, pose);
		}
		qaTotal[id] = r.qa?.total ?? null;
		detail[id] = { qa: qaLine(r.qa), fixed: Object.keys(r.fixed ?? {}), used: r.used, notes: r.notes };
	}
	for (const p of def.props) if (!p.moves) addProp(clip, p.id, p.size).pos.set(p.at);
	demo.props?.(clip, def);
	clip.stats = { buildMs: Math.round(buildMs * 100) / 100, rig: sk.model, bones: sk.names.length, qaProblems: qaTotal,
		specLines: demo.lines ?? null, rawStretchM: Math.round(raw * 1e4) / 1e4, rigidMoveM: Math.round(moved * 1e4) / 1e4 };
	clip.notes.push(...(demo.notes ?? []), ...(RIG_NOTES[engine] ?? []));
	if (moved > 0) clip.notes.push(`the source rig has bones between some of the 17 joints (Spine1, the shoulders): the raw joint distances were up to ${(raw * 100).toFixed(1)} cm off rest, so the chest, neck, head and arms were put back at their rest offsets (moved up to ${(moved * 100).toFixed(1)} cm); hands can be that far from where the compiler put them`);
	return { clip, detail };
}

function stretchOf(pose) {
	let worst = 0;
	for (let j = 1; j < JOINTS.length; j++) {
		const p = PARENT[j], d = Math.hypot(pose.pos[j][0] - pose.pos[p][0], pose.pos[j][1] - pose.pos[p][1], pose.pos[j][2] - pose.pos[p][2]);
		worst = Math.max(worst, Math.abs(d - Math.hypot(...OFFSET[j])));
	}
	return worst;
}
