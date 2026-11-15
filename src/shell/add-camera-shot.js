// Add > Camera names the cut it made (ViewportToolbar). A refusal is already toasted by runStudioAction.
import { ko } from "../locale.js";

export function addCameraShot({ appContext, runStudioAction, setToast }) {
	const shots = appContext.storeDomain("shot"), before = shots.read(), receipt = runStudioAction("shot.create");
	const made = shots.read().find((row) => row.id === receipt?.affectedIds.find((id) => !before.some((old) => old.id === id)));
	if (!made) return;
	setToast(ko(`${made.name} added — a camera cut at frame ${made.startFrame}`, `${made.name} 추가됨 — ${made.startFrame}프레임에서 카메라 컷`, `${made.name} 已添加 — 第 ${made.startFrame} 帧的摄影机剪辑`));
}
