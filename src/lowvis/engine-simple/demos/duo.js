// Demo "duo": approach, handshake, a talks while b listens, a pushes b, b staggers back and recovers.
export default {
	demo: "duo",
	a: [
		[0, "walk", { to: [1.1, 0] }],
		[0, "pose", { look: "b" }],
		[72, "pose", { R: { meet: "b" }, over: 14 }],
		[86, "pose", { R: { meet: "b" }, shake: 2, over: 30 }],
		[118, "pose", { R: "rest", over: 14 }],
		[132, "pose", { hands: [0.3, 0.15, 0.32], hip: [0.03, 0, 0], over: 12 }],
		[150, "pose", { hands: [0.24, 0.0, 0.2], over: 12 }],
		[166, "pose", { R: [-0.3, 0.3, 0.36], L: "rest", hip: [-0.03, 0, 0], over: 12 }],
		[188, "pose", { hands: "rest", hip: [0, 0, 0], over: 16 }],
		[204, "pose", { hands: [0.2, 0.2, 0.12], lean: -4, over: 10 }], // wind up
		[210, "walk", { to: [1.42, 0], steps: 1 }],
		[214, "pose", { hands: { chest: "b" }, lean: 8, over: 14, ease: "in" }], // contact at 228
		[228, "pose", { hands: [0.14, 0.3, 0.5], over: 6, ease: "out" }],
		[240, "pose", { hands: "rest", lean: 0, over: 30 }],
		[252, "walk", { to: [1.42, 0], steps: 1 }], // bring the back foot up
	],
	b: [
		[0, "walk", { to: [1.9, 0] }],
		[0, "pose", { look: "a" }],
		[72, "pose", { R: { meet: "a" }, over: 14 }],
		[86, "pose", { R: { meet: "a" }, shake: 2, over: 30 }],
		[118, "pose", { R: "rest", over: 14 }],
		[132, "pose", { hands: [0.05, -0.06, 0.15], over: 16 }], // hands held together in front
		[146, "pose", { nod: 2, over: 40 }],
		[228, "walk", { to: [2.9, 0], facing: 270, steps: 3, burst: true }],
		[228, "pose", { hands: [0.42, 0.25, 0.2], lean: -16, over: 8, ease: "out" }],
		[250, "pose", { hands: [0.3, 0.0, 0.15], lean: 10, over: 22 }],
		[276, "pose", { hands: "rest", lean: 0, over: 24 }],
	],
};
