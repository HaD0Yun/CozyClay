#!/usr/bin/env node
// grab/release and the group as the unit of motion (docs/motion-api-v3.1.md C3, 7.1, 7.2) on the
// cup scene: the left hand reaches the cup handle, grabs the cup group `empty-2` and lifts it.
// One track on the group root; the parts ride it through the scene hierarchy; the held cup keeps
// its grab-frame palm offset, freezes on release, is an obstacle (COLLIDE "<id> x <other>"), and
// a late hand gives a GRAB issue with a fix.
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { bakeTake } from "../../src/motion3/take.js";
import { carriedPose, relative } from "../../src/motion3/carried.js";
import { objectBoxesAt } from "../../src/motion3/object-pose.js";
import { quatFromMat, matFromQuat } from "../../src/motion3/compiler/math.js";
import { groupKey } from "../../src/motion3/qa/severity.js";
import { sceneObjectsAt, sceneObjectTravelMatrixAt } from "../../src/object-travel.js";
import { goalChecks } from "../../src/motion3/qa/goals.js";
import { grabReleases } from "../../src/motion3/beats.js";
import { rootPoseAt, riderOf, objectPoseAt } from "../../src/motion3/object-pose.js";
import { propOrigin } from "../../src/motion3/carried.js";
import { axisRot, mul, apply, sub, add } from "../../src/motion3/compiler/math.js";
import { compileTakeSource } from "../../src/domains/motion/take-source.js";
import { sdBox } from "../../src/motion3/qa/geometry.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const GRAB = 34, RELEASE = 80, LIFTED = 70;

// The fingers (prop "grip") land on the handle `cube-6` through a fit; `low` is 6 cm lower: a
// dip there (with a deeper bow) pushes the held cup into the table top.
function cupSpec({ objects, dip, offset } = {}) {
	const keys = [{ f: 10, set: { pitch: 0, armw_l: 0, w_cupHandle_l: 0, w_low_l: 0 } },
		{ f: 30, set: { pitch: 25, armw_l: 1, w_cupHandle_l: 1, hand_l: [0.3, 1, 0.7] } },
		{ f: 36, set: { w_cupHandle_l: 1, pitch: 25, hand_l: [0.3, 1, 0.7] } },
		{ f: 60, set: { w_cupHandle_l: 0, pitch: 10, hand_l: [0.3, 1.2, 0.6] } }, { f: 99, set: {} }];
	if (dip !== undefined) keys.push({ f: dip - 2, set: { w_cupHandle_l: 1, w_low_l: 0, pitch: 25 } }, { f: dip, set: { w_cupHandle_l: 0, w_low_l: 1, pitch: 45 } }, { f: dip + 2, set: { w_cupHandle_l: 1, w_low_l: 0, pitch: 25 } });
	keys.sort((a, b) => a.f - b.f);
	return { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100,
		use: [{ skill: "standIdle", args: { at: [0.15, 0.3], heading: 0 }, f0: 0 }],
		props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } },
		anchors: { cupHandle: { kind: "object", object: "cube-6", local: [0, 0.03, 0] }, low: { kind: "object", object: "cube-6", local: [0, -0.03, 0] } },
		fits: [{ side: "l", anchor: "cupHandle", effector: { prop: "grip", point: "fingers" }, ...(offset ? { offset } : {}) },
			{ side: "l", anchor: "low", effector: { prop: "grip", point: "fingers" } }],
		keys, objects: objects ?? { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE } } };
}

// ---- validation -------------------------------------------------------------------------
const base = cupSpec();
expect("a group id carries (objects.empty-2 with grab/release)", refusal(() => validateSpec(base, { sk, scene })) === "", refusal(() => validateSpec(base, { sk, scene })));
const bad = objects => refusal(() => validateSpec({ ...base, objects }, { sk, scene }));
// C15 (kits): at/along on a group pin its root to the palm, as for a body
expect("at/along on a group are accepted (C15: the root takes the fixed palm offset)", bad({ [CUP.group]: { prop: "grip", grab: 34, at: [0, 0, 0], along: [0, 1, 0] } }) === "");
expect("grab must come before release", /objects\.empty-2: grab \(50\) must come before release \(40\)/.test(bad({ [CUP.group]: { prop: "grip", grab: 50, release: 40 } })));
expect("grab and release are whole frames of the take", /objects\.empty-2\.release must be a whole frame 0\.\.99, got 100/.test(bad({ [CUP.group]: { prop: "grip", release: 100 } }))
	&& /objects\.empty-2\.grab must be a whole frame/.test(bad({ [CUP.group]: { prop: "grip", grab: 3.5 } })));
expect("an unknown object field is refused, and ignored on a lenient reload", /objects\.empty-2 \(carry\) has unknown field "grabb"; did you mean "grab"\?/.test(bad({ [CUP.group]: { prop: "grip", grabb: 3 } }))
	&& refusal(() => validateSpec({ ...base, objects: { [CUP.group]: { prop: "grip", grabb: 3 } } }, { sk, scene, lenient: true })) === "");
expect("a group hinge is accepted", bad({ [CUP.group]: { pivot: [0.2, 0.75, 0.85], axis: [0, 1, 0], channel: "cupTurn" } }) === "");
expect("a group with no body of its own is still refused where a body is needed", /names "empty-2", a group/.test(refusal(() => validateSpec({ ...base, checks: { clearance: [{ name: "c", part: "hand_l", object: CUP.group, min: 0.01 }] } }, { sk, scene }))));
expect("motionScene keeps groups as body-less nodes listing their children", JSON.stringify(scene.groups[CUP.group]?.children) === JSON.stringify(CUP.parts)
	&& scene.groups[CUP.table]?.children.includes(CUP.group) && !scene.objects[CUP.group] && scene.groups[CUP.group].pos.join() === "0.2,0.75,0.85");

// ---- the lift -----------------------------------------------------------------------------
const r = compileSpec(base, { sk, scene }), out = r.out, take = bakeTake(sk, out);
const track = take.objects[CUP.group], posAt = f => Array.from(track.pos.subarray(f * 3, f * 3 + 3)), quatAt = f => Array.from(track.quat.subarray(f * 4, f * 4 + 4));
const gap = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
expect("take.objects holds the group root only", JSON.stringify(Object.keys(take.objects)) === `["${CUP.group}"]`, JSON.stringify(Object.keys(take.objects)));
const restQ = quatFromMat(scene.groups[CUP.group].R);
let before = 0;
for (let f = 0; f < GRAB; f++) before = Math.max(before, gap(posAt(f), [0.2, 0.75, 0.85]), gap(quatAt(f), restQ));
expect("before grab the group track is the scene pose (1e-6)", before <= 1e-6, `${before}`);
const jump = gap(posAt(GRAB), posAt(GRAB - 1));
expect("no jump at grab (<= 1 mm)", jump <= 0.001, `${(jump * 1000).toFixed(3)} mm`);
const palm = f => carriedPose(sk, out.ctx.spec, out.frames[f].s, { prop: "grip" });
const offsetAt = f => relative(palm(f), { pos: posAt(f), R: matFromQuat(quatAt(f)) });
const o0 = offsetAt(GRAB);
let drift = 0;
for (let f = GRAB; f <= RELEASE; f++) { const o = offsetAt(f); drift = Math.max(drift, gap(o.pos, o0.pos), ...o.R.map((row, i) => gap(row, o0.R[i]) * 0.1)); }
expect("in hand the palm-relative offset holds (<= 1 mm)", drift <= 0.001, `${(drift * 1000).toFixed(3)} mm`);
let frozen = 0;
for (let f = RELEASE + 1; f < 100; f++) frozen = Math.max(frozen, gap(posAt(f), posAt(RELEASE)), gap(quatAt(f), quatAt(RELEASE)));
expect("after release the group is frozen at the release pose", frozen === 0, `${frozen}`);
expect("the take flags the held frames", track.hold[GRAB - 1] === 0 && track.hold[GRAB] === 1 && track.hold[RELEASE] === 1 && track.hold[RELEASE + 1] === 0);
const boxes = objectBoxesAt(out, CUP.group, LIFTED);
expect("objectBoxesAt moves every part box with the group", boxes.length === 4 && boxes.every(b => b.pos[1] > scene.objects[b.id].pos[1] + 0.1));

// The parts ride the group root through the scene hierarchy, as the renderer draws them.
const tracks = new Map(Object.entries(take.objects).map(([id, t]) => [id, { frameCount: take.frameCount, ...t }]));
const playback = { frameCount: take.frameCount, fps: 24, objectTracks: tracks };
const worldAt = (f, id) => sceneObjectsAt(SCENE_OBJECTS, f, playback).find(o => o.id === id);
const rise = id => worldAt(LIFTED, id).y - worldAt(0, id).y;
expect("cylinder and cube-6/7/8 rise >= 0.1 m with the group (sceneObjectsAt)", [...CUP.parts, CUP.group].every(id => rise(id) >= 0.1), [...CUP.parts, CUP.group].map(id => `${id} ${rise(id).toFixed(3)}`).join(", "));
const still = ["empty", "cube", "cube-2", "cube-3", "cube-4", "cube-5"];
expect("the table and its other parts stay put", still.every(id => worldAt(LIFTED, id) === SCENE_OBJECTS.find(o => o.id === id)));
const m = sceneObjectTravelMatrixAt(SCENE_OBJECTS, "cylinder", LIFTED, playback), seen = boxes.find(b => b.id === "cylinder").pos;
expect("the renderer matrix of a part matches QA's part box (1 mm)", gap([m.elements[12], m.elements[13], m.elements[14]], seen) < 0.001);
const xyz = o => [o.x, o.y, o.z];
expect("before grab every part stays on its authored pose", CUP.parts.every(id => gap(xyz(worldAt(10, id)), xyz(SCENE_OBJECTS.find(o => o.id === id))) < 1e-6));

// While held the parent's carry is cut: a table that moves does not carry the cup a second time.
const shove = { frameCount: 100, pos: new Float32Array(300).map((_, i) => (i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : 1)), quat: new Float32Array(400).map((_, i) => (i % 4 === 3 ? 1 : 0)) };
const moved = { ...playback, objectTracks: new Map([...tracks, [CUP.table, shove]]) };
const cyl = (f, take) => sceneObjectsAt(SCENE_OBJECTS, f, take).find(o => o.id === "cylinder");
expect("a held group ignores its parent's motion; before grab it rides it", Math.abs(cyl(LIFTED, moved).x - cyl(LIFTED, playback).x) < 1e-6 && Math.abs(cyl(10, moved).x - (0.2 + 1)) < 1e-6,
	`held dx ${(cyl(LIFTED, moved).x - cyl(LIFTED, playback).x).toFixed(4)}, before grab x ${cyl(10, moved).x.toFixed(4)}`);

// The other readers agree on the held group: timeline events, beats picks and a moved goal.
const events = r.timeline.flatMap(e => e.events ?? []).filter(e => e.object === CUP.group).map(e => `${e.event}@${e.f}`);
expect("timeline events: grab and release of the group", events.join() === `grab@${GRAB},release@${RELEASE}`, events.join());
const picks = grabReleases(r.timeline, out.ctx.spec.objects).map(p => p.f);
expect("beats pick the grab and release frames", picks.includes(GRAB) && picks.includes(RELEASE), picks.join());
const goal = goalChecks(out, [{ name: "cup lifted", moved: `object:${CUP.group}`, by: 0.1, at: [LIFTED, LIFTED + 5] }, { name: "cup still", moved: `object:${CUP.group}`, by: 0.01, at: [0, GRAB - 1], mode: "any" }]);
expect("a moved goal on the group: met while lifted, not before grab", goal.results[0]?.ok === true && goal.results[1]?.ok === false, JSON.stringify(goal.results));

// ---- QA ---------------------------------------------------------------------------------
const groups = res => res.qa.groups.map(g => `${g.kind} ${g.subject}`);
expect("the clean lift has no GRAB issue and no cup collision", !groups(r).some(s => /^GRAB|empty-2/.test(s)), groups(r).join(" | "));
const late = compileSpec(cupSpec({ objects: { [CUP.group]: { prop: "grip", grab: 22, release: RELEASE } } }), { sk, scene });
const lateGrab = late.qa.groups.find(g => g.kind === "GRAB");
expect("a grab before the hand arrives: GRAB with a fix on objects/<id>/grab (within +-24 frames)", lateGrab?.worstFrame === 22 && lateGrab.fix?.path === "/objects/empty-2/grab" && lateGrab.fix.value > 22 && lateGrab.fix.value <= 34,
	JSON.stringify(lateGrab && { ...lateGrab, fix: lateGrab.fix }));
const off = compileSpec(cupSpec({ offset: [0, 0.18, 0] }), { sk, scene });
const offGrab = off.qa.groups.find(g => g.kind === "GRAB");
expect("a hand 12 cm off at grab: GRAB with a fix that moves the hand", offGrab && offGrab.worst >= 0.1 && offGrab.worst <= 0.14 && /^empty-2: hand 1\d\.\d cm from it at grab$/.test(offGrab.subject)
	&& offGrab.fix?.path === "/fits/0/offset" && offGrab.fix.delta?.[1] < -0.05, JSON.stringify(offGrab && { ...offGrab, fix: offGrab.fix }));
const pushed = compileSpec(cupSpec({ dip: 44 }), { sk, scene });
const through = pushed.qa.groups.find(g => g.subject === "empty-2 x cube");
expect("a held cup pushed into the table top: COLLIDE \"empty-2 x cube\" with a hand fix", through?.kind === "COLLIDE" && through.worst > 0.01 && (through.fix?.delta ?? through.fix?.value)?.[1] > 0.01,
	JSON.stringify(through && { ...through, fix: through.fix }) + groups(pushed).join(" | "));
const atGrab = compileSpec(cupSpec({ dip: GRAB + 1 }), { sk, scene });
expect("the same dip within 3 frames of grab touches the support: no issue", !groups(atGrab).some(s => /empty-2 x/.test(s)), groups(atGrab).join(" | "));
const allowed = compileSpec({ ...cupSpec({ dip: 44 }), checks: { allow: [{ part: CUP.group, object: "cube", depth: 0.08 }] } }, { sk, scene });
expect("checks.allow excuses a carried object against a scene object", !groups(allowed).some(s => s === "COLLIDE empty-2 x cube"));
expect("carried-object groups keep the group id: distinct keys from the table legs", groupKey({ kind: "COLLIDE", subject: "empty-2 x cube" }) !== groupKey({ kind: "COLLIDE", subject: "empty-2 x cube-2" }));

// The body against the carried cup: the holding hand is excused, the other hand is not.
const bump = cupSpec();
bump.keys.push({ f: 66, set: { armw_r: 0 } }, { f: 70, set: { armw_r: 1, hand_r: [0.2, 1.27, 0.84] } }, { f: 74, set: { armw_r: 0 } });
bump.keys.sort((a, b) => a.f - b.f);
// fix.self off: its repair moves that FK-to-IK bump out of the body (7.6 cm in the torso, 7.9 in the hips) and so out of
// the cup too; the check is QA's, on the bump as keyed
const bumped = compileSpec({ ...bump, fix: { ...(bump.fix ?? {}), self: false } }, { sk, scene });
expect("the other hand in the held cup: COLLIDE \"hand_r x empty-2\"; the holding hand is never reported", groups(bumped).some(s => /^COLLIDE (hand|farm)_r x empty-2$/.test(s)) && !groups(bumped).some(s => /^COLLIDE (hand|farm)_l x empty-2$/.test(s)), groups(bumped).join(" | "));
// fix.self on: the repair moves the bump's arm out of the body only as far as it keeps the keyed hand on its key (its
// gate reads the wrist against the key on key frames, fixed.self.spans key [before, after]; QA's REACH reads against the
// target the repair pushed): it pulled the wrist 14.9 cm off the key at f70 (7.6 without the repair) and hid the miss
const selfOn = compileSpec(bump, { sk, scene }), unrepaired = compileMotion({ fps: 24, ...selfOn.expanded, ...(selfOn.fixed?.retime?.kept === false ? { fix: { ...selfOn.expanded.fix, retime: false } } : {}) }, { sk, scene }, { selfRepair: false });
const keyGap = o => gap(o.frames[70 - (o.f0 ?? 0)].s.P[sk.index.RightHand], [0.2, 1.27, 0.84]);
expect("the bump with fix.self on: the right wrist at its key f70 no farther off it than without the repair (1 cm), and the spans report it", keyGap(selfOn.out) <= keyGap(unrepaired) + 0.01
	&& (selfOn.fixed.self?.spans ?? []).every(sp => sp.key && sp.key[1] <= sp.key[0] + 0.01), JSON.stringify([keyGap(selfOn.out), keyGap(unrepaired), selfOn.fixed.self?.spans]));

// A group hinge turns the whole group about the root: one track, every part box turned.
const turn = { ...cupSpec({ objects: { [CUP.group]: { pivot: [0.2, 0.75, 0.85], axis: [0, 1, 0], channel: "cupTurn" } } }) };
turn.keys = [...turn.keys.filter(k => k.f !== 99), { f: 99, set: { cupTurn: 90 } }];
turn.keys[0].set.cupTurn = 0;
const turned = compileSpec(turn, { sk, scene }), turnTake = bakeTake(sk, turned.out);
const handle = objectBoxesAt(turned.out, CUP.group, 99).find(b => b.id === "cube-6").pos;
expect("a group hinge: one root track, the handle swings about the root", JSON.stringify(Object.keys(turnTake.objects)) === `["${CUP.group}"]` && gap(handle, [0.2, 0.77, 0.85 - 0.068]) < 1e-6, JSON.stringify(handle));

// ---- C14: keys on a held group (the cup tilted about the hand that holds it) -------------------
const tilt = (f, deg) => {
	const p = rootPoseAt(out, CUP.group, f), G = propOrigin(sk, out.ctx.spec, out.frames[f].s, { prop: "grip" }), R = axisRot([0, 0, 1], deg);
	return { f, pos: add(G, apply(R, sub(p.pos, G))).map(v => +v.toFixed(4)), rot: quatFromMat(mul(R, p.R)).map(v => +v.toFixed(5)) };
};
const cupKeys = [tilt(50, 0), tilt(58, -35), tilt(66, -35)], held = cupSpec({ objects: { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE, keys: cupKeys } } });
const kr = compileSpec(held, { sk, scene }), kt = bakeTake(sk, kr.out), kq = (t, f) => Array.from(t.objects[CUP.group].quat.subarray(f * 4, f * 4 + 4));
const turnOf = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((n, v, i) => n + v * b[i], 0)))) * 180 / Math.PI;
const keyMiss = Math.max(...cupKeys.map(k => Math.max(gap(Array.from(kt.objects[CUP.group].pos.subarray(k.f * 3, k.f * 3 + 3)), k.pos) * 1000, turnOf(kq(kt, k.f), k.rot))));
expect("group keys: one root track still, drawn on the keys (<= 1 mm, <= 0.1 deg), the cup tipped 35 deg from the plain carry", JSON.stringify(Object.keys(kt.objects)) === `["${CUP.group}"]` && keyMiss <= 0.1
	&& Math.abs(turnOf(kq(kt, 58), kq(take, 58)) - 35) < 0.1, `${keyMiss} ${turnOf(kq(kt, 58), kq(take, 58))}`);
let onHandle = 0;
for (let f = GRAB; f <= RELEASE; f++) onHandle = Math.max(onHandle, sdBox(propOrigin(sk, kr.out.ctx.spec, kr.out.frames[f].s, { prop: "grip" }), objectBoxesAt(kr.out, CUP.group, f).find(b => b.id === "cube-6")));
const plainGap = Math.max(...Array.from({ length: RELEASE - GRAB + 1 }, (_, i) => sdBox(propOrigin(sk, out.ctx.spec, out.frames[GRAB + i].s, { prop: "grip" }), objectBoxesAt(out, CUP.group, GRAB + i).find(b => b.id === "cube-6"))));
expect("the hand stays on the handle while the keys lead (as without keys), and reaches every key", Math.abs(onHandle - plainGap) < 0.001 && !groups(kr).some(g => g.startsWith("REACH empty-2")), `${onHandle} vs ${plainGap}; ${groups(kr).join(" | ")}`);
const reloaded = compileTakeSource({ schema: "cozyclay.take.v3", rig: CHARACTER.model, spec: held, placement: { position: [0, 0, 0], yaw: 0 }, scene });
expect("a keyed take reloads (lenient) to the same group track, bit for bit", ["pos", "quat", "hold"].every(k => reloaded.objects[CUP.group][k].every((v, i) => v === kt.objects[CUP.group][k][i])));
const keyRefusal = (o, extra = {}) => refusal(() => validateSpec({ ...base, ...extra, objects: { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE, ...o } } }, { sk, scene }));
const k0 = cupKeys[0];
expect("keys outside grab..release are refused", keyRefusal({ keys: [{ ...k0, f: 20 }] }).includes("objects.empty-2.keys[0].f = 20 is outside grab..release (34..80); keys pose a carried object only while it is in hand (drop its prop to move it on its own, C17)"));
expect("a bad rot, a repeated frame and a non-array are refused by name", keyRefusal({ keys: [{ ...k0, rot: [0, 0, 0, 2] }] }).includes("objects.empty-2.keys[0].rot must be a unit quaternion [x, y, z, w], got [0,0,0,2]")
	&& keyRefusal({ keys: [k0, { ...k0 }] }).includes("objects.empty-2.keys[1].f = 50: keys[0] is at that frame already; one key per frame") && keyRefusal({ keys: k0 }).includes("objects.empty-2.keys must be an array of { f, pos: [x, y, z], rot: [x, y, z, w] }"));
expect("an unknown key field is refused, and ignored on a lenient reload", keyRefusal({ keys: [{ ...k0, rott: 1 }] }).includes('objects.empty-2.keys[0] has unknown field "rott"; did you mean "rot"?')
	&& refusal(() => validateSpec({ ...base, objects: { [CUP.group]: { prop: "grip", keys: [{ ...k0, rott: 1 }] } } }, { sk, scene, lenient: true })) === "");
expect("a hinge takes no keys (its channel is keyed; keys move a free or carried object, C17)", /objects\.empty-2: a hinge turns by its channel "cupTurn", keyed in spec\.keys; keys and fall move an object with no pivot, axis or channel \(C17\)/.test(refusal(() => validateSpec({ ...base, objects: { [CUP.group]: { pivot: [0.2, 0.75, 0.85], channel: "cupTurn", keys: [k0] } } }, { sk, scene }))));
const auto = compileSpec({ ...held, frames: "auto" }, { sk, scene });
expect("frames: \"auto\" with keys: resolves to the last key + 1, stores the number and bakes the same take", auto.spec.frames === 100 && auto.out.frameCount === 100
	&& bakeTake(sk, auto.out).objects[CUP.group].pos.every((v, i) => v === kt.objects[CUP.group].pos[i]));

// ---- let go over a body that moves on its own: it rides that body ------------------------------
// A lighter put down in a truck that drives off (session 1c631d0c) stayed where it was let go. Here the table the cup is put
// back over drives 0.5 m along +X after the release (free keys on the table group): the cup rides it, keeping its world pose
// at the release, the take marks those frames world space (no hand holds it), and the renderer, which carries the cup with
// its scene parent (the table), draws it once, where the compiler has it.
const drive = { keys: [{ f: 85, pos: [0, 0, 1] }, { f: 99, pos: [0.5, 0, 1] }] };
const mr = compileSpec(cupSpec({ objects: { [CUP.group]: { prop: "grip", grab: GRAB, release: RELEASE }, [CUP.table]: drive } }), { sk, scene }).out;
const mt = bakeTake(sk, mr), mtrack = mt.objects[CUP.group], mpose = (id, f) => ({ pos: Array.from(mt.objects[id].pos.subarray(f * 3, f * 3 + 3)), R: matFromQuat(Array.from(mt.objects[id].quat.subarray(f * 4, f * 4 + 4))) });
expect("a carry let go over a moving body rides that body's mover (riderOf)", riderOf(mr, CUP.group) === CUP.table && riderOf(out, CUP.group) === null, `${riderOf(mr, CUP.group)} / ${riderOf(out, CUP.group)}`);
const onTable = f => relative(mpose(CUP.table, f), mpose(CUP.group, f)), atRelease = onTable(RELEASE);
let slide = 0;
for (let f = RELEASE + 1; f < 100; f++) { const o = onTable(f); slide = Math.max(slide, gap(o.pos, atRelease.pos), ...o.R.map((row, i) => gap(row, atRelease.R[i]))); }
expect("from the release on the cup keeps its place on the table (1e-5, Float32 tracks)", slide <= 1e-5, `${slide}`);
expect("the cup travels with the table (0.5 m along +X by the last frame)", Math.abs(mpose(CUP.group, 99).pos[0] - mpose(CUP.group, RELEASE).pos[0] - 0.5) < 1e-5 && gap(mpose(CUP.group, 99).pos, objectPoseAt(mr, CUP.group, 99).pos) < 1e-5);
expect("the take marks the riding frames world space, not held", mtrack.world?.[RELEASE] === 0 && mtrack.world?.[RELEASE + 1] === 1 && mtrack.hold[RELEASE + 1] === 0 && track.world === undefined);
const mplay = { frameCount: mt.frameCount, fps: 24, objectTracks: new Map(Object.entries(mt.objects).map(([id, t]) => [id, { frameCount: mt.frameCount, ...t }])) };
const drawn = sceneObjectTravelMatrixAt(SCENE_OBJECTS, CUP.group, 99, mplay);
expect("the renderer draws the riding cup once, at its track (the table's travel is not added again)", gap([drawn.elements[12], drawn.elements[13], drawn.elements[14]], mpose(CUP.group, 99).pos) < 1e-5,
	`${[drawn.elements[12], drawn.elements[13], drawn.elements[14]].map(v => v.toFixed(3))} vs ${mpose(CUP.group, 99).pos.map(v => v.toFixed(3))}`);

if (failures) { console.error(`${failures} grab check(s) failed`); process.exit(1); }
console.log("motion3 grab/release and groups: all checks passed");
