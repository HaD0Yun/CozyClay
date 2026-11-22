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

const sk = skeletonFor(TRACK_RIG), JOINT_OF_BONE = Object.fromEntries(Object.entries(ATTACH_BONE_OF).map(([joint, bone]) => [bone, joint]));
const DEG = Math.PI / 180, F = 96;
const qXYZ = ({ rotX = 0, rot = 0, rotZ = 0 }) => { const h = [rotX, rot, rotZ].map(v => v * DEG / 2), [cx, cy, cz] = h.map(Math.cos), [sx, sy, sz] = h.map(Math.sin); return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]; };
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) / DEG;
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
	assert.deepEqual(scene.attached, [{ id: "Cap", on: "a", bone: "head" }]);
	assert.deepEqual(ids.props.Cap.attach, { characterId: "a", bone: "head" });
	console.log("ok studioScene kinds: effects, a light and a group offered with their kind, a 1 cm solid offered, an attached object listed as attached");
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
		report.push({ s, prop, bone: a.bone, mm: +(place * 1000).toFixed(2), deg: +turn.toFixed(2), drift: out.attached.find(x => x.id === id).drift });
		assert.ok(place < 0.5e-3 + STILL.place && turn < STILL.turn + 0.05, `scale ${s}: ${prop} drawn on ${a.bone} stays on the engine's pose (worst ${(place * 1000).toFixed(2)} mm, ${turn.toFixed(2)} degrees)`);
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
	assert.match(request, /These objects ride a bone of a character \(attached in the Studio[^]*Cap on a's head/, "the attached cap is told, with its bone");
	assert.match(request, /A new prop is only ever a plain box or ball, never an object of another kind/);
	assert.deepEqual(done.carried, [{ id: "effect", kind: "effect smoke" }, { id: "effect-2", kind: "effect exhale" }]);
	assert.deepEqual(done.attached.map(a => `${a.id}:${a.bone}`).sort(), ["effect-2:head", "effect:rightHand", "obj-object.add:rightHand"].sort());
	assert.equal(/effect/.test(done.used ?? ""), false, "the effects are not boxes the body meets: used does not name them");
	console.log("ok runMotion: the kinds and the attached cap reach the writer; carried and attached reach the agent");
}
console.log("PASS verify-attach-bone");
