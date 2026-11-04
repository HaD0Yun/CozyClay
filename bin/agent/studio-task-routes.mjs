// The routes of parallel Studio tasks (P2), behind a flag until the panel ships (P3): single mode stays the default.
//   POST /agent/main                      a turn of the main agent (the Studio turn envelope); streams like /agent/turn
//   GET  /agent/main/<sessionId>/board    the tasks of that main session
//   GET  /agent/main/<sessionId>/events   the board's events, live (task.queued .. task.done), and main.turn when the
//                                         main agent reports on its own
//   POST /agent/main/<sessionId>/reconnect { context }: the panel came back (a reload) with the Studio's new handle; the
//                                         board follows it and resumes its paused tasks there
//   POST /agent/task/<taskId>/cancel      stop a task (its keys go back)
//   POST /agent/task/<taskId>/steer       { text }: add to a running task
// A task's run is an ordinary Studio turn (handleStudioTurn) in a child session the main session's owner owns, so its
// frames replay on GET /agent/turn/<turnId>/events like any turn's.
import { randomUUID } from "node:crypto";
import { createTaskBoard, taskHeader, TASK_LIMITS } from "./studio-tasks.mjs";
import { createMainTools, doneClaimCorrection, mainContextText } from "./main-agent.mjs";
import { MAIN_SYSTEM_PROMPT } from "./main-prompt.mjs";
import { LOST_STUDIO } from "./studio-turn-transaction.mjs";
import { TASK_SCOPE_ACTION } from "../../src/bus-tasks.js";

const TERMINAL = new Set(["task.review", "task.done", "task.incomplete", "task.failed", "task.cancelled", "task.paused"]);
const PREEMPT_WAIT_MS = 5000;
// A main turn with no model or tool event for idleMs ends with the reason (#1058), like a task's idle watchdog (studio-tasks.mjs).
const MAIN_TURN_LIMITS = Object.freeze({ idleMs: TASK_LIMITS.idleMs });
// A task's own action list names the one bus control it may send (the editor's registry does not list controls).
const withTaskActions = context => (Array.isArray(context?.actionIndex) && !context.actionIndex.some(row => row.id === TASK_SCOPE_ACTION.id)
	? { ...context, actionIndex: [...context.actionIndex, { id: TASK_SCOPE_ACTION.id, label: TASK_SCOPE_ACTION.label }] } : context);
const EVENT_TURN_TEXT = "(Task events arrived while the user waited. Tell the user what happened, in their language, in one or two lines.)";
const fakeResponse = () => ({ headersSent: false, writableEnded: false, destroyed: false, setHeader() {}, writeHead() {}, flushHeaders() {}, write: () => true, once() {}, end() { this.writableEnded = true; } });
const ownerRequest = owner => ({ headers: { cookie: `studio_owner=${encodeURIComponent(owner)}` } });

export function createStudioTaskRoutes({ enabled, handleStudioTurn, studioSessions, studioOwnerTokens, studioEvents, emitStudioEvent, writeStudioStream, newRecord, readContext, inspect, parseCookies, json, readBody, validateEnvelope, limits, eventTurnDelayMs = 400 }) {
	const mains = new Map();
	const ownerOf = sessionId => studioSessions.get(sessionId)?.owner;

	function mainOf(sessionId) {
		let main = mains.get(sessionId);
		if (main) return main;
		const feedId = `main:${sessionId}`;
		main = { sessionId, feedId, feed: newRecord(), events: [], host: null, model: undefined, effort: undefined, eventTimer: null };
		studioEvents.set(feedId, main.feed);
		main.notify = event => {
			main.events.push(event);
			emitStudioEvent(feedId, event);
			// Lost on the old handle after the panel already reconnected on a new one: resume there now, not at the next message.
			if (event.type === "task.paused" && main.host && main.board.get(event.taskId)?.host !== main.host) queueMicrotask(() => main.board.reconnect(main.host.sceneId));
			if (TERMINAL.has(event.type)) eventTurnSoon(main);
		};
		main.board = createTaskBoard({ limits, run: (task, options) => runTask(main, task, options), emit: main.notify });
		mains.set(sessionId, main);
		return main;
	}

	// The main agent reports on its own when a task ends and nobody is talking to it. The user does not see this turn
	// start (the panel reads Ready), so a message they send meanwhile preempts it (preemptEventTurn) instead of answering busy.
	function eventTurnSoon(main) {
		if (main.eventTimer) return;
		main.eventTimer = setTimeout(async () => {
			main.eventTimer = null;
			const session = studioSessions.get(main.sessionId);
			if (!session?.owner || !main.host || !main.events.length || main.eventTurn) return;
			if (session.activeTurnId) return eventTurnSoon(main);
			const turn = main.eventTurn = { turnId: randomUUID(), told: [], preempted: false, done: null };
			let context;
			try { context = await readContext(main.host); } catch { main.eventTurn = null; return; }
			// a user turn began while the context was read: it carries the events, or a later event turn does
			if (turn.preempted || session.activeTurnId) { main.eventTurn = null; if (!turn.preempted) eventTurnSoon(main); return; }
			emitStudioEvent(main.feedId, { type: "main.turn", turnId: turn.turnId });
			turn.done = runMain(main, ownerRequest(session.owner), fakeResponse(), { surface: "studio", sessionId: main.sessionId, turnId: turn.turnId, text: EVENT_TURN_TEXT, context, model: main.model, effort: main.effort }, turn).catch(() => {});
			await turn.done;
			if (main.eventTurn === turn) main.eventTurn = null;
		}, eventTurnDelayMs);
	}

	// A user message while only the hidden event turn runs: that turn stops and the events it was telling go back, so the
	// user's turn reads them in its <task-events>. A second user turn still answers busy (agent-runner.mjs).
	async function preemptEventTurn(main) {
		const turn = main.eventTurn;
		if (!turn) return;
		turn.preempted = true;
		const session = studioSessions.get(main.sessionId);
		if (session?.activeTurnId === turn.turnId) { session.controller?.abort(); await session.modelSession?.abort?.("user message"); }
		if (turn.done) await Promise.race([turn.done, new Promise(resolve => setTimeout(resolve, PREEMPT_WAIT_MS))]);
		if (main.eventTurn === turn) main.eventTurn = null;
		main.events.unshift(...turn.told.splice(0));
	}

	function runMain(main, req, res, value, eventTurn = null) {
		main.host = value.context.host; main.model = value.model; main.effort = value.effort;
		main.board.reconnect(value.context.host.sceneId);
		const userText = value.text, guard = watchMain(main, value.turnId);
		// hidden: the main agent reporting on its own is no user message (a panel that reattaches to it shows no prompt)
		return handleStudioTurn(req, res, { ...value, ...(userText === EVENT_TURN_TEXT ? { hidden: true } : {}), main: {
			systemPrompt: MAIN_SYSTEM_PROMPT,
			// The live host, not this turn's: a reload mid-turn moves the Studio to a new handle (POST .../reconnect).
			tools: ({ studio, hub, admission }) => createMainTools({ board: main.board, studio, hub, admission, workspaceHandle: value.context.host.workspaceHandle, liveHandle: () => main.host?.workspaceHandle }),
			contextText: () => { const told = main.events.splice(0); if (eventTurn) eventTurn.told = told; return mainContextText(main.board, told); },
			check: reply => (guard.tell() ? "" : doneClaimCorrection(reply, main.board.board(), userText)),
		}, observe: guard.observe }, "/agent/turn").finally(guard.stop);
	}

	// The main turn's no-progress guard (#1058): a frame, or any event of a model still streaming (snapshot().eventAt), is
	// progress. None for idleMs: the turn ends with the reason the user sees (a call that never finished, or a model that
	// never answered), the run is stopped quietly so that reason is the turn's only error, and the panel's input comes back.
	// The reason is told right before the turn's done frame (tell, from check), since an error closes a replay: a panel that
	// reattached between the two would miss done. A run that does not wind down within PREEMPT_WAIT_MS is told anyway.
	function watchMain(main, turnId) {
		const idleMs = limits?.mainIdleMs ?? MAIN_TURN_LIMITS.idleMs, open = new Map(), span = idleMs % 60_000 ? `${Math.round(idleMs / 1000)} s` : `${idleMs / 60_000} min`;
		let lastAt = Date.now(), timer = null, ended = false, reason = null;
		const tell = () => { const told = reason; if (told) emitStudioEvent(turnId, { type: "error", code: "stalled", message: told }); reason = null; return Boolean(told); };
		const check = async () => {
			const session = studioSessions.get(main.sessionId), active = session?.activeTurnId === turnId;
			const eventAt = active ? (await session.modelSession?.snapshot?.())?.eventAt ?? 0 : 0;
			if (ended) return;
			if (!active) lastAt = Date.now(); // not admitted yet: the wait starts when the turn does
			const left = Math.max(lastAt, eventAt) + idleMs - Date.now();
			if (left > 0) { timer = setTimeout(check, left); return; }
			const call = [...open.values()].at(-1);
			reason = call ? `Stopped: the ${call} call did not finish (no progress for ${span}).` : `Stopped: the model did not respond for ${span}.`;
			timer = setTimeout(tell, PREEMPT_WAIT_MS);
			await session.modelSession?.abort?.("no progress", { quiet: true });
			session.controller?.abort();
		};
		timer = setTimeout(check, idleMs);
		return {
			observe: frame => { lastAt = Date.now(); if (frame.type === "tool.start") open.set(frame.callId, frame.label ?? frame.name); else if (frame.type === "tool.done") open.delete(frame.callId); },
			tell, stop: () => { ended = true; clearTimeout(timer); },
		};
	}

	async function runTask(main, task, { resume, deps, signal }) {
		const owner = ownerOf(main.sessionId);
		let context;
		try { context = await readContext(main.host); }
		catch (error) { if (LOST_STUDIO.has(error?.code)) return { status: "lost", sceneId: main.host?.sceneId }; throw error; }
		// A resume after Studio came back (case 14): the scope must still read as the task last saw it. Autosave may have
		// missed its newest edit before the reload, or the user changed it meanwhile: then the task re-reads its scope, and
		// one that was mid-command fails, since it cannot know whether that command landed.
		if (resume) {
			const now = await scopeFingerprint(context, task.scope), changed = task.scope.filter(key => !task.seen?.has(key) || now.get(key) === null || now.get(key) !== task.seen.get(key));
			if (changed.length) {
				main.notify({ type: "task.sceneChanged", at: Date.now(), taskId: task.taskId, title: task.title, keys: changed, midCommand: Boolean(task.midCommand) });
				if (task.midCommand) return { status: "failed", error: { message: `the scene changed while the Studio reloaded (${changed.join(", ")}) and the task was mid-command: re-read the scope before trying again` } };
				resume = { ...resume, note: `The scene changed while the Studio reloaded: ${changed.join(", ")} no longer read${changed.length === 1 ? "s" : ""} as you left ${changed.length === 1 ? "it" : "them"}. Re-read your scope with inspect_studio before you continue; do not assume your last edits landed.` };
			} else resume = { ...resume, note: "Studio reconnected after a disconnect; your scope reads as you left it. Continue the task from where you were." };
		}
		task.host = main.host;
		task.seen = await scopeFingerprint(context, task.scope);
		task.midCommand = false;
		const sessionId = task.sessionId ??= randomUUID();
		if (!studioSessions.has(sessionId)) {
			studioOwnerTokens.set(sessionId, owner);
			studioSessions.set(sessionId, { owner, history: [], persistedItems: 0, meta: null, turns: new Map(), controller: null, host: null, updatedAt: Date.now() });
		}
		const turnId = task.turnId = randomUUID();
		const out = { receipts: [], reply: "", segment: "", error: null, usage: null, lost: false, busy: false };
		const session = () => studioSessions.get(sessionId);
		const stop = () => { session()?.controller?.abort(); void session()?.modelSession?.abort?.("task stop"); };
		signal.addEventListener("abort", stop, { once: true });
		task.steer = text => session()?.modelSession?.steer(text, []);
		let pending = 0, seenRead = Promise.resolve();
		// The Studio reloaded on the same handle: its document epoch is new (POST .../reconnect), so this run's commands
		// answer STALE_SCENE. That is a lost Studio too: pause, and resume on the new epoch.
		const reloaded = frame => String(frame.error ?? "").startsWith("STALE_SCENE") && main.host && main.host.documentEpoch !== context.host.documentEpoch;
		const observe = frame => {
			task.onFrame?.(frame);
			if (frame.type === "tool.start") pending++;
			if (frame.type === "tool.done") pending = Math.max(0, pending - 1);
			// What the task last wrote: read again after each of its authored edits, while Studio is there to answer.
			if (frame.type === "tool.done" && frame.ok && frame.result?.authored) seenRead = seenRead.then(() => readContext(main.host)).then(c => scopeFingerprint(c, task.scope)).then(seen => { task.seen = seen; }, () => {});
			if (frame.type === "text.delta") { out.segment += frame.text ?? ""; out.reply = out.segment; }
			else if (frame.type === "tool.start") out.segment = frame.review ? `${out.segment}\n` : "";
			else if (frame.type === "tool.done" && frame.ok && frame.result?.receiptId) out.receipts.push({ receiptId: frame.result.receiptId, action: frame.result.action ?? frame.name, affectedIds: (frame.result.affectedIds ?? []).slice(0, 6) });
			else if (frame.type === "tool.done" && !frame.ok && (LOST_STUDIO.has(String(frame.error ?? "").split(":")[0]) || reloaded(frame))) { out.lost = true; if (String(frame.error).startsWith("UNCERTAIN_APPLY")) task.midCommand = true; stop(); }
			else if (frame.type === "error") { out.error = { code: frame.code, message: frame.message }; if (frame.code === "SCOPE_BUSY") out.busy = true; if (LOST_STUDIO.has(frame.code)) out.lost = true; }
			else if (frame.type === "done" && frame.usage) out.usage = { ...frame.usage, cost: frame.cost ?? 0 };
			// How the bus closed the task: a stop that came after the run already finished keeps its edits (task.finish).
			else if (frame.type === "receipt" && /^task\.(cancel|finish)$/.test(frame.receipt?.action ?? "")) out.ended = frame.receipt.action;
		};
		try {
			await handleStudioTurn(ownerRequest(owner), fakeResponse(), { surface: "studio", sessionId, turnId, text: taskHeader(task, { deps, resume }), context: withTaskActions(context), model: main.model, effort: main.effort, observe,
				task: { taskId: task.taskId, scope: task.scope, reads: task.reads, title: task.title, parentId: main.sessionId, get lost() { return out.lost; }, get keep() { return Boolean(task.stopReason) && !task.cancelled; }, live: () => main.board.running().map(t => t.taskId).slice(0, 64) } }, "/agent/turn");
		} catch (error) {
			if (LOST_STUDIO.has(error?.code)) return { status: "lost", sceneId: context.host.sceneId };
			return { status: "failed", error, usage: out.usage };
		} finally { signal.removeEventListener("abort", stop); task.steer = null; }
		// the task opened another scene of this workspace (scene.create): its coordinator follows, or its next report could not read
		// the Studio (read_studio_context answers STALE_SCENE for the old scene) and the board stayed on Working / Being checked
		const adopted = studioSessions.get(sessionId)?.host;
		if (adopted && main.host && adopted.workspaceId === main.host.workspaceId && adopted.sceneId !== main.host.sceneId) main.host = { ...main.host, ...adopted };
		await seenRead;
		if (out.lost && pending > 0) task.midCommand = true;
		const common = { reply: out.reply, receipts: out.receipts, usage: out.usage, ...(out.ended ? { ended: out.ended } : {}) };
		if (out.lost) return { status: "lost", sceneId: context.host.sceneId, ...common };
		if (out.busy) return { status: "scopeBusy", error: out.error, ...common };
		if (signal.aborted && out.ended !== "task.finish") return { status: "cancelled", ...common };
		return out.error ? { status: "failed", error: out.error, ...common } : { status: "done", ...common };
	}

	// What each scope key reads as now: an entity's row without its session-local token, a shot's range and keys, the
	// timeline's frame count and shot ranges; null where nothing can be read (stage: not in a read), which counts as changed.
	async function scopeFingerprint(context, scope) {
		const ids = scope.filter(key => /^(object|character):/.test(key)).map(key => key.slice(key.indexOf(":") + 1)), rows = new Map();
		if (ids.length && inspect) {
			try { for (const row of (await inspect(context.host, { scope: "entities", ids, limit: Math.min(64, ids.length) }))?.entities ?? []) rows.set(row.id, row); } catch { /* unread rows count as changed */ }
		}
		const strip = row => row && JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !["token", "incarnation"].includes(key))));
		return new Map(scope.map(key => {
			const [kind, id] = key.split(/:(.*)/s);
			if (kind === "object" || kind === "character") return [key, strip(rows.get(id)) ?? null];
			if (kind === "shot") return [key, strip(context.shots?.find(shot => shot.id === id)) ?? null];
			if (kind === "timeline") return [key, JSON.stringify([context.scene?.frameCount, (context.shots ?? []).map(shot => shot.range)])];
			return [key, null];
		}));
	}

	const owned = (req, sessionId) => sessionId && ownerOf(sessionId) && parseCookies(req).studio_owner === ownerOf(sessionId);
	const taskOwner = taskId => [...mains.values()].find(main => main.board.get(taskId));

	return async function route(req, res, path) {
		// Off unless the flag is on, or the panel's Tasks switch opted this session in: a main turn sent with the header
		// x-cozyclay-tasks: on, after which that session's board and its tasks answer too.
		const optedIn = path === "/agent/main" ? req.headers?.["x-cozyclay-tasks"] === "on" : [...mains.keys()].some(id => path.startsWith(`/agent/main/${encodeURIComponent(id)}/`)) || /^\/agent\/task\//.test(path) && mains.size > 0;
		if (!enabled() && !optedIn) { json(res, 404, { error: "not found" }); return true; }
		if (path === "/agent/main" && req.method === "POST") {
			let value;
			try { value = await validateEnvelope(await readBody(req)); } catch (error) { json(res, 400, { error: error?.toJSON?.() ?? "invalid request" }); return true; }
			const session = studioSessions.get(value.sessionId);
			if (session && parseCookies(req).studio_owner !== session.owner) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Studio session owner mismatch." } }); return true; }
			const main = mainOf(value.sessionId);
			await preemptEventTurn(main);
			await runMain(main, req, res, value);
			return true;
		}
		const board = /^\/agent\/main\/([^/]+)\/(board|events)$/.exec(path);
		if (board && req.method === "GET") {
			const sessionId = decodeURIComponent(board[1]), main = mains.get(sessionId);
			if (!main || !owned(req, sessionId)) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Not owned by this session." } }); return true; }
			if (board[2] === "board") json(res, 200, { tasks: main.board.board() });
			else writeStudioStream(res, main.feed, Number(new URL(req.url, "http://127.0.0.1").searchParams.get("after") || 0));
			return true;
		}
		// The panel after a reload: its Studio has a new handle (and document epoch). The board reads and runs there from
		// now on, and the tasks the reload paused resume at once instead of at the user's next message.
		const reconnect = /^\/agent\/main\/([^/]+)\/reconnect$/.exec(path);
		if (reconnect && req.method === "POST") {
			const sessionId = decodeURIComponent(reconnect[1]), main = mains.get(sessionId);
			if (!main || !owned(req, sessionId)) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Not owned by this session." } }); return true; }
			let value;
			try { value = await validateEnvelope({ ...(await readBody(req)), surface: "studio", sessionId, turnId: randomUUID(), text: "reconnect" }); } catch (error) { json(res, 400, { error: error?.toJSON?.() ?? "invalid request" }); return true; }
			try { await readContext(value.context.host); } catch (error) { json(res, 409, { error: { code: error?.code ?? "LIVE_HUB_UNAVAILABLE", message: "The Studio does not answer on that handle." } }); return true; }
			main.host = value.context.host;
			main.board.reconnect(main.host.sceneId);
			json(res, 200, { ok: true, tasks: main.board.board() }); return true;
		}
		const action = /^\/agent\/task\/([^/]+)\/(cancel|steer)$/.exec(path);
		if (action && req.method === "POST") {
			const taskId = decodeURIComponent(action[1]), main = taskOwner(taskId);
			if (!main || !owned(req, main.sessionId)) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Not owned by this session." } }); return true; }
			if (action[2] === "cancel") { const view = main.board.cancel(taskId); json(res, view ? 200 : 409, view ?? { error: { code: "STALE_TARGET", message: "The task already ended." } }); return true; }
			const body = await readBody(req).catch(() => null);
			const task = main.board.get(taskId);
			if (typeof body?.text !== "string" || !body.text.trim()) { json(res, 400, { error: "invalid request" }); return true; }
			if (!task.steer) { json(res, 409, { error: { code: "NO_ACTIVE_TURN", message: `The task is ${task.status}.` } }); return true; }
			await task.steer(body.text);
			json(res, 200, { ok: true, queued: true }); return true;
		}
		json(res, 404, { error: "not found" }); return true;
	};
}
