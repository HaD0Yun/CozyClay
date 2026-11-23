// Demo "sit": walk to the chair, sit, stand, walk to the mat, kneel, lie on the back.
export default {
	demo: "sit",
	a: [
		[0, "walk", { to: [0, 1.15], heading: 180 }],
		[72, "sit", { on: "chair" }], // hands go to the thighs by default
		[120, "idle"],
		[156, "stand"],
		[204, "walk", { to: [2.0, 0.4], heading: 0 }],
		[276, "kneel"],
		[306, "lie", { on: "mat", head: 0 }],
		[348, "idle"],
	],
};
