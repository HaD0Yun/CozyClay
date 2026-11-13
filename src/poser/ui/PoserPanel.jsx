// Pose Details section of the Auto Pose tool: model status (loading, ready, failed with retry), the hint of the last
// solve, whole-pose actions, and per-handle switches (on, held, hold rotation, tolerance) for the selected handle.
import { ko } from "../../locale.js";
import { HANDLES } from "../handles.js";
import { canMove, canTurn, TOLERANCE_MAX, TOLERANCE_MIN } from "./handle-state.js";
import { ensurePoserNetwork } from "./model-host.js";
import { usePoserState } from "./poser-store.js";
import "./poser.css";

const HANDLE_NAMES = {
	hips: () => ko("Hips", "골반", "髋部"),
	spineLow: () => ko("Lower spine", "아래 척추", "下脊柱"),
	spineMid: () => ko("Mid spine", "가운데 척추", "中脊柱"),
	chest: () => ko("Chest", "가슴", "胸部"),
	neck: () => ko("Neck", "목", "颈部"),
	head: () => ko("Head", "머리", "头部"),
	lookAt: () => ko("Look at", "시선", "注视点"),
	leftShoulder: () => ko("Left shoulder", "왼쪽 어깨", "左肩"),
	rightShoulder: () => ko("Right shoulder", "오른쪽 어깨", "右肩"),
	leftHand: () => ko("Left hand", "왼손", "左手"),
	rightHand: () => ko("Right hand", "오른손", "右手"),
	leftElbow: () => ko("Left elbow", "왼쪽 팔꿈치", "左肘"),
	rightElbow: () => ko("Right elbow", "오른쪽 팔꿈치", "右肘"),
	leftFoot: () => ko("Left foot", "왼발", "左脚"),
	rightFoot: () => ko("Right foot", "오른발", "右脚"),
	leftKnee: () => ko("Left knee", "왼쪽 무릎", "左膝"),
	rightKnee: () => ko("Right knee", "오른쪽 무릎", "右膝"),
	leftToes: () => ko("Left toes", "왼발가락", "左脚趾"),
	rightToes: () => ko("Right toes", "오른발가락", "右脚趾"),
};
const IDS = HANDLES.map((h) => h.id).filter((id) => id !== "body");
const nameOf = (id) => HANDLE_NAMES[id]();
// The tolerance slider is logarithmic from 1 mm to 50 cm.
const LOG_SPAN = Math.log(TOLERANCE_MAX / TOLERANCE_MIN);
const toSlider = (v) => Math.round((1000 * Math.log(v / TOLERANCE_MIN)) / LOG_SPAN);
const fromSlider = (n) => TOLERANCE_MIN * Math.exp((n / 1000) * LOG_SPAN);

function hintText(hint, status, detail) {
	const name = detail?.id && HANDLE_NAMES[detail.id] ? nameOf(detail.id) : ko("A held handle", "고정된 핸들", "固定的控制点"), cm = Math.round(detail?.cm ?? 0);
	if (hint === "held-moved") return ko(`Stopped here: ${name} would move ${cm} cm from where it is held. Let it go or drag less far.`, `여기서 멈췄어요: ${name}이(가) 고정 위치에서 ${cm} cm 벗어나요. 고정을 풀거나 덜 끌어 주세요.`, `已停在这里：${name}会偏离固定位置 ${cm} 厘米。请取消固定或少拖一些。`);
	if (hint === "out-of-reach") return ko(`${name} cannot reach the dot: ${cm} cm short.`, `${name}이(가) 점까지 닿지 않아요: ${cm} cm 모자라요.`, `${name}够不到圆点：差 ${cm} 厘米。`);
	if (hint === "root-jump" || hint === "not-finite") return ko("That solve was not usable; the pose did not change.", "쓸 수 없는 결과라 포즈를 바꾸지 않았어요.", "该结果不可用，姿势未改变。");
	if (status === "unavailable") return ko("Auto Pose comes with the installed app (npx cozyclay). It is not available on this site; W and R work as usual.", "자동 포즈는 설치형 앱(npx cozyclay)에 들어 있어요. 이 사이트에서는 쓸 수 없어요. W와 R 도구는 그대로 쓸 수 있어요.", "自动姿势包含在安装版应用（npx cozyclay）中，本网站不提供。W 和 R 工具照常可用。");
	if (status === "failed") return ko("The model could not load. W and R still work.", "모델을 불러오지 못했어요. W와 R 도구는 그대로 쓸 수 있어요.", "模型无法加载。W 和 R 工具仍可使用。");
	if (hint === "no-position-effector") return ko("Nothing to solve: turn on a hand, foot, hips or another handle that holds a place.", "풀 수 없어요: 손, 발, 골반처럼 위치를 잡는 핸들을 하나 이상 켜세요.", "无法求解：请打开手、脚、髋部等能固定位置的控制点。");
	if (hint === "few-position-effectors") return ko("Tip: three or more handles that hold a place give steadier poses.", "팁: 위치를 잡는 핸들이 셋 이상이면 포즈가 더 안정돼요.", "提示：三个或更多固定位置的控制点会让姿势更稳定。");
	if (hint === "solve-failed") return ko("That solve failed; the pose did not change.", "계산에 실패해서 포즈가 바뀌지 않았어요.", "求解失败，姿势未改变。");
	return ko("Drag a dot: the body follows. Held dots stay put. Select a dot to turn it with the rings.", "점을 끌면 몸이 따라와요. 고정된 점은 그 자리에 있어요. 점을 고르면 고리로 돌릴 수 있어요.", "拖动圆点，身体随之调整。固定的圆点保持不动。选中圆点后可用圆环旋转。");
}

function ModelRow({ model }) {
	const label = model.status === "ready" ? ko("Ready", "준비됨", "就绪")
		: model.status === "failed" ? ko("Could not load", "불러오지 못함", "无法加载")
		: model.status === "unavailable" ? ko("Not on this site", "이 사이트에는 없음", "本网站不提供")
		: ko(`Loading ${Math.round((model.progress ?? 0) * 100)}%`, `불러오는 중 ${Math.round((model.progress ?? 0) * 100)}%`, `加载中 ${Math.round((model.progress ?? 0) * 100)}%`);
	return (<>
		<div className="pose-row" data-testid="poser-model" data-status={model.status}><span>{ko("Model", "모델", "模型")}</span><b>{label}</b></div>
		{model.status === "failed" && <div className="pose-actions"><button type="button" className="btn" data-testid="poser-retry" onClick={() => ensurePoserNetwork().catch(() => {})}>{ko("Try again", "다시 시도", "重试")}</button></div>}
	</>);
}

function HandleDetails({ id, s, ctrl }) {
	return (
		<div className="poser-handle-details" data-testid="poser-handle-details">
			<h5>{nameOf(id)}</h5>
			<label className="pose-row"><span>{ko("On", "켜기", "开启")}</span><input type="checkbox" data-testid="poser-enabled" checked={s.enabled} onChange={(e) => ctrl.setEnabled(id, e.target.checked)} /></label>
			{id !== "lookAt" && canMove(id) && <label className="pose-row"><span>{ko("Hold position", "위치 고정", "固定位置")}</span><input type="checkbox" data-testid="poser-held" checked={s.held} onChange={(e) => ctrl.setHeld(id, e.target.checked)} /></label>}
			{canTurn(id) && <label className="pose-row"><span>{ko("Hold rotation", "회전 고정", "固定旋转")}</span><input type="checkbox" data-testid="poser-hold-rotation" checked={s.holdsRotation} onChange={(e) => ctrl.setHoldsRotation(id, e.target.checked)} /></label>}
			{canMove(id) && <label className="pose-row pose-object-opacity"><span>{ko("Tolerance", "허용 오차", "容差")}</span>
				<input type="range" min={0} max={1000} step={1} data-testid="poser-tolerance" value={toSlider(s.tolerance)} onChange={(e) => ctrl.setTolerance(id, fromSlider(Number(e.target.value)))}
					aria-label={ko("How far the joint may stay from this handle", "관절이 이 핸들에서 떨어져도 되는 거리", "关节可偏离此控制点的距离")} />
				<b>{s.tolerance < 0.01 ? `${(s.tolerance * 1000).toFixed(0)} mm` : `${(s.tolerance * 100).toFixed(1)} cm`}</b></label>}
			{canTurn(id) && <label className="pose-row pose-object-opacity"><span>{ko("Turn tolerance", "회전 허용 오차", "旋转容差")}</span>
				<input type="range" min={0} max={1000} step={1} data-testid="poser-rotation-tolerance" value={toSlider(s.rotTolerance)} onChange={(e) => ctrl.setTolerance(id, fromSlider(Number(e.target.value)), { rotation: true })}
					aria-label={ko("How far the joint may turn from this handle's turn", "관절이 이 핸들의 회전에서 벗어나도 되는 정도", "关节可偏离此控制点旋转的程度")} />
				<b>{s.rotTolerance.toFixed(3)}</b></label>}
			{id === "lookAt" && s.placed && <div className="pose-actions"><button type="button" className="btn" onClick={() => ctrl.resetLookAt()}>{ko("Look ahead again", "다시 앞을 보기", "重新看向前方")}</button></div>}
		</div>
	);
}

/** The Auto Pose tool's Details section (Pose mode, tool E). */
export default function PoserPanel() {
	const { model, controller: ctrl, handles, selected, hint, detail, clipboard } = usePoserState();
	const ready = !!ctrl && !!handles;
	return (
		<section className="pose-section poser-panel" data-testid="poser-panel">
			<h4>{ko("Auto Pose", "자동 포즈", "自动姿势")}</h4>
			<ModelRow model={model} />
			<p className="inspector-hint" data-testid="poser-hint" data-hint={hint ?? ""}>{hintText(hint, model.status, detail)}</p>
			<div className="pose-actions">
				<button type="button" className="btn" data-testid="poser-reset" disabled={!ready} onClick={() => ctrl.reset()}>{ko("Back to T-pose", "T 포즈로", "回到 T 姿势")}</button>
				<button type="button" className="btn" data-testid="poser-flip" disabled={!ready} onClick={() => ctrl.flip()}>{ko("Flip left and right", "좌우 반전", "左右翻转")}</button>
				<button type="button" className="btn" data-testid="poser-copy" disabled={!ready} onClick={() => ctrl.copy()}>{ko("Copy pose", "포즈 복사", "复制姿势")}</button>
				<button type="button" className="btn" data-testid="poser-paste" disabled={!ready || !clipboard} onClick={() => ctrl.paste()}>{ko("Paste pose", "포즈 붙여넣기", "粘贴姿势")}</button>
				<button type="button" className="btn" data-testid="poser-paste-reversed" disabled={!ready || !clipboard} onClick={() => ctrl.paste({ reversed: true })}>{ko("Paste reversed", "반전해서 붙여넣기", "反向粘贴")}</button>
			</div>
			{ready && <div className="poser-chips" role="group" aria-label={ko("Handles", "핸들", "控制点")}>
				{IDS.map((id) => {
					const s = handles[id];
					return <button key={id} type="button" data-testid={`poser-handle-${id}`} aria-pressed={selected === id}
						className={"poser-chip" + (s.enabled ? " on" : "") + (s.enabled && (s.held || s.placed) && canMove(id) ? " held" : "") + (selected === id ? " selected" : "")}
						onClick={() => ctrl.select(id)}>{nameOf(id)}</button>;
				})}
			</div>}
			{ready && selected && handles[selected] && <HandleDetails id={selected} s={handles[selected]} ctrl={ctrl} />}
		</section>
	);
}
