// Public entry of the handle poser core: createPoser({ network, skeleton }) -> { solve, solveEffectors, prepare }.
// A solve runs encode, network, decode, IK, floor and output in that order, then writes bones; only the network call
// is asynchronous.
import { decodePose, outputPose } from "./decode.js";
import { buildEffectors, encodeQuery, floorShift } from "./encode.js";
import { hardFloor } from "./floor.js";
import { effectorsFromSends } from "./handles.js";
import { createIk } from "./ik.js";
import { prepareCharacter } from "./rig.js";
import { writePose } from "./retarget.js";
import { makeSkeleton, restLayout } from "./skeleton.js";
import { mixamoJointToBone } from "./ybot.js";

const now = () => globalThis.performance?.now() ?? Date.now();

/**
 * `network`: `{ run(inputs) -> Promise<{ draft, rot6d }> }` (network.js); `skeleton`: skeleton.json's shape
 * (default: the bundled one). Options per solve: `floor` (IK floor rows, hard floor, toe roll; default true),
 * `airborne` (lift handles held above standing height off the floor; default true), `toeTips` (default true when the character has them).
 */
export function createPoser({ network, skeleton } = {}) {
	if (!network?.run) throw new Error("createPoser: network must have run(inputs)");
	const sk = makeSkeleton(skeleton), ik = createIk(sk), prepared = new WeakMap();

	/** Read-and-write facts for a character (cached per character object); `jointToBone` defaults to Mixamo names. */
	function prepare(character, jointToBone) {
		if (character.boneOf) return character;
		if (!prepared.has(character)) prepared.set(character, prepareCharacter(sk, character, jointToBone ?? mixamoJointToBone(character.bones.map((b) => b.name))));
		return prepared.get(character);
	}

	/**
	 * Everything up to the world-frame pose, from an effector list (world frame) and 29 network lengths. Resolves `{ ok: false, reason, detail }`
	 * for a rejected query (no network call, pose unchanged) or `{ ok: true, ...world output, L, G, P, ikInfo, timings }`.
	 */
	async function solveEffectors(list, lengths, { floor = true, airborne = true, floorHeight = 0, toeTips = null } = {}) {
		const t0 = now();
		const built = buildEffectors(list);
		if (!built.ok) return built;
		const { shift, effectors } = floorShift(built.effectors, floorHeight, { airborne });
		const enc = encodeQuery(sk, effectors, lengths);
		const t1 = now();
		const net = await network.run(enc.inputs);
		const t2 = now();
		const rest = restLayout(sk, lengths);
		const pre = decodePose(sk, net.draft, net.rot6d, rest);
		const solved = ik.solve(pre.L, pre.root, rest, enc.rows, { floor });
		const t3 = now();
		const final = floor ? hardFloor(sk, solved.L, solved.root, rest, { toeTips }) : solved;
		const world = outputPose({ ...final, root: solved.root }, enc.centroid, shift, enc.rows);
		const t4 = now();
		return {
			ok: true, ...world, L: final.L, G: final.G, P: final.P, effectors: built.effectors, shift, centroid: enc.centroid,
			ikInfo: solved.info, warnings: built.positions < 3 ? ["few-position-effectors"] : [],
			timings: { encodeMs: t1 - t0, networkMs: t2 - t1, ikMs: t3 - t2, floorMs: t4 - t3 },
		};
	}

	/**
	 * Full solve for handle sends (handles.js) on a character (plain character data or a prepared one). Adds `bones`
	 * (per-bone transforms to write, retarget.js) and `pins` to solveEffectors' result. A body outside the network's
	 * size range is solved at `rig.size` times smaller and its positions scaled back, so results are in the caller's metres.
	 */
	async function solve(sends, character, options = {}) {
		const started = now(), rig = prepare(character), k = rig.size ?? 1;
		const { floor = true, toeTips = true } = options;
		const tips = floor && toeTips ? rig.toeTips : null;
		const result = await solveEffectors(resized(effectorsFromSends(sends), 1 / k), rig.network, {
			...options, floorHeight: rig.floorHeight / k, toeTips: k === 1 || !tips ? tips : tips.map((t) => t.map((v) => v / k)),
		});
		if (!result.ok) return result;
		if (k !== 1) scaleResult(result, k);
		const t = now();
		const written = writePose(rig, { joints: result.joints, G: result.G }, result.effectors, { floor });
		result.timings.writeMs = now() - t;
		result.timings.totalMs = now() - started;
		return { ...result, bones: written.bones, pins: written.pins };
	}

	return { skeleton: sk, prepare, solve, solveEffectors };
}

/** Effectors with their target points multiplied by `f` (rotations have none); the same list when `f` is 1. */
function resized(effectors, f) {
	return f === 1 ? effectors : effectors.map((e) => (e.target ? { ...e, target: e.target.map((v) => v * f) } : e));
}

/** Scale a solve made on a resized body back to the caller's size: positions, distances and effector targets. */
function scaleResult(result, k) {
	for (const key of ["joints", "root", "P", "centroid"]) result[key] = result[key].map((v) => v * k);
	result.shift *= k;
	result.errAfterCm *= k;
	result.belowFloorCm *= k;
	for (const key of Object.keys(result.ikInfo ?? {})) if (key.endsWith("Cm")) result.ikInfo[key] *= k;
	result.effectors = resized(result.effectors, k);
}
