// The motion of the cube comparison video (tools/lowvis/cube-motion.mjs): one character "a" in engine-simple's words,
// built once per lane at that lane's body scale. Walk to a table-height stand, wave once, take the small box with both
// hands, turn, carry it to the low box, set it down, stand with the arms hanging. 24 fps.
export const SCENE = {
	frames: 240,
	props: [
		{ id: "stand", size: [0.6, 0.75, 0.5], at: [0, 0.375, 1.5] },
		{ id: "box", size: [0.25, 0.2, 0.25], at: [0, 0.85, 1.4], moves: true },
		{ id: "low", size: [0.45, 0.45, 0.45], at: [1.45, 0.225, 0.45] },
	],
};

export const SPEC = {
	demo: "cube-motion",
	a: [
		[0, "walk", { to: [0, 0.95] }],
		[36, "pose", { R: [-0.3, 0.55, 0.12], over: 10 }],
		[48, "pose", { R: [-0.15, 0.58, 0.14], over: 7 }],
		[56, "pose", { R: [-0.3, 0.55, 0.12], over: 7 }],
		[66, "pose", { R: "rest", over: 10 }],
		[78, "pose", { hands: { prop: "box" }, over: 24 }],
		[104, "carry", { prop: "box", at: [0, 0.12, 0.27], over: 20 }],
		[120, "turn", { heading: 90 }],
		[146, "walk", { to: [0.85, 0.45], heading: 90 }],
		[186, "place", { prop: "box", at: [1.4, 0.551, 0.45], over: 22 }],
		[210, "pose", { hands: "rest", over: 18 }],
	],
};
