// A turn's step checklist in the agent panel (agent-plan.js keeps it): a header that says how far the plan is ("2/5")
// beside a thin progress bar, and one row per step: done steps checked, the step under way highlighted with a soft
// pulse, the rest waiting. While the turn runs the card stays pinned to the top of the transcript, so what is happening
// and what comes next stay in view however long the step list below grows. Once the turn ends nothing pulses, and a
// step a failed or stopped turn left unfinished reads muted. The header folds the card to one line (the step under way,
// or the last one, beside the count), so a pinned plan leaves the transcript its room; folding is a viewer setting shared
// by every plan card, never saved.
import { useSyncExternalStore } from "react";
import { FiCheck, FiChevronDown, FiChevronRight, FiMinus } from "react-icons/fi";
import { ko } from "../locale.js";
import "./agent-plan.css";

const STATUS_WORDS = {
	done: ko("done", "완료"),
	active: ko("in progress", "진행 중"),
	pending: ko("next", "대기"),
	unfinished: ko("not finished", "미완료"),
};

let folded = false;
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const readFolded = () => folded;
const setFolded = (value) => { folded = Boolean(value); for (const listener of listeners) listener(); };

function PlanMark({ status }) {
	if (status === "done") return <FiCheck className="agent-plan-mark done" size={11} aria-hidden="true" />;
	if (status === "unfinished") return <FiMinus className="agent-plan-mark unfinished" size={11} aria-hidden="true" />;
	return <span className={`agent-plan-mark ${status}`} aria-hidden="true" />;
}

export function PlanCard({ plan, live }) {
	const total = plan.steps.length, done = plan.steps.filter(step => step.status === "done").length;
	const state = live ? "live" : plan.outcome ?? "done";
	const closed = useSyncExternalStore(subscribe, readFolded, readFolded);
	// folded, the header names the step under way (else the first one still waiting or unfinished, else the last)
	const current = plan.steps.find(step => step.status === "active") ?? plan.steps.find(step => step.status !== "done") ?? plan.steps.at(-1);
	const toggle = closed ? ko("Show the plan's steps", "계획 단계 펼치기", "展开计划步骤") : ko("Fold the plan to one line", "계획을 한 줄로 접기", "将计划折叠为一行");
	return <div className="agent-row agent-plan-row" data-plan-live={live ? "true" : "false"}>
		<section className="agent-card agent-plan" data-agent-card="plan" data-plan-state={state} data-plan-folded={closed ? "true" : undefined} aria-label={ko(`Plan, ${done} of ${total} done`, `계획, ${total}단계 중 ${done}단계 완료`, `计划，已完成 ${done} / ${total}`)}>
			<button type="button" className="agent-plan-head" data-testid="agent-plan-toggle" aria-expanded={!closed} aria-label={toggle} title={toggle} onClick={() => setFolded(!closed)}>
				{closed ? <FiChevronRight className="agent-plan-chevron" size={12} aria-hidden="true" /> : <FiChevronDown className="agent-plan-chevron" size={12} aria-hidden="true" />}
				<span className="agent-plan-title">{ko("Plan", "계획")}</span>
				{closed && current ? <span className="agent-plan-current" data-plan-status={current.status}>{current.text}</span>
					: <span className="agent-plan-bar" aria-hidden="true"><span className="agent-plan-fill" style={{ "--agent-plan-done": total ? done / total : 0 }} /></span>}
				<span className="agent-plan-count">{done}/{total}</span>
			</button>
			{!closed && <ol className="agent-plan-steps">
				{plan.steps.map((step, index) => <li key={index} className={`agent-plan-step ${step.status}`} data-plan-status={step.status} aria-current={step.status === "active" ? "step" : undefined} aria-label={`${step.text}: ${STATUS_WORDS[step.status] ?? step.status}`}>
					<PlanMark status={step.status} />
					<span className="agent-plan-text">{step.text}</span>
				</li>)}
			</ol>}
		</section>
	</div>;
}
