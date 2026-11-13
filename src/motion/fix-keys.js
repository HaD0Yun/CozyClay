// Fix keys: hand edits of an installed take as plain keyframes on a body part (Pose mode's Fix, domains/motion/fix-islands.js,
// TimelineFixIslands.jsx). A track's fix keys (`key.fix.kf`) are either POSE keys (the limb as it was dragged at that frame)
// or REST keys (`fix.rest`: the take itself, no pose stored). At a frame the track plays
//   between a rest key and a pose key: the take plus the key's own correction (its delta over the take's pose at the key
//     frame), eased in by weight w from 0 at the rest key to 1 at the pose key, so the take's own motion carries through;
//   between two pose keys: the keyed poses themselves, eased from one to the next (the take's motion of that limb is
//     replaced there), and before the first / after the last key the nearest key holds.
// So: rest, pose, rest is one correction that eases in and out; two pose keys with the same pose hold it between them;
// more pose keys shape the motion frame by frame.
// The first drag on a part adds its own rest keys KEY_EASE frames each side; every mark after that is one key.
// Pure: ik.js (ikEvaluate), the motion owner and the node tests import it.
import { FIX_PARTS, partOf } from "./fix-weight.js";

const smooth = (t) => t * t * (3 - 2 * t);
export const KEY_EASE = 6;
export const isFixKey = (key) => Boolean(key?.fix?.kf);
export const isRestKey = (key) => Boolean(key?.fix?.kf && key.fix.rest);

/** What `trackId` plays at `frame` from its fix keys: { w, sampled, delta }, or null when the track has no fix keys (or
 * mixes in other keys: those keep the older paths). `delta` is the pose key to ease in as a correction over the take
 * (between a rest key and a pose key); otherwise `sampled` is the keyed pose in ikEvaluate's absolute shape (null when w is 0).
 * An ikState showing the original take (`fixView: "original"`) weighs 0. */
export function fixKeySample(keys, trackId, frame, ikState = null) {
	let prev = null, next = null;
	for (const [at, entry] of keys) {
		const key = entry.get(trackId);
		if (!key) continue;
		if (!isFixKey(key)) return null;
		if (at <= frame && (!prev || at > prev.at)) prev = { at, key };
		if (at >= frame && (!next || at < next.at)) next = { at, key };
	}
	if (!prev && !next) return null;
	const a = prev ?? next, b = next ?? prev, t = b.at === a.at ? 0 : smooth((frame - a.at) / (b.at - a.at));
	const wa = isRestKey(a.key) ? 0 : 1, wb = isRestKey(b.key) ? 0 : 1, w = ikState?.fixView === "original" ? 0 : wa + (wb - wa) * t;
	if (w <= 0) return { w: 0, sampled: null, delta: null };
	if (wa !== wb) return { w, sampled: null, delta: wa ? a.key : b.key };
	// the pose on each side of the frame: a rest key has none, so its neighbour's pose is the one the weight eases
	const pa = wa ? a.key : b.key, pb = wb ? b.key : a.key;
	if (pa === pb) return { w, delta: null, sampled: { q: pa.q, p: pa.p, chainP: pa.chainP, chainPWeight: 1, keepTranslations: pa.keepTranslations === true } };
	return { w, delta: null, sampled: {
		q: pa.q && pb.q ? pa.q.map((q, i) => (pb.q[i] ? q.clone().slerp(pb.q[i], t) : q)) : (pa.q ?? pb.q ?? null),
		p: pa.p && pb.p ? pa.p.clone().lerp(pb.p, t) : (pa.p ?? pb.p ?? null),
		chainP: pa.chainP && pb.chainP ? pa.chainP.map((p, i) => p.clone().lerp(pb.chainP[i], t)) : (pa.chainP ?? pb.chainP), chainPWeight: 1,
		keepTranslations: pa.keepTranslations === true || pb.keepTranslations === true,
	} };
}

/** The fix keys of a stored layer's IK key rows (motion-intent-codec.js shape) by part, each in frame order:
 * Map(part -> [{ frame, rest, tracks }]); a frame is a rest dot when every fix key the part has there is a rest key. */
export function partKeysOf(rows = []) {
	const out = new Map();
	for (const row of rows) {
		const groups = new Map();
		for (const [track, key] of Object.entries(row.tracks ?? {})) {
			if (!isFixKey(key)) continue;
			const part = partOf(track);
			if (!groups.has(part)) groups.set(part, { frame: row.frame, rest: true, tracks: [] });
			const group = groups.get(part);
			group.tracks.push(track);
			if (!key.fix.rest) group.rest = false;
		}
		for (const [part, dot] of groups) { if (!out.has(part)) out.set(part, []); out.get(part).push(dot); }
	}
	for (const dots of out.values()) dots.sort((a, b) => a.frame - b.frame);
	return new Map(FIX_PARTS.filter((part) => out.has(part)).map((part) => [part, out.get(part)]));
}

/** Rows saved by the band model (`fix` = { before, after, hold? }, fix-weight.js) as fix keys with the same shape: the
 * pose key stays, a rest key lands one frame outside each end of its reach, and a held band keeps its pose on the two
 * frames it held between. Rows without band keys come back as they are (the same array). `last`: the take's last frame. */
export function convertBandKeys(rows = [], last = Infinity) {
	if (!rows.some((row) => Object.values(row.tracks ?? {}).some((key) => key.fix && !key.fix.kf))) return rows;
	const frames = new Map(rows.map((row) => [row.frame, { ...row.tracks }]));
	const put = (frame, track, key) => {
		if (frame < 0 || frame > last) return;
		if (!frames.has(frame)) frames.set(frame, {});
		if (!frames.get(frame)[track]) frames.get(frame)[track] = key;
	};
	for (const row of rows) for (const [track, key] of Object.entries(row.tracks ?? {})) {
		if (!key.fix || key.fix.kf) continue;
		const { id, takeId = null, before = 0, after = 0, hold = null } = key.fix, fix = { id, takeId, kf: true };
		const { fix: _, blend: __, ...pose } = key, start = row.frame - before, end = row.frame + after;
		frames.get(row.frame)[track] = { ...pose, fix };
		if (hold) { put(start + Math.min(before, hold.in ?? 0), track, { ...pose, fix: { ...fix } }); put(end - Math.min(after, hold.out ?? 0), track, { ...pose, fix: { ...fix } }); }
		put(start - 1, track, { fix: { ...fix, rest: true } });
		put(end + 1, track, { fix: { ...fix, rest: true } });
	}
	return [...frames].sort(([a], [b]) => a - b).map(([frame, tracks]) => ({ frame, tracks }));
}
