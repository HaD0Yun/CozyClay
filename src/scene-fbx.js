/**
 * FBX bounds through the loader. Magic / version sniffing lives in
 * `mesh-sniff.js`, which stays three-free.
 *
 * GLB boxes stay JSON and OBJ boxes stay `v` text. An FBX box needs
 * `FBXLoader.parse` + world matrices. Callers in `scene-mesh.js` keep the
 * three-free paths; this file is the three.js boundary.
 */
import { Box3, Vector3 } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/** `FBXLoader.parse` wants a real ArrayBuffer, not a view into a larger pool. */
export function arrayBufferOf(bytes) {
	if (bytes instanceof ArrayBuffer) return bytes;
	if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return null;
}

function parseFbxGroup(bytes) {
	const buffer = arrayBufferOf(bytes);
	if (!buffer || !buffer.byteLength) return null;
	return new FBXLoader().parse(buffer, "");
}

/**
 * World-space box of an FBX after `updateMatrixWorld`. Empty, flat, or
 * unreadable graphs return null so import/shelf spawn can toast
 * "no measurable geometry" — same never-throw contract as parseGlbBounds.
 */
export function parseFbxBounds(bytes) {
	try {
		const group = parseFbxGroup(bytes);
		if (!group) return null;
		group.updateMatrixWorld(true);
		const box = new Box3().setFromObject(group);
		const size = box.getSize(new Vector3());
		if (!(size.y > 0) || !Number.isFinite(size.y)) return null;
		return {
			min: { x: box.min.x, y: box.min.y, z: box.min.z },
			max: { x: box.max.x, y: box.max.y, z: box.max.z },
		};
	} catch {
		return null;
	}
}
