// Authored Y Bot handle sets for the poser regression goldens. make-poser-goldens.mjs solves each one and writes the
// results to test/fixtures/poser/ybot-goldens.json; verify-poser-goldens.mjs replays them.
// Positions are metres in the character's own frame (Y up, facing +Z, left on +X, sole at y = 0). Rotations are
// global joint rotations relative to the T-pose, flat row-major 3x3. `tol` (metres) and `rotTol` (unitless) loosen a
// place or a turn. A case with `met: false` asks for places the body cannot reach together, so the
// handles-met property skips it; `options` go to poser.solve unchanged.

/** Flat row-major rotation by `deg` degrees about the x, y or z axis. */
function turn(axis, deg) {
	const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
	if (axis === "x") return [1, 0, 0, 0, c, -s, 0, s, c];
	if (axis === "y") return [c, 0, s, 0, 1, 0, -s, 0, c];
	return [c, -s, 0, s, c, 0, 0, 0, 1];
}

const HIPS = [0, 0.95, 0], LEFT_FOOT = [0.1, 0.08, 0], RIGHT_FOOT = [-0.1, 0.08, 0];
const hips = (position = HIPS, extra = {}) => ({ id: "hips", position, ...extra });
const feet = (left = LEFT_FOOT, right = RIGHT_FOOT) => [{ id: "leftFoot", position: left }, { id: "rightFoot", position: right }];
/** Hips and both feet where a relaxed stand puts them, plus `extra` sends. */
const stand = (...extra) => [hips(), ...feet(), ...extra];

export const CASES = [
	// standing, one handle at a time
	{ name: "stand", sends: stand() },
	{ name: "left hand forward", sends: stand({ id: "leftHand", position: [0.3, 1.25, 0.45] }) },
	{ name: "right hand overhead", sends: stand({ id: "rightHand", position: [-0.2, 1.85, 0.05] }) },
	{ name: "both hands forward", sends: stand({ id: "leftHand", position: [0.15, 1.2, 0.5] }, { id: "rightHand", position: [-0.15, 1.2, 0.5] }) },
	{ name: "left hand across the body", sends: stand({ id: "leftHand", position: [-0.25, 1.15, 0.3] }) },
	{ name: "hands on hips", sends: stand({ id: "leftHand", position: [0.2, 1.0, 0.02] }, { id: "rightHand", position: [-0.2, 1.0, 0.02] }) },
	{ name: "left hand turned palm up", sends: stand({ id: "leftHand", position: [0.4, 1.2, 0.3], rotation: turn("x", -90) }) },
	{ name: "right hand turned", sends: stand({ id: "rightHand", position: [-0.45, 1.3, 0.2], rotation: turn("z", 40), rotTol: 0.02 }) },
	{ name: "hips lowered", sends: [hips([0, 0.8, 0.05]), ...feet()] },
	{ name: "hips shifted left", sends: [hips([0.12, 0.93, 0]), ...feet()] },
	{ name: "hips turned", sends: [hips(HIPS, { rotation: turn("y", 30) }), ...feet()] },
	{ name: "hips tipped forward", sends: [hips(HIPS, { rotation: turn("x", 25) }), ...feet()] },
	{ name: "loose hips", sends: [hips([0.05, 0.9, 0.1], { tol: 0.06, rotation: turn("y", -20), rotTol: 0.08 }), ...feet()] },
	{ name: "chest leaning forward", met: false, sends: stand({ id: "chest", position: [0, 1.25, 0.18] }) },
	{ name: "chest twisted", sends: stand({ id: "chest", rotation: turn("y", 35) }) },
	{ name: "neck forward", sends: stand({ id: "neck", position: [0, 1.4, 0.12] }) },
	{ name: "head tilted sideways", sends: stand({ id: "head", position: [0.1, 1.5, 0.05] }) },
	{ name: "head turned", sends: stand({ id: "head", rotation: turn("y", 40) }) },
	{ name: "head nodding with a place", sends: stand({ id: "head", position: [0, 1.5, 0.1], rotation: turn("x", 25) }) },
	{ name: "look left", sends: stand({ id: "lookAt", lookAt: [1.2, 1.55, 0.8] }) },
	{ name: "look up", sends: stand({ id: "lookAt", lookAt: [0, 2.6, 0.9] }) },
	{ name: "lower spine bent", sends: stand({ id: "spineLow", rotation: turn("x", 20) }) },
	{ name: "middle spine bent sideways", sends: stand({ id: "spineMid", rotation: turn("z", 15) }) },
	{ name: "left shoulder raised", sends: stand({ id: "leftShoulder", rotation: turn("z", 20) }) },
	{ name: "right shoulder forward", sends: stand({ id: "rightShoulder", rotation: turn("y", 20) }) },
	{ name: "left elbow out", sends: stand({ id: "leftElbow", position: [0.4, 1.2, -0.05] }) },
	{ name: "right elbow and hand", met: false, sends: stand({ id: "rightElbow", position: [-0.3, 1.1, 0.1] }, { id: "rightHand", position: [-0.2, 1.35, 0.3] }) },
	{ name: "left knee raised", sends: [hips(), { id: "leftKnee", position: [0.12, 0.7, 0.35] }, { id: "rightFoot", position: RIGHT_FOOT }] },
	{ name: "right knee forward", met: false, sends: [hips([0, 0.9, 0]), { id: "rightKnee", position: [-0.12, 0.5, 0.25] }, ...feet()] },
	{ name: "left foot step forward", sends: [hips([0, 0.92, 0.1]), ...feet([0.12, 0.08, 0.35])] },
	{ name: "left foot lifted behind", sends: [hips(), ...feet([0.1, 0.35, -0.3])] },
	{ name: "left foot turned out", sends: [hips(), { id: "leftFoot", position: LEFT_FOOT, rotation: turn("y", 35) }, { id: "rightFoot", position: RIGHT_FOOT }] },
	{ name: "left toes placed", sends: stand({ id: "leftToes", position: [0.16, 0.03, 0.14] }) },
	{ name: "right toes turned", sends: stand({ id: "rightToes", rotation: turn("y", -25) }) },
	{ name: "neck turned", sends: stand({ id: "neck", rotation: turn("y", 25) }) },
	{ name: "look ahead with the head level", sends: stand({ id: "lookAt", lookAt: [0.3, 1.5, 1.5], rotation: turn("z", 10) }) },
	{ name: "elbows turned", sends: stand({ id: "leftElbow", position: [0.35, 1.15, 0.1], rotation: turn("y", -30) }, { id: "rightElbow", rotation: turn("x", 30) }) },
	{ name: "right foot turned in", sends: [hips(), { id: "leftFoot", position: LEFT_FOOT }, { id: "rightFoot", position: RIGHT_FOOT, rotation: turn("y", 20) }] },
	{ name: "knees turned", sends: [hips([0, 0.88, 0]), ...feet(), { id: "leftKnee", rotation: turn("x", -30) }, { id: "rightKnee", rotation: turn("x", -20) }] },
	{ name: "toes placed and turned", sends: stand({ id: "leftToes", rotation: turn("x", 20) }, { id: "rightToes", position: [-0.15, 0.03, 0.15] }) },
	{ name: "tight and loose tolerances", sends: stand({ id: "leftHand", position: [0.35, 1.3, 0.3], tol: 0.001 }, { id: "rightHand", position: [-0.35, 1.3, 0.3], tol: 0.05 }) },
	{ name: "hand out of reach", met: false, sends: stand({ id: "leftHand", position: [1.6, 1.4, 0.2] }) },
	// floor
	{ name: "foot asked below the floor", met: false, sends: [hips(), ...feet([0.1, -0.12, 0.05])] },
	{ name: "deep squat", sends: [hips([0, 0.45, -0.05]), ...feet([0.15, 0.08, 0.05], [-0.15, 0.08, 0.05])] },
	{ name: "kneeling on the left knee", met: false, sends: [hips([0, 0.6, 0]), { id: "leftKnee", position: [0.12, 0.06, 0.1] }, { id: "rightFoot", position: [-0.12, 0.08, 0.35] }] },
	{ name: "hips high in the air", sends: [hips([0, 2.2, 0]), { id: "leftHand", position: [0.4, 2.7, 0.1] }] },
	{ name: "airborne lift off", options: { airborne: false }, sends: [hips([0, 2.2, 0]), { id: "leftHand", position: [0.4, 2.7, 0.1] }] },
	{ name: "floor off", options: { floor: false }, met: false, sends: [hips(), ...feet([0.1, -0.12, 0.05])] },
	{ name: "toe tips off", options: { toeTips: false }, sends: [hips([0, 0.8, 0.05]), ...feet()] },
	// few position handles (solved, with a warning)
	{ name: "only the head placed", sends: [{ id: "head", position: [0, 1.6, 0] }] },
	{ name: "hips and a hand only", sends: [hips(), { id: "rightHand", position: [-0.4, 1.4, 0.2] }] },
	// rejected: no position handle
	{ name: "reject: nothing", sends: [], rejected: true },
	{ name: "reject: look only", sends: [{ id: "lookAt", lookAt: [0, 1.6, 1] }], rejected: true },
	{ name: "reject: turns only", sends: [{ id: "spineLow", rotation: [1, 0, 0, 0, 1, 0] }, { id: "head", rotation: turn("y", 30) }], rejected: true },
];
