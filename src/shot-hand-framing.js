import { useEffect, useRef } from "react";

// A hand framing the shot camera (a fly or orbit drag, a wheel notch, a typed value) moves the camera first and asks
// the bus to keep the framing after. While an agent turn holds the scene the bus refuses it; the framing is then not
// kept, so the view goes back to the pose the hand began on: the shot camera never shows a framing the scene does not
// have. The rest of that press is not sent again (the bus told the user once); the next press, notch or key asks again.

function shotPose(shared) {
	const cam = shared.shotCamRef.current, look = shared.look.current;
	return cam && { position: cam.position.clone(), yaw: look.yaw, pitch: look.pitch, roll: look.roll ?? 0, fov: cam.fov };
}

function restoreShotPose(shared, pose) {
	const cam = shared.shotCamRef.current;
	if (!pose || !cam) return null;
	cam.position.copy(pose.position);
	Object.assign(shared.look.current, { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll });
	cam.rotation.order = "YXZ"; cam.rotation.set(pose.pitch, pose.yaw, pose.roll);
	if (cam.fov !== pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
	return null;
}

/** Arms the shots domain's gesture on every press (as before) and returns keep(capture): capture() is the bus call
 * that keeps the framing, settled to null when refused. */
export function useShotHandFraming(appContext, domain) {
	const hand = useRef({ pose: null, pressed: false, refused: false });
	// appContext is a new object every render (forRender): the listeners read the latest one through this ref, so they
	// are not torn down on a render. Tearing down cancels the open gesture, and a drag's own write renders the App.
	const latest = useRef(appContext);
	useEffect(() => { latest.current = appContext; });
	useEffect(() => {
		const start = () => { hand.current = { pose: shotPose(latest.current.shared), pressed: true, refused: false }; domain.beginGesture(); };
		// outside a press every wheel notch and key starts from the pose of its own moment, never from an old press's
		const notch = () => { if (!hand.current.pressed) hand.current = { pose: shotPose(latest.current.shared), pressed: false, refused: false }; };
		const release = () => { hand.current.pressed = false; hand.current.refused = false; }; // bubble phase: after the press's own end
		window.addEventListener("pointerdown", start, true); window.addEventListener("wheel", notch, { capture: true, passive: true }); window.addEventListener("keydown", notch, true);
		window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release);
		return () => {
			window.removeEventListener("pointerdown", start, true); window.removeEventListener("wheel", notch, { capture: true }); window.removeEventListener("keydown", notch, true);
			window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release);
			domain.finishGesture(true);
		};
	}, [domain]);
	return function keep(capture) {
		if (hand.current.refused) return restoreShotPose(appContext.shared, hand.current.pose);
		const receipt = capture();
		if (receipt === null) { hand.current.refused = true; restoreShotPose(appContext.shared, hand.current.pose); }
		return receipt;
	};
}
