// Auto Pose's handles, how their sends become effectors, and what each handle sends during a drag.
// A send is what one handle contributes to this solve: `{ id, position?, rotation?, lookAt?, tol?, rotTol? }` with
// positions in the poser world frame (metres) and `rotation` the joint's global rotation relative to rest (6D or a
// flat row-major 3x3, skeleton frame).
import { to6d } from "./mat3.js";
import { DEFAULT_TOL, EFFECTOR } from "./encode.js";

const P = "position", R = "rotation", LOOK = "lookAt";
/** `start`: switched on when the tool opens; `held`: stays fixed in the world until the user releases it. */
export const HANDLES = Object.freeze([
	{ id: "body", joint: 0, sends: [] },
	{ id: "hips", joint: 0, sends: [P, R], start: true },
	{ id: "spineLow", joint: 1, sends: [R] },
	{ id: "spineMid", joint: 2, sends: [R] },
	{ id: "chest", joint: 3, sends: [P, R] },
	{ id: "neck", joint: 4, sends: [P, R] },
	{ id: "head", joint: 6, sends: [P, R] },
	{ id: "lookAt", joint: 6, sends: [LOOK, R], start: true },
	{ id: "leftShoulder", joint: 10, sends: [R] },
	{ id: "rightShoulder", joint: 16, sends: [R] },
	{ id: "leftHand", joint: 13, sends: [P, R], start: true },
	{ id: "rightHand", joint: 19, sends: [P, R], start: true },
	{ id: "leftElbow", joint: 12, sends: [P, R] },
	{ id: "rightElbow", joint: 18, sends: [P, R] },
	{ id: "leftFoot", joint: 24, sends: [P, R], start: true, held: true },
	{ id: "rightFoot", joint: 28, sends: [P, R], start: true, held: true },
	{ id: "leftKnee", joint: 23, sends: [P, R] },
	{ id: "rightKnee", joint: 27, sends: [P, R] },
	{ id: "leftToes", joint: 25, sends: [P, R], held: true },
	{ id: "rightToes", joint: 29, sends: [P, R], held: true },
]);
const BY_ID = new Map(HANDLES.map((h) => [h.id, h]));
const HAND_IDS = new Set(["leftHand", "rightHand"]);

const as6d = (r) => (r.length === 6 ? [...r] : Array.from(to6d(new Float64Array(6), 0, r, 0)));

/** Handle sends -> effectors; throws on an unknown handle or a send the handle cannot make. */
export function effectorsFromSends(sends) {
	const out = [];
	for (const send of sends) {
		const handle = BY_ID.get(send.id);
		if (!handle) throw new Error(`poser: unknown handle "${send.id}"`);
		const can = (kind) => { if (!handle.sends.includes(kind)) throw new Error(`poser: handle "${send.id}" cannot send ${kind}`); };
		if (send.position) { can(P); out.push({ joint: handle.joint, type: EFFECTOR.position, target: send.position, tol: send.tol ?? DEFAULT_TOL }); }
		if (send.lookAt) { can(LOOK); out.push({ joint: handle.joint, type: EFFECTOR.lookAt, target: send.lookAt, aim: [0, 0, 1] }); }
		if (send.rotation) { can(R); out.push({ joint: handle.joint, type: EFFECTOR.rotation, rot6d: as6d(send.rotation), tol: send.rotTol ?? DEFAULT_TOL }); }
	}
	return out;
}

/** Which way a rotation faces on the floor (radians about +Y): the direction of its +Z axis seen from above. */
export function headingOf(G, o = 0) {
	const fx = G[o + 2], fz = G[o + 8];
	return Math.hypot(fx, fz) < 1e-6 ? 0 : Math.atan2(fx, fz);
}

/**
 * What every handle sends for one pointer move. `state[id] = { enabled, held, tolerance, rotTolerance,
 * holdsRotation, place, turn, placed }` (place: press-time or user-left position; turn: global rotation, flat 3x3);
 * `drag = { id, target?, turn? }`.
 */
export function dragSends(state, drag) {
	const sends = [];
	const tolerance = (s) => s.tolerance ?? DEFAULT_TOL, rotTolerance = (s) => s.rotTolerance ?? DEFAULT_TOL;
	for (const handle of HANDLES) {
		const s = state[handle.id];
		if (!s?.enabled || handle.id === "body") continue;
		const send = { id: handle.id };
		if (handle.id === drag.id) {
			if (drag.target) {
				if (handle.id === "lookAt") send.lookAt = drag.target;
				else { send.position = drag.target; send.tol = Math.min(tolerance(s), 0.02); }
			}
			if (drag.turn) { send.rotation = drag.turn; send.rotTol = Math.min(rotTolerance(s), 0.02); }
			else if (s.holdsRotation && s.turn) { send.rotation = s.turn; send.rotTol = rotTolerance(s); }
		} else if (handle.id === "lookAt") {
			if (s.placed) send.lookAt = s.place;
			if (s.holdsRotation && s.turn) { send.rotation = s.turn; send.rotTol = rotTolerance(s); }
		} else if (s.held) {
			send.position = s.place; send.tol = tolerance(s);
			if ((HAND_IDS.has(handle.id) || s.holdsRotation) && s.turn) { send.rotation = s.turn; send.rotTol = rotTolerance(s); }
		} else if (handle.id === "hips") {
			const h = headingOf(s.turn ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]), c = Math.cos(h), sn = Math.sin(h);
			send.position = s.place; send.tol = Math.max(tolerance(s), 0.06);
			// a held rotation wins over the facing hint, the same way the tighter of two effectors wins
			if (s.holdsRotation && s.turn) { send.rotation = s.turn; send.rotTol = rotTolerance(s); }
			else { send.rotation = [c, 0, sn, 0, 1, 0, -sn, 0, c]; send.rotTol = 0.08; }
		} else if (s.holdsRotation && s.turn) { send.rotation = s.turn; send.rotTol = rotTolerance(s); }
		if (send.position || send.rotation || send.lookAt) sends.push(send);
	}
	return sends;
}
