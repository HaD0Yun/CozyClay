#!/usr/bin/env node
// Reading where a body is happens at the character's real size and place (src/commands/motion3.js, src/motion3/people.js):
//  - motion.sample answers the bones of a scaled character with a lowvis take where the stage puts them: each of the 17
//    clip joints, which the take puts exactly where the clip has them (studio/take.js), within 1 mm on several frames,
//    at 0.6, 0.81, 0.95 and 1.3, placed and turned anywhere; a character moved, turned, lifted or resized after the
//    install carries its take, and the answer goes with it
//  - at scale 1 the answer is the one of before, byte for byte (the formula without the scale)
//  - a compile's other people (people.js) are measured at their own scale: their joints and their thickness
//  - motion.compile compiles for the body a scaled character stands as (src/commands/motion3-scale.js), and the reads
//    that measure by compiling say of a raw track, at any scale, that it has no spec to compile
import "./block-figure.mjs"; // the block figure's numbers (figure.js: the launch names the look)
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
import { personCapsules } from "../../src/motion3/qa/people-checks.js";
import { CAPSULES } from "../../src/motion3/qa/geometry.js";
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
for (const [scale, at, heading] of [[0.6, [1.5, 0.7], 170], [0.81, [0.4, -1.2], 35], [0.95, [-2, 3], -120], [1.3, [0, 0], -45]]) {
	const clip = clipAt(scale, at, heading), { registry, character } = studioWith(clip), c = clip.characters[0];
	assert.equal(character.scale, scale);
	const answer = registry.run("motion.sample", { characterId: "S1", frames: FRAMES, bones: JOINTS.slice() }), rows = answer.output.frames;
	assert.equal(answer.summary, `Sampled ${FRAMES.length} frames at scale ${scale}.`, "the receipt says the scale it read at");
	let worst = 0;
	for (const row of rows) JOINTS.forEach((joint, j) => { const p = row.bones[joint], q = clipJoint(c, row.frame, j); worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); });
	assert.ok(worst < 1e-3, `scale ${scale}: motion.sample is within 1 mm of the drawn joints (worst ${(worst * 1000).toFixed(3)} mm)`);
	const head = rows[0].bones.Head[1], unit = clipAt(1, at, heading).characters[0].pos[JOINTS.indexOf("Head") * 3 + 1];
	assert.ok(Math.abs(head / unit - scale) < 2e-3, `the head stands ${scale} times as high as the unit body's`);
	console.log(`ok motion.sample at scale ${scale}: ${JOINTS.length} bones on ${FRAMES.length} frames within ${(worst * 1000).toFixed(3)} mm of the drawn joints`);

	// moved, turned, lifted and resized after the install: the stage draws the take's body at the character's place, turn
	// and scale (the clip's joints carried along), and motion.sample answers there
	const from = [character.x, 0, character.z], was = character.rot, of = scale, to = [character.x + 0.7, 0.25, character.z - 1.1], turn = 50, now = scale === 0.95 ? 1 : Math.round(scale * 80) / 100;
	Object.assign(character, { x: to[0], y: to[1], z: to[2], rot: was + turn, scale: now });
	const a = turn * Math.PI / 180, carried = q => { const x = (q[0] - from[0]) * now / of, y = (q[1] - from[1]) * now / of, z = (q[2] - from[2]) * now / of; return [to[0] + x * Math.cos(a) + z * Math.sin(a), to[1] + y, to[2] - x * Math.sin(a) + z * Math.cos(a)]; };
	const moved = registry.run("motion.sample", { characterId: "S1", frames: FRAMES, bones: JOINTS.slice() });
	assert.equal(moved.summary, now === 1 ? `Sampled ${FRAMES.length} frames.` : `Sampled ${FRAMES.length} frames at scale ${now}.`);
	let off = 0;
	for (const row of moved.output.frames) JOINTS.forEach((joint, j) => { const p = row.bones[joint], q = carried(clipJoint(c, row.frame, j)); off = Math.max(off, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); });
	assert.ok(off < 1e-3, `scale ${of} -> ${now}, moved and turned: motion.sample goes with the character (worst ${(off * 1000).toFixed(3)} mm)`);
	console.log(`ok motion.sample after a move, a turn, a lift and a resize ${of} -> ${now}: within ${(off * 1000).toFixed(3)} mm of where the stage puts the joints`);
	Object.assign(character, { x: from[0], y: 0, z: from[2], rot: was, scale: of });

	// the reads that measure by compiling cannot measure a raw track
	const qa = errorOf(() => registry.run("motion.qa", { characterId: "S1" }));
	assert.equal(qa?.code, "TARGET_NOT_READY");
	// a lowvis take is a raw track: motion.qa and motion.report cannot measure it at any scale, and say that (not the scale)
	assert.equal(qa.message, "motion.qa measures a take by compiling its motion spec again; Block figure S1's take was installed as a raw track and has no spec to compile, at any scale. motion.sample reads the take's bones at the character's place and scale.");
	assert.match(errorOf(() => registry.run("motion.report", { characterId: "S1" }))?.message ?? "", /^motion\.report measures a take by compiling its motion spec again; .* no spec to compile, at any scale\./);
	const made = registry.run("motion.compile", { characterId: "S1", spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 10, keys: [] }, repair: false });
	assert.equal(made.output.frames, 10, `scale ${scale}: motion.compile compiles for the body the character stands as`);
}
console.log("ok the reads that measure by compiling refuse a raw track with what they do; motion.compile and motion.sample take a scaled character");

// --- the reads that measure by compiling: a raw track at scale 1 too, and a compiled take on a body scaled after ---
{
	const { registry } = studioWith(clipAt(1, [0, 0], 0));
	for (const action of ["motion.qa", "motion.report"]) {
		const refused = errorOf(() => registry.run(action, { characterId: "S1" }));
		assert.equal(refused?.code, "TARGET_NOT_READY");
		assert.equal(refused.message, `${action} measures a take by compiling its motion spec again; Block figure S1's take was installed as a raw track and has no spec to compile, at any scale. motion.sample reads the take's bones at the character's place and scale.`);
	}
	const character = { id: "C1", model: TRACK_RIG, subject: "Cy", x: 1, y: 0, z: 2, rot: 90 }, takes = new Map();
	const owner = { replace: (id, value) => takes.set(id, value), motionFor: id => takes.get(id) ?? null };
	const old = createStudioAppActions({ state: () => ({ characters: [character], objects: [], frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
	const P = sk.restWorldPos, I = sk.index, ank = P[I.LeftFoot][1];
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, keys: [{ f: 0, set: { root: [1, P[I.Hips][1] - 0.01, 2], yaw: 90, foot_l: [1.03, ank, 1.91], foot_r: [0.97, ank, 2.09], fyaw_l: 90, fyaw_r: 90 } }] };
	const compiled = old.run("motion.compile", { characterId: "C1", spec, repair: false });
	assert.equal(typeof old.run("motion.qa", { characterId: "C1" }).output.qa.ok, "boolean", "at scale 1 motion.qa measures a compiled take");
	assert.equal(old.run("motion.report", { characterId: "C1" }).output.specId, compiled.output.specId, "and motion.report reads its report");
	const unit = old.run("motion.sample", { characterId: "C1", frames: [0, 30], bones: ["Head", "LeftHand"] }).output.frames;
	character.scale = 0.8;
	for (const action of ["motion.qa", "motion.report"]) {
		// motion.report holds this spec's report of the scale-1 body: it is not served as the scaled body's
		assert.equal(errorOf(() => old.run(action, { characterId: "C1" }))?.message, `${action} measures a take by compiling its motion spec again, for the body it was made for, at scale 1; Cy is at scale 0.8, so that would not measure the take as it plays. motion.sample reads the take's bones at the character's place and scale.`);
	}
	assert.equal(old.run("motion.report", { specId: compiled.output.specId }).output.specId, compiled.output.specId, "a report asked by specId is that compile's, whatever the body is now");
	assert.equal(errorOf(() => old.run("motion.keyObject", { characterId: "C1", objectId: "x", frame: 3, pos: [0, 0, 0] }))?.code, "INVALID_ARGUMENT", "motion.keyObject refuses an object the take does not move before it looks at the scale");
	const small = old.run("motion.sample", { characterId: "C1", frames: [0, 30], bones: ["Head", "LeftHand"] }).output.frames;
	for (const [i, row] of small.entries()) for (const bone of ["Head", "LeftHand"]) {
		const want = unit[i].bones[bone].map((v, k) => [1, 0, 2][k] + (v - [1, 0, 2][k]) * 0.8);
		assert.ok(Math.hypot(...row.bones[bone].map((v, k) => v - want[k])) < 2e-4, `a compiled take on a body scaled after: ${bone} is 0.8 times as far from the character's place`);
	}
	console.log("ok motion.qa and motion.report: a raw track is refused at scale 1 too, a compiled take's scale-1 report is not served for a scaled body; motion.sample reads it at 0.8");
}

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
	assert.equal(answer.summary, `Sampled ${FRAMES.length} frames.`, "and so is its summary");
	console.log("ok motion.sample at scale 1: the answer of before, byte for byte");
}

// --- a compile's other people are measured at their own scale ---
{
	for (const scale of [0.6, 0.81, 1, 1.3]) {
		const clip = clipAt(scale, [1, 2], 90), { character, take } = studioWith(clip), c = clip.characters[0];
		const scene = { people: peopleOf([character, { id: "me" }], "me", id => (id === "S1" ? take : null)) };
		let worst = 0;
		for (const f of FRAMES) JOINTS.forEach((joint, j) => { const p = personJoint(scene, "S1", joint, f), q = clipJoint(c, f, j); worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); });
		assert.ok(worst < 1e-3, `scale ${scale}: a person's joints are the drawn ones (worst ${(worst * 1000).toFixed(3)} mm)`);
		// its thickness too: each capsule's radius is the rig's times the scale (exactly the rig's, and no scale field, at 1)
		assert.deepEqual(personCapsules(scene.people.S1, 0).map(cap => cap[3]), CAPSULES.map(cap => (scale === 1 ? cap[3] : cap[3] * scale)));
		assert.equal("scale" in scene.people.S1, scale !== 1);
		console.log(`ok people at scale ${scale}: a person's joints within ${(worst * 1000).toFixed(3)} mm of the drawn ones, its capsules ${scale} times the rig's`);
	}
}
console.log("PASS verify-size-read");
