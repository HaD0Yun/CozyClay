import { useCallback, useEffect, useMemo, useState } from "react";
import { ko } from "./locale.js";
import "./range-pin-panel.css";

const RANGE_PIN_TRACKS = Object.freeze(["leftHand", "rightHand", "leftFoot", "rightFoot"]);

const PARTS = Object.freeze([
	{ id: "leftHand", label: "Left Hand", ko: "왼손", zh: "左手", color: "var(--range-pin-hand)" },
	{ id: "rightHand", label: "Right Hand", ko: "오른손", zh: "右手", color: "var(--range-pin-hand)" },
	{ id: "leftFoot", label: "Left Foot", ko: "왼발", zh: "左脚", color: "var(--range-pin-foot)" },
	{ id: "rightFoot", label: "Right Foot", ko: "오른발", zh: "右脚", color: "var(--range-pin-foot)" },
]);

const PIN_ID_PREFIX = "pin";
const DEFAULT_BLEND_SECONDS = 0.25;
const BLEND_MIN_SECONDS = 0.1;
const BLEND_MAX_SECONDS = 2;
const BLEND_STEP_SECONDS = 0.05;

function pinId() {
	if (globalThis.crypto?.randomUUID) return `${PIN_ID_PREFIX}-${globalThis.crypto.randomUUID()}`;
	return `${PIN_ID_PREFIX}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampFrame(value, frameCount) {
	const max = Math.max(0, Number(frameCount || 1) - 1);
	return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}

function partFor(track) {
	return PARTS.find((part) => part.id === track) ?? PARTS[1];
}

function objectName(object) {
	return object?.name || object?.id || ko("Missing object", "없는 오브젝트");
}

function blendFramesForSeconds(seconds, fps) {
	return Math.max(1, Math.round(Number(seconds || DEFAULT_BLEND_SECONDS) * Math.max(1, fps || 24)));
}

function secondsForBlend(blend, fps) {
	return Math.max(BLEND_MIN_SECONDS, Math.min(BLEND_MAX_SECONDS, Number(blend || 1) / Math.max(1, fps || 24)));
}

function freshDraft(frame, fps) {
	return {
		id: pinId(),
		track: "rightHand",
		startFrame: clampFrame(frame, Number.MAX_SAFE_INTEGER),
		endFrame: clampFrame(frame, Number.MAX_SAFE_INTEGER),
		blend: blendFramesForSeconds(DEFAULT_BLEND_SECONDS, fps),
		reach: "body",
		targetKind: "hold",
		objectId: "",
	};
}

function draftFromPin(pin) {
	return {
		id: pin.id,
		track: pin.track,
		startFrame: pin.startFrame,
		endFrame: pin.endFrame,
		blend: pin.blend,
		reach: pin.reach ?? "limb",
		targetKind: pin.target.space === "object" ? "object" : "hold",
		objectId: pin.target.space === "object" ? pin.target.objectId : "",
	};
}

function residualWarning(residuals) {
	const feet = (residuals ?? []).filter((entry) => Number(entry?.feetErrorM) > 0.01).map((entry) => entry.frame);
	const frames = (residuals ?? []).filter((entry) => Number(entry?.errorM) > 0.01 || Number(entry?.feetErrorM) > 0.01).map((entry) => entry.frame);
	if (!frames.length) return null;
	return {
		frames,
		label: ko(
			`Can't reach on ${frames.length} frame${frames.length === 1 ? "" : "s"}`,
			`${frames.length}개 프레임에 닿지 않음`, `${frames.length} 帧无法触及`,
		),
		title: ko(`Residual over 1 cm on frames ${frames.join(", ")}`, `1cm를 넘는 잔여 오차: ${frames.join(", ")}프레임`, `第 ${frames.join(", ")} 帧的残差超过 1 cm`)
			+ (feet.length ? ko(`; feet cannot stay planted on frames ${feet.join(", ")}`, `; 발 위치를 유지할 수 없는 프레임: ${feet.join(", ")}`, `；第 ${feet.join(", ")} 帧无法保持双脚踩地`) : ""),
	};
}

function validationFor(draft, { motion, frameCount, objects }) {
	if (!motion) return ko("Load a motion before creating a pin.", "핀을 만들기 전에 모션을 불러오세요.");
	if (!RANGE_PIN_TRACKS.includes(draft.track)) return ko("Choose a hand or foot.", "손이나 발을 선택하세요.");
	if (!Number.isInteger(Number(draft.startFrame)) || !Number.isInteger(Number(draft.endFrame))) return ko("In and Out must be whole frames.", "In과 Out은 정수 프레임이어야 해요.");
	if (draft.startFrame < 0 || draft.endFrame >= frameCount) return ko(`Use frames 0–${Math.max(0, frameCount - 1)}.`, `${Math.max(0, frameCount - 1)}프레임 안에서 선택하세요.`, `请使用第 0–${Math.max(0, frameCount - 1)} 帧。`);
	if (draft.endFrame < draft.startFrame) return ko("Out must be on or after In.", "Out은 In 이후여야 해요.");
	if (draft.targetKind === "object" && !draft.objectId) return ko("Choose a scene object.", "씬 오브젝트를 선택하세요.");
	if (draft.targetKind === "object" && !objects.some((object) => object.id === draft.objectId)) return ko("That scene object is no longer available.", "씬 오브젝트를 찾을 수 없어요.");
	if (!Number.isInteger(Number(draft.blend)) || draft.blend < 1) return ko("Blend must be at least one frame.", "Blend는 한 프레임 이상이어야 해요.");
	return "";
}

function targetLabel(pin, objects) {
	if (pin.target.space === "object") {
		return ko(`Object · ${objectName(objects.find((object) => object.id === pin.target.objectId))}`, `오브젝트 · ${objectName(objects.find((object) => object.id === pin.target.objectId))}`, `物体 · ${objectName(objects.find((object) => object.id === pin.target.objectId))}`);
	}
	return ko("Hold at In", "In 위치 고정");
}

export function RangePinPanel({
	active = false,
	motion = null,
	frame = 0,
	frameCount = 1,
	fps = 24,
	pins = [],
	residuals = new Map(),
	objects = [],
	selectedPinId = null,
	partPick = null,
	conflictFrames = [],
	overlapError = "",
	onSelectPin,
	onApply,
	onCancel,
	onDelete,
	onPreviewTarget,
}) {
	const [draft, setDraft] = useState(() => freshDraft(frame, fps));
	const [editingId, setEditingId] = useState(null);
	const [replaceConfirmed, setReplaceConfirmed] = useState(false);

	const selectedPin = useMemo(() => pins.find((pin) => pin.id === selectedPinId) ?? null, [pins, selectedPinId]);
	const validation = validationFor(draft, { motion, frameCount, objects });
	const selectedObject = objects.find((object) => object.id === draft.objectId) ?? null;
	const needsReplace = conflictFrames.length > 0;
	const canApply = !validation && !overlapError && (!needsReplace || replaceConfirmed);

	// React may run state updaters during render (and replay them). Keep every
	// updater pure; notify App only after the draft has committed.
	useEffect(() => {
		if (active) onPreviewTarget?.(draft);
	// The parent callback is a render-time command bridge. It is intentionally
	// omitted from the dependencies so a new closure cannot retrigger preview
	// state forever while the draft itself is unchanged.
	}, [active, draft, frame]);

	const updateDraft = useCallback((patch) => {
		setDraft((current) => ({ ...current, ...patch }));
		setReplaceConfirmed(false);
	}, []);

	useEffect(() => {
		if (!active) return;
		if (selectedPin) {
			setEditingId(selectedPin.id);
			setReplaceConfirmed(false);
			const next = draftFromPin(selectedPin);
			setDraft(next);
			return;
		}
		if (editingId && !pins.some((pin) => pin.id === editingId)) setEditingId(null);
		if (!editingId) {
			const next = freshDraft(frame, fps);
			setReplaceConfirmed(false);
			setDraft(next);
		}
	}, [active, editingId, fps, pins, selectedPin]);

	useEffect(() => {
		if (!active || !partPick || !RANGE_PIN_TRACKS.includes(partPick)) return;
		updateDraft({ track: partPick });
	}, [active, partPick, updateDraft]);

	useEffect(() => {
		if (!active) return undefined;
		const onKeyDown = (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.code === "KeyI") {
				event.preventDefault();
				updateDraft({ startFrame: clampFrame(frame, frameCount) });
			} else if (event.code === "KeyO") {
				event.preventDefault();
				updateDraft({ endFrame: clampFrame(frame, frameCount) });
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active, frame, frameCount, updateDraft]);

	const startNew = () => {
		const next = freshDraft(frame, fps);
		setEditingId(null);
		setReplaceConfirmed(false);
		onSelectPin?.(null);
		setDraft(next);
	};

	const editPin = (pin) => {
		const next = draftFromPin(pin);
		setEditingId(pin.id);
		setReplaceConfirmed(false);
		onSelectPin?.(pin.id);
		setDraft(next);
	};

	const submit = () => {
		if (!canApply) return;
		onApply?.({ ...draft, id: editingId ?? draft.id, replaceExisting: replaceConfirmed });
	};

	const setBlendSeconds = (seconds) => updateDraft({ blend: blendFramesForSeconds(seconds, fps) });
	const blendSeconds = secondsForBlend(draft.blend, fps);
	const sortedPins = [...pins].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame || a.id.localeCompare(b.id));

	return (
		<section className="range-pin-panel" data-testid="range-pin-panel" aria-label={ko("Range pins", "범위 고정") }>
			<div className="range-pin-panel-head">
				<div>
					<strong>{ko("Pin", "고정")}</strong>
					<span>{ko("Hold a hand or foot across a frame range", "프레임 범위 동안 손이나 발을 고정합니다")}</span>
				</div>
				{editingId && <button type="button" className="btn ghost small" onClick={startNew}>{ko("New", "새로 만들기")}</button>}
			</div>
			{!motion && <p className="inspector-hint range-pin-disabled-hint">{ko("Load a motion to enable range pins.", "범위 고정을 사용하려면 모션을 불러오세요.")}</p>}
			<div className="range-pin-form" aria-disabled={!motion}>
				<div className="range-pin-form-label">{ko("Part", "파츠")}</div>
				<div className="range-pin-part-grid" role="radiogroup" aria-label={ko("Pin part", "고정할 파츠")}>
					{PARTS.map((part) => (
						<button
							type="button"
							key={part.id}
							className={"range-pin-part" + (draft.track === part.id ? " selected" : "")}
							style={{ "--range-pin-color": part.color }}
							aria-pressed={draft.track === part.id}
							disabled={!motion}
							onClick={() => updateDraft({ track: part.id })}
						>
							<span className="range-pin-part-dot" aria-hidden="true" />
							{ko(part.label, part.ko, part.zh)}
						</button>
					))}
				</div>

				<div className="range-pin-form-label">{ko("Range", "범위")}</div>
				<div className="range-pin-frame-row">
					<label className="range-pin-frame-field">
						<span>{ko("In", "시작")}</span>
						<input data-testid="range-pin-in" type="number" min="0" max={Math.max(0, frameCount - 1)} step="1" value={draft.startFrame} disabled={!motion} onChange={(event) => updateDraft({ startFrame: clampFrame(event.target.value, frameCount) })} />
					</label>
					<span className="range-pin-frame-dash" aria-hidden="true">–</span>
					<label className="range-pin-frame-field">
						<span>{ko("Out", "끝")}</span>
						<input data-testid="range-pin-out" type="number" min="0" max={Math.max(0, frameCount - 1)} step="1" value={draft.endFrame} disabled={!motion} onChange={(event) => updateDraft({ endFrame: clampFrame(event.target.value, frameCount) })} />
					</label>
				</div>
				<div className="range-pin-frame-actions">
					<button type="button" className="btn ghost small" disabled={!motion} onClick={() => updateDraft({ startFrame: clampFrame(frame, frameCount) })}>{ko("Set In to playhead", "In을 현재 프레임으로")}</button>
					<button type="button" className="btn ghost small" disabled={!motion} onClick={() => updateDraft({ endFrame: clampFrame(frame, frameCount) })}>{ko("Set Out to playhead", "Out을 현재 프레임으로")}</button>
				</div>
				<p className="range-pin-shortcut-hint">{ko("Keyboard: I sets In · O sets Out", "키보드: I는 In · O는 Out")}</p>

				<div className="range-pin-form-label">{ko("Target", "대상")}</div>
				<div className="range-pin-targets" role="radiogroup" aria-label={ko("Pin target", "고정 대상")}>
					<label className="range-pin-target-option">
						<input type="radio" name="range-pin-target" value="hold" checked={draft.targetKind === "hold"} disabled={!motion} onChange={() => updateDraft({ targetKind: "hold", objectId: "" })} />
						<span>
							<b>{ko("Hold where it is at In", "In 위치에 고정")}</b>
							<small>{ko("Capture the part's world position at the In frame.", "In 프레임의 파츠 월드 위치를 사용합니다.")}</small>
						</span>
					</label>
					<label className="range-pin-target-option">
						<input type="radio" name="range-pin-target" value="object" checked={draft.targetKind === "object"} disabled={!motion || objects.length === 0} onChange={() => updateDraft({ targetKind: "object" })} />
						<span>
							<b>{ko("Stick to object", "오브젝트에 붙이기")}</b>
							<small>{ko("Follow a scene object's transform and travel path.", "씬 오브젝트의 변환과 이동 경로를 따라갑니다.")}</small>
						</span>
					</label>
				</div>
				{objects.length === 0 && <p className="range-pin-empty-hint">{ko("Add a scene object to use an object target.", "오브젝트 대상을 사용하려면 씬에 오브젝트를 추가하세요.")}</p>}
			{draft.targetKind === "object" && objects.length > 0 && (
				<label className="range-pin-object-select">
					<span>{ko("Scene object", "씬 오브젝트")}</span>
					<select data-testid="range-pin-object" value={draft.objectId} disabled={!motion} onChange={(event) => updateDraft({ objectId: event.target.value })}>
						<option value="">{ko("Choose an object", "오브젝트 선택")}</option>
						{objects.map((object) => <option key={object.id} value={object.id}>{objectName(object)}</option>)}
					</select>
				</label>
			)}
			{selectedObject && <p className="range-pin-object-readout">{ko("Following", "따라가는 대상")}: {objectName(selectedObject)}</p>}

			<label className="range-pin-target-option">
				<input data-testid="range-pin-reach" type="checkbox" checked={draft.reach === "body"} disabled={!motion} onChange={(event) => updateDraft({ reach: event.target.checked ? "body" : "limb" })} />
				<span><b>{ko("Body follows when out of reach", "손이 안 닿으면 몸도 따라가기")}</b></span>
			</label>

			<div className="range-pin-form-label">{ko("Blend", "블렌드")}</div>
			<div className="range-pin-blend-row">
				<input data-testid="range-pin-blend" type="range" min={BLEND_MIN_SECONDS} max={BLEND_MAX_SECONDS} step={BLEND_STEP_SECONDS} value={blendSeconds} disabled={!motion} onChange={(event) => setBlendSeconds(event.target.value)} />
				<span className="trail-falloff-value">{blendSeconds.toFixed(2)}s ({draft.blend}f)</span>
			</div>

			{overlapError && <p className="range-pin-validation" role="alert">{overlapError}</p>}
			{validation && <p className="range-pin-validation" role="alert">{validation}</p>}
			{needsReplace && (
				<div className="range-pin-replace-warning" role="alert">
					<span>{ko(`Existing IK keys on ${conflictFrames.length} frame${conflictFrames.length === 1 ? "" : "s"}: ${conflictFrames.join(", ")}`, `기존 IK 키가 ${conflictFrames.length}개 프레임에 있어요: ${conflictFrames.join(", ")}`, `${conflictFrames.length} 帧上已有 IK 关键帧：${conflictFrames.join(", ")}`)}</span>
					<button type="button" className="btn ghost small" onClick={() => setReplaceConfirmed((value) => !value)} aria-pressed={replaceConfirmed}>
						{replaceConfirmed ? ko("Replace confirmed", "교체 확인됨") : ko("Replace existing keys", "기존 키 교체")}
					</button>
				</div>
			)}
			<div className="range-pin-actions">
				<button type="button" className="btn ghost" disabled={!motion} onClick={onCancel}>{ko("Cancel", "취소")}</button>
				<button type="button" className="btn primary" data-testid="range-pin-apply" disabled={!canApply} onClick={submit}>{editingId ? ko("Update pin", "고정 업데이트") : ko("Apply pin", "고정 적용")}</button>
			</div>
			</div>

			<div className="range-pin-list-head">
				<span>{ko("Pins", "고정 목록", "固定项")}</span>
				<small>{sortedPins.length}</small>
			</div>
			{sortedPins.length === 0 ? (
				<p className="range-pin-empty-hint">{ko("No pins yet. Choose a part and apply a range.", "아직 고정이 없어요. 파츠와 범위를 정한 뒤 적용하세요.")}</p>
			) : (
				<div className="range-pin-list">
					{sortedPins.map((pin) => {
						const part = partFor(pin.track);
						const warning = residualWarning(residuals instanceof Map ? residuals.get(pin.id) : residuals?.[pin.id]);
						const missingObject = pin.target.space === "object" && !objects.some((object) => object.id === pin.target.objectId);
						return (
							<div key={pin.id} className={"range-pin-item" + (selectedPinId === pin.id ? " selected" : "")} style={{ "--range-pin-color": part.color }}>
								<button type="button" className="range-pin-item-main" onClick={() => editPin(pin)} aria-pressed={selectedPinId === pin.id}>
									<span className="range-pin-item-top"><span className="range-pin-part-dot" aria-hidden="true" />{ko(part.label, part.ko, part.zh)} <b>{pin.startFrame}–{pin.endFrame}</b></span>
									<span className="range-pin-item-target">{missingObject ? ko("Missing object target", "오브젝트 대상 없음") : targetLabel(pin, objects)}</span>
									{(warning || missingObject) && <span className="range-pin-warning" title={missingObject ? ko("The referenced object was deleted.", "참조한 오브젝트가 삭제됐어요.") : warning.title}>{missingObject ? ko("Invalid target", "대상 없음") : warning.label}</span>}
								</button>
								<button type="button" className="range-pin-delete" data-testid={`range-pin-delete-${pin.id}`} aria-label={ko(`Delete ${part.label} pin`, `${part.ko} 고정 삭제`, `删除${part.zh}固定`)} title={ko("Delete pin", "고정 삭제")} onClick={() => onDelete?.(pin.id)}><span aria-hidden="true">×</span></button>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

