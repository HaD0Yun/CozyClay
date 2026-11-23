// The bounds a following camera keeps (camera-follow.js). None is a fixed
// speed: two are a share of the camera's distance (an angle seen from it), one
// a multiple of the subject's own pace, so a subject of any speed stays in the
// picture and on the side the shot set.

// How far the operator's aim may sit from the subject, as a share of the
// camera's distance to it (0.25: at most 14.5° seen from the camera). The aim
// spring and its look-ahead are in seconds, so the metres they put between aim
// and subject grow with the subject's speed: at a walk a few degrees of lead
// room, at a car's speed enough to swing the subject out of the picture. The
// bound is an angle, the same at every speed and every camera distance. It
// does not know the lens: one whose half width is under it (70 mm and longer
// on the default sensor) can still put a fast subject at the picture's edge.
const AIM_REACH = 0.25;

// How fast the follow camera may steer toward its trailing position: twice the
// subject's own pace, and never under twice a walking pace (2.8 m/s) so a
// camera can still settle while its subject stands. The old fixed 2.8 m/s cap
// was tuned on a corner walk at 1.4 m/s, where it is this same budget; it
// bound any faster subject, so a side or front framing slid behind the subject
// and a front framing flipped round it on a straight.
const STEER_SCALE = 2, STEER_FLOOR = 2.8;

/** The share of x a bound of 1 lets through: all of a small x, x / (1 + x^4)^(1/4) in all, never more than 1. */
const knee = (x) => 1 / Math.sqrt(Math.sqrt(1 + x ** 4));

/**
 * The aim point the camera looks at: the spring's point, pulled toward the
 * subject only where it strays past the reach of the camera's distance. A
 * smooth knee (x / (1 + x^4)^(1/4)) leaves a walk's lead within a few
 * hundredths of a degree of what it was and never kinks the pan. A look-ahead
 * the shot sets above the default widens the reach with it (its seconds, as a
 * tangent), so the setting keeps its lead on a slow subject.
 */
export function framedAim(aim, subject, camera, lead = 0) {
	const ex = aim.x - subject.x, ez = aim.z - subject.z, e = Math.hypot(ex, ez);
	if (e < 1e-9) return aim;
	const share = Math.min(Math.max(AIM_REACH, Number.isFinite(lead) ? lead : 0), 2 * AIM_REACH);
	const reach = share * Math.max(Math.hypot(camera.x - subject.x, camera.z - subject.z), 1e-3);
	const k = knee(e / reach);
	return { ...aim, x: subject.x + ex * k, z: subject.z + ez * k };
}

/**
 * Seconds of the subject's velocity the follow camera's target runs ahead by:
 * the spring's lag, fed forward. The spring step trails a steady target by
 * 2/omega - dt, so 2/omega leads by one frame of travel. At a walk that is a
 * few centimetres and stays (the tracks are what they were); at speed it is
 * metres, which leaned a side framing toward the front and carried a camera
 * behind a subject faster than its distance per frame round to the front. The
 * frame of travel is held within AIM_REACH of the follow distance by the knee.
 */
export function steerLead(velocity, omega, dt, distance) {
	const ahead = Math.hypot(velocity.x, velocity.z) * dt;
	return 2 / omega - dt * (1 - knee(ahead / (AIM_REACH * Math.max(distance, 1e-3))));
}

/** The subject's pace at a frame (m/s): the middle of the frame steps before, at and after it, so one jumped frame is not a speed. */
function pace(subject, f, dt) {
	const step = (i) => { const k = Math.min(Math.max(1, i), subject.length - 1); return k > 0 ? Math.hypot(subject[k].x - subject[k - 1].x, subject[k].z - subject[k - 1].z) / dt : 0; };
	const a = step(f - 1), b = step(f), c = step(f + 1);
	return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * The follow camera's steering budget at a frame (m/s). The pace is the slower
 * of the smoothed velocity and the subject's own steps: a cut in the
 * subject's motion (one frame that jumps metres) leaves the smoothed velocity
 * high for many frames, and a budget read from that alone would carry the
 * camera through the subject to its far side.
 */
export function steerBudget(subject, velocity, f, dt) {
	return Math.max(STEER_FLOOR, STEER_SCALE * Math.min(Math.hypot(velocity.x, velocity.z), pace(subject, f, dt)));
}
