// A rail camera's head: whether it turns to what the shot follows, and the
// angle the user gave it by hand. Pure; camera-follow.js angle conventions
// (yaw/pitch in radians, positive yaw turns left, positive pitch looks up).
//
// Stored on a rail block as `head` (camera-block.js railShotFields):
//   null                              turns to the subject, no hand angle (every older shot)
//   { yawDeg, pitchDeg }              turns to the subject, then this much more by hand
//   { follow: false, yawDeg, pitchDeg } holds this angle and turns to nothing
// A recorded aim take (aimTake) replaces the head's angle on its frames, whatever the head says.

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

/** The sample's angles after the head: an offset from the aim when it follows, its own angle when not. */
export function applyRailHead(sample, head) {
	if (!sample || !head) return sample;
	const own = head.follow === false;
	const yaw = (own ? 0 : sample.yaw) + head.yawDeg * DEG;
	const pitch = (own ? 0 : sample.pitch) + head.pitchDeg * DEG;
	return { ...sample, yaw, pitch: clamp(pitch, -PITCH_LIMIT_DEG * DEG, PITCH_LIMIT_DEG * DEG) };
}

/**
 * The head that turns a rail camera shown at `sample` (built with `head`) to `look`:
 * the angle the user turned it to by hand. A following head keeps the turn as an offset.
 */
export function headFromLook(head, sample, look) {
	if (head?.follow === false) return cloneRailHead({ follow: false, yawDeg: look.yaw / DEG, pitchDeg: look.pitch / DEG });
	return cloneRailHead({
		yawDeg: (head?.yawDeg ?? 0) + wrapDeg((look.yaw - sample.yaw) / DEG),
		pitchDeg: (head?.pitchDeg ?? 0) + (look.pitch - sample.pitch) / DEG,
	});
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
