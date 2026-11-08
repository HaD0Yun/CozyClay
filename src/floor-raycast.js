// Screen -> floor: where a pointer event on `element`, seen through `camera`,
// meets the y = 0 floor. The Top-View rail and path strokes (planview.jsx) and
// the stage's route sketch (context-chip-tools.jsx) share it.
import * as THREE from "three";

export const createFloorRaycastTools = () => ({
	raycaster: new THREE.Raycaster(),
	plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
	pointer: new THREE.Vector2(),
	hit: new THREE.Vector3(),
});

/** The floor point under the pointer (tools.hit, reused), or null off the floor. */
export function floorPointAt(event, element, camera, tools) {
	if (!camera || !element) return null;
	const r = element.getBoundingClientRect();
	if (r.width < 2 || r.height < 2) return null;
	tools.pointer.set(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
	tools.raycaster.setFromCamera(tools.pointer, camera);
	return tools.raycaster.ray.intersectPlane(tools.plane, tools.hit) ? tools.hit : null;
}
