import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFBX } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";
import { ProxyFigure } from "./proxy-figure.jsx";
import { ImportedCharacter } from "./imported-character.jsx";
import { isImportedCharacter } from "./character-rig.js";
import { isProxyFigure } from "./scenes.js";
import { applyPartColours } from "./part-colours.js";
import { applyHipsOffset, applyPose, primeBindPose } from "./poses.js";
import { REST_BONES } from "./stage-startup-defaults.js";
import { playbackFrame, usePlaybackSnapshot } from "./motion/playback-frame-store.js";
import { placementAt } from "./root-path.js";
import { shotAtFrame } from "./cuts.js";
import { sampleAt } from "./sample-at.js";

// Memoized: unchanged cast members skip re-rendering on every playhead tick.
export const Character = memo(function Character({ character, ...props }) {
	// an imported character (character-import.js) plays on its own file's bones
	if (isImportedCharacter(character)) return <ImportedCharacter {...props} character={character} />;
	return isProxyFigure(props) ? <ProxyFigure {...props} /> : <RiggedCharacter {...props} />;
});

export const PlaybackCharacter = memo(function PlaybackCharacter({
	entry,
	clip,
	shots,
	...props
}) {
	const frame = usePlaybackSnapshot(playbackFrame);
	const placement = placementAt(entry, frame, {
		shotAt: (at) => shotAtFrame(shots, at),
		takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
	});
	return (
		<Character
			{...props}
			character={entry}
			position={[placement.x, entry.y ?? 0, placement.z]}
			rot={placement.rot}
			pose={clip ? null : (placement.pose ?? props.pose)}
			posture={placement.posture}
		/>
	);
});

const RiggedCharacter = memo(function RiggedCharacter({ url, position, rot, tint, pose, scale = 1, onRig, pickId, partColoursEnabled = false, partColoursMode = "shaded" }) {
	const fbx = useFBX(url);
	const model = useMemo(() => {
		const clone = SkeletonUtils.clone(fbx);
		// Mixamo exports centimetres; `scale` is the FILMED person's stature.
		// THE INVARIANT: extraction divided this take's root travel by that
		// stature, so the clip and the scale must travel together — apply one
		// without the other and every stride overshoots by the same factor and
		// the feet skate. It belongs HERE, on the world transform, and never
		// inside rig space: playback.js derives prep.scale from the bind pose,
		// so a scaled bone hierarchy would be measured as a different rig.
		clone.scale.setScalar(0.01 * scale);
		clone.traverse((child) => {
			if (child.isMesh) {
				// warm clay reads as a maquette; cold grey reads as a broken render.
				// Its colour is the tint, set below in place.
				child.material = new THREE.MeshStandardMaterial({
					// A slightly tighter highlight gives the clay enough form to read
					// at blocking distance without turning it into shiny plastic.
					roughness: 0.66,
					metalness: 0,
					envMapIntensity: 0.35,
				});
				child.frustumCulled = false;
				// The subject's own shadow is what plants it on the deck; a blocking
				// frame without one leaves the figure floating over flat colour.
				child.castShadow = true;
				child.receiveShadow = true;
			}
		});
		if (partColoursEnabled) applyPartColours(clone, partColoursMode);
		// Stamp the bind pose while the rig is still untouched: the pose effect
		// below runs immediately after and would otherwise be baked into "rest".
		primeBindPose(clone);
		return clone;
	}, [fbx, partColoursEnabled, partColoursMode]);

	// The tint recolours the clay in place, before the next frame. It must not rebuild the clone: a colour
	// picker streams a value every drag frame, and a new clone re-binds the rig (playback, IK, contact radii).
	// The joint shells (Alpha_Joints / Beta_Joints — elbows, knees, the exoskeleton bands) take a darkened
	// shade of the body tint so the segments read as separate pieces. The shipped clay is intentionally pale,
	// but the stage deck is pale too: a small value drop keeps the authored hue and restores silhouette
	// contrast in the editor. Part colours paint the vertices themselves and keep their white material.
	const invalidate = useThree((state) => state.invalidate);
	useLayoutEffect(() => {
		if (partColoursEnabled) return;
		const bodyTint = new THREE.Color(tint).multiplyScalar(0.9);
		const jointTint = bodyTint.clone().multiplyScalar(0.62);
		model.traverse((child) => {
			if (child.isMesh) child.material.color.copy(/_Joints$/i.test(child.name) ? jointTint : bodyTint);
		});
		invalidate();
	}, [model, tint, partColoursEnabled, invalidate]);

	// A new stature (a fresh extraction on this character) must not rebuild the
	// clone — that would drop the rig the playback effects hold. Only the world
	// transform moves; the same invariant as above applies.
	useEffect(() => {
		model.scale.setScalar(0.01 * scale);
	}, [model, scale]);

	useEffect(() => {
		// During playback the pose prop is null and the motion drives the rig;
		// this effect can flush AFTER the playback effect in a later commit
		// (measured: playback at t, pose reset at t+1.8ms), and resetting to
		// REST then would clobber the animation back to the bind pose. So a
		// null pose means "playback owns the rig" — do not touch it.
		if (!pose) return;
		// every joint is reset first, otherwise switching presets leaves stale limbs
		applyPose(model, { ...REST_BONES, ...pose.bones });
		// A measured pose (photo, bottled take frame) carries its hips height;
		// rotations alone would leave a crouch floating at standing height.
		applyHipsOffset(model, pose.rootY ?? 0);
	}, [model, pose]);

	const onRigRef = useRef(onRig);
	onRigRef.current = onRig;
	// Report on MODEL change only — a per-render callback identity change
	// must not re-run this effect.
	useEffect(() => {
		onRigRef.current?.(model);
	}, [model]);

	return (
		// characterPick makes the body a first-class click target: the Scene
		// picker walks up from any hit mesh, finds the tag, and routes the
		// selection to the hierarchy so the Inspector owns the controls.
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]} userData={pickId ? { characterPick: pickId } : undefined}>
			<primitive object={model} />
		</group>
	);
});
