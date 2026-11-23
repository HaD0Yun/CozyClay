// The box look's body parts as plain data, for the renderer that has no three.js (render.mjs).
// The numbers repeat src/lowvis/looks/parts.js and box.js (which need three.js to import); the joints, rest
// positions and tips come from rig17.js, so a rig change still reaches this table.
import { INDEX, REST, TIPS } from "../rig17.js";

const GAP = 0.012; // m cut from each end of a limb box (box.js)
const J = name => REST[INDEX[name]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** The rotation that turns +Y onto the unit vector d (three's setFromUnitVectors). */
function fromY(d) {
	const q = [d[2], 0, -d[0], 1 + d[1]], l = Math.hypot(...q);
	return l < 1e-9 ? [1, 0, 0, 0] : q.map(v => v / l);
}

// part: { joint, off: centre relative to the joint at rest, size: [x, y, z] in the part's own frame, q: its rest
//         rotation, dark: accent colour, right: on the figure's right side }
const parts = [];
const block = (joint, centre, size, extra = {}) => parts.push({ joint: INDEX[joint], off: sub(centre, J(joint)), size, q: [0, 0, 0, 1], dark: false, right: false, ...extra });
const limb = (joint, from, to, w, d, right) => {
	const v = sub(to, from), length = Math.hypot(...v);
	parts.push({ joint: INDEX[joint], off: sub(from.map((a, k) => (a + to[k]) / 2), J(joint)), size: [w, length - GAP * 2, d], q: fromY(v.map(a => a / length)), dark: false, right });
};

block("Hips", [0, 1.045, 0.005], [0.3, 0.185, 0.19]);
block("Spine", [0, 1.238, 0], [0.245, 0.17, 0.16]);
block("Spine2", [0, 1.42, -0.025], [0.31, 0.165, 0.2]);
block("Neck", [0, 1.548, -0.025], [0.085, 0.075, 0.085]);
{
	const c = [0, 1.7, 0.005], [w, h, d] = [0.175, 0.235, 0.2];
	block("Head", c, [w, h, d]);
	block("Head", [c[0], c[1] + h * 0.16, c[2] + d / 2 + 0.004], [w * 0.86, h * 0.2, 0.012], { dark: true }); // visor, on the +Z face
	block("Head", [c[0], c[1] - h * 0.05, c[2] + d / 2 + 0.02], [0.04, 0.06, 0.045]); // nose
}
for (const side of ["Left", "Right"]) {
	const s = side === "Left" ? 1 : -1, right = s < 0, ankle = J(`${side}Foot`), tip = TIPS[`${side}Foot`];
	limb(`${side}Arm`, J(`${side}Arm`), J(`${side}ForeArm`), 0.09, 0.095, right);
	limb(`${side}ForeArm`, J(`${side}ForeArm`), J(`${side}Hand`), 0.078, 0.082, right);
	limb(`${side}Hand`, J(`${side}Hand`), TIPS[`${side}Hand`], 0.04, 0.095, right);
	limb(`${side}UpLeg`, J(`${side}Leg`), J(`${side}UpLeg`), 0.13, 0.135, right);
	limb(`${side}Leg`, [ankle[0], ankle[1] - 0.012, ankle[2]], J(`${side}Leg`), 0.1, 0.105, right);
	const centre = [s * Math.abs(ankle[0]), 0.04, (tip[2] + ankle[2] - 0.06) / 2], size = [0.1, 0.08, tip[2] - ankle[2] + 0.06];
	block(`${side}Foot`, centre, size, { right });
	block(`${side}Foot`, [centre[0], centre[1], centre[2] + size[2] / 2 - 0.0355], [size[0] + 0.004, size[1] + 0.004, 0.075], { dark: true }); // toe cap
	for (const [joint, k] of [["Arm", 0.075], ["ForeArm", 0.065], ["Hand", 0.055], ["UpLeg", 0.105], ["Leg", 0.085], ["Foot", 0.07]]) {
		block(`${side}${joint}`, J(`${side}${joint}`), [k, k, k], { dark: true }); // knuckle on the joint
	}
}

/** Every box of the figure, in rest space relative to its joint. */
export const FIGURE_PARTS = Object.freeze(parts);
