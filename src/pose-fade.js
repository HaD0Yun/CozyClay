export const POSE_FADE_DEFAULT = 0.2;
export const POSE_FADE_STORAGE_KEY = "cozyclay.poseObjectOpacity";

export function readPoseFadeOpacity(storage = globalThis.localStorage) {
	const value = Number(storage?.getItem?.(POSE_FADE_STORAGE_KEY));
	return storage?.getItem?.(POSE_FADE_STORAGE_KEY) == null || !Number.isFinite(value)
		? POSE_FADE_DEFAULT
		: Math.min(1, Math.max(0, value));
}

export function writePoseFadeOpacity(value, storage = globalThis.localStorage) {
	try { storage?.setItem?.(POSE_FADE_STORAGE_KEY, String(value)); } catch { return; }
}

// Keyed by material: a material shared by several meshes is recorded once, so the restore is exact.
const originals = new WeakMap();
// The opacity a faded material was authored with: its own times its object's, without the working fade.
const authored = new WeakMap();
/** How see-through a material is in the scene as authored. Pose mode's working fade is an editing aid, not a property
    of the set: a pass that reports the scene (the depth plate, render-passes.js) reads this, not the opacity drawn. */
export const authoredOpacity = (material) => authored.get(material) ?? material?.opacity;
const noRaycast = () => {};
// Keyed by mesh, not userData: R3F replaces an inline userData prop on re-render (#974).
const savedRaycasts = new WeakMap();

function materialsOf(mesh) {
	return Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
}

// Image captures in Pose mode want the set as authored: the working fade is lifted while this is set.
let fadeSuspended = false;
function suspendPoseFade(suspended) {
	fadeSuspended = suspended;
}

/** Runs `draw` with the working fade lifted. `sync` re-applies the fade to every prop; it runs
    again afterwards because a demand frame loop may not render another frame on its own. */
export function withPoseFadeLifted(sync, draw) {
	suspendPoseFade(true);
	sync?.();
	try {
		return draw();
	} finally {
		suspendPoseFade(false);
		sync?.();
	}
}

/** `fade` is Pose mode's working fade (null = off; a faded prop also stops catching clicks);
    `own` is the object's authored opacity (1 = solid). */
export function applyPoseFade(root, fade, own = 1) {
	const workingFade = fadeSuspended || fade == null || fade >= 1 ? 1 : fade;
	const opacity = workingFade * own;
	const faded = opacity < 1;
	const unpickable = workingFade < 1;
	root.traverse((node) => {
		if (!node.isMesh) return;
		for (const material of materialsOf(node)) {
			if (faded) {
				if (!originals.has(material)) {
					originals.set(material, { transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite });
				}
				authored.set(material, originals.get(material).opacity * own);
				const target = originals.get(material).opacity * opacity;
				if (material.opacity !== target || !material.transparent || material.depthWrite) {
					material.transparent = true;
					material.opacity = target;
					material.depthWrite = false;
					material.needsUpdate = true;
				}
			} else if (originals.has(material)) {
				Object.assign(material, originals.get(material));
				originals.delete(material);
				authored.delete(material);
				material.needsUpdate = true;
			}
		}
		if (unpickable && node.raycast !== noRaycast) {
			if (Object.hasOwn(node, "raycast")) savedRaycasts.set(node, node.raycast);
			node.raycast = noRaycast;
		} else if (!unpickable && node.raycast === noRaycast) {
			// Nothing saved means the prototype's method was in use: drop the own property.
			if (savedRaycasts.has(node)) node.raycast = savedRaycasts.get(node);
			else delete node.raycast;
			savedRaycasts.delete(node);
		}
	});
}
