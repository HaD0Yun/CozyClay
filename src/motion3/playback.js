// Play a take v3 on a live rig: local quaternions straight onto the Mixamo control bones
// (first depth-first bone of each name; the nested identity "skinned" copies are never
// written) and the hips position in rig space. The rig root carries the character's
// placement and the 0.01 centimetre scale, so metres become centimetres here.
import { normalizeBoneName } from "../poses.js";

const CM_PER_M = 100;
const resolved = new WeakMap();

export function controlBones(rig, names) {
	let entry = resolved.get(rig);
	if (entry && entry.key === names.join()) return entry;
	const first = new Map();
	rig.traverse(o => {
		if (!o.isBone) return;
		const n = normalizeBoneName(o.name);
		if (!first.has(n)) first.set(n, o);
	});
	const bones = names.map(name => {
		const target = normalizeBoneName(name);
		for (const [n, bone] of first) if (n === target || n.endsWith(target)) return bone;
		return null;
	});
	// Bind translations: a take never moves a bone except the hips, so every other bone goes
	// back to its bind position (another player may have stretched it).
	const binds = rig.userData?.poseBind;
	const bindPos = bones.map(b => {
		const p = b && binds?.get(b)?.position;
		return b ? (p ? [p.x, p.y, p.z] : b.position.toArray()) : null;
	});
	entry = { key: names.join(), bones, bindPos, hips: names.indexOf("Hips") };
	resolved.set(rig, entry);
	return entry;
}

export const isTakeV3 = motion => motion?.schema === "cozyclay.take.v3";

export function applyTakeFrame(rig, take, frame) {
	if (!rig || !take) return;
	const { bones, bindPos, hips } = controlBones(rig, take.bones);
	const f = Math.max(0, Math.min(take.frameCount - 1, Math.round(frame) || 0)), B = take.bones.length;
	for (let b = 0; b < B; b++) {
		const bone = bones[b];
		if (!bone) continue;
		const i = (f * B + b) * 4;
		bone.quaternion.set(take.rot[i], take.rot[i + 1], take.rot[i + 2], take.rot[i + 3]);
		if (b === hips) bone.position.set(take.hips[f * 3] * CM_PER_M, take.hips[f * 3 + 1] * CM_PER_M, take.hips[f * 3 + 2] * CM_PER_M);
		else bone.position.set(bindPos[b][0], bindPos[b][1], bindPos[b][2]);
	}
	rig.updateMatrixWorld(true);
}
