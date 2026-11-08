// Pose mode's onion skin of the keyed poses: every IK key of the active character except the one
// on the playhead is drawn as a faded, desaturated ghost of the body in that pose, so all keyed
// poses read in one view. Ghosts sit on GIZMO_LAYER and take no ray or shadow: the working view
// shows them, the shot camera, captures and exports never do, and none of them can be picked.
// At most GHOST_MAX keys (the nearest to the playhead). A ghost's pose is read once per key set
// (the motion owner poses the live rig at that frame, then puts the playhead's pose back).
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { GIZMO_LAYER } from "./dualview.jsx";
import { usePoseGhosts } from "./motion/pose-key-door.js";

const GHOST_MAX = 8;
/** The ghosts' look: faded, desaturated, never writing depth. */
export const ghostMaterial = () => new THREE.MeshBasicMaterial({ color: "#9ca8b8", transparent: true, opacity: 0.2, depthWrite: false });
const noRay = () => {};
export const bonesOf = (root) => { const bones = []; root.traverse((node) => { if (node.isBone) bones.push(node); }); return bones; };

export function ghostOf(rig, material) {
	const copy = cloneSkeleton(rig);
	copy.traverse((node) => {
		node.layers.set(GIZMO_LAYER);
		node.raycast = noRay;
		node.castShadow = false;
		node.receiveShadow = false;
		if (node.isMesh) { node.material = material; node.frustumCulled = false; node.renderOrder = 38; }
	});
	copy.matrixAutoUpdate = true;
	return copy;
}

/** Pose the ghosts: read the key poses not read yet for this key set (then the playhead gets its pose
 * back), make enough clones, pose one per key frame and hide the rest. */
function showGhosts({ group, material, rig, enabled, owner, characterId, keys, frames, cache, slots, reset }) {
	if (slots.rig !== rig) { for (const slot of slots.list) group.remove(slot.root); slots.list = []; slots.rig = rig; }
	let byFrame = cache.byFrame;
	if (cache.keys !== keys) { byFrame = new Map(); reset({ keys, byFrame }); }
	const missing = enabled && owner ? frames.filter((f) => !byFrame.has(f)) : [];
	for (const f of missing) {
		const posed = owner.poseRigAt(characterId, f);
		if (posed) byFrame.set(f, bonesOf(posed).map((bone) => [bone.quaternion.clone(), bone.position.clone()]));
	}
	if (missing.length) owner.project?.();
	while (rig && enabled && slots.list.length < frames.length) { const root = ghostOf(rig, material); group.add(root); slots.list.push({ root, bones: bonesOf(root) }); }
	slots.list.forEach((slot, index) => {
		const pose = enabled && index < frames.length ? byFrame.get(frames[index]) : null;
		slot.root.visible = Boolean(pose);
		if (pose) slot.bones.forEach((bone, i) => { if (pose[i]) { bone.quaternion.copy(pose[i][0]); bone.position.copy(pose[i][1]); } });
	});
	// QA read (test/qa-pose-keys-browser.mjs): how many ghosts show, and at which key frames
	window.__cozyclayPoseGhosts = { count: slots.list.filter((slot) => slot.root.visible).length, frames: enabled ? frames.filter((f) => byFrame.has(f)) : [] };
}

function follow(group, rig, enabled) {
	if (!rig?.parent) { group.visible = false; return; }
	group.visible = enabled;
	group.matrix.copy(rig.parent.matrixWorld);
	group.matrixWorldNeedsUpdate = true;
}

/** app: the AppContext value; rig: the active character's live rig; on: Pose mode; hidden: looking through a shot. */
export function PoseKeyGhosts({ app, rig, characterId, frame, on, hidden }) {
	const shown = usePoseGhosts();
	const { scene, invalidate } = useThree();
	const owner = app?.storeDomain?.("motion") ?? null;
	const keys = (on && owner && characterId ? owner.layer(characterId)?.ikKeys : null) ?? null;
	const enabled = Boolean(shown && on && !hidden && rig && keys?.length);
	const frames = useMemo(() => (enabled ? [...new Set(keys.map((row) => row.frame))].filter((f) => f !== frame)
		.sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame) || a - b).slice(0, GHOST_MAX) : []), [enabled, keys, frame]);
	const material = useMemo(() => ghostMaterial(), []);
	const group = useMemo(() => { const node = new THREE.Group(); node.name = "pose-key-ghosts"; node.matrixAutoUpdate = false; return node; }, []);
	// key frame -> local bone rotations/positions, valid for one key set; one clone per ghost
	const cache = useRef({ keys: null, byFrame: new Map() });
	const slots = useRef({ rig: null, list: [] });

	useEffect(() => { scene.add(group); return () => { scene.remove(group); }; }, [scene, group]);
	useEffect(() => () => material.dispose(), [material]);
	useEffect(() => {
		showGhosts({ group, material, rig, enabled, owner, characterId, keys, frames, cache: cache.current, slots: slots.current, reset: (value) => { cache.current = value; } });
		invalidate();
	}, [rig, enabled, owner, characterId, keys, frames, group, material, invalidate]);
	// The ghosts stand where the character stands: under its parent's world matrix, like the rig.
	useFrame(() => follow(group, rig, enabled));
	return null;
}
