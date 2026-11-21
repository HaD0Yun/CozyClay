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
// sum has no direction at two places, both up, behind the hips and out to a side (about [+-0.79, 0.44, -0.44]): there
// the side chosen from one frame alone is not continuous in d, and near them it turns fast.
//
// So the knee also goes on from the frame before (`prev`: the leg's d, the knee's side across it there, and whether
// that knee was off the side chosen, as solve.js returns them; none on a clip's first frame or in a pose solved on its
// own, which take the side chosen above). A knee that was on the side chosen stays on it, to the last bit, unless that
// side has turned about the hip-ankle line by more than moves the knee twice SWING further than the ankle went round the
// hip since the frame before; so does every knee where the leg's direction itself turned more than LEAP. A knee that
// has left the side chosen, carried by the shortest turn that takes the old d to the new one, turns back toward it by
// as far as moves the knee SWING further than the ankle went (the short way round, or the other way where the short
// way passes the side opposite the middle of the two sides the sum is made of), and is on it again once that reaches
// it. Two things change that turn (kneePole): under the foot's floor it turns less, and off a side every hinge reading
// forbids it turns more, in one frame; that one frame can move the knee further than SWING.
import { INDEX as J, OFFSET } from "../rig17.js";
import { X, add, cross, dot, len, mul, norm, qConj, qRotate, sub } from "./math.js";

const BAND = 0.25; // the least part of the pole (length 0.5..1.5) along the knee's side
const MID = norm([0, -1, 1]); // the leg direction the carried part starts from: 45 degrees forward of down
const FRONT = cross(MID, X); // where the knee of a leg along MID stands off it
const SWING = 0.015; // m (at scale 1): how much further than the ankle went round the hip a knee off the side chosen turns back about the line in a frame; a knee on that side leaves it for a turn of over twice this
const LEAP = 0.2; // rad: a leg that turned more than this in one frame starts from the side chosen on that frame
const L1 = len(OFFSET[J.LeftLeg]), L2 = len(OFFSET[J.LeftFoot]);

/** v turned by the shortest turn that takes unit a to unit b; null where they point (nearly) opposite ways. */
function carry(v, a, b) {
	const c = dot(a, b), k = cross(a, b);
	return 1 + c > 1e-9 ? add(add(mul(v, c), cross(k, v)), mul(k, dot(k, v) / (1 + c))) : null;
}
const across = (v, d) => norm(sub(v, mul(d, dot(v, d))), [0, 0, 0]);

/** The pole that bends a knee on a leg from `hip` to `ankle` under the pelvis turn qP, given the solver's `pole` and
 *  the frame before's { d, side, off } (pelvis frame) or nothing. -> { pole, d, side, off }: d and the side the pole
 *  puts the knee on, in the pelvis frame, and whether that is off the side chosen, for the next frame. */
export function kneePole(qP, hip, ankle, pole, prev, floor) {
	const inv = qConj(qP), v = sub(ankle, hip), d = qRotate(inv, norm(v, [0, -1, 0])), out = chosen(inv, qP, d, pole);
	const side = across(qRotate(inv, out), d), was = prev && dot(prev.d, d) > Math.cos(LEAP) && carry(prev.side, prev.d, d);
	const from = was ? across(was, d) : [0, 0, 0];
	if (!len(from) || !len(side)) return { pole: out, d, side };
	// angles about d from `from`: the side chosen, and the side opposite the middle of the two sides the sum is made of
	const at = w => Math.atan2(dot(w, cross(d, from)), dot(w, from)), to = at(side), far = carry(FRONT, MID, d);
	const back = far && len(cross(d, X)) > 1e-6 ? at(mul(norm(add(norm(cross(d, X)), far), [0, 0, 0]), -1)) : null;
	const passes = back !== null && Math.abs(back) < Math.abs(to) && Math.sign(back) === Math.sign(to);
	const turn = passes ? to - Math.sign(to) * 2 * Math.PI : to, s = Math.sign(turn);
	const dist = Math.min(Math.max(len(v), Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995), a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
	const h = Math.sqrt(Math.max(0, L1 * L1 - a * a)); // the knee's distance from the hip-ankle line
	const most = (SWING + dist * Math.acos(Math.min(1, dot(prev.d, d)))) / Math.max(h, 1e-9); // plus as far as the ankle went round the hip
	// a knee on the side chosen leaves it only for a turn of over twice SWING past the ankle's; one that has left comes back SWING a frame
	if (Math.abs(turn) <= most + (prev.off ? 0 : SWING / Math.max(h, 1e-9))) return { pole: out, d, side };
	// It goes no nearer than where its hinge is neither over 89 degrees from every untwisted one (twist) where the side
	// chosen is not over 90, nor under the floor further than both the knee carried and the knee on the side chosen.
	const sideAt = k => add(mul(from, Math.cos(s * k)), mul(cross(d, from), Math.sin(s * k))), high = w => hip[1] + qRotate(qP, add(mul(d, a), mul(w, h)))[1];
	const right = twist(d, side, a, h, dist) <= 90, low = Math.min(high(from), high(side), floor);
	const wrong = k => right && twist(d, sideAt(k), a, h, dist) > 89, under = k => high(sideAt(k)) < low, bad = k => wrong(k) || under(k);
	// Under the floor ahead, it turns less, as far as it can (the side carried is never lower than that); bent the way it
	// cannot, it goes on past that place.
	let k = most;
	if (!wrong(most) && under(most)) {
		let lo = 0, hi = most;
		for (let n = 0; n < 20; n++) { const m = (lo + hi) / 2; if (under(m)) hi = m; else lo = m; }
		k = lo;
	}
	if (bad(k)) {
		let lo = most, hi = Math.abs(turn);
		for (let n = 1; n <= 24; n++) { const m = most + (Math.abs(turn) - most) * n / 24; if (!bad(m)) { hi = m; break; } lo = m; }
		for (let n = 0; n < 20; n++) { const m = (lo + hi) / 2; if (bad(m)) lo = m; else hi = m; }
		k = Math.min(hi + 0.01, Math.abs(turn)); // a little past that place: a convention's turn can begin or end on it
	}
	if (k === Math.abs(turn)) return { pole: out, d, side };
	const now = sideAt(k);
	return { pole: qRotate(qP, now), d, side: now, off: true };
}

/** How far (degrees) the hinge of a knee on `side` of a leg along d (the knee a along d and h off it, the ankle dist
 *  along it) is from the nearest hinge an untwisted thigh can have, over 90 where every one says it cannot bend that
 *  way: 0 within 15 degrees of X and 180 within 15 degrees of -X; else the least angle from X's part square to the
 *  thigh and from X carried by the shortest turn from straight down, and from 45 degrees forward of down, to the thigh
 *  (each left out where it has no direction; 0 where none has one, or the leg is straight). */
function twist(d, side, a, h, dist) {
	const t = norm(add(mul(d, a), mul(side, h))), hinge = norm(cross(t, sub(mul(d, dist - a), mul(side, h))), [0, 0, 0]);
	if (!len(hinge) || h < 1e-6) return 0;
	const off = dot(hinge, X);
	if (Math.abs(off) > Math.cos(15 * Math.PI / 180)) return off < 0 ? 180 : 0;
	const refs = [sub(X, mul(t, t[0]))];
	for (const start of [[0, -1, 0], MID]) if (dot(start, t) > Math.cos(168 * Math.PI / 180)) refs.push(carry(X, start, t));
	const h2 = across(hinge, t), seen = refs.filter(r => len(r) > Math.sin(5 * Math.PI / 180));
	return seen.length ? Math.min(...seen.map(r => Math.acos(Math.max(-1, Math.min(1, dot(h2, norm(r))))) * 180 / Math.PI)) : 0;
}

/** The side chosen from this frame alone (the header): the solver's pole, or its part along the knee's side mirrored. */
function chosen(inv, qP, d, pole) {
	const g = add(cross(d, X), mul(carry(FRONT, MID, d) ?? [0, 0, 0], d[0] * d[0])), n = len(g);
	if (n < 1e-9) return pole;
	const u = dot(qRotate(inv, pole), g) / n, goal = Math.max(Math.abs(u), BAND);
	return u >= goal ? pole : add(pole, qRotate(qP, mul(g, (goal - u) / n)));
}
