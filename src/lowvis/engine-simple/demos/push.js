// Demo "push": shove a heavy crate 2 m across the floor. The crate only moves while it is carried with slide:true.
export default {
	demo: "push",
	a: [
		[0, "walk", { to: [0, 0.95] }],
		[48, "push", { to: [0, 0.95] }], // brace in place: feet go back, pelvis drops, body leans in
		[50, "pose", { hands: { prop: "crate", face: true, y: 0.7 }, look: "crate", over: 20 }],
		[84, "pose", { hip: [0, -0.03, 0.07], over: 9, ease: "out" }], // the shove that does not move it
		[96, "pose", { hip: [0, 0, 0], over: 12 }],
		[114, "carry", { prop: "crate", slide: true }],
		[114, "push", { to: [0, 2.95] }],
		[258, "release", { prop: "crate" }],
		[258, "walk", { to: [0, 2.95] }], // feet come up under the hips, the body straightens
		[262, "pose", { hands: "rest", look: "fwd", over: 26 }],
		[292, "pose", { R: [-0.1, 0.6, 0.17], lean: 6, over: 16 }], // forearm to the brow
		[309, "pose", { R: [0.06, 0.6, 0.17], over: 8 }],
		[318, "pose", { R: "rest", lean: 0, over: 18 }],
	],
};
