// Where a standing body stands (standIdle): clear of the scene's bodies, and within reach of what it reaches for.
// Session 7f15b4ae: every cup and ball attempt stood with a foot in the table (COLLIDE foot_r x cube over the whole
// take) and the arm at full reach, while QA's hint already said how far to move the body; the agent kept guessing
// `at` by hand. Two rules:
//   clear   a stance whose legs, feet or hips are inside a body (a table, a box on the floor) slides out of it, the
//           least distance that clears it by MARGIN: straight back first, then sideways, then the diagonals
//   reach   standIdle with no `at` (and no root keyed) before a reachGrip in the same spec keeps its heading and steps
//           up to the anchor: the reaching shoulder in line with it, as near as COMFORT of the arm's length allows,
//           then back out of whatever is in the way (it stands at a table's edge)
// The body is the rest pose's legs, feet and hips as capsules (qa/geometry.js radii); a body whose top is under
// SUPPORT m (a floor, a mat, a low step) is stood on, not stood clear of.
import { add, sub, len, apply, ry } from "../compiler/math.js";
import { sdBox } from "../qa/geometry.js";
import { partsOf } from "../object-pose.js";

const MARGIN = 0.01, SUPPORT = 0.12, COMFORT = 0.8, SLIDE = 0.6, STEP = 0.01, NEAREST = 0.15, HANG = 0.62;
// [from, to, radius] of the standing body, as in qa/geometry.js CAPSULES (the foot: ankle to the toe tip)
const PARTS = ["Left", "Right"].flatMap(S => [[`${S}UpLeg`, `${S}Leg`, 0.07], [`${S}Leg`, `${S}Foot`, 0.05], [`${S}Foot`, `${S}ToeBase`, 0.045], [`${S}ToeBase`, `${S}Toe_End`, 0.04]])
	.concat([["LeftUpLeg", "RightUpLeg", 0.095], ["Hips", "Spine2", 0.12]]);
const DIRS = [[0, -1], [1, 0], [-1, 0], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];

/** The standing body's sample points [p, r] at ground point c = [x, z] facing heading h (deg): legs, feet, hips and the arms hanging at the sides (standIdle's FK arms down). */
function bodyPoints(sk, c, h) {
	const I = sk.index, P = sk.restWorldPos, hip = P[I.Hips], R = ry(h), at = p => add([c[0], 0, c[1]], apply(R, [p[0] - hip[0], p[1], p[2] - hip[2]]));
	const seg = (A, B, r) => [0, 0.25, 0.5, 0.75, 1].map(t => [add(A, sub(B, A).map(v => v * t)), r]);
	const arms = ["Left", "Right"].flatMap(S => { const sh = P[I[`${S}Arm`]], side = Math.sign(sh[0] - hip[0]) * 0.04; return seg(at(sh), at([sh[0] + side, sh[1] - HANG * (sk.landmarks?.scale?.arm ?? 1), sh[2]]), 0.045); });
	return PARTS.filter(([a, b]) => I[a] !== undefined && I[b] !== undefined).flatMap(([a, b, r]) => seg(at(P[I[a]]), at(P[I[b]]), r)).concat(arms);
}

/** The bodies a stance must stay clear of: every scene body whose top is above SUPPORT m. */
const obstacles = scene => Object.values(scene?.objects ?? {}).filter(o => o.half && o.pos && o.R && o.pos[1] + 2 * o.half[1] * o.R[1][1] > SUPPORT);

/** How far the body at c, h is clear of the obstacles (m; negative: inside one by that much, past MARGIN). */
function clearance(sk, boxes, c, h) {
	let worst = Infinity;
	for (const [p, r] of bodyPoints(sk, c, h)) for (const b of boxes) worst = Math.min(worst, sdBox(p, b) - r - MARGIN);
	return worst;
}

/** A stance at c ([x, z]) facing h moved the least distance out of the scene's bodies: { at, moved } or null when it is clear. */
export function clearStance(sk, scene, c, h) {
	const boxes = obstacles(scene);
	if (!boxes.length || clearance(sk, boxes, c, h) >= 0) return null;
	const R = ry(h);
	for (let d = STEP; d <= SLIDE + 1e-9; d += STEP) {
		for (const [x, z] of DIRS) {
			const v = apply(R, [x * d, 0, z * d]), at = [c[0] + v[0], c[1] + v[2]];
			if (clearance(sk, boxes, at, h) >= 0) return { at: at.map(n => +n.toFixed(4)), moved: +d.toFixed(2) };
		}
	}
	return null;
}


/** The standing body at c ([x, z]) facing h: its least distance to the bodies (ids not in skip; m, negative inside). */
export function standClearance(sk, scene, c, h, skip = new Set()) {
	const boxes = obstacles({ objects: Object.fromEntries(Object.entries(scene?.objects ?? {}).filter(([id]) => !skip.has(id))) });
	return boxes.length ? clearance(sk, boxes, c, h) : Infinity;
}
/**
 * The world point an anchor definition names on the still scene, as anchors.js resolves it: world p; an object's (or a
 * group's) `local` point, its base pivot without one; with `grasp` and no `local`, the centre of its parts (where a
 * thin part's socket sits). Null for any other kind.
 */
function anchorPoint(scene, a) {
	if (a?.kind === "world" && Array.isArray(a.p)) return a.p;
	if (a?.kind !== "object" || !scene) return null;
	const o = scene.objects?.[a.object] ?? scene.groups?.[a.object];
	if (!o) return null;
	if (!a.grasp || a.local) return add(o.pos, apply(o.R, a.local ?? [0, 0, 0]));
	const parts = partsOf(scene, a.object).map(id => scene.objects[id]).filter(p => p?.half);
	const centres = parts.map(p => add(p.pos, apply(p.R, [0, p.half[1], 0])));
	return centres.reduce((m, p) => add(m, p.map(v => v / centres.length)), [0, 0, 0]);
}

/**
 * The stance for a standIdle with no `at`: the first reachGrip after it in `use` (index i) and its anchor. The body
 * keeps its facing (args.heading, else the keyed yaw, else 0: the agent turns it by heading) and steps up to the
 * anchor: the reaching shoulder lined up with it, COMFORT of the arm's length from it (at least NEAREST m ahead), then
 * straight back out of any body in the way (a table: the body stands at its edge). { at, heading, anchor, moved } or
 * null when no reachGrip follows or its anchor has no still point.
 */
export function reachStance(ctx) {
	const { sk, scene, use = [], index = -1 } = ctx, next = use.slice(index + 1).find(u => u?.skill === "reachGrip");
	const a = next && (next.args?.define ?? ctx.anchors?.[next.args?.anchor]), T = anchorPoint(scene, a);
	if (!T) return null;
	const I = sk.index, P = sk.restWorldPos, S = next.args.side === "l" ? "Left" : "Right", hip = P[I.Hips], sh = P[I[`${S}Arm`]];
	const arm = len(sub(P[I[`${S}ForeArm`]], sh)) + len(sub(P[I[`${S}Hand`]], P[I[`${S}ForeArm`]])) + len(sub(P[I[`${S}HandMiddle2`]], P[I[`${S}Hand`]]));
	const dy = sh[1] - T[1], ahead = Math.max(NEAREST, Math.sqrt(Math.max(0, (COMFORT * arm) ** 2 - dy * dy)));
	const h = ctx.args.heading ?? ctx.state?.yaw ?? 0, R = ry(h), boxes = obstacles(scene);
	const off = apply(R, [sh[0] - hip[0], 0, sh[2] - hip[2] + ahead]), c0 = [T[0] - off[0], T[2] - off[2]];
	let moved = 0, c = c0;
	for (; moved <= SLIDE + 1e-9 && clearance(sk, boxes, c, h) < 0; moved += STEP) {
		const back = apply(R, [0, 0, -(moved + STEP)]);
		c = [c0[0] + back[0], c0[1] + back[2]];
	}
	return { at: c.map(n => +n.toFixed(4)), heading: h, anchor: next.args.anchor, moved: +moved.toFixed(2) };
}
