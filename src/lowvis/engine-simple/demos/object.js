// Demo "object": a lifts the box off the table, carries it to b, hands it over; b puts it on the floor.
export default {
	demo: "object",
	a: [
		[0, "walk", { to: [0, 0.6] }],
		[48, "pose", { hands: { prop: "box" }, over: 30 }],
		[84, "carry", { prop: "box", at: [0, 0.12, 0.27], over: 30, ease: "over" }],
		[120, "turn", { heading: 90 }],
		[144, "walk", { to: [2.3, 1.2], heading: 90 }],
		[150, "pose", { look: "b" }],
		[240, "carry", { prop: "box", at: [0, 0.14, 0.3], over: 20 }],
		[264, "pose", { hands: "rest", over: 24 }],
	],
	b: [
		[0, "idle"],
		[0, "pose", { look: "a" }],
		[216, "pose", { hands: { prop: "box" }, over: 44 }],
		[264, "carry", { prop: "box", at: [0, 0.12, 0.27], over: 24 }],
		[276, "turn", { heading: 90 }],
		[276, "pose", { look: "fwd", over: 30 }],
		[336, "place", { prop: "box", at: [3.6, 0.15, 1.2], over: 22 }],
		[358, "pose", { hands: "rest", over: 22 }],
	],
};
