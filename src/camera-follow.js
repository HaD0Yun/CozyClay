import { timingProgress } from "./speed-envelope.js";
import { monotoneCubicAt } from "./monotone-cubic.js";

/**
 * Follow camera: a real crew in three pieces of math.
 *
 * A tracking shot on set is three jobs — the RAIL constrains where the camera
 * may be, the DOLLY GRIP pushes along it to hold distance to the subject, and
 * the OPERATOR pans to keep the framing. Keyframe interpolation can't play
 * that scene: between keys it never looks at what the subject actually does,
 * which is exactly why corners feel wrong. Here the camera is DERIVED from
 * the subject's per-frame trajectory instead.
 *
 * Everything is integrated offline over the whole clip at a fixed dt, so
 * scrubbing, playing backwards, PlayView and Record all see the same
 * deterministic track — no wall-clock springs, no simulation state to
 * desync. Same trajectory + same params = the same track, always.
 *
 * Conventions match camera-move.js / controls.jsx: Y-up metres, YXZ look
 * angles with yaw = atan2(-dx, -dz).
 */

/** critically damped response: reaches ~98% of a step in `response` seconds */
function omegaFor(response) {
	return 4.6 / Math.max(response, 0.05);
}

/** one semi-implicit Euler step of a critically damped spring (scalar) */
function springStep(pos, vel, target, omega, dt) {
	const acc = omega * omega * (target - pos) - 2 * omega * vel;
	const nextVel = vel + acc * dt;
	return [pos + nextVel * dt, nextVel];
}

/** scalar forward spring whose speed limit is applied before position integration */
function cappedSpringStep(pos, vel, target, omega, dt, maxSpeed) {
	const acc = omega * omega * (target - pos) - 2 * omega * vel;
	const cap = Math.max(0, Number.isFinite(maxSpeed) ? maxSpeed : 0);
	// Rail targets never move backward; discard incompatible spring velocity
	// before integration so the authored arc remains a forward-only invariant.
	const nextVel = Math.max(0, Math.min(vel + acc * dt, cap));
	return [pos + nextVel * dt, nextVel];
}

const PITCH_LIMIT = (85 * Math.PI) / 180;

function offsetPitch(pitch, offsetDeg) {
	const safeOffset = Math.max(-170, Math.min(Number.isFinite(offsetDeg) ? offsetDeg : 0, 170));
	return Math.max(-PITCH_LIMIT, Math.min(pitch + (safeOffset * Math.PI) / 180, PITCH_LIMIT));
}

function aimAngles(position, target) {
	const dx = target.x - position.x;
	const dy = target.y - position.y;
	const dz = target.z - position.z;
	return {
		yaw: Math.atan2(-dx, -dz),
		pitch: Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-6)),
	};
}

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const rounded = (value, places) => Number(value.toFixed(places));

/** One authored-frame step. Render delta never enters the integrator. */
export const followFixedTimestep = (fps) => 1 / Math.max(Number.isFinite(fps) ? fps : 0, 1);

/**
 * Turn the operator's current viewport framing into the physical Follow
 * settings. These are observations, not knobs: moving the camera is the input.
 * Pitch is stored as an offset from the rig's automatic chest aim so replaying
 * the Follow track reproduces the angle the operator composed by hand. The
 * orbit offset records whether that composition was in front, beside or behind
 * the subject relative to its travel direction.
 */
export function followFramingFromCamera(position, pitch, subject, aimHeight = FOLLOW_DEFAULTS.aimHeight, travelDir = null) {
	const planarDistance = Math.hypot(position.x - subject.x, position.z - subject.z);
	const automaticPitch = aimAngles(position, { x: subject.x, y: aimHeight, z: subject.z }).pitch;
	const cameraOffset = normalize({ x: position.x - subject.x, z: position.z - subject.z });
	const direction = travelDir && Math.hypot(travelDir.x, travelDir.z) > 1e-6 ? normalize(travelDir) : { x: 0, z: 1 };
	const behind = { x: -direction.x, z: -direction.z };
	const orbitOffsetDeg = (Math.atan2(
		behind.x * cameraOffset.z - behind.z * cameraOffset.x,
		behind.x * cameraOffset.x + behind.z * cameraOffset.z,
	) * 180) / Math.PI;
	return {
		distance: rounded(clamp(planarDistance, 0.5, 15), 2),
		height: rounded(Math.max(position.y, 0.2), 2),
		pitchOffsetDeg: rounded(clamp(((pitch - automaticPitch) * 180) / Math.PI, -170, 170), 1),
		orbitOffsetDeg: rounded(clamp(orbitOffsetDeg, -180, 180), 1),
	};
}

export const FOLLOW_DEFAULTS = {
	/** metres the grip tries to hold between camera and subject */
	distance: 3,
	/** camera height in metres (a rail is 2D; height is the operator's) */
	height: 1.6,
	/** dolly response in seconds — larger = heavier, lazier camera */
	response: 0.7,
	/** operator aim response; a head pans faster than a dolly moves */
	aimResponse: 0.35,
	/** seconds of subject velocity the operator leads the frame by */
	lead: 0.25,
	/** where on the body the operator holds frame (chest, metres) */
	aimHeight: 1.35,
	/** vertical tilt added after automatic aiming, in degrees */
	pitchOffsetDeg: 0,
	/** authored position around the subject: 0 behind, ±90 side, 180 front */
	orbitOffsetDeg: 0,
	/** cap on unconstrained steering (m/s); exact follow distance wins */
	maxSpeed: 2.8,
	/** where a rail dolly opens: the authored head or legacy auto placement */
	railStartMode: "head",
	/** hard cap on rail-dolly travel in metres per second */
	maxDollySpeed: 4,
	/** EMA weight for the BEHIND direction; slow on purpose, so a corner
	 * sweeps the trailing position gradually and the camera cuts the corner
	 * the way a steadicam op does instead of whipping around the subject.
	 * Tuned with maxSpeed against a 90° corner walk: together they hold the
	 * worst pan under ~60°/s (3°/frame @20), a brisk but human pan. */
	dirBlend: 0.05,
};

/**
 * Subject travel directions, one unit XZ vector per frame. Velocity is
 * EMA-smoothed so a foot-plant wobble doesn't wag the whole camera, and the
 * last real direction is held through stops — a grip doesn't forget which
 * way the actor was walking just because they paused.
 */
export function travelDirections(subject, fps, initialDir = null, blend = 0.25) {
	const dirs = [];
	let dir = initialDir && Math.hypot(initialDir.x, initialDir.z) > 1e-6
		? normalize(initialDir)
		: null;
	let vx = 0;
	let vz = 0;
	for (let f = 0; f < subject.length; f += 1) {
		if (f > 0) {
			vx += ((subject[f].x - subject[f - 1].x) * fps - vx) * blend;
			vz += ((subject[f].z - subject[f - 1].z) * fps - vz) * blend;
		}
		if (Math.hypot(vx, vz) > 0.15) dir = normalize({ x: vx, z: vz });
		if (!dir) {
			// nothing has moved yet: probe the first future step so the camera
			// starts behind the walk instead of snapping when it begins
			for (let probe = f + 1; probe < subject.length; probe += 1) {
				const dx = subject[probe].x - subject[f].x;
				const dz = subject[probe].z - subject[f].z;
				if (Math.hypot(dx, dz) > 0.05) {
					dir = normalize({ x: dx, z: dz });
					break;
				}
			}
			if (!dir) dir = { x: 0, z: 1 };
		}
		dirs.push(dir);
	}
	return dirs;
}

function normalize(v) {
	const len = Math.max(Math.hypot(v.x, v.z), 1e-9);
	return { x: v.x / len, z: v.z / len };
}

function rotateDirection(direction, degrees) {
	const angle = ((Number.isFinite(degrees) ? degrees : 0) * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: direction.x * cos - direction.z * sin,
		z: direction.x * sin + direction.z * cos,
	};
}

/** smoothed subject velocities (m/s), the operator's lead signal */
function smoothedVelocities(subject, fps) {
	const out = [];
	let vx = 0;
	let vz = 0;
	const blend = 0.25;
	for (let f = 0; f < subject.length; f += 1) {
		if (f > 0) {
			vx += ((subject[f].x - subject[f - 1].x) * fps - vx) * blend;
			vz += ((subject[f].z - subject[f - 1].z) * fps - vz) * blend;
		}
		out.push({ x: vx, z: vz });
	}
	return out;
}

/**
 * Free follow (no rail): steadicam behind the subject. The position target
 * sits `distance` metres behind the smoothed travel direction; a spring
 * chooses the trailing direction, then the camera is projected onto the
 * exact authored radius. The aim spring chases a lead point. Returns one
 * {pos, yaw, pitch} per subject frame.
 */
export function buildFollowTrack(subject, fps, params = {}) {
	const p = { ...FOLLOW_DEFAULTS, ...params };
	if (!subject || subject.length === 0) return [];
	const dt = followFixedTimestep(fps);
	const dirs = travelDirections(subject, fps, p.initialDir, p.dirBlend);
	const offsets = dirs.map((dir) => rotateDirection({ x: -dir.x, z: -dir.z }, p.orbitOffsetDeg));
	const vels = smoothedVelocities(subject, fps);
	const omega = omegaFor(p.response);
	const aimOmega = omegaFor(p.aimResponse);
	// a critically damped spring trails a moving target by 2v/ω at steady
	// state; feeding the subject's velocity forward cancels that lag, so the
	// held distance is the REQUESTED distance, not distance-plus-lag
	const lagComp = 2 / omega;

	// start settled on the frame-0 target: a shot opens composed, not sliding
	let px = subject[0].x + offsets[0].x * p.distance;
	let pz = subject[0].z + offsets[0].z * p.distance;
	let py = p.height;
	let vx = 0, vz = 0, vy = 0;
	let ax = subject[0].x;
	let az = subject[0].z;
	let avx = 0, avz = 0;

	const track = [];
	for (let f = 0; f < subject.length; f += 1) {
		if (f > 0) {
			const previousX = px;
			const previousZ = pz;
			const tx = subject[f].x + offsets[f].x * p.distance + vels[f].x * lagComp;
			const tz = subject[f].z + offsets[f].z * p.distance + vels[f].z * lagComp;
			// planar spring integrated by hand so the SPEED cap binds the
			// velocity vector, not each axis separately
			vx += (omega * omega * (tx - px) - 2 * omega * vx) * dt;
			vz += (omega * omega * (tz - pz) - 2 * omega * vz) * dt;
			const speed = Math.hypot(vx, vz);
			if (speed > p.maxSpeed) {
				vx *= p.maxSpeed / speed;
				vz *= p.maxSpeed / speed;
			}
			px += vx * dt;
			pz += vz * dt;
			// Follow distance is a hard framing constraint. The spring chooses
			// the smooth trailing direction, then this projection puts the
			// camera back on the requested radius for this exact subject frame.
			let offsetX = px - subject[f].x;
			let offsetZ = pz - subject[f].z;
			const radius = Math.hypot(offsetX, offsetZ);
			if (radius < 1e-6) {
				offsetX = offsets[f].x;
				offsetZ = offsets[f].z;
			} else {
				offsetX /= radius;
				offsetZ /= radius;
			}
			px = subject[f].x + offsetX * p.distance;
			pz = subject[f].z + offsetZ * p.distance;
			// Keep the integrator honest after projection so radial error does
			// not accumulate invisibly and burst into a later frame.
			vx = (px - previousX) / dt;
			vz = (pz - previousZ) / dt;
			[py, vy] = springStep(py, vy, p.height, omega, dt);
			const aimTx = subject[f].x + vels[f].x * p.lead;
			const aimTz = subject[f].z + vels[f].z * p.lead;
			[ax, avx] = springStep(ax, avx, aimTx, aimOmega, dt);
			[az, avz] = springStep(az, avz, aimTz, aimOmega, dt);
		}
		const pos = { x: px, y: py, z: pz };
		const { yaw, pitch } = aimAngles(pos, { x: ax, y: p.aimHeight, z: az });
		track.push({ pos, yaw, pitch: offsetPitch(pitch, p.pitchOffsetDeg) });
	}
	return track;
}

/** Accepts the canonical { points } crane or the legacy { start, end } pair. */
function cranePoints(value) {
	if (!value || typeof value !== "object") return null;
	if (Array.isArray(value.points) && value.points.length >= 2) return value.points;
	if (Number.isFinite(value.start) && Number.isFinite(value.end)) {
		return [{ t: 0, height: value.start }, { t: 1, height: value.end }];
	}
	return null;
}

/**
 * Height of the crane profile at arc progress 0..1: a monotone piecewise
 * cubic through the marks (harmonic-mean tangents, Fritsch–Carlson family),
 * so the lens hits every authored height exactly and never overshoots
 * between two of them. Two marks degrade to the exact straight lerp.
 */
export function craneHeightAt(craneHeight, progress) {
	const points = cranePoints(craneHeight);
	if (!points) return NaN;
	return monotoneCubicAt(points, Math.max(0, Math.min(1, progress)), (point) => point.height);
}

/**
 * Ramer–Douglas–Peucker: an authored stroke is hundreds of jittery pointer
 * samples; the rail wants the handful of points that carry its shape.
 */
export function simplifyStroke(points, epsilon = 0.12) {
	if (!points || points.length <= 2) return points ? [...points] : [];
	const keep = new Array(points.length).fill(false);
	keep[0] = keep[points.length - 1] = true;
	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop();
		const pa = points[a];
		const pb = points[b];
		const abx = pb.x - pa.x;
		const abz = pb.z - pa.z;
		const abLen = Math.max(Math.hypot(abx, abz), 1e-9);
		let worst = 0;
		let worstIdx = -1;
		for (let i = a + 1; i < b; i += 1) {
			const d = Math.abs((points[i].x - pa.x) * abz - (points[i].z - pa.z) * abx) / abLen;
			if (d > worst) {
				worst = d;
				worstIdx = i;
			}
		}
		if (worst > epsilon && worstIdx > 0) {
			keep[worstIdx] = true;
			stack.push([a, worstIdx], [worstIdx, b]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/**
 * Centripetal Catmull–Rom through the simplified control points, sampled at
 * ~`spacing` metres. Returns { points, cumLen, length } — a dense polyline
 * with cumulative arc length, the coordinate system the grip pushes in.
 */
export function buildRail(controlPoints, { spacing = 0.05 } = {}) {
	const cps = (controlPoints ?? []).filter(
		(p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.z - arr[i - 1].z) > 1e-6,
	);
	if (cps.length < 2) return null;
	const pts = [cps[0]];
	const alpha = 0.5; // centripetal: no loops or overshoot at tight corners
	for (let i = 0; i < cps.length - 1; i += 1) {
		const p0 = cps[Math.max(i - 1, 0)];
		const p1 = cps[i];
		const p2 = cps[i + 1];
		const p3 = cps[Math.min(i + 2, cps.length - 1)];
		const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
		const steps = Math.max(2, Math.ceil(segLen / spacing));
		const t0 = 0;
		const t1 = t0 + Math.hypot(p1.x - p0.x, p1.z - p0.z) ** alpha || t0 + 1e-6;
		const t2 = t1 + segLen ** alpha;
		const t3 = t2 + Math.hypot(p3.x - p2.x, p3.z - p2.z) ** alpha || t2 + 1e-6;
		for (let s = 1; s <= steps; s += 1) {
			const t = t1 + ((t2 - t1) * s) / steps;
			pts.push(catmullRomPoint(p0, p1, p2, p3, t0, t1, t2, t3, t));
		}
	}
	const cumLen = [0];
	for (let i = 1; i < pts.length; i += 1) {
		cumLen.push(cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
	}
	return { points: pts, cumLen, length: cumLen[cumLen.length - 1] };
}

function catmullRomPoint(p0, p1, p2, p3, t0, t1, t2, t3, t) {
	const lerp2 = (a, b, ta, tb) => {
		const w = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
		return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
	};
	const a1 = lerp2(p0, p1, t0, t1);
	const a2 = lerp2(p1, p2, t1, t2);
	const a3 = lerp2(p2, p3, t2, t3);
	const b1 = lerp2(a1, a2, t0, t2);
	const b2 = lerp2(a2, a3, t1, t3);
	return lerp2(b1, b2, t1, t2);
}

/** point on the rail at arc position s (clamped) */
export function railPoint(rail, s) {
	const { points, cumLen, length } = rail;
	const target = Math.max(0, Math.min(s, length));
	let lo = 0;
	let hi = cumLen.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cumLen[mid] <= target) lo = mid;
		else hi = mid;
	}
	const span = cumLen[hi] - cumLen[lo];
	const w = span < 1e-9 ? 0 : (target - cumLen[lo]) / span;
	return {
		x: points[lo].x + (points[hi].x - points[lo].x) * w,
		z: points[lo].z + (points[hi].z - points[lo].z) * w,
	};
}

/** arc position of the sample nearest the given point, searched globally */
function nearestS(rail, point) {
	let best = 0;
	let bestD = Infinity;
	for (let i = 0; i < rail.points.length; i += 1) {
		const d = Math.hypot(rail.points[i].x - point.x, rail.points[i].z - point.z);
		if (d < bestD) {
			bestD = d;
			best = rail.cumLen[i];
		}
	}
	return best;
}

/**
 * Rail follow: the camera lives ON the drawn rail and traverses the authored
 * arc over the clip. `distance` remains a soft framing preference: nearby
 * arc positions can refine the timed target, but they can never make the
 * dolly stop at the first point that happens to match the preference.
 * The operator aims exactly as in the free follow. The timed target and its
 * local distance correction are both speed-capped, so the dolly never
 * teleports across the stage.
 */
export function buildRailFollowTrack(subject, fps, rail, params = {}) {
	const p = { ...FOLLOW_DEFAULTS, searchWindow: 2.5, distanceInfluence: 0.35, ...params };
	if (!subject || subject.length === 0 || !rail || rail.length < 1e-6) return [];
	const dt = followFixedTimestep(fps);
	const vels = smoothedVelocities(subject, fps);
	const omega = omegaFor(p.response);
	const aimOmega = omegaFor(p.aimResponse);
	const step = Math.max(rail.length / Math.max(rail.points.length - 1, 1), 1e-3);
	const authoredSpeed = subject.length > 1 ? rail.length / ((subject.length - 1) * dt) : 0;
	// A critically damped spring trails a constant-speed target by 2v/omega —
	// which is exactly a 2/omega-second head start. Leading in TIME instead of
	// metres keeps the compensation honest under a speed envelope: where the
	// schedule runs fast the lead covers more rail, where it holds it covers
	// none, and for the flat schedule it reduces to the old 2v/omega metres.
	const leadFraction = subject.length > 1 ? (2 / omega) / ((subject.length - 1) * dt) : 0;

	// The crane axis: lens height follows the dolly's own arc progress, so the
	// height always matches where the camera physically is on the track — a
	// stalled dolly holds its height instead of sinking on a timer.
	const crane = cranePoints(p.craneHeight) ? p.craneHeight : null;
	const craneTargetAt = (arc) => {
		if (!crane) return p.height;
		return craneHeightAt(crane, arc / rail.length);
	};

	const distanceErrorAt = (s, subj) => {
		const rp = railPoint(rail, s);
		return Math.abs(Math.hypot(rp.x - subj.x, rp.z - subj.z) - p.distance);
	};
	// Retreat is taxed: when the subject closes in, a real grip concedes
	// distance rather than sprinting the dolly backwards — the backwards
	// whip-pan looks far worse on screen than a temporarily short distance.
	const bestSNear = (s0, subj, window, penalty) => {
		let best = s0;
		let bestErr = distanceErrorAt(s0, subj);
		for (let ds = step; ds <= window; ds += step) {
			for (const cand of [s0 + ds, s0 - ds]) {
				if (cand < 0 || cand > rail.length) continue;
				const err = distanceErrorAt(cand, subj) + penalty * Math.max(0, s0 - cand);
				if (err < bestErr - 1e-9) {
					bestErr = err;
					best = cand;
				}
			}
		}
		return best;
	};

	// Head mode honours the authored start mark exactly. Nearest preserves the
	// legacy auto-placement option by searching the whole rail once. Once the
	// clip starts, authored progress is the primary target; distance only
	// nudges that target locally and can never reverse the dolly.
	let s = p.railStartMode === "nearest"
		? bestSNear(nearestS(rail, subject[0]), subject[0], rail.length, 0)
		: 0;
	let sVel = 0;
	let py = craneTargetAt(s);
	let vy = 0;
	let ax = subject[0].x;
	let az = subject[0].z;
	let avx = 0, avz = 0;

	const track = [];
	for (let f = 0; f < subject.length; f += 1) {
		if (f > 0) {
			const progress = f / Math.max(subject.length - 1, 1);
			// The dolly's schedule is the same speed-envelope grammar the prop
			// path uses: progress through time is shaped by the timing, the
			// area is the rail length, and a cut pins "at this frame, be at
			// this point of the rail". Null timing is the identity — the
			// constant-speed schedule this line always was.
			const authoredS = rail.length * timingProgress(p.dollyTiming, progress);
			const distanceS = bestSNear(authoredS, subject[f], p.searchWindow, 0);
			// Distance influence fades to zero at both authored endpoints, so
			// it refines the middle of the move without shifting its marks.
			const correctionEnvelope = Math.sin(Math.PI * progress) ** 2;
			const correction = (distanceS - authoredS) * clamp(p.distanceInfluence, 0, 1) * correctionEnvelope;
			const ledS = rail.length * timingProgress(p.dollyTiming, Math.min(1, progress + leadFraction));
			const sTarget = Math.max(s, Math.min(rail.length, ledS + correction));
			[s, sVel] = cappedSpringStep(s, sVel, sTarget, omega, dt, p.maxDollySpeed);
			s = Math.max(0, Math.min(s, rail.length));
			[py, vy] = springStep(py, vy, craneTargetAt(s), omega, dt);
			const aimTx = subject[f].x + vels[f].x * p.lead;
			const aimTz = subject[f].z + vels[f].z * p.lead;
			[ax, avx] = springStep(ax, avx, aimTx, aimOmega, dt);
			[az, avz] = springStep(az, avz, aimTz, aimOmega, dt);
		}
		const rp = railPoint(rail, s);
		const pos = { x: rp.x, y: py, z: rp.z };
		const { yaw, pitch } = aimAngles(pos, { x: ax, y: p.aimPerFrame ? (subject[f].y ?? p.aimHeight) : p.aimHeight, z: az });
		track.push({ pos, yaw, pitch: offsetPitch(pitch, p.pitchOffsetDeg), s });
	}
	return track;
}

/**
 * Prepare an x/z rail bend for one crane mark: a copy of the drawn control
 * points (with one inserted at the mark's base when none is close enough to
 * anchor the bend) plus a per-point weight — a cosine bump centred on the
 * anchor that fades to zero by the neighbouring crane marks, so dragging one
 * mark can never tow the marks beside it. For an interior mark both rail
 * ends are pinned outright. `maxControls` stops the seeding at a schema
 * ceiling (the nearest point anchors the bend instead).
 */
export function prepareRailBend(controlPoints, base, marks, markIndex, { maxControls = Infinity } = {}) {
	const controls = (controlPoints ?? []).map((entry) => ({ ...entry }));
	if (controls.length < 2) return null;
	// nearest control point / segment to the mark's base
	let nearestIdx = 0;
	let nearestD = Infinity;
	for (let i = 0; i < controls.length; i += 1) {
		const d = Math.hypot(controls[i].x - base.x, controls[i].z - base.z);
		if (d < nearestD) {
			nearestD = d;
			nearestIdx = i;
		}
	}
	const interior = markIndex > 0 && markIndex < marks.length - 1;
	let anchorIdx = nearestIdx;
	if (interior && nearestD > 0.25 && controls.length < maxControls) {
		// no control point near the mark: bend needs a vertex to pull, so one
		// is seeded at the base, on the segment the base projects onto
		let segmentIdx = 0;
		let segmentD = Infinity;
		for (let i = 0; i < controls.length - 1; i += 1) {
			const ax = controls[i].x;
			const az = controls[i].z;
			const bx = controls[i + 1].x;
			const bz = controls[i + 1].z;
			const lenSq = Math.max((bx - ax) ** 2 + (bz - az) ** 2, 1e-9);
			const u = Math.max(0, Math.min(1, ((base.x - ax) * (bx - ax) + (base.z - az) * (bz - az)) / lenSq));
			const d = Math.hypot(ax + (bx - ax) * u - base.x, az + (bz - az) * u - base.z);
			if (d < segmentD) {
				segmentD = d;
				segmentIdx = i;
			}
		}
		// An object route's points carry a height; the seed takes the one the
		// curve has there. (The camera rail's points have none.)
		const seed = { x: base.x, z: base.z };
		if (base.y !== undefined) seed.y = base.y;
		controls.splice(segmentIdx + 1, 0, seed);
		anchorIdx = segmentIdx + 1;
	}
	// normalized arc parameter of each control point along the control polygon
	const ts = [0];
	for (let i = 1; i < controls.length; i += 1) {
		ts.push(ts[i - 1] + Math.hypot(controls[i].x - controls[i - 1].x, controls[i].z - controls[i - 1].z));
	}
	const total = Math.max(ts[ts.length - 1], 1e-9);
	for (let i = 0; i < ts.length; i += 1) ts[i] /= total;
	// the bump reaches exactly to the neighbouring crane marks
	const t0 = ts[anchorIdx];
	const previous = markIndex > 0 ? marks[markIndex - 1].t : null;
	const next = markIndex < marks.length - 1 ? marks[markIndex + 1].t : null;
	const radius = Math.max(0.15, Math.min(previous != null ? t0 - previous : 1, next != null ? next - t0 : 1));
	const weights = ts.map((t, i) => {
		if (interior && (i === 0 || i === ts.length - 1)) return 0;
		const d = Math.abs(t - t0);
		return d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius));
	});
	return { startControls: controls, weights, t0, radius };
}
