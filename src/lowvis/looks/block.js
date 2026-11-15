// The block look: a figure of plain primitives, as in a drawing-class blockout. Boxes for the head, the chest, the
// pelvis and the hands; tapered boxes for the arms, the thighs, the lower legs and the feet; a plain box at the
// shoulder, elbow, wrist, knee and ankle. Flat grey, a thin dark line on every edge and down the front of the torso.
//
// No part floats. Where two boxes meet there is a narrow gap with a dark core in it: a dowel between chest and pelvis,
// a ball on the hip joint between pelvis and thigh. At a joint box, the piece before it runs CUP into it and the piece
// after it starts GAP clear of it. A joint box is a little thinner than the limb ends, so it reads as the joint.
//
// Every part is built in rest world space (metres, T-pose, facing +Z), so its mesh sits at the rest pose's world
// origin and follows its joint rigidly.
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { MAN } from "./block-shapes.js";
import { DEFAULT_TINT, createJointRig, restOf, span } from "./parts.js";

// The Studio's blockout grey (GREY_BOX in src/object-colors.js), copied here: src/lowvis imports no Studio module.
const GREY_BOX = "#c2c6c8";
const DOWEL_GREY = "#45484b", LINE_GREY = "#4b4e51";
const LEAN = 0.12, DOWEL_LEAN = 0.06; // how far a grey leans toward the character's tint, so two characters differ
const EDGE_ANGLE = 12; // degrees: an edge sharper than this gets a line (a box's edges, the crease across the chest)
const CUP = 0.01, GAP = 0.006; // metres, see above
const ORIGIN = [0, 0, 0], UP = [0, 1, 0], OUT = [1, 0, 0];
const V = a => new THREE.Vector3().fromArray(a);

/**
 * A stack of rectangles joined by flat walls: `rings` is [[centre, [w, d]], ...]. `side` is the direction of the
 * widths; the depths run across it. The rectangles are square to `axis` (default: the line from the first centre to
 * the last). userData.front is the middle line of the walls on the depth's + side, as pairs of points.
 */
function loftBox(rings, side = OUT, axis = null) {
	const a = (axis ? V(axis) : V(rings.at(-1)[0]).sub(V(rings[0][0]))).normalize();
	const s = V(side).addScaledVector(a, -V(side).dot(a)).normalize(), f = new THREE.Vector3().crossVectors(s, a);
	const corners = rings.map(([c, [w, d]]) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => V(c).addScaledVector(s, (i * w) / 2).addScaledVector(f, (j * d) / 2)));
	const position = [];
	/** One flat face p q r t, turned so that it faces away from `inside`. */
	const quad = (p, q, r, t, inside) => {
		const n = new THREE.Vector3().crossVectors(q.clone().sub(p), r.clone().sub(p));
		const outward = n.dot(p.clone().add(r).multiplyScalar(0.5).sub(inside)) >= 0;
		for (const v of outward ? [p, q, r, p, r, t] : [p, r, q, p, t, r]) position.push(...v.toArray());
	};
	for (let i = 0; i + 1 < rings.length; i++) {
		const inside = V(rings[i][0]).add(V(rings[i + 1][0])).multiplyScalar(0.5);
		for (let k = 0; k < 4; k++) quad(corners[i][k], corners[i][(k + 1) % 4], corners[i + 1][(k + 1) % 4], corners[i + 1][k], inside);
	}
	quad(...corners[0], V(rings[1][0]));
	quad(...corners.at(-1), V(rings.at(-2)[0]));
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
	geometry.computeVertexNormals(); // not indexed, so every face is flat
	const front = ([c, [, d]]) => V(c).addScaledVector(f, d / 2 + 0.001);
	geometry.userData.front = rings.slice(1).flatMap((ring, i) => [front(rings[i]), front(ring)]);
	return geometry;
}

/** A box that may taper: a rectangle `a` = [w, d] around `from` and one `b` around `to`. */
const taperBox = (from, to, a, b = a, side = OUT, axis = null) => loftBox([[from, a], [to, b]], side, axis);

/** A cylinder from `from` to `to`, radius r0 at the start and r1 at the end. */
function rod(from, to, r0, r1 = r0) {
	const s = span(from, to);
	return new THREE.CylinderGeometry(r1, r0, s.length, 24).applyQuaternion(s.quaternion).translate(...s.centre);
}

const ball = (centre, r) => new THREE.SphereGeometry(r, 24, 16).translate(...centre);

/** A plain box around `centre`, [x, y, z] in size, square to the world axes (the T-pose arm runs along x). */
const cube = (centre, size) => new THREE.BoxGeometry(...size).translate(...centre);

/** The convex hull of `points` ([x, y, z] arrays): flat faces, one normal each. */
const hull = points => new ConvexGeometry(points.map(V));

const PALM = 0.019, KNUCKLE = 0.1, BREADTH = 0.043; // the hand: half the palm's thickness, wrist to knuckles, half breadth

/**
 * The half-closed hand: a palm block; the four fingers as one block bent 55 degrees toward the palm at the knuckles
 * (the two blocks share the knuckle face, cut on the bisector, so the bend has no gap); a thumb along the palm's front
 * edge. `at(u, t, z)` places a point of the hand, `start` is where it leaves the wrist box.
 */
function mitten(at, start) {
	const curl = (55 * Math.PI) / 180, fingers = 0.06;
	/** The four corners of a section at (u, t): half thickness `h` along the direction (du, dt), half breadth `b`. */
	const section = (u, t, du, dt, h, b) => [-1, 1].flatMap(i => [-1, 1].map(j => at(u + i * h * du, t + i * h * dt, j * b)));
	const knuckle = section(KNUCKLE, 0, Math.sin(curl / 2), Math.cos(curl / 2), PALM / Math.cos(curl / 2), BREADTH - 0.001);
	return [
		hull([...section(start, 0, 0, 1, PALM, BREADTH), ...knuckle]),
		hull([...knuckle, ...section(KNUCKLE + fingers * Math.cos(curl), -fingers * Math.sin(curl), Math.sin(curl), Math.cos(curl), 0.014, 0.036)]),
		taperBox(at(0.045, -0.006, 0.036), at(0.095, -0.022, 0.042), [0.024, 0.024], [0.019, 0.02], UP),
	];
}

/**
 * The fist: one block whose side view is the closed hand (the flat back of the hand, the knuckles as its front top
 * corner, the curled fingers filling the palm side, a cut where the finger tips tuck in), and the thumb laid across
 * the curled fingers from the front edge.
 */
function fist(at, start) {
	const side = [[start, PALM], [KNUCKLE, PALM + 0.003], [KNUCKLE + 0.008, 0.004], [KNUCKLE + 0.004, -0.034], [0.084, -0.052], [0.048, -0.05], [start + 0.008, -0.026], [start, -PALM]];
	return [
		hull(side.flatMap(([u, t]) => [at(u, t, BREADTH), at(u, t, -BREADTH)])),
		taperBox(at(0.062, -0.028, 0.046), at(0.094, -0.05, 0.006), [0.022, 0.024], [0.018, 0.02], UP),
	];
}

/** The parts of the figure with proportions `S` (block-shapes.js) as { joint, geometry, line, marks, dark, hand }:
 * `line` asks for the centre line on the part's front, `marks` are pairs of points to join with a line, `dark` is a
 * core, `hand` is [side, "open" | "fist"] for a hand shape. */
function layoutParts(S) {
	const parts = [], add = (joint, geometry, options = {}) => parts.push({ joint, geometry, ...options });
	// Torso, top down: the chest is the long box and the pelvis the short one.
	// The head tells where it faces by its form: the face is the narrower end, and the chin is lower than the back of
	// the skull, so the jaw line slopes in the side view. Two cuts round it a little: the jaw narrows from the cheeks to
	// the chin, and the top of the back of the skull is cut off. The sides narrow only a little toward the face, so the
	// head does not grow much toward the back of the skull. On the face, the cross of a drawing class: a centre line and
	// an eye line. The head sits under the rig's head, for a short neck.
	const { back, face, chin, top: FULL_TOP, low: LOW, front: FACE_Z, rear: BACK_Z } = S.head;
	const at = k => LOW + (FULL_TOP - LOW) * (k / 0.215); // a height on the head, k metres above the chin on a 0.215 m head
	const TOP = FULL_TOP - (S.head.crown ?? 0); // `crown` (optional) shortens the head from the top alone
	const CROSS_Z = FACE_Z + 0.001, BACK_CUT = (S.head.backCut ?? 0.16) * (FACE_Z - BACK_Z);
	const half = b => back - ((back - face) / (FACE_Z - BACK_Z)) * b; // the head's half width b metres in front of the back
	// Optional cuts: `brow` off the top edge of the face (the forehead slopes back), `nape` off the lower edge of the back
	// (the skull tucks in toward the neck).
	// `temple` (optional) cuts the two top side edges along the whole head at 45 degrees, for a rounder head.
	const brow = S.head.brow ?? 0, nape = S.head.nape ?? 0, temple = S.head.temple ?? 0, base = at(0.055);
	/** A point on the top edge of the head, x its half width there: with a temple cut, the two ends of the cut. */
	const top = (x, z) => (temple ? [[x - temple, TOP, z], [x, TOP - temple, z]] : [[x, TOP, z]]);
	add("Head", hull([1, -1].flatMap(i => [
		...(brow ? [[i * face, TOP - brow, FACE_Z], ...top(half(FACE_Z - BACK_Z - brow), FACE_Z - brow).map(([x, y, z]) => [i * x, y, z])] : top(face, FACE_Z).map(([x, y, z]) => [i * x, y, z])),
		[i * face, at(S.head.cheek ?? 0.08), FACE_Z], [i * chin, LOW, FACE_Z], // the face: cheeks, then the jaw to the chin
		...top(half(BACK_CUT), BACK_Z + BACK_CUT).map(([x, y, z]) => [i * x, y, z]), [i * back, TOP - BACK_CUT, BACK_Z], // the back, its top edge cut
		...(nape ? [[i * back, base + nape, BACK_Z], [i * half(nape), base, BACK_Z + nape]] : [[i * back, base, BACK_Z]]),
	])), {
		marks: [[0, LOW, CROSS_Z], [0, TOP - brow, CROSS_Z], [-face, at(0.125), CROSS_Z], [face, at(0.125), CROSS_Z]],
	});
	// The neck starts just inside the chest's top and ends inside the head.
	add("Neck", taperBox([0, S.chest.at(-1)[0] - 0.005, -0.03], [0, 1.61, -0.02], ...S.neck));
	if (!S.bust) add("Spine2", loftBox(S.chest.map(([y, z, w, d]) => [[0, y, z], [w, d]]), OUT, UP), { line: true });
	else {
		// With a bust the chest is one hull, so the bust is made of the chest's own planes, not a part added to it: the
		// corners of the chest's rings and level strips across the whole front (from side to side, each at a height y and
		// a depth z), which push the front out. From the side the front comes forward quickly under the collar, runs
		// nearly straight down over the bust and turns back under it to the ribs; seen from the front the chest keeps its
		// straight sides. The centre line runs over the strips.
		const strips = [...S.bust].sort((a, b) => b[0] - a[0]), first = S.chest[0], last = S.chest.at(-1);
		/** Half the chest's width at height y, from its rings, a few millimetres in so a strip stays inside the sides. */
		const halfWidth = y => {
			const i = Math.max(0, S.chest.findIndex(([ry]) => ry >= y) - 1), [ya, , wa] = S.chest[i], [yb, , wb] = S.chest[i + 1];
			return (wa + ((wb - wa) * (y - ya)) / (yb - ya)) / 2 - 0.004;
		};
		const corners = S.chest.flatMap(([y, cz, w, d]) => [-1, 1].flatMap(i => [-1, 1].map(j => [(i * w) / 2, y, cz + (j * d) / 2])));
		const ridge = strips.flatMap(([y, z]) => [[-halfWidth(y), y, z], [halfWidth(y), y, z]]);
		const front = ([y, cz, , d]) => [0, y, cz + d / 2 + 0.001];
		const path = [front(last), ...strips.map(([y, z]) => [0, y, z + 0.001]), front(first)];
		const line = path.slice(1).flatMap((p, i) => [path[i], p]);
		add("Spine2", hull([...corners, ...ridge]), { marks: line });
	}
	// The waist dowel runs from inside the pelvis to 2 cm inside the chest (at least to 1.22).
	add("Spine", rod([0, 1.1, 0.008], [0, Math.max(1.22, S.chest[0][0] + 0.02), -0.006], S.waist), { dark: true });
	// The pelvis answers the chest with a taper of its own: narrow at the waist, wide at the hips. It is short, so a band
	// of the dark waist dowel shows above it and of the dark hip balls below it.
	if (!S.pelvis.briefs) add("Hips", taperBox([0, S.pelvis.from, 0], [0, S.pelvis.to, 0.006], S.pelvis.low, S.pelvis.high), { line: true });
	else {
		// The briefs: one hull through four levels, each a rectangle [y, width, depth]: the waist, the hips (widest), the
		// leg line at the sides and the crotch. As the crotch is lower and narrower than the leg line, the leg openings
		// are cut on the diagonal, and the thighs, which start inside, carry on the line of the hips.
		const levels = S.pelvis.briefs, z = 0.004;
		const points = levels.flatMap(([y, w, d]) => [-1, 1].flatMap(i => [-1, 1].map(j => [(i * w) / 2, y, z + (j * d) / 2])));
		const [top, , , crotch] = levels, front = ([y, , d]) => [0, y, z + d / 2 + 0.001];
		add("Hips", hull(points), { marks: [front(crotch), front(levels[2]), front(levels[2]), front(levels[1]), front(levels[1]), front(top)] });
	}
	for (const side of ["Left", "Right"]) {
		const k = side === "Left" ? 1 : -1, J = name => restOf(`${side}${name}`), put = (joint, ...rest) => add(`${side}${joint}`, ...rest);
		const along = (p, d) => [p[0] + k * d, p[1], p[2]]; // d metres further out along the T-pose arm
		const down = (p, d) => [p[0], p[1] - d, p[2]]; // d metres down the standing leg
		const shoulder = along(J("Arm"), S.shoulder.out), elbow = J("ForeArm"), wrist = J("Hand"), hip = J("UpLeg"), knee = J("Leg"), ankle = J("Foot");
		// Half the length of a joint box along its limb.
		const H = { elbow: S.elbow[0] / 2, wrist: S.wrist[0] / 2, knee: S.knee[1] / 2, ankle: S.ankle[1] / 2 };
		// The shoulder is a plain box that belongs to the chest: it stays at the chest's upper corner whatever the arm
		// does, so the shoulders stay wide. The rig's joint is inside it: the arm starts there.
		add("Spine2", cube(shoulder, [S.shoulder.size, S.shoulder.size, S.shoulder.size]));
		// The arm is angular like the leg: two tapered boxes, thick at the body end. It leaves the shoulder box as a short
		// wedge that widens from the joint. Its top is set armLift (3 cm on the man) up in the T-pose, which is outward
		// once the arm hangs: under the shoulder box and clear of the chest's side. It tapers back to the elbow, which
		// stays on the rig's joint.
		const lift = S.armLift ?? 0.03, armAxis = [k, 0, 0], [armRoot, armFull, armLow] = S.upperArm;
		const armTop = down(along(J("Arm"), 0.065), -lift);
		put("Arm", taperBox(down(J("Arm"), -0.4 * lift), armTop, armRoot, armFull, UP, armAxis));
		put("Arm", taperBox(armTop, along(elbow, CUP - H.elbow), armFull, armLow, UP, armAxis));
		// The elbow box is square in the plane the elbow bends in, so it fits both arm pieces at a right angle too. It is
		// a little thinner than the arm ends, so it reads as the joint between them.
		put("ForeArm", cube(elbow, [S.elbow[0], S.elbow[1], S.elbow[0]]));
		put("ForeArm", taperBox(along(elbow, H.elbow + GAP), along(wrist, CUP - H.wrist), ...S.foreArm, UP));
		put("Hand", cube(wrist, S.wrist));
		// The hand has two shapes, both mittens, and setPose shows one: a half-closed hand, which reads as relaxed when
		// it hangs and is the default, and a fist for a hand that holds something. In the T-pose the hand runs along u,
		// its back faces up (+t) and the thumb side is the front (+z).
		const at = (u, t, z = 0) => [wrist[0] + k * u * S.hand, wrist[1] + t * S.hand, wrist[2] + z * S.hand];
		for (const g of mitten(at, (H.wrist + GAP) / S.hand)) put("Hand", g, { hand: [side, "open"] });
		for (const g of fist(at, (H.wrist + GAP) / S.hand)) put("Hand", g, { hand: [side, "fist"] });
		// The hip core is a ball on the joint, not a dowel: it looks the same however the thigh turns.
		put("UpLeg", ball(hip, S.hip), { dark: true });
		put("UpLeg", taperBox([hip[0] + k * (S.thighOut ?? 0), S.thighTop ?? 0.95, hip[2]], down(knee, CUP - H.knee), ...S.thigh));
		// The knee box is square in the plane the knee bends in, like the elbow's.
		put("Leg", cube(knee, [S.knee[0], S.knee[1], S.knee[1]]));
		// The ankle box stands 1.2 cm over the joint, so a band of it shows between the shin and the foot.
		const ankleBox = down(ankle, -0.012);
		put("Leg", taperBox(down(knee, H.knee + GAP), down(ankleBox, CUP - H.ankle), ...S.shin));
		put("Foot", cube(ankleBox, S.ankle));
		// A wedge on the floor from behind the ankle to the toe tip: high at the heel, low at the toe.
		put("Foot", taperBox([ankle[0], 0.045, ankle[2] - 0.06], [ankle[0], 0.0175, S.foot.toe], S.foot.heel, S.foot.tip));
	}
	return parts;
}

function blockFigure(shape, { tint = DEFAULT_TINT } = {}) {
	const rig = createJointRig(), lean = new THREE.Color(tint);
	// The faces sit a little behind their edge lines in depth, so the lines do not flicker.
	const matte = (base, share) => new THREE.MeshStandardMaterial({ color: new THREE.Color(base).lerp(lean, share), roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const body = matte(GREY_BOX, LEAN), dowel = matte(DOWEL_GREY, DOWEL_LEAN), ink = new THREE.LineBasicMaterial({ color: LINE_GREY });
	const draw = (joint, geometry) => { const lines = rig.attach(joint, new THREE.LineSegments(geometry, ink), ORIGIN); lines.castShadow = false; return lines; };
	const hands = { Left: { open: [], fist: [] }, Right: { open: [], fist: [] } };
	for (const { joint, geometry, line, marks, dark, hand } of layoutParts(shape)) {
		const objects = [rig.attach(joint, new THREE.Mesh(geometry, dark ? dowel : body), ORIGIN)];
		if (!dark && geometry.type !== "SphereGeometry") objects.push(draw(joint, new THREE.EdgesGeometry(geometry, EDGE_ANGLE)));
		if (line) objects.push(draw(joint, new THREE.BufferGeometry().setFromPoints(geometry.userData.front)));
		if (marks) objects.push(draw(joint, new THREE.BufferGeometry().setFromPoints(marks.map(V))));
		if (hand) hands[hand[0]][hand[1]].push(...objects);
	}
	/** `grip` ({ Left, Right }, optional, from src/lowvis/grip.js) shows a fist on each hand that holds something. */
	function setPose(pos, quat, frame, grip) {
		rig.setPose(pos, quat, frame);
		for (const side of ["Left", "Right"]) {
			const closed = Boolean(grip?.[side]);
			for (const o of hands[side].open) o.visible = !closed;
			for (const o of hands[side].fist) o.visible = closed;
		}
	}
	return { object3D: rig.object3D, setPose };
}

export const block = options => blockFigure(MAN, options);
