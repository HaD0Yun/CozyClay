// Take v3: what the compiler bakes and the player reads. Bone rotations are LOCAL quaternions
// on the Mixamo control bones (the first depth-first bone of each name), so playback writes
// them straight onto the rig; the hips also carry a position. Everything is expressed in the
// character's placement frame (its base position and yaw), in metres, so moving or turning
// the character carries the take with it. Scene objects the motion animates ride along in
// world space: one track per spec.objects key (a group: its root only). A switch entry (C15)
// bakes only vis and lvl, no pos/quat: its record keeps its own place (object-travel.js). A follow
// entry (C16) bakes pos/quat with hold on every frame: its track is world space throughout. A free entry
// (C17) bakes pos/quat (and vis/lvl when it names them), world space, no hold. A carry that rides a moving body after
// its release (object-pose.js riderOf) marks those frames `world`: world space too, though no hand holds it.
import { toLocal } from "./compiler/skeleton.js";
import { sub, apply, ry, quatFromMat, mul } from "./compiler/math.js";
import { isCarried, isFollow, isSwitch } from "./carried.js";
import { isFree } from "./free-motion.js";
import { rootPoseAt, spanOf, riderOf } from "./object-pose.js";

const TAKE_SCHEMA = "cozyclay.take.v3";

/** out = compileMotion(...) result; placement = { position: [x,y,z], yaw } of the character. */
export function bakeTake(sk, out, placement = { position: [0, 0, 0], yaw: 0 }, meta = {}) {
	const F = out.frames.length, B = sk.names.length;
	const rot = new Float32Array(F * B * 4), hips = new Float32Array(F * 3);
	const unYaw = ry(-(placement.yaw ?? 0));
	for (let f = 0; f < F; f++) {
		const s = out.frames[f].s;
		const local = { P: s.P.map(p => apply(unYaw, sub(p, placement.position))), R: s.R.map(R => mul(unYaw, R)) };
		const { quats, hips: h } = toLocal(sk, local);
		quats.forEach((q, b) => rot.set(q, (f * B + b) * 4));
		hips.set(h, f * 3);
	}
	// one track per spec.objects key: a body, or a group root its parts ride (object-pose.js);
	// `hold` marks the frames a carried record is in hand, and every frame of a follow entry (world
	// space: object-travel.js cuts the carry of its own parents there); a switch bakes vis/lvl only
	const objects = {}, f0 = out.f0 ?? 0;
	for (const [id, spec] of Object.entries(out.ctx.spec.objects ?? {})) {
		const carried = isCarried(spec), follows = isFollow(spec), rides = carried || follows, moves = !isSwitch(spec);
		const pos = moves ? new Float32Array(F * 3) : null, quat = moves ? new Float32Array(F * 4) : null;
		const named = rides || !moves || isFree(spec), vis = named && spec.visible ? new Uint8Array(F) : null, hold = rides ? new Uint8Array(F) : null;
		const lvl = named && spec.level ? new Float32Array(F) : null;
		const [grab, release] = carried ? spanOf(out, spec) : [0, 0], world = carried && riderOf(out, id) ? new Uint8Array(F) : null;
		for (let f = 0; f < F; f++) {
			if (vis) vis[f] = (out.baked?.[spec.visible]?.[f + f0] ?? 0) > 0.5 ? 1 : 0;
			if (lvl) lvl[f] = Math.max(0, Math.min(4, out.baked?.[spec.level]?.[f + f0] ?? 1));
			if (!moves) continue;
			const o = rootPoseAt(out, id, f + f0);
			if (!o) continue;
			pos.set(o.pos, f * 3); quat.set(quatFromMat(o.R), f * 4);
			if (hold) hold[f] = follows || (f + f0 >= grab && f + f0 <= release) ? 1 : 0;
			if (world) world[f] = f + f0 > release ? 1 : 0;
		}
		objects[id] = { ...(moves ? { pos, quat } : {}), ...(vis ? { vis } : {}), ...(hold ? { hold } : {}), ...(world ? { world } : {}), ...(lvl ? { lvl } : {}) };
	}
	return { schema: TAKE_SCHEMA, fps: out.fps, frameCount: F, rig: sk.model, bones: sk.names.slice(), rot, hips, objects, placement, ...meta };
}

export function takeHips(take, f) {
	const ff = Math.max(0, Math.min(take.frameCount - 1, Math.round(f))) * 3;
	return [take.hips[ff], take.hips[ff + 1], take.hips[ff + 2]];
}
