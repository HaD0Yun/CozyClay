// Constant frame offset from each SOMA joint's X Bot bone (soma.js XBOT_BONE) to the joint, quaternion [x, y, z, w],
// CozyClay space: R_soma = R_xbot * offset. Averaged (outliers past 30 deg dropped) over 354 frames of model output
// converted to channels and compiled on the X Bot; the residual spread is the conversion's, not the rigs'.
export const SOMA_CALIB = [
	[0.49831, 0.5012, 0.49779, 0.50269], // Hips
	[0.54145, 0.4594, 0.53617, 0.45641], // Spine1
	[0.48901, 0.5157, 0.48194, 0.5125], // Spine2
	[0.52832, 0.45901, 0.53665, 0.47138], // Chest
	[0.62384, 0.34996, 0.61628, 0.32947], // Neck1
	[0.61809, 0.35819, 0.60614, 0.34966], // Neck2
	[0.52989, 0.47112, 0.52771, 0.46774], // Head
	[0.53024, 0.47085, 0.52779, 0.46753], // Jaw
	[0.5299, 0.47129, 0.52792, 0.46733], // LeftEye
	[0.53018, 0.47079, 0.52739, 0.46811], // RightEye
	[0.07734, 0.07123, 0.70565, 0.70072], // LeftShoulder
	[0.04574, 0.00151, 0.68674, 0.72546], // LeftArm
	[0.03243, -0.05755, 0.69458, 0.71637], // LeftForeArm
	[0.12839, 0.04706, 0.71096, 0.68981], // LeftHand
	[0.28834, 0.00956, 0.59058, 0.75364], // LeftHandThumbEnd
	[0.45252, -0.28781, 0.60865, 0.58475], // LeftHandMiddleEnd
	[0.69469, -0.70611, 0.06077, -0.12299], // RightShoulder
	[0.72159, -0.69037, 0.00353, -0.0518], // RightArm
	[-0.71268, 0.69963, 0.0348, 0.03728], // RightForeArm
	[0.68282, -0.7074, 0.08413, -0.16205], // RightHand
	[0.76198, -0.57931, 0.02902, -0.288], // RightHandThumbEnd
	[-0.64039, 0.62067, 0.22759, 0.39099], // RightHandMiddleEnd
	[0.53012, 0.48509, -0.50788, -0.4751], // LeftLeg
	[-0.49398, -0.51299, 0.47181, 0.51982], // LeftShin
	[0.40433, 0.68132, -0.40712, -0.45451], // LeftFoot
	[-0.51088, -0.50232, 0.61489, 0.32952], // LeftToeBase
	[0.47453, -0.50845, -0.48303, 0.53196], // RightLeg
	[-0.51936, 0.47403, 0.51091, -0.49449], // RightShin
	[-0.46666, 0.41791, 0.67023, -0.39796], // RightFoot
	[-0.33589, 0.62103, 0.49772, -0.50376], // RightToeBase
];
