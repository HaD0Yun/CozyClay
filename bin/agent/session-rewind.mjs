// The edit on the user's last message in the Studio's Agent box: the corrected message takes the old one's place.
// Each admitted Studio turn leaves one line in its conversation's session file (session-store.mjs) before its messages:
// { kind: "turn", turnId, revision, model }. Rewinding the last turn cuts the file back to that line, so its message,
// everything the turn added to the transcript (replies, tool calls and results, steers, its failure record) leave both
// the history the model is given (the next turn opens a new pi runner over the file) and the panel's restored
// transcript. The scene is not rolled back: the next turn's message says so, and how the scene revision moved since the
// old message was sent (editNote). session-store.read ignores the turn lines, as it ignores any kind but "message".
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2HeaderLine } from "./session-store.mjs";

// The v4 single-session engine (v4/studio-turn.mjs)'s model keys (v4/models.mjs V4_MODEL_KEY), not loaded here: it reads src/.
const keepsOwnHistory = model => String(model ?? "").startsWith("v4/");

const fileOf = (store, sessionId) => (typeof store?.dir === "string" && /^[A-Za-z0-9_-]+$/.test(String(sessionId)) ? join(store.dir, `${sessionId}.jsonl`) : null);

function linesOf(file) {
	try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

const parse = line => { try { return JSON.parse(line); } catch { return null; } };

/** The last turn line of the file and where it is: { at, turn, entries } (at -1 when there is none), or null with no file. */
function lastTurn(file) {
	const lines = linesOf(file);
	if (!lines) return null;
	const entries = lines.map(parse);
	return { lines, entries, at: entries.findLastIndex(entry => entry?.kind === "turn") };
}

/** Records an admitted turn before any of its messages. A store without files (a test's) records nothing. */
export function markTurn(store, sessionId, { turnId, revision = null, model = null }) {
	const file = fileOf(store, sessionId);
	if (!file) return;
	const header = linesOf(file) ? "" : `${v2HeaderLine(sessionId)}\n`;
	appendFileSync(file, `${header}${JSON.stringify({ kind: "turn", turnId, revision, model, at: new Date().toISOString() })}\n`, { mode: 0o600 });
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
 * Cuts the file back to before turn `turnId`, which must be its last turn. -> { ok: true, removed, revision } (removed:
 * messages taken out; a turn the file never recorded, one refused before it was admitted, removes nothing: recorded false), or
 * { ok: false, code } with NOT_LAST (a later turn exists) or ENGINE_KEEPS_HISTORY (the v4 single-session engine (v4/studio-turn.mjs) keeps the
 * conversation in its own session, which this cannot cut).
 */
export function rewindTurn(store, sessionId, turnId) {
	const file = fileOf(store, sessionId);
	if (!file) return { ok: false, code: "UNSUPPORTED" };
	const found = lastTurn(file);
	if (!found || !found.entries.some(entry => entry?.kind === "turn" && entry.turnId === turnId)) return { ok: true, removed: 0, revision: null, recorded: false };
	const turn = found.entries[found.at];
	if (turn.turnId !== turnId) return { ok: false, code: "NOT_LAST" };
	if (keepsOwnHistory(turn.model)) return { ok: false, code: "ENGINE_KEEPS_HISTORY" };
	const kept = found.lines.slice(0, found.at), removed = found.entries.slice(found.at).filter(entry => entry?.kind === "message").length;
	writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
	// The conversation's title is its first message: with none left, the next message names it.
	if (!found.entries.slice(0, found.at).some(entry => entry?.kind === "message" && entry.message?.role === "user")) {
		const metaFile = file.replace(/\.jsonl$/, ".meta.json");
		try { const meta = JSON.parse(readFileSync(metaFile, "utf8")); writeFileSync(metaFile, `${JSON.stringify({ ...meta, firstText: null }, null, "\t")}\n`, { mode: 0o600 }); } catch { /* no meta yet */ }
	}
	return { ok: true, removed, revision: turn.revision ?? null };
}

/** What the corrected message tells the model: it replaces the removed one, and what became of the scene. */
export function editNote(edit, revision) {
	const scene = !Number.isInteger(edit?.revision) || !Number.isInteger(revision)
		? "The scene was not rolled back: whatever the removed turn changed in it is still there."
		: edit.revision === revision
			? `The scene is at revision ${revision}, the same as when that message was sent: nothing in it changed since.`
			: `The scene was not rolled back: it was at revision ${edit.revision} when that message was sent and is at revision ${revision} now, so it keeps every change made since (by the removed turn or in the editor).`;
	return `<edited-message>The user edited their last message after sending it, and this message replaces it. The earlier version and everything this conversation held after it were removed, so answer this message only. ${scene}</edited-message>`;
}

const WAIT_STEP_MS = 50, WAIT_STEPS = 400; // a stopped turn winds down (its run's finally) within 20 s

/**
 * POST /agent/sessions/<id>/rewind { turnId }: stops that turn if it still runs, waits for it to end, drops the
 * conversation's pi runner (its Agent holds the messages in memory) and cuts the file. The next turn of this conversation
 * carries editNote (takeEditNote). deps: the route's studioSessions, studioRunners, studioEvents, sessionStore, edits
 * (sessionId -> { revision }), parseCookies, json, readBody.
 */
export async function handleRewind(req, res, sessionId, { studioSessions, studioRunners, studioEvents, sessionStore, edits, parseCookies, json, readBody }) {
	let value;
	try { value = await readBody(req); if (typeof value?.turnId !== "string" || !value.turnId || value.turnId.length > 100) throw new Error("turnId"); }
	catch { json(res, 400, { error: { code: "INVALID_REQUEST", message: "Expected { turnId }." } }); return true; }
	const live = studioSessions.get(sessionId), refuse = (status, code, message) => json(res, status, { error: { code, message } });
	if (live && parseCookies(req).studio_owner !== live.owner) { refuse(403, "AUTH_REQUIRED", "This conversation is not owned by this browser."); return true; }
	if (studioEvents.has(`main:${sessionId}`)) { refuse(409, "TASK_MODE", "A task-mode conversation cannot be rewound."); return true; }
	for (let step = 0; live?.activeTurnId; step += 1) {
		if (live.activeTurnId !== value.turnId) { refuse(409, "NOT_LAST", "Another turn runs in this conversation."); return true; }
		if (step === 0) { live.controller?.abort(); await live.modelSession?.abort?.("edited message"); }
		if (step === WAIT_STEPS) { refuse(409, "BUSY", "The stopped turn has not ended yet."); return true; }
		await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
	}
	const result = rewindTurn(sessionStore, sessionId, value.turnId);
	if (!result.ok) { refuse(409, result.code, result.code === "NOT_LAST" ? "Only the last message can be edited." : "This conversation's history cannot be cut."); return true; }
	await studioRunners.get(sessionId)?.close?.(); studioRunners.delete(sessionId);
	if (live) { live.modelSession = null; live.planSceneId = null; }
	if (result.recorded !== false) edits.set(sessionId, { revision: result.revision }); // a turn never admitted reached no model: nothing to tell
	json(res, 200, { ok: true, removed: result.removed, revision: result.revision }); return true;
}

/** The note for this turn when its conversation's last message was just edited (once), else undefined. */
export function takeEditNote(edits, sessionId, revision) {
	const edit = edits.get(sessionId);
	if (!edit) return undefined;
	edits.delete(sessionId);
	return editNote(edit, revision);
}
