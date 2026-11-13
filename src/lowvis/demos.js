// The four demos every engine builds. Same scene, same beats, same frame ranges, so the clips can be laid side by
// side. 24 fps. World: metres, Y up, floor at y = 0. A character's `at` is [x, z]; `heading` is degrees about Y,
// 0 = facing +Z, 90 = facing +X. A prop's `at` is the CENTRE of its box, `size` is [w, h, d].
// A beat's `to` frame is exclusive. Between beats the figure holds or blends; the engine decides how.
export const DEMOS = Object.freeze({
	locomotion: {
		frames: 336,
		characters: [{ id: "a", at: [0, 0], heading: 0 }],
		props: [],
		beats: [
			{ who: "a", from: 0, to: 24, do: "stand idle" },
			{ who: "a", from: 24, to: 120, do: "walk to [0, 3]" },
			{ who: "a", from: 120, to: 156, do: "turn on the spot to heading 90" },
			{ who: "a", from: 156, to: 240, do: "run to [4, 3]" },
			{ who: "a", from: 240, to: 288, do: "slow to a walk, turn to heading 180 while walking, reach [4.6, 2]" },
			{ who: "a", from: 288, to: 336, do: "stop, feet together, stand idle" },
		],
	},
	sit: {
		frames: 384,
		characters: [{ id: "a", at: [0, 0], heading: 0 }],
		props: [
			{ id: "chair", size: [0.45, 0.45, 0.45], at: [0, 0.225, 1.6] },
			{ id: "mat", size: [0.9, 0.1, 2.0], at: [2.0, 0.05, 1.6] },
		],
		beats: [
			{ who: "a", from: 0, to: 72, do: "walk to the chair, turn the back to it (stand at [0, 1.15], heading 180)" },
			{ who: "a", from: 72, to: 120, do: "sit down on the chair (seat top y = 0.45)" },
			{ who: "a", from: 120, to: 156, do: "sit still, hands on the thighs" },
			{ who: "a", from: 156, to: 204, do: "stand up" },
			{ who: "a", from: 204, to: 276, do: "walk to the mat (stand at [2.0, 0.4], heading 0)" },
			{ who: "a", from: 276, to: 348, do: "kneel, then lie down on the back along the mat, head toward +Z" },
			{ who: "a", from: 348, to: 384, do: "lie still" },
		],
	},
	object: {
		frames: 384,
		characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [3.0, 1.2], heading: 270 }],
		props: [
			{ id: "table", size: [0.8, 0.75, 0.6], at: [0, 0.375, 1.2] },
			{ id: "box", size: [0.3, 0.3, 0.3], at: [0, 0.9, 1.05], moves: true },
		],
		beats: [
			{ who: "a", from: 0, to: 48, do: "walk to the table (stand at [0, 0.6], heading 0)" },
			{ who: "a", from: 48, to: 84, do: "reach both hands to the sides of the box" },
			{ who: "a", from: 84, to: 120, do: "lift the box to chest height" },
			{ who: "a", from: 120, to: 240, do: "turn and carry the box to b (stand at [2.3, 1.2], heading 90)" },
			{ who: "b", from: 0, to: 216, do: "stand idle, look at a" },
			{ who: "b", from: 216, to: 264, do: "raise both hands to receive the box" },
			{ who: "a", from: 240, to: 288, do: "hold the box out; b takes it at frame 264; a lowers the arms" },
			{ who: "b", from: 264, to: 336, do: "pull the box to the chest, turn to heading 90" },
			{ who: "b", from: 336, to: 384, do: "bend and put the box on the floor at [3.6, 0.15, 1.2], stand up" },
		],
	},
	duo: {
		frames: 360,
		characters: [{ id: "a", at: [0, 0], heading: 90 }, { id: "b", at: [3.0, 0], heading: 270 }],
		props: [],
		beats: [
			{ who: "a", from: 0, to: 72, do: "walk to [1.1, 0] facing b" },
			{ who: "b", from: 0, to: 72, do: "walk to [1.9, 0] facing a" },
			{ who: "a", from: 72, to: 132, do: "handshake with the right hand: reach, two shakes, let go" },
			{ who: "b", from: 72, to: 132, do: "handshake with the right hand: reach, two shakes, let go" },
			{ who: "a", from: 132, to: 204, do: "talk: two open-hand gestures, small weight shifts" },
			{ who: "b", from: 132, to: 204, do: "listen: nod twice, arms crossed or on the hips" },
			{ who: "a", from: 204, to: 240, do: "step in and push b's chest with both hands (contact at frame 228)" },
			{ who: "b", from: 228, to: 300, do: "stagger back two steps to about [2.9, 0], catch the balance" },
			{ who: "a", from: 240, to: 360, do: "lower the arms, stand" },
			{ who: "b", from: 300, to: 360, do: "stand up straight, look at a" },
		],
	},
	push: {
		frames: 336,
		characters: [{ id: "a", at: [0, 0], heading: 0 }],
		props: [{ id: "crate", size: [0.8, 0.8, 0.8], at: [0, 0.4, 2.0], moves: true }], // about 100 kg
		beats: [
			{ who: "a", from: 0, to: 48, do: "walk up to the heavy crate" },
			{ who: "a", from: 48, to: 72, do: "set both hands on the crate" },
			{ who: "a", from: 72, to: 114, do: "brace the feet back, lean the whole body in and shove: the crate does not move" },
			{ who: "a", from: 114, to: 258, do: "the crate breaks loose and creeps 2 m; short driving steps, feet behind the hips" },
			{ who: "a", from: 258, to: 294, do: "stop pushing: the crate stops at once; let go and straighten up" },
			{ who: "a", from: 294, to: 336, do: "wipe the brow, stand" },
		],
	},
	chop: {
		frames: 312,
		characters: [{ id: "a", at: [0, 0], heading: 0 }],
		props: [
			{ id: "stump", size: [0.25, 1.0, 0.25], at: [0, 0.5, 1.6] },
			{ id: "trunk", size: [0.25, 1.4, 0.25], at: [0, 1.7, 1.6], moves: true },
			{ id: "sword", size: [0.04, 0.04, 1.0], at: [-0.26, 0.9, 0.4], moves: true },
		],
		beats: [
			{ who: "a", from: 0, to: 30, do: "stand with the sword in the right hand" },
			{ who: "a", from: 30, to: 78, do: "walk to the tree, step into a stance beside it" },
			{ who: "a", from: 78, to: 126, do: "wind up and strike: the blade stops in the trunk" },
			{ who: "a", from: 126, to: 168, do: "wind up and strike again" },
			{ who: "a", from: 168, to: 204, do: "big wind-up: chest and hips turn away, sword far back" },
			{ who: "a", from: 204, to: 240, do: "fast cut through the trunk at frame 208, the body weight follows; follow through and settle" },
			{ who: "a", from: 240, to: 312, do: "step back, lower the sword, stand; the upper trunk lies on the floor" },
		],
	},
});

export const DEMO_IDS = Object.freeze(Object.keys(DEMOS));
