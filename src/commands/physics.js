// motion.physicsOverlay: the physics overlay's viewer setting (physics-overlay-settings.js), the agent's door to the
// motion controls' Physics box. Transient: never saved, never undone.
import { describePhysicsOverlay, setPhysicsOverlay } from "../physics-overlay-settings.js";

const flag = description => ({ type: "boolean", description });

export const declarations = Object.freeze([
	{ id: "motion.physicsOverlay", label: "Physics overlay", kind: "transient",
		input: { type: "object", required: [], additionalProperties: false, properties: {
			com: flag("the centre of mass: a 4 cm ball with a line down to the ground, green inside the feet, red past the balance limit (what QA calls BALANCE), grey off the ground"),
			support: flag("the support polygon: the outline of the soles on the ground"),
			arc: flag("per air run: the hips' path (white, dashed) and the hips' gravity parabola through the same takeoff and landing (orange); they part in a flight that tucks or turns, since the centre of mass rides the arc (QA FLOAT reads the hips' lost fall, not this gap)"),
			trail: flag("the last 24 frames of each spring object's tip"),
			all: flag("every part at once, before the named ones; { all: false } turns the overlay off"),
		} },
		description: "Draw the physics QA measures over the active character's installed take, in the editor views and in captures, contact sheets and exports (capture_frame, verify_result frames, export.shotVideo) until it is turned off: com, support, arc and trail (see each field). Updated every frame, the same in scrub, playback and export. No field turns every part on; { all: false } turns it off. Turn it on before a screenshot to see why QA reports BALANCE or FLOAT. A viewer setting: off by default, never saved or undone." },
]);

export function register(registry) {
	registry.register({ ...declarations[0], available: () => true, run: args => ({ affectedIds: [], summary: describePhysicsOverlay(setPhysicsOverlay(args)) }) });
}
