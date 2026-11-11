// One coarse navigation signal per gesture start, for onboarding surfaces: the camera tutorial (camera-tutorial.jsx)
// finishes its Look, Walk, Dolly and Orbit steps on it. controls.jsx announces; nothing else should.
/** `kind`: "fly" | "walk" | "dolly" | "orbit" | "pan"; `key`: the walk key just pressed (w a s d q e). */
export function announceNav(kind, key = null) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent("cozyclay:nav", { detail: { kind, key } }));
}
