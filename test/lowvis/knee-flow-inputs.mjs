// Specs whose foot target moves slowly through and around the two leg directions where the side of
// src/lowvis/engine-simple/knee.js has no direction, for either leg, upright, lying on the back and tilted, at scales
// 0.5, 1 and 2, alone and with a second figure. The targets are places on the own Hips joint ({joint: "Hips", at}), so
// they hold the leg direction in the pelvis frame whatever the posture. The two directions are found here, with this
// file's own arithmetic, from the sentence of knee.js's header (d x X plus, weighed by the square of d's part along X,
// the knee direction of a leg 45 degrees forward of down carried by the shortest turn to d).
import { INDEX as J, OFFSET } from "../../src/lowvis/rig17.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = a => mul(a, 1 / Math.hypot(...a));
const X = [1, 0, 0], MID = unit([0, -1, 1]), FRONT = cross(MID, X);
const DEG = Math.PI / 180;

/** The side direction of knee.js for a unit leg direction d (not normalised). */
function side(d) {
	const c = dot(MID, d), k = cross(MID, d), far = add(add(mul(FRONT, c), cross(k, FRONT)), mul(k, dot(k, FRONT) / (1 + c)));
	return add(cross(d, X), mul(far, d[0] * d[0]));
}
/** The leg direction near `start` where side() has no length (Newton steps on the sphere, numeric slopes). */
function zero(start) {
	let d = unit(start);
	for (let it = 0; it < 60; it++) {
		const t1 = unit(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), t2 = cross(d, t1), g = side(d), h = 1e-6;
		const a = mul(add(side(unit(add(d, mul(t1, h)))), mul(g, -1)), 1 / h), b = mul(add(side(unit(add(d, mul(t2, h)))), mul(g, -1)), 1 / h);
		// least squares for x, y in a x + b y = -g
		const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), ag = dot(a, g), bg = dot(b, g), det = aa * bb - ab * ab;
		const x = (-ag * bb + bg * ab) / det, y = (-bg * aa + ag * ab) / det;
		d = unit(add(d, add(mul(t1, x), mul(t2, y))));
	}
	return d;
}
export const ZEROS = [zero([0.79, 0.44, -0.44]), zero([-0.79, 0.44, -0.44])];

const LEG = Math.hypot(...OFFSET[J.LeftLeg]) + Math.hypot(...OFFSET[J.LeftFoot]);
const HIP = [OFFSET[J.LeftUpLeg], OFFSET[J.RightUpLeg]];
const PROPS = [{ id: "mat", size: [0.9, 0.1, 2.0], at: [0, 0.05, 0] }, { id: "mat2", size: [0.9, 0.1, 2.0], at: [2, 0.05, 0] }];
const POSTURES = { stand: () => [], lie: () => [[0, "lie", { on: "mat", head: 0, over: 0 }]], tilt: () => [[0, "pose", { tilt: [40, 25], over: 0 }]] };
const lie2 = [[0, "lie", { on: "mat2", head: 0, over: 0 }]];

/** The foot keys of a path for leg `leg` (0 left, 1 right) past zero z at an angle `off` (deg) from it, along the
 *  direction `phi` (deg) on the sphere, at `r` x the leg's length: 1 degree a frame from 40 degrees before to 40 after. */
function pathKeys(leg, z, off, phi, r, s, pitch) {
	const e1 = unit(cross(z, [0, 1, 0])), e2 = cross(z, e1), m = add(mul(e1, Math.cos(phi * DEG)), mul(e2, Math.sin(phi * DEG))), n = cross(z, m);
	const at = th => add(mul(HIP[leg], s), mul(unit(add(add(z, mul(n, Math.tan(off * DEG))), mul(m, Math.tan(th * DEG)))), r * LEG * s));
	const name = leg ? "footR" : "footL", keys = [[0, "pose", { [name]: { joint: "Hips", at: at(-40), pitch }, over: 0 }]];
	for (let i = 1; i <= 20; i++) keys.push([4 * i, "pose", { [name]: { joint: "Hips", at: at(-40 + 4 * i), pitch }, over: 4, ease: "linear" }]);
	return keys;
}

/** A foot swung to a place given in the body frame, held there and set down again, then the other foot to the mirrored
 *  place: in front, behind, across, out to the side, over the hips, and up, back and out (toward one of the two
 *  directions). Scales 0.5, 1, 2. Each { tag, spec, def, s }. */
export function swingInputs() {
	const out = [], SPOTS = { front: [0.1, 0.9, 0.7], behind: [0.1, 0.5, -0.6], across: [-0.35, 0.5, 0.35], side: [0.75, 0.55, 0.05], over: [0.15, 1.5, 0.2], upBack: [0.55, 1.25, -0.3], upBackFar: [0.7, 1.1, -0.45] };
	for (const s of [0.5, 1, 2]) for (const [name, at] of Object.entries(SPOTS)) {
		const k = v => v.map(x => x * s);
		const a = [[5, "pose", { footL: { at: k(at), pitch: -30 }, over: 14 }], [34, "pose", { footL: { at: k([0.1, 0.2, 0.15]), pitch: 0 }, over: 14 }], [52, "pose", { footR: { at: k([-at[0], at[1], at[2]]), pitch: 30 }, over: 20 }], [80, "pose", { footR: { at: k([-0.1, 0.15, 0]), pitch: 0 }, over: 12 }]];
		out.push({ tag: `swing ${name} s${s}`, s, def: { frames: 96, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }], props: [] }, spec: { a } });
	}
	return out;
}

/** Every input: { tag, spec, def, s, two }. */
export function nearInputs() {
	const out = [];
	for (const s of [0.5, 1, 2]) for (const [pn, pre] of Object.entries(POSTURES)) for (const [zi, z] of ZEROS.entries()) for (const leg of [0, 1])
		for (const off of [0, 2, 5, 10, 20]) for (const [phiI, phi] of [0, 60, 120].entries()) for (const r of [0.6, 0.95]) {
			const pitch = [0, 60, -60][phiI], tag = `${pn} zero${zi} leg${leg} off${off} phi${phi} r${r} s${s}`;
			const chars = [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }];
			const spec = { a: [...pre(), ...pathKeys(leg, z, off, phi, r, s, pitch)] };
			out.push({ tag, s, two: false, def: { frames: 92, characters: chars, props: PROPS }, spec });
			if (off > 5 || r !== 0.95) continue;
			// a second figure beside it on the other leg past the other zero, at another size
			const s2 = s === 1 ? 2 : 1, b = [...(pn === "lie" ? lie2 : pre()), ...pathKeys(1 - leg, ZEROS[1 - zi], off, phi, r, s2, -pitch)];
			out.push({ tag: `${tag} +b`, s, two: true, def: { frames: 92, characters: [...chars, { id: "b", at: [2, 0], heading: 30, ...(s2 === 1 ? {} : { scale: s2 }) }], props: PROPS }, spec: { ...spec, b } });
		}
	return out;
}
