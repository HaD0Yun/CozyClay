import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { Vector3Row } from "../ui.jsx";
import { useStudioShell } from "../shell/studio-shell-context.js";

// The shot camera's Transform, the same Position / Rotation rows every scene
// object shows. Edits go through the gizmo's own path (setShotCameraTransform),
// so typing, scrubbing and dragging all commit the same manual framing.
// Rotation X is the tilt, Y the pan; the shot camera has no roll, so Z is shown
// and held at 0.
export default function CameraTransformPanel({ isCameraSelection }) {
	const { shotCameraTransform: camera, setShotCameraTransform } = useStudioShell();
	if (!camera) return null;
	const set = (patch) => setShotCameraTransform?.(patch);
	return (
		<Foldout hidden={!isCameraSelection} title={ko("Transform", "변환")}>
			<div data-testid="camera-transform">
				<p className="inspector-hint v2-details-hint">
					{ko("Type a value and press Enter, or drag a number sideways to scrub (Shift for fine).", "값을 입력하고 Enter를 누르거나 숫자를 좌우로 끌어 조절하세요(Shift는 미세 조정).")}
				</p>
				<Vector3Row
					label={ko("Position", "위치")}
					fields={[
						{ axis: "X", value: camera.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x) => set({ x }) },
						{ axis: "Y", value: camera.y, step: 0.05, precision: 2, scrubRange: 5, onChange: (y) => set({ y }) },
						{ axis: "Z", value: camera.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z) => set({ z }) },
					]}
				/>
				<Vector3Row
					label={ko("Rotation", "회전")}
					fields={[
						{ axis: "X", value: camera.pitch, step: 1, precision: 1, scrubRange: 85, onChange: (rotX) => set({ rotX }) },
						{ axis: "Y", value: camera.yaw, step: 1, precision: 1, scrubRange: 180, onChange: (rot) => set({ rot }) },
						{ axis: "Z", value: 0, step: 1, precision: 1, disabled: true, title: ko("The shot camera does not roll", "샷 카메라는 롤 회전이 없어요") },
					]}
				/>
			</div>
		</Foldout>
	);
}
