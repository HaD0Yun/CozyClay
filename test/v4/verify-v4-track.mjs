#!/usr/bin/env node
// v4 track component (design 3.2): the raw track codec, the TrackStore, the literal compile (rawOut, placedTake),
// motion.v4.install through the real action registry, save and reload (take-source + compileRawSource), the bench
// take.json (rawTakeJson) and the track tool over a fake context.
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { restState, rotateSubtree, toLocal, fk } from "../../src/motion3/compiler/skeleton.js";
import { add, sub, apply, axisRot, ry, quatFromMat } from "../../src/motion3/compiler/math.js";
import { takeOut } from "../../src/motion3/physics-frames.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { takeSource, normalizeTakeSource } from "../../src/domains/motion/take-source.js";
import { encodeRawTrack, decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { rawOut, placedTake, compileRawSource } from "../../src/motion-v4/track/literal.js";
import { createTrackStore } from "../../src/motion-v4/track/store.js";
import { rawTakeJson } from "../../src/motion-v4/track/take-json.js";
import * as motionV4 from "../../src/motion-v4/editor/install-action.js";
import { createTrackTool } from "../../bin/agent/v4/track-tool.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const errorOf = run => { try { run(); return null; } catch (error) { return error; } };
const rejection = async run => { try { await run(); return null; } catch (error) { return error; } };
const now = () => performance.now();
const bytes = values => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
const sameBytes = (a, b) => a.length === b.length && bytes(a).every((v, i) => v === bytes(b)[i]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const matErr = (A, B) => Math.max(...A.flatMap((row, i) => row.map((v, j) => Math.abs(v - B[i][j]))));

const sk = skeletonFor("y-bot-tpose"), B = sk.names.length, I = sk.index;

// ---- fixtures (the bench builder's rules, design 3.2, written out so nothing imports the bench) ----
const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
const BARBELL = [
	{ ...base, id: "barbell", name: "Barbell", renderer: "empty", x: 0, y: 0.225, z: 0.35, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, footprint: { width: 0, depth: 0 }, height: 0, supportY: 0 },
	{ ...base, id: "barbell-bar", name: "Barbell bar", renderer: "cylinder", x: -1, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.028, scaleY: 2, scaleZ: 0.028, parent: "barbell" },
	{ ...base, id: "barbell-plate-l", name: "Barbell plate left", renderer: "cylinder", x: 0.77, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
	{ ...base, id: "barbell-plate-r", name: "Barbell plate right", renderer: "cylinder", x: -0.83, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
];
const BARBELL_SET_OBJECTS = [
	{ id: "barbell", shape: "group", mass: 60 },
	{ id: "barbell-bar", shape: "cylinder", axis: "x", size: [2, 0.028, 0.028], parent: "barbell" },
	{ id: "barbell-plate-l", shape: "cylinder", axis: "x", size: [0.06, 0.45, 0.45], parent: "barbell" },
	{ id: "barbell-plate-r", shape: "cylinder", axis: "x", size: [0.06, 0.45, 0.45], parent: "barbell" },
];
const PARTS = ["barbell-bar", "barbell-plate-l", "barbell-plate-r"];
const crateAt = (cx, cy, cz, sx, sy, sz) => ({ ...base, id: "crate", name: "Crate", renderer: "cube", x: cx, y: cy - sy / 2, z: cz, scaleX: sx, scaleY: sy, scaleZ: sz, parent: null });
const CRATE = crateAt(1.5, 0.25, 1, 0.5, 0.5, 0.5);
const SCENE = [...BARBELL, CRATE];

/** A world-frame RawTrack from world states, the way the rig library writes one (toLocal; fk reads it back). */
function rawFrom(states, objects = {}) {
	const F = states.length, rot = new Float32Array(F * B * 4), hips = new Float32Array(F * 3);
	states.forEach((s, f) => { const { quats, hips: h } = toLocal(sk, s); quats.forEach((q, b) => rot.set(q, (f * B + b) * 4)); hips.set(h, f * 3); });
	return { schema: "cozyclay.take.v3", fps: 24, frameCount: F, rig: sk.model, bones: sk.names.slice(), rot, hips, objects,
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: F } };
}

/** 12 rest frames, then a squat: thighs forward, shins back, feet flat, the body lowered so the ankles stay put. */
function squatStates(F = 48) {
	const out = [];
	for (let f = 0; f < F; f++) {
		const s = restState(sk), a = f < 12 ? 0 : 70 * Math.sin(Math.PI * (f - 12) / (F - 13));
		for (const side of ["Left", "Right"]) {
			rotateSubtree(sk, s, I[`${side}UpLeg`], s.P[I[`${side}UpLeg`]], axisRot([1, 0, 0], -a));
			rotateSubtree(sk, s, I[`${side}Leg`], s.P[I[`${side}Leg`]], axisRot([1, 0, 0], 2 * a));
			rotateSubtree(sk, s, I[`${side}Foot`], s.P[I[`${side}Foot`]], axisRot([1, 0, 0], -a));
		}
		const dy = sk.restWorldPos[I.LeftFoot][1] - s.P[I.LeftFoot][1];
		s.P = s.P.map(p => add(p, [0, dy, 0]));
		out.push(s);
	}
	return out;
}

/** World pose track: pos(f) and quat(f) for F frames. */
function poseTrack(F, pos, quat = () => [0, 0, 0, 1]) {
	const p = new Float32Array(F * 3), q = new Float32Array(F * 4);
	for (let f = 0; f < F; f++) { p.set(pos(f), f * 3); q.set(quat(f), f * 4); }
	return { pos: p, quat: q };
}
const ROOT = [0, 0.225, 0.35];
const liftTrack = F => poseTrack(F, () => add(ROOT, [0, 1, 0]));

/** fk of raw frame f: the raw world frames. */
const worldOf = (raw, f) => fk(sk, sk.names.map((_, b) => Array.from(raw.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4))), Array.from(raw.hips.subarray(f * 3, f * 3 + 3)));
/** Largest joint position and rotation error of take out `out` against the raw world frames. */
function worldError(out, raw) {
	let p = 0, r = 0;
	for (let f = 0; f < raw.frameCount; f++) {
		const s = worldOf(raw, f), o = out.frames[f].s;
		for (let b = 0; b < B; b++) { p = Math.max(p, dist(o.P[b], s.P[b])); r = Math.max(r, matErr(o.R[b], s.R[b])); }
	}
	return { p, r };
}

const squat = rawFrom(squatStates());
const F = squat.frameCount;
const lifted = { ...squat, objects: { barbell: liftTrack(F) } };

// ---- 1. codec ----
{
	const encoded = encodeRawTrack(lifted), back = decodeRawTrack(encoded, sk);
	expect("codec: rot, hips and object tracks round trip byte-exact", sameBytes(back.rot, lifted.rot) && sameBytes(back.hips, lifted.hips)
		&& sameBytes(back.objects.barbell.pos, lifted.objects.barbell.pos) && sameBytes(back.objects.barbell.quat, lifted.objects.barbell.quat));
	expect("codec: encode(decode(x)) gives the same JSON", JSON.stringify(encodeRawTrack(back)) === JSON.stringify(encoded));
	expect("codec: the decoded track is a world-frame take v3", back.schema === "cozyclay.take.v3" && back.frameCount === F && back.fps === 24
		&& JSON.stringify(back.placement) === JSON.stringify({ position: [0, 0, 0], yaw: 0 }) && back.spec.frames === F && back.bones.join() === sk.names.join());
	expect("codec: base64 of little-endian Float32 bytes", encoded.rot === Buffer.from(bytes(new Float32Array(lifted.rot))).toString("base64") && encoded.hips === Buffer.from(bytes(lifted.hips)).toString("base64"));
	const odd = { ...squat, hips: new Float32Array(squat.hips) };
	odd.hips[0] = -0; odd.hips[1] = Math.fround(1e-40); odd.hips[2] = 3.4e38;
	expect("codec: -0, a subnormal and a large float keep their bits", sameBytes(decodeRawTrack(encodeRawTrack(odd), sk).hips, odd.hips) && Object.is(decodeRawTrack(encodeRawTrack(odd), sk).hips[0], -0));
	for (const n of [1, 2, 3, 4, 5]) {
		const tiny = { ...squat, frameCount: 1, rot: squat.rot.slice(0, B * 4), hips: new Float32Array([n / 7, 0.1, -0.2]), objects: { o: { pos: new Float32Array(3).fill(n), quat: new Float32Array([0, 0, 0, 1]) } } };
		expect(`codec: 1-frame track ${n} round trips (every padding case)`, sameBytes(decodeRawTrack(encodeRawTrack(tiny), sk).hips, tiny.hips));
	}
	const nan = { ...squat, hips: new Float32Array(squat.hips) }; nan.hips[5] = NaN;
	const inf = { ...squat, rot: new Float32Array(squat.rot) }; inf.rot[9] = Infinity;
	const swapped = { ...encoded, bones: [encoded.bones[1], encoded.bones[0], ...encoded.bones.slice(2)] };
	const cases = [
		["wrong schema", { ...encoded, schema: "cozyclay.raw-track.v0" }, /RAW_TRACK_INVALID: schema/],
		["wrong rig", { ...encoded, rig: "x-bot-tpose" }, /RAW_TRACK_INVALID: rig/],
		["bones out of rig order", swapped, /RAW_TRACK_INVALID: bones/],
		["bytes that do not match frames", { ...encoded, frames: F + 1 }, /RAW_TRACK_INVALID: rot has \d+ bytes/],
		["an object track of the wrong length", { ...encoded, objects: { barbell: { ...encoded.objects.barbell, quat: encoded.hips } } }, /RAW_TRACK_INVALID: objects\.barbell\.quat has/],
		["a NaN", encodeRawTrack(nan), /RAW_TRACK_INVALID: hips\[5\] is not a finite number/],
		["an infinite value", encodeRawTrack(inf), /RAW_TRACK_INVALID: rot\[9\] is not a finite number/],
		["text that is not base64", { ...encoded, hips: "@@@@" }, /RAW_TRACK_INVALID: hips is not base64/],
		["frames that are not a count", { ...encoded, frames: 0 }, /RAW_TRACK_INVALID: frames/],
	];
	for (const [what, value, pattern] of cases) { const error = errorOf(() => decodeRawTrack(value, sk)); expect(`codec: ${what} throws RAW_TRACK_INVALID with its reason`, pattern.test(error?.message ?? ""), error?.message); }
	const big = rawFrom(Array.from({ length: 368 }, (_, f) => squatStates(48)[f % 48]));
	let t = now(); const bigEncoded = encodeRawTrack(big); const encodeMs = now() - t;
	t = now(); decodeRawTrack(bigEncoded, sk); const decodeMs = now() - t;
	const size = JSON.stringify(bigEncoded).length;
	console.log(`  codec 368 frames: ${(size / 1024).toFixed(0)} KB JSON (${(size / 368).toFixed(0)} B/frame), encode ${encodeMs.toFixed(1)} ms, decode ${decodeMs.toFixed(1)} ms`);
	expect("codec: a 368-frame take is about 0.5 MB and codes fast", size < 600_000 && encodeMs < 500 && decodeMs < 500, `${size} B, ${encodeMs} / ${decodeMs} ms`);
}

// ---- 2. store ----
const payload = (raw, objects = {}) => ({ frames: raw.frameCount, rot: Array.from(raw.rot), hips: Array.from(raw.hips), objects });
const plainTrack = track => ({ pos: Array.from(track.pos), quat: Array.from(track.quat) });
const fakeCtx = (records = SCENE, runAction = async () => ({ receiptId: "r-fake" })) => ({ sk, character: { id: "char-a", model: "y-bot-tpose", position: [0, 0, 0], yaw: 0 }, records: async () => records, studio: { runAction } });
{
	const store = createTrackStore(fakeCtx());
	expect("store: empty at revision 0, not dirty", store.revision === 0 && store.dirty === false && store.current() === null && store.info().frames === 0);
	expect("store: out() is null without a track", (await store.out()) === null);
	const doubled = payload(squat);
	doubled.rot = doubled.rot.map(v => v * 2);
	const answer = store.set(doubled);
	expect("store: set answers { revision, frames } and makes it dirty", answer.revision === 1 && answer.frames === F && store.revision === 1 && store.dirty === true, JSON.stringify(answer));
	const got = store.get();
	expect("store: set normalizes quaternions; get returns what was set", got.from === 0 && got.to === F - 1 && got.bones.length === B && got.rot.length === F * B * 4
		&& got.rot.every((v, i) => Math.abs(v - squat.rot[i]) < 1e-6) && got.hips.every((v, i) => v === squat.hips[i]));
	const before = store.current(), beforeRot = new Float32Array(before.rot);
	const bones = ["LeftArm", "RightArm", "Head"], q = quatFromMat(axisRot([0, 0, 1], 40));
	const rot = Array.from({ length: 10 * 3 }, () => q).flat(), hips = Array.from({ length: 10 }, () => [0.1, 0.8, 0.2]).flat();
	const patched = store.patch({ from: 10, to: 19, bones, rot, hips });
	const after = store.current();
	expect("store: patch answers { revision, from, to, bones }", patched.revision === 2 && patched.from === 10 && patched.to === 19 && patched.bones.join() === bones.join(), JSON.stringify(patched));
	const part = store.get({ from: 10, to: 19, bones });
	expect("store: get of the patched range returns the patch", part.rot.length === 120 && part.rot.every((v, i) => Math.abs(v - rot[i]) < 1e-6) && part.hips.every((v, i) => Math.abs(v - hips[i]) < 1e-6));
	let untouched = true;
	for (let f = 0; f < F; f++) for (let b = 0; b < B; b++) {
		const inPatch = f >= 10 && f <= 19 && bones.includes(sk.names[b]);
		for (let k = 0; k < 4; k++) if (!inPatch && after.rot[(f * B + b) * 4 + k] !== before.rot[(f * B + b) * 4 + k]) untouched = false;
	}
	expect("store: patch leaves every other bone and frame alone", untouched);
	expect("store: patch makes a NEW RawTrack and never changes the old arrays", after !== before && after.rot !== before.rot && sameBytes(before.rot, beforeRot) && before.hips[30] === squat.hips[30]);
	expect("store: revision counts set and patch, dirty until a commit", store.revision === 2 && store.dirty && store.info().revision === 2 && store.info().committed === 0);
	const lengthErrors = [
		["set rot too short", () => store.set({ ...payload(squat), rot: [0, 0, 0, 1] }), /track set: rot has 4 numbers; 48 frames x 65 bones x 4 = 12480/],
		["set hips of the wrong length", () => store.set({ ...payload(squat), hips: [0, 1, 0] }), /track set: hips has 3 numbers; 48 frames x 3 = 144/],
		["set object quat of the wrong length", () => store.set(payload(squat, { crate: { pos: Array(F * 3).fill(0), quat: [0, 0, 0, 1] } })), /objects\.crate\.quat has 4 numbers/],
		["set without frames", () => store.set({ rot: [], hips: [] }), /frames must be an integer/],
		["patch rot of the wrong length", () => store.patch({ from: 0, to: 9, bones, rot: rot.slice(4) }), /track patch: rot has 116 numbers; 10 frames \(f0-f9\) x 3 bones x 4 = 120/],
		["patch past the last frame", () => store.patch({ from: 40, to: 48, hips: Array(27).fill(0) }), /to 48 is past the last frame 47/],
		["patch with from after to", () => store.patch({ from: 9, to: 2, hips: [] }), /from 9 is after to 2/],
		["patch of an unknown bone", () => store.patch({ from: 0, to: 0, bones: ["LeftElbow"], rot: [0, 0, 0, 1] }), /unknown bone LeftElbow; valid bones: Hips, Spine/],
		["a zero quaternion", () => store.set({ ...payload(squat), rot: Array(F * B * 4).fill(0) }), /zero quaternion at frame 0 Hips/],
		["a value that is not a number", () => store.set({ ...payload(squat), hips: Array(F * 3).fill(NaN) }), /hips\[0\] is not a finite number/],
	];
	for (const [what, run, pattern] of lengthErrors) { const error = errorOf(run); expect(`store: ${what} is an error`, pattern.test(error?.message ?? ""), error?.message); }
	expect("store: a refused call keeps the track and the revision", store.revision === 2 && store.current() === after);
	await store.out();
	const ghost = errorOf(() => store.set(payload(squat, { ghost: plainTrack(liftTrack(F)) })));
	expect("store: an unknown record id is refused once the records are known", /unknown object ghost; the scene records are barbell, barbell-bar/.test(ghost?.message ?? ""), ghost?.message);
	const cleared = store.clear();
	expect("store: clear drops the track and counts a revision", cleared.revision === 3 && store.current() === null && (await store.out()) === null && store.dirty);
	expect("store: get, patch and commit without a track say so", /no track yet: call track set first/.test(errorOf(() => store.get())?.message) && /no track yet/.test((await rejection(() => store.commit()))?.message));
	const fresh = createTrackStore(fakeCtx());
	fresh.set(payload(squat, { ghost: plainTrack(liftTrack(F)) }));
	expect("store: with records not loaded yet, commit checks the record ids", /track commit: unknown object ghost/.test((await rejection(() => fresh.commit()))?.message ?? "") && fresh.dirty);
	const refused = createTrackStore(fakeCtx(SCENE, async () => ({ ok: false, code: "TARGET_BUSY", message: "The user is mid-gesture." })));
	refused.set(payload(squat));
	expect("store: a receipt with ok false is a failed commit", /track commit: The user is mid-gesture/.test((await rejection(() => refused.commit()))?.message ?? "") && refused.dirty);
	const long = rawFrom(Array.from({ length: 368 }, (_, f) => squatStates(48)[f % 48])), longPayload = payload(long);
	const t = now();
	fresh.set(longPayload);
	const setMs = now() - t;
	console.log(`  store set 368 frames (${longPayload.rot.length + longPayload.hips.length} numbers) ${setMs.toFixed(1)} ms`);
	expect("store: a 368-frame set is fast", setMs < 500 && fresh.current().frameCount === 368, `${setMs} ms`);
}

// ---- 3. literal compile: rawOut and QA ----
{
	let t = now();
	const out = rawOut(squat, SCENE);
	const outMs = now() - t;
	const ref = takeOut(squat, SCENE);
	let same = out.frames.length === F;
	for (let f = 0; f < F && same; f++) for (let b = 0; b < B; b++) if (dist(out.frames[f].s.P[b], ref.frames[f].s.P[b]) !== 0 || matErr(out.frames[f].s.R[b], ref.frames[f].s.R[b]) !== 0) same = false;
	expect("rawOut: frames equal takeOut of the same take", same);
	expect("rawOut: equals the raw world frames (fk)", worldError(out, squat).p < 1e-9);
	expect("rawOut: diag and c on every frame; takeOut's cached out is left alone", out.frames.every(fr => fr.diag && fr.c) && ref.frames[0].diag === undefined);
	expect("rawOut: static objects equal takeOut's boxes", JSON.stringify(out.objectsAt(5)) === JSON.stringify(ref.objectsAt(5)) && Object.keys(out.objectsAt(0)).length === 4);
	expect("rawOut: ctx.objectsAt is objectsAt, ctx.spec is the raw spec", out.ctx.objectsAt === out.objectsAt && out.ctx.spec === squat.spec && out.ctx.sk === sk);
	expect("rawOut: cached per (raw, records)", rawOut(squat, SCENE) === out && rawOut(squat, BARBELL) !== out);
	t = now();
	let qa = null, error = null;
	try { qa = runMotionQa(sk, out, out.ctx.spec, { explain: false }); } catch (caught) { error = caught; }
	const qaMs = now() - t;
	expect("rawOut: runMotionQa runs on it", qa && typeof qa.total === "number" && Array.isArray(qa.groups), error?.stack);
	console.log(`  rawOut ${F} frames ${outMs.toFixed(1)} ms; runMotionQa ${qaMs.toFixed(1)} ms, ${qa?.total} issues in ${qa?.groups?.length} groups (${(qa?.groups ?? []).map(g => g.kind).slice(0, 6).join(" ")})`);
}

// ---- 4. object tracks: a group moves its parts, a body its box ----
{
	const turn = f => (f < 24 ? [0, 0, 0, 1] : [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
	const raw = { ...squat, objects: { barbell: poseTrack(F, () => add(ROOT, [0, 1, 0]), turn), crate: poseTrack(F, f => [1.5 + f / 100, 0, 1]) } };
	const out = rawOut(raw, SCENE), rest = out.ctx.scene.objects;
	let up = 0, turned = 0, crate = 0, R = 0;
	for (let f = 0; f < F; f++) {
		const boxes = out.objectsAt(f);
		for (const id of PARTS) {
			const want = f < 24 ? add(rest[id].pos, [0, 1, 0]) : add(add(ROOT, [0, 1, 0]), apply(ry(90), sub(rest[id].pos, ROOT)));
			if (f < 24) { up = Math.max(up, dist(boxes[id].pos, want)); R = Math.max(R, matErr(boxes[id].R, rest[id].R)); } else turned = Math.max(turned, dist(boxes[id].pos, want));
		}
		crate = Math.max(crate, dist(boxes.crate.pos, [1.5 + f / 100, 0, 1]));
	}
	expect("group track: every part box moves 1 m up with the barbell root", up < 1e-6 && R < 1e-6, `${up} ${R}`);
	expect("group track: a 90 degree turn of the root turns every part about it", turned < 1e-6, String(turned));
	expect("body track: the crate box stands where its own track puts it", crate < 1e-6, String(crate));
	expect("object tracks: objectsAt clamps the frame and keeps half sizes", out.objectsAt(500)["barbell-bar"].pos[1] === out.objectsAt(F - 1)["barbell-bar"].pos[1] && out.objectsAt(3)["barbell-bar"].half[1] === 1);
}

// ---- 5. install through the real registry ----
const takes = new Map();
const owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const character = { id: "char-a", model: "y-bot-tpose", subject: "a person", x: 1, y: 0, z: 2, rot: 90, scale: 1 };
const ports = { state: () => ({ characters: [character], objects: SCENE, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) };
const registry = createStudioAppActions(ports, { motionV4 });
const liftedEncoded = encodeRawTrack(lifted);
let installed;
{
	const row = registry.list().find(entry => entry.id === "motion.v4.install");
	expect("install: registered as a hidden mutation with a 60 s timeout", row?.agentHidden === true && row.kind === "mutation" && row.timeoutMs === 60000 && row.available === true, JSON.stringify(row));
	const receipt = registry.run("motion.v4.install", { characterId: "char-a", raw: liftedEncoded, label: "squat" });
	expect("install: answers affectedIds, summary and frames", receipt.affectedIds.join() === "char-a" && receipt.summary === `Installed raw take: ${F} frames.` && receipt.output.frames === F && JSON.stringify(receipt).length < 8192, JSON.stringify(receipt));
	installed = takes.get("char-a");
	expect("install: the take carries frames, the placement and the encoded track at spec.raw", installed?.schema === "cozyclay.take.v3" && installed.frames === F && installed.frameCount === F
		&& JSON.stringify(installed.placement) === JSON.stringify({ position: [1, 0, 2], yaw: 90 }) && JSON.stringify(installed.spec.raw) === JSON.stringify(liftedEncoded) && installed.spec.label === "squat" && installed.prompt === "squat"
		&& installed.spec.schema === "cozyclay.motion-spec.v1" && installed.spec.frames === F);
	const err = worldError(takeOut(installed, SCENE), lifted);
	console.log(`  install: world error of the placed take ${err.p.toExponential(2)} m, rotation ${err.r.toExponential(2)}`);
	expect("install: takeOut of the placed take equals the raw world frames within 1e-5 m", err.p < 1e-5 && err.r < 1e-5, JSON.stringify(err));
	expect("install: every non-Hips bone keeps its raw bytes", (() => { for (let f = 0; f < F; f++) for (let b = 1; b < B; b++) for (let k = 0; k < 4; k++) if (installed.rot[(f * B + b) * 4 + k] !== lifted.rot[(f * B + b) * 4 + k]) return false; return true; })());
	expect("install: object tracks stay world tracks", sameBytes(installed.objects.barbell.pos, lifted.objects.barbell.pos) && installed.objects.barbell.world.length === F && installed.objects.barbell.world.every(v => v === 1));
	const atZero = placedTake(lifted, { position: [0, 0, 0], yaw: 0 });
	expect("placedTake: at the origin the take is the raw track byte for byte", sameBytes(atZero.rot, lifted.rot) && sameBytes(atZero.hips, lifted.hips));
	const refusal = (args, mutate) => { const old = { ...character }; mutate?.(); const error = errorOf(() => registry.run("motion.v4.install", args)); Object.assign(character, old); return error; };
	const scaled = refusal({ characterId: "char-a", raw: liftedEncoded }, () => { character.scale = 2; });
	expect("install: a scaled character is refused", scaled?.code === "TARGET_NOT_READY" && /scale/.test(scaled.message), scaled?.message);
	const stale = refusal({ characterId: "char-z", raw: liftedEncoded });
	expect("install: an unknown character is refused", stale?.code === "STALE_TARGET", stale?.message);
	const bad = refusal({ characterId: "char-a", raw: { ...liftedEncoded, rig: "x-bot-tpose" } });
	expect("install: a raw track for another rig is refused with its reason", bad?.code === "INVALID_ARGUMENT" && /RAW_TRACK_INVALID: rig/.test(bad.message), bad?.message);
	const missing = refusal({ characterId: "char-a" });
	expect("install: raw is required", missing?.code === "INVALID_ARGUMENT", missing?.message);
	expect("install: a refusal leaves the installed take", takes.get("char-a") === installed);
}

// ---- 6. save and reload ----
{
	const saved = { ...takeSource(installed, SCENE), takeId: "t1" };
	const source = normalizeTakeSource(JSON.parse(JSON.stringify(saved)));
	expect("reload: normalizeTakeSource(takeSource(...)) keeps spec.raw", source?.spec?.raw?.rot === liftedEncoded.rot && source.spec.raw.objects.barbell.pos === liftedEncoded.objects.barbell.pos && source.takeId === "t1");
	let t = now();
	const compiled = compileRawSource(source);
	const ms = now() - t;
	expect("reload: compileRawSource gives the installed rot and hips bytes", sameBytes(compiled.rot, installed.rot) && sameBytes(compiled.hips, installed.hips), `${ms} ms`);
	expect("reload: frames, placement, spec and object tracks come back", compiled.frames === F && compiled.frameCount === F && JSON.stringify(compiled.placement) === JSON.stringify(installed.placement)
		&& compiled.spec.raw.rot === liftedEncoded.rot && compiled.prompt === "squat" && sameBytes(compiled.objects.barbell.quat, installed.objects.barbell.quat) && compiled.objects.barbell.world.every(v => v === 1));
	expect("reload: a source without raw is not this hook's", compileRawSource({ ...source, spec: { schema: "cozyclay.motion-spec.v1", frames: 10 } }) === null && compileRawSource({ ...source, rig: "nope" }) === null);
	console.log(`  reload: compileRawSource ${ms.toFixed(1)} ms`);
}

// ---- 7. bench take.json ----
const docWith = take => JSON.parse(JSON.stringify({ app: "cozyclay", kind: "project", version: 5, scenes: { version: 5, activeSceneId: "s1", scenes: [{ id: "s1", objects: BARBELL,
	stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 1, y: 0, z: 2, rot: 90, scale: 1, motionTake: { ...takeSource(take, BARBELL), takeId: "t1" } }] } }] } }));
const at = m => [m[3], m[7], m[11]];
const rot3 = m => [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
{
	let t = now();
	const take = rawTakeJson(docWith(installed), { characterId: "char-a", objects: BARBELL_SET_OBJECTS, source: { set: "deadlift" } });
	const ms = now() - t;
	const rows = take.characters["char-a"]?.bones ?? [];
	expect("take.json: version 0, 24 fps, frames, 65 mixamorig bones", take.version === 0 && take.fps === 24 && take.frames === F && take.rig.name === "y-bot-tpose"
		&& take.rig.bones.length === 65 && take.rig.bones.every((n, i) => n === `mixamorig:${sk.names[i]}`));
	expect("take.json: 65 row-major 4x4 bone matrices per frame", rows.length === F && rows.every(fr => fr.length === 65 && fr.every(m => m.length === 16 && m[15] === 1)));
	let p = 0, r = 0;
	for (let f = 0; f < F; f++) { const s = worldOf(lifted, f); for (let b = 0; b < B; b++) { p = Math.max(p, dist(at(rows[f][b]), s.P[b])); r = Math.max(r, matErr(rot3(rows[f][b]), s.R[b])); } }
	expect("take.json: bone matrices equal the raw world frames within 1e-6", p < 1e-6 && r < 1e-6, `${p} ${r}`);
	expect("take.json: source says raw cozyclay", take.source.tool === "cozyclay" && take.source.raw === true && take.source.f0 === 0 && take.source.qa === null && take.source.set === "deadlift");
	const group = take.objects.barbell;
	expect("take.json: the lifted group is one matrix at its root 1 m up", group.shape === "group" && group.mass === 60 && group.matrix.length === 1 && dist(at(group.matrix[0]), [0, 1.225, 0.35]) < 1e-6);
	const centres = { "barbell-bar": [0, 1.225, 0.35], "barbell-plate-l": [0.8, 1.225, 0.35], "barbell-plate-r": [-0.8, 1.225, 0.35] };
	expect("take.json: every part matrix follows the group (centre 1 m up, set axes)", PARTS.every(id => dist(at(take.objects[id].matrix[0]), centres[id]) < 1e-6
		&& matErr(rot3(take.objects[id].matrix[0]), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) < 1e-6 && take.objects[id].parent === "barbell" && take.objects[id].size.length === 3), JSON.stringify(PARTS.map(id => take.objects[id].matrix[0])));
	const moving = { ...squat, objects: { barbell: poseTrack(F, f => add(ROOT, [0, f / (F - 1), 0])) } };
	registry.run("motion.v4.install", { characterId: "char-a", raw: encodeRawTrack(moving) });
	const rising = rawTakeJson(docWith(takes.get("char-a")), { characterId: "char-a", objects: BARBELL_SET_OBJECTS });
	expect("take.json: a moving group keeps one matrix per frame, parts follow", rising.objects.barbell.matrix.length === F && PARTS.every(id => rising.objects[id].matrix.length === F
		&& Math.abs(at(rising.objects[id].matrix[F - 1])[1] - at(rising.objects[id].matrix[0])[1] - 1) < 1e-6));
	registry.run("motion.v4.install", { characterId: "char-a", raw: encodeRawTrack(squat) });
	const still = rawTakeJson(docWith(takes.get("char-a")), { characterId: "char-a", objects: BARBELL_SET_OBJECTS });
	expect("take.json: without object tracks every object keeps one matrix at rest", Object.values(still.objects).every(o => o.matrix.length === 1)
		&& dist(at(still.objects.barbell.matrix[0]), ROOT) < 1e-6 && dist(at(still.objects["barbell-plate-l"].matrix[0]), [0.8, 0.225, 0.35]) < 1e-6);
	const none = errorOf(() => rawTakeJson({ scenes: { activeSceneId: "s1", scenes: [{ id: "s1", objects: [], stage: { characters: [{ id: "char-a", model: "y-bot-tpose" }] } }] } }, { characterId: "char-a", objects: [] }));
	expect("take.json: a character without a raw take throws", /char-a has no raw take/.test(none?.message ?? ""), none?.message);
	console.log(`  take.json ${F} frames ${ms.toFixed(1)} ms, ${(JSON.stringify(take).length / 1024).toFixed(0)} KB`);
}

// ---- 8. track tool ----
{
	let actions = 0;
	const ctx = fakeCtx(SCENE, async (action, args) => { actions += 1; return { receiptId: `receipt-${actions}`, ...registry.run(action, args) }; });
	ctx.track = createTrackStore(ctx);
	const tool = createTrackTool(ctx), js = { from: "js" }, model = { from: "model" };
	expect("tool: name, description under 2,000 chars, the schema of the design", tool.name === "track" && tool.description.length <= 2000 && tool.inputSchema.required.join() === "op"
		&& tool.inputSchema.additionalProperties === false && tool.inputSchema.properties.op.enum.length === 6 && tool.inputSchema.properties.objects.additionalProperties.required.join() === "pos,quat", `${tool.description.length} chars`);
	expect("tool: info before a set says there is no track", /no track yet/.test((await tool.run({ op: "info" }, model)).text));
	const set = await tool.run(JSON.parse(JSON.stringify({ op: "set", ...payload(squat, { barbell: plainTrack(liftTrack(F)) }) })), js);
	expect("tool: set answers the store's data and a short text", set.data.revision === 1 && set.data.frames === F && /^track r1: 48 frames, objects barbell\. Not installed yet \(commit, or render commits it\)\.$/.test(set.text), set.text);
	const q = quatFromMat(axisRot([1, 0, 0], 20));
	const patch = await tool.run({ op: "patch", from: 40, to: 47, bones: ["Spine", "Spine1", "Spine2"], rot: Array.from({ length: 24 }, () => q).flat() }, model);
	expect("tool: patch text names the range and the bones", /^track r2: 48 frames; patched f40-f47, 3 bones\. Not installed yet/.test(patch.text) && patch.text.length <= 1500, patch.text);
	let t = now();
	const commit = await tool.run({ op: "commit", label: "tool squat" }, model);
	const ms = now() - t;
	expect("tool: commit installs through the registry and says so", actions === 1 && commit.data.revision === 2 && commit.data.receiptId === "receipt-1" && commit.data.frames === F
		&& /^installed r2 on char-a: 48 frames \(encode \d+ ms, install \d+ ms\)\.$/.test(commit.text), commit.text);
	expect("tool: after commit the store is clean and info names the installed revision", ctx.track.dirty === false && /track r2: 48 frames x 65 bones at 24 fps, objects barbell; installed r2\./.test((await tool.run({ op: "info" }, model)).text));
	const take = takes.get("char-a");
	expect("tool: the installed take is the store's track, placed", take.spec.label === "tool squat" && worldError(takeOut(take, SCENE), ctx.track.current()).p < 1e-5 && take.objects.barbell.world[0] === 1);
	const get = await tool.run({ op: "get" }, model);
	expect("tool: get gives the numbers to js and a short text to the model", get.data.rot.length === F * B * 4 && get.text === "track data f0-f47, 65 bones (returned to js only; call get from js).", get.text);
	const few = await tool.run({ op: "get", from: 3, to: 3, bones: ["Hips"] }, js);
	expect("tool: get of one bone on one frame", few.data.rot.length === 4 && few.data.hips.length === 3 && few.data.objects.barbell.pos.length === 3 && few.text.startsWith("track data f3, 1 bones"));
	await tool.run({ op: "patch", from: 0, to: 0, hips: [0, 0.9, 0] }, js);
	expect("tool: an edit after commit is dirty again", ctx.track.dirty === true && ctx.track.revision === 3);
	const old = character.scale;
	character.scale = 2;
	const failed = await rejection(() => tool.run({ op: "commit" }, model));
	character.scale = old;
	expect("tool: a refused install keeps the track dirty", /scale/.test(failed?.message ?? "") && ctx.track.dirty === true && ctx.track.info().committed === 2, failed?.message);
	const both = await Promise.all([ctx.track.commit(), ctx.track.commit({ label: "second" })]);
	expect("tool: commits run one at a time in call order", both[0].receiptId === "receipt-3" && both[1].receiptId === "receipt-4" && takes.get("char-a").spec.label === "second" && ctx.track.dirty === false, JSON.stringify(both.map(b => b.receiptId)));
	const clear = await tool.run({ op: "clear" }, model);
	expect("tool: clear text", /^track r4: cleared\./.test(clear.text), clear.text);
	const badOp = await rejection(() => tool.run({ op: "bake" }, js));
	expect("tool: an unknown op from js is an error", /op must be one of set, patch, commit, info, get, clear/.test(badOp?.message ?? ""), badOp?.message);
	const noStore = await rejection(() => createTrackTool({}).run({ op: "info" }, js));
	expect("tool: without a store it says so", /not ready/.test(noStore?.message ?? ""));
	console.log(`  tool commit ${F} frames ${ms.toFixed(1)} ms (encode ${commit.data.ms.encode} ms, install ${commit.data.ms.install} ms)`);
}

if (failures) {
	console.log(`FAIL ${failures} check(s)`);
	process.exit(1);
}
console.log("PASS v4 track");
