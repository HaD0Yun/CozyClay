// Pose mode's viewport tools for the W/E/R keys: the IK parts (W), Auto Pose (E) and the range pin (R). Same entry
// shape as the other modes' tools in ViewportToolbar.jsx.
import { ko } from "../locale.js";

export function poseTools({ ikEditTool, setIkEditTool, motion, setRangePinPartPick }) {
	return [
		{ key: "W", id: "ik", name: ko("Pose fix (IK parts)", "포즈 수정 (IK 파츠)"), active: ikEditTool === "ik", pick: () => setIkEditTool("ik") },
		{ key: "E", id: "poser", name: ko("Auto Pose (drag a few handles, the body follows)", "자동 포즈 (핸들 몇 개를 끌면 몸이 따라와요)", "自动姿势（拖动几个控制点，身体随之调整）"), active: ikEditTool === "poser", pick: () => setIkEditTool("poser") },
		{
			key: "R", id: "pin", name: ko("Pin (range pin)", "고정 (범위 고정)"), active: ikEditTool === "pin",
			refused: motion ? null : ko("Pinning needs a motion take", "고정하려면 모션 테이크가 필요해요"),
			pick: () => { setIkEditTool("pin"); setRangePinPartPick(null); },
		},
	];
}
