// The edit on the user's last message in the Studio's Agent box: the corrected message takes the old one's place.
// Each admitted Studio turn leaves one line in its conversation's session file (session-store.mjs) before its messages:
// { kind: "turn", turnId, revision, epoch, model, main? }. Rewinding the last turn cuts the file back to that line, so its
// message, everything the turn added to the transcript (replies, tool calls and results, steers, its failure record) leave
// both the history the model is given (the next turn opens a new pi runner over the file) and the panel's restored
// transcript. What is left is the file as it was when that turn was admitted, so no tool call is parted from its result.
// The scene is not rolled back: the next turn's message says so, and how the scene revision moved since the old message
// was sent (editNote). session-store.read ignores the turn lines, as it ignores any kind but "message".
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2HeaderLine } from "./session-store.mjs";

// The v4 single-session engine (v4/studio-turn.mjs)'s model keys (v4/models.mjs V4_MODEL_KEY), not loaded here: it reads src/.
const keepsOwnHistory = model => String(model ?? "").startsWith("v4/");

const fileOf = (store, sessionId) => (typeof store?.dir === "string" && /^[A-Za-z0-9_-]+$/.test(String(sessionId)) ? join(store.dir, `${sessionId}.jsonl`) : null);

function linesOf(file) {
	try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

const parse = line => { try { return JSON.parse(line); } catch { return null; } };

// The whole file or the old one: a crash part way through leaves the conversation readable.
function replaceFile(file, text) {
	const next = `${file}.${process.pid}.tmp`;
	writeFileSync(next, text, { mode: 0o600 });
	renameSync(next, file);
}

/** What a scene revision counts within: the editor's document and scene as opened. A reload of the editor, another scene
 * or another document starts a new count, so revisions compare only under one epoch. host: the turn context's host. */
export const sceneEpoch = host => (host?.documentEpoch && host?.sceneEpoch ? [host.documentEpoch, host.sceneId, host.sceneEpoch].join("|") : null);

/** The last turn line of the file and where it is: { at, turn, entries } (at -1 when there is none), or null with no file. */
function lastTurn(file) {
	const lines = linesOf(file);
	if (!lines) return null;
	const entries = lines.map(parse);
	return { lines, entries, at: entries.findLastIndex(entry => entry?.kind === "turn") };
}

/** Records an admitted turn before any of its messages. main: a task-mode turn (the main agent's; its tasks run in sessions
 * of their own, which a cut here would not stop). A store without files (a test's) records nothing. */
export function markTurn(store, sessionId, { turnId, revision = null, epoch = null, model = null, main = false }) {
	const file = fileOf(store, sessionId);
	if (!file) return;
	const header = linesOf(file) ? "" : `${v2HeaderLine(sessionId)}\n`;
	appendFileSync(file, `${header}${JSON.stringify({ kind: "turn", turnId, revision, epoch, model, ...(main ? { main: true } : {}), at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/** The restored transcript with the last turn's message marked by its turnId (the panel's edit needs it). transcriptOf:
 * session-store's transcriptFromHistory. A file with no turn line (written before this) marks nothing. */
export function withLastTurnId(store, sessionId, transcript, transcriptOf) {
	const file = fileOf(store, sessionId), found = file ? lastTurn(file) : null;
	if (!found || found.at === -1) return transcript;
	const history = found.entries.filter(entry => entry?.kind === "message").map(entry => entry.message);
	const before = found.entries.slice(0, found.at).filter(entry => entry?.kind === "message").length;
	if (!history.slice(before).some(message => message?.role === "user")) return transcript;
	const index = transcriptOf(history.slice(0, before)).filter(item => item.kind === "user").length;
	let seen = -1;
	return transcript.map(item => (item.kind === "user" && ++seen === index ? { ...item, turnId: found.entries[found.at].turnId } : item));
}

/**
 * Cuts the file back to before turn `turnId`, which must be its last turn. -> { ok: true, removed, revision, epoch }
 * (removed: messages taken out; a turn the file never recorded, one refused before it was admitted, removes nothing:
 * recorded false), or { ok: false, code } with NOT_LAST (a later turn exists), TASK_MODE (a task-mode turn) or
 * ENGINE_KEEPS_HISTORY (the v4 single-session engine (v4/studio-turn.mjs) keeps the conversation in its own session,
 * which this cannot cut). check: answers the same and writes nothing.
 */
export function rewindTurn(store, sessionId, turnId, { check = false } = {}) {
	const file = fileOf(store, sessionId);
	if (!file) return { ok: false, code: "UNSUPPORTED" };
	const found = lastTurn(file);
	const own = found?.entries.find(entry => entry?.kind === "turn" && entry.turnId === turnId);
	if (!own) return { ok: true, removed: 0, revision: null, recorded: false };
	if (own.main) return { ok: false, code: "TASK_MODE" }; // before NOT_LAST: the main agent's own report may have followed it
	const turn = found.entries[found.at];
	if (turn.turnId !== turnId) return { ok: false, code: "NOT_LAST" };
	if (keepsOwnHistory(turn.model)) return { ok: false, code: "ENGINE_KEEPS_HISTORY" };
	const kept = found.lines.slice(0, found.at), removed = found.entries.slice(found.at).filter(entry => entry?.kind === "message").length;
	const result = { ok: true, removed, revision: turn.revision ?? null, epoch: turn.epoch ?? null };
	if (check) return result;
	replaceFile(file, `${kept.join("\n")}\n`);
	// The conversation's title is its first message: with none left, the next message names it.
	if (!found.entries.slice(0, found.at).some(entry => entry?.kind === "message" && entry.message?.role === "user")) {
		const metaFile = file.replace(/\.jsonl$/, ".meta.json");
		try { const meta = JSON.parse(readFileSync(metaFile, "utf8")); replaceFile(metaFile, `${JSON.stringify({ ...meta, firstText: null }, null, "\t")}\n`); } catch { /* no meta yet */ }
	}
	return result;
}

/**
 * What the corrected message tells the model: it replaces the removed one, and what became of the scene. edit: the removed
 * turn's { revision, epoch } at its start; revision, epoch: the scene's now. Revisions are compared only under one epoch
 * (sceneEpoch): a reloaded editor counts from the start again, so equal numbers there say nothing.
 */
export function editNote(edit, revision, epoch = null) {
	const known = Number.isInteger(edit?.revision) && Number.isInteger(revision);
	const scene = !known
		? "The scene was not rolled back: nothing the removed turn changed in it was undone by this edit."
		: !edit.epoch || edit.epoch !== epoch
			? `The scene was not rolled back. The editor was reloaded or went to another scene or document since that message was sent, so its revision then (${edit.revision}) and now (${revision}) do not compare: the scene may hold changes the removed turn made.`
			: edit.revision === revision
				? `The scene's content is at revision ${revision}, the same as when that message was sent: nothing was changed in it since.`
				: `The scene was not rolled back: its content was at revision ${edit.revision} when that message was sent and is at revision ${revision} now, so it was changed since (by the removed turn, whose tool calls and results you no longer have, or by the user in the editor) and this edit undid none of that.`;
	return `<edited-message>The user edited their last message after sending it, and this message replaces it. The earlier version and everything this conversation held after it (replies, tool calls and their results) were removed, so answer this message only. ${scene}</edited-message>`;
}

const WAIT_STEP_MS = 50, WAIT_STEPS = 400; // a stopped turn winds down (its run's finally) within 20 s

const REFUSAL = {
	NOT_LAST: "Only the last message can be edited.",
	TASK_MODE: "A message sent with Tasks on cannot be edited.",
	ENGINE_KEEPS_HISTORY: "This model keeps the conversation in its own session: the message cannot be replaced.",
};

/**
 * POST /agent/sessions/<id>/rewind { turnId, check? }: refuses first what cannot be cut (nothing is stopped then), then
 * stops that turn if it still runs, waits for it to end, drops the conversation's pi runner (its Agent holds the messages
 * in memory) and cuts the file. check: true answers whether the cut would be taken and touches nothing (the panel asks
 * before it opens the edit and before it stops a running turn). The next turn of the user's in this conversation
 * carries editNote (takeEditNote). deps: the route's studioSessions, studioRunners, sessionStore, edits
 * (sessionId -> { revision, epoch }), parseCookies, json, readBody.
 */
export async function handleRewind(req, res, sessionId, { studioSessions, studioRunners, sessionStore, edits, parseCookies, json, readBody }) {
	let value;
	try { value = await readBody(req); if (typeof value?.turnId !== "string" || !value.turnId || value.turnId.length > 100) throw new Error("turnId"); }
	catch { json(res, 400, { error: { code: "INVALID_REQUEST", message: "Expected { turnId }." } }); return true; }
	const live = studioSessions.get(sessionId), refuse = (status, code, message) => json(res, status, { error: { code, message } });
	const refuseCut = code => refuse(409, code, REFUSAL[code] ?? "This conversation's history cannot be cut.");
	if (live && parseCookies(req).studio_owner !== live.owner) { refuse(403, "AUTH_REQUIRED", "This conversation is not owned by this browser."); return true; }
	const running = live?.activeTurnId && live.activeTurnId !== value.turnId, feasible = running ? { ok: false, code: "NOT_LAST" } : rewindTurn(sessionStore, sessionId, value.turnId, { check: true });
	if (!feasible.ok) { refuseCut(feasible.code); return true; }
	if (value.check === true) { json(res, 200, { ok: true, check: true }); return true; }
	for (let step = 0; live?.activeTurnId; step += 1) {
		if (live.activeTurnId !== value.turnId) { refuseCut("NOT_LAST"); return true; }
		if (step === 0) { live.controller?.abort(); await live.modelSession?.abort?.("edited message"); }
		if (step === WAIT_STEPS) { refuse(409, "BUSY", "The stopped turn has not ended yet."); return true; }
		await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
	}
	const result = rewindTurn(sessionStore, sessionId, value.turnId);
	if (!result.ok) { refuseCut(result.code); return true; }
	await studioRunners.get(sessionId)?.close?.(); studioRunners.delete(sessionId);
	if (live) { live.modelSession = null; live.planSceneId = null; }
	if (result.recorded !== false) edits.set(sessionId, { revision: result.revision, epoch: result.epoch }); // a turn never admitted reached no model: nothing to tell
	json(res, 200, { ok: true, removed: result.removed, revision: result.revision }); return true;
}

/** The note for this turn when its conversation's last message was just edited (once), else undefined. revision, epoch: the scene's now. */
export function takeEditNote(edits, sessionId, revision, epoch = null) {
	const edit = edits.get(sessionId);
	if (!edit) return undefined;
	edits.delete(sessionId);
	return editNote(edit, revision, epoch);
}
