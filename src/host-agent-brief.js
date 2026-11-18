// A brief for the Studio's own agent, handed over by a host app (#1319). A host
// that shows the Studio in its own window (the desktop app) may expose
// `window.cozyclayHost.agentBrief` from its preload. When it does, the host can
// send the agent one message with pictures, and the Studio reports how that
// turn ended; in a plain browser the object is absent and nothing changes.
// The launcher advertises this as the "agent-brief" capability
// (bin/host-contract.mjs).
//
// The bridge:
//   onRequest(listener) -> unsubscribe   host -> page; a request made before a listener exists waits for one
//   report(status)      -> void          page -> host
//
// Requests (unknown fields are ignored):
//   { kind: "brief", id, text, attachments?, project?, save?, chat? }
//   { kind: "stop", id }
//   id           the host's name for the brief, 1 to 128 of [A-Za-z0-9._-]; one brief, one id
//   text         the message for the agent, 1 to 16000 characters
//   attachments  1 to 4 of { name, dataUrl }: a png, jpeg or webp data URL of at most 6,000,000 characters
//   project      a token from projectFiles.onOpen (src/host-project-files.js): the brief runs only in that
//                project, and waits up to 60 s for it while it is still opening
//   save         true: after this brief's turn ended "done" the project is saved to its host file, with no
//                dialog. A host may ask it on every brief
//   chat         "new" (the default) or "continue": the brief is the next message in the chat this host's
//                previous brief ran in, when the panel still shows that chat or can open it again from its
//                history; otherwise it runs as "new"
//   stop         stops that brief's turn; an id that is not running is ignored
// The text and the attachments have the limits of a message typed in the
// panel (src/studio-agent-protocol.js).
//
// The brief runs as a user message in the agent panel, as one plain turn
// (never as parallel tasks), so the end of the turn is the end of the work. A
// host hands over a long job as several briefs, the first in a new chat and
// the others continuing it, each sent after the final report of the one before.
//
// Reports, each { id, state, ... }. A brief gets "started" at most once, and
// exactly one of the other three:
//   started   the agent took the message and its turn is running
//   done      { reply?, saved?, preview? }: the turn ran to its end, also when a tool call failed on the way.
//             reply is the agent's text of that turn, cut to 4000 characters: the longest block when it wrote
//             several; saved is there when save was asked; preview is a small picture of the stage as a data
//             URL (at most 1,500,000 characters) when the page has one
//   failed    { code, message }. code: "invalid" (the request broke the limits above), "busy" (an answer or
//             another brief is already running), "not-ready" (no model is connected, or the editor is not
//             ready), "project" (that project is not the one open), "turn" (the turn itself ended in an
//             error, for example the model provider refused; message is the panel's own words)
//   stopped   the host or the user stopped the turn
// A page that reloads mid-turn reports nothing more: the host treats a page
// that went away as failed.
import { hostProjectOpening } from "./host-project-files.js";
import { stageThumbDataUrl } from "./project-thumbs.js";

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const PICTURE = /^data:image\/(png|jpeg|webp);base64,/;
const TEXT_MAX = 16_000;
const ATTACHMENTS_MAX = 4;
const ATTACHMENT_MAX_CHARS = 6_000_000;
const ATTACHMENT_NAME_MAX = 120;
const REPLY_MAX = 4000;
const PREVIEW_MAX_CHARS = 1_500_000;
const WAIT_MS = 60_000;
const POLL_MS = 250;

function bridge() {
	const host = globalThis.window?.cozyclayHost?.agentBrief;
	return typeof host?.onRequest === "function" && typeof host.report === "function" ? host : null;
}

/** A host request, checked once here: { request } holding only the fields above, or { message } saying why it is
 * refused, with the `id` when it is a brief the page can still answer. An optional field may also be null. */
export function parseHostBriefRequest(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { message: "A host brief request must be an object." };
	const id = typeof value.id === "string" && ID.test(value.id) ? value.id : null;
	const refuse = (message) => ({ message, ...(id && value.kind === "brief" ? { id } : {}) });
	if (!id) return refuse("A host brief id is 1 to 128 characters of A-Z, a-z, 0-9, dot, underscore or hyphen.");
	if (value.kind === "stop") return { request: { kind: "stop", id } };
	if (value.kind !== "brief") return refuse("A host brief request is a brief or a stop.");
	if (typeof value.text !== "string" || !value.text.trim() || value.text.length > TEXT_MAX) return refuse(`The brief text must be 1 to ${TEXT_MAX} characters.`);
	const attachments = [];
	if (value.attachments != null) {
		if (!Array.isArray(value.attachments) || !value.attachments.length || value.attachments.length > ATTACHMENTS_MAX) return refuse(`A brief carries 1 to ${ATTACHMENTS_MAX} attachments.`);
		for (const entry of value.attachments) {
			if (typeof entry?.dataUrl !== "string" || entry.dataUrl.length > ATTACHMENT_MAX_CHARS || !PICTURE.test(entry.dataUrl)) return refuse(`Each attachment must be a png, jpeg or webp data URL of at most ${ATTACHMENT_MAX_CHARS} characters.`);
			if (entry.name != null && typeof entry.name !== "string") return refuse("An attachment name must be text.");
			attachments.push({ dataUrl: entry.dataUrl, ...(entry.name ? { name: entry.name.slice(0, ATTACHMENT_NAME_MAX) } : {}) });
		}
	}
	if (value.project != null && (typeof value.project !== "string" || !value.project)) return refuse("The brief's project must be a host project token.");
	if (value.save != null && typeof value.save !== "boolean") return refuse("The brief's save must be true or false.");
	if (value.chat != null && value.chat !== "new" && value.chat !== "continue") return refuse('The brief\'s chat must be "new" or "continue".');
	return { request: { kind: "brief", id, text: value.text, attachments, project: value.project ?? null, save: value.save === true, chat: value.chat ?? "new" } };
}

export function reportHostBrief(status) {
	try {
		bridge()?.report(status);
	} catch (error) {
		console.warn(`cozyclay: the host app did not take a brief report: ${error.message}`);
	}
}

// The host's requests, each checked first: a brief that breaks the limits is
// answered here, anything else that cannot be read is dropped. Returns the
// unsubscribe function.
export function subscribeHostBriefs(handler) {
	const host = bridge();
	if (!host) return () => {};
	const unsubscribe = host.onRequest((value) => {
		const { request, id, message } = parseHostBriefRequest(value);
		try {
			if (request) handler(request);
			else if (id) reportHostBrief({ id, state: "failed", code: "invalid", message });
			else console.warn(`cozyclay: ${message}`);
		} catch (error) {
			console.warn(`cozyclay: ${error.message}`);
		}
	});
	return typeof unsubscribe === "function" ? unsubscribe : () => {};
}

/** Whether the agent panel can take a brief: true, null while it is still finding out (the model list loading, a
 * chat being restored, the editor connecting), or the reason it cannot. */
export function hostBriefReadiness({ authState, modelsState, model, restoreReady = true, editorReady = true }) {
	if (authState === "loading" || modelsState === "loading" || !restoreReady) return null;
	if (authState !== "ready" || !model) return "No model is connected in the Studio's agent panel.";
	return editorReady ? true : null;
}

// The agent's text in the turn that just ended: its longest block, because the
// last one is often a short note about a late fix. Of two equally long blocks
// the later one is used.
function turnReply(items) {
	let reply = "";
	for (let index = items.length - 1; index >= 0 && items[index].kind !== "user"; index -= 1) {
		const text = items[index].kind === "assistant" ? String(items[index].text ?? "").trim() : "";
		if (text.length > reply.length) reply = text;
	}
	return reply.slice(0, REPLY_MAX) || null;
}

// The store's state once no answer is streaming.
function turnEnd(store) {
	return new Promise((resolve) => {
		let unsubscribe = () => {};
		const check = (state) => { if (!state.streaming) { unsubscribe(); resolve(state); } };
		unsubscribe = store.subscribe(check);
		check(store.getState());
	});
}

// Only the host's own file is written without asking: any other project would
// open a dialog.
async function saveHostFile(request, file) {
	try {
		const token = file?.token() ?? null;
		return Boolean(token) && (!request.project || token === request.project) && (await file.save()) === true;
	} catch {
		return false;
	}
}

// Puts a chat the panel has left back in it, from the Studio's own history. A
// chat that is gone or cannot be read stays away, and so does one that would
// replace an answer that started meanwhile: the brief then starts a new chat,
// or is refused as busy.
async function reopenChat(store, load, sessionId) {
	try {
		const transcript = (await load(sessionId))?.transcript;
		if (Array.isArray(transcript) && !store.getState().streaming) store.restore(transcript, sessionId);
	} catch { /* that chat is gone */ }
}

// The brief this page is handling, every brief id it has taken, and the chat
// (the store's session id) the last brief ran its turn in, which a "continue"
// brief goes on in. They belong to the page, not to one subscription: a panel
// that subscribes again still knows the brief that is running. A page that
// reloads forgets them all.
let active = null;
const taken = new Set();
let lastChat = null;

async function runBrief(request, { store, panel, preview, waitMs, pollMs }) {
	const brief = { id: request.id, stopped: false, stop() { brief.stopped = true; } };
	active = brief;
	let started = false;
	// The one final report: whatever comes after it for this brief is dropped.
	const finish = (status) => {
		if (active !== brief) return;
		active = null;
		reportHostBrief({ id: brief.id, ...status });
	};
	const fail = (code, message) => finish({ state: "failed", code, message });
	try {
		panel().open();
		// Wait for the panel and for the named project. A host sends the brief as
		// soon as the page loads, while the model list, the editor and the project
		// it just asked for are all still on their way.
		const deadline = Date.now() + waitMs;
		// The chat to go on in, when the brief asks for one and an earlier brief left one.
		const chat = request.chat === "continue" ? lastChat : null;
		const continues = () => chat !== null && store.getState().sessionId === chat;
		let reopened = chat === null;
		while (true) {
			if (brief.stopped) return finish({ state: "stopped" });
			if (store.getState().streaming) return fail("busy", "An answer is already running in the Studio's agent panel.");
			const { ready, project, loadChat } = panel();
			if (typeof ready === "string") return fail("not-ready", ready);
			const here = !hostProjectOpening() && (!request.project || project?.token() === request.project);
			if (ready === true && here) {
				if (reopened || continues()) break;
				// The panel has left the chat to continue. Opening it again takes a moment, so every check above runs once more.
				reopened = true;
				await reopenChat(store, loadChat, chat);
				continue;
			}
			if (Date.now() >= deadline) {
				if (here) return fail("not-ready", "The Studio's agent was not ready in time.");
				return fail("project", request.project ? "That project is not the one open in the Studio." : "A project is still opening in the Studio.");
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		const { newChat, turn } = panel();
		if (!continues() && store.getState().items.length) newChat();
		// The store starts the turn before it first waits, so its state already says whether it took the message.
		void store.send(request.text, { ...turn, attachFrame: false, attachments: request.attachments });
		if (!store.getState().streaming) return fail("not-ready", store.getState().items.findLast((item) => item.kind === "failure")?.failure?.message || "The Studio's agent did not take the message.");
		lastChat = store.getState().sessionId ?? null;
		started = true;
		reportHostBrief({ id: brief.id, state: "started" });
		brief.stop = () => store.stop();
		const ended = await turnEnd(store);
		brief.stop = () => {};
		if (ended.lastTurn?.status === "stopped") return finish({ state: "stopped" });
		// A tool call that failed inside the turn leaves the status "done": only a turn that itself ended in an error has failed.
		if (ended.lastTurn?.status !== "done") return fail("turn", ended.lastTurn?.failure?.message || "The turn failed.");
		const reply = turnReply(ended.items);
		const done = { state: "done", ...(reply ? { reply } : {}) };
		if (request.save) done.saved = await saveHostFile(request, panel().project);
		const picture = await Promise.resolve().then(preview).catch(() => null);
		if (typeof picture === "string" && picture.startsWith("data:image/") && picture.length <= PREVIEW_MAX_CHARS) done.preview = picture;
		finish(done);
	} catch (error) {
		fail(started ? "turn" : "not-ready", String(error?.message || error));
	}
}

/** Runs the host's briefs through the agent panel. `store` is the panel's chat store; `panel()` answers with the
 * panel as it is now: { ready (hostBriefReadiness), project ({ token(), save() } of the open project, or
 * nothing), turn (the model options of a send), newChat(), loadChat(sessionId) (a chat of the Studio's history,
 * as { transcript }), open() }. Returns the unsubscribe function. */
export function runHostBriefs({ store, panel, preview = stageThumbDataUrl, waitMs = WAIT_MS, pollMs = POLL_MS }) {
	return subscribeHostBriefs((request) => {
		if (request.kind === "stop") {
			if (active?.id === request.id) active.stop();
			return;
		}
		if (taken.has(request.id)) return;
		taken.add(request.id);
		if (active) reportHostBrief({ id: request.id, state: "failed", code: "busy", message: "Another brief is already running in the Studio." });
		else void runBrief(request, { store, panel, preview, waitMs, pollMs });
	});
}
