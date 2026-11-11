// The MotionBricks fill reads and writes poses through its body model, which is mapped onto the X Bot's and the Y Bot's
// skeleton only (soma.js, reverse.js). On an adapted rig (rigs/adapt.js) it would read the wrong joints, so it refuses
// there until that body model is mapped onto adapted rigs.
import { isBuiltInRig } from "../rigs/posted.js";

/** Throws TARGET_NOT_READY unless skeleton sk is the X Bot's or the Y Bot's. */
export function fillRig(sk) {
	if (!isBuiltInRig(sk?.model)) throw Object.assign(new Error(`MotionBricks fill runs on the X Bot and the Y Bot only: ${sk?.model ?? "this character"} is an adapted rig, which its body model does not map yet`), { code: "TARGET_NOT_READY" });
}
