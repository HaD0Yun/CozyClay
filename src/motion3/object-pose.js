// C3. Where a scene object or a group is at a frame: the one place refs, probes, goals, the
// timeline, the take and QA read object poses from. See docs/motion-api-v3.1.md (C3, 7.1, 7.2).
//
// The group (an Empty) is the unit. spec.objects[id] may name a body or a group:
//   hinge  { pivot, axis, channel }                        turns the record (a group: the whole group
//                                                          about the group root) by a keyed angle
//   carry  { prop, grab?, release?, at?, along?, visible?, level? } the record rides prop `prop`'s hand
//   switch { visible?, level? }                            moves nothing: shows/hides and dims the record (C15)
// A carried or hinged group gets ONE track, on the group root (take.objects[groupId]); its parts
// follow through the parent carry that already exists in src/object-travel.js (ancestorsOf /
// ownTravelMatrix). There are no per-part tracks. While the group is in hand (grab..release) its
// track is in world space and the carry from the group's own parent (a table) is cut, so nothing
// is carried twice (the take's `hold` flags, object-travel.js).
//   f < grab              the scene pose
//   grab <= f <= release  follows the prop's hand; without at/along it keeps the transform it had
//                         against the palm axes at grab (no jump); at/along pin an offset (a group: its root, C15)
//   f > release           frozen at the release pose; let go over a body that moves on its own (a seat of a truck the spec
//                         drives with keys, a hinged lid), it rides that body's mover from the release on, keeping its world
//                         pose at the release (riderOf): a lighter put down in the cab leaves with the truck
//   no grab: in hand from frame 0; no release: in hand to the end (PR #14 behaviour)
//   keys (C14, object-keys.js): the object leads and the hand follows; the object is still drawn
//                         in the hand, so what the hand cannot reach shows as a residual (QA)
//   follow { follow, offset?, aim?, visible?, level? }   rides a point of the body every frame (C16, follow.js)
//   free   { keys?, fall?, visible?, level? }             moves on its own: keys, falls (C17, free-motion.js); a carry's
//                         fall puts it where it lands before grab (the hand finds it there) or after release
// Carried objects are OBSTACLES at every frame, at their pose that frame (qa/object-checks.js);
// a follow entry is none.
import { isCarried, isFollow, carriedPose, compose, relative, movesRecord } from "./carried.js";
import { seatsInHand, seatOffset, settleAt, between } from "./seat.js";
import { followPose } from "./follow.js";
import { groupsOf } from "./scene.js";
import { solveFrame } from "./compiler/compile.js";
import { channelsAt } from "./compiler/channels.js";
import { resolveBone } from "./bones.js";
import { isFree, freePoseAt, freeSwungAt, beforeGrab, afterRelease, releaseFall, fallsAfter, corners, topOf, under, TOUCH } from "./free-motion.js";
import { add } from "./compiler/math.js";
import { springRest, springStep, swingOf, swungPose, springLength, springOpts } from "./compiler/spring.js";

/**
 * Body ids that make up `id` in a motionScene: [id] for a body (plus any bodies parented under
 * it), every body under it for a group, [] when the scene knows no such id.
 * @returns {string[]}
 */
export function partsOf(scene, id) {
	const objects = scene?.objects ?? {};
	return Object.keys(objects).filter(k => k === id || objects[k].ancestors?.includes(id));
}

/**
 * True while spec.objects entry `o` holds its record in a hand at absolute frame f
 * (grab <= f <= release; a missing grab is 0, a missing release the last frame).
 */
export function inHandAt(o, f) {
	return isCarried(o) && f >= (o.grab ?? 0) && (o.release === undefined || f <= o.release);
}

/** The scene pose { pos, R } of a body or a group root, or null. */
function restPose(scene, id) {
	return scene?.objects?.[id] ?? groupsOf(scene)[id] ?? null;
}

/** The spec.objects key that moves body or group `id`: itself or its nearest group with a carry, follow or hinge entry (a switch moves nothing), or null. */
export function moverOf(spec, scene, id) {
	return [id, ...(scene?.objects?.[id]?.ancestors ?? groupsOf(scene)[id]?.ancestors ?? [])].find(k => movesRecord(spec.objects?.[k])) ?? null;
}

/** [grab, release] of a carried entry in absolute frames of `out` (after a retime). */
export function spanOf(out, o) {
	const map = f => (out.timeMap ? Math.round(out.timeMap(f)) : f);
	return [map(o.grab ?? 0), o.release === undefined ? out.frameCount - 1 : map(o.release)];
}

/** Without at/along a grabbed body, and a group, keeps its grab-frame palm offset; at/along pin one (a kit root, C15). */
const keepsOffset = (scene, id, o) => o.at === undefined && o.along === undefined && ((!scene?.objects?.[id] && !!groupsOf(scene)[id]) || o.grab !== undefined);

const solved = new WeakMap(), poses = new WeakMap(), riders = new WeakMap();

/** What free-motion.js reads of a compile result: the spec, the scene and the time map. */
const freeCtx = out => ({ spec: out.ctx.spec, scene: out.ctx.scene, timeMap: out.timeMap });

/**
 * Where a carried body or group `id` (or a part of one) rests at absolute f before its grab, and where the hand took
 * it from after: its scene pose, or where a fall before the grab left it (C17). null when no carry moves it.
 */
export function restingAt(out, id, f) {
	const { spec, scene } = out.ctx, mover = moverOf(spec, scene, id), o = spec.objects?.[mover];
	if (!isCarried(o)) return null;
	const root = beforeGrab(freeCtx(out), mover, o, f, spanOf(out, o)[0]);
	return root && (mover === id ? root : compose(root, relative(restPose(scene, mover), restPose(scene, id))));
}

/**
 * The spec.objects key a carry `id` (entry o) rides after its release: the key that moves the highest body under the
 * record's centre at the release frame, when that key moves on its own (keys, a fall or a hinge; never a hand or a follow)
 * and is not the record itself. null when the carry falls after its release, is never let go, or nothing under it moves.
 */
export function riderOf(out, id) {
	if (!riders.has(out)) riders.set(out, new Map());
	const cache = riders.get(out);
	if (cache.has(id)) return cache.get(id);
	const { spec, scene } = out.ctx, o = spec.objects?.[id], rest = restPose(scene, id), parts = partsOf(scene, id);
	let best = null;
	if (isCarried(o) && o.release !== undefined && rest && parts.length) {
		const release = spanOf(out, o)[1];
		if (release < out.frameCount - 1 && !fallsAfter(freeCtx(out), o, release)) {
			const at = carriedAt(out, id, o, release), pts = parts.flatMap(p => corners({ ...compose(at, relative(rest, scene.objects[p])), half: scene.objects[p].half }));
			const low = Math.min(...pts.map(p => p[1])), c = pts.reduce((a, p) => add(a, p), [0, 0, 0]).map(v => v / pts.length);
			for (const [k, body] of Object.entries(scene.objects)) {
				const mover = parts.includes(k) ? null : moverOf(spec, scene, k), entry = spec.objects?.[mover];
				if (!mover || mover === id || isCarried(entry) || isFollow(entry)) continue;
				const box = { ...objectPoseAt(out, k, release), half: body.half }, top = topOf(box);
				if (under(box, c) && top <= low + TOUCH && (!best || top > best.top)) best = { mover, top };
			}
		}
	}
	cache.set(id, best?.mover ?? null);
	return best?.mover ?? null;
}

/** The solved frame at absolute f: out.frames, or solved once on demand outside a window (or ahead of the frame being solved). */
export function frameAt(out, f) {
	const own = out.frames[f - (out.f0 ?? 0)];
	if (own) return own;
	if (!solved.has(out)) solved.set(out, new Map());
	const cache = solved.get(out);
	if (!cache.has(f)) cache.set(f, solveFrame(out.ctx, channelsAt(out.baked, f), f));
	return cache.get(f);
}

/** Pose of the record a carried entry moves at in-hand frame f, on that frame's pose s. */
function carriedOn(out, id, o, f, s) {
	const { sk, spec, scene } = out.ctx;
	if (!keepsOffset(scene, id, o)) return carriedPose(sk, spec, s, o);
	// keyed (object-keys.js): the grab-frame offset solved without the keys, which the hand followed. While that
	// grab frame is solved (a hand anchored on the object reads it), the object is where the offset puts it: at rest.
	const seat = seatsInHand(spec, o, scene, id);
	if (o.keys?.length && out.ctx.hold) {
		if (out.ctx.hold.attaching(id)) return restPose(scene, id);
		const held = compose(carriedPose(sk, spec, s, { prop: o.prop }, seat), out.ctx.hold.attachAt(id, f)), grab = spanOf(out, o)[0];
		return seat ? between(restingAt(out, id, grab) ?? restPose(scene, id), held, settleAt(grab, f)) : held;
	}
	const palm = st => carriedPose(sk, spec, st, { prop: o.prop }, seat), grab = spanOf(out, o)[0];
	const taken = relative(palm(grab === f ? s : frameAt(out, grab).s), restingAt(out, id, grab) ?? restPose(scene, id));
	// on the grasp path the object eases into its seat against the palm (seat.js)
	return seat ? between(compose(palm(s), taken), compose(palm(s), seatOffset(sk, spec, scene, id, o, taken)), settleAt(grab, f)) : compose(palm(s), taken);
}

/** Pose of the record a carried entry moves, cached on the solved frame. */
function carriedAt(out, id, o, f) {
	const fr = frameAt(out, f);
	if (!poses.has(fr)) poses.set(fr, new Map());
	const cache = poses.get(fr);
	if (!cache.has(id)) cache.set(id, carriedOn(out, id, o, f, fr.s));
	return cache.get(id);
}

/**
 * World pose { pos, R } of the record spec.objects[id] moves (a body or a group root) at
 * absolute frame f: carried, hinged (out.ctx.objectsAt for a body; the group root turned by
 * the same hinge) or still. null for an id the scene does not know. `now` ({ s, diag, c }) is
 * frame f while the compiler solves it (an object anchor): its pose so far stands in for the
 * solved frame, so the carrying hand must already be solved (compiler/anchors.js).
 */
export function rootPoseAt(out, id, f, now = null) {
	const o = out.ctx.spec.objects?.[id];
	if (o?.spring && isFree(o)) return freeSwungAt(freeCtx(out), id, f);
	const pose = basePoseAt(out, id, f, now);
	return o?.spring && pose && isCarried(o) ? swungPose(pose, springAt(out, id, o, f, now ? pose : null)) : pose;
}

const springs = new WeakMap();

/**
 * The swing [tx, tz] of spring carry `id` at absolute f (compiler/spring.js): the solver walks frames 0..f of the
 * record's unswung pose (its anchor). Each frame's state is cached with the solved frame it was read on, and reused
 * while frames 0..k are still those frames (a fix that re-solves a frame starts the walk again there). `nowPose`: the
 * unswung pose of frame f while it is being solved (not cached).
 */
function springAt(out, id, o, f, nowPose) {
	if (!springs.has(out)) springs.set(out, new Map());
	const cache = springs.get(out), f0 = out.f0 ?? 0, fps = out.fps ?? out.ctx.spec.fps ?? 30, { scene } = out.ctx;
	if (!cache.has(id)) cache.set(id, { states: [], keys: [], length: springLength(partsOf(scene, id).flatMap(p => corners(scene.objects[p]))) });
	const c = cache.get(id), opts = springOpts(o.spring, fps, c.length), release = spanOf(out, o)[1];
	const end = nowPose ? f - 1 : f;
	let k = 0;
	while (k <= end && k < c.states.length && c.keys[k] === (out.frames[k - f0] ?? null)) k += 1;
	c.states.length = k; c.keys.length = k;
	// let go and fallen (free-motion.js releaseFall): from its landing it rests and hangs from nothing, no swing carried on
	const step = (prev, j, pose) => {
		const fell = j > release ? releaseFall(...releaseArgs(out, id, o, j, release)) : null, s = springStep(prev, (pose ?? fell?.pose ?? basePoseAt(out, id, j)).pos, opts);
		return fell?.landed ? { ...s, th: [0, 0], w: [0, 0] } : s;
	};
	for (; k <= end; k++) {
		c.states[k] = step(k ? c.states[k - 1] : springRest(), k, null);
		c.keys[k] = out.frames[k - f0] ?? null;
	}
	const last = end >= 0 ? c.states[end] : springRest();
	return swingOf(nowPose ? step(last, f, nowPose) : last);
}

/** The arguments of free-motion.js afterRelease / releaseFall for carry `id` (entry o) at f past its release frame. */
const releaseArgs = (out, id, o, f, release) => [freeCtx(out), id, o, f, release, carriedAt(out, id, o, release), release > 0 ? carriedAt(out, id, o, release - 1) : null];

/** rootPoseAt before a spring swings it: where the keys and the hand put it (qa/key-checks.js measures the keys on it). */
export function basePoseAt(out, id, f, now = null) {
	const { spec, scene } = out.ctx, o = movesRecord(spec.objects?.[id]) ? spec.objects[id] : undefined, rest = restPose(scene, id);
	if (isFollow(o)) return followPose(now ? { ...out, f0: f, frames: [now] } : out, o, f);
	if (isCarried(o) && (rest || !keepsOffset(scene, id, o))) {
		const [grab, release] = spanOf(out, o), g = Math.max(grab, Math.min(f, release));
		if (f < grab && rest) return restingAt(out, id, f);
		const after = f > release ? afterRelease(...releaseArgs(out, id, o, f, release)) : null;
		if (after) return after;
		const by = f > release ? riderOf(out, id) : null;
		if (by) { const at = carriedAt(out, id, o, release); return compose(rootPoseAt(out, by, f), relative(rootPoseAt(out, by, release), at)); }
		return now && g === f ? carriedOn(out, id, o, f, now.s) : carriedAt(out, id, o, g);
	}
	if (!rest) return null;
	if (isFree(o)) return freePoseAt(freeCtx(out), id, f);
	if (o && scene.objects[id]) return out.ctx.objectsAt(f)[id];
	if (o) { const part = partsOf(scene, id)[0], box = out.ctx.objectsAt(f)[part]; return compose(box, relative(scene.objects[part], rest)); }
	return { pos: rest.pos, R: rest.R };
}

/**
 * The boxes of `id` at absolute frame f of a compile result `out` (out.ctx.scene, out.ctx.spec):
 * [{ id: partId, pos, R, half }] for a body ([its own box]) or a group (every part box, moved by
 * the group root's pose at f). null when f is outside the compiled window (out.f0 ..
 * out.f0 + out.frames.length - 1) or the scene has no such id.
 * @returns {{ id: string, pos: number[], R: number[][], half: number[] }[] | null}
 */
export function objectBoxesAt(out, id, f) {
	const fr = out.frames?.[f - (out.f0 ?? 0)], scene = out.ctx.scene, parts = partsOf(scene, id);
	if (!fr || !parts.length) return null;
	return parts.map(p => { const pose = objectPoseAt(out, p, f); return { id: p, pos: pose.pos, R: pose.R, half: scene.objects[p].half }; });
}

/**
 * The hand ("l" | "r") body or group `id` rides at absolute frame f, so a pose of that frame needs that arm solved
 * first: a carry while in hand (grab..release; after release it is frozen at a frame already solved), a follow on a
 * joint of that arm or a point of its prop. null otherwise.
 */
export function handOf(out, id, f) {
	const { spec, scene, sk } = out.ctx, entry = spec.objects?.[moverOf(spec, scene, id)];
	if (isCarried(entry)) { const [grab, release] = spanOf(out, entry); return f >= grab && f <= release ? spec.props?.[entry.prop]?.hand ?? null : null; }
	if (!isFollow(entry)) return null;
	const [kind, rest = ""] = String(entry.follow).split(/:(.*)/s);
	if (kind === "prop") return spec.props?.[rest.split(".")[0]]?.hand ?? null;
	const arm = (kind === "joint" || kind === "bone") && /^(Left|Right)(Arm|ForeArm|Hand)/.exec(resolveBone(sk, rest).bone ?? "");
	return arm ? (arm[1] === "Left" ? "l" : "r") : null;
}

/**
 * World pose { pos, R } of a body (its base pivot) or a group (its origin) at absolute frame f:
 * the one pose object refs, probes, goals, QA and object anchors read. A carried or follow record
 * is where it rides, a hinged one turned, any other at its scene pose. `now` as rootPoseAt.
 * null for an id the scene does not know.
 */
export function objectPoseAt(out, id, f, now = null) {
	const { spec, scene } = out.ctx, rest = restPose(scene, id), mover = moverOf(spec, scene, id), entry = spec.objects?.[mover];
	if (!rest) return null;
	if (isCarried(entry) || isFollow(entry) || isFree(entry)) { const root = rootPoseAt(out, mover, f, now); return root && compose(root, relative(restPose(scene, mover), rest)); }
	if (!mover) return { pos: rest.pos, R: rest.R };
	if (scene.objects[id]) return out.ctx.objectsAt(f)[id] ?? rest;
	return mover === id ? rootPoseAt(out, id, f) : compose(rootPoseAt(out, mover, f), relative(restPose(scene, mover), rest));
}
