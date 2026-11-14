// The proportion tables of the mannequin looks. Everything is in rest world space: metres, T-pose, facing +Z, +X on
// the figure's left. A part is { rows, start, end, hard }; a row is one cross-section in loft.js's form,
// [t, offsetSide, offsetFront, shape]. loft.js rounds the drawn mesh between the rows and round the corners, so rows
// are few and each one sits on a real change of the form.
//
// The design is the jointed wooden mannequin of a drawing class: separate masses with gaps between them, each a plain
// turned or carved piece, not a muscle. The blocks (ribcage, pelvis, thigh) have flat faces and soft corners, so the
// light shows a front and a side; the rest (head, neck, arms, lower legs) is round. Sizes (how thick a limb is, how
// high a landmark sits) follow measured bodies; the shapes do not.
//
// Torso and head are columns along +Y from the world origin: `slab` and `oval` rows give a height and the z of the
// front and of the back face. Limbs start at their own joint and run toward the next one: a `limb` row is
// [t, width, depth, offsetSide, offsetFront, corner], t the distance from the joint, width across the part's side
// axis, depth across front and back; with a corner radius the section is a rounded rectangle, without one an oval.
// offsetSide is outward for the legs. For the arms it is up in the T-pose, which is outward once the arm hangs.
const POINTS = 12, at = k => (2 * Math.PI * k) / POINTS;

/** Radii of a round section: half width `a` to the side, depth `bf` to the front and `bb` to the back, with the
 * exponents nf and nb (2 is an ellipse, more is squarer). */
const egg = (a, bf, bb, nf, nb = nf) => Array.from({ length: POINTS }, (_, k) => {
	const c = Math.cos(at(k)), s = Math.abs(Math.sin(at(k))), b = c >= 0 ? bf : bb, n = c >= 0 ? nf : nb;
	return +(((s / a) ** n + (Math.abs(c) / b) ** n) ** (-1 / n)).toFixed(4);
});
/** Points [front, side] of a rounded rectangle: half width `a` (`ab` at the back, for a wedge that is narrower in
 * front), `bf` to the front, `bb` to the back, corner radius `c` in front and `cb` behind. The front and the sides
 * are flat; the back is a shallow bow. */
const K = 1 - Math.SQRT1_2;
const block = (a, bf, bb, c, cb = c, ab = a) => {
	const half = [[bf, 0], [bf, a - c], [bf - c * K, a - c * K], [bf - c, a], [-bb + cb, ab], [-bb + cb * K, ab - cb * K], [-bb, 0]];
	return [...half, ...half.slice(1, 6).reverse().map(([u, v]) => [u, -v])].map(([u, v]) => [+u.toFixed(4), +v.toFixed(4)]);
};
/** Column rows: at height y, half width a (ab at the back), the front face at z = zf and the back at z = zb. */
const slab = (y, a, zf, zb, c, cb = c, ab = a) => [y, 0, (zf + zb) / 2, block(a, (zf - zb) / 2, (zf - zb) / 2, c, cb, ab)];
const oval = (y, a, zf, zb, nf, nb = nf) => [y, 0, (zf + zb) / 2, egg(a, (zf - zb) / 2, (zf - zb) / 2, nf, nb)];
/** A slab row whose front swells by `s` at the two front corners and by `s - cleft` on the centre line: the bust. */
const bust = (row, s, cleft) => {
	const p = row[3].map(q => [...q]);
	p[0][0] += s - cleft; p[1][0] += s; p[11][0] += s; p[2][0] += s * 0.5; p[10][0] += s * 0.5;
	return [row[0], row[1], row[2], p];
};
const ROUND = 2.3; // how square a round limb's oval is
/** Limb rows, their width scaled by kw and their depth by kd. */
const limb = (rows, kw = 1, kd = kw) => rows.map(([t, w, d, os = 0, of = 0, c]) =>
	[t, os * kw, of, c ? block((w * kw) / 2, (d * kd) / 2, (d * kd) / 2, c * Math.min(kw, kd)) : egg((w * kw) / 2, (d * kd) / 2, (d * kd) / 2, ROUND)]);
/** Foot rows [t, width, height, offsetSide]: the sole flat on the floor, the top a soft-cornered slope (the part's
 * front is up). */
const sole = (rows, kw = 1, kt = 1) => rows.map(([t, w, h, os = 0]) => [t * kt, os, h * 0.42, egg((w * kw) / 2, h * 0.58, h * 0.42, 3, 7)]);
/** A ball as loft rows: its centre `c` metres from the joint, `len` long, `w` thick (across the side axis) and `d`
 * broad, all scaled by k. */
const ball = (c, len, w, d, k = 1) => [-78, -60, -40, -20, 0, 20, 40, 60, 78].map(deg => {
	const r = (deg * Math.PI) / 180, q = (Math.cos(r) * k) / 2;
	return [(c + (len / 2) * Math.sin(r)) * k, 0, 0, egg(w * q, d * q, d * q, 2)];
});
/** Head and ear rows scaled by k about a point inside the head. */
const HEAD_Y = 1.67, HEAD_Z = -0.012;
const sized = (rows, k) => rows.map(([y, os, z, shape]) => [HEAD_Y + (y - HEAD_Y) * k, os * k, HEAD_Z + (z - HEAD_Z) * k, shape.map(v => (Array.isArray(v) ? v.map(x => x * k) : v * k))]);

// A plain egg, 0.235 m high, 0.16 wide and 0.2 deep: widest two thirds up, narrower toward a broad rounded chin, the
// chin a little forward and the back of the skull full. No features: the front is only a little flatter than the
// back, and that and the ears tell where it faces. It sits 3 cm lower than the rig's head, so that only about 3.5 cm
// of the neck shows between the collar and the chin (a figure of about 7.5 heads).
const HEAD = [
	oval(1.538, 0.028, 0.05, -0.004, 2.2),
	oval(1.558, 0.054, 0.072, -0.034, 2.3),
	oval(1.598, 0.07, 0.088, -0.076, 2.5, 2.1),
	oval(1.648, 0.078, 0.095, -0.1, 2.6, 2.1),
	oval(1.692, 0.08, 0.094, -0.106, 2.6, 2.1),
	oval(1.732, 0.073, 0.081, -0.098, 2.4, 2.1),
	oval(1.756, 0.056, 0.058, -0.076, 2.2),
	oval(1.77, 0.03, 0.026, -0.042, 2),
	oval(1.774, 0.012, 0.006, -0.018, 2),
];
const EAR = limb([[1.618, 0.01, 0.02, 0.0765, -0.016], [1.641, 0.013, 0.03, 0.0785, -0.02], [1.664, 0.01, 0.022, 0.0785, -0.023]]); // the left one

// The parts both figures share, the woman's scaled down.
// A thin post that rises out of the dark collar on top of the ribcage and ends inside the head.
const NECK = [[1.47, 0.062, 0.064, 0, -0.04], [1.53, 0.056, 0.058, 0, -0.03], [1.6, 0.056, 0.058, 0, -0.012]];
const COLLAR = [[1.494, 0.096, 0.086, 0, -0.035], [1.51, 0.09, 0.08, 0, -0.034]];
// A flat top under the knee with a rounded shoulder, a modest calf behind a straight shin, a thin ankle, cut flat.
const SHIN = [[0.02, 0.082, 0.088], [0.036, 0.104, 0.114, 0, -0.003], [0.056, 0.116, 0.13, 0.001, -0.006], [0.12, 0.122, 0.14, 0.002, -0.01], [0.27, 0.08, 0.098, 0, -0.01], [0.36, 0.068, 0.082, 0, -0.007], [0.42, 0.068, 0.08, 0, -0.005]];
// A plain wedge along +Z from the back of the heel, `heel` behind the ankle: highest under the ankle, one slope down
// to a blunt toe.
const FOOT = [[0, 0.062, 0.05], [0.022, 0.08, 0.08], [0.07, 0.088, 0.09], [0.11, 0.094, 0.078, 0.002], [0.225, 0.104, 0.04, 0.005], [0.262, 0.096, 0.03, 0.004]];
// The shoulder cap: a separate rounded piece over the top of the upper arm. It rises from the arm's axis to the
// shoulder line, is fullest just past the joint, covers the upper half of the arm and ends in a cut lower edge, out
// of which the thinner arm comes.
const CAP = [[-0.058, 0.05, 0.06, 0.008, 0.006], [-0.04, 0.092, 0.106, 0.01, 0.008], [-0.008, 0.116, 0.132, 0.012, 0.01], [0.05, 0.12, 0.136, 0.012, 0.01], [0.115, 0.114, 0.128, 0.01, 0.008], [0.135, 0.108, 0.12, 0.009, 0.008]];
// Tapered round pieces with nearly straight sides.
const UPPER_ARM = [[0, 0.094, 0.1, 0.004], [0.1, 0.09, 0.096, 0.003], [0.252, 0.078, 0.082, 0, 0.001]];
const FORE_ARM = [[0.028, 0.09, 0.096], [0.062, 0.102, 0.11, 0.002], [0.272, 0.058, 0.068]];
// The hand is a plain ball on the wrist core, a little longer than broad and a little flat: [centre, length,
// thickness, breadth] for `ball`. No fingers, no thumb.
const HAND = [0.078, 0.115, 0.085, 0.1];

const flat = rows => ({ rows, start: "flat", end: "flat" }), cut = rows => ({ rows, start: "cut", end: "cut" });

export const MAN = {
	head: flat(HEAD),
	ear: flat(EAR),
	neck: flat(limb(NECK)),
	collar: flat(limb(COLLAR)),
	// The middle of the torso, on the Spine joint, in the body colour: a block about 1 cm narrower all round than the
	// lower rib edge above it and the pelvis rim below it, its rounded ends tucked inside both, so the three masses
	// tilt and twist against each other and the waist is not open.
	abdomen: {
		rows: [slab(1.035, 0.06, 0.05, -0.05, 0.03), slab(1.06, 0.098, 0.082, -0.084, 0.04), slab(1.09, 0.106, 0.09, -0.092, 0.042), slab(1.14, 0.098, 0.07, -0.086, 0.04), slab(1.185, 0.09, 0.046, -0.076, 0.034), slab(1.215, 0.08, 0.04, -0.07, 0.03), slab(1.24, 0.05, 0.02, -0.05, 0.024)],
		start: "flat", end: "flat", line: [1.096, 1.182],
	},
	// One block, the tall mass of the torso (the pelvis is the short one, about 1.7 to 1 as in the reference drawing).
	// Bottom up: the lower edge, cut flat and tucked back so an arm that crosses the body stays in front of it; flat
	// front and sides widening to the crease across the chest (a hard row: the front-most cut, a line all round); the
	// upper chest plane leaning back to a square shoulder line; a short slope up to the flat top that carries the collar.
	// The sides slope all the way from the shoulders to the lower edge (a trapezoid from the front, as drawn).
	ribcage: {
		rows: [slab(1.185, 0.1, 0.056, -0.086, 0.03), slab(1.335, 0.132, 0.118, -0.114, 0.04), slab(1.46, 0.152, 0.096, -0.12, 0.042), slab(1.48, 0.14, 0.086, -0.114, 0.044), slab(1.5, 0.086, 0.036, -0.096, 0.04)],
		hard: [1.335], start: "cut", end: "flat", line: [1.2, 1.47],
	},
	// The briefs: a front panel that stands a little in front of the thighs, a straight V from the crotch up to the
	// hip line (a hard row), so the leg openings are cut on the diagonal and the top of each thigh shows in its
	// opening; the back narrows less than the front. Above the hip line the sides close a little to the rim, a band
	// that stands 3 mm proud and is cut flat on top.
	pelvis: {
		rows: [slab(0.9, 0.03, 0.098, -0.078, 0.02, 0.03, 0.078), slab(1.04, 0.12, 0.1, -0.106, 0.042), slab(1.064, 0.114, 0.098, -0.1, 0.042), slab(1.068, 0.117, 0.101, -0.103, 0.045), slab(1.09, 0.117, 0.101, -0.103, 0.045)],
		hard: [1.04], start: "flat", end: "cut", line: [0.915, 1.082],
	},
	// A ball around the hip joint, then a block with flat front and sides: widest at the top, a nearly straight taper
	// to the flat cut above the knee.
	thigh: { rows: limb([[-0.056, 0.07, 0.08, 0.002], [-0.032, 0.112, 0.128, 0.003], [0, 0.136, 0.162, 0.004, -0.006, 0.05], [0.05, 0.148, 0.192, 0.006, -0.006, 0.045], [0.24, 0.121, 0.151, 0.003, -0.002, 0.038], [0.418, 0.094, 0.108, 0, 0.002, 0.03]]), start: "flat", end: "cut" },
	shin: cut(limb(SHIN)),
	foot: { ...flat(sole(FOOT)), heel: 0.062 },
	cap: { rows: limb(CAP), start: "flat", end: "cut" },
	upperArm: { rows: limb(UPPER_ARM), start: "flat", end: "cut" },
	foreArm: cut(limb(FORE_ARM)),
	hand: flat(ball(...HAND)),
	// Radius of the dark core in the gap at each joint: thin at knee, wrist and ankle, a band as thick as the arm at
	// the elbow.
	cores: { ForeArm: 0.037, Hand: 0.017, Leg: 0.024, Foot: 0.02 },
};

// Woman: a narrower ribcage with the bust over a crease and a small waist cut, a narrower abdomen, a wider and
// rounder pelvis (the hips swell from a narrow rim down to the leg openings, with no hard hip line), fuller thighs
// with rounder corners, slimmer neck, arms and shoulder caps.
export const WOMAN = {
	head: flat(sized(HEAD, 0.96)),
	ear: flat(sized(EAR, 0.96)),
	neck: flat(limb(NECK, 0.88)),
	collar: flat(limb(COLLAR, 0.88)),
	abdomen: {
		rows: [slab(1.04, 0.056, 0.048, -0.05, 0.028), slab(1.065, 0.094, 0.08, -0.084, 0.04), slab(1.094, 0.104, 0.088, -0.09, 0.042), slab(1.15, 0.086, 0.066, -0.08, 0.038), slab(1.2, 0.076, 0.046, -0.066, 0.032), slab(1.23, 0.066, 0.04, -0.06, 0.028), slab(1.255, 0.042, 0.02, -0.044, 0.02)],
		start: "flat", end: "flat", line: [1.1, 1.196],
	},
	ribcage: {
		rows: [slab(1.2, 0.086, 0.056, -0.076, 0.028), bust(slab(1.305, 0.109, 0.094, -0.098, 0.038), 0.004, 0), bust(slab(1.35, 0.116, 0.1, -0.106, 0.04), 0.03, 0.012), slab(1.41, 0.125, 0.094, -0.112, 0.04), slab(1.46, 0.13, 0.08, -0.114, 0.04), slab(1.48, 0.12, 0.07, -0.108, 0.042), slab(1.5, 0.076, 0.03, -0.092, 0.036)],
		hard: [1.305], start: "cut", end: "flat", line: [1.215, 1.47],
	},
	pelvis: {
		rows: [slab(0.882, 0.03, 0.096, -0.082, 0.02, 0.032, 0.085), slab(0.985, 0.158, 0.1, -0.118, 0.056), slab(1.035, 0.142, 0.1, -0.112, 0.052), slab(1.066, 0.112, 0.097, -0.099, 0.046), slab(1.07, 0.115, 0.1, -0.102, 0.049), slab(1.094, 0.115, 0.1, -0.102, 0.049)],
		start: "flat", end: "cut", line: [0.897, 1.086],
	},
	thigh: { rows: limb([[-0.056, 0.07, 0.08, 0.004], [-0.032, 0.114, 0.126, 0.008], [0, 0.142, 0.16, 0.012, -0.006, 0.055], [0.06, 0.166, 0.188, 0.02, -0.004, 0.055], [0.24, 0.128, 0.15, 0.012, 0.002, 0.042], [0.418, 0.092, 0.102, 0, 0.006, 0.03]]), start: "flat", end: "cut" },
	shin: cut(limb(SHIN, 0.96)),
	foot: { ...flat(sole(FOOT, 0.96, 0.95)), heel: 0.062 },
	cap: { rows: limb(CAP, 0.86), start: "flat", end: "cut" },
	upperArm: { rows: limb(UPPER_ARM, 0.88), start: "flat", end: "cut" },
	foreArm: cut(limb(FORE_ARM, 0.92)),
	hand: flat(ball(...HAND, 0.92)),
	cores: { ForeArm: 0.032, Hand: 0.015, Leg: 0.022, Foot: 0.019 },
};
