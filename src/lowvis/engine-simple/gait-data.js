import { clamp, mix, rad } from "./math.js";

// How a walking body moves over one gait cycle, from captured human walks: the mean of five straight walks of a public
// motion-capture set (about 1.2 m/s), each curve as [its mean, then [cos, sin] for 1, 2 and 3 waves per cycle],
// scaled back to the takes' mean range (averaging takes whose phases differ a little flattens the mean curve).
// Phase 0 is the left heel strike, 0.5 the right one. Metres and degrees; only the swing about the mean is used.
export const WALK_CURVES = {
	side: [-0.0003, [-0.0025, 0.0249], [0.0002, 0.0003], [-0.0005, 0.0007]], // pelvis toward the left (+)
	surge: [-0.0031, [-0.0056, -0.0046], [-0.0032, 0.0136], [-0.0012, -0.0033]], // pelvis ahead of the steady path (+)
	height: [1.0379, [0.0013, -0.0031], [-0.0118, 0.0055], [-0.0004, -0.0002]], // pelvis height
	pelvisYaw: [0.6494, [4.2147, 0.9198], [0.4443, 0.3141], [-0.1171, 0.0189]], // left hip ahead (+)
	pelvisList: [0.5413, [-3.4492, 4.0181], [-0.0948, 0.1646], [-0.5466, 0.6193]], // left hip higher (+)
	chestYaw: [0.2542, [-4.4084, 2.0776], [0.2769, 0.3588], [0.0301, -0.4608]], // left shoulder ahead (+)
	chestList: [2.9496, [-1.7391, 0.1268], [0.0102, 0.1938], [0.0127, -0.2852]], // left shoulder higher (+)
	wristX: [0.2548, [-0.0238, 0.0085], [-0.0053, -0.0042], [-0.0011, 0.0007]], // left wrist from the hips: toward the left (+)
	wristY: [-0.1688, [-0.0292, 0.0055], [0.0106, -0.0065], [0.0001, 0.0005]], // up (+)
	wristZ: [0.0473, [-0.1214, 0.0286], [-0.0001, -0.0153], [-0.001, -0.0007]], // forward (+)
};
export const WALK_SPEED = 1.2; // m/s of the captured walks; the arm swing grows and shrinks with the speed
/** A curve of [mean, [cos, sin] x 3] at phase ph, about its mean. */
export const curve = (c, ph) => c.slice(1).reduce((n, [a, b], i) => n + a * Math.cos(2 * Math.PI * (i + 1) * ph) + b * Math.sin(2 * Math.PI * (i + 1) * ph), 0);

// How a running body moves, from captured runs and jogs of seven people (31 straight steady cycles, 1.9 to 4.9 m/s)
// of public motion-capture sets: every length scaled by the rig's leg over that person's leg, so a speed here is the
// rig's. Each person weighs the same. The step rate's line, and the share of the cycle a foot is down, the ankle's lift and
// the curves over one cycle (phase 0 the left foot's landing, 0.5 the right one's; each as [its mean, then [cos, sin] for 1, 2 and 3 waves],
// kept symmetric between the sides, scaled back to the cycles' mean range) are given at the speeds of RUN_CURVES.v.
// Metres and degrees. Above and below those speeds the nearest is used; the step rate's line goes on, and above the
// fastest a foot is down over the fastest's length of ground (runAt).
/** Steps a minute = a + b v (m/s); the spread about the line is 9 a minute. */
const RUN_RATE = [125.9, 11.31];
/** The hip joints' mean height while running, as a share of their standing height (the walks of the same people: 0.961). */
export const RUN_HIPS = 0.955;
/** The swinging ankle's highest over its floor level in the same people's walks (m); a run's in RUN_CURVES.ankleTop. */
const WALK_ANKLE_TOP = 0.188;
/** The same walkers' mean wrist from the hip joints' middle [left, up, ahead]: a running wrist is the walking rest hand
 *  moved by the running mean less this. */
export const WALK_WRIST = [0.27, -0.036, 0.039];
const RUN_CURVES = {
	v: [1.96, 2.94, 4.05],
	// share of a cycle each foot is down; the swinging ankle's highest over its floor level (m)
	stance: [0.496, 0.325, 0.287],
	ankleTop: [0.225, 0.311, 0.405],
	// trunk lean (neck over the hip joints, ahead +) above the same person's walking lean; its swing in `lean`
	leanUp: [3.0, 4.1, 5.3],
	side: [[0.0022, [-0.0048, -0.0017], [0, 0], [0, 0.0003]], [-0.014, [0.0136, -0.0024], [0, 0], [0.0004, 0.0002]], [0.0036, [-0.0047, 0.0036], [0, 0], [-0.0025, 0.0004]]],
	surge: [[-0.0087, [0, 0], [0.0129, 0.0024], [0, 0]], [-0.027, [0, 0], [0.0185, -0.0073], [0, 0]], [-0.0107, [0, 0], [0.0105, -0.0135], [0, 0]]],
	height: [[1.0322, [0, 0], [0.0372, -0.0323], [0, 0]], [1.0368, [0, 0], [0.0107, -0.0419], [0, 0]], [1.0259, [0, 0], [-0.0055, -0.0382], [0, 0]]],
	pelvisYaw: [[1.0479, [-1.0364, -0.5267], [0, 0], [-0.2612, 0.5432]], [2.2031, [-3.7613, 0.3035], [0, 0], [1.3214, 1.4565]], [-1.8886, [-3.8658, -3.8537], [0, 0], [-0.0394, -0.6195]]],
	pelvisList: [[-1.7276, [0.4209, -0.0855], [0, 0], [-1.7907, -0.4211]], [-0.8084, [-2.9074, 3.1218], [0, 0], [-1.4596, 0.8379]], [0.1213, [-1.1735, 5.2389], [0, 0], [-0.6451, 2.064]]],
	chestYaw: [[3.3314, [-11.7797, 6.7596], [0, 0], [0.4573, 0.1132]], [2.3711, [-9.0526, 5.1639], [0, 0], [0.8463, 0.4318]], [0.2935, [-10.5052, 7.2411], [0, 0], [0.4748, -0.7681]]],
	chestList: [[-0.5497, [-0.086, -5.0957], [0, 0], [0.7988, 0.0498]], [2.4045, [-1.2203, -1.8937], [0, 0], [0.2597, -0.0195]], [0.9457, [-1.7749, -0.6644], [0, 0], [0.1505, -0.3168]]],
	wristX: [[0.1779, [0.0247, -0.0056], [-0.0069, 0.0012], [0.0045, 0.0028]], [0.2064, [0.0357, -0.0236], [-0.0036, 0.0129], [0.0045, 0.0035]], [0.1895, [0.0338, -0.0479], [0.0023, 0.0118], [0.0062, -0.0024]]],
	wristY: [[0.2996, [-0.0526, 0.0167], [0.0373, -0.032], [0.0034, 0.0022]], [0.1121, [-0.0244, 0.0393], [0.004, -0.025], [-0.0013, -0.0014]], [0.1676, [-0.0142, 0.0498], [-0.0201, -0.0564], [0.0008, -0.0044]]],
	wristZ: [[0.1544, [-0.0861, 0.064], [-0.0118, -0.0029], [0.0038, -0.0059]], [0.0393, [-0.1112, 0.1116], [-0.0141, 0.0201], [-0.0013, -0.0007]], [0.0967, [-0.0851, 0.1379], [-0.0079, 0.0328], [-0.0084, 0.0031]]],
	lean: [[-1.1154, [0, 0], [-0.5553, -0.3312], [0, 0]], [0.9945, [0, 0], [-1.1279, 1.6782], [0, 0]], [7.1577, [0, 0], [-0.4225, 2.3995], [0, 0]]],
};

/** The run at v m/s (the rig's): steps of the captured rate, each foot down for the captured share of the cycle, the
 *  hip joints at base (the captured share of their standing height, RUN_HIPS), the trunk as much more ahead and the ankle as much higher
 *  as the same people ran against how they walked. */
export const runAt = (v, walk, run, base) => {
	// faster than the fastest captured speed a foot is down over the same length of ground as there (its share of the
	// cycle times the two steps of a cycle: 0.79, 0.72 and 0.81 m at the three speeds), not for the same share of a longer step
	const top = RUN_CURVES.v.at(-1), rate = RUN_RATE[0] + RUN_RATE[1] * Math.max(0, v), stance = Math.min(0.5, runCurve("stance", v) * Math.min(1, runStep(top) / runStep(v)));
	return {
		...run, stepFrames: 1440 / rate, sw: 2 * (1 - stance), step: Math.max(0.05, v) * 60 / rate, maxStride: runStep(RUN_CURVES.v.at(-1)), swLong: 2 * (1 - runCurve("stance", RUN_CURVES.v.at(-1))), base,
		lean: walk.lean + rad(runCurve("leanUp", v)), lift: walk.lift + runCurve("ankleTop", v) - WALK_ANKLE_TOP, // the ankle as much higher than the walk's as the captured
	};
};
/** A runner's step at v m/s; the longest step of a run is the one at the fastest captured speed. */
const runStep = v => Math.max(0.05, v) * 60 / (RUN_RATE[0] + RUN_RATE[1] * Math.max(0, v));
/** A run curve's value at speed v (between the captured speeds, else the nearest): at phase ph, or its mean when ph is null. */
export function runCurve(n, v, ph = null) {
	const S = RUN_CURVES.v, i = clamp(S.findLastIndex(s => s <= v), 0, S.length - 2), t = clamp((v - S[i]) / (S[i + 1] - S[i]));
	const at = c => (typeof c === "number" ? c : ph == null ? c[0] : curve(c, ph));
	return mix(at(RUN_CURVES[n][i]), at(RUN_CURVES[n][i + 1]), t);
}
