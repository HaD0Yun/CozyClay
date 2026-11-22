#!/usr/bin/env node
// Reading where a body is happens at the character's real size (src/commands/motion3.js, src/motion3/people.js):
//  - motion.sample answers the drawn bones of a scaled character with a lowvis take: each of the 17 clip joints, which
//    the take puts exactly where the clip has them (studio/take.js), within 1 mm on several frames, at 0.81 and 0.95,
//    placed and turned anywhere
//  - at scale 1 the answer is the one of before, byte for byte (the formula without the scale)
//  - a compile's other people (people.js) are measured at their own scale
//  - the actions that compile for the body at scale 1 still refuse a scaled character, each saying what it does
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { JOINTS, JOINT_COUNT } from "../../src/lowvis/rig17.js";
import { TRACK_RIG, clipTrack } from "../../src/lowvis/studio/take.js";
import { encodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fk } from "../../src/motion3/compiler/skeleton.js";
import { add, apply, ry } from "../../src/motion3/compiler/math.js";
import { peopleOf, personJoint } from "../../src/motion3/people.js";
import { createStudioAppActions } from "../../src/commands/index.js";

const sk = skeletonFor(TRACK_RIG), FRAMES = [0, 9, 23, 40, 59];
const SPEC = { demo: "x", c1: [[0, "walk", { to: [0.9, 1.6] }], [40, "pose", { R: [-0.2, 0.3, 0.1] }]] };
const clipAt = (scale, at, heading) => JSON.parse(serializeClip(buildClip(structuredClone(SPEC), { frames: 60, characters: [{ id: "c1", at, heading, ...(scale === 1 ? {} : { scale }) }], props: [] }).clip));
const errorOf = run => { try { run(); return null; } catch (error) { return error; } };

/** A Studio with one character as the lowvis install leaves it: at the clip's start, at its scale, the take installed. */
function studioWith(clip) {
	const c = clip.characters[0], forward = [c.quat[0], c.quat[1], c.quat[2], c.quat[3]];
	const yaw = Math.atan2(2 * (forward[3] * forward[1] + forward[0] * forward[2]), 1 - 2 * (forward[0] ** 2 + forward[1] ** 2)) * 180 / Math.PI;
	const character = { id: "S1", model: TRACK_RIG, subject: "", x: c.pos[0], y: 0, z: c.pos[2], rot: Math.round(yaw * 10) / 10, ...(c.scale ? { scale: c.scale } : {}) };
	const takes = new Map(), owner = { replace: (id, value) => takes.set(id, value), motionFor: id => takes.get(id) ?? null };
	const ports = { state: () => ({ characters: [character], objects: [], frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) };
	const registry = createStudioAppActions(ports);
	registry.run("motion.v4.install", { characterId: "S1", raw: encodeRawTrack(clipTrack(clip, 0)) });
	return { registry, character, take: takes.get("S1") };
}
const clipJoint = (c, f, j) => c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3);

// --- a scaled body: the sampled bones are the drawn ones ---
for (const [scale, at, heading] of [[0.81, [0.4, -1.2], 35], [0.95, [-2, 3], -120]]) {
	const clip = clipAt(scale, at, heading), { registry, character } = studioWith(clip), c = clip.characters[0];
	assert.equal(character.scale, scale);
	const rows = registry.run("motion.sample", { characterId: "S1", frames: FRAMES, bones: JOINTS.slice() }).output.frames;
	let worst = 0;
	for (const row of rows) JOINTS.forEach((joint, j) => { const p = row.bones[joint], q = clipJoint(c, row.frame, j); worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); });
	assert.ok(worst < 1e-3, `scale ${scale}: motion.sample is within 1 mm of the drawn joints (worst ${(worst * 1000).toFixed(3)} mm)`);
	const head = rows[0].bones.Head[1], unit = clipAt(1, at, heading).characters[0].pos[JOINTS.indexOf("Head") * 3 + 1];
	assert.ok(Math.abs(head / unit - scale) < 2e-3, `the head stands ${scale} times as high as the unit body's`);
	console.log(`ok motion.sample at scale ${scale}: ${JOINTS.length} bones on ${FRAMES.length} frames within ${(worst * 1000).toFixed(3)} mm of the drawn joints`);

	// the actions that compile for the body at scale 1 still refuse it, saying what they do
	const qa = errorOf(() => registry.run("motion.qa", { characterId: "S1" }));
	assert.equal(qa?.code, "TARGET_NOT_READY");
	assert.equal(qa.message, `motion.qa compiles the installed take's spec again, which motion compile does only for a body at scale 1; Block figure S1's scale is ${scale}. motion.sample reads its bones as drawn, at that scale.`);
	assert.match(errorOf(() => registry.run("motion.report", { characterId: "S1" }))?.message ?? "", /^motion\.report compiles the installed take's spec again/);
	assert.equal(errorOf(() => registry.run("motion.compile", { characterId: "S1", spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 10, keys: [] } }))?.message, "Set the character's scale back to 1 before compiling motion.", "compiling keeps its refusal of before");
}
console.log("ok the actions that compile refuse a scaled character with what they do; motion.sample does not refuse it");

// --- at scale 1: the answer of before, byte for byte ---
{
	const clip = clipAt(1, [0.4, -1.2], 35), { registry, take } = studioWith(clip), bones = ["Hips", "Head", "LeftHand", "RightFoot", "hand_r"];
	const answer = registry.run("motion.sample", { characterId: "S1", frames: FRAMES, bones });
	// the formula of before: the take's skeleton at its placement, no scale
	const B = take.bones.length, yaw = ry(take.placement.yaw), before = FRAMES.map(f => {
		const quats = Array.from({ length: B }, (_, b) => Array.from(take.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4)));
		const state = fk(sk, quats, Array.from(take.hips.subarray(f * 3, f * 3 + 3)));
		const name = n => (n === "hand_r" ? "RightHand" : n);
		return { frame: f, bones: Object.fromEntries(bones.map(n => [n, add(take.placement.position, apply(yaw, state.P[sk.index[name(n)]])).map(v => Math.round(v * 1e4) / 1e4)])) };
	});
	assert.equal(JSON.stringify(answer.output), JSON.stringify({ frames: before }), "at scale 1 the answer is the one of before");
	console.log("ok motion.sample at scale 1: the answer of before, byte for byte");
}

// --- a compile's other people are measured at their own scale ---
{
	for (const scale of [0.81, 1]) {
		const clip = clipAt(scale, [1, 2], 90), { character, take } = studioWith(clip), c = clip.characters[0];
		const scene = { people: peopleOf([character, { id: "me" }], "me", id => (id === "S1" ? take : null)) };
		let worst = 0;
		for (const f of FRAMES) JOINTS.forEach((joint, j) => { const p = personJoint(scene, "S1", joint, f), q = clipJoint(c, f, j); worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); });
		assert.ok(worst < 1e-3, `scale ${scale}: a person's joints are the drawn ones (worst ${(worst * 1000).toFixed(3)} mm)`);
		console.log(`ok people at scale ${scale}: a person's joints within ${(worst * 1000).toFixed(3)} mm of the drawn ones`);
	}
}
console.log("PASS verify-size-read");
