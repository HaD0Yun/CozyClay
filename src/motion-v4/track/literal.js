// The v4 "literal compile": a RawTrack (world frame, store.js) is used as written. There is no motion3 solve here:
// compileSpec and runCompileJob never run, so no flow, auto, fixes, retime, repair or thinning can touch it.
//   rawOut           the `out` QA, measure and render read: takeOut plus empty diag/c and the tracked records moved
//   placedTake       the take v3 the editor plays for a character at its placement (bakeTake's frame, take.js)
//   compileRawSource the reload hook: a saved source whose spec carries `raw` back into the installed take
// Browser-safe: the editor loads it through install-action.js and take-source.js.
import { takeOut, trackPose } from "../../motion3/physics-frames.js";
import { groupsOf } from "../../motion3/scene.js";
import { compose, relative } from "../../motion3/carried.js";
import { skeletonFor } from "../../motion3/rigs/index.js";
import { sub, apply, mul, ry, quatFromMat, matFromQuat } from "../../motion3/compiler/math.js";
import { decodeRawTrack } from "./codec.js";

const TAKE_SCHEMA = "cozyclay.take.v3";
const outs = new WeakMap();

/** The scene boxes of frame f: a record with a track (or under a group with one) stands where the track puts it. */
function movedBoxes(scene, groups, tracks, f) {
	const out = {};
	for (const [id, o] of Object.entries(scene.objects)) {
		const mover = [id, ...(o.ancestors ?? [])].find(k => tracks[k]);
		const pose = mover ? trackPose(tracks[mover], f) : null, rest = mover ? scene.objects[mover] ?? groups[mover] : null;
		out[id] = pose && rest ? { ...o, ...compose(pose, relative(rest, o)) } : o;
	}
	return out;
}

/**
 * rawOut(raw, records) -> Out | null: takeOut(raw, records) with diag and c on every frame, ctx.spec the raw's own
 * spec, and objectsAt (also ctx.objectsAt) moving each tracked record and its parts. Cached per (raw, records).
 * takeOut's own cached out is left as it was.
 */
export function rawOut(raw, records = []) {
	const kept = outs.get(raw);
	if (kept && kept.records === records) return kept.out;
	const base = takeOut(raw, records);
	if (!base) return null;
	const scene = base.ctx.scene, groups = groupsOf(scene), tracks = raw.objects ?? {}, boxes = new Map(), last = raw.frameCount - 1;
	const objectsAt = f => {
		const at = Math.max(0, Math.min(last, Math.round(f) || 0));
		if (!boxes.has(at)) boxes.set(at, movedBoxes(scene, groups, tracks, at));
		return boxes.get(at);
	};
	const frames = base.frames.map(frame => ({ ...frame, diag: {}, c: {} }));
	const out = { ...base, frames, objectsAt, ctx: { ...base.ctx, spec: raw.spec ?? base.ctx.spec, objectsAt } };
	outs.set(raw, { records, out });
	return out;
}

/**
 * The take v3 for a character placed at `placement` ({ position, yaw }): the Hips local quat becomes
 * ry(-yaw) * its world rotation and the hips ry(-yaw) * (p - position), as bakeTake writes them; every other bone
 * is local already. Object tracks stay world tracks (`world` set on every frame). meta is spread last.
 */
export function placedTake(raw, placement = { position: [0, 0, 0], yaw: 0 }, meta = {}) {
	const F = raw.frameCount, B = raw.bones.length, h = raw.bones.indexOf("Hips"), yaw = placement.yaw ?? 0, at = placement.position ?? [0, 0, 0];
	const unYaw = ry(-yaw), rot = new Float32Array(raw.rot), hips = new Float32Array(F * 3);
	for (let f = 0; f < F; f++) {
		const i = (f * B + h) * 4, p = [raw.hips[f * 3], raw.hips[f * 3 + 1], raw.hips[f * 3 + 2]];
		// at yaw 0 the world rotation is the local one: keep its bytes
		if (yaw !== 0) rot.set(quatFromMat(mul(unYaw, matFromQuat([raw.rot[i], raw.rot[i + 1], raw.rot[i + 2], raw.rot[i + 3]]))), i);
		hips.set(apply(unYaw, sub(p, at)), f * 3);
	}
	const objects = {};
	for (const [id, track] of Object.entries(raw.objects ?? {})) {
		objects[id] = { pos: new Float32Array(track.pos), quat: new Float32Array(track.quat), world: new Uint8Array(F).fill(1) };
	}
	return { schema: TAKE_SCHEMA, fps: raw.fps ?? 24, frameCount: F, rig: raw.rig, bones: raw.bones.slice(), rot, hips, objects,
		placement: { position: [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0], yaw }, ...meta };
}

/** A saved take source whose spec carries `raw` -> the installed take (with `frames`), as compileTakeSource answers. */
export function compileRawSource(source) {
	const sk = skeletonFor(source?.rig);
	if (!sk || !source.spec?.raw) return null;
	const raw = decodeRawTrack(source.spec.raw, sk);
	const take = placedTake(raw, source.placement ?? undefined, { spec: source.spec, prompt: source.spec.label ?? "" });
	return { ...take, frames: take.frameCount };
}
