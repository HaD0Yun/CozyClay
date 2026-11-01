// The Studio task board in the agent panel (parallel tasks, P3). Task mode is a per-browser switch, on by default (the panel's Tasks
// toggle) or the server's COZYCLAY_STUDIO_TASKS flag: the chat then talks to the main agent (POST /agent/main), which
// answers at once and dispatches tasks; this board shows them. Pure parts here (the reducer, labels, the switch's
// storage); the network side is createTaskBoardClient; the view is TaskBoard.jsx.
//   server events (GET /agent/main/<sessionId>/events): task.queued|waiting|started|resumed|paused|review|done|failed|cancelled
//     carry the task's view { taskId, title, status, scope, reason?, turnId?, usage, summary? }; task.sceneChanged
//     { taskId, keys, midCommand }; main.turn { turnId } (the main agent reporting on its own)
//   editor events (the command bus): task.userEdit { taskId, keys } (the user changed something in its scope)
//   compile activity (motion3-compile.js): { running, waiting } of { taskId, characterId }
import { ko } from "../locale.js";
import { sidecarUrl } from "../agent-image-client.js";
import { parseSseChunk } from "./agent-client.js";

const TASKS_KEY = "cozyclay.agent.tasks";
export function readStoredTaskMode(storage = globalThis.localStorage) {
	try { return storage?.getItem(TASKS_KEY) !== "off"; } catch { return true; } // on unless the author turned it off
}
export function storeTaskMode(enabled, storage = globalThis.localStorage) {
	try { storage?.setItem(TASKS_KEY, enabled ? "on" : "off"); } catch { /* storage may be unavailable */ }
}

export const TASK_STATUS_COPY = {
	queued: ko("Queued", "대기열"),
	waiting: ko("Waiting for scope", "영역 대기"),
	starting: ko("Starting", "시작 중"),
	running: ko("Running", "작업 중"),
	paused: ko("Paused: Studio lost", "일시정지: Studio 연결 끊김"),
	review: ko("Being checked", "확인 중"),
	done: ko("Done", "완료"),
	failed: ko("Failed", "실패"),
	cancelled: ko("Cancelled", "취소됨"),
};
export const ACTIVE_STATUSES = new Set(["queued", "waiting", "starting", "running", "paused"]);

export const emptyBoard = () => ({ order: [], tasks: {}, after: 0 });

/** The board after one event (server, editor or compile). Unknown events leave it as it is. */
export function reduceBoard(board, event) {
	if (!event || typeof event !== "object") return board;
	const after = Number.isFinite(event.eventSeq) ? Math.max(board.after, event.eventSeq) : board.after;
	const patch = (taskId, change) => {
		const known = board.tasks[taskId];
		if (!known && !change.title) return { ...board, after };
		const task = { notes: [], ...known, ...change, taskId };
		return { ...board, after, order: known ? board.order : [...board.order, taskId], tasks: { ...board.tasks, [taskId]: task } };
	};
	const note = (taskId, text) => (board.tasks[taskId] ? patch(taskId, { notes: [...board.tasks[taskId].notes, text].slice(-4) }) : { ...board, after });
	if (event.type === "task.sceneChanged") return note(event.taskId, ko(`The scene changed during a reload: ${event.keys.join(", ")}`, `새로고침 중에 장면이 바뀜: ${event.keys.join(", ")}`, `重新加载期间场景发生变化：${event.keys.join(", ")}`));
	if (event.type === "task.userEdit") return note(event.taskId, ko(`You changed ${event.keys.join(", ")}; the task reads it again`, `${event.keys.join(", ")}을(를) 직접 바꿈: 작업이 다시 읽어요`, `你修改了 ${event.keys.join(", ")}；任务会重新读取`));
	if (event.type === "task.undone") return board.tasks[event.taskId] ? patch(event.taskId, { undone: true }) : board;
	if (typeof event.type === "string" && event.type.startsWith("task.") && event.taskId && event.status) {
		const { type, at, eventSeq, ...view } = event;
		return patch(event.taskId, { ...view, ...(type === "task.started" || type === "task.resumed" ? { progress: "" } : {}) });
	}
	return { ...board, after };
}

/** A board read (GET .../board) merged under what the events already said. */
export function seedBoard(board, tasks = []) {
	return tasks.reduce((acc, view) => (acc.tasks[view.taskId] ? acc : reduceBoard(acc, { type: "task.seed", ...view })), board);
}

/** The line a running card shows: the last tool it started, or the compile it waits for. */
export function progressLine(frame, labelOf = call => call.name) {
	if (frame?.type === "tool.start") return labelOf(frame);
	// The sidecar waits out the user's own drag (bin/agent/studio-busy-wait.mjs): a quiet status, never an error.
	if (frame?.type === "studio.waiting") return frame.waiting ? ko("Waiting: the user is editing", "대기 중: 사용자가 편집 중", "等待：用户正在编辑") : ko("Working…", "작업 중…");
	if (frame?.type === "error") return ko(`Error: ${frame.message ?? frame.code}`, `오류: ${frame.message ?? frame.code}`, `错误：${frame.message ?? frame.code}`);
	return null;
}

/** A task's wait or failure reason in the author's words: the server names the blocking task by id and title. */
export function taskReason(reason) {
	// Greedy to the last ")": a title may hold parentheses of its own.
	const after = /(?:waits for|held by) task \S+ \((.+)\)/.exec(String(reason ?? ""))?.[1];
	if (after) return ko(`Starts after "${after}"`, `'${after}' 끝나면 시작`, `在“${after}”之后开始`);
	if (/scope is held/.test(String(reason ?? ""))) return ko("Starts when another task frees its part", "다른 작업이 끝나면 시작");
	return reason ?? "";
}

/** The one line a task row shows after its title. */
export function taskLine(task) {
	if (task.status === "running") return task.progress || ko("Working…", "작업 중…");
	if (task.status === "done") return task.undone ? ko("Undone", "되돌림") : String(task.summary?.reply ?? "").split(/(?<=[.!?。])\s/)[0] || TASK_STATUS_COPY.done;
	if (task.reason) return taskReason(task.reason);
	return TASK_STATUS_COPY[task.status] ?? task.status;
}

const SCOPE_NAMES = { timeline: ko("timeline", "타임라인"), stage: ko("stage", "무대"), scene: ko("scene", "장면"), object: ko("object", "오브젝트"), character: ko("character", "캐릭터"), shot: ko("shot", "샷") };
/** A scope key (object:<id>, timeline, ...) as a word; the raw key stays in the tooltip. */
export const scopeLabel = key => SCOPE_NAMES[String(key).split(":")[0]] ?? String(key);

/** Rows by state for the status line: what needs a look first, then what runs, waits and ended. */
export function boardGroups(board) {
	const groups = { failed: [], running: [], waiting: [], done: [] };
	for (const id of board.order) {
		const task = board.tasks[id];
		// review: the run ended but the coordinator still checks it, so it waits (and offers no cancel: not in ACTIVE_STATUSES).
		const group = task.status === "failed" || task.status === "paused" ? "failed" : task.status === "running" || task.status === "starting" ? "running" : ACTIVE_STATUSES.has(task.status) || task.status === "review" ? "waiting" : "done";
		groups[group].push(task);
	}
	return groups;
}

/** The task ids a turn's dispatch_task and dispatch_plan steps started, in order (a duplicate points at the task it repeats). */
export const dispatchedTaskIds = steps => (steps ?? []).filter(step => step.kind === "tool" && ["dispatch_task", "dispatch_plan"].includes(step.name))
	.flatMap(step => (step.name === "dispatch_plan" ? step.result?.tasks ?? [] : [step.result])).map(result => result?.taskId ?? result?.duplicateOf).filter(Boolean);

/** What the task view shares between the headless board (TaskBoard.jsx) and the rows in the chat (TaskInline.jsx). */
function createTaskViewStore() {
	let state = { board: emptyBoard(), activity: null, client: null, undo: null, open: null };
	const listeners = new Set();
	return {
		get: () => state,
		set: patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
		subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
	};
}
// One agent panel per page, so one view.
export const taskView = createTaskViewStore();

/** "$0.12" for a task's cost, or "" when nothing is known yet. */
export const costLabel = usage => (Number.isFinite(usage?.cost) && usage.cost > 0 ? `$${usage.cost.toFixed(2)}` : "");

/** The compile a task waits for: how many of its compiles wait and how many run. */
export function compileState(activity, taskId) {
	const mine = list => (list ?? []).filter(meta => meta?.taskId === taskId).length;
	return { waiting: mine(activity?.waiting), running: mine(activity?.running) };
}

/** The open scopes the editor's bus reports: taskId -> keys (task.begun / task.scope / task.finished|cancelled). */
export function reduceScopes(scopes, event) {
	if (event?.type === "task.begun" || event?.type === "task.scope") return { ...scopes, [event.taskId]: event.scope ?? [] };
	if (event?.type === "task.finished" || event?.type === "task.cancelled") { const { [event.taskId]: _gone, ...rest } = scopes; return rest; }
	return scopes;
}

/**
 * The sidecar side of the board. All requests are same-origin with the Studio session's owner cookie.
 * fetchImpl(url, init) -> Response; url(path) -> the sidecar URL.
 */
export function createTaskBoardClient({ fetchImpl = globalThis.fetch?.bind(globalThis), url = sidecarUrl } = {}) {
	const json = async (path, init) => {
		const response = await fetchImpl(url(path), { credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, ...init });
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `${response.status}`), { status: response.status, code: body?.error?.code });
		return body;
	};
	/** Streams an SSE route to onEvent until it ends or signal aborts. */
	async function stream(path, onEvent, signal) {
		const response = await fetchImpl(url(path), { credentials: "same-origin", headers: { accept: "text/event-stream" }, signal });
		if (!response.ok || !response.body) throw Object.assign(new Error(`${response.status}`), { status: response.status });
		const reader = response.body.getReader(), decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const parsed = parseSseChunk(buffer + decoder.decode(value, { stream: true }));
				buffer = parsed.tail;
				for (const event of parsed.events) onEvent(event);
			}
		} finally { reader.releaseLock(); }
	}
	const id = value => encodeURIComponent(value);
	return {
		board: sessionId => json(`/agent/main/${id(sessionId)}/board`),
		events: (sessionId, after, onEvent, signal) => stream(`/agent/main/${id(sessionId)}/events?after=${after}`, onEvent, signal),
		frames: (turnId, onEvent, signal) => stream(`/agent/turn/${id(turnId)}/events?after=0`, onEvent, signal),
		cancel: taskId => json(`/agent/task/${id(taskId)}/cancel`, { method: "POST", body: "{}" }),
		steer: (taskId, text) => json(`/agent/task/${id(taskId)}/steer`, { method: "POST", body: JSON.stringify({ text }) }),
	};
}
