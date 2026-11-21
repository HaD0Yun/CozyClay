// The looks of the 17-joint figure. Each is ({ tint }) => { object3D, setPose(pos, quat, frame) } where pos/quat
// are a clip character's flat arrays (src/lowvis/clip.js) and frame is the frame index to show. colour (optional, with
// tint): the character's own colour; the block look then has that colour.
import { block } from "./block.js";
import { box } from "./box.js";
import { cube } from "./cube.js";
import { capsuleLook as capsule } from "./capsule.js";
import { man, woman } from "./mannequin.js";
import { stick } from "./stick.js";
import { JOINT_COUNT } from "../rig17.js";

export const LOOKS = { box, capsule, stick, man, woman, block, cube };
export { DEFAULT_TINT } from "./parts.js";

/** `look` for a clip character of `scale` (clip.js): drawn that large about its joints; setPose takes the clip's arrays as before. */
export function sizedLook(look, scale = 1) {
	if (scale === 1) return look;
	const N = JOINT_COUNT, pos = new Float32Array(N * 3);
	look.object3D.scale.setScalar(scale);
	return { object3D: look.object3D, setPose(p, q, frame = 0, grip) {
		for (let i = 0; i < N * 3; i++) pos[i] = p[frame * N * 3 + i] / scale;
		look.setPose(pos, q.slice(frame * N * 4, (frame + 1) * N * 4), 0, grip);
	} };
}
