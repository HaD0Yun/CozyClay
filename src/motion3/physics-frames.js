// The frames QA measured, rebuilt from an installed take v3 (take.js bakeTake), for the physics overlay
// (physics-view.js). A take keeps local bone turns and the hips in the character's placement frame, plus world
// tracks of the objects it moves; QA read the compiler's `out`: world joint positions per frame, the skeleton and
// the obstacle boxes per frame. takeOut gives that shape back, so the overlay calls QA's own functions (qa/com.js,
// qa/ground.js, qa/style.js) on the pose the viewport plays, and its verdicts are QA's.
//   frames[f].s   { P, R }: fk of the take's frame f, turned by the placement yaw and moved to its position; a take of
//                 a body of another scale (take.scale, motion-v4/track/codec.js) has its joints times that scale
//   objectsAt(f)  the authored records as motion boxes (scene.js), the way compile.js objectTracks lays them out:
//                 a record a carry or a follow moves is not an obstacle; one a free or hinge entry moves stands
//                 where the take's track puts its mover
// Pure: the take and the records in, numbers out; cached per take and records.
import { skeletonFor } from "./rigs/index.js";
import { fk } from "./compiler/skeleton.js";
import { add, apply, mul, ry, matFromQuat } from "./compiler/math.js";
import { motionScene, groupsOf } from "./scene.js";
import { isCarried, isFollow, movesRecord, compose, relative } from "./carried.js";
import { expandUse } from "./skills/index.js";

const cache = new WeakMap();

/** The take's spec with its skills expanded (the checks and objects QA read), or the spec as stored when it cannot expand. */
function expandedSpec(take, sk, scene) {
	try { return expandUse(take.spec ?? {}, { sk, scene, lenient: true }).spec; } catch { return take.spec ?? {}; }
}

/** World pose { pos, R } of track `track` at frame f, or null when it has none there. */
export function trackPose(track, f) {
	if (!track?.pos || !track.quat || f < 0 || (f + 1) * 3 > track.pos.length) return null;
	const p = track.pos, q = track.quat;
	return { pos: [p[f * 3], p[f * 3 + 1], p[f * 3 + 2]], R: matFromQuat([q[f * 4], q[f * 4 + 1], q[f * 4 + 2], q[f * 4 + 3]]) };
}

/** The obstacle boxes of frame f (compile.js objectTracks obstacles, the movers read from the take's tracks). */
function obstaclesAt(take, spec, scene, f) {
	const out = {}, groups = groupsOf(scene);
	for (const [id, o] of Object.entries(scene.objects)) {
		const mover = [id, ...(o.ancestors ?? [])].find(k => movesRecord(spec.objects?.[k])), entry = spec.objects?.[mover];
		if (!entry) { out[id] = o; continue; }
		if (isCarried(entry) || isFollow(entry)) continue;
		const pose = trackPose(take.objects?.[mover], f), rest = scene.objects[mover] ?? groups[mover];
		out[id] = pose && rest ? { ...o, ...compose(pose, relative(rest, o)) } : o;
	}
	return out;
}

/**
 * takeOut(take, objects) -> { frames, ctx: { sk, spec, scene }, objectsAt, fps, f0, frameCount } | null: the `out`
 * QA reads, from take v3 `take` over the authored records `objects`. null for another take or a body motion3 cannot
 * drive. spec is the take's spec with its skills expanded.
 */
export function takeOut(take, objects = []) {
	if (take?.schema !== "cozyclay.take.v3" || !(take.frameCount > 0)) return null;
	const kept = cache.get(take);
	if (kept && kept.objects === objects) return kept.out;
	const sk = skeletonFor(take.rig);
	if (!sk) return null;
	const B = take.bones.length, slot = take.bones.map(name => sk.index[name]), yaw = ry(take.placement?.yaw ?? 0), at = take.placement?.position ?? [0, 0, 0], size = take.scale ?? 1;
	const frames = [];
	for (let f = 0; f < take.frameCount; f++) {
		const quats = sk.names.map(() => [0, 0, 0, 1]);
		for (let b = 0; b < B; b++) if (slot[b] !== undefined) quats[slot[b]] = Array.from(take.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4));
		const local = fk(sk, quats, Array.from(take.hips.subarray(f * 3, f * 3 + 3)));
		frames.push({ s: { P: local.P.map(p => p && add(at, apply(yaw, size === 1 ? p : p.map(v => v * size)))), R: local.R.map(R => R && mul(yaw, R)) } });
	}
	const scene = motionScene(objects), spec = expandedSpec(take, sk, scene), boxes = new Map();
	const objectsAt = f => {
		if (!boxes.has(f)) boxes.set(f, obstaclesAt(take, spec, scene, Math.max(0, Math.min(take.frameCount - 1, f))));
		return boxes.get(f);
	};
	const out = { frames, ctx: { sk, spec, scene }, objectsAt, fps: take.fps ?? 24, f0: 0, frameCount: take.frameCount };
	cache.set(take, { objects, out });
	return out;
}
