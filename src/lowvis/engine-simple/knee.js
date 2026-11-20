// The side a knee bends to. The leg's hinge is pole x (hip -> ankle) (solve.js limb); the knee stands off the hip-ankle
// line d along the pole's part across d. Everything here is in the pelvis frame (X its left), so it holds whatever way
// the whole figure is turned and at any size.
//
// The side a knee can bend to is taken from one direction across d, the sum of two:
// - d x X: the knee of a hip that only flexes, the hinge along the pelvis's left. On the pelvis's sagittal plane that is
//   the knee of every flexion (the foot in front, above the hips or behind them alike). It has no direction where the
//   leg points along X (the foot straight out to a side or across).
// - FRONT carried by the shortest turn that takes MID to d, weighed by the square of d's part along X: the same on the
//   sagittal plane, and in front of the leg and above it where the leg points out to a side.
// The solver's own pole (the pelvis's forward plus half the foot's) is kept wherever its part along that direction is at
// least BAND; below it that part is mirrored and held at BAND or more, so the pole never comes onto the leg's line. The
// sum has no direction at two places, both up, behind the hips and out to a side (about [+-0.79, 0.44, -0.44]): there,
// and only there, the knee is not continuous in d, and near them it turns fast.
import { X, add, cross, dot, len, mul, norm, qConj, qRotate, sub } from "./math.js";

const BAND = 0.25; // the least part of the pole (length 0.5..1.5) along the knee's side
const MID = norm([0, -1, 1]); // the leg direction the carried part starts from: 45 degrees forward of down
const FRONT = cross(MID, X); // where the knee of a leg along MID stands off it

/** The pole that bends a knee on a leg from `hip` to `ankle` under the pelvis turn qP, given the solver's `pole`. */
export function kneePole(qP, hip, ankle, pole) {
	const inv = qConj(qP), d = qRotate(inv, norm(sub(ankle, hip), [0, -1, 0])), c = dot(MID, d), k = cross(MID, d);
	const carried = 1 + c > 1e-9 ? add(add(mul(FRONT, c), cross(k, FRONT)), mul(k, dot(k, FRONT) / (1 + c))) : [0, 0, 0];
	const g = add(cross(d, X), mul(carried, d[0] * d[0])), n = len(g);
	if (n < 1e-9) return pole;
	const u = dot(qRotate(inv, pole), g) / n, goal = Math.max(Math.abs(u), BAND);
	return u >= goal ? pole : add(pole, qRotate(qP, mul(g, (goal - u) / n)));
}
