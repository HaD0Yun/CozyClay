// Pose mode's hand overlays in the viewport: the finger handles (W tool) and the Auto Pose handles (E tool), mounted
// together so App renders one element for both. useFingerEdit comes through here because App drives the finger state
// these overlays draw.
import { FingerHandles } from "./finger-handles.jsx";
import { PoserHandles } from "./poser/ui/PoserHandles.jsx";

export { useFingerEdit } from "./finger-handles.jsx";

/** Props: the shared drag callbacks, then each overlay's own (`finger*` for FingerHandles, the rest for PoserHandles). */
export function PoseOverlays({ onSolve, onDragEnd, fingers, fingerEnabled, exposureProbeRef, rig, model, characterId, poserEnabled, onNotice }) {
	return (
		<>
			<FingerHandles fingers={fingers} enabled={fingerEnabled} onSolve={onSolve} onDragEnd={onDragEnd} exposureProbeRef={exposureProbeRef} />
			<PoserHandles rig={rig} model={model} characterId={characterId} enabled={poserEnabled} onSolve={onSolve} onDragEnd={onDragEnd} onNotice={onNotice} />
		</>
	);
}
