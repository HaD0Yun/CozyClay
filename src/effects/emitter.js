/**
 * Where an effect emitter is, whether it is shown and how strongly it emits,
 * at any frame: the one place the simulation reads the scene from.
 *
 * Everything here is a pure function of (records, take, frame), so a frame
 * evaluates the same whether it is scrubbed to, played into or exported.
 */
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { sceneObjectTravelMatrixAt, trackShown } from "../object-travel.js";

const DEG = Math.PI / 180;
const scratchMatrix = new Matrix4();
const scratchPos = new Vector3();
const scratchQuat = new Quaternion();
const scratchScale = new Vector3();
const scratchEuler = new Euler();

/** False while the take hides the record or any record it is grouped under
 * (a smoke emitter on a cigarette still in the pocket), and for a
 * showOnlyInTake emitter no take drives (a kit's tip smoke in a static scene). */
export function emitterShown(lookup, record, frame, take) {
	return trackShown(record.id, frame, take, lookup);
}

function authoredPose(record) {
	scratchPos.set(record.x ?? 0, record.y ?? 0, record.z ?? 0);
	scratchQuat.setFromEuler(scratchEuler.set((record.rotX ?? 0) * DEG, (record.rot ?? 0) * DEG, (record.rotZ ?? 0) * DEG, "XYZ"));
}

/**
 * The emitter's world position and orientation at `frame`, scale left out:
 * effect sizes are metres whatever the record's scale.
 *
 * Routed, hinged, take-carried and parented records come from
 * sceneObjectTravelMatrixAt. A record pinned to a character bone (`attach`)
 * asks `live(id, out, frame)` for its world matrix at that frame: the bone
 * where the character's take has it then (attach-history.js), or where the
 * live rig has it now when that cannot be read (null falls back to the numbers).
 *
 * @returns {{ p: number[], q: number[] }}
 */
export function emitterPoseAt(lookup, record, frame, take, live = null) {
	const world = record.attach ? live?.(record.id, scratchMatrix, frame) ?? null : sceneObjectTravelMatrixAt(lookup, record.id, frame, take ?? {}, scratchMatrix);
	if (world) world.decompose(scratchPos, scratchQuat, scratchScale);
	else authoredPose(record);
	return { p: [scratchPos.x, scratchPos.y, scratchPos.z], q: [scratchQuat.x, scratchQuat.y, scratchQuat.z, scratchQuat.w] };
}

/** `v` (3 numbers) turned by unit quaternion `q`, into `out`. */
export function rotate(q, x, y, z, out) {
	const [qx, qy, qz, qw] = q;
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
	out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
	out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
	return out;
}
