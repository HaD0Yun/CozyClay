// Parallel Studio tasks, P2 (the server; plan: ~/.claude/plans/parallel-studio-agents.md, cases by number). The main
// agent answers the user at once and hands work to tasks; each task is an ordinary Studio agent run (studio-prompt.mjs,
// its own history) inside task.begin..finish on its scope (src/bus-tasks.js). This file is the board: it queues, starts
// and ends tasks and tells the main agent what happened, never what it hopes happened.
//   - at most CAP running tasks; the rest wait (11), the longest chain of work still to come first: a task that others
//     wait on starts before an independent one, so the plan ends sooner. Waiting adds a level every AGING ms, so an
//     independent task is not starved by a stream of chains; equal scores keep the order they came in
//   - a task whose scope another running task holds waits for it; the bus is the authority (SCOPE_BUSY at begin) (1)
//   - dependsOn: a task starts after those are done and hears their summaries; a failed one fails it (8)
//   - verify: a task the coordinator wants to check ends in review, not done; it holds no scope (it finished running)
//     but its dependents wait until accept (done, they start) or reject (failed, they fail): a wrong result is caught
//     before work is built on it (8)
//   - a plan queues a whole dependency graph at once: local refs name its steps, and a cycle or an unknown ref refuses
//     all of it before one task is queued, so the board never holds half a plan (8)
//   - a second task starts only once the first one's model has answered, or STAGGER ms passed: the shared prompt prefix
//     is then cached once, not written by every task at the same moment (12)
//   - usage and cost per task (13); summaries are capped so the main agent's context stays small (16)
//   - a done task also says what it changed as data (the ids its receipts touched, as scope keys where its scope names
//     them), so a dependent reads which targets moved instead of parsing the summary text (8)
//   - a run whose Studio went away pauses, and resumes when the main agent next sees the same scene; another scene fails
//     it (14)
//   - timing per task, in memory like the rest: queued, started and ended at, and the time it waited on a held scope, on
//     its dependencies and on the cap, so the scheduling can be judged from data (in the view and the ended event)
//   - the same instructions on the same scope as a queued or running task are not started twice (19)
//   - a task that runs past MAX_MS or MAX_TOOLS tool calls is stopped and reported as such (20)
import { randomUUID } from "node:crypto";
import { isScopeKey, scopeConflict } from "../../src/bus-task-scopes.js";

export const TASK_LIMITS = Object.freeze({ cap: 3, staggerMs: 1500, maxMs: 20 * 60_000, maxTools: 120, summaryChars: 1200, receipts: 8, changed: 24, agingMs: 60_000, busyMaxMs: 15_000 });
const ACTIVE = new Set(["queued", "waiting", "starting", "running", "paused", "review"]);
const ENDED = new Set(["done", "failed", "cancelled"]);
const norm = text => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * run(task, { resume }) runs one task to its end and answers { status: "done" | "failed" | "cancelled" | "lost" |
 * "scopeBusy", reply, receipts, usage, error }; it calls task.onFrame(frame) for every frame. emit(event) tells the
 * main agent (task.queued, task.started, task.review, task.done, task.failed, task.cancelled, task.paused, task.resumed).
 */
export function createTaskBoard({ run, emit = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, limits = {} } = {}) {
	const L = { ...TASK_LIMITS, ...limits }, tasks = new Map();
	let lastStart = null, scheduled = null, planning = false;
	const list = () => [...tasks.values()];
	const running = () => list().filter(task => ["starting", "running"].includes(task.status));
	const scopes = () => new Map(running().map(task => [task.taskId, { taskId: task.taskId, title: task.title, keys: new Set(task.scope) }]));
	const view = task => ({ taskId: task.taskId, title: task.title, status: task.status, scope: task.scope, ...(task.reason ? { reason: task.reason } : {}), ...(task.turnId ? { turnId: task.turnId } : {}),
		...(task.dependsOn.length ? { dependsOn: task.dependsOn } : {}), ...(task.verify ? { verify: true } : {}), tools: task.tools, usage: task.usage, ...(task.summary ? { summary: task.summary } : {}), ...(task.changed?.length ? { changed: task.changed } : {}), timing: timing(task) });
	// An open wait counts up to now, so a board read mid-wait is already true.
	const waited = (task, kind) => task.waited[kind] + (task.wait?.kind === kind ? now() - task.wait.since : 0);
	const timing = task => ({ queuedAt: task.createdAt, ...(task.startedAt ? { startedAt: task.startedAt } : {}), ...(task.endedAt ? { endedAt: task.endedAt } : {}),
		waitScopeMs: waited(task, "scope"), waitDepsMs: waited(task, "deps"), waitCapMs: waited(task, "cap") });
	const closeWait = task => { if (task.wait) task.waited[task.wait.kind] += now() - task.wait.since; task.wait = null; };
	const waitOn = (task, kind) => { if (task.wait?.kind !== kind) { closeWait(task); task.wait = { kind, since: now() }; } };
	const tell = (type, task, extra = {}) => emit({ type, at: now(), ...view(task), ...extra });

	const invalid = message => Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
	function check({ instructions, scope }) {
		if (typeof instructions !== "string" || !instructions.trim()) throw invalid("A task needs instructions.");
		if (!Array.isArray(scope) || !scope.length || scope.some(key => !isScopeKey(key))) throw invalid("scope: one or more keys object:<id>, character:<id>, shot:<id>, stage, timeline or scene.");
	}

	function dispatch({ title, instructions, scope, reads = [], dependsOn = [], verify = false }) {
		check({ instructions, scope });
		const unknown = dependsOn.find(id => !tasks.has(id));
		if (unknown) throw invalid(`dependsOn: no task ${unknown}.`);
		const same = list().find(task => ACTIVE.has(task.status) && norm(task.instructions) === norm(instructions) && [...task.scope].sort().join() === [...scope].sort().join());
		if (same) return { duplicateOf: same.taskId, ...view(same) };
		const task = { taskId: randomUUID(), title: clip(String(title || instructions).trim(), 120), instructions, scope: [...new Set(scope)], reads, dependsOn, verify: verify === true,
			status: "queued", tools: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 }, createdAt: now(), warm: false, waited: { scope: 0, deps: 0, cap: 0 }, wait: null };
		tasks.set(task.taskId, task);
		tell("task.queued", task);
		if (!planning) schedule();
		return view(task);
	}

	// A whole graph in one call: every step is checked and ordered first, then queued, then scheduled once, so the first
	// step does not start before the steps that build on it are known.
	function dispatchPlan({ tasks: steps } = {}) {
		if (!Array.isArray(steps) || !steps.length) throw invalid("A plan needs one or more tasks.");
		const byRef = new Map();
		for (const step of steps) {
			if (typeof step?.ref !== "string" || !step.ref.trim()) throw invalid("Every plan task needs a ref.");
			if (byRef.has(step.ref)) throw invalid(`ref ${step.ref} is used twice.`);
			check(step); byRef.set(step.ref, step);
		}
		for (const step of steps) { const unknown = (step.dependsOn ?? []).find(dep => !byRef.has(dep) && !tasks.has(dep)); if (unknown) throw invalid(`dependsOn of ${step.ref}: no ref or task ${unknown}.`); }
		const order = [], state = new Map();
		const visit = (ref, path) => {
			if (state.get(ref) === "done") return;
			if (state.get(ref) === "open") throw invalid(`dependsOn forms a cycle: ${[...path, ref].join(" -> ")}.`);
			state.set(ref, "open");
			for (const dep of byRef.get(ref).dependsOn ?? []) if (byRef.has(dep)) visit(dep, [...path, ref]);
			state.set(ref, "done"); order.push(byRef.get(ref));
		};
		for (const step of steps) visit(step.ref, []);
		const ids = new Map(), out = new Map(); // ref -> taskId, ref -> its dispatch answer
		planning = true;
		try {
			for (const { ref, dependsOn = [], ...step } of order) {
				const queued = dispatch({ ...step, dependsOn: [...new Set(dependsOn.map(dep => ids.get(dep) ?? dep))] });
				ids.set(ref, queued.duplicateOf ?? queued.taskId); out.set(ref, queued);
			}
		} finally { planning = false; }
		schedule();
		// Answered after the one schedule pass, so each step reads as the board sees it now (running, waiting with why).
		return { tasks: steps.map(({ ref }) => ({ ref, ...(out.get(ref).duplicateOf ? { duplicateOf: ids.get(ref) } : {}), ...view(tasks.get(ids.get(ref))) })) };
	}

	// What still holds a queued task back, or null when it may start now.
	function blocker(task) {
		const failed = task.dependsOn.map(id => tasks.get(id)).find(dep => ["failed", "cancelled"].includes(dep.status));
		if (failed) return { fail: `it depends on task ${failed.taskId} (${failed.title}), which ${failed.status === "failed" ? "failed" : "was cancelled"}` };
		const open = task.dependsOn.map(id => tasks.get(id)).find(dep => dep.status !== "done");
		if (open) return { kind: "deps", wait: `waits for task ${open.taskId} (${open.title}) to ${open.status === "review" ? "be accepted" : "finish"}` };
		// the editor answered SCOPE_BUSY for a holder this board does not see: retry after the backoff, not at once
		if (task.retryAt > now()) return { kind: "scope", wait: task.reason, retry: task.retryAt - now() };
		const held = scopeConflict(task.taskId, task.scope, scopes());
		if (held) return { kind: "scope", wait: `${held}` };
		if (running().length >= L.cap) return { kind: "cap", wait: `${L.cap} tasks are running; it starts when one ends` };
		return null;
	}

	// The longest chain of not-ended tasks that depend on each task, counting the task itself (dependsOn has no cycle:
	// a dependency exists before its dependent, and a plan with a cycle is refused).
	function chains() {
		const dependents = new Map(), memo = new Map();
		for (const task of list()) if (!ENDED.has(task.status)) for (const id of task.dependsOn) dependents.set(id, [...(dependents.get(id) ?? []), task]);
		const chain = task => { if (!memo.has(task.taskId)) memo.set(task.taskId, 1 + Math.max(0, ...(dependents.get(task.taskId) ?? []).map(chain))); return memo.get(task.taskId); };
		return chain;
	}

	function schedule() {
		if (scheduled) return;
		const chain = chains(), score = task => chain(task) + Math.floor((now() - task.createdAt) / L.agingMs);
		for (const task of list().filter(task => ["queued", "waiting"].includes(task.status)).sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt)) {
			const held = blocker(task);
			if (held?.fail) { end(task, "failed", { reason: held.fail }); continue; }
			if (held) {
				waitOn(task, held.kind);
				if (held.retry && !task.wake) task.wake = setTimer(() => { task.wake = null; rescheduleNow(); }, held.retry);
				if (task.reason !== held.wait || task.status !== "waiting") { task.status = "waiting"; task.reason = held.wait; tell("task.waiting", task); }
				continue;
			}
			closeWait(task);
			// Cache warm-up: the previous start's model has not answered yet, and STAGGER has not passed.
			const wait = lastStart && !lastStart.warm ? lastStart.at + L.staggerMs - now() : 0;
			if (wait > 0) { scheduled = setTimer(() => { scheduled = null; schedule(); }, wait); return; }
			start(task);
		}
	}

	function rescheduleNow() { if (scheduled) { clearTimer(scheduled); scheduled = null; } schedule(); }

	function start(task, resume = null) {
		closeWait(task); task.status = "starting"; task.reason = undefined; task.startedAt ??= now();
		lastStart = { at: now(), warm: false, taskId: task.taskId };
		const mark = lastStart;
		task.controller = new AbortController();
		const deps = task.dependsOn.map(id => tasks.get(id)).map(dep => ({ taskId: dep.taskId, title: dep.title, summary: dep.summary, changed: dep.changed ?? [] }));
		task.timer = setTimer(() => stop(task, `it ran past ${Math.round(L.maxMs / 60_000)} minutes`), L.maxMs);
		task.onFrame = frame => {
			// a retry after SCOPE_BUSY says started once, not on every attempt
			if (task.status === "starting") { task.status = "running"; if (!task.toldStart) tell(resume ? "task.resumed" : "task.started", task); task.toldStart = true; }
			if (!mark.warm && ["text.delta", "tool.start", "thinking.delta"].includes(frame.type)) { mark.warm = true; rescheduleNow(); }
			if (frame.type === "tool.start" && ++task.tools > L.maxTools) stop(task, `it made more than ${L.maxTools} tool calls`);
		};
		Promise.resolve().then(() => run(task, { resume, deps, signal: task.controller.signal })).then(result => settle(task, result), error => settle(task, { status: "failed", error }));
	}

	function settle(task, result) {
		clearTimer(task.timer);
		if (lastStart?.taskId === task.taskId) lastStart.warm = true;
		for (const key of Object.keys(task.usage)) if (Number.isFinite(result?.usage?.[key])) task.usage[key] += result.usage[key];
		if (result.status === "scopeBusy") {
			// back off 1, 2, 4 .. 15 s; the waiting line is told once per distinct reason
			const reason = result.error?.message ?? "its scope is held by another task";
			task.busyTries = (task.busyTries ?? 0) + 1; task.retryAt = now() + Math.min(L.busyMaxMs, 1000 * 2 ** (task.busyTries - 1));
			waitOn(task, "scope"); task.status = "waiting";
			task.reason = reason;
			if (task.busyReason !== reason) { task.busyReason = reason; tell("task.waiting", task); }
		}
		else if (result.status === "lost") { task.status = "paused"; task.reason = "Studio disconnected; it resumes when Studio reconnects to the same scene"; task.sceneId = result.sceneId; tell("task.paused", task); }
		else {
			const summary = { reply: clip(String(result.reply ?? "").trim(), L.summaryChars), receipts: (result.receipts ?? []).slice(-L.receipts) };
			if (result.status === "done") task.changed = changedBy(task, result.receipts);
			// A cancel that arrived after the run finished cannot take it back: it stays done (and can be undone).
			const status = task.stopReason ? "failed" : task.cancelled && result.status !== "done" ? "cancelled" : result.status;
			end(task, status === "done" && task.verify ? "review" : status, { reason: task.stopReason ?? (result.status === "failed" ? clip(String(result.error?.message ?? result.error ?? "the run failed"), 300) : undefined), summary });
		}
		rescheduleNow();
	}

	// Every receipt counts, not only the capped ones the summary keeps; an id the scope names reads as its key, one the task
	// made (outside its declared scope) as the bare id.
	function changedBy(task, receipts = []) {
		const keyOf = id => task.scope.find(key => key.slice(key.indexOf(":") + 1) === id && /^(object|character|shot):/.test(key)) ?? id;
		return [...new Set(receipts.flatMap(receipt => receipt?.affectedIds ?? []).filter(id => typeof id === "string" && id).map(keyOf))].slice(0, L.changed);
	}

	function end(task, status, { reason, summary } = {}) {
		if (task.wake) { clearTimer(task.wake); task.wake = null; }
		// endedAt is when it stopped running: an accept after review does not move it.
		closeWait(task); task.status = status; task.reason = reason; task.endedAt ??= now();
		if (summary) task.summary = summary;
		tell(`task.${status === "done" ? "done" : status}`, task);
	}

	function stop(task, reason) {
		if (!["starting", "running"].includes(task.status)) return;
		task.stopReason = `stopped: ${reason}; ask the user whether to continue`;
		task.controller.abort(new Error(task.stopReason));
	}

	return {
		dispatch,
		dispatchPlan,
		board: () => list().map(view),
		get: taskId => tasks.get(taskId),
		/** Cancels a queued task, or stops a running one (its keys go back: task.cancel). */
		cancel(taskId) {
			const task = tasks.get(taskId);
			if (!task || ENDED.has(task.status) || task.status === "review") return null;
			if (["queued", "waiting", "paused"].includes(task.status)) { end(task, "cancelled", { reason: "cancelled before it ran" }); schedule(); return view(task); }
			task.cancelled = true; task.controller.abort(new Error("cancelled"));
			return view(task);
		},
		/** A task in review is done: its dependents start. */
		accept(taskId) {
			const task = tasks.get(taskId);
			if (task?.status !== "review") return null;
			end(task, "done"); schedule();
			return view(task);
		},
		/** A task in review is failed with the coordinator's reason: its dependents fail as after any failed task. */
		reject(taskId, reason) {
			const task = tasks.get(taskId);
			if (task?.status !== "review") return null;
			end(task, "failed", { reason: clip(`rejected by the coordinator: ${String(reason ?? "").trim() || "no reason given"}`, 300) }); schedule();
			return view(task);
		},
		/** A Studio context the main agent saw: paused tasks of that scene resume there, others fail. */
		reconnect(sceneId) {
			for (const task of list().filter(task => task.status === "paused")) {
				if (task.sceneId && task.sceneId !== sceneId) end(task, "failed", { reason: "Studio came back on another scene" });
				else start(task, { note: "Studio reconnected after a disconnect. Read the scene again before you continue the task from where you were." });
			}
			schedule();
		},
		running: () => running().map(view),
		dispose() { if (scheduled) clearTimer(scheduled); for (const task of running()) task.controller.abort(new Error("closed")); },
	};
}

/** The header a task's run reads before its instructions (after the cached system prompt and motion reference). */
export function taskHeader(task, { deps = [], resume = null } = {}) {
	return [`<task id="${task.taskId}">`,
		`You are one of several tasks working on this scene at once. Your scope (the only things you may change): ${task.scope.join(", ")}.`,
		"Everything else is read-only for you: another task or the user may be changing it. A command outside your scope is refused with SCOPE_DENIED; ask for more with run_action task.requestScope { taskId, scope }, and if that answers SCOPE_BUSY, do what you can inside your scope and say what is left.",
		"When you finish, end with a short report for the coordinator in English: what you changed (receipt ids, ids), the QA problems left, and anything not done. The coordinator talks to the user.",
		"Before you finish, check each visible criterion in the instructions (the user's words) and report it as met, unmet or not measurable by QA, with the measured value when there is one (anchor 7 cm off the bar). A QA count alone never means done.",
		...deps.map(dep => `Earlier task ${dep.taskId} (${dep.title}) is done: ${dep.summary?.reply ?? ""}${dep.changed?.length ? ` It changed: ${dep.changed.join(", ")}.` : ""}`),
		...(resume?.note ? [resume.note] : []),
		"</task>", "", task.instructions].join("\n");
}
