// The side a knee (and an elbow) bends to, measured from a clip's output with arithmetic of this file's own, and the
// inputs that sweep it: body states for the leg solver directly, paths of a foot target, and specs compiled whole.
//
// The allowed side, in the limb's own frame from the rig's rest pose: at rest a knee bends about the pelvis's left
// axis X (the shin goes back as the knee goes forward); an elbow about the chest axis rest-pole x rest-arm. That rest
// hinge is carried with the upper bone by the shortest turn from a reference direction of the bone to where the bone
// points in its parent's frame (pelvis for a thigh, chest for an upper arm), so it keeps the bone's own twist at zero.
// The twist is the angle between the limb's actual hinge (thigh x shin, or the thigh's own turned X while the leg is
// straight) and that carried hinge, about the bone. Over 90 degrees the joint bends to the side it cannot: the shin
// swings forward of the thigh, the knee points behind the leg. The reference direction of a thigh is 45 degrees forward
// of its rest direction, so the one direction where the carry is undefined points up and back (a hip extended past
// 135 degrees, which no hip reaches); an upper arm's is its rest direction (undefined pointing into the chest).
import { INDEX as J, OFFSET, PARENT, REST } from "../../src/lowvis/rig17.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.sqrt(dot(a, a));
const unit = a => mul(a, 1 / len(a));
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const qmul = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rot = (q, v) => { const t = mul(cross(q, v), 2); return add(add(v, mul(t, q[3])), cross(q, t)); }; // q = [x, y, z, w], unit
const axisAngle = (ax, deg) => { const h = deg * Math.PI / 360, s = Math.sin(h), u = unit(ax); return [u[0] * s, u[1] * s, u[2] * s, Math.cos(h)]; };
const DEG = 180 / Math.PI;
const angle = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b)) * DEG;
/** v turned by the shortest turn that takes unit a to unit b (Rodrigues); null where a and b nearly oppose. */
function carry(v, a, b) {
	const k = cross(a, b), c = dot(a, b);
	if (1 + c < 1e-9) return null;
	return add(add(mul(v, c), cross(k, v)), mul(k, dot(k, v) / (1 + c)));
}
const rotX = (v, deg) => { const a = deg / DEG, c = Math.cos(a), s = Math.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; };

export const LIMBS = [
	{ name: "knee L", parent: J.Hips, root: J.LeftUpLeg, mid: J.LeftLeg, end: J.LeftFoot },
	{ name: "knee R", parent: J.Hips, root: J.RightUpLeg, mid: J.RightLeg, end: J.RightFoot },
	{ name: "elbow L", parent: J.Spine2, root: J.LeftArm, mid: J.LeftForeArm, end: J.LeftHand },
	{ name: "elbow R", parent: J.Spine2, root: J.RightArm, mid: J.RightForeArm, end: J.RightHand },
].map(l => {
	const leg = l.name.startsWith("knee"), rest = unit(OFFSET[l.mid]);
	const hinge = leg ? [1, 0, 0] : unit(cross([0, 0, -1], rest)); // rest pole x rest bone, the bend's axis at rest
	return { ...l, leg, hinge, ref: leg ? unit(rotX(rest, -45)) : rest };
});
if (PARENT[J.LeftArm] !== J.Spine2 || PARENT[J.LeftUpLeg] !== J.Hips) throw new Error("rig parents changed");

/** One limb of one pose ({pos, quat} lists of 17): { twist (deg, 0..180; null where the carry is undefined), bend (deg
 *  between the two bones), mid, root, end } */
export function limbSide(pos, quat, L) {
	const inv = conj(quat[L.parent]), t = rot(inv, sub(pos[L.mid], pos[L.root])), s = rot(inv, sub(pos[L.end], pos[L.mid]));
	const bend = angle(t, s), tu = unit(t);
	let h = cross(t, s);
	if (len(h) < Math.sin(2 / DEG) * len(t) * len(s)) h = rot(qmul(inv, quat[L.root]), L.hinge); // nearly straight: the bone's own turned hinge
	const ref = carry(L.hinge, L.ref, tu); // the rest hinge is square to the reference direction (a turn about it from rest)
	if (!ref || angle(tu, mul(L.ref, -1)) < 5) return { twist: null, bend, root: pos[L.root], mid: pos[L.mid], end: pos[L.end] };
	const across = sub(h, mul(tu, dot(h, tu)));
	return { twist: angle(across, ref), bend, root: pos[L.root], mid: pos[L.mid], end: pos[L.end] };
}

/** The 17 joints of frame f of a clip character. */
export function frameOf(c, f) {
	const pos = [], quat = [];
	for (let j = 0; j < 17; j++) {
		const p = (f * 17 + j) * 3, q = (f * 17 + j) * 4;
		pos.push([c.pos[p], c.pos[p + 1], c.pos[p + 2]]); quat.push([c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3]]);
	}
	return { pos, quat };
}

// ---------------------------------------------------------------------------------------------- direct solver inputs
const fib = n => Array.from({ length: n }, (_, i) => { const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5)); return [r * Math.cos(a), y, r * Math.sin(a)]; });
/** Pelvis turns: upright, every quarter of pitch and roll, both lying postures, upside down, and seeded odd ones. */
function pelvisTurns() {
	const list = [[0, 0, 0, 1]];
	for (const p of [-135, -90, -45, 45, 90, 135, 180]) list.push(axisAngle([1, 0, 0], p));
	for (const r of [-90, 45, 90, 180]) list.push(axisAngle([0, 0, 1], r));
	list.push(qmul(axisAngle([0, 1, 0], 90), axisAngle([1, 0, 0], -90)), qmul(axisAngle([0, 1, 0], -30), axisAngle([0, 0, 1], 120)));
	let seed = 7;
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	for (let i = 0; i < 6; i++) list.push(axisAngle(unit([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), 360 * rnd()));
	return list;
}
const LEG = len(OFFSET[J.LeftLeg]) + len(OFFSET[J.LeftFoot]);
const HANGS = [[0.22, -0.13, 0.02], [-0.22, -0.13, 0.02]];
/** A body state (solve.js B) at scale s with pelvis turn q and each foot at a point and turn; feet free of the floor. */
function bodyState(q, feet, s = 1, floor = -1e9) {
	return { p: [0, 1 * s, 0], q, yaw: 0, lean: 0, twist: 0, feet: feet.map(f => ({ a: f.a, q: f.q, planted: false, floor })), hands: HANGS.map(h => mul(h, s)) };
}
const hipOf = (q, side, s) => add([0, 1 * s, 0], rot(q, mul(sub(REST[side ? J.RightUpLeg : J.LeftUpLeg], REST[J.Hips]), s)));
const footTurn = (yaw, pitch) => qmul(axisAngle([0, 1, 0], yaw), axisAngle([1, 0, 0], pitch));

/** Every direct input: pelvis turns x foot directions about the hip (in the pelvis frame) x distances (under, at and
 *  past the leg's reach) x foot pitch x scale. Each yields { B, s, tag }. */
export function* directInputs({ dirs = 96, scales = [0.5, 1, 2] } = {}) {
	const D = fib(dirs), R = [0.15, 0.4, 0.6, 0.8, 0.95, 1.05, 1.4], P = [-180, -135, -90, -45, 0, 45, 90, 135];
	const turns = pelvisTurns();
	for (const s of scales) for (const [qi, q] of turns.entries()) for (const [di, d] of D.entries()) for (const r of R) for (const pitch of P) {
		const feet = [0, 1].map(side => {
			const dd = side ? [-d[0], d[1], d[2]] : d;
			return { a: add(hipOf(q, side, s), rot(q, mul(dd, r * LEG * s))), q: footTurn(0, pitch) };
		});
		yield { B: bodyState(q, feet, s), s, tag: `q${qi} d${di} r${r} p${pitch} s${s}` };
	}
}

/** Paths of a foot target (pelvis frame) that move a little each step: circles about the hip through every axis, at
 *  several distances, with the foot pitch turning along. Each yields { at: u (0..1) => { B, s }, tag }. */
export function* directPaths() {
	const axes = fib(14), R = [0.3, 0.6, 0.9, 0.99, 1.2];
	for (const [qi, q] of pelvisTurns().slice(0, 12).entries()) for (const [ai, ax] of axes.entries()) for (const r of R) {
		const a0 = unit(cross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
		const at = u => {
			const turn = axisAngle(ax, 360 * u), pitch = 150 * Math.sin(2 * Math.PI * u);
			const feet = [0, 1].map(side => {
				const d = rot(turn, a0), dd = side ? [-d[0], d[1], d[2]] : d;
				return { a: add(hipOf(q, side, 1), rot(q, mul(dd, r * LEG))), q: footTurn(0, pitch) };
			});
			return { B: bodyState(q, feet, 1), s: 1 };
		};
		yield { at, tag: `q${qi} axis${ai} r${r}` };
	}
}

// ------------------------------------------------------------------------------------------------ specs, compiled whole
const PROPS = [{ id: "chair", size: [0.45, 0.45, 0.45], at: [0, 0.225, -0.55] }, { id: "mat", size: [0.9, 0.1, 2.0], at: [2.5, 0.05, 0] }];
const scene = (s, frames = 96) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }) }], props: PROPS });
/** Foot targets in the body frame (y over the floor): in front, above the hips, behind, across, out to the side, low,
 *  far out of reach. Times the scale. */
const SPOTS = { front: [0.1, 0.5, 0.6], high: [0.1, 1.2, 0.7], above: [0.1, 1.6, 0.05], behind: [0.1, 0.6, -0.6], across: [-0.4, 0.4, 0.3], side: [0.7, 0.6, 0], low: [0.1, 0.15, 0.3], far: [0.2, 2.6, 1.2] };
const POSTURES = { stand: [], kneel: [[0, "kneel", { over: 0 }]], sit: [[0, "sit", { on: "chair", over: 0 }]], lie: [[0, "lie", { on: "mat", head: 0, over: 0 }]], lieSide: [[0, "lie", { on: "mat", head: 90, over: 0 }]] };

/** Every spec input: { tag, spec, def }. */
export function specInputs() {
	const out = [], add1 = (tag, s, acts, frames) => out.push({ tag: `${tag} s${s}`, def: scene(s, frames), spec: { a: acts } });
	for (const s of [0.5, 1, 2]) {
		const k = v => v.map(x => x * s);
		add1("idle", s, [[0, "idle"]]);
		add1("walk", s, [[0, "walk", { to: k([0, 3]) }]]);
		add1("run", s, [[0, "run", { to: k([0, 5]) }]]);
		add1("push", s, [[0, "push", { to: k([0, 1.5]) }]]);
		add1("back", s, [[0, "walk", { to: k([0, -1.5]), facing: 0 }]]);
		add1("sidestep", s, [[0, "walk", { to: k([1.5, 0]), facing: 0 }]]);
		add1("lunge", s, [[0, "walk", { to: k([0, 0.7]), steps: 1 }]]);
		add1("turnwalk", s, [[0, "walk", { to: k([2, 2]), heading: 200 }]]);
		add1("kneel-stand", s, [[0, "kneel"], [40, "stand"]]);
		add1("sit-stand", s, [[0, "sit", { on: "chair" }], [50, "stand"]]);
		add1("kneel-lie", s, [[0, "kneel"], [30, "lie", { on: "mat", head: 0 }]]);
		for (const [pn, pre] of Object.entries(POSTURES)) for (const [sn, at] of Object.entries(SPOTS)) for (const pitch of [-90, 0, 60, 180]) {
			add1(`${pn} footL ${sn} pitch${pitch}`, s, [...pre, [10, "pose", { footL: { at: k(at), pitch }, over: 30 }], [60, "pose", { footR: { at: k([-at[0], at[1], at[2]]), pitch: -pitch }, over: 20 }]]);
		}
		// hand targets with no elbow target (for the elbow's side; the arms are not this change's)
		for (const [pn, pre] of [["stand", []], ["sit", POSTURES.sit], ["lie", POSTURES.lie]]) for (const at of [[0.2, 0.3, 0.5], [0.3, 0.9, 0.1], [0.2, 0.1, -0.4], [-0.3, 0.3, 0.3], [0.8, 0.4, 0], [0, -0.4, 0.2]]) {
			add1(`${pn} hands ${at}`, s, [...pre, [5, "pose", { L: k(at), R: k([-at[0], at[1], at[2]]), over: 20 }]]);
		}
		// the whole figure tilted by pitch and roll about each pivot, with both feet up above the hips and plain
		for (const [pn, pre] of [["stand", []], ["lie", POSTURES.lie]]) for (const tilt of [[90, 0], [180, 0], [-90, 0], [45, 30], [0, 90], [0, -90], [400, 0], [120, 200]]) for (const about of ["hips", "feet", k([0, 1, 0.5])]) {
			const feetUp = [[5, "pose", { footL: { at: k([0.1, 1.4, 0.2]), pitch: -60 }, footR: { at: k([-0.1, 1.3, 0.4]), pitch: 30 }, over: 25 }]];
			add1(`${pn} tilt ${tilt} about ${about} feet up`, s, [...pre, ...feetUp, [30, "pose", { tilt, about, over: 40 }]]);
			add1(`${pn} tilt ${tilt} about ${about}`, s, [...pre, [10, "pose", { tilt, about, over: 40 }]]);
		}
		// a foot target that moves on over time: around the hip from in front, over the top, to behind and across
		for (const [pn, pre] of Object.entries(POSTURES)) {
			const path = [[0.1, 0.4, 0.7], [0.1, 1.0, 0.7], [0.1, 1.5, 0.3], [0.1, 1.6, -0.2], [0.1, 1.0, -0.7], [-0.3, 0.5, -0.3], [-0.5, 0.6, 0.4], [0.6, 1.2, 0.3], [0.1, 0.3, 0.2]];
			add1(`${pn} moving foot`, s, [...pre, ...path.map((at, i) => [6 + 10 * i, "pose", { footL: { at: k(at), pitch: 90 * Math.sin(i) }, over: 10, ease: "linear" }])], 100);
		}
	}
	return out;
}
