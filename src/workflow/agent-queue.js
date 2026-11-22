// The Agent box's queue: messages typed while a turn runs. Enter or Send during a turn puts the message here, one row
// per message, in order, with what it would have been sent with at that moment (the composer's pictures, the model, the
// effort, the frame switch, task mode: `options`, as AgentPanel's runTurn takes them).
// Where a row goes:
//   - as the next turn, by itself, when the running turn ends done or failed: the first row, then the next one when that
//     turn ends. A rate limit holds the queue (the composer is paused too).
//   - after Stop, nowhere by itself: Stop holds the queue. The user sends a row with Send now, and the rows after it
//     follow on their own again once that turn ends.
//   - Send now while a turn runs: into that turn (store.steer). The row reads "sending" until the turn's stream says the
//     model's context took it (steer.received: the row leaves and the message joins the transcript there) or the turn
//     ended first (steer.dropped: the row is queued again, in its place). Send now while no turn runs starts it as a turn.
// The rows belong to one conversation: they are kept per session id in sessionStorage, so a reload of the page brings
// them back (held: nothing goes before the user says so) and another conversation shows its own rows.
const STORAGE_PREFIX = "cozyclay.agent.queue.";

/** A row's options as they are kept: plain data only (attachments are data URLs). */
const keepable = ({ attachments, ...options } = {}) => ({ ...options, attachments: (Array.isArray(attachments) ? attachments : []).map(({ dataUrl, name }) => ({ dataUrl, ...(name ? { name } : {}) })) });

/**
 * createMessageQueue({ store, send?, storage?, newId? }) -> { getState, subscribe, connect, add, beginEdit, edit, cancelEdit, remove, sendNow, steered }
 * store: the chat store (agent-client.js createAgentChatStore). send(row): starts row.text as a new turn with row.options
 * (the panel's runTurn); connect(send) sets it and answers a function that unsets it. With no send, a row that would go
 * stays, held. steered(event): the store's steer.received / steer.dropped report for a row's id.
 * getState() -> { rows: [{ id, text, options, status: "queued" | "editing" | "sending" }], held }.
 * The store is followed only while someone follows the queue (the mounted panel): a queue nobody shows sends nothing.
 */
export function createMessageQueue({ store, send = null, storage = globalThis.sessionStorage, newId = () => globalThis.crypto.randomUUID() }) {
	const listeners = new Set();
	let state = { rows: [], held: false }, sessionId = null, streaming = false, unsubscribe = null;
	const load = (id) => { try { const rows = JSON.parse(storage?.getItem(STORAGE_PREFIX + id) ?? "[]"); return Array.isArray(rows) ? rows.filter((row) => typeof row?.text === "string").map((row) => ({ ...row, status: "queued" })) : []; } catch { return []; } };
	const save = () => {
		try {
			if (state.rows.length) storage?.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(state.rows.map(({ id, text, options }) => ({ id, text, options }))));
			else storage?.removeItem(STORAGE_PREFIX + sessionId);
		} catch { /* storage full or unavailable: the rows stay in this page */ }
	};
	const tell = () => { for (const listener of [...listeners]) listener(state); };
	const set = (patch) => { state = { ...state, ...patch }; if (!state.rows.length) state.held = false; save(); tell(); };
	const patchRow = (id, patch) => set({ rows: state.rows.map((row) => row.id === id ? { ...row, ...patch } : row) });
	// A row as the next turn. A send the store did not start (no scene context yet) puts it back in front, held.
	const start = (row) => {
		set({ rows: state.rows.filter((entry) => entry.id !== row.id) });
		send?.(row);
		if (!store.getState().streaming) set({ rows: [row, ...state.rows], held: true });
	};
	// The first row goes. A row open for editing waits, and so do the rows behind it: they go in the order they were typed.
	const next = () => {
		const chat = store.getState(), row = state.rows.find((entry) => entry.status !== "sending");
		if (!row || row.status !== "queued" || state.held || chat.streaming) return;
		if (chat.rateLimit) set({ held: true }); else start(row);
	};
	const onStore = (chat) => {
		if (chat.sessionId !== sessionId) { sessionId = chat.sessionId; const rows = load(sessionId); state = { rows, held: rows.length > 0 }; tell(); }
		const ended = streaming && !chat.streaming;
		streaming = chat.streaming;
		if (!ended) return;
		if (chat.lastTurn?.status === "stopped") { if (state.rows.length) set({ held: true }); return; }
		queueMicrotask(next);
	};
	const edit = (id, text) => {
		const trimmed = String(text ?? "").trim();
		if (!state.rows.some((row) => row.id === id && row.status !== "sending")) return;
		patchRow(id, { status: "queued", ...(trimmed ? { text: trimmed } : {}) });
		if (!streaming) queueMicrotask(next);
	};
	onStore(store.getState());
	return {
		getState: () => state,
		connect(fn) { send = fn; return () => { if (send === fn) send = null; }; },
		subscribe(listener) {
			if (!listeners.size) { onStore(store.getState()); unsubscribe = store.subscribe(onStore); }
			listeners.add(listener);
			return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = null; } };
		},
		add(text, options = {}) {
			const trimmed = String(text ?? "").trim();
			if (!trimmed) return null;
			const row = { id: newId(), text: trimmed, options: keepable(options), status: "queued" };
			set({ rows: [...state.rows, row] });
			return row;
		},
		/** Opens a row for editing: it is not sent (nor the rows behind it) until edit() or cancelEdit() closes it. */
		beginEdit(id) { if (state.rows.some((row) => row.id === id && row.status === "queued")) patchRow(id, { status: "editing" }); },
		edit,
		cancelEdit: (id) => edit(id, null),
		remove(id) {
			if (!state.rows.some((row) => row.id === id && row.status !== "sending")) return;
			set({ rows: state.rows.filter((row) => row.id !== id) });
			if (!streaming) queueMicrotask(next);
		},
		/** Into the running turn, or as a new turn when none runs. Answers the store's steer result ({ ok, code, message }). */
		async sendNow(id) {
			const row = state.rows.find((entry) => entry.id === id && entry.status === "queued");
			if (!row) return { ok: false, code: "GONE", message: "" };
			if (!store.getState().streaming) { set({ held: false }); start(row); return { ok: true, code: null, message: "" }; }
			patchRow(id, { status: "sending" });
			const result = await store.steer(row.text, { id: row.id, attachments: row.options.attachments });
			// refused: queued again; when the turn ended meanwhile (its end skipped this row while it was sending), it goes now
			if (!result.ok && state.rows.some((entry) => entry.id === id && entry.status === "sending")) { patchRow(id, { status: "queued" }); if (!streaming) queueMicrotask(next); }
			return result;
		},
		steered(event) {
			if (!state.rows.some((row) => row.id === event?.id)) return;
			if (event.type === "steer.received") set({ rows: state.rows.filter((row) => row.id !== event.id) });
			else { patchRow(event.id, { status: "queued" }); if (!streaming) queueMicrotask(next); }
		},
	};
}
