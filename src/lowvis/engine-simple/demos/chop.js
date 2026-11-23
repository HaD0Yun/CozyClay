// Demo "chop": two strikes that stop in the trunk, then a cut through it at frame 208; the upper trunk tips and falls.
const BACK = { R: [-0.5, 0.25, -0.05], aim: [-0.7, 0.4, -0.6], twist: -50, hipTurn: -14, hip: [0, 0, -0.05], lean: -3 }; // wound up
const STOP = { R: [-0.32, 0.08, 0.36], aim: [0.34, 0, 1], twist: 12, hipTurn: 4, hip: [0, -0.02, 0.04], lean: 6 };      // blade on the bark
export default {
	demo: "chop",
	a: [
		[0, "hold", { prop: "sword", hand: "R" }],
		[0, "pose", { aim: [0, 0.35, 1], look: [0, 1.0, 1.6] }],
		[30, "walk", { to: [0, 0.25] }],
		[60, "walk", { to: [0, 0.45], steps: 1 }], // left foot forward
		[78, "pose", { ...BACK, over: 20 }],
		[100, "pose", { ...STOP, over: 5, ease: "in", fast: true }],
		[105, "pose", { R: [-0.36, 0.1, 0.32], over: 6, ease: "out" }], // rebound
		[126, "pose", { ...BACK, over: 18 }],
		[146, "pose", { ...STOP, over: 5, ease: "in", fast: true }],
		[151, "pose", { R: [-0.36, 0.1, 0.32], over: 6, ease: "out" }],
		[168, "pose", { R: [-0.52, 0.34, -0.12], aim: [-0.6, 0.5, -0.7], twist: -62, hipTurn: -20, hip: [0, 0, -0.08], lean: -5, L: [0.3, 0.2, 0.25], over: 30 }],
		[204, "pose", { R: [-0.1, 0.08, 0.42], aim: [0.12, 0, 1], twist: 15, hipTurn: 6, hip: [0, -0.03, 0.06], lean: 8, over: 4, ease: "in", fast: true }], // through the trunk at 208
		[208, "pose", { R: [0.38, -0.12, 0.2], aim: [0.9, -0.3, 0.25], twist: 48, hipTurn: 14, hip: [0.04, -0.05, 0.1], lean: 12, L: [0.35, 0.05, -0.1], over: 7, ease: "out", fast: true }],
		[222, "pose", { R: [0.3, -0.12, 0.2], twist: 35, hipTurn: 8, hip: [0.02, -0.02, 0.06], lean: 6, over: 16 }], // settle
		[240, "walk", { to: [0, 0.05], facing: 0 }],
		[244, "pose", { R: "rest", L: "rest", aim: [0, -0.5, 1], twist: 0, hipTurn: 0, hip: [0, 0, 0], lean: 0, look: [0, 0.3, 2.6], over: 30 }],
	],
	trunk: [
		[208, "tip", { pivot: [0, 1.0, 1.725], axis: [1, 0, 0], deg: 64, over: 20, ease: "in" }],
		[228, "move", { to: [0, 0.125, 2.62], axis: [1, 0, 0], deg: 26, over: 7, ease: "linear" }],
		[235, "move", { to: [0, 0.125, 2.66], over: 8, ease: "out" }],
	],
};
