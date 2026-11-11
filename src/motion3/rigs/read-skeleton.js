// A loaded character's skeleton as adapt.js's raw ({ model, units, bones: [{ name, parent, localPos, localQuat [x, y, z, w] }] }),
// read from a three.js object tree (a loaded glTF, FBX or VRM scene: its Object3D with isBone) or from a glTF file's JSON
// (glTF 2.0 nodes: translation, rotation or a matrix, children; the joints of a skin).
//   Joints: the bones (three.js isBone, or opts.bones) or the skin's joints (glTF skins[opts.skin ?? 0].joints; every
//   node without a mesh or camera when the file has no skin). A node between two joints that is not one (a helper
//   group) is folded into the lower joint's local transform. Nodes above the top joint (a scene, an armature) are not:
//   raw lives in the top joint's parent space, which is the space a player writes the top joint's position in.
//   Scale is not read: a joint whose scale is not 1 is listed in `scaled`.
//   Units: opts.units, else read from the skeleton's size in its own numbers: 10 or more is centimetres (an armature
//   scaled 0.01 holds cm bones), less is metres (adapt.js refuses a stature outside 0.1 to 10 m, so the two never meet).
//   VRM: a humanoid mapping (glTF extensions VRMC_vrm 1.0 or VRM 0.x; for three.js opts.humanoid { humanBone: bone name })
//   renames each mapped joint to its humanoid name, so adaptRig(raw, { template: "vrm" }) maps every one of them;
//   `sources` keeps each raw bone's own node name for the player.
import { add, apply, mul, matFromQuat, quatFromMat } from "../compiler/math.js";

const CM_FROM = 10;

/**
 * Raw bones from a node tree: nodes [{ name, parent (node index or -1), t [3], q [4], joint, scaled }], humanoid
 * { node index: humanoid name }.
 */
function rawOf(nodes, humanoid, opts) {
	const joints = nodes.map((n, i) => (n.joint ? i : -1)).filter(i => i >= 0), at = new Map(joints.map((i, k) => [i, k]));
	const bones = joints.map(i => {
		let R = matFromQuat(norm4(nodes[i].q)), t = [...nodes[i].t], p = nodes[i].parent;
		// fold non-joint nodes up to the joint above; none above: the top joint's own transform alone
		const between = [];
		while (p >= 0 && !nodes[p].joint) { between.push(p); p = nodes[p].parent; }
		if (p >= 0) for (const m of between) { const Rm = matFromQuat(norm4(nodes[m].q)); t = add(nodes[m].t, apply(Rm, t)); R = mul(Rm, R); }
		return { name: humanoid.get(i) ?? nodes[i].name, parent: p >= 0 ? at.get(p) : -1, localPos: t, localQuat: quatFromMat(R) };
	});
	const extent = sizeOf(bones), units = opts.units ?? (extent >= CM_FROM ? "cm" : "m");
	if (units !== "cm" && units !== "m") throw new Error(`readSkeleton: units must be "cm" or "m", got ${JSON.stringify(units)}`);
	return {
		raw: { ...(opts.model ? { model: opts.model } : {}), units, bones },
		unitsDetected: opts.units === undefined, extent, template: humanoid.size ? "vrm" : null,
		sources: joints.map(i => nodes[i].name), scaled: joints.filter(i => nodes[i].scaled).map(i => nodes[i].name),
	};
}

const norm4 = q => { const l = Math.hypot(...q) || 1; return q.map(v => v / l); };

/** The largest side of the joints' bounding box, in the skeleton's own numbers. */
function sizeOf(bones) {
	const P = [], R = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	const visit = i => {
		if (P[i]) return;
		const b = bones[i], L = matFromQuat(b.localQuat);
		if (b.parent < 0) { P[i] = b.localPos; R[i] = L; } else { visit(b.parent); P[i] = add(P[b.parent], apply(R[b.parent], b.localPos)); R[i] = mul(R[b.parent], L); }
		P[i].forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); });
	};
	bones.forEach((_, i) => visit(i));
	return bones.length ? Math.max(...hi.map((v, k) => v - lo[k])) : 0;
}

/**
 * readThreeSkeleton(root, opts?) -> { raw, unitsDetected, extent, template, sources, scaled }
 * root: a three.js Object3D (gltf.scene, an FBX group, vrm.scene). opts: { units?, model?, bones? (the joints, e.g.
 * a SkinnedMesh's skeleton.bones; default every isBone below root), humanoid? ({ humanBone: bone name }) }.
 */
export function readThreeSkeleton(root, opts = {}) {
	const nodes = [], index = new Map(), want = opts.bones ? new Set(opts.bones) : null;
	const visit = (o, parent) => {
		const i = nodes.length, s = o.scale;
		index.set(o, i);
		nodes.push({ name: String(o.name ?? ""), parent, t: [o.position.x, o.position.y, o.position.z], q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
			joint: want ? want.has(o) : Boolean(o.isBone), scaled: Boolean(s) && Math.max(Math.abs(s.x - 1), Math.abs(s.y - 1), Math.abs(s.z - 1)) > 1e-6 });
		for (const c of o.children ?? []) visit(c, i);
	};
	visit(root, -1);
	const humanoid = new Map();
	for (const [bone, name] of Object.entries(opts.humanoid ?? {})) {
		const i = nodes.findIndex(n => n.joint && n.name === name);
		if (i >= 0) humanoid.set(i, bone);
	}
	return rawOf(nodes, humanoid, opts);
}

/** A glTF node's translation and rotation (a matrix: column-major, its scale taken out of the columns). */
function trs(node) {
	const m = node.matrix;
	if (!m) return { t: node.translation ?? [0, 0, 0], q: node.rotation ?? [0, 0, 0, 1], s: node.scale ?? [1, 1, 1] };
	const c = [0, 4, 8].map(o => [m[o], m[o + 1], m[o + 2]]), s = c.map(v => Math.hypot(...v)), u = c.map((v, k) => v.map(x => x / s[k]));
	return { t: [m[12], m[13], m[14]], q: quatFromMat([0, 1, 2].map(r => [u[0][r], u[1][r], u[2][r]])), s };
}

/** VRM humanoid of a glTF JSON: node index -> humanoid bone name (VRM 1.0 VRMC_vrm, else VRM 0.x). */
function vrmHumanoid(json) {
	const one = json.extensions?.VRMC_vrm?.humanoid?.humanBones, zero = json.extensions?.VRM?.humanoid?.humanBones;
	const pairs = one ? Object.entries(one).map(([bone, v]) => [v?.node, bone]) : Array.isArray(zero) ? zero.map(v => [v?.node, v?.bone]) : [];
	return new Map(pairs.filter(([node, bone]) => Number.isInteger(node) && typeof bone === "string"));
}

/**
 * readGltfSkeleton(json, opts?) -> { raw, unitsDetected, extent, template, sources, scaled }
 * json: a glTF 2.0 file's JSON (a .gltf, or a .glb's JSON chunk). opts: { units?, model?, skin? (index, default 0) }.
 */
export function readGltfSkeleton(json, opts = {}) {
	const list = json?.nodes;
	if (!Array.isArray(list) || !list.length) throw new Error("readGltfSkeleton: the glTF has no nodes");
	const parent = list.map(() => -1);
	list.forEach((n, i) => (n.children ?? []).forEach(c => { parent[c] = i; }));
	const skin = json.skins?.[opts.skin ?? 0], humanoid = vrmHumanoid(json);
	const joints = new Set([...(skin?.joints ?? list.map((n, i) => (n.mesh === undefined && n.camera === undefined ? i : -1)).filter(i => i >= 0)), ...humanoid.keys()]);
	const nodes = list.map((n, i) => {
		const { t, q, s } = trs(n);
		return { name: String(n.name ?? `node${i}`), parent: parent[i], t, q, joint: joints.has(i), scaled: s.some(v => Math.abs(v - 1) > 1e-6) };
	});
	return rawOf(nodes, humanoid, opts);
}
