import * as THREE from "three";
import { objectSize } from "./scene-objects.js";

// The ObjectGizmo's fixed parts: handle layout, sizes, colours and the two
// placement rules (where the gizmo stands, and which way its rings face).
export const AXES = [
	{ axis: "x", dir: new THREE.Vector3(1, 0, 0), color: "#ff5340" },
	{ axis: "y", dir: new THREE.Vector3(0, 1, 0), color: "#54e05c" },
	{ axis: "z", dir: new THREE.Vector3(0, 0, 1), color: "#3d8bff" },
];
/** the same three directions, addressable by the record's axis key */
export const AXIS_VECTORS = { x: AXES[0].dir, y: AXES[1].dir, z: AXES[2].dir };
/** Move-tool plane handles. Unity colours each square after the axis it LOCKS,
 * so the blue square (z locked) slides in xy. `normal` is the pinned axis. */
export const PLANES = [
	{ id: "xz", axes: ["x", "z"], normal: "y", color: "#54e05c" },
	{ id: "xy", axes: ["x", "y"], normal: "z", color: "#3d8bff" },
	{ id: "yz", axes: ["y", "z"], normal: "x", color: "#ff5340" },
];
export const PLANE_OFFSET = 0.26; // where the square sits along each of its two axes
export const PLANE_SIZE = 0.2;
export const ARROW_LEN = 0.62;
export const SHAFT_R = 0.016;
export const TIP_R = 0.05;
export const TIP_LEN = 0.14;
export const RING_R = 0.52;
/**
 * The axis rings are drawn as two half-tori instead of one full torus. A full
 * ring is misleading: the half facing away from the camera is pixel-identical
 * to the near half, so a drag started on the far side reads backwards.
 * Depth-sorting the ring against the object would only help when the object
 * is big enough to occlude the far half — the gizmo sits at the object's
 * centre and the ring is only 0.52 m across, so for the small props a
 * blocking tool is full of, the far half projects outside the silhouette and
 * stays ambiguous. Fading it instead (FAR_HALF_ALPHA vs the near half's
 * 0.95) is unambiguous at every object size and camera angle. Only the drawn
 * halves fade — the pick proxy stays one full invisible torus per ring.
 */
export const FAR_HALF_ALPHA = 0.28;
/** the outer screen-space ring: larger than the axis rings (RING_R) so it
 * encloses them from every angle, and far enough out that its pick band
 * [0.61, 0.75] clears the axis rings' [0.45, 0.59] — the two can never fight
 * for a grab. (§3.3: "a larger circle enclosing the sphere, drawn flat to
 * the viewer" — rotates about the view axis.) */
export const SCREEN_RING_R = 0.68;
/** Unity's yellow for the handle being dragged — and, after release, for the
 * last-dragged one, until the selection or the tool changes (§3.1). */
export const ACTIVE_COLOR = "#ffd23d";
export const RING_TUBE = 0.022;
export const BOX_SIZE = 0.09; // scale-mode axis knobs
export const CENTRE_BOX = 0.11; // uniform-scale knob at the pivot
/** Pick proxies. A drawn 1.6 cm shaft is ~3 screen pixels — nothing anyone can
 * reliably grab — so hit testing runs against invisible fat volumes around each
 * arrow, ring and knob, the way every DCC gizmo does it. */
export const PICK_SHAFT_R = 0.09;
export const PICK_TUBE_R = 0.07;
export const PICK_CENTRE_R = 0.16;
/** metres of gizmo per metre of camera distance: keeps it a constant size on
 * screen whether the object is at the lens or across the room */
export const SCREEN_SCALE = 0.12;

/** the object's own centre height, where the gizmo sits */
function gizmoHeight(object) {
	return (object.y ?? 0) + Math.max(objectSize(object).height / 2, 0.25);
}

/** the handles-Map key a pick entry was registered under — the same
 * expression __gizmoPick reports, so highlights and QA hooks agree on handle
 * identity */
export function handleKey(entry) {
	if (entry.corner) return `corner:${entry.corner.id}`;
	return entry.axis ?? (entry.plane ? `plane:${entry.plane.id}` : "centre");
}

/**
 * The four corners of a cutout card, in the card's own local space.
 *
 * A standee is a picture, and a picture is resized by its corners — grabbing
 * one and pulling is the gesture everybody already has for "make this bigger",
 * and unlike an axis knob it says which way is bigger without reading a label.
 * `sx`/`sy` are which way each corner lies from the centre, so the drag can
 * measure travel along the diagonal that corner actually points down.
 */
export const CARD_CORNERS = [
	{ id: "tr", sx: 1, sy: 1 },
	{ id: "tl", sx: -1, sy: 1 },
	{ id: "br", sx: 1, sy: -1 },
	{ id: "bl", sx: -1, sy: -1 },
];
export const CORNER_BOX = 0.085;
export const PICK_CORNER_R = 0.13;

/**
 * Screen-space ring result: the object rotated `deltaDeg` about the world
 * `viewAxis`, written back as all three Euler channels in one patch. The
 * stored channels are Euler degrees per world axis, so the drag-start
 * orientation is composed with the delta in quaternion space and decomposed
 * again in the same order the renderer uses — exact for any start
 * orientation, where a single-channel approximation would drift. Snap
 * quantizes the accumulated delta to the same 5° grid the axis rings snap
 * their start+delta to (start values are always on the grid themselves).
 */

// Path authoring intersects presses with the set floor, exactly where a
// dropped pin will live.
export const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Where the gizmo stands: on the pose a take draws the object at (`held.pose`, held-object-edit.jsx), else at the authored centre. */
export function gizmoOrigin(object, held, out) {
	return held?.pose ? out.fromArray(held.pose.centre) : out.set(object.x, gizmoHeight(object), object.z);
}

/** The rotation the handles take: the drawn object's own axes while a held-object drag edits it in rotate mode, else none (world axes). */
export function gizmoTurn(held, mode) {
	return mode === "rotate" && held?.editable ? held.pose.quat : null;
}
