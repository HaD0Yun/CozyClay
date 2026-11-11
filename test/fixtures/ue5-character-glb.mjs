// A character file with another bone convention, built from the repo's own X Bot bind (src/motion3/rigs/x-bot-tpose.json):
// every bone renamed to its Unreal Engine 5 name (src/motion3/rigs/templates/ue5.json), the figure rescaled to 1.1, Z-up
// centimetres under an armature node that turns it Y-up and scales it 0.01, and each bone's axes turned 90 degrees about
// its own z; a box skinned to each bone gives it a body. Nothing is downloaded.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createSkeleton } from "../../src/motion3/compiler/skeleton.js";
import { apply, mul, rx, rz, scale, sub, T, quatFromMat } from "../../src/motion3/compiler/math.js";
import { TEMPLATES } from "../../src/motion3/rigs/templates.js";

const REF = createSkeleton(JSON.parse(readFileSync(new URL("../../src/motion3/rigs/x-bot-tpose.json", import.meta.url), "utf8")));
const SIDES = ["Left", "Right"];
/** Canonical bone -> the ue5 template's first name for it. */
function ue5Names() {
	const t = TEMPLATES.ue5, names = {}, fill = (n, S) => n.replace(/\{(\w+)\}/g, (_, k) => t.sides[S][k]), pre = (t.prefixes ?? [""])[0];
	for (const [key, list] of Object.entries(t.bones)) {
		if (key.includes("{Side}")) for (const S of SIDES) names[key.replace("{Side}", S)] = pre + fill(list[0], S);
		else names[key] = pre + list[0];
	}
	for (const S of SIDES) for (const [f, joints] of Object.entries(t.fingers)) joints.forEach((j, i) => { names[`${S}Hand${f}${i + 1}`] = pre + fill([j].flat()[0], S); });
	return names;
}

/** { bytes: the .glb file, names: canonical bone -> the file's bone name }. */
export function buildUe5Glb() {
	const names = ue5Names(), keep = REF.names.filter(n => names[n]), STATURE = 1.1, Z_UP = rx(90), C = rz(90);
	const bones = keep.map(n => {
		let p = REF.parent[REF.index[n]];
		while (p >= 0 && !keep.includes(REF.names[p])) p = REF.parent[p];
		const j = REF.index[n];
		// armature space: Z-up centimetres; each bone's axes turned by C
		return { canon: n, name: names[n], parent: p < 0 ? -1 : keep.indexOf(REF.names[p]), P: scale(apply(Z_UP, REF.restWorldPos[j]), 100 * STATURE), R: mul(mul(Z_UP, REF.restWorldRot[j]), C) };
	});
	const q = R => quatFromMat(R), nodes = [], o = 2;
	nodes.push({ name: "Body", mesh: 0, skin: 0 }, { name: "Armature", rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [0.01, 0.01, 0.01], children: [] });
	bones.forEach(b => {
		const pb = bones[b.parent];
		nodes.push({ name: b.name, translation: pb ? apply(T(pb.R), sub(b.P, pb.P)) : b.P, rotation: q(pb ? mul(T(pb.R), b.R) : b.R) });
	});
	bones.forEach((b, i) => { (b.parent < 0 ? nodes[1] : nodes[o + b.parent]).children ??= []; (b.parent < 0 ? nodes[1] : nodes[o + b.parent]).children.push(o + i); });
	// world (Y-up metres) of each joint, through three.js, for the skin's inverse binds and the boxes
	const objs = nodes.map(n => { const g = new THREE.Object3D(); if (n.translation) g.position.fromArray(n.translation); if (n.rotation) g.quaternion.fromArray(n.rotation); if (n.scale) g.scale.fromArray(n.scale); return g; });
	nodes.forEach((n, i) => (n.children ?? []).forEach(c => objs[i].add(objs[c])));
	objs[1].updateMatrixWorld(true);
	const world = bones.map((_, i) => objs[o + i].matrixWorld), pos = [], joints = [], weights = [], index = [], ibm = [];
	bones.forEach((b, i) => {
		const at = new THREE.Vector3().setFromMatrixPosition(world[i]), child = bones.findIndex(c => c.parent === i);
		const to = child >= 0 ? new THREE.Vector3().setFromMatrixPosition(world[child]) : at.clone().add(new THREE.Vector3(0, 0.02, 0));
		const lo = at.clone().min(to).subScalar(0.012), hi = at.clone().max(to).addScalar(0.012), base = pos.length / 3;
		for (let c = 0; c < 8; c++) { pos.push(c & 1 ? hi.x : lo.x, c & 2 ? hi.y : lo.y, c & 4 ? hi.z : lo.z); joints.push(i, 0, 0, 0); weights.push(1, 0, 0, 0); }
		for (const [a, b2, c2, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) index.push(base + a, base + b2, base + c2, base + a, base + c2, base + d);
		ibm.push(...world[i].clone().invert().elements);
	});
	const parts = [new Float32Array(pos), new Uint16Array(joints), new Float32Array(weights), new Uint16Array(index), new Float32Array(ibm)];
	const views = [], chunks = [];
	let offset = 0;
	for (const a of parts) { const bytes = Buffer.from(a.buffer); views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); chunks.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)); offset += bytes.length + ((4 - (bytes.length % 4)) % 4); }
	const lo = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), hi = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
	const json = { asset: { version: "2.0", generator: "cozyclay qa" }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes,
		meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] }],
		skins: [{ joints: bones.map((_, i) => o + i), inverseBindMatrices: 4 }],
		buffers: [{ byteLength: offset }], bufferViews: views,
		accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: lo, max: hi }, { bufferView: 1, componentType: 5123, count: pos.length / 3, type: "VEC4" },
			{ bufferView: 2, componentType: 5126, count: pos.length / 3, type: "VEC4" }, { bufferView: 3, componentType: 5123, count: index.length, type: "SCALAR" },
			{ bufferView: 4, componentType: 5126, count: bones.length, type: "MAT4" }] };
	let text = Buffer.from(JSON.stringify(json));
	text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
	const bin = Buffer.concat(chunks), header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
	header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
	jh.writeUInt32LE(text.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
	return { bytes: Buffer.concat([header, jh, text, bh, bin]), names };
}
