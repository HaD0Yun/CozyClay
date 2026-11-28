// One turn's work in the agent panel (agent-turn.js turnLayout): a header that says how the turn stands (working,
// done, stopped, failed), how many steps and how long, and one compact row per step: the tool call with a plain
// label, what it was about and its one-line result; the reasoning the model streamed between calls; the call it is
// writing now. Open while the turn runs, folded to its header when the turn ends (a failed or stopped turn stays
// open, and a stopped one says what it left in the scene).
import { useState } from "react";
import { FiCheck, FiChevronRight, FiSquare, FiX } from "react-icons/fi";
import { ko } from "../locale.js";
import { scriptNow, stepLabel, stepResult, stepsHeader, stoppedNote, thinkingLine, unchangedNote } from "./agent-turn.js";
import "./agent-turn-steps.css";

/** Step time: "0.6 s", "12 s", "1 m 05 s". */
function stepClock(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)} s`;
	if (s < 60) return `${Math.round(s)} s`;
	return `${Math.floor(s / 60)} m ${String(Math.round(s % 60)).padStart(2, "0")} s`;
}

function StepIcon({ state }) {
	if (state === "running") return <span className="agent-step-spin" aria-label={ko("running", "진행 중")} />;
	if (state === "failed") return <FiX className="agent-step-icon alert" size={11} aria-label={ko("failed", "실패")} />;
	if (state === "cancelled") return <FiSquare className="agent-step-icon warn" size={9} aria-label={ko("stopped", "중지됨")} />;
	if (state === "note") return <span className="agent-step-dot" aria-hidden="true" />;
	return <FiCheck className="agent-step-icon ok" size={11} aria-label={ko("done", "완료")} />;
}

function Step({ step, live, isLast, now, toolLabels }) {
	const [open, setOpen] = useState(false);
	if (step.kind === "narration") return <li className="agent-step narration" data-step-kind="narration"><StepIcon state="note" /><span className="agent-step-text">{step.text}</span></li>;
	if (step.kind === "thinking") {
		const running = live && isLast;
		const line = thinkingLine(step.text);
		// from its first words until the next step began; a thought that arrived at once shows no time
		const took = (running ? now : step.endedAt ?? step.updatedAt) - step.startedAt;
		return <li className="agent-step thinking" data-step-kind="thinking">
			<button type="button" className="agent-step-row" aria-expanded={open} onClick={() => setOpen(value => !value)}>
				<StepIcon state={running ? "running" : "note"} />
				<span className="agent-step-label">{ko("Thinking", "생각")}</span>
				<span className="agent-step-subject">{open ? "" : line}</span>
				<span className="agent-step-time">{took >= 1000 ? stepClock(took) : ""}</span>
			</button>
			{open && <p className="agent-step-thought">{step.text}</p>}
		</li>;
	}
	const running = step.kind === "compose" || step.status === "running";
	const label = step.kind === "compose" ? ko(`Preparing ${stepLabel(step, toolLabels)}`, `${stepLabel(step, toolLabels)} 준비 중`, `正在准备 ${stepLabel(step, toolLabels)}`) : stepLabel(step, toolLabels);
	const result = running ? (step.progress ? `${scriptNow(step)}${step.progress.summary ? ` — ${step.progress.summary}` : ""}` : "") : stepResult(step);
	const time = running ? now - (step.startedAt ?? now) : step.elapsedMs;
	return <li className={`agent-step ${step.kind}${step.status === "failed" ? " failed" : ""}`} data-step-kind={step.kind} data-tool-name={step.name} data-tool-status={step.kind === "compose" ? "composing" : step.status} data-action={step.action}>
		<div className="agent-step-row">
			<StepIcon state={running ? "running" : step.status} />
			<span className="agent-step-label">{label}</span>
			{step.subject && <span className="agent-step-subject">{step.subject}</span>}
			<span className="agent-step-time">{stepClock(time)}</span>
		</div>
		{result && <p className="agent-step-result">{result}</p>}
	</li>;
}

export function TurnSteps({ block, now, toolLabels, formatClock, onRetry }) {
	const [chosen, setChosen] = useState(null);
	const failed = block.end?.status === "failed" || block.steps.some(step => step.failure);
	const stopped = block.end?.status === "stopped";
	const open = chosen ?? (block.live || failed || stopped);
	const header = stepsHeader(block, now, formatClock);
	const failure = block.steps.find(step => step.failure)?.failure;
	const unchanged = unchangedNote(block);
	return <div className="agent-card agent-steps" data-agent-card="steps" data-steps-state={block.live ? "live" : block.end?.status ?? "done"} data-open={open ? "true" : "false"}>
		<button type="button" className="agent-steps-head" aria-expanded={open} onClick={() => setChosen(!open)}>
			<span className={`agent-status-dot ${header.tone}`} aria-hidden="true" />
			<span className="agent-steps-title">{header.text}</span>
			<FiChevronRight className="agent-steps-chevron" size={12} aria-hidden="true" />
		</button>
		{open && <ol className="agent-steps-list">
			{block.steps.map((step, index) => <Step key={step.id} step={step} live={block.live} isLast={index === block.steps.length - 1} now={now} toolLabels={toolLabels} />)}
		</ol>}
		{stopped && <p className="agent-steps-note">{stoppedNote(block)}</p>}
		{unchanged && <p className="agent-steps-note" data-steps-note="unchanged">{unchanged}</p>}
		{failure && <div className="agent-error" role="alert">
			<span>{failure.message || ko("The turn failed.", "턴이 실패했어요.")}</span>
			<div className="agent-error-actions"><button type="button" className="agent-ghost-button agent-error-retry" onClick={onRetry}>{ko("Retry", "다시 시도")}</button></div>
		</div>}
	</div>;
}
