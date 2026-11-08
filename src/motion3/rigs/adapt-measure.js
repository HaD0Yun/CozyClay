// Body measurements and landmarks of an adapted rig (adapt.js), from its canonical bind joints J (m, floor at y 0)
// and frames R. The landmarks are the X Bot rig's (x-bot-tpose.json), carried by the head and scaled by the head's size,
// unless the source sent its own; the sole and the proportions the compiler reads in place of X Bot constants:
//   sole.ball / sole.tip  how far the sole lies below the ToeBase / Toe_End joints at bind (cm; qa/geometry.js): the
//                         joints' height above the floor, the tip 0.6 cm less (the toe's skin turns up at its end:
//                         0.5 cm on the Y Bot, 0.7 cm on the X Bot).
//   sole.heel             [back, up] of the heel point from the ankle at bind (cm; the X Bot's 4.5 and 0.5), back
//                         scaled by the foot's length.
//   scale                 { foot, hand, arm, hips, girth }: the rig's foot (ankle to ball), hand (wrist to middle
//                         knuckle), arm (shoulder to wrist), hip width and stature over the X Bot's, for the hand-size
//                         grasp offsets and finger radii (compiler/limbs.js palmPoint, qa/geometry.js), the stance width
//                         and the legs' SELF limits (skills/basic.js standIdle, compiler/walk.js, qa/geometry.js legGap),
//                         the hanging arm (skills/stance.js) and the body capsules' radii (girth; qa/geometry.js).
import { add, sub, scale, dist, apply, T } from "../compiler/math.js";

const CM = 100, TIP_UP = 0.6;
const r4 = v => Math.round(v * 1e4) / 1e4;
const mean = f => (f("Left") + f("Right")) / 2;

/** report.measured: the rig's body in metres (ratios and angles as named). r = adapt-pose.js ratios. */
export function measure(ref, J, r, extra) {
	const len = (a, b) => dist(J[a], J[b]);
	const refFoot = mean(S => dist(ref.restWorldPos[ref.index[`${S}Foot`]], ref.restWorldPos[ref.index[`${S}ToeBase`]]));
	return {
		heightM: r4(J.HeadTop_End[1]), hipsHeightM: r4(J.Hips[1]), ankleHeightM: r4(mean(S => J[`${S}Foot`][1])),
		legLengthM: r4(mean(S => len(`${S}UpLeg`, `${S}Leg`) + len(`${S}Leg`, `${S}Foot`))),
		armLengthM: r4(mean(S => len(`${S}Arm`, `${S}ForeArm`) + len(`${S}ForeArm`, `${S}Hand`))),
		handLengthM: r4(mean(S => len(`${S}Hand`, `${S}HandMiddle1`) + len(`${S}HandMiddle1`, `${S}HandMiddle4`))),
		footLengthM: r4(mean(S => len(`${S}Foot`, `${S}ToeBase`) + len(`${S}ToeBase`, `${S}Toe_End`))),
		ballHeightM: r4(mean(S => J[`${S}ToeBase`][1])),
		shoulderWidthM: r4(len("LeftArm", "RightArm")), hipWidthM: r4(len("LeftUpLeg", "RightUpLeg")),
		trunkLengthM: r4(len("Hips", "Neck")), headScale: r4(r.head), bodyScale: r4(r.body),
		footScale: r4(mean(S => len(`${S}Foot`, `${S}ToeBase`)) / refFoot), ...extra,
	};
}

/** The rig's proportions to the X Bot that the compiler reads (landmarks.scale; see the head of this file). */
function proportions(ref, J, r) {
	const refW = dist(ref.restWorldPos[ref.index.LeftUpLeg], ref.restWorldPos[ref.index.RightUpLeg]);
	const girth = J.HeadTop_End[1] / ref.restWorldPos[ref.index.HeadTop_End][1];
	return { foot: r4(mean(S => r.foot[S])), hand: r4(mean(S => r.hand[S])), arm: r4(mean(S => r.arm[S])), hips: r4(dist(J.LeftUpLeg, J.RightUpLeg) / refW), girth: r4(girth) };
}

/**
 * Rig landmarks (cm, world at bind, as x-bot-tpose.json has them). L = the X Bot's landmarks (cm); own = the source's
 * landmarks in canonical metres ({ mouth, headEllipsoid: { centre, radii }, sole: { ball, tip } }, each optional), or null.
 */
export function landmarksFor(ref, L, J, R, r, own) {
	const h = ref.index.Head, toHead = p => apply(T(ref.restWorldRot[h]), sub(scale(p, 0.01), ref.restWorldPos[h]));
	const carry = p => scale(add(J.Head, apply(R.Head, scale(toHead(p), r.head))), CM);
	const ball = mean(S => J[`${S}ToeBase`][1]) * CM, tip = mean(S => J[`${S}Toe_End`][1]) * CM - TIP_UP;
	const heel = [r4(4.5 * mean(S => r.foot[S])), 0.5];
	return {
		mouth: own?.mouth ? scale(own.mouth, CM) : carry(L.mouth),
		headEllipsoid: own?.headEllipsoid
			? { centre: scale(own.headEllipsoid.centre, CM), radii: scale(own.headEllipsoid.radii, CM) }
			: { centre: carry(L.headEllipsoid.centre), radii: scale(L.headEllipsoid.radii, r.head) },
		headJoint: scale(J.Head, CM), headTop: scale(J.HeadTop_End, CM),
		sole: { ball: r4(own?.sole?.ball !== undefined ? own.sole.ball * CM : ball), tip: r4(own?.sole?.tip !== undefined ? own.sole.tip * CM : tip), heel },
		scale: proportions(ref, J, r),
	};
}
