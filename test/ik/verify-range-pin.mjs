import * as THREE from "three";
import { createHash } from "node:crypto";
import { resolveIkRig, createIkState, ikEvaluate, ikTouch, solveIk, correctionWeight } from "../../src/motion/ik.js";
import { bakeIkDragKey } from "../../src/motion/ik-drag.js";
import { ikKeyJson, ikTrackKeyFromJson } from "../../src/motion/ik-key-json.js";
import { objectTransformAt } from "../../src/object-path.js";
import { studioActionDeclaration } from "../../src/studio-actions.js";
import { validateStudioSchema } from "../../src/studio-agent-protocol.js";
import {
	applyRangePin,
	captureRangePinTarget,
	normalizeRangePin,
	rangePinTargetWorld,
	removeRangePinKeys,
} from "../../src/motion/range-pin.js";

/* A range pin holds one limb on a target for every frame of a range, as delta
 * IK keys over the motion tagged with the pin id. Inside the range the
 * effector must sit on the target; beyond the pin's blend the clip is
 * untouched; re-applying a pin must not stack. */

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

const BLEND = 6; // App.jsx IK_CORRECTION_BLEND_FRAMES
const CLIP_FRAMES = 60;
const FPS = 24;
const v = () => new THREE.Vector3();
const mm = (m) => `${(m * 1000).toFixed(3)}mm`;

/* verify-ik.mjs's synthetic Mixamo rig: T-pose, arms along ±X, 0.01 scale. */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	mk("mixamorigRightHand", rFore, -30, 0, 0);
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

/** A 60-frame take: arms swinging, chain translations 3-7 % off bind (ARDY
 * writes per-bone translations), hips bobbing and walking forward. A pure
 * function of the frame. */
function buildTake({ walkCm = 0.5 } = {}) {
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const hips = fkJoints.get("hips");
	const Y = new THREE.Vector3(0, 1, 0);
	const Z = new THREE.Vector3(0, 0, 1);
	const poseClip = (frame) => {
		const stretch = 1.05 + 0.02 * Math.sin(frame * 0.7);
		for (const [id, chain] of chains) {
			const sign = id.startsWith("left") ? 1 : -1;
			chain.bones.forEach((bone, index) => {
				bone.position.copy(chain.bindPositions[index]).multiplyScalar(stretch);
				bone.quaternion.identity();
			});
			if (chain.track.kind === "arm") {
				chain.bones[0].quaternion.setFromAxisAngle(Z, sign * (-0.9 + 0.6 * Math.sin((frame / CLIP_FRAMES) * Math.PI * 2)));
				// The forearm's child lies on its local X, so the elbow bends about Y.
				chain.bones[1].quaternion.setFromAxisAngle(Y, sign * (0.9 + 0.3 * Math.sin(frame * 0.15)));
			}
		}
		hips.bone.position.copy(hips.bindPos).add(new THREE.Vector3(0, 3 * Math.sin(frame * 0.4), frame * walkCm));
		hips.bone.quaternion.identity();
		for (const [id, joint] of fkJoints) {
			if (id === "hips") continue;
			joint.bone.position.copy(joint.bindPos);
			joint.bone.quaternion.identity();
		}
		rig.updateMatrixWorld(true);
	};
	const state = createIkState();
	state.chains = chains;
	state.fkJoints = fkJoints;
	state.rig = rig;
	// poseMemberAtFrame: clip, then the layer.
	const viewAt = (frame) => {
		poseClip(frame);
		if (state.keys.size) ikEvaluate(chains, state, frame, fkJoints, BLEND);
	};
	// setCharacterIkKey per frame: each track replaces its key and is tracked.
	const setEntries = (entries) => {
		for (const [frame, baked] of entries) {
			let entry = state.keys.get(frame);
			if (!entry) state.keys.set(frame, (entry = new Map()));
			for (const [id, key] of baked) {
				entry.set(id, key);
				ikTouch(state, id);
			}
		}
	};
	const apply = (pin, objectWorldMatrix = null) => applyRangePin({
		chains, fkJoints, ikState: state, pin, objectWorldMatrix, applyRaw: poseClip, applyLayer: viewAt,
	});
	return { rig, chains, fkJoints, state, poseClip, viewAt, setEntries, apply };
}

const handAt = (take, id = "rightHand") => take.chains.get(id).bones[2].getWorldPosition(v());
const chainWorld = (take, id) => take.chains.get(id).bones.map((bone) => bone.getWorldPosition(v()));
const rigSnapshot = (rig) => {
	const out = [];
	rig.traverse((node) => out.push([node, node.position.clone(), node.quaternion.clone()]));
	return out;
};
const rigUnchanged = (snapshot) => snapshot.every(([node, p, q]) => node.position.equals(p) && node.quaternion.equals(q));
/** Ramp frames: 0 < w < 1, each chain bone carries exactly w of the edge
 * key's delta over the clip (strictly between none and all of it), and the
 * hand is off the clip. */
function rampStrictlyBetween(take, entries, frames, edgeFrame) {
	const edge = entries.get(edgeFrame).get("rightHand");
	const chain = take.chains.get("rightHand");
	const identity = new THREE.Quaternion();
	let ok = true;
	const detail = [];
	for (const f of frames) {
		const w = correctionWeight(take.state.keys, "rightHand", f, BLEND);
		take.poseClip(f);
		const clipQ = chain.bones.map((b) => b.quaternion.clone());
		const clipHand = handAt(take);
		take.viewAt(f);
		const off = handAt(take).distanceTo(clipHand);
		for (let i = 0; i < 2; i += 1) {
			const full = edge.baseQ[i].clone().invert().multiply(edge.q[i]).angleTo(identity);
			const applied = clipQ[i].clone().invert().multiply(chain.bones[i].quaternion).angleTo(identity);
			if (!(w > 0 && w < 1 && applied > 1e-6 && applied < full - 1e-6 && Math.abs(applied - w * full) < 1e-6)) ok = false;
			detail.push(`f${f} b${i} w=${w.toFixed(2)} ${applied.toFixed(4)}/${full.toFixed(4)}`);
		}
		if (!(off > 1e-6)) ok = false;
		detail.push(`f${f} hand off clip ${mm(off)}`);
	}
	return { ok, detail: detail.join("; ") };
}
const finiteKey = (key) => key.q.every((q) => [q.x, q.y, q.z, q.w].every(Number.isFinite)) && key.baseQ.every((q) => [q.x, q.y, q.z, q.w].every(Number.isFinite));

/* --- (1)-(3): world pin over 21..29, pin blend 4 --------------------------- */
const PIN_BLEND = 4;
const main = buildTake();
const pinned = (() => {
	const before = rigSnapshot(main.rig);
	const target = captureRangePinTarget({ chains: main.chains, track: "rightHand", frame: 21, applyFrame: main.viewAt });
	check("captureRangePinTarget leaves the rig as it found it", rigUnchanged(before));
	main.poseClip(21);
	check("captured world target is the frame-21 effector", new THREE.Vector3().fromArray(target.position).distanceTo(handAt(main)) < 1e-12);
	const pin = normalizeRangePin({ id: "pin-a", track: "rightHand", startFrame: 21, endFrame: 29, blend: PIN_BLEND, target }, { clipFrames: CLIP_FRAMES });
	main.viewAt(40);
	const held = rigSnapshot(main.rig);
	const result = main.apply(pin);
	check("applyRangePin leaves the rig as it found it", rigUnchanged(held));
	check("applyRangePin writes nothing into the layer itself", main.state.keys.size === 0);
	main.setEntries(result.entries);
	return { result, target: new THREE.Vector3().fromArray(target.position) };
})();
{
	const { result, target } = pinned;
	const frames = [...result.entries.keys()];
	check("one key per frame of the inclusive range", frames.join() === "21,22,23,24,25,26,27,28,29", frames.join());
	const keys = frames.map((f) => result.entries.get(f));
	check("every key is the pinned chain only", keys.every((entry) => [...entry.keys()].join() === "rightHand"));
	check("every key is a delta tagged with the pin and its blend", keys.every((entry) => {
		const key = entry.get("rightHand");
		return key.baseQ?.length === 3 && key.q?.length === 3 && key.pin === "pin-a" && key.blend === PIN_BLEND;
	}));
	check("every key's baseQ is the raw clip rotation of its frame", frames.every((f) => {
		main.poseClip(f);
		return result.entries.get(f).get("rightHand").baseQ.every((q, i) => q.equals(main.chains.get("rightHand").bones[i].quaternion));
	}));
	check("reachable pin: residuals under 1 mm", result.residuals.every((r) => r.errorM < 0.001), result.residuals.map((r) => mm(r.errorM)).join(" "));

	// (1) on target inside the range after ikEvaluate(blendWindow 6).
	let worst = 0;
	let moved = 0;
	for (let f = 21; f <= 29; f += 1) {
		main.viewAt(f);
		worst = Math.max(worst, handAt(main).distanceTo(target));
		main.poseClip(f);
		moved = Math.max(moved, handAt(main).distanceTo(target));
	}
	check("(1) fixture: the clip hand leaves the target over 21..29 (> 5 cm)", moved > 0.05, mm(moved));
	check("(1) effector within 1 mm of the target on 21..29", worst < 0.001, `worst=${mm(worst)}`);

	// (2) beyond startFrame-blend and endFrame+blend the pose is the clip.
	let outside = 0;
	for (const f of [0, 5, 10, 15, 16, 17, 33, 34, 40, 50, 59]) {
		main.poseClip(f);
		const clip = chainWorld(main, "rightHand");
		main.viewAt(f);
		const view = chainWorld(main, "rightHand");
		outside = Math.max(outside, ...view.map((p, i) => p.distanceTo(clip[i])));
	}
	check("(2) frames <= start-blend and >= end+blend equal the clip (< 1e-6 m)", outside < 1e-6, `worst=${outside.toExponential(2)} m`);

	// (3) The target IS the frame-21 hand, so the frame-21 key's delta is the
	// identity and the ramp-in has nothing to ease: it must equal the clip.
	// The ramp-out carries the whole frame-29 correction.
	const rampOut = rampStrictlyBetween(main, result.entries, [30, 31, 32], 29);
	check("(3) ramp-out frames 30-32 are strictly between clip and pinned", rampOut.ok, rampOut.detail);
	let rampIn = 0;
	for (const f of [18, 19, 20]) {
		main.poseClip(f);
		const clip = handAt(main);
		main.viewAt(f);
		rampIn = Math.max(rampIn, handAt(main).distanceTo(clip));
	}
	check("(3) ramp-in frames 18-20 of an identity edge key stay on the clip", rampIn < 1e-6, `worst=${rampIn.toExponential(2)} m`);
}

/* --- (3b) a pin off the pose eases in AND out strictly between ----------- */
{
	const take = buildTake();
	take.poseClip(21);
	const lifted = handAt(take).add(new THREE.Vector3(0, 0.05, 0));
	const pin = normalizeRangePin({ id: "pin-lift", track: "rightHand", startFrame: 21, endFrame: 29, blend: PIN_BLEND, target: { space: "world", position: lifted.toArray() } });
	const result = take.apply(pin);
	take.setEntries(result.entries);
	const rampIn = rampStrictlyBetween(take, result.entries, [18, 19, 20], 21);
	const rampOut = rampStrictlyBetween(take, result.entries, [30, 31, 32], 29);
	check("(3) lifted pin: ramp-in frames 18-20 strictly between", rampIn.ok, rampIn.detail);
	check("(3) lifted pin: ramp-out frames 30-32 strictly between", rampOut.ok, rampOut.detail);
	let worst = 0;
	for (let f = 21; f <= 29; f += 1) {
		take.viewAt(f);
		worst = Math.max(worst, handAt(take).distanceTo(lifted));
	}
	check("(3) lifted pin: on target on 21..29 (< 1 mm)", worst < 0.001, mm(worst));
}

/* --- (4) apply -> remove -> apply == apply; unrelated keys survive --------- */
{
	const take = buildTake();
	// An unrelated delta key on the LEFT hand at the same frames.
	for (let f = 21; f <= 29; f += 1) {
		take.viewAt(f);
		const chain = take.chains.get("leftHand");
		solveIk(chain, handAt(take, "leftHand").add(new THREE.Vector3(0, 0.06, 0.03)));
		take.setEntries(new Map([[f, bakeIkDragKey(take.chains, take.fkJoints, f, ["leftHand"], () => take.poseClip(f))]]));
	}
	const leftKeys = new Map([...take.state.keys].map(([f, entry]) => [f, entry.get("leftHand")]));
	const target = captureRangePinTarget({ chains: take.chains, track: "rightHand", frame: 21, applyFrame: take.viewAt });
	const pin = normalizeRangePin({ id: "pin-b", track: "rightHand", startFrame: 21, endFrame: 29, blend: PIN_BLEND, target });
	const first = take.apply(pin);
	take.setEntries(first.entries);
	const sample = () => {
		const out = [];
		for (let f = 12; f <= 38; f += 1) {
			take.viewAt(f);
			out.push(...chainWorld(take, "rightHand"), ...chainWorld(take, "leftHand"));
		}
		return out;
	};
	const once = sample();
	// Re-applying with the pin's own keys still in the layer must solve against
	// the same layer (they are held out while posing).
	const again = take.apply(pin);
	const sameKeys = (a, b) => [...a.entries].every(([f, entry]) => {
		const ka = entry.get("rightHand");
		const kb = b.entries.get(f)?.get("rightHand");
		// Exact: the same layer and the same solve must give the same bits.
		return kb && ka.q.every((q, i) => q.equals(kb.q[i])) && ka.baseQ.every((q, i) => q.equals(kb.baseQ[i]));
	});
	check("(4) re-apply over its own keys bakes the same keys", sameKeys(first, again));
	const removed = removeRangePinKeys(take.state, "pin-b");
	check("(4) removeRangePinKeys removes the 9 pin keys", removed === 9, `removed=${removed}`);
	check("(4) no pin-b key remains", [...take.state.keys.values()].every((entry) => [...entry.values()].every((key) => key.pin !== "pin-b")));
	check("(4) the unrelated left-hand keys are intact (same objects, same frames)",
		take.state.keys.size === leftKeys.size && [...leftKeys].every(([f, key]) => take.state.keys.get(f)?.get("leftHand") === key));
	check("(4) removing an absent pin removes nothing", removeRangePinKeys(take.state, "pin-b") === 0 && removeRangePinKeys(take.state, "nope") === 0);
	const second = take.apply(pin);
	take.setEntries(second.entries);
	check("(4) apply -> remove -> apply bakes the same keys as one apply", sameKeys(first, second));
	const twice = sample();
	const drift = Math.max(...twice.map((p, i) => p.distanceTo(once[i])));
	check("(4) apply -> remove -> apply poses equal one apply (< 1e-9 m)", drift < 1e-9, `drift=${drift.toExponential(2)} m`);
	{
		// A frame whose only track was the pin's disappears with it.
		const solo = createIkState();
		solo.keys.set(5, new Map([["rightHand", { q: null, p: null, pin: "x" }]]));
		solo.keys.set(6, new Map([["rightHand", { q: null, p: null, pin: "x" }], ["leftHand", { q: null, p: null }]]));
		removeRangePinKeys(solo, "x");
		check("(4) a frame left empty is deleted, a shared frame keeps its other track", !solo.keys.has(5) && [...solo.keys.get(6).keys()].join() === "leftHand");
	}
}

/* --- (5) object-space pin on an object walking +5 cm per frame ------------- */
{
	const take = buildTake();
	take.poseClip(21);
	const start = handAt(take);
	// A real object path (src/object-path.js): 1.2 m/s at 24 fps = 5 cm/frame
	// along +X, facing its travel (yaw 90 deg), passing the hand at frame 21.
	const x0 = start.x - 21 * 0.05;
	const object = { id: "box", x: x0, y: start.y, z: start.z, rot: 0, path: { points: [{ x: x0, y: start.y, z: start.z }, { x: x0 + 10, y: start.y, z: start.z }], speed: 1.2 } };
	const take2 = { frameCount: 400, fps: FPS };
	const objectWorldMatrix = (objectId, frame) => {
		if (objectId !== "box") return null;
		const at = objectTransformAt(object, frame, take2);
		return new THREE.Matrix4().compose(new THREE.Vector3(at.x, at.y, at.z),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ((at.rot ?? 0) * Math.PI) / 180, 0)), new THREE.Vector3(1, 1, 1));
	};
	const target = captureRangePinTarget({ chains: take.chains, track: "rightHand", frame: 21, applyFrame: take.viewAt, space: "object", objectId: "box", objectWorldMatrix });
	check("(5) object target is stored in object-local space", target.space === "object" && target.objectId === "box" && target.local.length === 3);
	const pin = normalizeRangePin({ id: "pin-obj", track: "rightHand", startFrame: 21, endFrame: 29, blend: PIN_BLEND, target }, { clipFrames: CLIP_FRAMES });
	const t21 = rangePinTargetWorld(pin, 21, { objectWorldMatrix });
	const t29 = rangePinTargetWorld(pin, 29, { objectWorldMatrix });
	check("(5) the target starts on the frame-21 hand", t21.distanceTo(start) < 1e-9, mm(t21.distanceTo(start)));
	check("(5) the target travels 40 cm along +X over 21..29", Math.abs(t29.x - t21.x - 0.4) < 1e-9 && Math.abs(t29.y - t21.y) < 1e-9 && Math.abs(t29.z - t21.z) < 1e-9, `${t29.clone().sub(t21).toArray().map((n) => n.toFixed(4))}`);
	const result = take.apply(pin, objectWorldMatrix);
	take.setEntries(result.entries);
	let worst = 0;
	for (let f = 21; f <= 29; f += 1) {
		take.viewAt(f);
		worst = Math.max(worst, handAt(take).distanceTo(rangePinTargetWorld(pin, f, { objectWorldMatrix })));
	}
	check("(5) effector tracks the moving object target within 1 mm", worst < 0.001, `worst=${mm(worst)}; residuals ${result.residuals.map((r) => mm(r.errorM)).join(" ")}`);
	let missing = null;
	try { rangePinTargetWorld(pin, 21, { objectWorldMatrix: () => null }); } catch (error) { missing = error.code; }
	check("(5) an object without a transform is a typed error", missing === "OBJECT_UNAVAILABLE", `code=${missing}`);
}

/* --- (6) unreachable target ------------------------------------------------- */
{
	const take = buildTake();
	take.poseClip(21);
	const far = handAt(take).add(new THREE.Vector3(0, 0, 2));
	const pin = normalizeRangePin({ id: "pin-far", track: "rightHand", startFrame: 21, endFrame: 29, blend: PIN_BLEND, target: { space: "world", position: far.toArray() } });
	const result = take.apply(pin);
	check("(6) a residual per frame", result.residuals.length === 9);
	check("(6) residual > 0.5 m on every frame", result.residuals.every((r) => r.errorM > 0.5), result.residuals.map((r) => r.errorM.toFixed(3)).join(" "));
	check("(6) no NaN in residuals or keys", result.residuals.every((r) => Number.isFinite(r.errorM)) && [...result.entries.values()].every((entry) => finiteKey(entry.get("rightHand"))));
	take.setEntries(result.entries);
	let finite = true;
	for (let f = 15; f <= 35; f += 1) {
		take.viewAt(f);
		if (!chainWorld(take, "rightHand").every((p) => [p.x, p.y, p.z].every(Number.isFinite))) finite = false;
	}
	check("(6) evaluated poses stay finite", finite);
}

/* --- (7) JSON round trip + schema; normalizeRangePin refusals --------------- */
{
	const setIkKey = studioActionDeclaration("character.setIkKey").input;
	const entry = pinned.result.entries.get(25);
	const tracks = ikKeyJson(entry);
	check("(7) ikKeyJson writes pin and blend", tracks.rightHand.pin === "pin-a" && tracks.rightHand.blend === PIN_BLEND, JSON.stringify(Object.keys(tracks.rightHand)));
	const args = { characterId: "char-a", frame: 25, tracks };
	let validated = null;
	try { validated = validateStudioSchema(setIkKey, args); } catch (error) { check("(7) schema accepts pin", false, error.message); }
	const back = validated ? ikTrackKeyFromJson(validated.tracks.rightHand) : null;
	check("(7) setIkKey round trip keeps pin and blend", back?.pin === "pin-a" && back?.blend === PIN_BLEND);
	check("(7) round trip keeps the delta", back?.baseQ?.length === 3 && back.q.every((q, i) => q.angleTo(entry.get("rightHand").q[i]) < 1e-6));
	const plain = ikTrackKeyFromJson(ikKeyJson(new Map([["hips", { q: [new THREE.Quaternion()], p: null }]])).hips);
	check("(7) a key without pin stays without", !("pin" in plain));
	for (const bad of [42, "", "x".repeat(65), true]) {
		let refused = false;
		try { validateStudioSchema(setIkKey, { ...args, tracks: { rightHand: { ...tracks.rightHand, pin: bad } } }); } catch (error) { refused = error?.code === "INVALID_ARGUMENT"; }
		check(`(7) schema refuses pin ${JSON.stringify(bad).slice(0, 12)}`, refused);
	}
	let accepted = true;
	try { validateStudioSchema(setIkKey, { ...args, tracks: { rightHand: { ...tracks.rightHand, pin: "x".repeat(64) } } }); } catch { accepted = false; }
	check("(7) schema accepts a 64-character pin", accepted);

	const good = { id: "p", track: "leftFoot", startFrame: 3, endFrame: 3, blend: 1, target: { space: "object", objectId: "box", local: [0, 0.1, 0] } };
	const codeOf = (pin, options) => { try { normalizeRangePin(pin, options); return "ok"; } catch (error) { return error.code; } };
	const copy = normalizeRangePin(good, { clipFrames: 4 });
	check("(7) normalizeRangePin returns a validated copy", copy !== good && copy.target !== good.target && copy.target.local !== good.target.local && JSON.stringify(copy) === JSON.stringify(good));
	check("(7) unknown track is refused", codeOf({ ...good, track: "head" }) === "UNKNOWN_TRACK");
	check("(7) start > end is refused", codeOf({ ...good, startFrame: 5, endFrame: 4 }) === "BAD_RANGE");
	check("(7) end past the clip is refused", codeOf(good, { clipFrames: 3 }) === "OUT_OF_RANGE" && codeOf({ ...good, startFrame: -1 }) === "OUT_OF_RANGE");
	check("(7) bad targets are refused", ["world", "object", "screen"].every((space) => codeOf({ ...good, target: { space, position: [0, NaN, 0], objectId: "", local: [1, 2] } }) === "BAD_TARGET"));
	check("(7) bad blend / id are refused", codeOf({ ...good, blend: 0 }) === "BAD_PIN" && codeOf({ ...good, blend: 2.5 }) === "BAD_PIN" && codeOf({ ...good, id: "" }) === "BAD_PIN");
}

/* --- (8) a walking root needs anticipatory body reach, not a longer arm --- */
{
	const take = buildTake({ walkCm: 5 });
	const target = captureRangePinTarget({ chains: take.chains, track: "rightHand", frame: 21, applyFrame: take.viewAt });
	const legacy = { id: "walking", track: "rightHand", startFrame: 21, endFrame: 29, blend: 6, target };
	const json = (result) => JSON.stringify([...result.entries].map(([f, entry]) => [f, ikKeyJson(entry)]));
	const old = take.apply(legacy);
	const limb = take.apply(normalizeRangePin({ ...legacy, reach: "limb" }));
	check("(8) explicit limb reach is bit-identical to an absent reach field", json(old) === json(limb));
	// Captured from 457e0c7 before changing the solver: compare all serialized
	// machine-consumed key values, not just two paths through the new code.
	const legacyHash = createHash("sha256").update(json(old)).digest("hex");
	// Re-pinned: exactHinge now keeps the current hinge axis, so the knee side can no longer flip (was 34aa5972...).
	check("(8) legacy walking keys match the pinned exactHinge output", legacyHash === "91190fbe936f015a3717300ae9c5502baaa5b924bd1e8527c249321fe277bb98", legacyHash);
	check("(8) fixture: limb-only walk leaves the target by > 1 cm", Math.max(...old.residuals.map((r) => r.errorM)) > 0.01);
	const pin = normalizeRangePin({ ...legacy, reach: "body" });
	check("(8) normalization preserves body reach", pin.reach === "body");
	let badReach = false;
	try { normalizeRangePin({ ...legacy, reach: "stretch" }); } catch (e) { badReach = e.code === "BAD_PIN"; }
	check("(8) normalization refuses unknown reach modes", badReach);
	const held = rigSnapshot(take.rig);
	const result = take.apply(pin);
	check("(8) body bake restores the rig and leaves the layer alone", rigUnchanged(held) && take.state.keys.size === 0);
	take.setEntries(result.entries);
	check("(8) body bake includes hips and both leg delta keys on every frame", [...result.entries].every(([, entry]) => {
		const hips = entry.get("hips");
		return hips?.p && hips.basePos && hips.q === null && ["leftFoot", "rightFoot", "rightHand"].every((id) => entry.get(id)?.baseQ?.length === 3)
			&& [...entry.values()].every((k) => k.pin === pin.id && k.blend === pin.blend);
	}));
	let maxHand = 0, maxFeet = 0, maxOffsetStep = 0, lastOffset = null;
	for (let f = 21; f <= 29; f++) {
		take.poseClip(f);
		const feet = [handAt(take, "leftFoot"), handAt(take, "rightFoot")];
		const hips = take.fkJoints.get("hips").bone.getWorldPosition(v());
		take.viewAt(f);
		maxHand = Math.max(maxHand, handAt(take).distanceTo(v().fromArray(target.position)));
		maxFeet = Math.max(maxFeet, handAt(take, "leftFoot").distanceTo(feet[0]), handAt(take, "rightFoot").distanceTo(feet[1]));
		const offset = take.fkJoints.get("hips").bone.getWorldPosition(v()).sub(hips);
		if (lastOffset) maxOffsetStep = Math.max(maxOffsetStep, offset.distanceTo(lastOffset));
		lastOffset = offset;
	}
	console.log(`walking body maxima: hand=${mm(maxHand)} feet=${mm(maxFeet)} extra hips step=${mm(maxOffsetStep)}`);
	check("(8) walking hand stays within 1 cm on every frame", maxHand < 0.01, mm(maxHand));
	check("(8) both feet stay within 1 cm of clip positions", maxFeet < 0.01, mm(maxFeet));
	check("(8) hips correction changes by at most 1 cm per frame", maxOffsetStep <= 0.010001, mm(maxOffsetStep));
	check("(8) residuals report post-compensation hand and feet errors", result.residuals.every((r) => r.errorM < 0.01 && r.feetErrorM < 0.01));
	check("(8) body re-apply is bit-identical", json(result) === json(take.apply(pin)));
	check("(8) all body keys survive the setIkKey JSON/schema round trip", [...result.entries].every(([f, entry]) => {
		const tracks = ikKeyJson(entry);
		validateStudioSchema(studioActionDeclaration("character.setIkKey").input, { characterId: "char-a", frame: f, tracks });
		return [...entry].every(([id, key]) => {
			const back = ikTrackKeyFromJson(tracks[id]);
			return back.pin === key.pin && back.blend === key.blend
				&& (id === "hips" ? back.q === null && back.p.equals(key.p) && back.basePos.equals(key.basePos)
					: back.keepTranslations === true && back.q.every((q, i) => q.angleTo(key.q[i]) < 1e-6) && back.baseQ.every((q, i) => q.angleTo(key.baseQ[i]) < 1e-6));
		});
	}));
	let edgeError = 0, outsideError = 0;
	for (const f of [15, 18, 20, 30, 32, 35]) {
		take.poseClip(f);
		const hips = take.fkJoints.get("hips").bone;
		const raw = hips.position.clone(), rawQ = hips.quaternion.clone();
		const edge = result.entries.get(f < 21 ? 21 : 29).get("hips");
		const weight = correctionWeight(take.state.keys, "hips", f, BLEND);
		const expected = raw.clone().addScaledVector(edge.p.clone().sub(edge.basePos), weight);
		const before = rigSnapshot(take.rig);
		take.viewAt(f);
		edgeError = Math.max(edgeError, hips.position.distanceTo(expected), hips.quaternion.angleTo(rawQ));
		if (weight === 0) outsideError = Math.max(outsideError, ...before.map(([node, p, q]) => node.position.distanceTo(p) + node.quaternion.angleTo(q)));
	}
	check("(8) hips edges ease only the translation delta", edgeError < 1e-6, String(edgeError));
	check("(8) outside the body pin blend the whole clip is unchanged", outsideError < 1e-6, String(outsideError));
	const removed = removeRangePinKeys(take.state, pin.id);
	check("(8) removing body pin removes hips and legs too", removed === 36 && take.state.keys.size === 0, `removed=${removed}`);
}

/* --- (9) world/local conversion, object rebuild, foot pins, infeasibility --- */
{
	const take = buildTake({ walkCm: 5 });
	take.rig.rotation.y = 0.8;
	take.rig.position.set(1.2, 0, -0.7);
	let objectX = 0;
	const objectWorldMatrix = () => new THREE.Matrix4().makeTranslation(objectX, 0, 0);
	const target = captureRangePinTarget({ chains: take.chains, track: "leftHand", frame: 21, applyFrame: take.viewAt, space: "object", objectId: "box", objectWorldMatrix });
	const pin = normalizeRangePin({ id: "yawed-body", track: "leftHand", startFrame: 21, endFrame: 29, blend: 6, reach: "body", target });
	for (const x of [0, 0.2]) {
		objectX = x;
		const result = take.apply(pin, objectWorldMatrix);
		take.setEntries(result.entries);
		let maxHand = 0, maxFeet = 0, reportError = 0;
		for (let f = 21; f <= 29; f++) {
			take.poseClip(f);
			const feet = [handAt(take, "leftFoot"), handAt(take, "rightFoot")];
			take.viewAt(f);
			const handError = handAt(take, "leftHand").distanceTo(rangePinTargetWorld(pin, f, { objectWorldMatrix }));
			const footError = Math.max(handAt(take, "leftFoot").distanceTo(feet[0]), handAt(take, "rightFoot").distanceTo(feet[1]));
			maxHand = Math.max(maxHand, handError); maxFeet = Math.max(maxFeet, footError);
			const r = result.residuals.find((r) => r.frame === f);
			reportError = Math.max(reportError, Math.abs(handError - r.errorM), Math.abs(footError - r.feetErrorM));
		}
		check(`(9) yawed/scaled body object pin at x=${x}: hand and feet within 1 cm`, maxHand < 0.01 && maxFeet < 0.01, `hand=${mm(maxHand)} feet=${mm(maxFeet)}`);
		check(`(9) object rebuild residuals match evaluated keys at x=${x}`, reportError < 1e-7, String(reportError));
	}
}
{
	const take = buildTake({ walkCm: 5 });
	const target = captureRangePinTarget({ chains: take.chains, track: "rightFoot", frame: 21, applyFrame: take.viewAt });
	const pin = normalizeRangePin({ id: "foot-body", track: "rightFoot", startFrame: 21, endFrame: 29, blend: 6, reach: "body", target });
	const result = take.apply(pin);
	take.setEntries(result.entries);
	let maxFoot = 0, maxSupport = 0;
	for (let f = 21; f <= 29; f++) {
		take.poseClip(f);
		const support = handAt(take, "leftFoot");
		take.viewAt(f);
		maxFoot = Math.max(maxFoot, handAt(take, "rightFoot").distanceTo(v().fromArray(target.position)));
		maxSupport = Math.max(maxSupport, handAt(take, "leftFoot").distanceTo(support));
	}
	check("(9) foot pin follows its target while the other foot keeps its clip plant", maxFoot < 0.01 && maxSupport < 0.01, `pin=${mm(maxFoot)} support=${mm(maxSupport)}`);
	check("(9) pinned-foot displacement is not a failed supporting plant", result.residuals.every((r) => r.feetErrorM < 0.01));
}
{
	const take = buildTake({ walkCm: 5 });
	// An already sunk clip makes floor safety and planting incompatible:
	// lifting its pelvis necessarily overextends the straight hanging legs.
	// The assist must honor the measured floor and report the lost plants.
	const poseRaw = (f) => {
		take.poseClip(f);
		take.fkJoints.get("hips").bone.position.y -= 103;
		take.rig.updateMatrixWorld(true);
	};
	const poseLayer = (f) => { poseRaw(f); ikEvaluate(take.chains, take.state, f, take.fkJoints, BLEND); };
	poseRaw(21);
	const pin = { id: "impossible-body", track: "rightHand", startFrame: 21, endFrame: 29, blend: 6, reach: "body", target: { space: "world", position: handAt(take).add(new THREE.Vector3(-3, -3, 2)).toArray() } };
	const result = applyRangePin({ chains: take.chains, fkJoints: take.fkJoints, ikState: take.state, pin, applyRaw: poseRaw, applyLayer: poseLayer });
	take.setEntries(result.entries);
	let maxStep = 0, last = null, maxVertical = 0, minHeight = Infinity, reportError = 0;
	for (let f = 21; f <= 29; f++) {
		poseRaw(f);
		const hips = take.fkJoints.get("hips").bone;
		const raw = hips.getWorldPosition(v());
		const feet = [handAt(take, "leftFoot"), handAt(take, "rightFoot")];
		poseLayer(f);
		const pos = hips.getWorldPosition(v()), offset = pos.clone().sub(raw);
		if (last) maxStep = Math.max(maxStep, offset.distanceTo(last));
		last = offset; maxVertical = Math.max(maxVertical, Math.abs(offset.y)); minHeight = Math.min(minHeight, pos.y);
		const error = Math.max(handAt(take, "leftFoot").distanceTo(feet[0]), handAt(take, "rightFoot").distanceTo(feet[1]));
		reportError = Math.max(reportError, Math.abs(error - result.residuals[f - 21].feetErrorM));
	}
	check("(9) impossible body pin stays finite, floor-safe, vertically limited and smooth", result.residuals.every((r) => Number.isFinite(r.errorM) && Number.isFinite(r.feetErrorM)) && minHeight >= 0.01 && maxVertical <= 0.100001 && maxStep <= 0.010001);
	check("(9) impossible reach is not hidden after compensation", result.residuals.some((r) => r.errorM > 0.01));
	check("(9) impossible planting is reported as measured", result.residuals.some((r) => r.feetErrorM > 0.01) && reportError < 1e-7, `feet residual max=${mm(Math.max(...result.residuals.map((r) => r.feetErrorM)))} discrepancy=${reportError}`);
}

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall range pin checks passed");
