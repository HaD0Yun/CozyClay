// Per-character facts the poser needs before it can read or write a rig.
// Character data is plain: `{ bones: [{ name, parent (index, name or null), head: [x,y,z], rest: 3x3 rows }],
// scale, frame?: 3x3 rows, floorHeight? }` in armature space; `jointToBone` maps the 30 joint names to bone names.
import { cross, dot, fromRows, identity, mul, mulTVec, mulVec, norm, shortestArc, sub } from "./mat3.js";
import { measuredLengths, networkLengths } from "./rig-lengths.js";
import { restLayout } from "./skeleton.js";

const TRUNK = new Set([0, 1, 2, 3, 4, 5]);
const NO_PRIMARY_CHILD = new Set([6, 13, 19]); // head, hand_l, hand_r
const OWN_FOOT_REST = new Set([24, 25, 28, 29]);
const MARKERS = new Set([14, 15, 20, 21]);
const SPAN_GROUPS = [[1, 2, 3, 4, 5, 6], [10, 11], [16, 17]];
const DEG = Math.PI / 180;

/** Normalised bones with parent indices, children and flat rest rotations. */
function parseBones(character) {
	const index = new Map(character.bones.map((b, i) => [b.name, i]));
	const bones = character.bones.map((b) => ({
		name: b.name,
		parent: typeof b.parent === "number" ? (b.parent >= 0 ? b.parent : -1) : b.parent == null ? -1 : index.get(b.parent) ?? -1,
		head: [...b.head],
		rest: b.rest.length === 9 ? Float64Array.from(b.rest) : fromRows(b.rest),
		children: [],
	}));
	bones.forEach((b, i) => { if (b.parent >= 0) bones[b.parent].children.push(i); });
	return { bones, index };
}

/**
 * Frame guess for a rig that does not state one: try each axis-aligned up and keep the one under which the head is
 * highest and the feet lowest, then spin about that up until the character's left points along +X.
 */
function autoFrame(head) {
	const ups = [[1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0, -1, 0, 0, 0, -1], [1, 0, 0, 0, 0, 1, 0, -1, 0], [1, 0, 0, 0, 0, -1, 0, 1, 0], [0, 1, 0, -1, 0, 0, 0, 0, 1], [0, -1, 0, 1, 0, 0, 0, 0, 1]];
	const y = (R, j) => (head(j) ? mulVec([0, 0, 0], 0, R, 0, head(j), 0)[1] : NaN);
	const R = Float64Array.from(ups.find((u) => y(u, 6) > y(u, 3) && y(u, 3) > y(u, 0) && y(u, 0) > Math.max(y(u, 24), y(u, 28))) ?? ups[0]);
	const pair = head(11) && head(17) ? [11, 17] : [22, 26];
	const lr = mulVec([0, 0, 0], 0, R, 0, sub(head(pair[0]), head(pair[1])), 0), yaw = Math.atan2(lr[2], lr[0]);
	if (Math.abs(yaw) <= DEG) return R;
	const c = Math.cos(yaw), s = Math.sin(yaw);
	return mul(new Float64Array(9), 0, Float64Array.of(c, 0, s, 0, 1, 0, -s, 0, c), 0, R, 0);
}

/** Everything the poser derives from the character's rest pose; computed once, reused by every solve. */
export function prepareCharacter(sk, character, jointToBone) {
	const { bones, index } = parseBones(character);
	const boneOf = sk.names.map((name) => (jointToBone[name] != null && index.has(jointToBone[name]) ? index.get(jointToBone[name]) : -1));
	const head = (j) => (boneOf[j] >= 0 ? bones[boneOf[j]].head : null);
	// frame and scale
	const R = character.frame ? fromRows(character.frame) : autoFrame(head);
	// the caller's scale is kept as given; a body of unusual size is handled by `size` below, not by guessing units
	const s = character.scale ?? 1;
	const toSkeleton = (v) => mulVec([0, 0, 0], 0, R, 0, v, 0).map((x) => x * s); // A v
	const nv = (j) => [sk.restJoints[3 * j], sk.restJoints[3 * j + 1], sk.restJoints[3 * j + 2]];
	// how far each rig bone's rest direction is from the skeleton's
	const C = new Float64Array(9 * 30), Cp = new Float64Array(9 * 30), angleOf = new Float64Array(30);
	for (let j = 0; j < 30; j += 1) {
		const q = sk.parents[j], c = NO_PRIMARY_CHILD.has(j) ? -1 : sk.children[j][0] ?? -1;
		const inherit = () => (q < 0 ? identity(C, 9 * j) : C.copyWithin(9 * j, 9 * q, 9 * q + 9));
		if (j === 6) { identity(C, 9 * j); continue; }
		if (boneOf[j] < 0 || c < 0 || boneOf[c] < 0) { inherit(); continue; }
		const rig = sub(head(c), head(j)), canonM = sub(nv(c), nv(j));
		if (norm(rig) < 1e-8 || (TRUNK.has(j) && norm(rig) * s < 0.5 * norm(canonM))) { inherit(); continue; }
		const [q9, angle] = shortestArc(rig, mulTVec([0, 0, 0], 0, R, 0, canonM, 0));
		angleOf[j] = angle / DEG;
		if (angle > DEG) C.set(q9, 9 * j);
		else identity(C, 9 * j);
	}
	Cp.set(C);
	for (const j of OWN_FOOT_REST) identity(Cp, 9 * j);
	const matching = [...Array(30).keys()].every((j) => C[9 * j] === 1 && C[9 * j + 4] === 1 && C[9 * j + 8] === 1);
	// rest orientation of each mapped bone after that correction
	const E = new Float64Array(9 * 30);
	for (let j = 0; j < 30; j += 1) if (boneOf[j] >= 0) mul(E, 9 * j, Cp, 9 * j, bones[boneOf[j]].rest, 0);
	// bone lengths
	const measured = measuredLengths(sk, { boneOf, head, s, C, toSkeleton });
	const { lengths: network, size } = networkLengths(sk, measured, SPAN_GROUPS, { matching });
	// where the toe tips are, from the toe bone's nearest child
	const toeTips = [25, 29].map((j) => {
		const b = boneOf[j];
		if (b < 0 || !bones[b].children.length) return null;
		const tip = bones[b].children.reduce((best, k) => (norm(sub(bones[k].head, bones[b].head)) < norm(sub(bones[best].head, bones[b].head)) ? k : best));
		return toSkeleton(mulVec([0, 0, 0], 0, Cp, 9 * j, sub(bones[tip].head, bones[b].head), 0));
	});
	const written = writtenJoints(sk, { bones, boneOf, head, C, toSkeleton, rest: restLayout(sk, network.map((v) => v * size)) });
	const between = betweenBones(bones, boneOf, written);
	return {
		bones, boneIndex: index, boneOf, R, s, size, C, Cp, E, correctionDeg: angleOf, matching, measured, network,
		toeTips: toeTips.every(Boolean) ? toeTips : null, written, between, limbFitNeeded: !matching || between.length > 0,
		floorHeight: character.floorHeight ?? 0,
	};
}

const isDescendant = (bones, b, a) => { for (let k = bones[b].parent; k >= 0; k = bones[k].parent) if (k === a) return true; return false; };

/** Which mapped joints get written: the root always; others when they sit close enough to where the skeleton puts them. */
function writtenJoints(sk, { bones, boneOf, head, C, toSkeleton, rest }) {
	const inGroup = new Set(SPAN_GROUPS.flat());
	return sk.names.map((_, j) => {
		if (boneOf[j] < 0 || MARKERS.has(j)) return false;
		if (j === 0) return true;
		let a = sk.parents[j];
		while (a >= 0 && boneOf[a] < 0) a = sk.parents[a];
		if (a < 0 || !isDescendant(bones, boneOf[j], boneOf[a])) return false;
		if (inGroup.has(j)) return true;
		const rigOff = toSkeleton(mulVec([0, 0, 0], 0, C, 9 * a, sub(head(j), head(a)), 0));
		const netOff = [rest[3 * j] - rest[3 * a], rest[3 * j + 1] - rest[3 * a + 1], rest[3 * j + 2] - rest[3 * a + 2]];
		const lr = norm(rigOff), ln = norm(netOff);
		if (lr === 0 || ln === 0) return true;
		const angle = Math.atan2(norm(cross(rigOff, netOff)), dot(rigOff, netOff)) / DEG;
		return !(lr > 2 * ln || ln > 2 * lr || angle > 50);
	});
}

/** Bones strictly between a written bone and its nearest written ancestor bone (held at rest when writing). */
function betweenBones(bones, boneOf, written) {
	const writtenBones = new Set(boneOf.filter((b, j) => b >= 0 && written[j]));
	const out = new Set();
	for (const b of writtenBones) {
		const path = [];
		for (let k = bones[b].parent; k >= 0; k = bones[k].parent) {
			if (writtenBones.has(k)) { path.forEach((p) => out.add(p)); break; }
			path.push(k);
		}
	}
	return [...out].sort((x, y) => x - y);
}
