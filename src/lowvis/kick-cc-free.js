// "kick" (cc-free): one figure runs up to a football, kicks it with the right foot at a standing box and watches it
// bounce back and stop. The scene and the engine-simple spec in one file; tools/lowvis/kick-cc-free.mjs builds it.
// Metres, Y up, floor y = 0, 24 fps; the figure faces +Z with +X on its left.

export const KICK = 132; // the frame the right foot is on the ball; the ball is still in place on it and flies from the next

export const scene = {
	frames: 240,
	characters: [{ id: "a", at: [0, 0], heading: 0 }],
	props: [
		{ id: "ball", size: [0.22, 0.22, 0.22], shape: "sphere", at: [0, 0.11, 3.0], moves: true },
		{ id: "goal", size: [2.0, 1.0, 0.2], at: [0, 0.5, 9.0] },
	],
};

export const spec = {
	demo: "kick",
	a: [
		[0, "idle"],
		[0, "pose", { look: "ball", over: 0 }],
		// run-up: four steps R L R L, each longer than the one before; the left foot lands 0.2 m to the left of the ball
		// and the right foot stays behind (it never takes a fifth step: it becomes the kick)
		[24, "walk", { to: [0.118, 2.7], steps: 4, first: "R", stepFrames: 18, ease: "in", end: { L: [0, 0.3], R: [0, -0.75] } }],
		[70, "pose", { hip: [0, 0, -0.12], over: 22, ease: "in" }],                                    // the pelvis brakes into the plant step
		[88, "pose", { footR: { at: [-0.1, 0.55, -0.45], pitch: 60 }, over: 32 }],                     // the right heel comes up behind
		// hand targets are measured from the unshifted hips, so their z carries the pelvis shift (`hip`) of the same key
		[94, "pose", { L: [0.52, 0.25, 0.1], R: [-0.5, 0.2, -0.15], lean: -10, hipTurn: -12, twist: 10, hip: [0.02, -0.02, 0.02], over: 24 }], // arms out, chest back
		[120, "pose", { footR: { world: [0, 0.235, 2.875], pitch: 60 }, over: 12, ease: "in" }],       // whip the foot down onto the ball
		[120, "pose", { L: [0.46, 0.25, 0.4], R: [-0.46, 0.15, 0], lean: 4, hipTurn: 6, twist: -8, hip: [0.03, -0.03, 0.2], over: 12, ease: "in", fast: true }],
		[KICK, "pose", { footR: { at: [-0.06, 0.6, 0.98], pitch: 25 }, over: 9, ease: "out" }],       // follow through: the leg rises in front
		[KICK, "pose", { L: [0.4, 0.15, 0.35], R: [-0.42, 0.1, 0.15], lean: 8, hipTurn: 14, twist: -14, hip: [0.02, 0, 0.3], over: 9, ease: "out", fast: true }],
		[141, "walk", { to: [0.1, 3.95], steps: 2, first: "R" }],                                      // the kicking leg comes down as a step, the left closes
		[144, "pose", { footR: "plant", over: 8 }],                                                 // ... into the step the body layer is taking
		[143, "pose", { hands: "rest", lean: 0, hipTurn: 0, twist: 0, hip: [0, 0, 0], over: 22 }],
		[168, "idle"],
	],
	ball: [[KICK, "launch", { vel: [0, 3.27, 9.93], bounce: 0.3, friction: 3.2 }]],
};
