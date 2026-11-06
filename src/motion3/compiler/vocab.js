// The motion spec's channel vocabulary and sign conventions, shared by the validator (exact
// error messages) and QA hints. Degrees for angles, metres for points.

const sided = names => names.flatMap(n => [`${n}_l`, `${n}_r`]);

export const VEC_CHANNELS = new Set(["root", ...sided(["foot", "knee", "hand", "elbow"])]);
export const POLE_CHANNELS = new Set(sided(["knee", "elbow"]));
export const NUM_CHANNELS = new Set(["yaw", "pitch", "roll", "spine_yaw", "spine_pitch", "spine_roll", "head_yaw", "head_pitch", "head_roll", "arm_rest", "arm_hang",
	...sided(["fyaw", "fpitch", "armw", "wtwist", "wflex", "aswing", "abend"])]);
export const MAP_CHANNELS = new Set(sided(["fingers"]));
// Channels the skills key (standIdle, walks): valid in a spec, left out of motion.describe so a first spec need not read them.
export const SKILL_CHANNELS = new Set(["arm_hang"]);
export const FINGER_PRESETS = ["relaxed", "fist", "grip", "cigarette", "point", "spherical", "flat", "hook"];
/** The grasps an object anchor takes a hand by (../sockets.js), and the finger preset each closes the hand to by default.
 * support: a box held from below at its sides (a carried crate): the palm on a side face low, the fingers round the bottom
 * edge; the compiler places it from the box's size and the rig's hand (sockets.js supportFace, anchors.js supportAt), no local needed. */
export const GRASPS = ["power", "pinch", "hook", "palm", "spherical", "support"];
export const GRASP_FINGERS = { power: "grip", pinch: "cigarette", hook: "grip", palm: "flat", spherical: "spherical", support: "hook" };
/** The grasps a carry names (objects.<id>.grasp: one hand seats the thing, ../seat.js); support is two hands' on object anchors. */
export const CARRY_GRASPS = GRASPS.filter(g => g !== "support");
/** Grasps whose palm presses a face (no axis across it): the palm frame faces the face and the palm point is the palm's own. */
export const PALM_GRASPS = new Set(["palm", "support"]);
/** Where the held thing sits in the hand, [d, l, n] on the palm axes from the finger middles (n toward the palm; m): a bar in a
 * power grip or a hook lies across the palm under the finger middles, a pinch is held at the fingertips, a flat palm presses with its centre. */
export const GRASP_POINTS = { power: [0, 0, 0.02], hook: [0, 0, 0.02], pinch: [0.025, 0, 0.01], palm: [-0.045, 0, 0.015], spherical: [-0.015, 0, 0.035], support: [-0.045, 0, 0.015] };

// [min, max, convention] for numeric channels whose values have a hard range.
const RANGES = [
	[/^(armw)_[lr]$/, 0, 1, "0 FK, 1 IK to the hand target"],
	[/^arm_hang$/, 0, 1, "1 = a free FK forearm hangs plumb"],
	[/^w_.+_[lr]$/, 0, 1, "hand-target weight; a hand's sum <= 1"],
	[/^wtwist_[lr]$/, -85, 85, "twist about the forearm, deg"],
	[/^wflex_[lr]$/, -70, 70, "flex about the knuckle line, deg"],
	[/^fpitch_[lr]$/, -60, 90, "toe-down pitch, deg: + lifts the heel (toes flat), - lifts the toes"],
	// the whole-body pitch and roll have none: they turn in full (flips, cartwheels; pose.js tiltFrame)
	[/^(spine_pitch|head_pitch)$/, -120, 120, "deg, + bends forward"],
	[/^(spine_roll|head_roll)$/, -90, 90, "degrees"],
];
export const rangeOf = ch => RANGES.find(([re]) => re.test(ch)) ?? null;

export const CONVENTIONS = {
	yaw: "yaw 0 faces +Z and + turns toward +X",
	fyaw: "foot heading, as yaw",
	pole: "body-frame direction (root yaw): +z forward, +x its left, +y up",
	foot: "ANKLE target, world m (standing 0.087 X Bot, 0.105 Y Bot)",
	hand: "WRIST target, world m",
	root: "hips joint, world m (standing 1.03 X Bot, 0.99 Y Bot)",
};

/** What each channel family means (a family drops the _l/_r side), for motion.describe "channels". */
export const CHANNEL_DOCS = {
	root: CONVENTIONS.root, yaw: `deg; ${CONVENTIONS.yaw}`, pitch: "degrees", roll: "degrees",
	spine_yaw: "degrees", spine_pitch: "deg, + bends forward", spine_roll: "degrees", head_yaw: "degrees", head_pitch: "degrees, + looks down", head_roll: "degrees",
	arm_rest: "FK arms down, deg, default 72", arm_hang: "1 = a free FK forearm hangs plumb (standIdle and walks key it)", foot: CONVENTIONS.foot, fyaw: CONVENTIONS.fyaw, fpitch: "toe-down pitch, degrees, + heel up",
	knee: `knee pole, ${CONVENTIONS.pole}`, armw: "0 = FK arm, 1 = IK to hand_* / the anchors", hand: CONVENTIONS.hand, elbow: `elbow pole, ${CONVENTIONS.pole}`,
	wtwist: "wrist twist, degrees", wflex: "wrist flex, degrees", aswing: "FK arm swing, deg, + forward", abend: "FK elbow bend, deg",
	fingers: "{ preset: weight 0..1 }",
};
export const channelFamily = ch => ch.replace(/_[lr]$/, "");

/** "; did you mean ..." for an unknown field: frame words point at the field that takes frames, distance words at the tolerance. */
const FIELD_ALIASES = [[["frames", "when", "range", "f", "from", "within", "during", "at"], ["when", "frames", "at", "f"]], [["max", "maxDist", "distance", "tolerance", "limit"], ["tol", "min"]]];
export function suggestField(name, fields) {
	for (const [words, targets] of FIELD_ALIASES) {
		const to = words.includes(name) && targets.find(t => fields.includes(t) && t !== name);
		if (to) return `; did you mean "${to}"?`;
	}
	return didYouMean(name, fields, Math.max(2, Math.floor(name.length / 3)));
}

export const isVec3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export const fmt = v => JSON.stringify(v)?.slice(0, 60);

/** Levenshtein distance, for "did you mean" suggestions. */
function editDistance(a, b) {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length][b.length];
}

export function didYouMean(name, options, maxD = Math.max(3, Math.floor(name.length / 3))) {
	let best = null, bestD = Infinity;
	for (const o of options) { const d = editDistance(name, o); if (d < bestD) { best = o; bestD = d; } }
	return best && bestD <= maxD ? `; did you mean "${best}"?` : "";
}
