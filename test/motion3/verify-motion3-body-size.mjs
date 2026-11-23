#!/usr/bin/env node
// motion.compile is made for the body the character stands as (src/commands/motion3-scale.js): its scale times its
// look's body. Under the default look (cube, 0.943 of the rig's body) a new character at scale 1 compiles without a
// scale change, and the take plays in that size:
//  - a walk keeps the feet on the floor, at body 0.943 and 1.1316 as at the rig's own body
//  - a cup picked off a table: the hand meets the cup and the cup is lifted, at the same places in the world
//  - the take keeps its numbers in the rig's own size and carries the size it was made for (take.scale); motion.sample
//    reads it where the stage draws it; motion.qa and motion.report measure it; resized after, they say why they do not
//  - at the rig's own body (the block look, or a 3.2.3 character carried to 1.060445) the take is the one of before
//  - a sized take saved as its source and compiled back (a scene reload) is the same take, bytes and size
//  - a rig registered at one size changes nothing at the rig's own: compiled at 1, at 0.943 and at 1 again, the first and
//    the third take are the same bytes
//  - a key that names a pose is fitted to the body the character stands as
//  - frame_shot's held-shot reader compiles the take for the body it was made for: its camera looks at the middle of the
//    joints the stage draws
import assert from "node:assert/strict";
import { createStudioAppActions } from "../../src/commands/index.js";
import { lookBody } from "../../src/lowvis/studio/figure.js";
import { SCENE_OBJECTS, CUP } from "./fixtures/cup-scene.mjs";
import { takeSource, normalizeTakeSource, compileTakeSource } from "../../src/domains/motion/take-source.js";
import { resolveOverShot } from "../../src/commands/shot-held.js";
import { takeOut } from "../../src/motion3/physics-frames.js";

assert.equal(lookBody(), 0.943, "nothing named at launch: the cube look, 0.943 of the rig's body");

function studio(character, objects = []) {
	const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
	const registry = createStudioAppActions({ state: () => ({ characters: [character], objects, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
	return { run: (id, args) => { const r = registry.run(id, args); return r?.output ?? r; }, take: () => takes.get(character.id), character };
}
const refusal = fn => { try { fn(); return null; } catch (error) { return error; } };
const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const sameTake = (a, b) => bytes(a.rot).equals(bytes(b.rot)) && bytes(a.hips).equals(bytes(b.hips)) && Object.keys(a.objects).every(id => Object.keys(a.objects[id]).every(k => bytes(a.objects[id][k]).equals(bytes(b.objects[id][k]))));
/** What a scene file keeps of a take and gives back on load (domains/motion.js): its source through JSON, compiled again. */
const reloaded = (take, objects) => compileTakeSource(normalizeTakeSource(JSON.parse(JSON.stringify(takeSource(take, objects)))));
const FEET = ["LeftToeBase", "RightToeBase", "LeftFoot", "RightFoot"];

// --- a walk: the feet on the floor ---
const walk = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 120, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 90 } }], generators: [{ type: "walk", f0: 10, steps: 6, heading: [90, 90] }] };
const walked = {};
for (const [name, scale] of [["rig", 1 / 0.943], ["cube 1", 1], ["cube 1.2", 1.2]]) {
	const s = studio({ id: "w", model: "x-bot-tpose", subject: "Walker", x: 0, y: 0, z: 0, rot: 90, scale });
	const out = s.run("motion.compile", { characterId: "w", spec: walk, repair: false });
	assert.equal(out.frames, 120, `${name}: compiled`);
	const body = scale * 0.943, take = s.take();
	if (Math.abs(body - 1) < 1e-6) assert.ok(!("scale" in take), `${name}: a take of the rig's own body carries no size`);
	else assert.equal(take.scale, body, `${name}: the take carries the size it was made for`);
	const rows = [0, 60].flatMap(from => s.run("motion.sample", { characterId: "w", frames: Array.from({ length: 60 }, (_, f) => from + f), bones: FEET }).frames);
	const low = FEET.slice(0, 2).map(b => Math.min(...rows.map(r => r.bones[b][1]))), lowest = Math.min(...rows.flatMap(r => FEET.map(b => r.bones[b][1])));
	const hips0 = s.run("motion.sample", { characterId: "w", frames: [0], bones: ["Hips"] }).frames[0].bones.Hips[1];
	const travel = s.run("motion.sample", { characterId: "w", frames: [119], bones: ["Hips"] }).frames[0].bones.Hips[0];
	walked[name] = { body, low, lowest, hips0, travel };
	const again = reloaded(take, []);
	assert.ok(sameTake(take, again) && (again.scale ?? 1) === (take.scale ?? 1) && again.rig === take.rig, `${name}: the take saved and loaded is the same take, of the same size`);
	// the ball of each foot comes down to the floor (the X Bot's sole is at its ToeBase joint) and nothing sinks under it
	for (const v of low) assert.ok(Math.abs(v) <= 0.01, `${name}: a foot's ball on the floor within 10 mm (${(v * 1000).toFixed(1)} mm)`);
	assert.ok(lowest >= -0.01, `${name}: no foot joint under the floor past 10 mm (${(lowest * 1000).toFixed(1)} mm)`);
	console.log(`ok walk, body ${body.toFixed(4)}: balls of the feet at ${low.map(v => (v * 1000).toFixed(1)).join(" / ")} mm, hips ${hips0.toFixed(3)} m, ${travel.toFixed(2)} m walked`);
}
assert.ok(Math.abs(walked["cube 1"].hips0 / walked.rig.hips0 - 0.943) < 0.01, "the hips stand 0.943 times as high as the rig's body");

// --- one size leaves the rig's own alone: compiled at 1, at 0.943, at 1 again ---
{
	const once = scale => { const s = studio({ id: "w", model: "x-bot-tpose", subject: "Walker", x: 0, y: 0, z: 0, rot: 90, scale }); s.run("motion.compile", { characterId: "w", spec: walk, repair: false }); return s.take(); };
	const first = once(1 / 0.943), sized = once(1), third = once(1 / 0.943);
	assert.ok(sameTake(first, third) && !sameTake(first, sized), "the rig's own take is the same bytes before and after a compile at another size");
	console.log("ok no size leaks into the rig's own: compiled at 1, 0.943, 1: the first and third takes are the same bytes");
}

// --- a key that names a pose is fitted to the body ---
{
	const posed = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 40, keys: [{ f: 0, pose: "stand" }, { f: 39, pose: "stand" }] }, at = {};
	for (const [name, scale] of [["rig", 1 / 0.943], ["cube 1", 1], ["cube 1.2", 1.2]]) {
		const s = studio({ id: "p", model: "x-bot-tpose", subject: "Poser", x: 0, y: 0, z: 0, rot: 0, scale });
		s.run("motion.compile", { characterId: "p", spec: posed, repair: false });
		const b = s.run("motion.sample", { characterId: "p", frames: [20], bones: ["Hips", "LeftToeBase"] }).frames[0].bones;
		at[name] = { hips: b.Hips[1], ball: b.LeftToeBase[1] };
		assert.ok(Math.abs(b.LeftToeBase[1]) <= 0.002, `${name}: the standing pose has the ball of the foot on the floor (${(b.LeftToeBase[1] * 1000).toFixed(1)} mm)`);
	}
	for (const [name, body] of [["cube 1", 0.943], ["cube 1.2", 1.1316]]) assert.ok(Math.abs(at[name].hips / at.rig.hips - body) < 0.005, `${name}: the pose's hips stand ${body} times as high as on the rig's body (${at[name].hips.toFixed(3)} against ${at.rig.hips.toFixed(3)} m)`);
	console.log(`ok a named pose fits the body: hips ${Object.entries(at).map(([name, v]) => `${name} ${v.hips.toFixed(3)} m`).join(", ")}`);
}

// --- frame_shot over: "shot" reads the take for the body it was made for ---
{
	const s = studio({ id: "w", model: "x-bot-tpose", subject: "Walker", x: 0, y: 0, z: 0, rot: 90, scale: 1 });
	s.run("motion.compile", { characterId: "w", spec: walk, repair: false });
	const take = s.take(), raw = { characters: [s.character], objects: [], frameCount: 120, view: { frame: 0 }, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 }, camera: { focalMm: 35 } };
	const shot = { id: "held", startFrame: 0, endFrame: 119, cameraKeys: [] }, args = { subjectIds: ["w"], over: "shot", shotId: "held", framing: { intent: { size: "wide shot", level: "eye", view: "front", side: "left", focalMm: 35 } } };
	/** How far the held camera's look-at is from the middle of the joints `drawn` holds over the frames it sampled (fitAt: the middle of their bounds). */
	const off = (of, drawn) => {
		const held = resolveOverShot(args, { raw, shots: [shot], ports: { state: () => raw, storeDomain: () => ({ motionFor: () => of }) } });
		const points = held.held.frames.flatMap(f => drawn.frames[f].s.P.filter(Boolean)), mid = i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2, look = held.args.framing.exact.lookAt;
		return Math.hypot(look.x - mid(0), look.y - mid(1), look.z - mid(2));
	};
	const drawn = takeOut(take, []), now = off(take, drawn), { scale: _made, ...unsized } = take, before = off(unsized, drawn);
	assert.ok(now <= 0.002, `the held camera looks at the middle of the body as drawn, within 2 mm (${(now * 1000).toFixed(1)} mm)`);
	assert.ok(before > 0.03, `read as a take of the rig's own body it looked ${(before * 1000).toFixed(1)} mm off`);
	console.log(`ok frame_shot over: "shot" on a take made for body 0.943: look-at ${(now * 1000).toFixed(1)} mm from the middle of the drawn joints (${(before * 1000).toFixed(1)} mm when the take is compiled again on the rig's own body)`);
}

// --- a cup off a table: the hand meets the cup, at the same places in the world ---
const GRAB = 34, RELEASE = 80;
const cupSpec = {
	schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100,
	use: [{ skill: "standIdle", args: { at: [0.15, 0.3], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } },
	anchors: { cupHandle: { kind: "object", object: "cube-6", local: [0, 0.03, 0] } },
	fits: [{ side: "l", anchor: "cupHandle", effector: { prop: "grip", point: "fingers" } }],
	keys: [{ f: 10, set: { pitch: 0, armw_l: 0, w_cupHandle_l: 0 } },
		{ f: 30, set: { pitch: 25, armw_l: 1, w_cupHandle_l: 1, hand_l: [0.3, 1, 0.7] } },
		{ f: 36, set: { w_cupHandle_l: 1, pitch: 25, hand_l: [0.3, 1, 0.7] } },
		{ f: 60, set: { w_cupHandle_l: 0, pitch: 10, hand_l: [0.3, 1.2, 0.6] } }, { f: 99, set: {} }],
	objects: { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE } },
	goals: [{ name: "cup lifted", moved: `object:${CUP.group}`, by: 0.1, at: [65, 75] }],
};
const probes = [{ name: "handToCup", distance: ["joint:lefthand", `object:${CUP.group}`], frames: [20, 40] }];
const cups = {};
for (const [name, scale] of [["rig", 1 / 0.943], ["cube 1", 1]]) {
	const s = studio({ id: "c", model: "x-bot-tpose", subject: "Cupper", x: 0, y: 0, z: 0, rot: 0, scale }, SCENE_OBJECTS);
	const out = s.run("motion.compile", { characterId: "c", spec: cupSpec, probes, repair: false });
	const reach = out.probes.handToCup, grabs = out.qa.groups.filter(g => g.kind === "GRAB").length;
	const hand = s.run("motion.sample", { characterId: "c", frames: [GRAB], bones: ["LeftHandMiddle2"] }).frames[0].bones.LeftHandMiddle2;
	const handle = SCENE_OBJECTS.find(o => o.id === "cube-6"), off = Math.hypot(hand[0] - handle.x, hand[1] - (handle.y + 0.03), hand[2] - handle.z);
	cups[name] = { goal: out.qa.goals[0].ok, min: reach.min, grabs, off };
	assert.ok(sameTake(s.take(), reloaded(s.take(), SCENE_OBJECTS)), `${name}: the cup take saved and loaded is the same take, the cup's track with it`);
	console.log(`ok cup, body ${(scale * 0.943).toFixed(4)}: lifted ${cups[name].goal}, GRAB groups ${grabs}, hand to cup ${reach.min.toFixed(3)} m, fingers ${(off * 1000).toFixed(1)} mm from the handle anchor at the grab`);
	// the reads that measure by compiling measure the take as it plays; resized after, they say why they do not
	assert.equal(typeof s.run("motion.qa", { characterId: "c" }).qa.ok, "boolean", `${name}: motion.qa measures the take`);
	assert.equal(s.run("motion.report", { characterId: "c" }).specId, out.specId, `${name}: motion.report reads its report`);
	s.character.scale = scale * 1.25;
	for (const action of ["motion.qa", "motion.report"]) assert.match(refusal(() => s.run(action, { characterId: "c" }))?.message ?? "", new RegExp(`^${action.replace(".", "\\.")} measures a take by compiling its motion spec again, for the body it was made for, at scale ${Math.round(scale * 1e6) / 1e6}; Cupper is at scale`));
}
// the cube body meets the cup as the rig's body does (the rig's body is main's: the same code, the same take)
assert.equal(cups["cube 1"].goal, cups.rig.goal, "the cup is lifted at the cube body as at the rig's");
assert.equal(cups.rig.goal, true, "the cup is lifted");
assert.ok(cups["cube 1"].grabs <= cups.rig.grabs, "no more GRAB groups at the cube body");
assert.ok(cups["cube 1"].min <= cups.rig.min + 0.01 && cups["cube 1"].off <= cups.rig.off + 0.01, "the hand comes as close to the cup and its handle as at the rig's body, within 10 mm");

console.log(`PASS verify-motion3-body-size: ${JSON.stringify({ walked, cups })}`);
