// Task mode inside the chat (task-board.js; the headless TaskBoard.jsx feeds taskView). A task is one quiet line
// under the turn that dispatched it; a status line under the header counts them; a line opens the task's own view
// (its steps, cost, cancel / undo, and an input that talks to that task only), and the chat is one click back.
import { useEffect, useState, useSyncExternalStore } from "react";
import { FiChevronDown, FiChevronLeft } from "react-icons/fi";
import { ko } from "../locale.js";
import { ACTIVE_STATUSES, TASK_STATUS_COPY, boardGroups, compileState, costLabel, dispatchedTaskIds, progressLine, scopeLabel, taskLine, taskReason, taskView } from "./task-board.js";
import "./task-board.css";
export { readStoredTaskMode, storeTaskMode } from "./task-board.js";

const useTaskView = () => useSyncExternalStore(taskView.subscribe, taskView.get, taskView.get);
const openTask = taskId => taskView.set({ open: taskId });

function TaskRow({ task, activity }) {
	const line = task.status === "running" && compileState(activity, task.taskId).waiting > 0 ? ko("Compile waits for a free worker", "컴파일 차례 기다리는 중") : taskLine(task);
	const status = TASK_STATUS_COPY[task.status] ?? task.status;
	return <button type="button" className="task-row" data-status={task.status} data-task-id={task.taskId} onClick={() => openTask(task.taskId)}
		title={`${task.title} — ${line}`} aria-label={`${task.title}, ${status}: ${line}`}>
		<span className="task-dot" aria-hidden="true" />
		<span className="task-row-title">{task.title}</span>
		<span className="task-row-line">{line}</span>
	</button>;
}

/** The tasks a turn dispatched (`steps`), or with `items` every task no turn in the chat dispatched (a restored chat). */
export function TaskRows({ steps, items }) {
	const { board, activity } = useTaskView();
	const placed = items ? new Set(dispatchedTaskIds(items)) : null;
	const ids = placed ? board.order.filter(id => !placed.has(id)) : [...new Set(dispatchedTaskIds(steps))].filter(id => board.tasks[id]);
	if (!ids.length) return null;
	return <div className="task-rows">{ids.map(id => <TaskRow key={id} task={board.tasks[id]} activity={activity} />)}</div>;
}

const GROUPS = [["failed", ko("need a look", "확인 필요")], ["running", ko("running", "실행 중", "执行中")], ["waiting", ko("waiting", "대기")], ["done", ko("done", "완료")]];

export function TaskStrip() {
	const { board, activity } = useTaskView();
	const [expanded, setExpanded] = useState(false);
	if (!board.order.length) return null;
	const groups = boardGroups(board);
	const shown = GROUPS.filter(([key]) => groups[key].length);
	return <div className="task-strip" data-expanded={expanded ? "true" : "false"}>
		<button type="button" className="task-strip-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
			{shown.map(([key, label]) => <span key={key} className="task-strip-count" data-status={key}><span className="task-dot" aria-hidden="true" />{groups[key].length} {label}</span>)}
			<FiChevronDown className="task-strip-caret" size={12} aria-hidden="true" />
		</button>
		{expanded && <div className="task-rows task-strip-list">{shown.flatMap(([key]) => groups[key]).map(task => <TaskRow key={task.taskId} task={task} activity={activity} />)}</div>}
	</div>;
}

function TaskFrames({ client, turnId, labelOf }) {
	const [lines, setLines] = useState([]);
	useEffect(() => {
		if (!turnId || !client) return undefined;
		const controller = new AbortController();
		let reply = "";
		client.frames(turnId, frame => {
			if (frame.type === "text.delta") { reply += frame.text ?? ""; setLines(list => [...list.filter(line => line.kind !== "reply"), { kind: "reply", text: reply }]); return; }
			const label = frame.type === "tool.done" || (frame.type === "studio.waiting" && !frame.waiting) ? null : progressLine(frame, labelOf);
			if (frame.type === "tool.start") reply = "";
			if (label) setLines(list => [...list.filter(line => line.kind !== "reply"), ...(reply ? [{ kind: "said", text: reply }] : []), { kind: frame.type === "error" ? "error" : "tool", text: label }].slice(-40));
		}, controller.signal).catch(() => {});
		return () => controller.abort();
	}, [client, turnId, labelOf]);
	if (!lines.length) return <p className="task-frames-empty">{ko("No steps yet.", "아직 단계가 없어요.")}</p>;
	return <ol className="task-frames">{lines.map((line, index) => <li key={index} data-kind={line.kind}>{line.text}</li>)}</ol>;
}

export function TaskDetail() {
	const { board, open, client, undo, labelOf } = useTaskView();
	const task = open ? board.tasks[open] : null;
	return task ? <OpenTask key={task.taskId} task={task} client={client} undo={undo} labelOf={labelOf} /> : null;
}

function OpenTask({ task, client, undo, labelOf }) {
	const [notice, setNotice] = useState("");
	const [steering, setSteering] = useState("");
	useEffect(() => {
		const onKey = event => { if (event.key === "Escape") openTask(null); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const active = ACTIVE_STATUSES.has(task.status);
	const cost = costLabel(task.usage);
	const act = async (run, done) => { setNotice(""); try { await run(); setNotice(done); } catch (error) { setNotice(String(error?.message ?? error)); } };
	const steer = event => {
		event.preventDefault();
		const text = steering.trim();
		if (text) act(() => client.steer(task.taskId, text), ko("Sent to this task.", "이 작업에 전달함.")).then(() => setSteering(""));
	};
	return <section className="task-detail" data-status={task.status} data-task-id={task.taskId} aria-label={task.title}>
		<header className="task-detail-head">
			<button type="button" className="agent-ghost-button task-detail-back" onClick={() => openTask(null)} autoFocus><FiChevronLeft size={13} aria-hidden="true" />{ko("Chat", "대화")}</button>
			<span className="task-detail-title">{task.title}</span>
		</header>
		<div className="task-detail-body">
			<div className="task-detail-meta" data-status={task.status}>
				<span className="task-dot" aria-hidden="true" />
				<span>{TASK_STATUS_COPY[task.status] ?? task.status}{cost ? ` · ${cost}` : ""}</span>
				{active && <button type="button" className="agent-ghost-button task-detail-cancel" onClick={() => act(() => client.cancel(task.taskId), ko("Cancelled; its changes go back.", "취소함: 바뀐 것은 되돌아가요."))}>{ko("Cancel", "취소")}</button>}
				{task.status === "done" && !task.undone && <button type="button" className="agent-ghost-button task-detail-undo" onClick={() => act(() => undo(task.taskId), ko("Undone.", "되돌림."))}>{ko("Undo task", "작업 되돌리기")}</button>}
			</div>
			{task.scope?.length > 0 && <p className="task-detail-scope" title={task.scope.join(", ")}>{ko("Touches", "건드리는 것")}: {[...new Set(task.scope.map(scopeLabel))].join(" · ")}</p>}
			{task.reason && task.status !== "done" && <p className="task-detail-reason">{taskReason(task.reason)}</p>}
			{task.notes?.map((text, index) => <p key={index} className="task-detail-note">{text}</p>)}
			{task.summary?.reply && !active && <p className="task-detail-summary">{task.summary.reply}</p>}
			<TaskFrames key={task.turnId} client={client} turnId={task.turnId} labelOf={labelOf} />
			{notice && <p className="task-detail-notice" role="status">{notice}</p>}
		</div>
		{task.status === "running" && <form className="task-detail-steer" onSubmit={steer}>
			<input value={steering} onChange={event => setSteering(event.target.value)} placeholder={ko("Tell this task…", "이 작업에게 지시…")} aria-label={ko("Tell this task", "이 작업에게 지시")} />
		</form>}
	</section>;
}
