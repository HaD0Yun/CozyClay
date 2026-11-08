import * as THREE from "three";
import { createIkState, ikBakeKeyframe, solveHipsTranslateToFloor, solveIk } from "./ik.js";

/**
 * Range pins: hold one limb's effector on a target for every frame of an
 * inclusive range, over the motion that is already there.
 *
 * A pin is data, the keys are its bake. Every frame of the range gets a DELTA
 * IK key on the pinned chain (baseQ = the raw clip rotations of that frame, the
 * same shape fix-collisions and ik-drag write) tagged `pin: pin.id`, with
 * `blend: pin.blend`. The contiguous keys are one island, so ikEvaluate holds
 * them at full weight inside the range and eases out over pin.blend frames.
 *
 * Body reach also bakes a translation-only hips delta and re-planted leg
 * deltas. All participating tracks share the pin's ownership and blend.
 *
 * pin = { id, track, startFrame, endFrame (inclusive), blend, reach?,
 *   // reach: "body" for new pins; absent/"limb" preserves legacy bakes
 *   target: { space: "world", position: [x,y,z] }
 *         | { space: "object", objectId, local: [x,y,z] } }
 */

const RANGE_PIN_TRACKS = Object.freeze(["leftHand", "rightHand", "leftFoot", "rightFoot"]);
const LEGS = ["leftFoot", "rightFoot"];
const REACH_MARGIN = 0.005;
const BODY_STEP = 0.01;
const BODY_VERTICAL = 0.1;

/** Tracks a pin may own. Body pins share the hips/legs, so overlapping body
 * pins cannot independently author them in this single-key-per-track layer. */
export function rangePinTracks(pin) {
	return pin.reach === "body" ? [...new Set([pin.track, "hips", ...LEGS])] : [pin.track];
}
/** Same bounds character.setIkKey accepts for a key's blend and pin id. */
const BLEND_MAX = 240;
const ID_MAX = 64;

class RangePinError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RangePinError";
		this.code = code;
	}
}

const isInt = (value) => Number.isInteger(value);
const isVec3 = (value) => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));

/** Validated copy of a pin, or a RangePinError naming what is wrong.
 * `clipFrames` (frame count) bounds endFrame when given. */
export function normalizeRangePin(pin, { clipFrames = null } = {}) {
	if (!pin || typeof pin !== "object") throw new RangePinError("BAD_PIN", "A pin must be an object.");
	const { id, track, startFrame, endFrame, blend, target, reach } = pin;
	if (reach !== undefined && reach !== "limb" && reach !== "body") throw new RangePinError("BAD_PIN", 'reach must be "limb" or "body".');
	if (typeof id !== "string" || !id.length || id.length > ID_MAX) throw new RangePinError("BAD_PIN", `Pin id must be a string of 1-${ID_MAX} characters.`);
	if (!RANGE_PIN_TRACKS.includes(track)) throw new RangePinError("UNKNOWN_TRACK", `Unknown pin track "${track}" (expected ${RANGE_PIN_TRACKS.join(", ")}).`);
	if (!isInt(startFrame) || !isInt(endFrame)) throw new RangePinError("BAD_RANGE", "startFrame and endFrame must be integers.");
	if (startFrame > endFrame) throw new RangePinError("BAD_RANGE", `startFrame ${startFrame} is after endFrame ${endFrame}.`);
	if (startFrame < 0) throw new RangePinError("OUT_OF_RANGE", `startFrame ${startFrame} is before frame 0.`);
	if (clipFrames != null && endFrame > clipFrames - 1) throw new RangePinError("OUT_OF_RANGE", `endFrame ${endFrame} is past the last frame ${clipFrames - 1}.`);
	if (!isInt(blend) || blend < 1 || blend > BLEND_MAX) throw new RangePinError("BAD_PIN", `blend must be an integer of 1-${BLEND_MAX} frames.`);
	if (!target || typeof target !== "object") throw new RangePinError("BAD_TARGET", "A pin needs a target.");
	let copy;
	if (target.space === "world") {
		if (!isVec3(target.position)) throw new RangePinError("BAD_TARGET", "A world target needs position [x, y, z].");
		copy = { space: "world", position: [...target.position] };
	} else if (target.space === "object") {
		if (typeof target.objectId !== "string" || !target.objectId) throw new RangePinError("BAD_TARGET", "An object target needs objectId.");
		if (!isVec3(target.local)) throw new RangePinError("BAD_TARGET", "An object target needs local [x, y, z].");
		copy = { space: "object", objectId: target.objectId, local: [...target.local] };
	} else {
		throw new RangePinError("BAD_TARGET", `Unknown target space "${target.space}".`);
	}
	return { id, track, startFrame, endFrame, blend, target: copy, ...(reach === undefined ? {} : { reach }) };
}

/** The object's world matrix at `frame`, or a typed error when there is none. */
function objectMatrix(objectWorldMatrix, objectId, frame) {
	const matrix = typeof objectWorldMatrix === "function" ? objectWorldMatrix(objectId, frame) : null;
	if (!matrix?.elements || matrix.elements.length !== 16 || !matrix.elements.every(Number.isFinite)) {
		throw new RangePinError("OBJECT_UNAVAILABLE", `No world transform for object "${objectId}" at frame ${frame}.`);
	}
	return matrix;
}

/** World-space target of `pin` at `frame`. Object targets ride the object's
 * full world transform at that frame (translation, rotation, scale). */
export function rangePinTargetWorld(pin, frame, { objectWorldMatrix = null } = {}) {
	const { target } = pin;
	if (target.space === "world") return new THREE.Vector3().fromArray(target.position);
	return new THREE.Vector3().fromArray(target.local).applyMatrix4(objectMatrix(objectWorldMatrix, target.objectId, frame));
}

/** Snapshot every node's local transform under `rig`; returns the restore. */
function holdRig(rig) {
	const saved = [];
	rig.traverse((node) => saved.push([node, node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
	return () => {
		for (const [node, position, quaternion, scale] of saved) {
			node.position.copy(position);
			node.quaternion.copy(quaternion);
			node.scale.copy(scale);
		}
		rig.updateMatrixWorld(true);
	};
}

function chainFor(chains, track) {
	const chain = chains?.get(track);
	if (!chain) throw new RangePinError("UNKNOWN_TRACK", `The rig has no "${track}" chain.`);
	return chain;
}

/** The pin target that keeps `track`'s effector where it is at `frame`, as
 * posed by `applyFrame(frame)`: a world position, or the same point in the
 * object's local space. The rig is left as it was found. */
export function captureRangePinTarget({ chains, track, frame, applyFrame, space = "world", objectId = null, objectWorldMatrix = null }) {
	const chain = chainFor(chains, track);
	const restore = holdRig(chain.rig);
	let world;
	try {
		applyFrame(frame);
		world = chain.bones[2].getWorldPosition(new THREE.Vector3());
	} finally {
		restore();
	}
	if (space === "world") return { space: "world", position: world.toArray() };
	if (space !== "object") throw new RangePinError("BAD_TARGET", `Unknown target space "${space}".`);
	const inverse = objectMatrix(objectWorldMatrix, objectId, frame).clone().invert();
	return { space: "object", objectId, local: world.applyMatrix4(inverse).toArray() };
}

/** Pull every key tagged `pinId` out of the layer: [[frame, track, key]]. */
function takePinKeys(ikState, pinId) {
	const taken = [];
	for (const [frame, entry] of [...ikState.keys]) {
		for (const [track, key] of [...entry]) {
			if (key?.pin !== pinId) continue;
			taken.push([frame, track, key]);
			entry.delete(track);
		}
		if (!entry.size) ikState.keys.delete(frame);
	}
	return taken;
}

function putPinKeys(ikState, taken) {
	for (const [frame, track, key] of taken) {
		let entry = ikState.keys.get(frame);
		if (!entry) ikState.keys.set(frame, (entry = new Map()));
		entry.set(track, key);
	}
}

/** Remove only the track entries tagged with `pinId` (a frame left empty goes
 * too). Returns how many were removed. */
export function removeRangePinKeys(ikState, pinId) {
	return takePinKeys(ikState, pinId).length;
}

function reachBall(chain, target, margin) {
	const [root, mid, end] = chain.bones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
	return { center: target.clone().sub(root), radius: Math.max(1e-6, root.distanceTo(mid) + mid.distanceTo(end) - margin) };
}

/** Weighted projection onto a reach sphere in world-offset space. Moving Y
 * costs 16x as much as X/Z: prefer a lean, but allow a small crouch to keep
 * straight legs planted. The multiplier has one monotone scalar root. */
function projectReach(offset, { center, radius }) {
	const delta = offset.clone().sub(center);
	if (delta.length() <= radius) return;
	let low = 0, high = 16 * delta.length() / radius;
	for (let i = 0; i < 32; i++) {
		const t = (low + high) / 2;
		const d = Math.hypot(delta.x / (1 + t), delta.y / (1 + t / 16), delta.z / (1 + t));
		if (d > radius) low = t; else high = t;
	}
	offset.copy(center).add(new THREE.Vector3(delta.x / (1 + high), delta.y / (1 + high / 16), delta.z / (1 + high)));
}

/** Look ahead over the whole range: a causal filter cannot both follow a
 * 5 cm/frame walk and introduce at most 1 cm/frame of extra hips motion.
 * Alternating convex projections satisfy limb reach, both leg reaches, a
 * floor-safe +/-10 cm vertical band, and adjacent-offset speed balls. This
 * anticipates an upcoming shortfall rather than snapping on its first frame.
 * Infeasible ranges remain best effort, bounded and honestly residualized. */
function bodyOffsets({ chains, joint, pin, applyLayer, objectWorldMatrix }) {
	const samples = [];
	let needsAssist = false;
	let minY = -BODY_VERTICAL;
	for (let frame = pin.startFrame; frame <= pin.endFrame; frame++) {
		const target = rangePinTargetWorld(pin, frame, { objectWorldMatrix });
		applyLayer(frame);
		const limb = reachBall(chains.get(pin.track), target, REACH_MARGIN);
		needsAssist ||= limb.center.length() > limb.radius;
		const balls = [limb];
		for (const id of LEGS) {
			if (id === pin.track) continue; // the pinned foot goes to its target, not its old plant
			const leg = chains.get(id);
			balls.push(reachBall(leg, leg.bones[2].getWorldPosition(new THREE.Vector3()), 1e-5));
		}
		const y = joint.bone.getWorldPosition(new THREE.Vector3()).y;
		minY = Math.max(minY, (chains.get(pin.track).contactHeights?.Hips ?? 0.01) - y);
		samples.push({ balls, offset: new THREE.Vector3() });
	}
	if (!needsAssist) return null;
	const maxY = Math.max(minY, BODY_VERTICAL); // floor safety wins even on an already sunk clip
	const clampY = (offset) => { offset.y = Math.max(minY, Math.min(maxY, offset.y)); };
	const origin = new THREE.Vector3();
	for (let pass = 0; pass < 256; pass++) {
		let change = 0;
		for (const { balls, offset } of samples) {
			const before = offset.clone();
			for (const ball of balls) projectReach(offset, ball);
			clampY(offset);
			change = Math.max(change, before.distanceTo(offset));
		}
		for (let i = samples.length - 1; i > 0; i--) {
			const a = samples[i - 1].offset, b = samples[i].offset;
			const delta = b.clone().sub(a);
			const limited = delta.clone();
			projectReach(limited, { center: origin, radius: BODY_STEP });
			const correction = delta.sub(limited).multiplyScalar(0.5);
			a.add(correction); b.sub(correction);
			change = Math.max(change, correction.length());
		}
		if (change < 1e-7) break;
	}
	// Guarantee speed/floor limits even when the reach constraints conflict.
	// Convex interpolation within the common vertical band stays floor safe.
	for (let i = 0; i < samples.length; i++) {
		const offset = samples[i].offset;
		clampY(offset);
		if (i > 0) {
			const prev = samples[i - 1].offset;
			const delta = offset.clone().sub(prev).clampLength(0, BODY_STEP);
			offset.copy(prev).add(delta);
		}
	}
	return samples.map(({ offset }) => offset);
}

/**
 * Solve `pin` over the existing motion and return its keys without writing
 * them: { entries: Map(frame → Map(track → key)), residuals: [{frame, errorM}] }.
 *
 * Per frame: `applyRaw(frame)` poses the clip alone and its chain rotations
 * become the key's baseQ; `applyLayer(frame)` poses clip + the current IK
 * layer, which is what the limb is solved over. This pin's own keys are held
 * out of `ikState` while the layer is posed, so a re-apply solves against the
 * same layer as the first apply did. residual is the effector's distance from
 * the target after the solve (nonzero only when the target is out of reach).
 * The rig and the layer are left as they were found.
 */
export function applyRangePin({ chains, fkJoints = null, ikState, pin, applyRaw, applyLayer, objectWorldMatrix = null }) {
	const chain = chainFor(chains, pin.track);
	const entries = new Map();
	const residuals = [];
	const own = takePinKeys(ikState, pin.id);
	const restore = holdRig(chain.rig);
	const effector = new THREE.Vector3();
	try {
		const joint = fkJoints?.get("hips");
		if (pin.reach === "body" && !joint) throw new RangePinError("UNKNOWN_TRACK", "Body reach needs a hips joint.");
		const offsets = pin.reach === "body" ? bodyOffsets({ chains, joint, pin, applyLayer, objectWorldMatrix }) : null;
		const ids = offsets ? rangePinTracks(pin) : [pin.track];
		for (let frame = pin.startFrame; frame <= pin.endFrame; frame += 1) {
			const target = rangePinTargetWorld(pin, frame, { objectWorldMatrix });
			applyRaw(frame);
			const baseQuats = new Map(ids.filter((id) => chains.has(id)).map((id) => [id, chains.get(id).bones.map((bone) => bone.quaternion.clone())]));
			const basePositions = offsets ? new Map([["hips", joint.bone.position.clone()]]) : null;
			applyLayer(frame);
			const plants = new Map();
			if (offsets) {
				for (const id of LEGS) plants.set(id, chains.get(id).bones[2].getWorldPosition(new THREE.Vector3()));
				solveHipsTranslateToFloor(joint, offsets[frame - pin.startFrame], joint.bone.position.clone(), 0, chain.contactHeights, chain.contactRadii);
				for (const [id, plant] of plants) solveIk(chains.get(id), plant, { exactHinge: true });
			}
			solveIk(chain, target, { exactHinge: true });
			chain.bones[2].getWorldPosition(effector);
			const residual = { frame, errorM: effector.distanceTo(target) };
			if (pin.reach === "body") {
				// A pinned foot intentionally leaves its old clip position; only
				// supporting feet count as planting failures.
				residual.feetErrorM = Math.max(0, ...[...plants].filter(([id]) => id !== pin.track).map(([id, plant]) => chains.get(id).bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(plant)));
			}
			residuals.push(residual);
			const scratch = createIkState();
			ikBakeKeyframe(chains, scratch, frame, fkJoints, ids, basePositions, baseQuats);
			const entry = scratch.keys.get(frame);
			for (const key of entry.values()) { key.blend = pin.blend; key.pin = pin.id; }
			entries.set(frame, entry);
		}
	} finally {
		restore();
		putPinKeys(ikState, own);
	}
	return { entries, residuals };
}
