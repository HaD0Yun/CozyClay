// Keep a body in a moving camera's picture. A follow or rail camera is derived from one point of its subject
// (camera-follow.js: the hips' path, aimed at a fixed chest height), so a pose that reaches below or above that
// point (a long stride, a crouch, a seat on the floor, an arm up) can leave the frame. holdBody looks at the body
// as it is posed at each frame (its joints) and changes the camera only as far as the joints need: first the aim
// (pan and tilt), then, where the body is too big for the lens at that distance and the camera may move, a dolly
// back from the body. Corrections are eased over neighbouring frames so the camera does not jerk, and a last pass
// makes sure every frame holds its joints. Pure: { pos, yaw, pitch } samples (camera-follow.js conventions) in,
// the same shape out; a frame without joints is left as it is.

/** Share of the half frame the joints may reach: a little room at the edges. */
const HOLD_MARGIN = 0.92;
const STEP = 0.04, MAX_STEPS = 80, AIM_ITERATIONS = 12, NEAR = 0.05;

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Where joints land in the picture of { pos, yaw, pitch }: their NDC box, or null when one is behind the lens. */
export function screenBox(sample, points, { tanV, aspect }) {
	const cy = Math.cos(sample.yaw), sy = Math.sin(sample.yaw), cp = Math.cos(sample.pitch), sp = Math.sin(sample.pitch);
	const f = [-sy * cp, sp, -cy * cp], r = [cy, 0, -sy], u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
	const box = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
	for (const [x, y, z] of points) {
		const d = [x - sample.pos.x, y - sample.pos.y, z - sample.pos.z], depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
		if (depth <= NEAR) return null;
		const sx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (depth * tanV * aspect), syy = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (depth * tanV);
		box.xMin = Math.min(box.xMin, sx); box.xMax = Math.max(box.xMax, sx); box.yMin = Math.min(box.yMin, syy); box.yMax = Math.max(box.yMax, syy);
	}
	return box;
}

const holds = (box, margin) => !!box && box.xMin >= -margin && box.xMax <= margin && box.yMin >= -margin && box.yMax <= margin;

/** The NDC shift that brings [lo, hi] inside [-m, m]: none when it is inside, else the least move (centred when too wide). */
function shiftInto(lo, hi, m) {
	if (hi - lo > 2 * m) return (lo + hi) / 2;
	return hi > m ? hi - m : lo < -m ? lo + m : 0;
}

/** Pan and tilt only as far as the joints need. */
function reaim(sample, points, lens, margin) {
	let out = sample;
	for (let i = 0; i < AIM_ITERATIONS; i += 1) {
		const box = screenBox(out, points, lens);
		if (!box) return out;
		const dx = shiftInto(box.xMin, box.xMax, margin), dy = shiftInto(box.yMin, box.yMax, margin);
		if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return out;
		out = { ...out, yaw: out.yaw - Math.atan(dx * lens.tanV * lens.aspect), pitch: Math.max(-1.5, Math.min(1.5, out.pitch + Math.atan(dy * lens.tanV))) };
	}
	return out;
}

const middle = (points) => {
	const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[2]], [0, 0]);
	return { x: sum[0] / points.length, z: sum[1] / points.length };
};

/** Back along the floor from the body's middle by `extra` metres (a camera standing on it is pushed aside along x). */
function dollied(sample, centre, extra) {
	if (!(extra > 0)) return sample;
	const dx = sample.pos.x - centre.x, dz = sample.pos.z - centre.z, len = Math.hypot(dx, dz);
	const ux = len > 1e-6 ? dx / len : 1, uz = len > 1e-6 ? dz / len : 0;
	return { ...sample, pos: { ...sample.pos, x: sample.pos.x + ux * extra, z: sample.pos.z + uz * extra } };
}

/** One frame: the aim that holds the joints and, when the camera may move, the dolly back it needs ({ sample, extra }). */
function fitFrame(sample, points, lens, { dolly, margin }) {
	const centre = middle(points), start = Math.hypot(sample.pos.x - centre.x, sample.pos.z - centre.z);
	let extra = 0, fitted = reaim(sample, points, lens, margin);
	for (let k = 0; dolly && k < MAX_STEPS && !holds(screenBox(fitted, points, lens), margin); k += 1) {
		extra += STEP * Math.max(start + extra, 0.5);
		fitted = reaim(dollied(sample, centre, extra), points, lens, margin);
	}
	return { sample: fitted, extra };
}

/** max over ±w then the mean over ±w: smooth, and never below the input at any frame. */
function easeUp(values, w) {
	const n = values.length, at = (a, i) => a[Math.max(0, Math.min(n - 1, i))];
	const peak = values.map((_, i) => { let m = 0; for (let k = -w; k <= w; k += 1) m = Math.max(m, at(values, i + k)); return m; });
	return peak.map((_, i) => { let s = 0; for (let k = -w; k <= w; k += 1) s += at(peak, i + k); return s / (2 * w + 1); });
}
const easeSigned = (values, w) => {
	const up = easeUp(values.map((v) => Math.max(v, 0)), w), down = easeUp(values.map((v) => Math.max(-v, 0)), w);
	return up.map((v, i) => v - down[i]);
};

/**
 * track: camera samples, one per frame; bodies: the subject's joints at each of those frames ([[x, y, z], ...] or
 * null); fovDeg: the vertical field of view a sample without its own fovDeg renders with; aspect: the picture's
 * width / height; dolly: false keeps every camera where it is (a rail) and only re-aims; fps sets how long a
 * correction is eased in and out. Samples that roll the picture keep their framing (rolled framing is the user's).
 */
export function holdBody(track, bodies, { fovDeg, aspect, dolly = true, fps = 24, margin = HOLD_MARGIN, easeSeconds = 0.4 } = {}) {
	if (!Array.isArray(track) || !Array.isArray(bodies) || !(aspect > 0)) return track;
	const lensOf = (sample) => ({ tanV: Math.tan(((Number.isFinite(sample.fovDeg) ? sample.fovDeg : fovDeg) * Math.PI) / 360), aspect });
	const usable = (f) => track[f] && !track[f].rollDeg && Array.isArray(bodies[f]) && bodies[f].length > 0 && Number.isFinite(lensOf(track[f]).tanV);
	if (!track.some((_, f) => usable(f))) return track;
	const w = Math.max(1, Math.round(easeSeconds * fps));
	// 1. how far each frame must dolly back (with its best aim), eased so the camera glides out and back in
	const extras = easeUp(track.map((sample, f) => (dolly && usable(f) ? fitFrame(sample, bodies[f], lensOf(sample), { dolly, margin }).extra : 0)), w);
	const moved = track.map((sample, f) => (usable(f) ? dollied(sample, middle(bodies[f]), extras[f]) : sample));
	// 2. the pan and tilt each frame needs from there, eased the same way
	const aims = moved.map((sample, f) => (usable(f) ? reaim(sample, bodies[f], lensOf(sample), margin) : sample));
	const tilts = easeSigned(aims.map((aim, f) => aim.pitch - moved[f].pitch), w), pans = easeSigned(aims.map((aim, f) => wrapAngle(aim.yaw - moved[f].yaw)), w);
	// 3. every frame holds its joints, whatever the easing did
	return moved.map((sample, f) => {
		if (!usable(f)) return sample;
		const eased = { ...sample, yaw: sample.yaw + pans[f], pitch: sample.pitch + tilts[f] };
		return holds(screenBox(eased, bodies[f], lensOf(sample)), margin) ? eased : fitFrame(eased, bodies[f], lensOf(sample), { dolly, margin }).sample;
	});
}
