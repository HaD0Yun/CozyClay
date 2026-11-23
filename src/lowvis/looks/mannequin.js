// The mannequin looks (`man`, `woman`): the jointed wooden figure of a drawing class as a grey-box blockout. Separate
// masses (egg head, neck post, ribcage block, abdomen, pelvis, thigh, shin, foot, shoulder cap, upper arm, forearm, hand), each
// a plain carved or turned piece, brushed over once, so only the edges that are meant stay crisp. The waist is filled:
// an abdomen block sits between ribcage and pelvis, tucked into both. A gap at every joint with a thin dark core through it, and a
// dark band at the elbow. One builder, two proportion tables (mannequin-shapes.js); the joints are the rig's.
//
// Every part is a loft (loft.js) in rest world space, so its mesh sits at the rest pose's world origin and
// follows its joint rigidly. The geometry is built once per table and shared by all figures; only the three
// materials are per figure, from its tint.
import * as THREE from "three";
import { TIPS } from "../rig17.js";
import { POINTS, loft, ribbon } from "./loft.js";
import { MAN, WOMAN } from "./mannequin-shapes.js";
import { DEFAULT_TINT, createJointRig, restOf } from "./parts.js";

const UP = [0, 1, 0], FRONT = [0, 0, 1], ORIGIN = [0, 0, 0];
const COLUMN = { origin: ORIGIN, axis: UP, side: [1, 0, 0], front: FRONT };
// The Studio's blockout grey (GREY_BOX in src/object-colors.js), copied here: src/lowvis imports no Studio module.
const GREY_BOX = "#c2c6c8";
const JOINT_GREY = "#45484b"; // cores and collar
// How far a grey leans toward the character's tint, so two characters in a clip differ. The dark grey takes half:
// the same share of a pale tint shows twice as strongly on a dark colour and turned it brown.
const LEAN = 0.12, JOINT_LEAN = 0.06;
const END_TONE = 0.8, LINE_TONE = 0.6; // brightness of a cut end face and of the engraved line, against the body
// A joint core is two dark pegs, one on each limb, that meet in the joint. A peg's sections, [t, radius] in peg radii:
// a half ball centred on the joint, then a straight run into its limb's end. Each peg turns with its own limb about
// the joint, so the pair stays one bent rod at any angle. REACH is how far a peg runs from the joint into the child
// limb and into the parent limb, in metres (the ankle has no child peg: the foot sits on the joint).
const PEG = [[-0.97, 0.26], [-0.84, 0.55], [-0.6, 0.8], [-0.3, 0.955], [0, 1]];
const REACH = { ForeArm: [0.042, 0.04], Hand: [0.036, 0.04], Leg: [0.036, 0.04], Foot: [0, 0.04] };
const PARENT = { ForeArm: "Arm", Hand: "ForeArm", Leg: "UpLeg", Foot: "Leg" };

/** The parts of a figure as [{ joint, dark, line, spec }]; `spec` is what loft() takes. */
function layoutParts(shape) {
	const list = [];
	const part = (joint, { rows, line, heel, ...options }, frame, dark = false) => list.push({ joint, dark, line, spec: { ...frame, rows, endTone: END_TONE, ...options } });
	part("Head", shape.head, COLUMN);
	for (const k of [1, -1]) part("Head", { ...shape.ear, rows: shape.ear.rows.map(([t, os, of, radii]) => [t, os * k, of, radii]) }, COLUMN);
	part("Neck", shape.neck, COLUMN);
	part("Spine2", shape.collar, COLUMN, true);
	part("Spine2", shape.ribcage, COLUMN);
	part("Spine", shape.abdomen, COLUMN);
	part("Hips", shape.pelvis, COLUMN);

	for (const side of ["Left", "Right"]) {
		const out = [side === "Left" ? 1 : -1, 0, 0], J = name => restOf(`${side}${name}`);
		const toward = (a, b) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const limb = (joint, target, def, sideways) => part(`${side}${joint}`, def, { origin: J(joint), axis: toward(J(joint), target), side: sideways, front: FRONT });
		limb("UpLeg", J("Leg"), shape.thigh, out);
		limb("Leg", J("Foot"), shape.shin, out);
		const ankle = J("Foot");
		part(`${side}Foot`, shape.foot, { origin: [ankle[0], 0, ankle[2] - shape.foot.heel], axis: FRONT, side: out, front: UP });
		limb("Arm", J("ForeArm"), shape.cap, UP);
		limb("Arm", J("ForeArm"), shape.upperArm, UP);
		limb("ForeArm", J("Hand"), shape.foreArm, UP);
		limb("Hand", TIPS[`${side}Hand`], shape.hand, UP);
		for (const [joint, r] of Object.entries(shape.cores)) {
			const arm = joint === "ForeArm" || joint === "Hand", child = joint === "Hand" ? TIPS[`${side}Hand`] : J(joint === "ForeArm" ? "Hand" : "Foot");
			const peg = reach => ({ rows: [...PEG, [reach / r, 1]].map(([t, k]) => [t * r, 0, 0, Array(POINTS).fill(k * r)]), start: "flat", end: "flat" });
			const frame = target => ({ origin: J(joint), axis: toward(J(joint), target), side: arm ? UP : out, front: FRONT });
			if (REACH[joint][0]) part(`${side}${joint}`, peg(REACH[joint][0]), frame(child), true);
			part(`${side}${PARENT[joint]}`, peg(REACH[joint][1]), frame(J(PARENT[joint])), true);
		}
	}
	return list;
}

/** The stretch of a line of { p, n, t } points between t0 and t1, its two ends interpolated. */
function between(points, t0, t1) {
	const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k), out = [];
	const at = (a, b, t) => { const k = (t - a.t) / (b.t - a.t); return { p: mix(a.p, b.p, k), n: mix(a.n, b.n, k), t }; };
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i], b = points[i + 1];
		if (b.t <= t0 || a.t >= t1) continue;
		if (!out.length) out.push(a.t < t0 ? at(a, b, t0) : a);
		out.push(b.t > t1 ? at(a, b, t1) : b);
	}
	return out;
}

const built = new Map(); // proportion table -> [{ joint, dark, geometry, line }]
function geometries(shape) {
	if (built.has(shape)) return built.get(shape);
	const out = layoutParts(shape).map(({ joint, dark, line, spec }) => {
		const geometry = loft(spec);
		// The engraved centre line of the torso: a thin darker strip on the front of the ribcage, abdomen and pelvis.
		const strip = line && ribbon(between(geometry.userData.front, line[0], line[1]), 0.004, 0.0006, LINE_TONE);
		return { joint, dark, geometry, line: strip };
	});
	built.set(shape, out);
	return out;
}

function mannequin(shape, { tint = DEFAULT_TINT } = {}) {
	const rig = createJointRig(), lean = new THREE.Color(tint);
	// Matte and plain: the geometry carries its brushed normals and a grey vertex colour for the cut ends.
	const matte = (base, k) => new THREE.MeshStandardMaterial({ color: new THREE.Color(base).lerp(lean, k), vertexColors: true, roughness: 0.7, metalness: 0 });
	const body = matte(GREY_BOX, LEAN), dark = matte(JOINT_GREY, JOINT_LEAN);
	// The engraved line is a strip in the body colour, darkened by its vertex colour and drawn just over the surface.
	const engraved = new THREE.MeshStandardMaterial({ color: body.color, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
	for (const { joint, dark: isDark, geometry, line } of geometries(shape)) {
		rig.attach(joint, new THREE.Mesh(geometry, isDark ? dark : body), ORIGIN);
		if (line) rig.attach(joint, new THREE.Mesh(line, engraved), ORIGIN).castShadow = false;
	}
	return { object3D: rig.object3D, setPose: rig.setPose };
}

export const man = options => mannequin(MAN, options);
export const woman = options => mannequin(WOMAN, options);
