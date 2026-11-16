/**
 * The sculpt shapes that follow points (SCULPT_SHAPE_SPECS entries, same
 * contract as sculpt-shapes.js). Pure: no three.js.
 *
 *   lathe    profile [[r, y]] turned round the part's y axis: vase, pot, bottle
 *   tube     a round tube swept along path [[x, y, z]]: rope, vine, frame tube
 *   extrude  a flat outline [[x, y]] pushed through size z: sign, leaf, gable
 *
 * Every point is a fraction of the part's size, so `size` stays the box the
 * record trusts: a tube's centreline is drawn in the box shrunk by its
 * thickness, and the curves never overshoot their points (sculpt-curve.js).
 */

import { RecipeError, isFiniteNumber, readUnit, tidy } from "./sculpt-recipe-read.js";
import { earClip, insideLoop, loopCrossing, monotoneCurve, signedArea } from "./sculpt-curve.js";

/** The thinnest tube: the same floor as a part's extent (SCULPT_LIMITS.minExtent). */
const MIN_THICKNESS = 0.001;
const RING = 24;
const half = (part) => part.size.map((value) => value / 2);

function readFlag(value, path, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new RecipeError(path, `must be true or false, got ${JSON.stringify(value)}`);
	return value;
}

/** A fresh list of points, each `label`-shaped with every component in [lo, hi]. */
function readPoints(value, path, label, [min, max], [lo, hi]) {
	if (!Array.isArray(value) || value.length < min || value.length > max) {
		throw new RecipeError(path, `must be a list of ${min}-${max} points ${label}, got ${Array.isArray(value) ? `${value.length} points` : JSON.stringify(value)}`);
	}
	const dims = label.split(",").length;
	return value.map((point, i) => {
		if (!Array.isArray(point) || point.length !== dims || !point.every(isFiniteNumber)) {
			throw new RecipeError(`${path}[${i}]`, `must be ${dims} numbers ${label}, got ${JSON.stringify(point)}`);
		}
		point.forEach((component, axis) => {
			if (component < lo || component > hi) throw new RecipeError(`${path}[${i}][${axis}]`, `must be from ${lo} to ${hi}, got ${component}`);
		});
		return point.map(tidy);
	});
}

/** An outline or hole: x and y as fractions of size, any winding, no repeated point. */
function readLoop(value, path, counts) {
	const loop = readPoints(value, path, "[x, y]", counts, [-0.5, 0.5]);
	loop.forEach(([x, y], i) => {
		const [px, py] = loop[(i + loop.length - 1) % loop.length];
		if (x === px && y === py) throw new RecipeError(`${path}[${i}]`, i ? "repeats the point before it" : "repeats the last point; the loop closes by itself");
	});
	return loop;
}

/* ------------------------------------------------------------- lathe ---- */

/** The drawn profile: [r fraction, y metres from the part's centre]. */
export function latheRows(part, steps) {
	const rows = part.smooth ? monotoneCurve(part.profile, steps) : part.profile;
	return rows.map(([r, y]) => [r, (y - 0.5) * part.size[1]]);
}

/** Rings on the drawn profile, one hull per band, so a vase keeps its neck. */
function latheSamples(part) {
	const [hx, , hz] = half(part);
	const rings = latheRows(part, Math.ceil(24 / (part.profile.length - 1))).map(([r, y]) => Array.from({ length: RING }, (_, j) => {
		const angle = (j / RING) * 2 * Math.PI;
		return [r * hx * Math.sin(angle), y, r * hz * Math.cos(angle)];
	}));
	return rings.slice(1).map((ring, k) => [...rings[k], ...ring]);
}

const lathe = {
	keys: ["profile", "smooth"],
	read(raw, part, where) {
		const profile = readPoints(raw.profile, `${where}.profile`, "[r, y]", [3, 32], [0, 1]);
		profile.forEach(([, y], i) => {
			if (i && y < profile[i - 1][1]) throw new RecipeError(`${where}.profile[${i}][1]`, `y must not go down the profile (${y} after ${profile[i - 1][1]}); list it from bottom (0) to top (1)`);
		});
		if (profile.at(-1)[1] === profile[0][1]) throw new RecipeError(`${where}.profile`, "must climb: the last y must be above the first");
		if (profile.every(([r]) => r === 0)) throw new RecipeError(`${where}.profile`, "has every r at 0, so nothing would be drawn");
		part.profile = profile;
		part.smooth = readFlag(raw.smooth, `${where}.smooth`, true);
	},
	samples: latheSamples,
};

/* -------------------------------------------------------------- tube ---- */

/** The path's points in metres: the box shrunk by the thickness, so the round wall fits. */
const tubeKnots = (part) => part.path.map((point) => point.map((value, axis) => value * (part.size[axis] - part.thickness)));

export const tubeCentre = (part, steps) => monotoneCurve(tubeKnots(part), steps, part.closed);

/** Radius at each centreline sample; taper runs by length, so uneven points taper evenly. */
export function tubeRadii(part, centre) {
	const radius = part.thickness / 2;
	if (!part.taper) return centre.map(() => radius);
	const run = [0];
	for (let k = 1; k < centre.length; k += 1) run.push(run[k - 1] + Math.hypot(...centre[k].map((value, axis) => value - centre[k - 1][axis])));
	return run.map((length) => {
		const s = length / run.at(-1);
		return radius * (1 - Math.max(0, part.taper) * s - Math.max(0, -part.taper) * (1 - s));
	});
}

/** 26 unit directions (a cube's faces, edges and corners): a ball the hull can trace. */
const BALL = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
	const length = Math.hypot(x, y, z);
	if (length) BALL.push([x / length, y / length, z / length]);
}

/** One hull per segment between path points, so a U-shaped rope stays open inside. */
function tubeSamples(part) {
	const steps = 4;
	const centre = tubeCentre(part, steps);
	const radii = tubeRadii(part, centre);
	const segments = part.closed ? part.path.length : part.path.length - 1;
	return Array.from({ length: segments }, (_, segment) => {
		const points = [];
		for (let i = segment * steps; i <= (segment + 1) * steps; i += 1) {
			const k = i % centre.length;
			for (const direction of BALL) points.push(centre[k].map((value, axis) => value + direction[axis] * radii[k]));
		}
		return points;
	});
}

const tube = {
	keys: ["path", "thickness", "taper", "closed"],
	read(raw, part, where) {
		part.path = readPoints(raw.path, `${where}.path`, "[x, y, z]", [2, 32], [-0.5, 0.5]);
		const smallest = Math.min(...part.size);
		if (!isFiniteNumber(raw.thickness) || raw.thickness < MIN_THICKNESS || raw.thickness > smallest) {
			throw new RecipeError(`${where}.thickness`, `must be the tube's diameter in metres, from ${MIN_THICKNESS} to the part's smallest size (${tidy(smallest)} m), got ${JSON.stringify(raw.thickness)}`);
		}
		part.thickness = tidy(raw.thickness);
		part.taper = readUnit(raw.taper, `${where}.taper`, 0, -1, 1);
		part.closed = readFlag(raw.closed, `${where}.closed`, false);
		if (part.closed && part.taper) throw new RecipeError(`${where}.taper`, "a closed tube cannot taper: its two ends meet");
		if (part.closed && part.path.length < 3) throw new RecipeError(`${where}.path`, "a closed tube needs at least 3 points");
		const knots = tubeKnots(part);
		knots.forEach((point, i) => {
			if (!i && !part.closed) return;
			const before = knots[(i + knots.length - 1) % knots.length];
			if (Math.hypot(...point.map((value, axis) => value - before[axis])) < 1e-6) {
				throw new RecipeError(`${where}.path[${i}]`, i ? "sits on the point before it once fitted to the size" : "repeats the last point; a closed path joins its ends by itself");
			}
		});
	},
	mirror(copy) {
		copy.path = copy.path.map(([x, y, z]) => [tidy(-x), y, z]);
	},
	samples: tubeSamples,
};

/* ----------------------------------------------------------- extrude ---- */

/** One prism per ear-clipped triangle of the outline. The bevel is ignored. */
function extrudeSamples(part) {
	const [w, h, d] = part.size;
	return earClip(part.outline).map((triangle) => triangle.flatMap((k) => {
		const [x, y] = part.outline[k];
		return [[x * w, y * h, d / 2], [x * w, y * h, -d / 2]];
	}));
}

/** The compare cuts one opening: the largest hole, as its convex hull. */
function extrudeHole(part) {
	if (!part.holes) return null;
	const largest = part.holes.reduce((best, hole) => (Math.abs(signedArea(hole)) > Math.abs(signedArea(best)) ? hole : best));
	return largest.map(([x, y]) => [x * part.size[0], y * part.size[1], 0]);
}

const flipX = (loop) => loop.map(([x, y]) => [tidy(-x), y]);

const extrude = {
	keys: ["outline", "holes", "roundness"],
	read(raw, part, where) {
		part.outline = readLoop(raw.outline, `${where}.outline`, [3, 64]);
		if (raw.holes !== undefined && (!Array.isArray(raw.holes) || raw.holes.length > 4)) {
			throw new RecipeError(`${where}.holes`, `must be a list of at most 4 hole outlines, got ${JSON.stringify(raw.holes).slice(0, 60)}`);
		}
		const holes = (raw.holes ?? []).map((hole, i) => readLoop(hole, `${where}.holes[${i}]`, [3, 32]));
		const names = [`${where}.outline`, ...holes.map((_, i) => `${where}.holes[${i}]`)];
		const crossing = loopCrossing([part.outline, ...holes]);
		if (crossing) {
			const { a, b } = crossing;
			const other = a.loop === b.loop ? "another of its edges" : `${names[b.loop]} (edge ${b.edge})`;
			throw new RecipeError(names[a.loop], `edge ${a.edge} (point ${a.edge} to the next) touches or crosses ${other}; an outline must not cross itself or its holes`);
		}
		[part.outline, ...holes].forEach((loop, i) => {
			if (Math.abs(signedArea(loop)) < 1e-5) throw new RecipeError(names[i], "encloses no area");
		});
		holes.forEach((hole, i) => {
			if (!insideLoop(hole[0], part.outline)) throw new RecipeError(names[i + 1], "must lie inside the outline");
			if (holes.some((other, j) => j !== i && insideLoop(hole[0], other))) throw new RecipeError(names[i + 1], "must not lie inside another hole");
		});
		if (holes.length) part.holes = holes;
		part.roundness = readUnit(raw.roundness, `${where}.roundness`, 0.1, 0, 1);
	},
	mirror(copy) {
		copy.outline = flipX(copy.outline);
		if (copy.holes) copy.holes = copy.holes.map(flipX);
	},
	samples: extrudeSamples,
	hole: extrudeHole,
};

export const CURVED_SHAPE_SPECS = Object.freeze({ lathe, tube, extrude });
