// Pose-mode placement keys: where the whole character stands (world x, z) and faces (yaw, degrees) at a keyed frame.
// They ride the IK keys as one more track, "placement", whose p is { x, y: yaw, z } (no bone owns it: ikEvaluate skips
// it), so they save, load and undo with the pose keys. Between keys the character travels in a straight line and turns
// the short way round; before the first key and after the last it holds.
export const PLACEMENT_TRACK = "placement";

/** { x, z, rot } -> the track key character.setIkKey takes. */
export const placementTrackKey = ({ x, z, rot }) => ({ p: { x, y: rot, z } });

/** The placement keys in the motion store's JSON IK keys ([{ frame, tracks }]), in frame order. */
export function placementRows(ikKeys = []) {
	return ikKeys.filter(row => row.tracks?.[PLACEMENT_TRACK]?.p).map(row => ({ frame: row.frame, x: row.tracks[PLACEMENT_TRACK].p.x, z: row.tracks[PLACEMENT_TRACK].p.z, rot: row.tracks[PLACEMENT_TRACK].p.y }))
		.sort((a, b) => a.frame - b.frame);
}

const wrap = deg => ((deg % 360) + 540) % 360 - 180;

/** The placement at `frame` (fractional frames too), or null without keys. */
export function samplePlacement(rows, frame) {
	if (!rows?.length) return null;
	const next = rows.findIndex(row => row.frame >= frame);
	if (next === 0 || rows.length === 1) return { x: rows[0].x, z: rows[0].z, rot: rows[0].rot };
	if (next < 0) { const last = rows.at(-1); return { x: last.x, z: last.z, rot: last.rot }; }
	const a = rows[next - 1], b = rows[next], t = (frame - a.frame) / (b.frame - a.frame);
	return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, rot: a.rot + wrap(b.rot - a.rot) * t };
}
