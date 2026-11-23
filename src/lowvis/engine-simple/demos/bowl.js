// Demo "bowl": a four-step approach with a pendulum swing, release at frame 82, the ball rolls and scatters the pins.
import { DEMOS } from "../../demos.js";

const RELEASE = 82, HIT = 109; // HIT: the frame the rolling ball reaches the head pin (read from the build's ball track)
// Each pin tips over its base edge away from the ball's line, later the further back and out it stands, then slides.
const pins = Object.fromEntries(DEMOS.bowl.props.filter(p => p.id.startsWith("pin")).map(p => {
	const [x, y, z] = p.at, row = Math.round((z - 8.0) / 0.26), out = x + (row % 2 ? 0.11 : 0.01), l = Math.hypot(out, 0.5), dx = out / l, dz = 0.5 / l;
	const f = HIT + row * 3 + Math.round(Math.abs(x) * 6), far = 0.35 + 0.12 * row;
	return [p.id, [
		[f, "tip", { pivot: [x + dx * 0.06, y - 0.19, z + dz * 0.06], axis: [dz, 0, -dx], deg: 90, over: 7, ease: "in" }],
		[f + 7, "move", { to: [x + dx * (0.19 + far), y - 0.13, z + dz * (0.19 + far)], axis: [0, 1, 0], deg: 70 * Math.sign(out), over: 16, ease: "out" }],
	]];
}));

export default {
	demo: "bowl",
	a: [
		[0, "hold", { prop: "ball", hand: "R" }],
		[0, "pose", { R: [-0.1, 0.16, 0.26], L: { prop: "ball" }, look: [0, 0.2, 8], over: 0 }],
		[30, "walk", { to: [-0.2, -0.55], steps: 5, first: "R", end: { L: [0.02, 0.25], R: [0.24, -0.4] } }], // 4 steps, then the right leg sweeps behind
		[30, "pose", { R: [-0.16, 0.12, 0.48], L: [0.3, 0.12, 0.3], over: 12 }],                                        // push away
		[43, "pose", { R: [-0.16, -0.16, 0.06], L: [0.42, 0.1, 0.12], bow: 8, hip: [0, -0.08, 0], over: 12, ease: "in" }], // down
		[55, "pose", { R: [-0.16, 0.3, -0.4], L: [0.5, 0.2, 0.2], bow: 28, hip: [0, -0.16, 0], over: 13, ease: "out" }],   // top of the back swing
		[70, "pose", { R: [-0.16, -0.69, 0.42], L: [0.55, 0.25, 0.0], bow: 55, lean: 8, hip: [0, -0.24, 0.05], over: 12, ease: "in", fast: true }], // down to the release
		[RELEASE, "release", { prop: "ball", roll: true }],
		[RELEASE, "pose", { R: [-0.16, 0.35, 0.6], bow: 32, hip: [0, -0.2, 0.05], over: 14, ease: "out", fast: true }], // follow through
		[216, "walk", { to: [-0.2, -0.55] }],
		[216, "pose", { hands: "rest", lean: 0, bow: 0, hip: [0, 0, 0], look: "fwd", over: 30 }],
	],
	ball: [[HIT + 2, "move", { to: [0.25, 0.111, 9.25], axis: [1, 0, 0], deg: 400, over: 22, ease: "out" }]],
	...pins,
};
