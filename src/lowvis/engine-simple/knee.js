// The side a knee bends to. The leg's hinge is pole x (hip -> ankle) (solve.js limb). A knee bends to the side it can
// when that hinge has no part along the pelvis's right axis: on the pelvis's sagittal plane that is the hinge of every
// hip flexion, the foot in front, above the hips or behind them alike. In the pelvis frame the pole's part along
// d x X (d the hip-ankle direction, X the pelvis's left) is that hinge's part along X. The solver's own pole (the
// pelvis's forward plus half the foot's) is kept wherever that part is at least BAND; below it the part is mirrored
// and held at BAND or more, so the knee never folds onto the leg's line and moves on continuously as the pole and the
// leg turn. Everything is in the pelvis frame, so it holds whatever way the whole figure is turned and at any size.
//
// d x X has no direction where the leg points along X (the foot straight out to a side or across). The correction fades
// out within SIDE of that line, where the solver's pole lies forward of the leg and bends the knee as a hip turned out
// bends it.
import { X, add, clamp, cross, dot, len, mul, norm, qConj, qRotate, sub } from "./math.js";

const BAND = 0.25; // the least part of the pole (length 0.5..1.5) along d x X
const SIDE = 0.2; // sin of the angle from the left-right line within which the correction fades out

/** The pole that bends a knee on a leg from `hip` to `ankle` under the pelvis turn qP, given the solver's `pole`. */
export function kneePole(qP, hip, ankle, pole) {
	const inv = qConj(qP), d = qRotate(inv, norm(sub(ankle, hip), [0, -1, 0])), g = cross(d, X), n = len(g), w = clamp(n / SIDE);
	if (w === 0) return pole;
	const u = dot(qRotate(inv, pole), g) / n, goal = Math.max(Math.abs(u), BAND);
	return u >= goal ? pole : add(pole, qRotate(qP, mul(g, w * (goal - u) / n)));
}
