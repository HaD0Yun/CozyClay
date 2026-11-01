// Moves the editor view (the camera the user looks through, not the shot camera). FlyControls rewrites the camera's rotation
// from the look angles every frame, so a bare camera.lookAt is overwritten before the next paint: set both.
import { aimAt } from "./controls.jsx";

export function frameEditorView(camera, look, position, target) {
	if (!camera) return false;
	const angles = aimAt(position, target);
	look.yaw = angles.yaw;
	look.pitch = angles.pitch;
	camera.position.set(position.x, position.y, position.z);
	camera.rotation.order = "YXZ";
	camera.rotation.set(angles.pitch, angles.yaw, 0);
	camera.updateProjectionMatrix();
	return true;
}
