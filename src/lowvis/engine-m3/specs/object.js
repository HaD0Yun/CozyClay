// Demo "object" as motion3 specs: a takes a box off a table, carries it to b, b takes it and puts it on the floor.
import { SCHEMA, standSet, turnOnSpot, linesOf } from "../author.js";
import { boxRecord, carriedProp } from "../scene.js";
import { DEMOS } from "../../demos.js";

const deg = r => r * 180 / Math.PI, wrap = a => a - 360 * Math.round(a / 360);
/** head_yaw that looks from floor point `at` (heading h) at floor point `to`. */
const lookYaw = (at, h, to) => Math.round(wrap(deg(Math.atan2(to[0] - at[0], to[1] - at[1])) - h) * 10) / 10;

export function object(B) {
	const def = DEMOS.object, box = def.props.find(p => p.id === "box");
	const A = [0, 0.6], T = [2.3, 1.2], Bp = [3.0, 1.2], hCarry = Math.round(deg(Math.atan2(T[0] - A[0], T[1] - A[1])) * 10) / 10;
	const GRAB = 84, TAKE = 264, DOWN = 360, both = (name, v) => ({ [`${name}_l`]: v, [`${name}_r`]: v });
	// a body anchor per hand (mirrored in x) and the two weights that put the left hand on the L one, the right on the R one
	const sided = (name, [x, y, z]) => ({ [`${name}L`]: { kind: "body", p: [x, y, z] }, [`${name}R`]: { kind: "body", p: [-x, y, z] } });
	const on = (name, v) => ({ [`w_${name}L_l`]: v, [`w_${name}R_r`]: v });
	// a's hands on the box's side faces: the wrist 3.5 cm off the face and 7 cm short of the box's middle
	const side = (y, z) => ({ hand_l: [box.size[0] / 2 + 0.035, y, z], hand_r: [-box.size[0] / 2 - 0.035, y, z] });
	const out = { elbow_l: [0.6, -0.6, -0.4], elbow_r: [-0.6, -0.6, -0.4] };
	const carry = { ...both("armw", 1), ...on("carry", 1), ...on("give", 0), ...on("open", 0) };
	const a = {
		schema: SCHEMA, fps: 24, frames: def.frames,
		anchors: {
			...sided("carry", [0.185, 0.12, 0.25]), ...sided("give", [0.185, 0.13, 0.29]), ...sided("open", [0.3, 0.1, 0.27]),
		},
		use: [
			{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
			{ skill: "walkTo", f0: 0, args: { to: A, steps: 2, period: 7 } },
			{ skill: "walkTo", f0: 156, args: { to: T, steps: 5, period: 10 } },
		],
		keys: [
			// f48-84: reach both hands to the sides of the box (keys: the trunk leans, the knees give)
			{ f: 48, set: { ...both("armw", 0), ...on("carry", 0), ...on("give", 0), ...on("open", 0) } },
			{ f: 66, set: { ...both("armw", 1), hand_l: [0.3, 0.98, 0.9], hand_r: [-0.3, 0.98, 0.9], ...out, root: [A[0], B.hipsY - 0.04, A[1] + 0.03], pitch: 10, spine_pitch: 20, head_pitch: 8 } },
			{ f: GRAB, set: { ...side(box.at[1], box.at[2] - 0.07), root: [A[0], B.hipsY - 0.07, A[1] + 0.06], pitch: 14, spine_pitch: 28, head_pitch: 10 } },
			// f84-120: lift it straight up, then to the chest
			{ f: 96, set: { ...side(box.at[1] + 0.16, box.at[2] - 0.07), root: [A[0], B.hipsY - 0.05, A[1] + 0.04], pitch: 10, spine_pitch: 18, ...on("carry", 0) } },
			{ f: 118, set: { ...carry, root: [A[0], B.hipsY - 0.01, A[1]], pitch: 0, spine_pitch: 0, head_pitch: 0 } },
			// f120-156: turn on the spot toward b with the box (keys)
			...turnOnSpot(B, { f0: 120, f1: 156, at: A, h0: 0, h1: hCarry, extra: carry }),
			// f240-288: hold the box out, let go when b has it (f264), lower the arms
			{ f: 240, set: { ...carry, yaw: hCarry } },
			{ f: 254, set: { yaw: 90, ...on("carry", 0), ...on("give", 1) } },
			{ f: TAKE, set: { ...on("give", 1), ...on("open", 0), ...both("armw", 1) } },
			{ f: TAKE + 8, set: { ...on("give", 0), ...on("open", 1), ...both("armw", 1) } },
			{ f: 288, set: { ...both("armw", 0), ...both("aswing", 0), ...both("abend", 0) } },
			{ f: 383, set: { ...both("armw", 0) } },
		],
	};
	// b: the hands go under the box (a holds its sides), wrists 3 cm under its bottom
	const give = [T[0] + 0.41, 1.19, T[1]], under = give[1] - box.size[1] / 2 - 0.03;
	const hold = { ...both("armw", 1), ...on("hold", 1), ...on("floor", 0) };
	const b = {
		schema: SCHEMA, fps: 24, frames: def.frames,
		anchors: {
			...sided("hold", [0.08, under - B.hipsY + 0.01, 0.2]),
			// putting it down: the wrists just over the floor under where the box goes (the compiler brings the body down to them)
			floorL: { kind: "world", p: [3.6 - 0.11, 0.06, 1.2 - 0.08] }, floorR: { kind: "world", p: [3.6 - 0.11, 0.06, 1.2 + 0.08] },
		},
		use: [{ skill: "standIdle", f0: 0, args: { at: Bp, heading: 270 } }],
		keys: [
			// f0-216: stand, look at a (the head follows where a's beats put it)
			...[[0, [0, 0]], [48, A], [156, A], [198, [(A[0] + T[0]) / 2, (A[1] + T[1]) / 2]], [240, T]].map(([f, to]) => ({ f, set: { head_yaw: lookYaw(Bp, 270, to) } })),
			// f216-264: raise both hands under the box
			{ f: 216, set: { ...both("armw", 0), ...on("hold", 0), ...on("floor", 0) } },
			{ f: 244, set: { ...both("armw", 1), hand_l: [Bp[0] - 0.14, under - 0.12, Bp[1] + 0.12], hand_r: [Bp[0] - 0.14, under - 0.12, Bp[1] - 0.12], head_pitch: 14 } },
			{ f: 260, set: { hand_l: [give[0] + 0.11, under, give[2] + 0.08], hand_r: [give[0] + 0.11, under, give[2] - 0.08] } },
			{ f: TAKE, set: { hand_l: [give[0] + 0.11, under, give[2] + 0.08], hand_r: [give[0] + 0.11, under, give[2] - 0.08], ...on("hold", 0) } },
			// f264-336: pull it to the chest, turn to heading 90 (keys)
			{ f: 276, set: { ...hold, head_pitch: 0, head_yaw: 0 } },
			...turnOnSpot(B, { f0: 278, f1: 334, at: Bp, h0: 270, h1: 90, extra: hold }),
			// f336-384: bend, put the box on the floor, stand up
			{ f: 336, set: { ...hold, root: [Bp[0], B.hipsY - 0.01, Bp[1]], pitch: 0, spine_pitch: 0 } },
			{ f: 346, set: { root: [Bp[0] + 0.06, 0.78, Bp[1]], pitch: 28, spine_pitch: 24 } },
			{ f: 357, set: { ...both("armw", 1), ...on("hold", 0), w_floorL_l: 1, w_floorR_r: 1, root: [Bp[0] + 0.14, 0.4, Bp[1]], pitch: 48, spine_pitch: 50, head_pitch: -10, fpitch_l: 30, fpitch_r: 30,
				foot_l: standSet(B, Bp, 90).foot_l, foot_r: standSet(B, Bp, 90).foot_r } },
			{ f: DOWN, set: { w_floorL_l: 1, w_floorR_r: 1, ...both("armw", 1) } },
			{ f: DOWN + 3, set: { w_floorL_l: 1, w_floorR_r: 1, root: [Bp[0] + 0.14, 0.4, Bp[1]], pitch: 48, spine_pitch: 50 } },
			{ f: DOWN + 11, set: { w_floorL_l: 0, w_floorR_r: 0, ...both("armw", 0.4), root: [Bp[0] + 0.08, 0.7, Bp[1]], pitch: 32, spine_pitch: 24, fpitch_l: 10, fpitch_r: 10 } },
			{ f: 383, set: { ...standSet(B, Bp, 90) } },
		],
	};
	return {
		objects: def.props.filter(p => !p.moves).map(boxRecord),
		characters: { a, b },
		props: clip => carriedProp(clip, box, [{ from: GRAB, who: "a" }, { from: TAKE, who: "b" }], { at: DOWN, to: [3.6, 0.15, 1.2], yaw: 0, settle: 5 }),
		lines: linesOf(object),
		notes: [
			"reach, lift, hand-over and put-down are hand-written keys on body and world anchors; walkTo carries the box (the hands stay on body anchors while the legs walk)",
			"motion3's carried objects, reachGrip and finger grasp are not used: they need finger joints, so the box is not in the compile. Its track is read back from the two palms of the finished clip (engine-m3/scene.js), so nothing keeps the hands on its faces or out of it",
			"a turns on the spot to the heading of the straight line to b, walks it, and turns the last degrees to heading 90 while holding the box out",
			"a and b stand 0.7 m apart, so a holds the box out only 4 cm and b takes it from underneath",
			"b lets the box go a few cm over the floor and it settles onto its spot in 5 frames",
		],
	};
}
