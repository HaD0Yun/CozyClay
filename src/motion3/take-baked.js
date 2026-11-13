// Fix keys merged into an installed take v3 (Pose mode's Merge, domains/motion/fix-islands.js mergeFixKeys): the take's own
// frames rewritten, so merged keys ARE the motion (the next keys start from it, on a clean row).
// The compiled take is never touched and a saved take is still its source (take-source.js), so the merge is kept as
// patches beside it: { bones: [name], frames: [source frame], rot: [x, y, z, w per frame per bone], hips?: [x, y, z per
// frame] }, in SOURCE frames (before the timing edit, take-edit.js) so a later cut or speed change carries them along.
// applyBaked writes them over a copy of the compiled arrays, in the order they were merged.
import { isIdentityEdit, normalizeTakeEdit, takeEditLayout } from "./take-edit.js";

const round = value => Math.round(value * 1e6) / 1e6;

function nlerp(a, ia, b, ib, t, out) {
	const sign = a[ia] * b[ib] + a[ia + 1] * b[ib + 1] + a[ia + 2] * b[ib + 2] + a[ia + 3] * b[ib + 3] < 0 ? -1 : 1;
	let n = 0;
	for (let k = 0; k < 4; k++) { out[k] = a[ia + k] * (1 - t) + b[ib + k] * sign * t; n += out[k] ** 2; }
	n = Math.sqrt(n) || 1;
	for (let k = 0; k < 4; k++) out[k] /= n;
	return out;
}

/** A patch read on the timeline (`rot` / `hips` hold timeline frames start..end, densely) as a patch in source frames.
 * `edit` is the take's timing edit (null: the timeline is the source); `sourceFrames` the compiled take's frame count. */
export function sourcePatch({ bones, start, end, rot, hips = null }, edit, sourceFrames) {
	const B = bones.length, normalized = normalizeTakeEdit(edit, sourceFrames), frames = [], outRot = [], outHips = hips ? [] : null, q = [0, 0, 0, 1];
	const sample = (source, at) => {
		const i0 = Math.max(start, Math.min(end, Math.floor(at))), i1 = Math.min(end, i0 + 1), t = Math.max(0, Math.min(1, at - i0));
		frames.push(source);
		for (let b = 0; b < B; b++) outRot.push(...nlerp(rot, ((i0 - start) * B + b) * 4, rot, ((i1 - start) * B + b) * 4, t, q).map(round));
		if (hips) for (let k = 0; k < 3; k++) outHips.push(round(hips[(i0 - start) * 3 + k] * (1 - t) + hips[(i1 - start) * 3 + k] * t));
	};
	if (!normalized || isIdentityEdit(normalized, sourceFrames)) for (let f = start; f <= end; f++) sample(f, f);
	else for (const segment of takeEditLayout(normalized)) for (let s = segment.sourceStart; s <= segment.sourceEnd; s++) {
		const at = segment.timelineFrames <= 1 || segment.sourceEnd === segment.sourceStart ? segment.timelineStart
			: segment.timelineStart + ((s - segment.sourceStart) / (segment.sourceEnd - segment.sourceStart)) * (segment.timelineFrames - 1);
		if (at >= start - 1e-6 && at <= end + 1e-6) sample(s, at);
	}
	return { bones: [...bones], frames, rot: outRot, ...(outHips ? { hips: outHips } : {}) };
}

/** Saved patches checked; null when there are none (or they are not patches). */
export function normalizeBaked(value) {
	if (!Array.isArray(value) || !value.length) return null;
	const ok = value.every(patch => patch && Array.isArray(patch.bones) && patch.bones.every(name => typeof name === "string") && Array.isArray(patch.frames) && patch.frames.every(Number.isInteger)
		&& Array.isArray(patch.rot) && patch.rot.length === patch.frames.length * patch.bones.length * 4 && patch.rot.every(Number.isFinite)
		&& (patch.hips === undefined || (Array.isArray(patch.hips) && patch.hips.length === patch.frames.length * 3 && patch.hips.every(Number.isFinite))));
	return ok ? value.map(({ bones, frames, rot, hips }) => ({ bones: [...bones], frames: [...frames], rot: [...rot], ...(hips ? { hips: [...hips] } : {}) })) : null;
}

/** The compiled take with its `baked` patches written in: the same take object when there are none. */
export function applyBaked(take) {
	const baked = take && normalizeBaked(take.baked);
	if (!baked || !take.rot) return take;
	const B = take.bones.length, rot = new Float32Array(take.rot), hips = new Float32Array(take.hips);
	for (const patch of baked) {
		const index = patch.bones.map(name => take.bones.indexOf(name));
		patch.frames.forEach((frame, i) => {
			if (frame < 0 || frame >= take.frameCount) return;
			index.forEach((b, j) => { if (b >= 0) for (let k = 0; k < 4; k++) rot[(frame * B + b) * 4 + k] = patch.rot[(i * patch.bones.length + j) * 4 + k]; });
			if (patch.hips) for (let k = 0; k < 3; k++) hips[frame * 3 + k] = patch.hips[i * 3 + k];
		});
	}
	return { ...take, rot, hips };
}
