// Demo "locomotion": stand, walk, turn on the spot, run, slow to a walk through a turn, stop with the feet together.
export default {
	demo: "locomotion",
	a: [
		[0, "idle"],
		[24, "walk", { to: [0, 3] }],
		[120, "turn", { heading: 90 }],
		[156, "run", { to: [4, 3] }],
		[240, "walk", { to: [4.6, 2.2], heading: 180 }],
		[288, "walk", { to: [4.6, 2.0] }], // the stop: brake over the last 0.2 m, close the feet
		[312, "idle"],
	],
};
