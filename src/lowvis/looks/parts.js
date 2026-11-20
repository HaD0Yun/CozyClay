// Shared pieces of the three looks: the 17 joint groups a look hangs its parts on, the clay material, and the
// body-part table (metres, rest pose) that the box and capsule looks both draw.
//
// A clip joint's quaternion is its world rotation from rest, so a mesh built at its rest place and parented to a
// group at the joint follows the joint rigidly: group.position = pos[j], group.quaternion = quat[j].
import * as THREE from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import { INDEX, JOINT_COUNT, REST, TIPS } from "../rig17.js";

export const DEFAULT_TINT = "#c9b7a4";

/** The Studio's clay values (src/proxy-figure.jsx). */
export function clayMaterial(color) {
	return new THREE.MeshStandardMaterial({ color, roughness: 0.66, metalness: 0, envMapIntensity: 0.35 });
}

/** A darker shade of the tint, for joints, the face and the toe caps. */
export function accentColor(tint, k = 0.42) {
	return new THREE.Color(tint).multiplyScalar(k);
}

/** 17 groups, one per joint, at rest. `setPose` moves them to frame `frame` of a clip character's arrays. */
export function createJointRig() {
	const object3D = new THREE.Group();
	const joints = [];
	for (let j = 0; j < JOINT_COUNT; j++) {
		const g = new THREE.Group();
		g.position.fromArray(REST[j]);
		object3D.add(g);
		joints.push(g);
	}
	function setPose(pos, quat, frame = 0) {
		const p = frame * JOINT_COUNT * 3, q = frame * JOINT_COUNT * 4;
		for (let j = 0; j < JOINT_COUNT; j++) {
			joints[j].position.set(pos[p + j * 3], pos[p + j * 3 + 1], pos[p + j * 3 + 2]);
			joints[j].quaternion.set(quat[q + j * 4], quat[q + j * 4 + 1], quat[q + j * 4 + 2], quat[q + j * 4 + 3]);
		}
	}
	/** Parents `mesh` to joint `name`, with `centre` (and the mesh's own rotation) given in rest world space. */
	function attach(name, mesh, centre) {
		const j = INDEX[name];
		mesh.position.set(centre[0] - REST[j][0], centre[1] - REST[j][1], centre[2] - REST[j][2]);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		joints[j].add(mesh);
		return mesh;
	}
	return { object3D, joints, setPose, attach };
}

/** The solids of a look as drawn, for a measure that has no three.js scene: per part ({ joint, geometry }, built in rest
 *  world space) that is not on a hand, the convex solid around its vertices (every part is convex but a lofted chest,
 *  which it encloses), as { joint (rig index), v: its corners from the joint at rest, t: its triangles (corner indices),
 *  n: its face normals, e: its edges [corner, corner, normal of one face, normal of the other], c and h: the centre and
 *  half sizes of the box around it square to the rest axes } (metres, a body of scale 1). */
export function solidsOf(parts) {
	const key = a => a.map(x => x.toFixed(6)).join();
	return parts.filter(p => !/Hand$/.test(p.joint)).map(({ joint, geometry }) => {
		const j = INDEX[joint], a = geometry.attributes.position.array, pts = [];
		for (let i = 0; i < a.length; i += 3) pts.push(new THREE.Vector3(a[i] - REST[j][0], a[i + 1] - REST[j][1], a[i + 2] - REST[j][2]));
		const hull = new ConvexHull().setFromPoints(pts), at = new Map(), v = [], t = [], n = new Map(), e = new Map();
		const corner = p => { const k = key(p.toArray()); if (!at.has(k)) { at.set(k, v.length); v.push(p.toArray()); } return at.get(k); };
		for (const face of hull.faces) {
			const normal = face.normal.toArray(), tri = [];
			n.set(key(normal), normal);
			let h = face.edge;
			do {
				const [p, q] = [corner(h.tail().point), corner(h.head().point)].sort((x, y) => x - y);
				tri.push(corner(h.head().point));
				e.set(`${p},${q}`, [p, q, normal, h.twin.face.normal.toArray()]);
				h = h.next;
			} while (h !== face.edge);
			t.push(tri);
		}
		const lo = [0, 1, 2].map(k => Math.min(...v.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...v.map(p => p[k])));
		return { joint: j, v, t, n: [...n.values()], e: [...e.values()], c: lo.map((x, k) => (x + hi[k]) / 2), h: lo.map((x, k) => (hi[k] - x) / 2) };
	});
}

const J = name => REST[INDEX[name]];
const Y = new THREE.Vector3(0, 1, 0);

/** Midpoint, length and the rotation that turns +Y onto a -> b. */
export function span(a, b) {
	const va = new THREE.Vector3().fromArray(a), vb = new THREE.Vector3().fromArray(b);
	const dir = vb.clone().sub(va);
	const length = dir.length();
	return {
		centre: va.clone().add(vb).multiplyScalar(0.5).toArray(),
		length,
		quaternion: new THREE.Quaternion().setFromUnitVectors(Y, dir.normalize()),
	};
}

// Limbs run from joint to joint. `w` is the thickness across the limb's local X after +Y is turned onto the limb,
// `d` across local Z. For the arms (along world X) local X is world Y, so a hand is thin in `w`.
// Legs are listed bottom-up so the turn from +Y is small and `w` stays the left-right width.
function limbs(side) {
	const s = side === "Left" ? 1 : -1;
	const ankle = J(`${side}Foot`);
	return [
		{ id: `${side}UpperArm`, joint: `${side}Arm`, from: J(`${side}Arm`), to: J(`${side}ForeArm`), w: 0.09, d: 0.095 },
		{ id: `${side}ForeArm`, joint: `${side}ForeArm`, from: J(`${side}ForeArm`), to: J(`${side}Hand`), w: 0.078, d: 0.082 },
		{ id: `${side}Hand`, joint: `${side}Hand`, from: J(`${side}Hand`), to: TIPS[`${side}Hand`], w: 0.04, d: 0.095, hand: true },
		{ id: `${side}Thigh`, joint: `${side}UpLeg`, from: J(`${side}Leg`), to: J(`${side}UpLeg`), w: 0.13, d: 0.135 },
		{ id: `${side}Shin`, joint: `${side}Leg`, from: [ankle[0], ankle[1] - 0.012, ankle[2]], to: J(`${side}Leg`), w: 0.1, d: 0.105 },
		// The foot is a block on the floor from behind the ankle to the toe tip.
		{ id: `${side}Foot`, joint: `${side}Foot`, foot: true, centre: [s * Math.abs(ankle[0]), 0.04, (TIPS[`${side}Foot`][2] + ankle[2] - 0.06) / 2], size: [0.1, 0.08, TIPS[`${side}Foot`][2] - ankle[2] + 0.06] },
	];
}

/** Axis-aligned torso and head blocks: centre and size in rest world space. */
const TORSO = [
	{ id: "Pelvis", joint: "Hips", centre: [0, 1.045, 0.005], size: [0.3, 0.185, 0.19] },
	{ id: "Belly", joint: "Spine", centre: [0, 1.238, 0], size: [0.245, 0.17, 0.16] },
	{ id: "Chest", joint: "Spine2", centre: [0, 1.42, -0.025], size: [0.31, 0.165, 0.2] },
	{ id: "Neck", joint: "Neck", centre: [0, 1.548, -0.025], size: [0.085, 0.075, 0.085] },
	{ id: "Head", joint: "Head", centre: [0, 1.7, 0.005], size: [0.175, 0.235, 0.2], head: true },
];

export const PARTS = Object.freeze([...TORSO, ...limbs("Left"), ...limbs("Right")]);

/** Joints drawn as a dark knuckle between two segments: [joint, size]. */
export const KNUCKLES = Object.freeze(["Left", "Right"].flatMap(side => [
	[`${side}Arm`, 0.075], [`${side}ForeArm`, 0.065], [`${side}Hand`, 0.055],
	[`${side}UpLeg`, 0.105], [`${side}Leg`, 0.085], [`${side}Foot`, 0.07],
]));

export { J as restOf };
