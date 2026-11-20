// The cube look: the figure of a quick marker sketch (the owner's reference drawing). A cube head on a short neck
// block; the torso as three stacked boxes with gaps between them (chest, belly, pelvis); thin straight arms and legs;
// forearms and shins that widen toward the hand and the foot; the block look's two hands (a half-closed hand, and a fist
// for a hand that holds something); a wedge foot on a dark sole; two upright black bar eyes on the face (the owner's
// second reference). Parts do not touch: at every joint there is an empty gap between the two parts.
//
// Most sizes come from the drawing, measured in pixels and turned into metres with one rule: the drawing's leg (top of
// the thigh to the floor, 700 px) is the rig's leg (0.975 m), so 1 px = 1.39 mm. The joints stay the rig's (rig17.js),
// so a part spans its rig joints even where the drawing's limb is shorter (the forearm).
// Changed from the drawing on the owner's word (2026-11-20, "a smaller head, longer arms", picked from a comparison
// sheet): the head is 0.85 of the drawing's in all three directions, on the same neck; the upper arm starts at the rig's
// shoulder joint instead of at the chest's corner, with a narrower chest (0.28 m) to make room for it; the gaps at the
// elbow and the wrist are 15 mm instead of 25. The joints did not move: the drawn arm is 34 mm longer from its shoulder
// end to its wrist end, and the hand hangs no lower.
//
// Plain stock parts, as the block look: a matte white, a navy sole, black eyes and a navy line on every edge. How
// they are shaded is the stage's business (the Studio's toon finish, src/stage-finish.js, shades stock materials).
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { fist, mitten } from "./block.js";
import { createJointRig, restOf, solidsOf } from "./parts.js";

// The navy of the sole and the lines is read off the drawing.
const WHITE = "#f4f4f2", NAVY = "#0b1c52", INK = "#0a1a50", EYE = "#050508";
const ORIGIN = [0, 0, 0], UP = [0, 1, 0], OUT = [1, 0, 0];

/**
 * The proportions the look draws with, metres at character scale 1, all in one place. The joints are the rig's and
 * never move; these numbers only say where the parts sit about them.
 *   head: [w, h, d] of the head cube, its bottom at headBottom (on the neck); the eyes keep their shares of the face
 *   chest: [w, h, d] of the top torso box
 *   armTopX: how far from the middle the upper arm starts in the T-pose (0.152: the shoulder joint); armLift: how far
 *     over the joint its top end sits in the T-pose
 *   upperArm, foreArm: the slab's [w, d] at its two ends
 *   elbowGap, wristGap: metres from the elbow / wrist joint to each part it joins; gap: the same at every other joint
 */
export const CUBE_SHAPE = Object.freeze({
	head: [0.2465, 0.2635, 0.238], headBottom: 1.585,
	chest: [0.28, 0.21, 0.2],
	armTopX: 0.152, armLift: 0.04,
	upperArm: [[0.07, 0.07], [0.062, 0.064]], foreArm: [[0.058, 0.06], [0.085, 0.082]],
	elbowGap: 0.015, wristGap: 0.015, gap: 0.025,
});

const V = a => new THREE.Vector3().fromArray(a);

/**
 * A box from `a` to `b` that may taper: a rectangle `sa` = [w, d] around a and `sb` around b. w runs along `side`
 * (made square to the axis), d across it.
 */
function slab(a, b, sa, sb = sa, side = OUT) {
	const axis = V(b).sub(V(a)).normalize();
	const s = V(side).addScaledVector(axis, -V(side).dot(axis)).normalize(), f = new THREE.Vector3().crossVectors(s, axis);
	const ring = (c, [w, d]) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => V(c).addScaledVector(s, (i * w) / 2).addScaledVector(f, (j * d) / 2));
	return new ConvexGeometry([...ring(a, sa), ...ring(b, sb)]);
}

/** A plain box of `size` [x, y, z] around `centre`. */
const block = (centre, size) => new THREE.BoxGeometry(...size).translate(...centre);

/** The parts as { joint, geometry, dark, hand }, in rest world space (metres, T-pose, facing +Z, +X on the left). dark:
 * "sole" or "eye" for a part of that colour; such parts get no edge lines. hand: [side, "open" | "fist"], as block.js. */
function layout(S) {
	const parts = [], add = (joint, geometry, dark = false, hand = null) => parts.push({ joint, geometry, dark, hand });
	const GAP = S.gap;
	// Head, neck and torso, top down. Drawing (px): head 210 x 240 front face (now 0.85 of it), neck 70 x 50,
	// chest 240 x 150 (now narrower), belly 185 x 80, pelvis 160 x 70, a gap of about 15 between them.
	const HEAD = S.head, HEAD_Y = S.headBottom + HEAD[1] / 2;
	add("Head", block([0, HEAD_Y, 0], HEAD));
	// The eyes (reference, as shares of the face): upright bars with round ends, 0.29 of the width out from the
	// middle, 0.36 of the height long, centred 0.4 down from the top, 0.08 of the width wide; laid on the face.
	const EYE_W = 0.08 * HEAD[0], EYE_L = 0.36 * HEAD[1], eyeY = HEAD_Y + HEAD[1] / 2 - 0.4 * HEAD[1];
	// Each eye is a flat plate 2 mm in front of the face, not a solid sunk into it: where a curved solid cuts a flat face
	// its outline follows the solid's facets and comes out jagged at a distance.
	const r = EYE_W / 2, h = EYE_L / 2 - r, bar = new THREE.Shape().moveTo(-r, -h).lineTo(-r, h);
	bar.absarc(0, h, r, Math.PI, 0, true).lineTo(r, -h).absarc(0, -h, r, 0, Math.PI, true);
	for (const i of [-1, 1]) add("Head", new THREE.ShapeGeometry(bar, 24).translate(i * 0.29 * HEAD[0], eyeY, HEAD[2] / 2 + 0.002), "eye");
	add("Neck", block([0, 1.53, -0.03], [0.1, 0.055, 0.1]));
	const CHEST = S.chest;
	add("Spine2", block([0, 1.375, -0.02], CHEST));
	add("Spine", block([0, 1.195, 0], [0.26, 0.11, 0.17]));
	add("Hips", block([0, 1.07, 0.01], [0.22, 0.1, 0.16]));
	for (const side of ["Left", "Right"]) {
		const k = side === "Left" ? 1 : -1, J = name => restOf(`${side}${name}`), put = (joint, g, dark, hand) => add(`${side}${joint}`, g, dark, hand);
		const along = (p, d) => [p[0] + k * d, p[1], p[2]]; // d metres further out along the T-pose arm
		const elbow = J("ForeArm"), wrist = J("Hand"), knee = J("Leg"), ankle = J("Foot");
		// Arm (px): upper arm 50 thick (in the drawing from the chest's top corner; here from the shoulder joint);
		// forearm widening from 45 to 80. The hands are the block look's own two shapes, starting S.wristGap clear of the wrist.
		// The upper arm's top end starts S.armTopX out (the shoulder joint) and sits S.armLift over the
		// joint in the T-pose, so once the arm hangs it is outside the chest; it runs down to the elbow on the joint.
		// The gaps at the elbow and the wrist are S.elbowGap and S.wristGap.
		const armTop = [k * S.armTopX, elbow[1] + S.armLift, elbow[2]];
		put("Arm", slab(armTop, along(elbow, -S.elbowGap), ...S.upperArm, UP));
		put("ForeArm", slab(along(elbow, S.elbowGap), along(wrist, -S.wristGap), ...S.foreArm, UP));
		const at = (u, t, z = 0) => [wrist[0] + k * u, wrist[1] + t, wrist[2] + z]; // block.js: along the arm, up, front
		for (const g of mitten(at, S.wristGap)) put("Hand", g, false, [side, "open"]);
		for (const g of fist(at, S.wristGap)) put("Hand", g, false, [side, "fist"]);
		// Leg (px): thigh 55 to 60 wide under the pelvis's edge; shin widening from 55 to 100;
		// a wedge foot, high at the heel and low at the toe, on a dark sole a little larger than it.
		const hipX = J("UpLeg")[0];
		put("UpLeg", slab([hipX, 0.985, 0], [hipX, knee[1] + GAP, knee[2]], [0.078, 0.088], [0.084, 0.09]));
		put("Leg", slab([hipX, knee[1] - GAP, knee[2]], [hipX, ankle[1] + GAP, ankle[2]], [0.08, 0.09], [0.14, 0.125]));
		const SOLE = 0.018;
		const heel = [-1, 1].flatMap(i => [[hipX + (i * 0.14) / 2, SOLE, -0.085], [hipX + (i * 0.14) / 2, ankle[1] - GAP, -0.085]]);
		const toe = [-1, 1].flatMap(i => [[hipX + (i * 0.122) / 2, SOLE, 0.18], [hipX + (i * 0.122) / 2, SOLE + 0.026, 0.18]]);
		put("Foot", new ConvexGeometry([...heel, ...toe].map(V)));
		put("Foot", block([hipX, SOLE / 2, 0.047], [0.152, SOLE, 0.285]), "sole");
	}
	return parts;
}

/** The cube look's solids as drawn, in the proportions it draws with (CUBE_SHAPE; parts.js solidsOf). */
export const cubeSolids = () => solidsOf(layout(CUBE_SHAPE));

/** The figure is white (the owner's pick, 2026-11-19): a character's tint and colour are not used. `shape`
 * (optional): proportions to draw with instead of CUBE_SHAPE, for comparing sets side by side. */
export function cube({ shape = CUBE_SHAPE } = {}) {
	const rig = createJointRig();
	// The faces sit a little behind their edge lines in depth, so the lines do not flicker.
	const matte = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const body = matte(WHITE), sole = matte(NAVY), ink = new THREE.LineBasicMaterial({ color: INK });
	const eye = new THREE.MeshBasicMaterial({ color: EYE, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
	const hands = { Left: { open: [], fist: [] }, Right: { open: [], fist: [] } };
	for (const { joint, geometry, dark, hand } of layout(shape)) {
		const objects = [rig.attach(joint, new THREE.Mesh(geometry, { sole, eye }[dark] ?? body), ORIGIN)];
		objects[0].castShadow = dark !== "eye";
		if (!dark) objects.push(rig.attach(joint, new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 12), ink), ORIGIN));
		if (objects[1]) objects[1].castShadow = false;
		if (hand) hands[hand[0]][hand[1]].push(...objects);
	}
	/** `grip` ({ Left, Right }, optional, from src/lowvis/grip.js) shows a fist on each hand that holds something. */
	function setPose(pos, quat, frame, grip) {
		rig.setPose(pos, quat, frame);
		for (const side of ["Left", "Right"]) {
			const closed = Boolean(grip?.[side]);
			for (const o of hands[side].open) o.visible = !closed;
			for (const o of hands[side].fist) o.visible = closed;
		}
	}
	return { object3D: rig.object3D, setPose };
}
