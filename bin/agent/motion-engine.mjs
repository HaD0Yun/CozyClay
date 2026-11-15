// The one place that says which motion engine the Studio agent uses, read from the environment.
//   COZYCLAY_MOTION_ENGINE=old      the old motion engine comes back; anything else (or unset) is the lowvis engine
//   COZYCLAY_MOTION_DIRECT=on       the motion request goes straight to the motion writer
//   COZYCLAY_MOTION_OFF=pace,turn   engine steps of the lowvis engine switched off by name (src/lowvis/pi/prompt.mjs OFF)

import { OFF as STEPS } from "../../src/lowvis/pi/prompt.mjs";

/** "old" only when COZYCLAY_MOTION_ENGINE is "old", else "lowvis". */
export const motionEngine = (env = process.env) => env?.COZYCLAY_MOTION_ENGINE === "old" ? "old" : "lowvis";

/** Whether COZYCLAY_MOTION_DIRECT is "on". */
export const motionDirect = (env = process.env) => env?.COZYCLAY_MOTION_DIRECT === "on";

/** The engine steps listed in COZYCLAY_MOTION_OFF (comma separated, of pace, turn, tops). Throws on any other name. */
export function motionOff(env = process.env) {
	const list = String(env?.COZYCLAY_MOTION_OFF ?? "").split(",").map(s => s.trim()).filter(Boolean);
	const bad = list.filter(s => !STEPS.includes(s));
	if (bad.length) throw new Error(`COZYCLAY_MOTION_OFF: want any of ${STEPS.join(", ")}, got ${bad.join(", ")}`);
	return [...new Set(list)];
}
