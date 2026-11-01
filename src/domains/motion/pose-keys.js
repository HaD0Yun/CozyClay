// Pose mode's keying (the Sequencer key bar, src/shell/PoseKeyBar.jsx), for the motion owner (domains/motion.js): the rig as it
// plays at a frame, K over the whole body with where the character stands, and the placement track (motion/placement-keys.js).
import * as THREE from "three";
import { REST_BONES } from "../../app-stage.jsx";
import { createIkState, ikBakeKeyframe, ikEvaluate, resolveIkRig } from "../../motion/ik.js";
import { applyTakeFrame } from "../../motion3/playback.js";
import { DEFAULT_POSE, restoreBindPositions, applyPose, applyHipsOffset } from "../../poses.js";
import { restFingers } from "../../motion/fingers.js";
import { StudioProtocolError } from "../../studio-agent-protocol.js";
import { PLACEMENT_TRACK, placementTrackKey } from "../../motion/placement-keys.js";
import { encodeMotionKeys } from "./motion-intent-codec.js";

/** ports: { appContext, rigFor(id), visibleMotion(id), editKeys(id, mutate), run(id, args) }. */
export function createPoseKeys({ appContext, rigFor, visibleMotion, editKeys, run }) {
	// The rig as it plays at frame `at`: the take or the stage pose, then the IK keys (project; Pose mode's Fill reads keyed frames).
	function poseRig(id, rig, resolved, state, take, at) {
		restFingers(resolved.fkJoints); if (take) applyTakeFrame(rig, take, Math.min(at, take.frames - 1));
		else {
			const character = appContext.storeDomain('cast').read().find(entry => entry.id === id);
			restoreBindPositions(rig); applyPose(rig, { ...REST_BONES, ...(character?.pose ?? DEFAULT_POSE).bones });
			applyHipsOffset(rig, character?.pose?.rootY ?? 0);
		}
		ikEvaluate(resolved.chains, state, at, resolved.fkJoints, take ? 6 : 0);
	}
	function poseRigAt(id, at) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig), state = appContext.shared.ikStatesRef.current.get(id);
		if (!resolved || !state) return null;
		poseRig(id, rig, resolved, state, visibleMotion(id), at); rig.updateMatrixWorld(true);
		return rig;
	}
	// Pose mode's K: every part of the body as it stands at the playhead, plus where the character stands.
	function keyAll(id, at, placement) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'The character rig is not loaded.');
		const scratch = { ...createIkState(), tracked: new Set([...resolved.chains.keys(), ...resolved.fkJoints.keys()]) };
		ikBakeKeyframe(resolved.chains, scratch, at, resolved.fkJoints);
		const keyed = encodeMotionKeys(scratch.keys)[0]?.tracks ?? {};
		return run('ik.setKey', { characterId: id, frame: at, tracks: { ...keyed, [PLACEMENT_TRACK]: placementTrackKey(placement) } });
	}
	function setPlacementKey(id, at, placement) {
		editKeys(id, state => {
			if (!state.keys.has(at)) state.keys.set(at, new Map());
			state.keys.get(at).set(PLACEMENT_TRACK, { q: null, p: new THREE.Vector3(placement.x, placement.rot, placement.z) });
		});
	}
	return { poseRig, poseRigAt, keyAll, setPlacementKey };
}
