// Route sketch geometry: a freehand floor stroke (world x/z metres) turned
// into the few points a route needs. Pure; RouteSketchTool.jsx feeds it.

export const ROUTE_MAX_POINTS = 64; // what the agent context carries
const WALK_MIN_STEP_M = 0.5; // a root waypoint needs ≥ 8 frames (≈ 0.47 m at a walk)

const round = (value) => Math.round(value * 100) / 100;

function routeLength(points) {
	let length = 0;
	for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
	return length;
}

function segmentDistance(p, a, b) {
	const dx = b.x - a.x, dz = b.z - a.z, span = dx * dx + dz * dz;
	const t = span ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / span)) : 0;
	return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/** Douglas-Peucker: the points that keep the stroke within `epsilon` metres. */
function simplifyRoute(points, epsilon) {
	if (points.length < 3) return points.slice();
	const keep = new Uint8Array(points.length);
	keep[0] = keep[points.length - 1] = 1;
	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const [first, last] = stack.pop();
		let worst = -1, index = -1;
		for (let i = first + 1; i < last; i += 1) {
			const distance = segmentDistance(points[i], points[first], points[last]);
			if (distance > worst) { worst = distance; index = i; }
		}
		if (worst > epsilon) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/** Simplify with a growing tolerance until at most `maxPoints` remain. */
function fitRoute(points, maxPoints = ROUTE_MAX_POINTS, epsilon = 0.05) {
	let fitted = simplifyRoute(points, epsilon);
	while (fitted.length > maxPoints) {
		epsilon *= 1.5;
		fitted = simplifyRoute(points, epsilon);
	}
	return fitted;
}

/**
 * The chip's route: the stroke with its first point on the character's feet,
 * consecutive duplicates dropped, at most ROUTE_MAX_POINTS points rounded to a
 * centimetre. Null when the stroke is too short to be a route.
 */
export function routeFromStroke(stroke, start) {
	const raw = [{ x: start.x, z: start.z }, ...stroke.slice(1)].filter((point, i, list) => i === 0 || Math.hypot(point.x - list[i - 1].x, point.z - list[i - 1].z) > 0.01);
	if (raw.length < 2 || routeLength(raw) < 0.25) return null;
	const points = fitRoute(raw).map((point) => ({ x: round(point.x), z: round(point.z) }));
	return { points, lengthM: round(routeLength(points)) };
}

/**
 * Where "Apply as walk" pins the root: the route after its start (frame 0 is
 * the character's own spot), points at least WALK_MIN_STEP_M apart, at most
 * `maxPins`, the route's end always kept.
 */
function walkPins(points, maxPins) {
	const pins = [];
	let last = points[0];
	for (const point of fitRoute(points, maxPins + 1).slice(1)) {
		if (Math.hypot(point.x - last.x, point.z - last.z) < WALK_MIN_STEP_M) continue;
		pins.push(point);
		last = point;
	}
	// The walk ends where the route does: a pin too close to the end gives way to it.
	const end = points.at(-1), gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
	if (pins.at(-1) !== end) {
		if (pins.length && gap(end, pins.at(-1)) < WALK_MIN_STEP_M) pins.pop();
		if (!pins.length || gap(end, pins.at(-1)) >= WALK_MIN_STEP_M) pins.push(end);
	}
	return pins.length > maxPins ? [...pins.slice(0, maxPins - 1), end] : pins;
}

const WALK_SPEED_MPS = 1.4;

/**
 * "Apply as walk": the root waypoints that walk `points` at a constant
 * WALK_SPEED_MPS. Each pin's frame is the metres walked to it along the pins
 * (the root moves in straight legs between them) over the speed, at `fps`.
 * Empty when the route is too short to walk; the caller checks the last frame
 * against the clip.
 */
export function walkWaypoints(points, { fps, maxPins }) {
	const pins = walkPins(points, maxPins);
	let walked = 0, previous = points[0];
	const waypoints = pins.map((pin) => {
		walked += Math.hypot(pin.x - previous.x, pin.z - previous.z);
		previous = pin;
		return { frame: Math.max(1, Math.round((walked / WALK_SPEED_MPS) * fps)), x: pin.x, z: pin.z };
	});
	return waypoints;
}

/** A drawn stroke cut to at most `max` points (Douglas-Peucker on the floor plane; each kept point keeps its height). */
export const simplifyStroke = (points, max = ROUTE_MAX_POINTS) => fitRoute(points, max);
