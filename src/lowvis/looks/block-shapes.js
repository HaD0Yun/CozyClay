// The proportion tables of the block look: one per figure, same parts and joints (the rig's), different sizes. Metres,
// rest pose (T-pose, facing +Z, +X on the figure's left). block.js says what each part is.
//
//   head      half widths at the back, at the face (cheeks) and at the chin; heights of the top and of the chin; z of
//             the face and of the back; cheek (optional, 0.08) where the jaw starts, in metres above the chin on a
//             0.215 m head; backCut (optional, 0.16) the cut off the top of the back, as a share of the head's depth;
//             brow and nape (optional) cuts off the top edge of the face and the lower edge of the back, temple
//             (optional) a 45-degree cut off the two top side edges, in metres; crown (optional) metres off the top
//             alone: the jaw, the eye line and the back's lower edge keep the heights they have under `top`
//   neck      [w, d] at the bottom and at the top
//   chest     rings bottom up: [y, z of the centre, width, depth]; the middle ring is the crease across the chest
//   bust      (optional) level strips across the chest's whole front that push it out: [[y, z], ...]
//   waist     radius of the dark dowel between chest and pelvis
//   pelvis    from and to (y), [w, d] at the bottom (hips) and at the top (waist); or briefs, four levels [y, w, d]
//             top down: waist, hips, the leg line at the sides, the crotch
//   shoulder  how far the box sits out from the rig's shoulder joint, and its size
//   upperArm  [w, d] where it leaves the shoulder box, at its full top, at the elbow; armLift (optional, 0.03) sets
//             the arm's top outward once the arm hangs, so it sits under the shoulder box
//   elbow     [length along the arm, thickness] of the elbow box
//   foreArm   [w, d] at the elbow and at the wrist
//   wrist     size of the wrist box: [along the arm, thickness, breadth]
//   hand      scale of the mitten and the fist
//   hip       radius of the dark ball on the hip joint
//   thigh     [w, d] at the top and at the knee; thighOut (optional) moves the top outward from the hip joint;
//             thighTop (optional, 0.95) the height of its top
//   knee      [width, length and depth] of the knee box
//   shin      [w, d] at the knee and at the ankle
//   ankle     size of the ankle box: [width, height, depth]
//   foot      z of the toe tip, [w, h] at the heel and at the toe

export const MAN = {
	head: { back: 0.083, face: 0.074, chin: 0.053, top: 1.758, low: 1.56, front: 0.097, rear: -0.087, crown: 0.012 },
	neck: [[0.1, 0.1], [0.085, 0.09]],
	// An inverted triangle, its front 2.5 cm out at the pectoral crease; the back is one straight plane.
	chest: [[1.17, -0.006, 0.19, 0.15], [1.375, -0.0085, 0.294, 0.217], [1.505, -0.035, 0.36, 0.21]],
	waist: 0.05,
	pelvis: { from: 0.985, to: 1.12, low: [0.29, 0.18], high: [0.235, 0.162] },
	shoulder: { out: 0.03, size: 0.104 },
	upperArm: [[0.05, 0.05], [0.083, 0.087], [0.071, 0.075]],
	elbow: [0.06, 0.058],
	foreArm: [[0.069, 0.073], [0.05, 0.056]],
	wrist: [0.04, 0.04, 0.048],
	hand: 1,
	hip: 0.05,
	thigh: [[0.14, 0.15], [0.1, 0.11]],
	knee: [0.08, 0.084],
	shin: [[0.1, 0.11], [0.06, 0.07]],
	ankle: [0.048, 0.06, 0.056],
	foot: { toe: 0.172, heel: [0.085, 0.09], tip: [0.095, 0.035] },
};
