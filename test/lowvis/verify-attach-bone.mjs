#!/usr/bin/env node
// A motion carries any Studio object, keeping its kind, and a prop one bone carries the whole clip rides that bone.
// - studioScene { kinds } (src/lowvis/studio/scene.js) offers an object with no box of its own (an effect, a light, a
//   group's Empty) as a small hollow prop with its kind, a solid small in every side as a prop, and an object attached to
//   a body as attached (no prop); without the flag the scene is as before.
// - installClip (src/lowvis/studio/install.js, attach.js): a cigarette held the whole clip, the smoke effect riding its
//   tip and an exhale effect riding the head are attached to the right hand and the head (object.attach with their place
//   in the bone's frame) and get no track; a lighter moved by its own keys keeps a track. Played as the Studio plays the
//   installed take (the decoded raw track, forward kinematics, the body's scale), each attached object's place and turn
//   are measured against the engine's own pose of its prop on every frame, at scale 1 and 0.81.
// - An object attached earlier that a new clip moves otherwise is detached first; runMotion answers carried and attached.
// - A second motion over the scene the first left: the attached objects are read back in their bones' frames (a point
//   object as one, with its turn), the same motion attaches each at the same numbers, one that puts the cigarette down
//   takes it and its smoke off the hand onto tracks; an object others are grouped under keeps a track; propsSet tells an
//   attached object as attached.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { qMul, qRotate } from "../../src/lowvis/rig17.js";
import { studioScene, POINT } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { ATTACH_BONE_OF, STILL } from "../../src/lowvis/studio/attach.js";
import { TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { fk } from "../../src/motion3/compiler/skeleton.js";
import { quatFromMat } from "../../src/motion3/compiler/math.js";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { propsSetOf } from "../../bin/agent/motion-props.mjs";

const sk = skeletonFor(TRACK_RIG), JOINT_OF_BONE = Object.fromEntries(Object.entries(ATTACH_BONE_OF).map(([joint, bone]) => [bone, joint]));
const DEG = Math.PI / 180, F = 96;
const qXYZ = ({ rotX = 0, rot = 0, rotZ = 0 }) => { const h = [rotX, rot, rotZ].map(v => v * DEG / 2), [cx, cy, cz] = h.map(Math.cos), [sx, sy, sz] = h.map(Math.sin); return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]; };
// between unit quaternions: a clip's are rounded to 5 decimals, which read as up to 0.7 degrees when they are not taken to unit length first
const unit = q => { const n = Math.hypot(...q); return q.map(v => v / n); };
const angle = (a, b) => { const [u, v] = [unit(a), unit(b)]; return 2 * Math.acos(Math.min(1, Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2] + u[3] * v[3]))) / DEG; };
const effect = (id, name, preset, at, extra = {}) => ({ id, name, renderer: "effect", x: at[0], y: at[1], z: at[2], rot: 0, rotX: 0, rotZ: 0, footprint: { width: 0, depth: 0 }, height: 0, effect: { preset }, ...extra });

// --- 1. the scene the motion writer reads ---
const DESCRIBE = {
	characters: [{ id: "a", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }],
	objects: [
		effect("effect", "Tip smoke", "smoke", [0.3, 1, 0.3]),
		effect("effect-2", "Exhale", "exhale", [0, 1.6, 0.1], { rotX: 70 }),
		{ id: "point-light", name: "Lamp", renderer: "light", light: { type: "point" }, x: 2, y: 1.5, z: 0, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 },
		{ id: "empty", name: "Kit", renderer: "empty", x: 1, y: 1, z: 1, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 },
		{ id: "sphere", name: "Ember", renderer: "sphere", parent: "empty", x: 1, y: 1, z: 1, rot: 0, footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.01, scaleY: 0.01, scaleZ: 0.01, glow: { intensity: 4 } },
		effect("effect-3", "Ember smoke", "smoke", [1, 1.01, 1], { parent: "empty" }),
		{ id: "rug", name: "Rug", renderer: "cube", x: 0, y: 0, z: 2, rot: 0, footprint: { width: 2, depth: 1 }, height: 0.01 },
		{ id: "cap", name: "Cap", renderer: "sphere", x: 0, y: 1.7, z: 0, rot: 0, footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.2, scaleY: 0.2, scaleZ: 0.2, attach: { characterId: "a", bone: "head" } },
	],
};
{
	const plain = studioScene(DESCRIBE, { turn: true });
	assert.deepEqual(plain.scene.props.map(p => p.id), [], "without kinds: no point object, no small solid, as before");
	assert.equal(plain.scene.attached?.[0]?.id, "Cap", "an object attached to an offered character is listed as attached");
	const { scene, ids } = studioScene(DESCRIBE, { turn: true, kinds: true });
	assert.deepEqual(scene.props.map(p => [p.id, p.kind ?? "solid"]), [["Tip_smoke", "effect smoke"], ["Exhale", "effect exhale"], ["Lamp", "point light"], ["Kit", "group of sphere, effect smoke"], ["Ember", "solid"]],
		"effects, a light and a group are offered with their kind; a grouped effect rides its group; a 1 cm solid is a prop; a rug is still flat");
	assert.deepEqual(scene.props[0], { id: "Tip_smoke", size: [POINT, POINT, POINT], at: [0.3, 1, 0.3], kind: "effect smoke", hollow: true });
	assert.equal(ids.props.Exhale.point, true);
	assert.ok(angle(ids.props.Exhale.quat, qXYZ({ rotX: 70 })) < 0.1, "a point object's own turn is kept for the install");
	assert.deepEqual(scene.attached, [{ id: "Cap", on: "a", bone: "head", size: [0.2, 0.2, 0.2] }], "an attached solid is listed with its box's size");
	assert.deepEqual(ids.props.Cap.attach, { characterId: "a", bone: "head" });
	assert.equal(ids.props.Kit.group, true, "an object others are grouped under is marked: the install keeps it on a track");
	// a set of 45 crates and 50 lamps: the first 40 crates are offered as without the flag, and the first 40 lamps beside them
	const crate = n => ({ id: `cube-${n}`, name: `Crate ${n}`, renderer: "cube", x: n, y: 0, z: 0, rot: 0, footprint: { width: 0.4, depth: 0.4 }, height: 0.4 });
	const lamp = n => ({ id: `light-${n}`, name: `Lamp ${n}`, renderer: "light", light: { type: "point" }, x: n, y: 2, z: 0, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 });
	const big = { characters: [], objects: Array.from({ length: 95 }, (_, n) => (n % 2 || n >= 90 ? lamp(n) : crate(n))) };
	const [off, on] = [studioScene(big, { turn: true }), studioScene(big, { turn: true, kinds: true })];
	assert.equal(off.scene.props.length, 40);
	assert.deepEqual(on.scene.props.filter(p => !p.kind), off.scene.props, "the solids offered are the ones offered without the flag");
	assert.equal(on.scene.props.filter(p => p.kind).length, 40, "and 40 of the objects with no box beside them");
	console.log("ok studioScene kinds: effects, a light and a group offered with their kind, a 1 cm solid offered, an attached object listed as attached; no light takes a solid's place among the first 40");
}

// --- 2. the install: held throughout and riding throughout -> attached; moved by keys -> a track ---
async function installCase(s) {
	const { scene: studio, ids } = studioScene({ ...DESCRIBE, characters: [{ ...DESCRIBE.characters[0], scale: s }], objects: DESCRIBE.objects.slice(0, 2) }, { turn: true, kinds: true, body: true });
	const scene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }],
		props: [...studio.props.map(p => ({ ...p, moves: true })), { id: "cig", size: [0.0078, 0.0078, 0.084], at: [0.2 * s, 0.85 * s, 0.25 * s], moves: true }, { id: "lighter", size: [0.025, 0.075, 0.013], at: [1, 0.4, 0.5], moves: true }, { id: "table", size: [0.5, 0.36, 0.5], at: [1, 0.18, 0.5] }] };
	const spec = { a: [[0, "hold", { prop: "cig", hand: "R" }], [12, "walk", { to: [0, 1.5] }], [60, "pose", { R: [0.1, 0.45, 0.35], over: 18 }]],
		Tip_smoke: [[0, "ride", { on: "cig", at: [0, 0, 0.042] }]], Exhale: [[0, "ride", { joint: "Head", of: "a", at: [0, -0.06, 0.11] }]], lighter: [[30, "move", { to: [1, 0.6, 0.8], over: 20 }]] };
	const clip = JSON.parse(serializeClip(buildClip(structuredClone({ demo: "x", ...spec }), scene).clip));
	const steps = [], raws = {};
	let n = 0;
	const run = async (action, args) => {
		steps.push([action, args]);
		if (action === "motion.v4.install") raws[args.characterId] = args.raw;
		return { affectedIds: [action === "character.add" ? args.character.id : action === "object.attach" ? args.objectId : `obj-${++n}`] };
	};
	const out = await installClip(clip, run, { existing: ids, turn: true });
	assert.equal(out.ok, true);
	return { clip, out, steps, raws, ids };
}
const pivotOf = (prop, f, point) => { const q = Array.from(prop.quat.slice(f * 4, f * 4 + 4)), down = qRotate(q, [0, point ? 0 : -prop.size[1] / 2, 0]); return { p: [0, 1, 2].map(k => prop.pos[f * 3 + k] + down[k]), q }; };
const report = [];
for (const s of [1, 0.81]) {
	const { clip, out, steps, raws, ids } = await installCase(s);
	const attached = Object.fromEntries(steps.filter(([a]) => a === "object.attach").map(([, args]) => [args.objectId, args]));
	const cigId = out.placed.cig, smokeId = ids.props.Tip_smoke.id, exhaleId = ids.props.Exhale.id;
	assert.deepEqual(Object.fromEntries(Object.entries(attached).map(([id, a]) => [id, `${a.characterId}:${a.bone}`])), { [smokeId]: "a:rightHand", [exhaleId]: "a:head", [cigId]: "a:rightHand" }, `scale ${s}: the held cigarette, its tip smoke and the exhale ride their bones`);
	assert.deepEqual(out.moving, [out.placed.lighter], `scale ${s}: only the lighter, moved by its own keys, has a track`);
	assert.deepEqual(out.attached.map(a => a.id).sort(), [cigId, smokeId, exhaleId].sort());
	const raw = decodeRawTrack(raws.a, sk);
	assert.deepEqual(Object.keys(raw.objects), [out.placed.lighter], "the take holds the lighter's track only");
	// the Studio plays the raw track on the body at its scale: the joints at scale x the unit skeleton's, the bones' turns as they are
	for (const [prop, id, own] of [["cig", cigId, null], ["Tip_smoke", smokeId, ids.props.Tip_smoke.quat], ["Exhale", exhaleId, ids.props.Exhale.quat]]) {
		const a = attached[id], j = sk.index[JOINT_OF_BONE[a.bone]], clipProp = clip.props.find(p => p.id === prop), local = qXYZ(a.local);
		let place = 0, turn = 0;
		for (let f = 0; f < F; f++) {
			const B = raw.bones.length, quats = raw.bones.map((_, b) => Array.from(raw.rot.slice((f * B + b) * 4, (f * B + b) * 4 + 4))), body = fk(sk, quats, Array.from(raw.hips.slice(f * 3, f * 3 + 3)));
			const boneQ = quatFromMat(body.R[j]), boneP = body.P[j].map(v => v * s), off = qRotate(boneQ, [a.local.x, a.local.y, a.local.z]);
			const drawn = { p: boneP.map((v, k) => v + off[k]), q: qMul(boneQ, local) }, want = pivotOf(clipProp, f, Boolean(own));
			if (own) want.q = qMul(want.q, own);
			place = Math.max(place, Math.hypot(...drawn.p.map((v, k) => v - want.p[k])));
			turn = Math.max(turn, angle(drawn.q, want.q));
		}
		report.push({ s, prop, bone: a.bone, mm: +(place * 1000).toFixed(2), deg: +turn.toFixed(3), drift: out.attached.find(x => x.id === id).drift });
		assert.ok(place < 0.1e-3 && turn < 0.05, `scale ${s}: ${prop} drawn on ${a.bone} stays on the engine's pose (worst ${(place * 1000).toFixed(2)} mm, ${turn.toFixed(3)} degrees)`);
		assert.ok(out.attached.find(x => x.id === id).drift.place < STILL.place / 5 && out.attached.find(x => x.id === id).drift.turn < STILL.turn / 5, `scale ${s}: ${prop} is still on its bone well inside the limit`);
	}
}
for (const r of report) console.log(`ok scale ${r.s}: ${r.prop} on ${r.bone}: worst ${r.mm} mm and ${r.deg} degrees from the engine's pose over ${F} frames (drift in the bone's frame ${(r.drift.place * 1000).toFixed(3)} mm, ${r.drift.turn} degrees)`);

// --- 3. an object attached earlier that the new clip moves by keys is detached first, then tracked ---
{
	const ids = { characters: { a: "a" }, props: { cap: { id: "cap-1", x: 0, y: 0, z: 0, rot: 0, attach: { characterId: "a", bone: "head" } } }, switch: [] };
	const scene = { frames: 48, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "cap", size: [0.2, 0.1, 0.2], at: [1, 0.05, 1], moves: true }] };
	const clip = JSON.parse(serializeClip(buildClip({ demo: "x", cap: [[10, "move", { to: [1, 0.05, 2], over: 20 }]], a: [] }, scene).clip));
	const steps = [];
	const out = await installClip(clip, async (action, args) => { steps.push(action); return { affectedIds: [args.objectId ?? "x"] }; }, { existing: ids, turn: true });
	assert.equal(out.ok, true);
	assert.equal(steps[0], "object.detach", "the cap comes off the head before anything else");
	assert.deepEqual(out.moving, ["cap-1"]);
	assert.equal(out.attached, undefined);
	console.log("ok an attached object the new clip moves by keys is detached, then moved by a track");
}

// --- 3b. a second motion over the scene the first one left: the attached objects are read back in their bones' frames ---
{
	const first = await installCase(1), attachedAt = Object.fromEntries(first.steps.filter(([a]) => a === "object.attach").map(([, args]) => [args.objectId, args]));
	// the Studio's rows after the first install: each attached object holds its numbers in its bone's frame
	const onBone = (row, id = row.id) => ({ ...row, ...attachedAt[id].local, attach: { characterId: "a", bone: attachedAt[id].bone } });
	const cigRow = { id: first.out.placed.cig, name: "cig", renderer: "cube", footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.0078, scaleY: 0.0078, scaleZ: 0.084 };
	const after = { characters: DESCRIBE.characters, objects: [onBone(DESCRIBE.objects[0]), onBone(DESCRIBE.objects[1]), onBone(cigRow)] };
	const again = studioScene(after, { turn: true, kinds: true, body: true });
	assert.deepEqual(again.scene.props, [], "the attached objects are no props of the scene");
	assert.deepEqual(again.scene.attached, [{ id: "Tip_smoke", on: "a", bone: "rightHand", kind: "effect smoke" }, { id: "Exhale", on: "a", bone: "head", kind: "effect exhale" }, { id: "cig", on: "a", bone: "rightHand", size: [0.008, 0.008, 0.084] }], "each is told with its bone and its kind or size");
	const rerun = async clip => { const steps = []; const out = await installClip(clip, async (action, args) => { steps.push([action, args]); return { affectedIds: [args.objectId ?? args.id ?? "x"] }; }, { existing: again.ids, turn: true }); assert.equal(out.ok, true); return { steps, out }; };
	// the same motion again: every object rides its bone at the numbers it has, and none is given world numbers
	const same = await rerun(first.clip);
	assert.deepEqual(same.steps.filter(([, args]) => [args.objectId, args.id].some(id => id in attachedAt)).map(([a]) => a), ["object.attach", "object.attach", "object.attach"], "nothing but its attach touches an attached object");
	for (const [, args] of same.steps.filter(([a]) => a === "object.attach")) {
		const was = attachedAt[args.objectId];
		assert.equal(args.bone, was.bone);
		assert.ok(Math.hypot(args.local.x - was.local.x, args.local.y - was.local.y, args.local.z - was.local.z) < 1e-5 && angle(qXYZ(args.local), qXYZ(was.local)) < 0.01, `${args.objectId} rides ${args.bone} at the same place and turn as before (an effect keeps its box's centre and its own turn)`);
	}
	// the cigarette put on a table: it and the smoke on its tip come off the hand, get their place and whole turn in the world and a track; the exhale stays on the head
	const scene = { frames: F, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "Tip_smoke", size: [POINT, POINT, POINT], at: [0.3, 1, 0.3], moves: true }, { id: "Exhale", size: [POINT, POINT, POINT], at: [0, 1.6, 0.1], moves: true }, { id: "cig", size: [0.0078, 0.0078, 0.084], at: [0.2, 0.85, 0.25], moves: true }, { id: "table", size: [0.5, 0.7, 0.5], at: [0, 0.35, 0.75] }] };
	const spec = { demo: "x", a: [[0, "hold", { prop: "cig", hand: "R" }], [30, "place", { prop: "cig", at: [0, 0.704, 0.6], over: 30 }]], Tip_smoke: [[0, "ride", { on: "cig", at: [0, 0, 0.042] }]], Exhale: [[0, "ride", { joint: "Head", of: "a", at: [0, -0.06, 0.11] }]] };
	const clip = JSON.parse(serializeClip(buildClip(spec, scene).clip)), down = await rerun(clip), smoke = clip.props.find(p => p.id === "Tip_smoke");
	assert.deepEqual(down.steps.filter(([a]) => a === "object.detach").map(([, args]) => args.objectId), ["effect", cigRow.id], "the smoke and the cigarette come off the hand");
	assert.deepEqual(down.out.moving.sort(), ["effect", cigRow.id].sort());
	assert.deepEqual(down.out.attached.map(a => `${a.id}:${a.bone}`), ["effect-2:head"]);
	const patch = down.steps.find(([a, args]) => a === "object.update" && args.id === "effect")[1].patch;
	assert.ok(Math.hypot(patch.x - smoke.pos[0], patch.y - smoke.pos[1], patch.z - smoke.pos[2]) < 1e-6, "the smoke stands at its box's centre (a point object, read back as one)");
	assert.ok(["rotX", "rot", "rotZ"].every(k => Number.isFinite(patch[k])), "with its whole turn");
	console.log("ok a second motion over attached objects: the same motion attaches each at the same numbers; one that puts the cigarette down takes it and its smoke off the hand onto tracks");
}

// --- 3c. an object others are grouped under keeps a track: its parts go with a track and would stay behind a bone ---
{
	const { scene: studio, ids } = studioScene({ characters: DESCRIBE.characters, objects: DESCRIBE.objects.slice(3, 6) }, { turn: true, kinds: true });
	const scene = { frames: 48, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: studio.props.map(p => ({ ...p, moves: true })) };
	const clip = JSON.parse(serializeClip(buildClip({ demo: "x", a: [[5, "walk", { to: [0, 1] }]], Kit: [[0, "ride", { joint: "RightHand", of: "a", at: [0, 0, 0] }]] }, scene).clip));
	const out = await installClip(clip, async (action, args) => ({ affectedIds: [args.objectId ?? "x"] }), { existing: ids, turn: true });
	assert.deepEqual([out.moving, out.attached], [["empty"], undefined], "the group rides the hand on a track");
	console.log("ok a group carried by one bone keeps its track");
}

// --- 4. runMotion: the request shows the kinds and the attached objects; the answer names carried and attached ---
{
	const { clip, ids } = await installCase(1);
	void ids;
	let request = null;
	const describe = { characters: DESCRIBE.characters, objects: [...DESCRIBE.objects.slice(0, 2), DESCRIBE.objects.at(-1)] };
	const done = await runMotion({ words: "he smokes", memoryKey: null, hub: { command: async () => describe }, workspaceHandle: "ws", env: {},
		invoke: async (action, args) => ({ affectedIds: [action === "character.add" ? args.character.id : args.objectId ?? `obj-${action}`] }),
		deps: { studioScene, installClip, runScene: async options => { request = options.request; return { wallMs: 0, compiles: 1, report: "Done.\nMissing: none", missing: "none", final: { clip: "c.json", scene: {}, spec: {} } }; }, readClip: () => clip } });
	assert.match(request, /"kind":"effect smoke","hollow":true/, "the scene JSON gives the effect's kind");
	assert.match(request, /These objects ride a bone of a character \(attached in the Studio[^]*Cap \(size \[0\.2,0\.2,0\.2\]\) on a's head/, "the attached cap is told, with its size and its bone");
	assert.match(request, /A new prop is only ever a plain box, ball or line, never an object of another kind/);
	assert.deepEqual(done.carried, [{ id: "effect", kind: "effect smoke" }, { id: "effect-2", kind: "effect exhale" }]);
	assert.deepEqual(done.attached.map(a => `${a.id}:${a.bone}`).sort(), ["effect-2:head", "effect:rightHand", "obj-object.add:rightHand"].sort());
	assert.equal(/effect/.test(done.used ?? ""), false, "the effects are not boxes the body meets: used does not name them");
	console.log("ok runMotion: the kinds and the attached cap reach the writer; carried and attached reach the agent");
}
// --- 5. propsSet (what the install set since the draft): an attached stand-in is told as attached, with no numbers of its bone's frame as a place ---
{
	const row = (id, name, at, extra = {}) => [id, { id, name, renderer: "cube", x: at[0], y: at[1], z: at[2], rot: 0, footprint: { width: 1, depth: 1 }, height: 1, scaleX: 0.01, scaleY: 0.01, scaleZ: 0.084, ...extra }];
	const onHand = { attach: { characterId: "a", bone: "rightHand" } }, done = { objectIds: ["new-1"], moved: ["was-1", "off-1"], attached: [{ id: "cube-1", characterId: "a", bone: "rightHand" }, { id: "new-1", characterId: "a", bone: "rightHand" }, { id: "was-1", characterId: "a", bone: "head" }] };
	const lines = propsSetOf({ props: ["cig", "pen", "cap", "cup"].map(id => ({ id })), placed: { cig: "cube-1", pen: "new-1", cap: "was-1", cup: "off-1" }, done, plan: { drafted: { cig: { id: "cube-1", untouched: true } } },
		start: new Map([row("was-1", "cap", [1, 0, 1]), row("off-1", "cup", [-0.1, 0.04, 0], onHand)]), at: new Map([row("cube-1", "cig", [0.2, 0.85, 0.25])]),
		now: new Map([row("cube-1", "cig", [-0.108, 0.04, 0.004], onHand), row("new-1", "pen", [-0.1, 0.03, 0], onHand), row("was-1", "cap", [0, 0.1, 0], { attach: { characterId: "a", bone: "head" } }), row("off-1", "cup", [0.5, 0.7, 0.6])]) });
	assert.deepEqual(lines, [
		"cig (cube-1), the draft's stand-in of cig: now attached to a's rightHand, which carries it the whole motion.",
		"pen (new-1): the motion added it as a stand-in, 0.01 x 0.01 x 0.08 m, attached to a's rightHand, which carries it the whole motion; the draft did not have it.",
		"cap (was-1): the motion attached it to a's head, which carries it the whole motion.",
		"cup (off-1): the motion took it off a's rightHand: 0.01 x 0.01 x 0.08 m, base [0.5, 0.7, 0.6].",
	], "an attached object's numbers are its bone's: none is told as a place in the scene");
	console.log("ok propsSet: an attached stand-in, an attached scene object and one taken off its bone are told as such");
}
console.log("PASS verify-attach-bone");
