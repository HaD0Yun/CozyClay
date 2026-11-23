// A rail camera's head: whether it turns to what the shot follows, and the
// angle the user gave it by hand. Pure; camera-follow.js angle conventions
// (yaw/pitch in radians, positive yaw turns left, positive pitch looks up).
//
// Stored on a rail block as `head` (camera-block.js railShotFields):
//   null                              turns to the subject, no hand angle (every older shot)
//   { yawDeg, pitchDeg }              turns to the subject, then this much more by hand
//   { follow: false, yawDeg, pitchDeg } holds this angle and turns to nothing
// A recorded aim take (aimTake) replaces the head's angle on its frames, whatever the head says.
// A crane mark may carry a turn of its own ({ t, height, yawDeg, pitchDeg }, camera-block.js): the head turns that
// much more where the dolly passes the mark, eased between marks like the height (railTurnAt).

import { monotoneCubicAt } from "./monotone-cubic.js";

const DEG = Math.PI / 180;
const PITCH_LIMIT_DEG = 85;
const OFFSET_PITCH_LIMIT_DEG = 170;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const tenth = (value) => Math.round(value * 10) / 10 || 0;
const wrapDeg = (value) => {
	const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 && value > 0 ? 180 : wrapped;
};

/** A stored head, normalized: angles to 0.1 degree, null when it is the default (follow, no hand angle). */
export function cloneRailHead(value) {
	if (!value || typeof value !== "object") return null;
	const follow = value.follow !== false;
	const yawDeg = Number.isFinite(value.yawDeg) ? tenth(wrapDeg(value.yawDeg)) : 0;
	const pitchLimit = follow ? OFFSET_PITCH_LIMIT_DEG : PITCH_LIMIT_DEG;
	const pitchDeg = Number.isFinite(value.pitchDeg) ? tenth(clamp(value.pitchDeg, -pitchLimit, pitchLimit)) : 0;
	if (follow && !yawDeg && !pitchDeg) return null;
	return { ...(follow ? {} : { follow: false }), yawDeg, pitchDeg };
}

/** A crane mark's turn, normalized like the head: degrees to 0.1, left out when zero (older marks stay byte-stable). */
export function craneMarkTurn(point) {
	const yawDeg = Number.isFinite(point?.yawDeg) ? tenth(wrapDeg(point.yawDeg)) : 0;
	const pitchDeg = Number.isFinite(point?.pitchDeg) ? tenth(clamp(point.pitchDeg, -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG)) : 0;
	return { ...(yawDeg ? { yawDeg } : {}), ...(pitchDeg ? { pitchDeg } : {}) };
}

/** The turn the crane marks give at arc progress 0..1, eased between marks as the height is; null when no mark turns. */
export function railTurnAt(crane, progress) {
	const points = crane?.points;
	if (!Array.isArray(points) || !points.some((point) => point.yawDeg || point.pitchDeg)) return null;
	const at = (key) => monotoneCubicAt(points, clamp(progress, 0, 1), (point) => point[key] ?? 0);
	return { yawDeg: at("yawDeg"), pitchDeg: at("pitchDeg") };
}

/** Where the shot camera looks as it passes arc progress `t` of its rail: the shot's track sample nearest it, or null. */
export function railViewAt(track, shot, rail, t) {
	if (!Array.isArray(track) || !shot || !rail?.length || !Number.isFinite(t)) return null;
	let best = null;
	for (let frame = shot.startFrame; frame <= shot.endFrame; frame += 1) {
		const sample = track[frame];
		if (!sample || !Number.isFinite(sample.s)) continue;
		const d = Math.abs(sample.s / rail.length - t);
		if (!best || d < best.d) best = { d, yaw: sample.yaw, pitch: sample.pitch };
	}
	return best && { yaw: best.yaw, pitch: best.pitch };
}

/** The sample's angles after the head: an offset from the aim when it follows, its own angle when not; then a mark's turn. */
export function applyRailHead(sample, head, turn = null) {
	if (!sample || (!head && !turn)) return sample;
	const own = head?.follow === false;
	const yaw = (own ? 0 : sample.yaw) + ((head?.yawDeg ?? 0) + (turn?.yawDeg ?? 0)) * DEG;
	const pitch = (own ? 0 : sample.pitch) + ((head?.pitchDeg ?? 0) + (turn?.pitchDeg ?? 0)) * DEG;
	return { ...sample, yaw, pitch: clamp(pitch, -PITCH_LIMIT_DEG * DEG, PITCH_LIMIT_DEG * DEG) };
}

/**
 * The head that turns a rail camera shown at `sample` (built with `head`) to `look`:
 * the angle the user turned it to by hand, as a change of the head, so a crane mark's turn there is not counted twice.
 */
export function headFromLook(head, sample, look) {
	return cloneRailHead({
		...(head?.follow === false ? { follow: false } : {}),
		yawDeg: (head?.yawDeg ?? 0) + wrapDeg((look.yaw - sample.yaw) / DEG),
		pitchDeg: (head?.pitchDeg ?? 0) + (look.pitch - sample.pitch) / DEG,
	});
}

const samePlace = (a, b) => ["x", "y", "z"].every((axis) => Math.abs(a[axis] - b[axis]) < 1e-3);

/**
 * How a hand change of the camera on a rail frame reads. `shown` is what the rail shows there ({ camera, head }),
 * `position` and `look` are where the hand left the camera, `left` is where the last hand MOVE left it and how
 * it looked then ({ position, yaw, pitch }, or null).
 *   { hold: false, head }  the camera stands where the rail put it: it was turned, the head takes the turn
 *   { hold: true, head? }  it stands where the last hand move left it: a look that changed since is a turn
 *                          (head), an unchanged one is nothing new; the camera stays held where it is
 *   null                   it was moved: the caller measures the follow framing, as before the head existed
 */
export function railHandTurn(shown, position, look, left) {
	if (samePlace(position, shown.camera.pos)) return { hold: false, head: headFromLook(shown.head, shown.camera, look) };
	if (!left || !samePlace(position, left.position)) return null;
	const turned = Math.abs(left.yaw - look.yaw) > 1e-6 || Math.abs(left.pitch - look.pitch) > 1e-6;
	return { hold: true, ...(turned ? { head: headFromLook(shown.head, shown.camera, look) } : {}) };
}

/** The tilt a rail's controls show: the head's own angle with follow off, else its tilt offset plus the follow
 * pitch an aimless rail still carries from before the head existed (camera-follow.js offsetPitch). */
export function railShownPitchDeg(camera, followPitchDeg = 0) {
	const head = camera?.head;
	if (head?.follow === false) return head.pitchDeg;
	return (head?.pitchDeg ?? 0) + (camera?.aim ? 0 : followPitchDeg);
}

/** Follow on keeps the subject centred (no offset); follow off holds the angle shown now. */
export function toggleRailHeadFollow(head, shown) {
	if (head?.follow === false) return null;
	return cloneRailHead({ follow: false, yawDeg: shown.yaw / DEG, pitchDeg: shown.pitch / DEG });
}
