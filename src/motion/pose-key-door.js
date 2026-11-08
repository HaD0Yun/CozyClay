// Pose mode's other doors to a key (the Sequencer key bar, src/shell/PoseKeyBar.jsx, owns keying):
// a press on the Body lane's empty track keys the pose on screen at the frame pressed, and the
// onion-skin toggle for the keyed poses (pose-key-ghosts.jsx). The key bar registers its keyer
// while Pose mode is on; the timeline calls it without knowing the motion owner.
import { useSyncExternalStore } from "react";

let keyer = null;
/** fn(frame): key the pose on screen at `frame`. Returns the unregister. */
export function registerPoseKeyer(fn) {
	keyer = fn;
	return () => { if (keyer === fn) keyer = null; };
}

/** The Body lane's pointerdown: a left press on the empty track (not on a key or a band) keys there. */
export function ikLanePress(event, frame) {
	if (event.button !== 0 || event.target !== event.currentTarget || !keyer) return;
	event.preventDefault();
	event.stopPropagation();
	keyer(frame);
}

// Ghosts of the keyed poses: a viewer setting (never saved, never undone), on by default.
let ghosts = true;
const listeners = new Set();
const poseGhostsOn = () => ghosts;
export function setPoseGhosts(value) {
	if (ghosts === Boolean(value)) return;
	ghosts = Boolean(value);
	for (const listener of listeners) listener();
}
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const usePoseGhosts = () => useSyncExternalStore(subscribe, poseGhostsOn, poseGhostsOn);
