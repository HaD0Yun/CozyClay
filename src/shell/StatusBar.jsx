import { useEffect, useRef, useState } from "react";
import SourceOffer from "../source-offer.jsx";
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import "./topbar.css";

const BUSY = ["preparing", "encoding", "finalizing"];

// 2a status bar: status text on the left (export progress, retry and cancel
// take that slot while an export runs, G7); fps and the source offer on the
// right. #570: the save state sits under the project name (ProjectHead).
// In the studio shell there is no standing row: a fixed "Ready", the fps the
// Sequencer already shows and a source link Help › About already carries were
// a band of noise under the dock. Only a live export status shows, as a
// capsule floating in the viewport's bottom-left corner.
// Embeds have no menu bar, so they keep the full row and its source offer.
export default function StatusBar({ embedded = false }) {
	const { exportStatus, exportPhaseLabel, resultOpen, recState, tlFps } = useStudioShell();
	// A frame export's status is already shown inside its result dialog.
	const exportShown = exportStatus && !(resultOpen && exportStatus.kind === "frame");
	if (!embedded) {
		if (!exportShown) return null;
		return (
			<footer className="brandbar v2-statusbar statusbar-float">
				<ExportStatus status={exportStatus} label={exportPhaseLabel} recording={recState === "recording"} />
			</footer>
		);
	}
	return (
		<footer className="brandbar v2-statusbar">
			<div className="statusbar-left">
				{exportShown
					? <ExportStatus status={exportStatus} label={exportPhaseLabel} recording={recState === "recording"} />
					: <span className="statusbar-text">{ko("Ready", "준비")}</span>}
			</div>
			<span className="statusbar-fps" title={ko("Timeline frame rate", "타임라인 프레임 레이트")}>{tlFps} fps</span>
			<SourceOffer />
		</footer>
	);
}

function ExportStatus({ status, label, recording }) {
	const { phase, kind, message, completedFrames, frameCount, stage, cancellable, retryable, handedOff, cancel, retry } = status;
	const busy = BUSY.includes(phase);
	const detail = [
		message,
		retryable && ko("Retry keeps the original shot, camera, range and settings; it does not change your edits.", "다시 시도하면 원래 샷·카메라·범위·설정을 사용하며 편집 내용은 바꾸지 않아요."),
		handedOff > 0 && ko(`${handedOff} file(s) already handed off. Retry skips those files.`, `파일 ${handedOff}개는 이미 전달했어요. 다시 시도할 때 해당 파일은 건너뛰어요.`, `已交付 ${handedOff} 个文件。重试时会跳过这些文件。`),
		busy && stage === "mux" && ko("Finalizing MP4; this stage cannot be interrupted.", "MP4 마무리 중이에요. 이 단계는 중단할 수 없어요."),
	].filter(Boolean).join(" ");
	return (
		<section
			className="export-status statusbar-export"
			data-testid="export-status"
			data-phase={phase}
			data-kind={kind}
			role="status"
			aria-live="polite"
			aria-atomic="true"
			title={detail || undefined}
		>
			<strong className="statusbar-export-phase">{label(phase)}{status.label ? ` · ${status.label}` : ""}</strong>
			{busy && frameCount > 0 && (
				<>
					<progress aria-label={label(phase)} max={frameCount} value={completedFrames} />
					<span className="statusbar-export-count">{completedFrames}/{frameCount}</span>
				</>
			)}
			{!busy && message && <span className="statusbar-export-message">{message}</span>}
			{busy && cancellable && (
				<button type="button" className="statusbar-action" data-testid="export-cancel" onClick={cancel}>
					{ko("Cancel", "취소")}
				</button>
			)}
			{retryable && (
				<button type="button" className="statusbar-action" data-testid="export-retry" disabled={recording} onClick={() => void retry()}>
					{ko("Retry", "재시도")}
				</button>
			)}
		</section>
	);
}

function relativeTime(ms) {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return ko("just now", "방금");
	if (minutes < 60) return ko(`${minutes} min ago`, `${minutes}분 전`, `${minutes} 分钟前`);
	const hours = Math.floor(minutes / 60);
	return ko(`${hours} h ago`, `${hours}시간 전`, `${hours} 小时前`);
}

// "Saved 2 min ago" once a save completes in this session; otherwise the
// project's own save state (Unsaved changes, Saving…, Save failed, Not saved).
export function SaveState({ status }) {
	const [savedAt, setSavedAt] = useState(null);
	const [now, setNow] = useState(() => Date.now());
	const previous = useRef(status.state);
	useEffect(() => {
		if (previous.current === "saving" && status.state === "saved") setSavedAt(Date.now());
		if (status.dirty) setSavedAt(null);
		previous.current = status.state;
	}, [status.state, status.dirty]);
	useEffect(() => {
		if (savedAt === null) return undefined;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30000);
		return () => clearInterval(timer);
	}, [savedAt]);
	const text = savedAt !== null && status.state === "saved" && !status.dirty
		? ko(`Saved ${relativeTime(now - savedAt)}`, `저장됨 · ${relativeTime(now - savedAt)}`, `已保存 · ${relativeTime(now - savedAt)}`)
		: status.text;
	return (
		<span
			className={"project-save-status status-" + status.state}
			data-testid="project-save-status"
			data-dirty={status.dirty ? "true" : undefined}
			role="status"
			aria-live="polite"
		>
			{text}
		</span>
	);
}
