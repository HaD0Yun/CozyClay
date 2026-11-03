// Task mode's board, headless (task-board.js): it follows the main session's task events, each running task's
// progress and the compile pool, and publishes them to taskView; TaskInline.jsx draws them in the chat. It also marks
// the outliner rows inside a running task's scope, and carries the main agent's own reports (main.turn) into the chat.
// Loaded lazily: the compile pool it watches belongs to the Studio, never the workflow page.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ko } from "../locale.js";
import { useBus } from "../app-context.js";
import { compileActivity, watchCompileActivity } from "../commands/motion3-compile.js";
import { createTaskBoardClient, emptyBoard, progressLine, reduceBoard, reduceScopes, seedBoard, taskView } from "./task-board.js";

const RETRY_MS = 2000;
const sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

/** Marks outliner rows (data-node-id is the scope key: object:<id>, character:<id>) inside running tasks' scopes. */
function useScopeBadges(scopes, titles) {
	useEffect(() => {
		const owner = new Map();
		for (const [taskId, keys] of Object.entries(scopes)) for (const key of keys) owner.set(key, titles[taskId] ?? taskId);
		const paint = () => {
			for (const row of document.querySelectorAll("[data-node-id]")) {
				const title = owner.get(row.getAttribute("data-node-id"));
				if (title) { row.setAttribute("data-task-scope", title); row.setAttribute("title", ko(`In task: ${title}`, `작업 중: ${title}`, `任务中：${title}`)); }
				else if (row.hasAttribute("data-task-scope")) { row.removeAttribute("data-task-scope"); row.removeAttribute("title"); }
			}
		};
		paint();
		const observer = new MutationObserver(paint);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => { observer.disconnect(); owner.clear(); paint(); };
	}, [scopes, titles]);
}

export default function TaskBoard({ sessionId, pulse, labelOf, onMainNote }) {
	const client = useMemo(() => createTaskBoardClient(), []);
	const bus = useBus();
	const [board, dispatch] = useReducer((state, action) => (action.seed ? seedBoard(state, action.seed) : action.reset ? emptyBoard() : reduceBoard(state, action.event)), undefined, emptyBoard);
	const [scopes, setScopes] = useState({});
	const [activity, setActivity] = useState(compileActivity);
	const afterRef = useRef(0);
	const noteRef = useRef(onMainNote);
	useEffect(() => { afterRef.current = board.after; noteRef.current = onMainNote; }, [board.after, onMainNote]);

	useEffect(() => { dispatch({ reset: true }); afterRef.current = 0; }, [sessionId]);
	useEffect(() => watchCompileActivity(setActivity), []);
	useEffect(() => bus.subscribe(event => {
		if (typeof event?.type !== "string" || !event.type.startsWith("task.")) return;
		setScopes(current => reduceScopes(current, event));
		if (event.type === "task.userEdit" || event.type === "task.undone") dispatch({ event });
	}), [bus]);

	// The board's live events; the main session exists only after its first turn, so a refusal retries (pulse: a turn ended).
	useEffect(() => {
		if (!sessionId) return undefined;
		const controller = new AbortController();
		(async () => {
			while (!controller.signal.aborted) {
				try {
					const { tasks } = await client.board(sessionId);
					dispatch({ seed: tasks });
					await client.events(sessionId, afterRef.current, event => {
						if (event.type === "main.turn" && event.turnId) {
							let text = "";
							client.frames(event.turnId, frame => { if (frame.type === "text.delta") text += frame.text ?? ""; if (frame.type === "tool.start" || frame.type === "error" && frame.code === "aborted") text = ""; }, controller.signal)
								.then(() => noteRef.current?.(text), () => {});
						}
						dispatch({ event });
					}, controller.signal);
				} catch { /* not there yet, or the stream dropped: try again */ }
				await sleep(RETRY_MS, controller.signal);
			}
		})();
		return () => controller.abort();
	}, [client, sessionId, pulse]);

	// A running card's progress line: its own frames, the last tool it started.
	const running = board.order.filter(id => board.tasks[id]?.status === "running" && board.tasks[id]?.turnId);
	const runningKey = running.map(id => `${id}:${board.tasks[id].turnId}`).join();
	useEffect(() => {
		const controllers = running.map(id => {
			const controller = new AbortController(), { turnId } = board.tasks[id];
			client.frames(turnId, frame => { const line = progressLine(frame, labelOf); if (line) dispatch({ event: { type: "task.progress", taskId: id, status: "running", progress: line } }); }, controller.signal).catch(() => {});
			return controller;
		});
		return () => controllers.forEach(controller => controller.abort());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, runningKey, labelOf]);

	const titles = useMemo(() => Object.fromEntries(board.order.map(id => [id, board.tasks[id].title])), [board]);
	useScopeBadges(scopes, titles);

	useEffect(() => {
		taskView.set({ client, labelOf, undo: async taskId => {
			const receipt = await bus.run("task.undo", { taskId });
			if (receipt?.ok === false) throw new Error(receipt.message ?? receipt.code);
			dispatch({ event: { type: "task.undone", taskId } });
		} });
	}, [bus, client, labelOf]);
	useEffect(() => { taskView.set({ board, activity }); }, [board, activity]);
	// Task mode off or another session: nothing of this board is shown any more.
	useEffect(() => () => taskView.set({ board: emptyBoard(), open: null }), [sessionId]);
	return null;
}
