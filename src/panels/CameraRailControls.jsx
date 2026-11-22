import { useState } from "react";
import { ko } from "../locale.js";
import { Vector3Row } from "../ui.jsx";
import { createCameraBlock } from "../camera-block.js";
import { characterName } from "../character-name.js";
import { railShownPitchDeg, toggleRailHeadFollow } from "../camera-rail-head.js";
import { RAIL_AIM_FEEL, readRailAimFeel, writeRailAimFeel } from "../rail-aim-feel.js";

const AIM_IDS_MAX = 4;

/** Who a follow or rail shot follows: a rail with a cast aim names it there, any other shot in subjectIds. */
function followedIds(shot, camera) {
	if (camera.mode === "rail" && camera.aim?.ids) return camera.aim.ids;
	return shot.subjectIds ?? [];
}

/**
 * Which characters the shot follows, and on a rail whether its head turns to
 * them and the angle the user gave it. `shown` is the camera at the playhead.
 */
export function CameraFollowControls({ shot, characters, sceneObjects, shown, runStudioAction }) {
	const camera = createCameraBlock(shot.camera);
	if (camera.mode === "keys") return null;
	const rail = camera.mode === "rail" && !!camera.cameraRail, head = camera.head ?? null, follows = head?.follow !== false;
	const picked = followedIds(shot, camera), names = new Map([...characters, ...sceneObjects].map((entry) => [entry.id, entry.name ?? entry.id]));
	const setCamera = (patch) => runStudioAction("shot.setCamera", { shotId: shot.id, patch });
	const pick = (id) => {
		const next = picked.includes(id) ? picked.filter((entry) => entry !== id) : [...picked, id];
		if (rail && camera.aim?.ids) setCamera({ aim: next.length ? { ...camera.aim, ids: next.slice(0, AIM_IDS_MAX) } : null });
		else runStudioAction("shot.set", { id: shot.id, set: { subjectIds: next } });
	};
	// An aimless rail still tilts by the follow pitch it had before the head existed; the field shows the sum.
	const legacyPitch = rail && !camera.aim && follows ? camera.followCam.pitchOffsetDeg : 0;
	const setHead = (patch) => setCamera({ head: { ...(follows ? {} : { follow: false }), yawDeg: head?.yawDeg ?? 0, pitchDeg: head?.pitchDeg ?? 0, ...patch } });
	const missing = picked.filter((id) => !characters.some((entry) => entry.id === id));
	return (
		<div data-testid="camera-follow-controls">
			<div className="v2-details-field" role="group" aria-label={ko("Follows", "따라갈 대상", "跟随对象")}>
				<label>{ko("Follows", "따라갈 대상", "跟随对象")}</label>
				<div className="camera-follow-pick">
					{characters.map((entry, index) => (
						<button key={entry.id} type="button" className="btn" aria-pressed={picked.includes(entry.id)}
							data-testid={`camera-follow-subject-${entry.id}`} disabled={rail && !follows} title={characterName(entry)} onClick={() => pick(entry.id)}>
							{/* the Outliner's name for the row */}
							{ko(`Character ${index + 1}`, `인물 ${index + 1}`, `角色 ${index + 1}`)}
						</button>
					))}
					{missing.map((id) => (
						<button key={id} type="button" className="btn active" aria-pressed="true" data-testid={`camera-follow-subject-${id}`} onClick={() => pick(id)}>
							{names.has(id) ? names.get(id) : ko(`${id} (removed)`, `${id} (삭제됨)`, `${id}（已删除）`)}
						</button>
					))}
				</div>
			</div>
			<p className="inspector-hint v2-details-hint" data-testid="camera-follow-hint">
				{!picked.length
					? ko("Nobody picked: the camera follows the selected character. Pick one or more to keep following them whatever is selected.", "선택 없음: 카메라가 지금 선택한 캐릭터를 따라갑니다. 하나 이상 고르면 무엇을 선택하든 그 캐릭터를 따라갑니다.", "未选择：摄影机跟随当前选中的角色。选择一个或多个后，无论选中什么都跟随它们。")
					: missing.some((id) => !names.has(id))
						? ko("A picked character is gone: the camera holds still and follows no one else. Unpick it, pick another, or Undo the removal.", "고른 캐릭터가 없어졌습니다: 카메라는 멈춰 있고 다른 캐릭터를 따라가지 않습니다. 선택을 풀거나 다른 캐릭터를 고르거나 삭제를 실행 취소하세요.", "所选角色已不存在：摄影机保持不动，不会改跟其他角色。取消选择、另选角色或撤销删除。")
						: ko("The camera follows the picked characters (their middle when several).", "카메라가 고른 캐릭터를 따라갑니다(여럿이면 그 가운데).", "摄影机跟随所选角色（多个时取其中心）。")}
			</p>
			{rail && <>
				<button type="button" className="btn full camera-head-follow" aria-pressed={follows} data-testid="camera-head-follow"
					onClick={() => setCamera({ head: toggleRailHeadFollow(head, shown ?? { yaw: 0, pitch: 0 }) })}>
					{follows ? ko("Turn to subject: On", "대상 바라보기: 켜짐", "朝向对象：开") : ko("Turn to subject: Off", "대상 바라보기: 꺼짐", "朝向对象：关")}
				</button>
				{/* Y pans and X tilts, as in the Transform's Rotation row */}
				<div data-testid="camera-head-angle">
					<Vector3Row label={follows ? ko("Offset °", "오프셋 °", "偏移 °") : ko("Angle °", "각도 °", "角度 °")} fields={[
						{ axis: "Y", value: head?.yawDeg ?? 0, step: 1, precision: 1, scrubRange: 90, onChange: (yawDeg) => setHead({ yawDeg }),
							title: follows ? ko("Pan offset from the subject; positive turns left", "대상 기준 팬 오프셋, 양수는 왼쪽", "相对对象的水平偏移，正值向左") : ko("Pan; positive turns left", "팬, 양수는 왼쪽", "水平，正值向左") },
						{ axis: "X", value: railShownPitchDeg(camera, camera.followCam.pitchOffsetDeg), step: 1, precision: 1, scrubRange: 45, onChange: (value) => setHead({ pitchDeg: value - legacyPitch }),
							title: follows ? ko("Tilt offset from the subject; positive looks up", "대상 기준 틸트 오프셋, 양수는 위", "相对对象的俯仰偏移，正值向上") : ko("Tilt; positive looks up", "틸트, 양수는 위", "俯仰，正值向上") },
					]} />
				</div>
				<p className="inspector-hint v2-details-hint">
					{follows
						? ko("Turn the camera by hand (right-drag in Look through, the rotate gizmo, or these fields): the rail keeps that turn from the subject over the whole shot.", "카메라를 손으로 돌리면(샷 시점에서 오른쪽 드래그, 회전 기즈모, 이 칸) 레일이 대상에서 그만큼 돌린 각도를 샷 내내 유지합니다.", "手动转动摄影机（镜头视角中右键拖动、旋转控件或这些字段）：轨道在整个镜头中保持相对对象的这一偏转。")
						: ko("The head turns to no one: it holds the angle you set by hand over the whole rail.", "대상을 바라보지 않습니다: 손으로 정한 각도를 레일 내내 유지합니다.", "不朝向任何对象：整条轨道保持手动设定的角度。")}
					{" "}{ko("A recorded aim take replaces this angle on its frames; Discard take to use it again.", "녹화한 시선은 그 프레임에서 이 각도를 대신합니다. 다시 쓰려면 촬영본을 삭제하세요.", "已录制的朝向在其帧上替代此角度；放弃此条即可恢复。")}
				</p>
			</>}
		</div>
	);
}

/** Aim recording's reaction to the mouse: the user's own setting, kept in this browser. */
export function RailAimFeelControls({ disabled }) {
	const [feel, setFeel] = useState(readRailAimFeel);
	const change = (patch) => { const next = { ...feel, ...patch }; setFeel(next); writeRailAimFeel(next); };
	const row = (key, label, unit, places, title) => (
		<div className="matte-slider" key={key} title={title}>
			<label htmlFor={`rail-aim-${key}`}>{label}</label>
			<input type="range" id={`rail-aim-${key}`} data-testid={`rail-aim-${key}`} min={RAIL_AIM_FEEL[key].min} max={RAIL_AIM_FEEL[key].max} step={RAIL_AIM_FEEL[key].step}
				value={feel[key]} disabled={disabled} onChange={(event) => change({ [key]: Number(event.currentTarget.value) })} />
			<output data-testid={`rail-aim-${key}-value`}>{feel[key].toFixed(places)} {unit}</output>
		</div>
	);
	return (
		<div data-testid="rail-aim-feel">
			{row("sensitivity", ko("Sensitivity", "감도", "灵敏度"), "°/100px", 1,
				ko("How far the camera turns per 100 px of mouse travel while recording the aim (the look in the viewport turns 18.3)", "시선 녹화 중 마우스 100 px당 카메라가 도는 각도 (뷰포트 시점 조작은 18.3)", "录制朝向时鼠标每移动 100 px 摄影机转动的角度（视口视角为 18.3）"))}
			{row("smoothing", ko("Smoothing", "부드럽게", "平滑"), ko("s", "초", "秒"), 2,
				ko("Time constant of the filter the recorded aim passes through: a steady pan, late by about this much; 0 records the raw mouse", "녹화되는 시선이 거치는 필터의 시간 상수: 고른 팬이 되며 대략 이만큼 늦습니다. 0은 마우스 그대로", "录制朝向所经滤波的时间常数：得到平稳的摇镜，约滞后这么多；0 为原始鼠标"))}
		</div>
	);
}
