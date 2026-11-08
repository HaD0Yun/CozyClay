// A/B for fix islands (src/shell/FixTools.jsx): while the view shows the take with its fixes, the take's original pose at
// the playhead is drawn as one faded ghost (pose-key-ghosts.jsx's look and layer: editor view only, no ray, no shadow),
// on frames a fix reaches. The original pose is read by posing the live rig without fixes, then the rig gets its pose back.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { bonesOf, ghostMaterial, ghostOf } from "./pose-key-ghosts.jsx";
import { holdBones, islandsOf } from "./motion/fix-weight.js";
import { useFixView } from "./motion/fix-door.js";

const none = () => () => {};
const EMPTY = [];

/** Pose the ghost as the original take at `frame`, or hide it. */
function showOriginal({ group, material, slot, rig, enabled, owner, characterId, frame }) {
	if (slot.rig !== rig) { if (slot.root) group.remove(slot.root); slot.root = null; slot.rig = rig; }
	const state = enabled ? owner.liveIkStates().get(characterId) : null;
	if (state) {
		const restore = holdBones(rig), view = state.fixView;
		let pose = null;
		try {
			state.fixView = "original";
			const posed = owner.poseRigAt(characterId, frame);
			pose = posed && bonesOf(posed).map((bone) => [bone.quaternion.clone(), bone.position.clone()]);
		} finally { state.fixView = view; restore(); }
		if (pose && !slot.root) { slot.root = ghostOf(rig, material); slot.root.name = "fix-original-ghost"; slot.bones = bonesOf(slot.root); group.add(slot.root); }
		if (pose) slot.bones.forEach((bone, i) => { if (pose[i]) { bone.quaternion.copy(pose[i][0]); bone.position.copy(pose[i][1]); } });
		if (slot.root) slot.root.visible = Boolean(pose);
	} else if (slot.root) slot.root.visible = false;
	// QA read (test/qa-fix-islands-browser.mjs): is the original pose shown, and at which frame
	window.__cozyclayFixGhost = { visible: Boolean(slot.root?.visible), frame };
}

function follow(group, rig) {
	if (!rig?.parent) return;
	group.matrix.copy(rig.parent.matrixWorld);
	group.matrixWorldNeedsUpdate = true;
}

/** app: the AppContext value; rig: the active character's live rig; on: Pose mode; hidden: looking through a shot. */
export function FixOriginalGhost({ app, rig, characterId, frame, on, hidden }) {
	const view = useFixView();
	const { scene, invalidate } = useThree();
	const owner = app?.storeDomain?.("motion") ?? null;
	const rows = useSyncExternalStore(owner?.documentStore.subscribe ?? none, () => (owner && characterId ? owner.read().find((row) => row.id === characterId)?.ikKeys ?? EMPTY : EMPTY));
	const reached = islandsOf(rows).some((island) => frame >= island.start && frame <= island.end);
	const enabled = Boolean(on && !hidden && rig && view === "fixed" && reached && owner?.motionFor(characterId));
	const material = useMemo(() => ghostMaterial(), []);
	const group = useMemo(() => { const node = new THREE.Group(); node.name = "fix-original-ghosts"; node.matrixAutoUpdate = false; return node; }, []);
	const slot = useRef({ rig: null, root: null, bones: [] });

	useEffect(() => { scene.add(group); return () => { scene.remove(group); }; }, [scene, group]);
	useEffect(() => () => material.dispose(), [material]);
	useEffect(() => {
		showOriginal({ group, material, slot: slot.current, rig, enabled, owner, characterId, frame });
		invalidate();
	}, [group, material, rig, enabled, owner, characterId, frame, rows, invalidate]);
	useFrame(() => follow(group, rig));
	return null;
}
