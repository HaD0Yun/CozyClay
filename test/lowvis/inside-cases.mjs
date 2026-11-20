// Scenes and specs made for the inside rows (verify-inside.mjs) and for comparing the motion tool's text against an
// older tree. Each case: { name, scene, spec, figure?, off?, told: the "<body or moving prop>><prop>" pairs the
// inside rows must name, exactly; endsBy?: { <pair>: frame } its last frame inside comes before that frame; skip?:
// { <pair>: [[from, to, joints?], ...] } frames [from, to) on which the spec's words make that pair touch (only those
// joints' solids when joints is given) }.
import { REST, INDEX } from "../../src/lowvis/rig17.js";

const ANKLE = REST[INDEX.RightFoot][1]; // the ankle joint over the sole at scale 1
const prop = (id, size, at, more = {}) => ({ id, size, at, ...more });
const one = (props, extra = {}) => ({ frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0, ...extra }], props });
const walk = to => ({ a: [[5, "walk", { to }]] });

const base = [
	{ name: "a box around the head", scene: one([prop("crate", [0.4, 0.4, 0.4], [0, 1.7, 0])]), spec: { a: [[0, "idle"]] }, told: ["a>crate"] },
	{ name: "walk through a tall wall", scene: one([prop("wall", [2, 2, 0.2], [0, 1, 1.5])]), spec: walk([0, 3]), told: ["a>wall"] },
	{ name: "walk through a turned wall", scene: one([prop("wall", [2, 2, 0.2], [0, 1, 1.5], { turn: 30 })]), spec: walk([0, 3]), told: ["a>wall"] },
	{ name: "walk through a thin plate", scene: one([prop("plate", [2, 2, 0.012], [0, 1, 1.5])]), spec: walk([0, 3]), told: ["a>plate"] },
	{ name: "walk beside a box", scene: one([prop("crate", [0.5, 1, 0.5], [0.8, 0.5, 1.5])]), spec: walk([0, 3]), told: [] },
	// the engine keeps walking feet on the floor (ground y = 0), so they pass through a low step; a foot the spec lifts onto
	// its top, or a body the spec shifts up onto it, stands on it
	{ name: "walk across a low step at floor level", scene: one([prop("step", [1.2, 0.12, 0.8], [0, 0.06, 1.5])]), spec: walk([0, 3]), told: ["a>step"] },
	{ name: "stand on a low step, shifted up onto it", scene: one([prop("step", [1.2, 0.12, 0.8], [0, 0.06, 0])]), spec: { a: [[0, "pose", { tilt: [0, 0], shift: [0, 0.12, 0], over: 0 }]] }, told: [] },
	{ name: "a foot put on a box top", scene: one([prop("crate", [0.3, 0.15, 0.3], [-0.1, 0.075, 0.5])]), spec: { a: [[5, "pose", { footR: { world: [-0.1, 0.15 + ANKLE, 0.5] }, over: 20 }]] }, told: ["a>crate"], endsBy: { "a>crate": 25 } }, // the foot swings low through the box's side; standing on its top from f25 is not inside
	{ name: "walk into a box", scene: one([prop("crate", [1, 1, 1], [0, 0.5, 2.2])]), spec: walk([0, 2.2]), told: ["a>crate"] },
	{ name: "sit on a seat", scene: { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 180 }], props: [prop("seat", [0.45, 0.45, 0.45], [0, 0.225, 0.45])] }, spec: { a: [[10, "sit", { on: "seat" }], [60, "idle"]] }, told: [], skip: { "a>seat": [[10, 120]] } },
	{ name: "sit, stand up and walk through the seat", scene: { frames: 160, characters: [{ id: "a", at: [0, 0], heading: 180 }], props: [prop("seat", [0.45, 0.45, 0.45], [0, 0.225, 0.45])] }, spec: { a: [[10, "sit", { on: "seat" }], [50, "idle"], [70, "stand"], [100, "walk", { to: [0, 1.4], heading: 0 }]] }, told: ["a>seat"], skip: { "a>seat": [[10, 100]] } },
	{ name: "kneel and lie on a mat", scene: { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [prop("mat", [0.9, 0.1, 2], [0, 0.05, 1.4])] }, spec: { a: [[10, "kneel"], [40, "lie", { on: "mat", head: 0 }], [80, "idle"]] }, told: [], skip: { "a>mat": [[40, 120]] } },
	{ name: "a ball keyed along a lane", scene: one([prop("lane", [0.8, 0.02, 4], [1.5, 0.01, 2]), prop("ball", [0.2, 0.2, 0.2], [1.5, 0.12, 0.4], { shape: "sphere", moves: true })]), spec: { ball: [[10, "move", { to: [1.5, 0.12, 3.5], over: 80 }]] }, told: [] },
	{ name: "a box keyed through a wall", scene: one([prop("wall", [0.2, 1, 1], [1.5, 0.5, 1.5]), prop("crate", [0.4, 0.4, 0.4], [0.6, 0.2, 1.5], { moves: true })]), spec: { crate: [[10, "move", { to: [2.4, 0.2, 1.5], over: 60 }]] }, told: ["crate>wall"] },
	{ name: "a box keyed through a hollow wall", scene: one([prop("wall", [0.2, 1, 1], [1.5, 0.5, 1.5], { hollow: true }), prop("crate", [0.4, 0.4, 0.4], [0.6, 0.2, 1.5], { moves: true })]), spec: { crate: [[10, "move", { to: [2.4, 0.2, 1.5], over: 60 }]] }, told: [] },
	{ name: "a ball launched at a wall", scene: one([prop("wall", [2, 1, 0.2], [1.5, 0.5, 2.5]), prop("ball", [0.22, 0.22, 0.22], [1.5, 0.11, 1], { shape: "sphere", moves: true })]), spec: { ball: [[10, "launch", { vel: [0, 0, 4] }]] }, told: [] },
	{ name: "a stick in one hand poked into a wall", scene: one([prop("wall", [2, 2, 0.2], [0, 1, 1.25]), prop("stick", [0.04, 0.04, 1.4], [-0.25, 0.85, 0.3], { moves: true })]), spec: { a: [[0, "hold", { prop: "stick", hand: "R" }], [10, "walk", { to: [0, 0.75] }]] }, told: ["stick>wall"] },
	{ name: "a box carried and placed on a table", scene: one([prop("table", [0.8, 0.75, 0.6], [0, 0.375, 1.1]), prop("crate", [0.3, 0.3, 0.3], [0, 0.9, 0.95], { moves: true }), prop("shelf", [0.6, 0.75, 0.6], [0.85, 0.375, 0.45])]), spec: { a: [[0, "walk", { to: [0, 0.45] }], [30, "carry", { prop: "crate", at: [0, 1.1, 0.42], over: 20 }], [60, "turn", { heading: 90 }], [80, "place", { prop: "crate", at: [0.75, 0.9, 0.45], over: 20 }]] }, told: [], skip: { "a>crate": [[30, 100, ["LeftForeArm", "RightForeArm"]]] } },
	{ name: "a crate riding on a keyed cart", scene: one([prop("cart", [0.6, 0.3, 0.8], [1.2, 0.15, 1], { moves: true }), prop("crate", [0.3, 0.3, 0.3], [1.2, 0.45, 1], { moves: true })]), spec: { crate: [[0, "ride", { on: "cart" }]], cart: [[10, "move", { to: [1.2, 0.15, 2.6], over: 60 }]] }, told: [], skip: { "crate>cart": [[0, 120]] } },
	{ name: "a hat riding on the head", scene: one([prop("hat", [0.3, 0.1, 0.3], [0, 1.8, 0], { moves: true })]), spec: { hat: [[0, "ride", { joint: "Head", of: "a", at: [0, 0.12, 0] }]], a: [[10, "walk", { to: [0, 1.5] }]] }, told: [], skip: { "a>hat": [[0, 120, ["Head"]]] } },
	{ name: "two walk through one wall", scene: { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [1, 0], heading: 0 }], props: [prop("wall", [3, 2, 0.2], [0.5, 1, 1.5])] }, spec: { a: [[5, "walk", { to: [0, 3] }]], b: [[5, "walk", { to: [1, 3] }]] }, told: ["a>wall", "b>wall"] },
];
// the same cases with every scale of body (and the box around the body kept at its hips' height)
const scaled = [0.5, 2].map(s => ({ name: `a box around the hips at scale ${s}`, scene: one([prop("crate", [0.3, 0.3, 0.3], [0, 1.0 * s, 0])], { scale: s }), spec: { a: [[0, "idle"]] }, told: ["a>crate"] }));
const reversed = base.filter(c => c.scene.props.length > 1 || c.scene.characters.length > 1).map(c => ({ ...c, name: `${c.name}, listed the other way`, scene: { ...c.scene, characters: c.scene.characters.slice().reverse(), props: c.scene.props.slice().reverse() } }));
export const CASES = [...base, ...scaled, ...reversed, ...base.map(c => ({ ...c, name: `${c.name} (cube look)`, figure: "cube" }))];
