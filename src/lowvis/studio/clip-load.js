// Loading a finished lowvis clip into the Studio by name (the QA hook window.__cozyclay.showLowvisClip), and the
// camera frame that shows the whole clip.
import * as THREE from "three";
import { clipBounds, clipUsable } from "../viewer/scene.js";

/** The clip public/lowvis/clips/pi/<name>.json, or null when it is missing or not a usable lowvis clip. */
export async function loadLowvisClip(name) {
	const res = await fetch(`${import.meta.env.BASE_URL}lowvis/clips/pi/${encodeURIComponent(name)}.json`, { cache: "no-store" });
	if (!res.ok) return null;
	try {
		const clip = JSON.parse(await res.text());
		return clipUsable(clip) ? clip : null;
	} catch {
		return null;
	}
}

/** What a camera frames to see the whole clip over all its frames: { target: { x, y, z }, radius } in metres. */
export function clipFrame(clip) {
	const box = clipBounds(clip), centre = box.getCenter(new THREE.Vector3());
	return { target: { x: centre.x, y: centre.y, z: centre.z }, radius: Math.max(1, box.getSize(new THREE.Vector3()).length() / 2) };
}
