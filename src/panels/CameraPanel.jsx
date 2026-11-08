import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { Field } from "../ui.jsx";
import { VIDEO_MODEL_PRESETS } from "../model-presets.js";
import { useBus } from "../app-context.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { focusDistance } from "../camera-optics.js";
import CameraTransformPanel from "./CameraTransformPanel.jsx";

export default function CameraPanel({ isCameraSelection, shot, moveSequence, cameraKeys, activeShot }) {
	const { run } = useBus();
	const { startCameraPerformance, stopCameraPerformance, cameraPerformanceRecording, characters, sceneObjects, shotsDomain, runStudioAction } = useStudioShell();
	const optics = activeShot?.optics ?? { shiftX: 0, shiftY: 0, focusTargetId: null };
	const setOptics = patch => activeShot && runStudioAction("shot.setOptics", { shotId: activeShot.id, optics: { ...optics, ...patch } });
	const focusId = optics.focusTargetId;
	const focusCharacter = characters.find(entry => entry.id === focusId);
	const focusObject = sceneObjects.find(entry => entry.id === focusId);
	const cameraPosition = shotsDomain.state().camera?.position;
	const focusTarget = focusCharacter ? { x: focusCharacter.x, y: 1.3 * (focusCharacter.scale ?? 1), z: focusCharacter.z }
		: focusObject ? { x: focusObject.x, y: (focusObject.y ?? 0) + (focusObject.height ?? 0) / 2, z: focusObject.z } : null;
	const focusMeters = focusDistance(cameraPosition, focusTarget);
	// Transform first, as on every scene object, then the camera's own controls.
	return (<>
<CameraTransformPanel isCameraSelection={isCameraSelection} />
<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>
						<div className="readout v2-details-readout">
						<span title={ko("camera to subject", "카메라와 피사체 거리")}><small>{ko("Distance", "거리")}</small> {shot.distance.toFixed(2)} m</span>
						<span title={ko("nearest prime on the cropped filmback", "크롭된 필름백 기준 가장 가까운 단렌즈")}><small>{ko("Lens", "렌즈")}</small> {shot.focalMm} mm</span>
						<span title={ko("angle relative to the subject's eyes", "피사체 눈높이 기준 각도")}><small>{ko("Angle", "각도")}</small> {shot.elevationDeg.toFixed(0)}°</span>
						</div>
						<h3 className="move-head v2-details-subsection-title">{ko("Move keys", "움직임 키")}</h3>
						{moveSequence ? (
							<div className="move-slate v2-details-value-box" title={ko("derived from the keyframings, not chosen from a list", "목록에서 고른 값이 아니라 키프레임에서 계산된 움직임입니다")}>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
							</div>
						) : (
							<p className="inspector-hint v2-details-hint">
								{cameraKeys.length === 1
									? ko(`Locked-off hold from frame ${cameraKeys[0].frame}. Click the empty lower strip of a Shot block to add a move.`, `프레임 ${cameraKeys[0].frame}부터 고정 샷이에요. 샷 블록 아래 빈 줄을 클릭해 움직임을 추가하세요.`, `从第 ${cameraKeys[0].frame} 帧起为固定机位。点击镜头块下方的空条添加运动。`)
									: ko("Click a Shot block's lower strip to key the current framing at that frame.", "샷 블록 아래 빈 줄을 클릭하면 해당 프레임에 현재 프레이밍을 저장합니다.")}
							</p>
						)}

						<h3 className="move-head v2-details-subsection-title">{ko("Follow cam", "팔로우 카메라")}</h3>
						<p className="camera-editor-pointer">
							{activeShot
								? ko(`Editing ${activeShot.name} in the timeline camera bar below.`, `아래 타임라인 카메라 바에서 ${activeShot.name}을 편집합니다.`, `在下方时间线摄影机栏中编辑 ${activeShot.name}。`)
								: ko("Select a Shot block below to edit its camera.", "아래에서 샷 블록을 선택하면 카메라를 편집할 수 있습니다.")}
						</p>

						{/* Which generator this cut is being made FOR. Nothing here
						    re-times or re-crops the shot — the timeline simply warns
						    when the cut runs past the target's clip length or leaves
						    its delivery aspects. */}
						<h3 className="move-head v2-details-subsection-title">{ko("Camera performance", "퍼포먼스")}</h3>
						<button type="button" className="btn full" data-testid="camera-performance-record" disabled={!activeShot}
							onClick={cameraPerformanceRecording ? stopCameraPerformance : startCameraPerformance}>
							{cameraPerformanceRecording ? ko("Stop + save keys", "정지 + 키 저장") : ko("Record walk camera", "Walk 녹화")}
						</button>
						<p className="inspector-hint">{ko("Enters Look through. Right-drag and WASD record the shot; Stop writes one undo step.", "샷 시점으로 전환됩니다. 오른쪽 드래그·WASD로 촬영하고 정지하면 한 번의 실행 취소로 저장됩니다.")}</p>

						<h3 className="move-head v2-details-subsection-title">{ko("Optics", "광학")}</h3>
						<div className="v2-details-grid-2">
							<Field label={ko("Shift X", "시프트 X")}><input type="number" min="-0.5" max="0.5" step="0.01" value={optics.shiftX ?? 0} disabled={!activeShot}
								onChange={event => setOptics({ shiftX: Number(event.target.value) })} /></Field>
							<Field label={ko("Shift Y", "시프트 Y")}><input type="number" min="-0.5" max="0.5" step="0.01" value={optics.shiftY ?? 0} disabled={!activeShot}
								onChange={event => setOptics({ shiftY: Number(event.target.value) })} /></Field>
						</div>
						<Field label={ko("Focus target", "초점 대상")}>
							<select value={focusId ?? ""} disabled={!activeShot} onChange={event => setOptics({ focusTargetId: event.target.value || null })}>
								<option value="">{ko("None", "없음")}</option>
								{characters.map(entry => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
								{sceneObjects.map(entry => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
							</select>
						</Field>
						{focusMeters !== null && <p className="inspector-hint" data-testid="focus-distance">{ko(`Focus distance ${focusMeters.toFixed(2)} m · included in review burn-in`, `초점 거리 ${focusMeters.toFixed(2)} m · 리뷰 번인에 포함`)}</p>}

						<h3 className="move-head v2-details-subsection-title">{ko("Target model", "타깃 모델")}</h3>
						<p className="inspector-hint v2-details-hint">
							{ko("The timeline flags this shot when the cut runs past the model's clip length or leaves its delivery ratios. Nothing is re-timed or re-cropped.", "컷 길이나 화면 비율이 모델 한계를 벗어나면 타임라인이 표시해줘요. 자동으로 재조정하지는 않습니다.")}
						</p>
						<Field label={ko("Cut for", "맞출 모델")}>
							<select
								data-shot-target-model
								aria-label={ko("Target video model", "타깃 영상 모델")}
								disabled={!activeShot}
								value={activeShot?.targetModel ?? ""}
								onChange={(event) => run('shot.set', { id: activeShot.id, set: { targetModel: event.target.value || null } })}
							>
								<option value="">{ko("None", "없음")}</option>
								{VIDEO_MODEL_PRESETS.map((entry) => (
									<option key={entry.id} value={entry.id}>{entry.name}</option>
								))}
							</select>
						</Field>
					</Foldout>
	</>);
}
