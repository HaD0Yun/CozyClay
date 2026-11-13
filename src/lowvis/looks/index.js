// The looks of the 17-joint figure. Each is ({ tint }) => { object3D, setPose(pos, quat, frame) } where pos/quat
// are a clip character's flat arrays (src/lowvis/clip.js) and frame is the frame index to show.
import { box } from "./box.js";
import { capsuleLook as capsule } from "./capsule.js";
import { stick } from "./stick.js";

export const LOOKS = { box, capsule, stick };
export { DEFAULT_TINT } from "./parts.js";
