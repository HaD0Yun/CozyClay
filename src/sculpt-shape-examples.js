/**
 * One minimal valid part per sculpt shape (and for `repeat`), appended to a
 * refusal of that shape's fields. An agent that reads a working example fixes
 * its call; one that reads only the rule tends to fall back to a box.
 * verify-sculpt-repeat.mjs checks that every example validates. Pure.
 */

const EXAMPLES = Object.freeze({
	blob: { id: "head", shape: "blob", size: [0.3, 0.28, 0.3], position: [0, 0.14, 0], roundness: 0.2, taper: 0.1 },
	box: { id: "board", shape: "box", size: [0.6, 0.03, 0.2], position: [0, 0.015, 0], roundness: 0.3 },
	cylinder: { id: "post", shape: "cylinder", size: [0.08, 1, 0.08], position: [0, 0.5, 0], taper: 0.2 },
	torus: { id: "ring", shape: "torus", size: [0.4, 0.4, 0.05], position: [0, 0.2, 0] },
	frame: { id: "frame", shape: "frame", size: [0.5, 0.7, 0.04], position: [0, 0.35, 0], border: 0.05 },
	lathe: { id: "pot", shape: "lathe", size: [0.3, 0.35, 0.3], position: [0, 0.175, 0], profile: [[0, 0], [0.7, 0.02], [1, 0.6], [0.8, 1]] },
	tube: { id: "stem", shape: "tube", size: [0.2, 0.6, 0.05], position: [0, 0.3, 0], path: [[0, -0.5, 0], [0.3, 0, 0], [-0.2, 0.5, 0]], thickness: 0.03, taper: 0.4 },
	extrude: { id: "sign", shape: "extrude", size: [0.5, 0.3, 0.03], position: [0, 0.15, 0], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.2], [0, 0.5], [-0.5, 0.2]] },
	loft: { id: "trunk", shape: "loft", size: [0.4, 1.2, 0.4], position: [0, 0.6, 0], sections: [{ y: 0, w: 1, d: 1 }, { y: 0.3, w: 0.6, d: 0.6 }, { y: 1, w: 0.4, d: 0.45, x: 0.1 }] },
	convex: { id: "rock", shape: "convex", size: [0.5, 0.3, 0.4], position: [0, 0.15, 0], seed: 3 },
	scatter: { id: "grass", shape: "scatter", size: [1, 0.15, 1], position: [0, 0.075, 0], item: "blade", count: 600 },
	repeat: { id: "picket", shape: "box", size: [0.08, 0.9, 0.02], position: [-0.9, 0.45, 0], repeat: { count: 12, step: [0.16, 0, 0] } },
});

/** The example sentence for `name` (a shape or "repeat"), or "" when there is none. */
export function sculptRefusalExample(name) {
	const example = EXAMPLES[name];
	if (!example) return "";
	const ring = name === "repeat" ? ` A ring: repeat { count: 8, turn: [0, 45, 0], pivot: [0, 0, 0] }; a spiral stair: step [0, 0.18, 0] with turn [0, 30, 0].` : "";
	return ` A valid ${name} part: ${JSON.stringify(example)}.${ring}`;
}

export const SCULPT_EXAMPLE_NAMES = Object.freeze(Object.keys(EXAMPLES));
export const sculptExamplePart = (name) => EXAMPLES[name];
