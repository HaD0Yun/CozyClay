// What Auto Pose remembers about each handle of one character, and how user actions change it. Pure data: every
// function returns a new state object and never touches a rig. Positions are in the poser world frame (metres).
import { angleDeg } from "../mat3.js";
import { DEFAULT_TOL } from "../encode.js";
import { HANDLES } from "../handles.js";

export const TOLERANCE_MIN = 0.001;
export const TOLERANCE_MAX = 0.5;
/** A turn smaller than this (degrees) counts as a click, not a turn, so it does not hold the rotation. */
const HOLD_TURN_DEG = 2;
/** Until the user drags it, the look target rides this many metres ahead of the face (along the head's +Z). */
export const LOOK_AHEAD = 0.45;

const BY_ID = new Map(HANDLES.map((h) => [h.id, h]));
const clampTolerance = (v) => Math.min(TOLERANCE_MAX, Math.max(TOLERANCE_MIN, Number.isFinite(v) ? v : DEFAULT_TOL));

/** Whether the handle can be dragged to a point (it sends a position or a look-at point). */
export const canMove = (id) => !!BY_ID.get(id)?.sends.some((kind) => kind === "position" || kind === "lookAt");
/** Whether the handle can be turned (it sends a rotation). */
export const canTurn = (id) => !!BY_ID.get(id)?.sends.includes("rotation");

/**
 * How handles start, and what Back to T-pose returns to: the six core handles on, feet and toes held, default
 * tolerance, no rotation held, the look target riding ahead of the face. `left` marks a place the user left (it stays), `turnSet` a turn the user set.
 */
export function initialHandles() {
	return Object.fromEntries(HANDLES.filter((h) => h.id !== "body").map((h) => [h.id, {
		enabled: !!h.start, held: !!h.held, tolerance: DEFAULT_TOL, rotTolerance: DEFAULT_TOL,
		holdsRotation: false, placed: false, left: false, turnSet: false, place: null, turn: null,
	}]));
}

const patch = (state, id, change) => (state[id] ? { ...state, [id]: { ...state[id], ...change } } : state);

/**
 * Switch a handle on or off. Switching on does not re-solve: the handle sits on its joint. Switching off
 * re-solves, so `resolve` is true then. A switched-off look target keeps its point but is not sent.
 */
export function setEnabled(state, id, on) {
	const was = !!state[id]?.enabled;
	if (!state[id] || was === !!on) return { state, resolve: false };
	return { state: patch(state, id, { enabled: !!on, left: false }), resolve: was && !on };
}

/** Hold a handle where it is in the world, or let it follow the body; letting go forgets a place the user left. */
export function setHeld(state, id, on) {
	return patch(state, id, on ? { held: true } : { held: false, left: false });
}

/** Position tolerance (or turn tolerance with `rotation`), kept between 0.001 and 0.5. */
export function setTolerance(state, id, value, { rotation = false } = {}) {
	return patch(state, id, { [rotation ? "rotTolerance" : "tolerance"]: clampTolerance(value) });
}

/** Hold (or release) the handle's rotation; releasing it lets the network decide the joint's rotation again. */
export function setHoldsRotation(state, id, on) {
	return patch(state, id, on ? { holdsRotation: true } : { holdsRotation: false, turnSet: false });
}

/** Send the look target back to riding ahead of the face, where it moves with the head and asks for nothing. */
export function resetLookAt(state) {
	return patch(state, "lookAt", { placed: false, place: null, holdsRotation: false, turnSet: false });
}

/**
 * State at the press of a drag: each handle's place is its joint's current position and its turn the joint's
 * current global rotation, except places and turns the user left. `pose.jointAt(joint)` and `pose.turnAt(joint)`
 * read the character as it stands; `pose.lookHome` is the riding point ahead of the face.
 */
export function pressHandles(state, pose) {
	const out = {};
	for (const [id, s] of Object.entries(state)) {
		const joint = BY_ID.get(id).joint;
		const place = id === "lookAt" ? (s.placed ? s.place : pose.lookHome) : s.left && s.place ? s.place : pose.jointAt(joint);
		out[id] = { ...s, place, turn: s.turnSet && s.turn ? s.turn : pose.turnAt(joint) };
	}
	return out;
}

/** After an outside change of the pose (undo, another frame, another tool) the places and turns left are stale. */
export function forgetLeft(state) {
	const out = {};
	for (const [id, s] of Object.entries(state)) out[id] = s.left || s.turnSet ? { ...s, left: false, turnSet: false } : s;
	return out;
}

/**
 * State after a drag ends. `drag = { id, target?, turn?, pressTurn? }`. A dragged handle is switched on and stays
 * held where it was dropped; a dragged look target stops riding with the face. A real turn (not a click) holds the
 * rotation.
 */
export function afterDrag(state, drag) {
	const s = state[drag.id];
	if (!s) return state;
	const change = { enabled: true };
	if (drag.target) {
		change.place = [...drag.target];
		if (drag.id === "lookAt") change.placed = true;
		else { change.held = true; change.left = true; }
	}
	if (drag.turn) {
		const turned = !drag.pressTurn || angleDeg(drag.turn, 0, drag.pressTurn, 0) > HOLD_TURN_DEG;
		if (turned) Object.assign(change, { turn: Array.from(drag.turn), holdsRotation: true, turnSet: true });
	}
	return patch(state, drag.id, change);
}

/** Where a handle is drawn: its own place when the user left it there (or dropped the look target), else null. */
export function heldPlace(state, id) {
	const s = state[id];
	if (!s) return null;
	if (id === "lookAt") return s.placed ? s.place : null;
	return s.left && s.held ? s.place : null;
}
