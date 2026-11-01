// The main agent of parallel Studio tasks (P2): its tools, what it reads each turn, and the check on what it says.
// It holds no editor transaction: it reads the scene, dispatches tasks to the board (studio-tasks.mjs) and makes at
// most one small edit itself, inside a one-command task of its own (quick_edit). It hears of tasks only through the
// board's events, which reach it in its context; a reply that calls a task finished without that task's done event is
// corrected before the turn ends (case 15).
import { randomUUID } from "node:crypto";

const QUICK_TOOLS = ["arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "run_action"];
// No compile, no task or turn control, no document action: a quick edit is one small authored change.
const QUICK_REFUSED = /compile|^motion\.|^task\.|^agent\.|^(scene|project)\.|^load_scenes$/;
const keys = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32, description: "scope keys: object:<id>, character:<id>, shot:<id>, stage, timeline, scene" };
const verify = { type: "boolean", description: "end in review, not done: its dependents wait until you accept_task or reject_task it" };
// A task's timing is for measuring the board, not for the coordinator's decisions: it stays out of its context (case 16).
const bare = ({ timing: _timing, ...view }) => view;
const fn = (name, description, properties, required) => ({ type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } });

/** The main agent's tools: inspect_studio from the run's own Studio tools, the board's, and quick_edit. */
export function createMainTools({ board, studio, hub, admission, workspaceHandle }) {
	const inspect = studio.find(tool => tool.name === "inspect_studio");
	const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };
	const control = (action, taskId, args = {}) => hub.command("run_action", { name: "run_action", args: { action, args: { taskId, ...args } }, taskId,
		commandId: randomUUID(), host: admission.host, expectedRevision: admission.revision }, workspaceHandle);
	return [
		inspect,
		{ ...fn("dispatch_task", "Start a task: a Studio agent that does the work inside its scope while you keep talking. Answers its taskId and status (queued, waiting with the reason, or duplicateOf an equal task).",
			{ title: { type: "string", maxLength: 120 }, instructions: { type: "string", maxLength: 6000, description: "what to do, self-contained" }, scope: keys,
				reads: { ...keys, minItems: 0, description: "keys the task reads but does not change (it hears when they change)" }, dependsOn: { type: "array", items: { type: "string" }, maxItems: 8 }, verify },
			["title", "instructions", "scope"]),
		handler: args => bare(board.dispatch(args)) },
		{ ...fn("dispatch_plan", "Queue several tasks that depend on each other in one call: each has a local ref, and dependsOn names refs of this plan or taskIds of earlier tasks. A cycle or an unknown ref refuses the whole plan. Answers every task with its ref, taskId and status.",
			{ tasks: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["ref", "title", "instructions", "scope"], properties: {
				ref: { type: "string", maxLength: 40 }, title: { type: "string", maxLength: 120 }, instructions: { type: "string", maxLength: 6000, description: "what to do, self-contained" }, scope: keys,
				reads: { ...keys, minItems: 0, description: "keys the task reads but does not change (it hears when they change)" }, dependsOn: { type: "array", items: { type: "string" }, maxItems: 8, description: "refs of this plan or earlier taskIds" }, verify } } } },
			["tasks"]),
		handler: args => ({ tasks: board.dispatchPlan(args).tasks.map(bare) }) },
		{ ...fn("steer_task", "Add to a running task's instructions (the user changed their mind about its work).", { taskId: { type: "string" }, text: { type: "string", maxLength: 4000 } }, ["taskId", "text"]),
			handler: async ({ taskId, text }) => {
				const task = board.get(taskId) ?? fail("STALE_TARGET", `No task ${taskId}.`);
				if (!task.steer) fail("TARGET_NOT_READY", `Task ${taskId} is ${task.status}; dispatch a new task instead.`);
				await task.steer(text);
				return { ok: true, taskId, queued: true };
			} },
		{ ...fn("cancel_task", "Stop a task; what it changed goes back.", { taskId: { type: "string" } }, ["taskId"]),
			// an ended task holds nothing on the board; a scope its run left open in the editor is released by the next task's begin
			handler: ({ taskId }) => { const task = board.get(taskId) ?? fail("STALE_TARGET", `No task ${taskId}.`), view = board.cancel(taskId);
				if (!view && task.status === "review") fail("STALE_TARGET", `Task ${taskId} is in review: accept_task or reject_task it.`);
				return view ? bare(view) : { taskId, status: task.status, note: `Task ${taskId} already ended (${task.status}); its scope is free: dispatch the next task now.` }; } },
		{ ...fn("accept_task", "Accept a task in review (dispatched with verify): it is done and the tasks that depend on it start.", { taskId: { type: "string" } }, ["taskId"]),
			handler: ({ taskId }) => bare(board.accept(taskId) ?? fail("STALE_TARGET", `Task ${taskId} is not in review.`)) },
		{ ...fn("reject_task", "Reject a task in review: it fails with your reason and the tasks that depend on it fail too. Its changes stay (the user can undo the task).", { taskId: { type: "string" }, reason: { type: "string", maxLength: 300 } }, ["taskId", "reason"]),
			handler: ({ taskId, reason }) => bare(board.reject(taskId, reason) ?? fail("STALE_TARGET", `Task ${taskId} is not in review.`)) },
		{ ...fn("task_board", "List every task with its status, scope, reason and summary.", {}, []), handler: () => ({ tasks: board.board().map(bare) }) },
		{ ...fn("quick_edit", "Make ONE small edit yourself inside scope (no motion compile, no scene or project action): tool is one of arrange_objects, arrange_characters, patch_elements, frame_shot, run_action with its usual args.",
			{ scope: keys, tool: { enum: QUICK_TOOLS }, args: { type: "object" } }, ["scope", "tool", "args"]),
		handler: async ({ scope, tool, args }) => {
			if (tool === "run_action" && QUICK_REFUSED.test(String(args?.action ?? ""))) fail("CAPABILITY_MISSING", `${args.action} is task work: dispatch_task it.`);
			const studioTool = studio.find(entry => entry.name === tool) ?? fail("INVALID_ARGUMENT", `Unknown tool ${tool}.`);
			const taskId = randomUUID(), begun = await control("task.begin", taskId, { scope, title: "quick edit" });
			if (!begun.ok) fail(begun.code, begun.message);
			admission.taskId = taskId;
			try { return await studioTool.handler(args); }
			finally { delete admission.taskId; await control("task.finish", taskId).catch(() => {}); }
		} },
	];
}

/** The board and the events the main agent has not seen yet, appended to its Studio context each turn. */
// What one turn's context may carry about tasks: a stuck task once told 7021 events in a minute and the next message
// no longer fit the model (prompt too long). Repeats fold into one line with a count; the newest lines win.
const MAX_EVENTS = 50, MAX_EVENT_BYTES = 20_000, MAX_BOARD = 24, MAX_BOARD_BYTES = 20_000;
const cut = (text, n) => (typeof text === "string" && text.length > n ? `${text.slice(0, n - 1)}…` : text);
const slim = ({ timing: _timing, usage: _usage, summary, reason, ...view }) => ({ ...view, ...(reason ? { reason: cut(reason, 400) } : {}), ...(summary ? { summary: { reply: cut(summary.reply, 1200) } } : {}) });
const capped = (items, max, bytes) => {
	const kept = items.slice(-max);
	while (kept.length > 1 && JSON.stringify(kept).length > bytes) kept.shift();
	return { kept, dropped: items.length - kept.length };
};

/** The <task-board> and <task-events> blocks of the main agent's next message, each under ~20 KB whatever happened. */
export function mainContextText(board, events) {
	const rows = capped(board.board().map(bare).map(task => ({ ...slim(task), usage: { cost: Number(task.usage.cost.toFixed(4)), requests: task.usage.requests } })), MAX_BOARD, MAX_BOARD_BYTES);
	const folded = [];
	for (const event of events.map(slim)) {
		const last = folded.findLast(e => e.taskId === event.taskId);
		const flip = ["task.waiting", "task.started"], same = last && flip.includes(event.type) && flip.includes(last.type) && (!event.reason || !last.reason || last.reason === event.reason);
		if (same) Object.assign(last, { repeats: (last.repeats ?? 1) + 1, type: event.type, status: event.status, at: event.at, reason: event.reason ?? last.reason });
		else folded.push(event);
	}
	const told = capped(folded, MAX_EVENTS, MAX_EVENT_BYTES);
	const more = (n, what) => (n ? `\n(${n} older ${what} left out)` : "");
	return `\n<task-board>${JSON.stringify(rows.kept)}${more(rows.dropped, "tasks")}</task-board>${told.kept.length ? `\n<task-events>${JSON.stringify(told.kept)}${more(told.dropped, "events")}</task-events>` : ""}`;
}

const DONE = /(완료|끝났|끝냈|마쳤|마무리|설치했|적용했|반영했|해결했|\bdone\b|\bfinished\b|\bcompleted?\b|\binstalled\b|\bapplied\b)/i;
const STATUS_KO = { review: "검토 대기", queued: "대기 중", waiting: "대기 중", starting: "시작 중", running: "진행 중", paused: "일시정지", failed: "실패", cancelled: "취소됨" };

/**
 * A correction for every sentence of `reply` that calls a task finished while the board says otherwise, in the user's
 * language (Korean when `userText` has Hangul), or null when the reply only claims what happened.
 */
export function doneClaimCorrection(reply, tasks, userText = "") {
	const korean = /[가-힣]/.test(userText);
	const wrong = tasks.filter(task => task.status !== "done").filter(task => String(reply).split(/(?<=[.!?。])\s+|\n+/).some(sentence => DONE.test(sentence)
		&& (sentence.includes(task.taskId) || (task.title.length >= 4 && sentence.toLowerCase().includes(task.title.toLowerCase().slice(0, 24))))));
	if (!wrong.length) return null;
	return `\n\n${wrong.map(task => korean ? `(정정: "${task.title}" 작업은 아직 끝나지 않았습니다. 지금 ${STATUS_KO[task.status] ?? task.status}입니다.)` : `(Correction: task "${task.title}" has not finished; it is ${task.status}.)`).join("\n")}`;
}
