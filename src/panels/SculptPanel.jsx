import { useEffect, useRef, useState } from "react";
import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { effortOptions } from "../workflow/agent-client.js"; import { saveExport } from "../export-workspace.js";
import SculptPartTree from "./SculptPartTree.jsx";
import "./sculpt.css";

// Sculpt mode side panel (#739). Pure view: the run controller owns the run state and the
// reference; this panel only renders it and reports the operator's intent through callbacks.

const STAGES = [
	["measure", ko("Measure", "측정")],
	["draft", ko("Draft", "초안")],
	["score", ko("Score", "채점")],
	["refine", ko("Refine", "다듬기")],
];
const RUNNING = new Set(["measure", "draft", "score", "refine"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function pickImage(files) {
	return [...(files ?? [])].find((file) => IMAGE_TYPES.has(file.type)) ?? null;
}

function formatElapsed(ms) {
	const seconds = Math.max(0, Math.round((ms || 0) / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function formatIou(iou) {
	return Number.isFinite(iou) ? iou.toFixed(3) : "—";
}


function formatClock(ms) {
	const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Re-render every half second while something is awaited, so the wait counts up live. */
function useTicking(active) {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!active) return undefined;
		const timer = setInterval(() => setTick((value) => value + 1), 500);
		return () => clearInterval(timer);
	}, [active]);
}

/** What the run is waiting on right now, how long it has waited and how long that usually takes. */
function NowLine({ waiting, now = Date.now() }) {
	if (!waiting) return null;
	const waited = Math.max(0, now - (waiting.since ?? now));
	const expect = Number.isFinite(waiting.expectMs) && waiting.expectMs > 0 ? waiting.expectMs : null;
	const over = expect !== null && waited > expect * 1.5;
	return (
		<div className="sculpt-now" data-testid="sculpt-now" data-what={waiting.what} data-over={over ? "true" : undefined} role="status" aria-live="polite">
			<span className="sculpt-clay" aria-hidden="true" />
			<span className="sculpt-now-label">{waiting.label}</span>
			<span className="sculpt-now-time" data-testid="sculpt-now-time">{Math.floor(waited / 1000)}s</span>
			{expect !== null && (
				<span className="sculpt-now-expect">
					{over ? ko("taking longer than usual", "평소보다 오래 걸려요") : ko(`usually ~${Math.round(expect / 1000)}s`, `보통 ~${Math.round(expect / 1000)}초`, `通常约 ${Math.round(expect / 1000)} 秒`)}
				</span>
			)}
			{expect !== null && <span className="sculpt-now-bar" aria-hidden="true"><span style={{ "--sculpt-wait": Math.min(1, waited / expect) }} /></span>}
		</div>
	);
}

/** IoU after each scored round, against the target line; the newest point pulses. */
function IouTrail({ history, target }) {
	if (!history?.length) return null;
	const values = history.map((row) => row.iou);
	const low = Math.max(0, Math.min(...values, target ?? 1) - 0.05);
	const y = (iou) => 30 - ((iou - low) / Math.max(0.01, 1 - low)) * 26;
	const x = (index) => (history.length === 1 ? 50 : 6 + (index / (history.length - 1)) * 88);
	const last = history.at(-1).iou;
	const delta = history.length > 1 ? last - history.at(-2).iou : null;
	return (
		<div className="sculpt-trail" data-testid="sculpt-trail">
			<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-label={ko(`Match by round: ${values.map((v) => v.toFixed(3)).join(", ")}`, `라운드별 일치도: ${values.map((v) => v.toFixed(3)).join(", ")}`, `各轮匹配度：${values.map((v) => v.toFixed(3)).join(", ")}`)} role="img">
				{target !== null && <line className="sculpt-trail-target" x1="0" x2="100" y1={y(target)} y2={y(target)} />}
				{history.length > 1 && <polyline className="sculpt-trail-line" points={history.map((row, index) => `${x(index)},${y(row.iou)}`).join(" ")} />}
				{history.map((row, index) => <circle key={index} className="sculpt-trail-dot" data-last={index === history.length - 1 ? "true" : undefined} cx={x(index)} cy={y(row.iou)} r="2.2" />)}
			</svg>
			{delta !== null && <span className="sculpt-delta" key={history.length} data-testid="sculpt-delta" data-sign={delta >= 0 ? "up" : "down"}>{delta >= 0 ? "+" : ""}{delta.toFixed(3)}</span>}
		</div>
	);
}

/** The latest candidate ranking as a race: each fix's IoU as a bar that grows in, the leader marked. */
function CandidateRace({ candidates }) {
	if (!candidates?.length) return null;
	const scored = candidates.filter((row) => Number.isFinite(row.iou));
	const lo = scored.length ? Math.min(...scored.map((row) => row.iou)) - 0.02 : 0;
	const hi = scored.length ? Math.max(...scored.map((row) => row.iou)) + 0.01 : 1;
	const leader = candidates.find((row) => !row.refused && Number.isFinite(row.iou));
	return (
		<ol className="sculpt-race" data-testid="sculpt-race" aria-label={ko("Candidate fixes, best first", "후보 수정안 (좋은 순)")}>
			{candidates.map((row, index) => (
				<li key={`${row.label}-${index}`} className="sculpt-race-row" data-leader={row === leader ? "true" : undefined} data-refused={row.refused ? "true" : undefined}
					style={{ "--sculpt-race": Number.isFinite(row.iou) ? Math.max(0.04, (row.iou - lo) / Math.max(0.001, hi - lo)) : 0, "--sculpt-race-delay": `${index * 90}ms` }}>
					<span className="sculpt-race-label" title={row.label}>{row.label}</span>
					<span className="sculpt-race-bar" aria-hidden="true"><span /></span>
					<span className="sculpt-race-score">{row.refused ? ko("refused", "거부") : Number.isFinite(row.delta) ? `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(3)}` : formatIou(row.iou)}</span>
				</li>
			))}
		</ol>
	);
}

/** The run's own account of itself, newest at the bottom and kept in view. */
function ActivityLog({ activity }) {
	const logRef = useRef(null);
	useEffect(() => {
		const logList = logRef.current;
		if (logList) logList.scrollTop = logList.scrollHeight;
	}, [activity?.length]);
	if (!activity?.length) return null;
	return (
		<ol className="sculpt-log" data-testid="sculpt-log" ref={logRef} aria-label={ko("Sculpt activity", "조형 진행 기록")}>
			{activity.map((row) => (
				<li key={row.id} className="sculpt-log-row" data-kind={row.kind}>
					<span className="sculpt-log-time">{formatClock(row.atMs)}</span>
					<span className="sculpt-log-dot" aria-hidden="true" />
					<span className="sculpt-log-text">{row.text}</span>
				</li>
			))}
		</ol>
	);
}

/** The measured slices drawn over the reference: a scan line while measuring, then each slice's spans. */
function OutlineScan({ outline, scanning }) {
	const box = outline?.box;
	return (
		<>
			{scanning && <span className="sculpt-scanline" data-testid="sculpt-scanline" aria-hidden="true" />}
			{box && (
				<svg className="sculpt-scan" data-testid="sculpt-scan" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
					{outline.rows.flatMap((row, index) => row.spans.map(([from, to], spanIndex) => {
						const centre = box.left + box.width / 2;
						const scale = box.height * (box.aspect ?? 1);
						return (
							<rect key={`${index}-${spanIndex}`} className="sculpt-scan-span" style={{ animationDelay: `${index * 70}ms` }}
								x={centre + from * scale} width={Math.max(0.004, (to - from) * scale)} y={box.top + row.y * box.height - 0.006} height="0.012" />
						);
					}))}
				</svg>
			)}
		</>
	);
}

/**
 * Which model the run uses, and its effort. The list is the Agent panel's
 * (/agent/models): grouped by provider, a provider without a credential lists
 * its models disabled. Locked while a run is out, since every turn of one run
 * uses the same model.
 */
function ModelPicker({ picker, locked }) {
	if (!picker) return null;
	const { state, providers = [], models = [], model, effort, onModel, onEffort } = picker;
	const efforts = effortOptions(models.find((entry) => entry.id === model));
	const disabled = locked || !models.length;
	return (
		<div className="sculpt-model" data-testid="sculpt-model">
			<div className="sculpt-label"><span>{ko("Model", "모델")}</span>{locked && <small>{ko("locked while running", "실행 중엔 고정")}</small>}</div>
			<div className="sculpt-model-row">
				<select className="sculpt-select" data-testid="sculpt-model-select" aria-label={ko("Sculpt model", "조형 모델")} value={model || ""} disabled={disabled}
					onChange={(event) => onModel?.(event.target.value)}>
					{providers.length
						? providers.map((provider) => (
							<optgroup key={provider.id} label={provider.label ?? provider.id}>
								{(provider.models ?? []).map((entry) => {
									const key = entry.key ?? `${provider.id}/${entry.id}`;
									const label = models.find((row) => row.id === key)?.label ?? entry.label ?? key;
									return <option key={key} value={key} disabled={!provider.signedIn}>{provider.signedIn ? label : `${label} — ${ko("add key", "키 필요")}`}</option>;
								})}
							</optgroup>
						))
						: models.length
							? models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label ?? entry.id}</option>)
							: <option value="">{state === "failed" ? ko("No model available", "사용할 모델 없음") : ko("Loading models…", "모델 불러오는 중…")}</option>}
				</select>
				{efforts.length > 0 && (
					<select className="sculpt-select sculpt-effort" data-testid="sculpt-effort-select" aria-label={ko("Effort", "추론 강도")} value={effort ?? ""} disabled={locked}
						onChange={(event) => onEffort?.(event.target.value || null)}>
						<option value="">{ko(`Default (${efforts[0]})`, `기본 (${efforts[0]})`, `默认（${efforts[0]}）`)}</option>
						{efforts.map((value) => <option key={value} value={value}>{value}</option>)}
					</select>
				)}
			</div>
		</div>
	);
}

/**
 * The blueprint step: one image request turns the reference into a four-view
 * orthographic model sheet. Pure view: App owns the request and its result.
 */
function BlueprintSection({ blueprint, disabled }) {
	if (!blueprint) return null;
	const { state = "idle", pose = "keep", notes = "", prompt = "", sheet = null, error = null, startedAt = null, refusal = null, onPose, onNotes, onGenerate, onCancel, layout = [] } = blueprint;
	const busy = state === "generating", waited = busy && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
	return (
		<div className="sculpt-blueprint" data-testid="sculpt-blueprint" data-state={state}>
			<div className="sculpt-label"><span>{ko("Blueprint (model sheet)", "도면 (모델 시트)")}</span><small>{ko("front · side · back · top", "정면 · 측면 · 뒷면 · 윗면")}</small></div>
			<div className="sculpt-blueprint-row">
				<select className="sculpt-select" data-testid="sculpt-blueprint-pose" aria-label={ko("Pose on the sheet", "도면 포즈")} value={pose} disabled={busy || disabled} onChange={(event) => onPose?.(event.target.value)}>
					<option value="keep">{ko("Pose: as in the reference", "포즈: 원본 그대로")}</option>
					<option value="neutral">{ko("Pose: neutral rest pose", "포즈: 중립 자세")}</option>
				</select>
			</div>
			<textarea className="sculpt-notes" data-testid="sculpt-blueprint-notes" rows={2} maxLength={600} disabled={busy || disabled}
				placeholder={ko("Notes (optional): what it is, what to keep or fix", "메모 (선택): 무엇인지, 유지하거나 고칠 점")}
				aria-label={ko("Blueprint notes", "도면 메모")} value={notes} onChange={(event) => onNotes?.(event.target.value)} />
			{busy ? (
				<div className="sculpt-now" data-testid="sculpt-blueprint-wait" role="status" aria-live="polite">
					<span className="sculpt-clay" aria-hidden="true" />
					<span className="sculpt-now-label">{ko("Drawing the four-view sheet", "4면 도면 그리는 중")}</span>
					<span className="sculpt-now-time">{waited}s</span>
					<span className="sculpt-now-expect">{ko("usually ~40–90s", "보통 ~40–90초")}</span>
					<button type="button" className="btn ghost small" data-testid="sculpt-blueprint-cancel" onClick={() => onCancel?.()}>{ko("Cancel", "취소")}</button>
				</div>
			) : !refusal && (
				// Without a ChatGPT token there is no button: the refusal below says why (#970).
				<button type="button" className="btn full" data-testid="sculpt-blueprint-generate" disabled={disabled} onClick={() => onGenerate?.()}>
					{sheet ? ko("Generate again", "다시 생성") : ko("Generate blueprint", "도면 생성")}
				</button>
			)}
			{refusal && !busy && <p className="inspector-hint" role="status" data-testid="sculpt-blueprint-refusal">{refusal}</p>}
			{error && !busy && <p className="inspector-hint sculpt-error" role="alert" data-testid="sculpt-blueprint-error">{error}</p>}
			{sheet?.notices?.length > 0 && !busy && <p className="inspector-hint" role="status" data-testid="sculpt-blueprint-notices">{sheet.notices.join(" ")}</p>}
			{sheet && (
				<figure className="sculpt-sheet-figure" data-testid="sculpt-blueprint-sheet">
					<a href={sheet.dataUrl} target="_blank" rel="noreferrer" title={ko("Open full size", "원본 크기로 열기")}>
						<img src={sheet.dataUrl} alt={ko("Generated four-view model sheet", "생성된 4면 도면")} />
						{layout.map((panel) => (
							<span key={panel.view} className="sculpt-sheet-tag" style={{ left: `${panel.x * 100}%`, top: `${panel.y * 100}%` }}>{panel.label}</span>
						))}
					</a>
					<figcaption>
						<span>{sheet.width}×{sheet.height}{Number.isFinite(sheet.ms) ? ` · ${Math.round(sheet.ms / 1000)}s` : ""}</span>
						<a href={sheet.dataUrl} download="sculpt-blueprint.png" data-testid="sculpt-blueprint-download" onClick={(event) => { event.preventDefault(); void saveExport(sheet.dataUrl, "sculpt-blueprint.png"); }}>{ko("Download", "내려받기")}</a>
					</figcaption>
				</figure>
			)}
			{prompt && (
				<details className="sculpt-prompt" data-testid="sculpt-blueprint-prompt">
					<summary>{ko("Request sent to the image model", "이미지 모델에 보내는 요청")}</summary>
					<pre>{prompt}</pre>
				</details>
			)}
		</div>
	);
}

export default function SculptPanel({ run, reference, onReference, onStart, onCancel, onPlaceInScene, onSaveToShelf, canStart, startRefusal, sculptName, hidden, modelPicker = null, blueprint = null, parts = null }) {
	const fileRef = useRef(null);
	const [dragging, setDragging] = useState(false);
	// The sheet is the clearest picture of what is off, so it starts open.
	const [showSheet, setShowSheet] = useState(true);

	const stage = run?.stage ?? "idle";
	const running = RUNNING.has(stage);
	const stageIndex = STAGES.findIndex(([id]) => id === stage);
	const iou = Number.isFinite(run?.iou) ? run.iou : null;
	const target = Number.isFinite(run?.targetIou) ? run.targetIou : null;
	const hasLog = Boolean(run?.activity?.length);
	useTicking((running && Boolean(run?.waiting)) || blueprint?.state === "generating");

	const take = (files) => {
		const file = pickImage(files);
		if (file) onReference?.(file);
	};
	const openPicker = () => fileRef.current?.click();

	return (
		<Foldout hidden={hidden} title={ko("Sculpt from image", "이미지로 조형")}>
			<div className="sculpt-panel" data-testid="sculpt-panel" data-stage={stage}
				onPaste={(event) => {
					const file = pickImage(event.clipboardData?.files);
					if (!file) return;
					event.preventDefault();
					onReference?.(file);
				}}>

				<div className="sculpt-label"><span>{ko("Reference", "참조 이미지")}</span>{reference?.name && <small title={reference.name}>{reference.name}</small>}</div>
				{reference ? (
					<div className="sculpt-well sculpt-well-filled" data-testid="sculpt-reference"
						onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); }}
						onDrop={(event) => { event.preventDefault(); take(event.dataTransfer?.files); }}>
						<div className="sculpt-ref-frame">
							<img src={reference.dataUrl} alt={ko(`Reference: ${reference.name}`, `참조 이미지: ${reference.name}`, `参考图：${reference.name}`)} />
							<OutlineScan outline={run?.outline} scanning={stage === "measure" && !run?.outline} />
						</div>
						<button type="button" className="btn ghost small sculpt-well-replace" data-testid="sculpt-reference-replace"
							disabled={running} aria-label={ko("Replace reference image", "참조 이미지 바꾸기")} onClick={openPicker}>
							{ko("Replace", "바꾸기")}
						</button>
					</div>
				) : (
					<div className="sculpt-well sculpt-well-empty" data-testid="sculpt-dropzone" data-dragging={dragging ? "true" : undefined}
						role="button" tabIndex={0} aria-label={ko("Drop or paste a reference image, or press Enter to choose a file", "참조 이미지를 끌어놓거나 붙여넣기, 또는 Enter로 파일 선택")}
						onClick={openPicker}
						onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPicker(); } }}
						onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setDragging(true); } }}
						onDragLeave={() => setDragging(false)}
						onDrop={(event) => { event.preventDefault(); setDragging(false); take(event.dataTransfer?.files); }}>
						<span className="sculpt-well-title">{ko("Drop or paste a reference image", "참조 이미지를 끌어놓거나 붙여넣으세요")}</span>
						<span className="sculpt-well-sub">PNG · JPEG · WebP</span>
						<span className="btn ghost small" aria-hidden="true">{ko("Choose file", "파일 선택")}</span>
					</div>
				)}
				<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="multimodel-file-input" data-testid="sculpt-reference-input"
					aria-label={ko("Reference image file", "참조 이미지 파일")}
					onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; take(files); }} />

				{reference && <BlueprintSection blueprint={blueprint} disabled={running} />}

				<ModelPicker picker={modelPicker} locked={running} />

				{running ? (
					<button type="button" className="btn full sculpt-cancel" data-testid="sculpt-cancel" onClick={() => onCancel?.()}>
						{ko("Cancel", "취소")}
					</button>
				) : (
					<button type="button" className="btn primary full" data-testid="sculpt-start" disabled={!canStart || Boolean(startRefusal)}
						aria-describedby={startRefusal ? "sculpt-start-refusal" : undefined} onClick={() => onStart?.()}>
						{ko("Start (fast draft)", "시작 (빠른 초안)")}
					</button>
				)}
				{!running && startRefusal && <p className="inspector-hint sculpt-refusal" id="sculpt-start-refusal" role="status" data-testid="sculpt-start-refusal">{startRefusal}</p>}
				{sculptName && <SculptPartTree {...parts} />}

				{stage !== "idle" && (
					<div className="sculpt-progress" data-testid="sculpt-progress">
						<ol className="sculpt-stepper" aria-label={ko("Sculpt stages", "조형 단계")}>
							{STAGES.map(([id, label], index) => {
								const state = stage === "done" || (stageIndex >= 0 && index < stageIndex) ? "complete" : index === stageIndex ? "current" : "pending";
								return (
									<li key={id} className="sculpt-step" data-state={state} data-stage={id} aria-current={state === "current" ? "step" : undefined}>
										<span className="sculpt-step-dot" aria-hidden="true" />
										<span className="sculpt-step-label">{label}</span>
									</li>
								);
							})}
						</ol>

						{running && <NowLine waiting={run.waiting} />}

						<div className="sculpt-stats">
							<span data-testid="sculpt-round">{ko(`Round ${run.round} / ${run.maxRounds}`, `라운드 ${run.round} / ${run.maxRounds}`, `第 ${run.round} / ${run.maxRounds} 轮`)}</span>
							<span data-testid="sculpt-elapsed">{formatElapsed(run.elapsedMs)}</span>
						</div>

						<div className="sculpt-iou">
							<div className="sculpt-label">
								<span title={ko("Silhouette match (IoU)", "실루엣 일치도 (IoU)")}>{stage === "done" ? ko("Final match", "최종 일치도", "最终匹配度") : ko("Match", "일치도", "匹配度")}</span>
								<small data-testid="sculpt-iou">{formatIou(iou)}{target !== null && <span className="sculpt-iou-target"> / {formatIou(target)}</span>}</small>
							</div>
							<div className="sculpt-iou-bar" role="meter" aria-label={ko("Silhouette match", "실루엣 일치도", "轮廓匹配度")}
								aria-valuemin={0} aria-valuemax={1} aria-valuenow={iou ?? undefined}
								data-reached={iou !== null && target !== null && iou >= target ? "true" : undefined}
								style={{ "--sculpt-iou": iou ?? 0, "--sculpt-target": target ?? 0 }}>
								<span className="sculpt-iou-fill" />
								{target !== null && <span className="sculpt-iou-marker" data-testid="sculpt-iou-target" title={ko(`Target ${formatIou(target)}`, `목표 ${formatIou(target)}`, `目标 ${formatIou(target)}`)} />}
							</div>
							<IouTrail history={run.history} target={target} />
						</div>

						<CandidateRace candidates={run.candidates} />
						<ActivityLog activity={run.activity} />

						{run.message && !hasLog && <p className="inspector-hint sculpt-message" role="status">{run.message}</p>}
						{stage === "done" && <p className="inspector-hint sculpt-done" role="status" data-testid="sculpt-done">{ko(`Done — IoU ${formatIou(iou)}`, `완료 — IoU ${formatIou(iou)}`, `完成 — IoU ${formatIou(iou)}`)}</p>}
						{stage === "cancelled" && <p className="inspector-hint" role="status" data-testid="sculpt-cancelled">{ko("Cancelled.", "취소했어요.")}</p>}
						{stage === "failed" && <p className="inspector-hint sculpt-error" role="alert" data-testid="sculpt-error">{run.error || ko("The sculpt run failed.", "조형에 실패했어요.")}</p>}
					</div>
				)}

				{run?.sheetDataUrl && (
					<div className="sculpt-sheet">
						<button type="button" className="btn ghost small full" data-testid="sculpt-sheet-toggle" aria-pressed={showSheet}
							onClick={() => setShowSheet((value) => !value)}>
							{showSheet ? ko("Hide overlay sheet", "오버레이 시트 숨기기") : ko("Show overlay sheet", "오버레이 시트 보기")}
						</button>
						{showSheet && <img className="sculpt-sheet-image" data-testid="sculpt-sheet" src={run.sheetDataUrl} alt={ko("Reference beside the sculpt overlay", "참조 이미지와 조형 오버레이")} />}
					</div>
				)}

				<button type="button" className="btn full" data-testid="sculpt-place" disabled={!sculptName || running}
					aria-label={sculptName ? ko(`Place ${sculptName} in scene`, `${sculptName} 장면에 배치`, `将 ${sculptName} 放入场景`) : ko("Place in scene", "장면에 배치")}
					onClick={() => onPlaceInScene?.()}>{ko("Place in scene", "장면에 배치")}</button>
				<button type="button" className="btn ghost full" data-testid="sculpt-save-shelf" disabled={!sculptName || running} title={ko("Keep a copy on the asset shelf (Content › Sculpts), for any scene or project", "에셋 선반(콘텐츠 › 조형물)에 사본을 보관해 어느 씬·프로젝트에서나 씁니다")} onClick={() => onSaveToShelf?.()}>{ko("Save to shelf", "선반에 저장", "保存到架子")}</button>

				<p className="inspector-hint sculpt-hint" data-testid="sculpt-hint">
					{ko("Fix details by chatting with the Agent (⌘B) while the sculpt is selected.", "조형물을 선택한 채 에이전트(⌘B)와 대화해 디테일을 고치세요.")}
				</p>
			</div>
		</Foldout>
	);
}
