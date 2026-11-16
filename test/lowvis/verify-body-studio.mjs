#!/usr/bin/env node
// A body's size and colour between the motion writer and the Studio: one pair of fields, the cast member's own
// `scale` and `tint` (src/scenes.js createCharacterEntry, src/studio-elements.js).
//  - studioScene reads them into the scene the motion writer gets (src/lowvis/studio/scene.js)
//  - installClip sets what the clip says through character.add / character.update, and nothing when nothing is said
//  - the take of a sized body (studio/take.js, motion-v4/track) plays where the clip has its joints, through the real
//    motion.v4.install; a take of another scale than the character's is refused
//  - runMotion and the motion tool tell which scale and tint each body got; a later change of an animated character's
//    scale answers with motionFit.bodies (bin/agent/motion-fit.mjs)
//  - the block figure is drawn at the character's scale and in its tint (studio/skin-pose.js, looks/block.js)
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { JOINTS, JOINT_COUNT, REST } from "../../src/lowvis/rig17.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { TRACK_RIG, clipTrack } from "../../src/lowvis/studio/take.js";
import { followBones } from "../../src/lowvis/studio/skin-pose.js";
import { LOOKS, sizedLook } from "../../src/lowvis/looks/index.js";
import { encodeRawTrack, decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { placedTake, rawOut } from "../../src/motion-v4/track/literal.js";
import * as motionV4 from "../../src/motion-v4/editor/install-action.js";
import { takeOut } from "../../src/motion3/physics-frames.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { createCharacterEntry } from "../../src/scenes.js";
import { elementByPath } from "../../src/studio-elements.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { bodyFitOf, turnFitView } from "../../bin/agent/motion-fit.mjs";

const sk = skeletonFor(TRACK_RIG);
const errorOf = run => { try { run(); return null; } catch (error) { return error; } };
// a clip of the engine: c1 at scale 0.5 in a tint, n as the engine makes a body with nothing said
const SCENE = { frames: 72, characters: [{ id: "c1", at: [0, 0], heading: 0, scale: 0.5, tint: "#112233" }, { id: "n", at: [1.5, 0.5], heading: 90 }], props: [] };
const SPEC = { demo: "x", c1: [[0, "walk", { to: [0.4, 0.9] }], [48, "pose", { R: [-0.1, 0.2, 0.15] }]], n: [[0, "idle"], [10, "turn", { heading: 0 }]] };
const clipOf = scene => JSON.parse(serializeClip(buildClip(structuredClone(SPEC), scene).clip));
const CLIP = clipOf(SCENE), PLAIN_CLIP = clipOf({ ...SCENE, characters: SCENE.characters.map(({ scale: _s, tint: _t, ...c }) => c) });
/** The worst distance (m) between the 17 joints of clip character c and the frames of a take's out (takeOut, rawOut). */
function worstOff(out, c, F) {
	let worst = 0;
	for (let f = 0; f < F; f++) JOINTS.forEach((joint, j) => {
		const p = out.frames[f].s.P[sk.index[joint]], q = c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3);
		worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
	});
	return worst;
}
function recorder() {
	const calls = [];
	return { calls, names: () => calls.map(c => c.action), run: async (action, args) => { calls.push({ action, args }); return { affectedIds: [action === "character.add" ? args.character.id : args.characterId] }; } };
}

// --- the fields are the Studio's own ---
{
	assert.ok(elementByPath("character.scale") && elementByPath("character.tint"), "scale and tint are fields of a Studio character");
	const entry = createCharacterEntry({ id: "x", model: TRACK_RIG, scale: 0.5, tint: "#112233" });
	assert.deepEqual([entry.scale, entry.tint], [0.5, "#112233"], "a cast member keeps them as given");
	const describe = { characters: [{ id: "c1", model: TRACK_RIG, x: 1, z: 2, rot: 90, scale: 0.8, tint: "#aa3311" }, { id: "c2", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale: 1, tint: null }, { id: "cap", model: "proxy-figure", x: 0, z: 0, rot: 0, scale: 1.4 }], objects: [] };
	const { scene, ids } = studioScene(describe, { body: true });
	assert.deepEqual(scene.characters, [{ id: "c1", at: [1, 2], heading: 90, scale: 0.8, tint: "#aa3311" }, { id: "c2", at: [0, 0], heading: 0 }], "a character at another scale is offered with its scale and tint; one at the defaults has neither field");
	assert.deepEqual(ids.bodies, { c1: { scale: 0.8, tint: "#aa3311" }, c2: { scale: 1, tint: null } });
	assert.deepEqual(scene.others, [{ id: "cap", why: "box figure" }], "the stand-in figure is named as every other text names it, at any scale");
	const before = studioScene(describe);
	assert.deepEqual(before.scene.others, [{ id: "c1", why: "scale 0.8" }, { id: "cap", why: "box figure" }], "without the body step a character at another scale stands as it is, as before");
	assert.deepEqual(before.scene.characters, [{ id: "c2", at: [0, 0], heading: 0 }]);
	assert.equal(before.ids.bodies, undefined);
	console.log("ok studioScene { body }: a character's scale and tint are read from its own fields");
}

// --- installClip: what the clip says is set through the Studio's own actions; nothing said, nothing set ---
{
	const fresh = recorder(), out = await installClip(CLIP, fresh.run);
	assert.deepEqual(fresh.names(), ["character.add", "motion.v4.install", "character.add", "motion.v4.install"]);
	const { x: _x, z: _z, rot: _rot, ...added } = fresh.calls[0].args.character;
	assert.deepEqual(added, { id: "lowvis-c1", model: TRACK_RIG, scale: 0.5, tint: "#112233" }, "a new character is added at the said scale and tint");
	assert.deepEqual(Object.keys(fresh.calls[2].args.character), ["id", "model", "x", "z", "rot"], "one with nothing said is added as before: no scale, no tint");
	assert.deepEqual(out.bodies, [{ id: "lowvis-c1", scale: 0.5, tint: "#112233" }], "the result names the bodies it set");
	assert.equal(fresh.calls[1].args.raw.scale, 0.5, "its take is of a body of that scale");
	assert.equal("scale" in fresh.calls[3].args.raw, false, "the other's take has no scale field");
	// nothing said at all: the actions and the result of before
	const plain = recorder(), same = await installClip(PLAIN_CLIP, plain.run);
	assert.deepEqual(plain.calls.filter(c => c.action === "character.add").map(c => Object.keys(c.args.character)), [["id", "model", "x", "z", "rot"], ["id", "model", "x", "z", "rot"]]);
	assert.deepEqual(same, { characterIds: ["lowvis-c1", "lowvis-n"], objectIds: [], switched: [], placed: {}, ok: true }, "and the result has no bodies field");
	// a character the Studio has: only what differs from its own fields is set, before the take goes in
	const existing = bodies => ({ characters: { c1: "S1", n: "S2" }, props: {}, switch: [], bodies });
	const other = recorder(), set = await installClip(CLIP, other.run, { existing: existing({ S1: { scale: 0.8, tint: "#aa3311" }, S2: { scale: 1, tint: null } }) });
	assert.deepEqual(other.names(), ["character.update", "character.clearWaypoints", "motion.v4.install", "character.clearWaypoints", "motion.v4.install"]);
	assert.deepEqual(other.calls[0].args, { characterId: "S1", patch: { scale: 0.5, tint: "#112233" } });
	assert.deepEqual(set.bodies, [{ id: "S1", scale: 0.5, tint: "#112233" }]);
	const kept = recorder(), none = await installClip(CLIP, kept.run, { existing: existing({ S1: { scale: 0.5, tint: "#112233" }, S2: { scale: 1, tint: null } }) });
	assert.deepEqual(kept.names(), ["character.clearWaypoints", "motion.v4.install", "character.clearWaypoints", "motion.v4.install"], "a character that already has the clip's body is not touched");
	assert.equal("bodies" in none, false);
	const back = recorder();
	await installClip(PLAIN_CLIP, back.run, { existing: existing({ S1: { scale: 0.8, tint: "#aa3311" }, S2: { scale: 1, tint: null } }) });
	assert.deepEqual(back.calls[0].args, { characterId: "S1", patch: { scale: 1 } }, "a clip of a body at scale 1 on a character at 0.8 sets its scale to 1; a tint the clip does not have stays");
	console.log("ok installClip: scale and tint go through character.add and character.update; nothing said, nothing set");
}

// --- the take of a sized body plays where the clip has its joints ---
{
	const c = CLIP.characters[0], F = CLIP.frameCount, track = clipTrack(CLIP, 0), encoded = encodeRawTrack(track), raw = decodeRawTrack(encoded, sk);
	assert.equal(raw.scale, 0.5);
	assert.ok(Math.abs(track.hips[1] * 0.5 - c.pos[1]) < 1e-6, "the track holds the unit skeleton's motion: its hips are the clip's divided by the scale");
	assert.ok(worstOff(rawOut(raw, []), c, F) < 1e-4, "the track's own frames are the clip's joints");
	// the placed take, read as the Studio's readers read it (takeOut) for a character standing anywhere
	const take = placedTake(raw, { position: [1.5, 0, -2], yaw: 40 });
	assert.equal(take.scale, 0.5);
	const worst = worstOff(takeOut(take, []), c, F);
	assert.ok(worst < 1e-4, `the placed take's joints are the clip's within 0.1 mm (worst ${(worst * 1000).toFixed(4)} mm)`);
	// as the rig plays it: the take's hips are in the rig's own units, which the character's scale multiplies
	const yaw = 40 * Math.PI / 180, h = [take.hips[0] * 0.5, take.hips[1] * 0.5, take.hips[2] * 0.5];
	const world = [1.5 + Math.cos(yaw) * h[0] + Math.sin(yaw) * h[2], h[1], -2 - Math.sin(yaw) * h[0] + Math.cos(yaw) * h[2]];
	assert.ok(Math.hypot(world[0] - c.pos[0], world[1] - c.pos[1], world[2] - c.pos[2]) < 1e-5, "placement + turn x (scale x the take's hips) is the clip's Hips joint");
	// an unsized character: the encoded track and the placed take have no scale field (the bytes of before)
	const plain = encodeRawTrack(clipTrack(PLAIN_CLIP, 0));
	assert.deepEqual(Object.keys(plain), ["schema", "rig", "fps", "frames", "bones", "rot", "hips", "objects"]);
	assert.equal("scale" in placedTake(decodeRawTrack(plain, sk), { position: [1, 0, 2], yaw: 10 }), false);
	assert.throws(() => decodeRawTrack({ ...encoded, scale: 0 }, sk), /RAW_TRACK_INVALID: scale/);

	// through the real motion.v4.install: on a character at the take's scale; another scale is refused with both numbers
	const takes = new Map(), character = { id: "S1", model: TRACK_RIG, subject: "", x: 1, y: 0, z: 2, rot: 90, scale: 0.5 };
	const ports = { state: () => ({ characters: [character], objects: [], frameCount: 300 }), storeDomain: name => (name === "motion" ? { replace: (id, value) => takes.set(id, value), motionFor: id => takes.get(id) ?? null } : null) };
	const registry = createStudioAppActions(ports, { motionV4 });
	registry.run("motion.v4.install", { characterId: "S1", raw: encoded, label: "walk" });
	assert.ok(worstOff(takeOut(takes.get("S1"), []), c, F) < 1e-4, "installed on the character at scale 0.5, the take's joints are the clip's");
	character.scale = 1;
	const refused = errorOf(() => registry.run("motion.v4.install", { characterId: "S1", raw: encoded }));
	assert.equal(refused?.code, "TARGET_NOT_READY");
	assert.match(refused.message, /take is of a body of scale 0\.5 and the character's scale is 1/, "a take of another scale than the character's is refused, with both");
	character.scale = 2;
	assert.equal(errorOf(() => registry.run("motion.v4.install", { characterId: "S1", raw: plain }))?.message, "Set the character's scale back to 1 before installing motion.", "a take with no scale on a scaled character: the refusal of before");
	console.log(`ok take: a body at scale 0.5 plays within ${(worst * 1000).toFixed(4)} mm of the clip; a take of another scale than the character's is refused`);
}

// --- runMotion: the scene's bodies go to the motion writer, the clip's to the Studio, the result names them ---
const DESCRIBE = { characters: [{ id: "c1", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale: 0.8, tint: "#aa3311" }], objects: [] };
function harness({ clip, describe = DESCRIBE }) {
	const seen = { runs: [], actions: [] };
	const deps = { studioScene, installClip, readClip: () => clip,
		runScene: async options => { seen.runs.push(options); return { wallMs: 1000, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "clip.json", scene: { characters: [], props: [] }, spec: {} } }; } };
	const invoke = async (action, args) => { seen.actions.push({ action, args }); return { affectedIds: [] }; };
	return { seen, base: { hub: { command: async () => describe }, workspaceHandle: "ws", invoke, env: {}, deps } };
}
{
	const { seen, base } = harness({ clip: CLIP }), set = [];
	const done = await runMotion({ ...base, words: "the small one walks", memoryKey: "conv-body", onBodies: list => set.push(list) });
	const request = seen.runs[0].request, scene = JSON.parse(request.split("\n").find(line => line.startsWith("{\"characters\"")));
	assert.deepEqual(scene.characters, [{ id: "c1", at: [0, 0], heading: 0, scale: 0.8, tint: "#aa3311" }], "the motion writer reads the scale and tint the Studio holds");
	assert.ok(request.includes("A character's scale and tint are the Studio character's own scale and tint: the ones your scene gives are set on it, one it leaves out stays as the Studio has it."));
	assert.deepEqual(seen.runs[0].bodies, { c1: { scale: 0.8, tint: "#aa3311" } }, "and the tool knows them for a scene that leaves them out");
	assert.deepEqual(seen.actions.find(a => a.action === "character.update").args, { characterId: "c1", patch: { scale: 0.5, tint: "#112233" } }, "what the clip says is set on the Studio's character");
	assert.deepEqual(done.bodies, [{ id: "c1", scale: 0.5, tint: "#112233" }, { id: "lowvis-n", scale: 1, tint: null }], "the result names the scale and tint each animated character got");
	assert.deepEqual(done.bodiesSet, [{ id: "c1", scale: 0.5, tint: "#112233" }], "and bodiesSet what this motion set: the new character with nothing said is not in it");
	assert.deepEqual(set, [done.bodiesSet], "onBodies: once, with what the install set");

	// a later edit of that character: its scale against the motion's
	const value = { sessionId: "conv-body", context: { host: { workspaceHandle: "ws" } } }, tool = answer => ({ name: "run_action", handler: async () => answer });
	const fit = scale => turnFitView({ value, env: {}, hub: { command: async () => ({ characters: [{ id: "c1", scale }], objects: [] }) }, delayMs: 0 }).tools([tool({ ok: true, affectedIds: ["c1"] })])[0].handler({});
	assert.deepEqual((await fit(1.2)).motionFit, { fits: false, bodies: [{ id: "c1", differs: ["scale 1.2, the motion's 0.5: the take plays 2.4 times as large about the character's place"] }] }, "a scale that is no longer the motion's is told");
	assert.deepEqual(await fit(0.5), { ok: true, affectedIds: ["c1"] }, "at the motion's scale the edit's answer is as it is");
	assert.deepEqual(bodyFitOf({ scale: 1 }, { scale: 1 }), []);
	console.log("ok runMotion: the Studio's bodies reach the motion writer, the clip's reach the Studio, the result and motionFit name them");
}
{
	const plain = { characters: [{ id: "c1", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale: 1, tint: null }], objects: [] };
	const { seen, base } = harness({ clip: PLAIN_CLIP, describe: plain }), set = [];
	const done = await runMotion({ ...base, words: "he walks", memoryKey: null, onBodies: list => set.push(list) });
	assert.ok(!("bodies" in done) && !("bodiesSet" in done), "nothing said and default bodies: the result has no bodies or bodiesSet field");
	assert.equal("bodies" in seen.runs[0], false);
	assert.deepEqual(set, []);
	assert.deepEqual(seen.actions.map(a => a.action), ["character.clearWaypoints", "motion.v4.install", "character.add", "motion.v4.install"], "and the install is the one of before");
	// the body step off: a character at another scale stands as it is and the request has no word of scale or tint
	const off = harness({ clip: PLAIN_CLIP });
	await runMotion({ ...off.base, env: { COZYCLAY_MOTION_OFF: "body" }, words: "he walks", memoryKey: null });
	assert.ok(off.seen.runs[0].request.includes("These characters cannot be animated by the engine and stand as they are: c1 (scale 0.8)."));
	assert.ok(!off.seen.runs[0].request.includes("tint") && !("bodies" in off.seen.runs[0]) && off.seen.runs[0].off.includes("body"));
	console.log("ok runMotion: nothing said, the result and the install of before; the body step off, a scaled character is not animated");
}

// --- the motion tool: bodies in its answer, and one progress line when a scale or tint was set ---
{
	const DONE = { report: "Done.\nMissing: none", missing: "none", frames: 72, clipSeconds: 3, tookSeconds: 31, compiles: 1, characterIds: ["c1"], objectIds: [], switched: [] };
	const door = run => createMotionDoor({ run, mark: async () => null, rollback: async () => null });
	const frames = [], answer = await door(async ({ onCompile, onBodies }) => { onCompile({ n: 1, ok: true, line: "motion 1: ok" }); onBodies([{ id: "c1", scale: 0.5, tint: "#112233" }, { id: "c2", tint: "#445566" }]); return { ...DONE, bodies: [{ id: "c1", scale: 0.5, tint: "#112233" }], bodiesSet: [{ id: "c1", scale: 0.5, tint: "#112233" }, { id: "c2", tint: "#445566" }] }; })
		.handler({ request: "the small one walks" }, { toolCallId: "call-1", emit: frame => frames.push(frame) });
	assert.deepEqual([answer.bodies, answer.bodiesSet], [[{ id: "c1", scale: 0.5, tint: "#112233" }], [{ id: "c1", scale: 0.5, tint: "#112233" }, { id: "c2", tint: "#445566" }]]);
	assert.deepEqual(frames.map(f => [f.type, f.name, f.index, f.summary]), [["tool.progress", "motion", 1, "compile 1"], ["tool.progress", "motion", 2, "bodiesSet c1 scale 0.5 tint #112233, c2 tint #445566"]]);
	const plainFrames = [], plain = await door(async ({ onCompile }) => { onCompile({ n: 1, ok: true, line: "motion 1: ok" }); return DONE; }).handler({ request: "he walks" }, { toolCallId: "call-2", emit: frame => plainFrames.push(frame) });
	assert.ok(!("bodies" in plain) && !("bodiesSet" in plain) && !JSON.stringify(plain).includes("bodiesSet"));
	assert.deepEqual(plainFrames.map(f => f.summary), ["compile 1"], "no bodiesSet line when nothing was set");
	assert.match(door(async () => DONE).description, /bodies names each animated character's scale and tint/);
	console.log("ok motion tool: bodies and bodiesSet in the answer; a `bodiesSet ...` progress line only when the install set a scale or a tint");
}

// --- the block figure: as large as the character, in its tint ---
{
	const s = 0.5, bones = JOINTS.map((name, j) => { const bone = new THREE.Object3D(); bone.name = name; bone.position.set(REST[j][0] * s + 2, REST[j][1] * s, REST[j][2] * s - 1); return bone; });
	const scene = new THREE.Scene(), body = LOOKS.block({ tint: "#c9b7a4", colour: "#112233" });
	scene.add(...bones, body.object3D);
	const undo = followBones(body, bones, s), at = new THREE.Vector3(), size = new THREE.Vector3();
	scene.updateMatrixWorld();
	body.object3D.children.forEach((joint, j) => assert.ok(joint.getWorldPosition(at).distanceTo(bones[j].position) < 1e-6, `${JOINTS[j]} of the figure is on its bone`));
	const tall = new THREE.Box3().setFromObject(body.object3D).getSize(size).y, full = new THREE.Box3().setFromObject(LOOKS.block({}).object3D).getSize(size).y;
	assert.ok(Math.abs(tall / full - s) < 0.01, `the figure is ${s} times as tall (${tall.toFixed(3)} m of ${full.toFixed(3)} m)`);
	const colours = look => { const set = new Set(); look.object3D.traverse(node => { if (node.isMesh) set.add(node.material.color.getHexString()); }); return set; };
	assert.ok(colours(body).has("112233"), "its body has the character's tint");
	assert.ok(!colours(LOOKS.block({ tint: "#112233" })).has("112233"), "a character with no tint of its own keeps the blockout grey (leaning toward the default tint)");
	undo();
	assert.equal(body.object3D.scale.x, 1, "undo gives the look its own size back");
	// the viewer's look of a clip character: the same, from the clip's arrays
	const look = sizedLook(LOOKS.block({ colour: CLIP.characters[0].tint }), CLIP.characters[0].scale), c = CLIP.characters[0];
	look.setPose(c.pos, c.quat, 30);
	look.object3D.updateMatrixWorld(true);
	look.object3D.children.forEach((joint, j) => assert.ok(joint.getWorldPosition(at).distanceTo(new THREE.Vector3(...c.pos.slice((30 * JOINT_COUNT + j) * 3, (30 * JOINT_COUNT + j) * 3 + 3))) < 1e-5, `${JOINTS[j]} of the viewer's figure is where the clip has it`));
	console.log(`ok block figure: on its bones at scale ${s}, ${tall.toFixed(2)} m tall, in the character's tint`);
}
console.log("PASS verify-body-studio");
