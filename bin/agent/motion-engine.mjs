// The one place that says which motion engine the Studio agent uses, read from the environment.
//   COZYCLAY_MOTION_ENGINE=old      the old motion engine comes back; anything else (or unset) is the lowvis engine
//   COZYCLAY_MOTION_DIRECT=on       the motion request goes straight to the motion writer
//   COZYCLAY_MOTION_OFF=pace,turn   engine steps of the lowvis engine switched off by name (src/lowvis/pi/prompt.mjs OFF);
//                                   body off: a character has no scale or tint in a motion, and one at another scale than 1 is not animated
//   COZYCLAY_MOTION_MODEL=<id>      the motion writer's model (default claude-opus-5-5); COZYCLAY_MOTION_EFFORT its effort (default medium)

import { OFF as STEPS } from "../../src/lowvis/pi/prompt.mjs";

/** "old" only when COZYCLAY_MOTION_ENGINE is "old", else "lowvis". */
export const motionEngine = (env = process.env) => env?.COZYCLAY_MOTION_ENGINE === "old" ? "old" : "lowvis";

/**
 * The motion writer's model and effort: claude-opus-5-5 at medium unless COZYCLAY_MOTION_MODEL / COZYCLAY_MOTION_EFFORT
 * name others. The engine and the manual stay as they are, so the same requests can be run on another model.
 */
export const motionWriter = (env = process.env) => ({ model: env?.COZYCLAY_MOTION_MODEL || "claude-opus-5-5", effort: env?.COZYCLAY_MOTION_EFFORT || "medium" });

/** Whether COZYCLAY_MOTION_DIRECT is "on". */
export const motionDirect = (env = process.env) => env?.COZYCLAY_MOTION_DIRECT === "on";

/** The engine steps listed in COZYCLAY_MOTION_OFF (comma separated, of pace, turn, tops, body). Throws on any other name. */
export function motionOff(env = process.env) {
	const list = String(env?.COZYCLAY_MOTION_OFF ?? "").split(",").map(s => s.trim()).filter(Boolean);
	const bad = list.filter(s => !STEPS.includes(s));
	if (bad.length) throw new Error(`COZYCLAY_MOTION_OFF: want any of ${STEPS.join(", ")}, got ${bad.join(", ")}`);
	return [...new Set(list)];
}

/**
 * The editor actions the Studio agent does not see while the lowvis engine is on (agent-view.mjs): the old motion
 * engine's actions and the hand-fix actions of a rig body. Body motion is the motion tool's work (motion-door.mjs).
 * The editor, MCP and the old engine keep them.
 */
export const HIDDEN_ACTIONS = Object.freeze([
	"motion.compile", "motion.describe", "motion.report", "motion.keyObject", "motion.fill", "motion.primitive", "motion.qa",
	"character.setIkKey", "character.removeIkKey", "character.clearIkKeys", "objects.batch", "character.setPose", "ik.applyPose",
	"motion.rangePin.apply", "motion.rangePin.remove", "ik.setKey", "ik.removeKey", "ik.clearKeys", "ik.moveKey",
]);
