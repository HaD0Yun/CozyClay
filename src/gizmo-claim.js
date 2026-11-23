// Which GIZMO_LAYER surfaces own the press under them (#81).
//
// GIZMO_LAYER carries two very different kinds of things: grabbable handles
// whose own listeners run AFTER ObjectGizmo's window-capture selection handler
// (the twin gizmo's pick proxies, the key-light sun, path and crane dots), and
// pure furniture that owns no press at all (the selection cage, the drawn
// arrows and rings, rail lines, floating labels). ObjectGizmo must yield a
// press aimed at the former — claiming it would deselect the character and
// kill the drag their handler was about to start — but treating EVERY layer
// hit as a claim let the SELECTED object's own cage veto a press aimed at a
// different object's body, so Cube -> Sphere selection never happened.
//
// The split is explicit marking: a surface that handles its own press carries
// one of these userData keys, everything else on the layer is furniture and
// never blocks selection. This module has no three.js import on purpose — the
// predicate is plain ancestor-walking, directly testable under Node.

/** ObjectGizmo's own pick proxies (register* stamps this on every proxy). */
export const HANDLE_PROXY_FLAG = "gizmoHandleProxy";

/**
 * userData keys whose owner handles the press itself. `shotCameraPick` is
 * deliberately absent: the camera ghost is a selection TARGET for
 * ObjectGizmo's pickObject, so its press must fall through to selection.
 */
const CLAIM_KEYS = [
	HANDLE_PROXY_FLAG,
	"keyLightPick", // the key-light sun's grab surfaces (app-stage KeyLightPuck)
	"pathAxis", // travel path: axis-gizmo pick proxies (app-stage ObjectPathHandles)
	"pathIndex", // travel path: mark dots — index 0 is a valid value
	"pathRing", // travel path: the selected dot's bank / pitch rings
	"pathLine", // travel path: the drawn route itself — a press near it is aimed at the route
	"craneAxis", // crane marks: axis-gizmo pick proxies (app-stage CraneHandles)
	"craneIndex", // crane marks: height dots
	"craneRing", // crane marks: the selected mark's pan / tilt rings under the rotate tool (CraneTurnRings)
];

/** Whether this hit object — or any ancestor — is a marked press-claimer. */
export function isPressClaimer(object3d) {
	for (let node = object3d; node; node = node.parent) {
		const data = node.userData;
		if (!data) continue;
		for (const key of CLAIM_KEYS) if (data[key] !== undefined) return true;
	}
	return false;
}

/** Whether any raycast hit in the list lands on a press-claimer. */
export function claimsPress(hits) {
	return hits.some((hit) => isPressClaimer(hit.object));
}
