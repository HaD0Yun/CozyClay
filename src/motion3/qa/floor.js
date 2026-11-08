// GROUND for the body above the soles (#1113): every part of the skin under the floor (y 0) deeper than the ground's
// allowance (QA_LIMITS.groundAllow, as a sole), as "<part> below floor": the palms (hand_<k>), the fingers (fingers_<k>),
// the forearms and upper arms, the thighs and shins (a knee is the end of both), the hips, the torso, the shoulders,
// the neck and the head. A part planted on the floor touches it; it does not sink into it. The feet are the soles'
// ("<Side> sole below floor", checks.js). Physics bench 2026-11-07: fingertips 9-18 cm under the floor in 6 of 12
// floor-task runs and thighs 20 cm in a crawl, with QA clean.
// The skin is the fitted body's (body.js grids: the cells within half a step of the skin, moved onto it along the
// grid's gradient, one per SPACING cube, carried by their bone); the fingers have no grid and are their phalanx
// capsules (geometry.js fingerCapsules). Against the rig's skinned mesh posed on the 30 bench takes (linear blend
// skinning, the surface verify_result measures; 7689 frames), each part's deepest point agrees within 4.1 mm, with no
// part read over 1 cm in where the skin is under 0.5 cm and none read under 1 cm where it is over 1.5 cm; the joint
// capsules (CAPSULES) are off by up to 10 cm (the torso 3 cm under the floor where the skin lies on it, the hips' 3 cm
// missed). A rig without a fitted body is measured on the capsules.
import { len, scale, sub } from "../compiler/math.js";
import { bodyFor } from "../body.js";
import { regionOf } from "./body-checks.js";
import { CAPSULES, fingerCapsules } from "./geometry.js";

const SPACING = 0.01, FEET = /(Foot|Toe)/;
const skins = new Map();

/** Skin points of every fitted bone but the feet, in the bones' bind frames: [[bone, local point, part], ...]; null without a fitted body. */
function bodySkin(sk) {
	if (skins.has(sk.model)) return skins.get(sk.model);
	const body = bodyFor(sk), out = body ? [] : null;
	for (const g of body?.grids ?? []) {
		if (FEET.test(sk.names[g.b])) continue;
		const [nx, ny, nz] = g.dims, step = body.step, at = (i, j, k) => g.data[(i * ny + j) * nz + k] / 1000, part = regionOf(sk, g.b), seen = new Set();
		for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {
			const d = at(i, j, k);
			if (Math.abs(d) > step / 2) continue;
			const grad = [at(i + 1, j, k) - at(i - 1, j, k), at(i, j + 1, k) - at(i, j - 1, k), at(i, j, k + 1) - at(i, j, k - 1)], l = len(grad);
			if (l < 1e-9) continue;
			const q = sub([g.min[0] + i * step, g.min[1] + j * step, g.min[2] + k * step], scale(grad, d / l)), cell = q.map(v => Math.floor(v / SPACING)).join();
			if (!seen.has(cell)) { seen.add(cell); out.push([g.b, q, part]); }
		}
	}
	skins.set(sk.model, out);
	return out;
}

/** The part that drives part p's height: each arm below the elbow its hand (fingers_<k>, hand_<k>, farm_<k>), the rest the body. */
const driverOf = p => /^(?:fingers|hand|farm)_([lr])$/.exec(p)?.[1] ?? "body";

/**
 * The parts deepest under the floor at state s, one for each arm below the elbow and one for the rest of the body:
 * [[part, depth]] with depth past `allow`. One part a frame for each: a body lying 10 cm in the floor is one problem
 * (raise it), not its thighs, shins, hips, torso and head each.
 */
export function floorParts(sk, s, allow) {
	const worst = new Map();
	for (const [part, d] of floorDepths(sk, s)) { const k = driverOf(part); if (d > allow && !(worst.get(k)?.[1] >= d)) worst.set(k, [part, d]); }
	return [...worst.values()];
}

/** How deep (m) each part's skin goes under the floor at state s: Map part -> depth (negative: its lowest point is above it). */
export function floorDepths(sk, s) {
	const deep = new Map(), put = (part, d) => { if (!(deep.get(part) >= d)) deep.set(part, d); };
	const skin = bodySkin(sk);
	if (skin) for (const [b, q, part] of skin) { const R = s.R[b]; put(part, -(s.P[b][1] + R[1][0] * q[0] + R[1][1] * q[1] + R[1][2] * q[2])); }
	else for (const [part, a, b, r] of CAPSULES) put(part, r - Math.min(s.P[sk.index[a]][1], s.P[sk.index[b]][1]));
	for (const side of ["Left", "Right"]) for (const [part, a, b, r] of fingerCapsules(sk, s, side)) put(part, r - Math.min(a[1], b[1]));
	return deep;
}
