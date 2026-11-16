import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_PERSISTED_IMAGE_BYTES = 2 * 1024 * 1024;

const V2_FORMAT = "cozyclay-agent-v2";
const V2_VERSION = 2;

function configDir() {
	return process.env.COZYCLAY_CONFIG_DIR
		|| join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
}

function agentSessionsDir() {
	return process.env.COZYCLAY_AGENT_SESSIONS_DIR || join(configDir(), "agent-sessions");
}

function validSessionId(sessionId) {
	if (typeof sessionId !== "string" || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id.");
	return sessionId;
}

function paths(dir, sessionId) {
	const id = validSessionId(sessionId);
	return { history: join(dir, `${id}.jsonl`), meta: join(dir, `${id}.meta.json`) };
}

// A file this store wrote in v1 (or anything foreign dropped into the
// directory) has no header line at all; it is treated as absent rather than
// guessed at. One warning per session id per process is enough to notice
// without flooding the log on every list()/read() pair.
const warnedLegacySessions = new Set();
function warnLegacySession(sessionId) {
	if (warnedLegacySessions.has(sessionId)) return;
	warnedLegacySessions.add(sessionId);
	console.warn(`[agent] skipping legacy session ${sessionId}`);
}

function v2HeaderLine(sessionId) {
	return JSON.stringify({ format: V2_FORMAT, version: V2_VERSION, sessionId });
}

function isV2Header(line) {
	try {
		const parsed = JSON.parse(line);
		return !!parsed && parsed.format === V2_FORMAT && parsed.version === V2_VERSION;
	} catch { return false; }
}

function dataUrlTooLarge(value) {
	return typeof value === "string" && value.startsWith("data:") && Buffer.byteLength(value) > MAX_PERSISTED_IMAGE_BYTES;
}

function rawImageTooLarge(value) {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) > MAX_PERSISTED_IMAGE_BYTES;
}

/** Keep a pi Message as the sole persisted shape, omitting only oversized
 * inline images (from either the legacy input_image part or the pi
 * ImageContent part) while keeping the text around it. */
function persistableMessage(message) {
	if (!message || typeof message !== "object") return message;
	if (!Array.isArray(message.content)) return message;
	const content = message.content.flatMap((part) => {
		if (part?.type === "input_image") {
			const image = part.image_url ?? part.imageUrl ?? part.dataUrl;
			return dataUrlTooLarge(image) ? [] : [part];
		}
		if (part?.type === "image") {
			return rawImageTooLarge(part.data) ? [] : [part];
		}
		return [part];
	});
	return content.length === message.content.length ? message : { ...message, content };
}

function cleanUserText(text) {
	const value = String(text || "");
	const marker = "</studio-context>";
	const end = value.indexOf(marker);
	return end === -1 ? value : value.slice(end + marker.length).trim();
}

/** The plain text of a message's content, across both the legacy
 * (input_text/output_text) and the pi (string | text-part) shapes. */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text" || part?.type === "input_text" || part?.type === "output_text")
		.map((part) => part.text || "").join("");
}

function firstUserText(history) {
	for (const item of history) {
		if (item?.role !== "user") continue;
		const text = textOf(item.content);
		if (text) return cleanUserText(text);
	}
	return "";
}

export function createSessionStore(dir = agentSessionsDir()) {
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		read(sessionId) {
			const { history: historyFile, meta: metaFile } = paths(dir, sessionId);
			let historyText;
			try { historyText = readFileSync(historyFile, "utf8"); }
			catch (error) { if (error?.code === "ENOENT") return null; throw error; }
			const lines = historyText.split("\n").filter(Boolean);
			if (!lines.length || !isV2Header(lines[0])) { warnLegacySession(sessionId); return null; }
			const entries = lines.slice(1).map((line) => JSON.parse(line));
			const history = entries.filter((entry) => entry?.kind === "message").map((entry) => entry.message);
			const turnErrors = entries.filter((entry) => entry?.kind === "turn_error").map(({ code, message, at, afterMessage }) => ({ code, message, at, afterMessage }));
			Object.defineProperty(history, "turnErrors", { value: turnErrors });
			let meta = null;
			try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			return { history, ...(turnErrors.length ? { turnErrors } : {}), meta };
		},
		appendTurnError(sessionId, { code, message, at = new Date().toISOString() }, meta = {}) {
			const { history: historyFile, meta: metaFile } = paths(dir, sessionId);
			let historyText = "";
			try { historyText = readFileSync(historyFile, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			const lines = historyText.split("\n").filter(Boolean);
			if (!lines.length) appendFileSync(historyFile, `${v2HeaderLine(sessionId)}\n`, { mode: 0o600 });
			const afterMessage = lines.slice(1).reduce((count, line) => count + (JSON.parse(line)?.kind === "message" ? 1 : 0), 0);
			appendFileSync(historyFile, `${JSON.stringify({ kind: "turn_error", code, message, at, afterMessage })}\n`, { mode: 0o600 });
			const now = new Date().toISOString();
			let previous = null;
			try { previous = JSON.parse(readFileSync(metaFile, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			const next = { ...previous, sessionId, surface: meta.surface ?? previous?.surface ?? "studio", createdAt: previous?.createdAt ?? now, updatedAt: now };
			writeFileSync(metaFile, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			return next;
		},
		append(sessionId, messages, meta = {}) {
			const { history: historyFile, meta: metaFile } = paths(dir, sessionId);
			const persisted = (Array.isArray(messages) ? messages : []).map(persistableMessage);
			let needsHeader = false;
			try { readFileSync(historyFile, "utf8"); }
			catch (error) { if (error?.code === "ENOENT") needsHeader = true; else throw error; }
			const headerText = needsHeader ? `${v2HeaderLine(sessionId)}\n` : "";
			const bodyText = persisted.length ? `${persisted.map((message) => JSON.stringify({ kind: "message", message })).join("\n")}\n` : "";
			if (headerText || bodyText) appendFileSync(historyFile, `${headerText}${bodyText}`, { mode: 0o600 });
			const now = new Date().toISOString();
			let previous = null;
			try { previous = JSON.parse(readFileSync(metaFile, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			const motionJobIds = [...new Set([
				...(Array.isArray(previous?.motionJobIds) ? previous.motionJobIds : []),
				...(Array.isArray(meta.motionJobIds) ? meta.motionJobIds : []),
			].filter((id) => typeof id === "string"))];
			const next = {
				sessionId,
				surface: meta.surface ?? previous?.surface ?? "studio",
				createdAt: previous?.createdAt ?? meta.createdAt ?? now,
				updatedAt: now,
				sceneName: meta.sceneName ?? previous?.sceneName ?? null,
				firstText: previous?.firstText || meta.firstText || firstUserText(messages),
				motionJobIds, ...((meta.parentId ?? previous?.parentId) ? { parentId: meta.parentId ?? previous.parentId, taskId: meta.taskId ?? previous?.taskId ?? null } : {}),
			};
			writeFileSync(metaFile, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			return next;
		},
		list({ surface } = {}) {
			let names = [];
			try { names = readdirSync(dir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			return names.filter((name) => name.endsWith(".meta.json")).flatMap((name) => {
				const sessionId = name.slice(0, -".meta.json".length);
				try {
					// null means "no jsonl file at all" (fine, listed on meta alone); any
					// string — including an empty one from a file that starts with '\n' —
					// must parse as the v2 header or the session is legacy.
					let firstLine = null;
					try { firstLine = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8").split("\n", 1)[0] ?? ""; }
					catch (error) { if (error?.code !== "ENOENT") throw error; }
					if (firstLine !== null && !isV2Header(firstLine)) { warnLegacySession(sessionId); return []; }
					const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
					return (!surface || meta.surface === surface) && !meta.parentId ? [meta] : [];
				} catch { return []; }
			}).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 50);
		},
	};
}

function receiptSummary(value) {
	if (!value || typeof value !== "object") return "Receipt";
	if (typeof value.summary === "string" && value.summary) return value.summary;
	if (value.status === "installed") return `Installed ${value.installed?.durationSeconds ?? ""}s of motion`;
	if (value.status === "undone") return `Undid ${value.undoneReceiptId || "edit"}`;
	if (value.status === "noop") return "Nothing to change";
	return value.status === "applied" ? "Applied to the scene" : `Receipt: ${value.status || "complete"}`;
}

const ATTACHMENT_LABEL = "User attachment ";
const OBSERVATION_LABEL = /^Studio (frame|plan|motion) observation\b/; // the editor's own frame, top-view plan or motion result (motion-door.mjs), never the user's text

/** A pasted picture the sidecar put in front of the turn text (#367): its label
 * plus the inline image, or the label alone when the image was too large to keep. */
function legacyAttachmentPart(item) {
	if (item?.role !== "user" || !Array.isArray(item.content)) return null;
	const label = textOf(item.content.filter((part) => part?.type === "input_text"));
	if (!label.startsWith(ATTACHMENT_LABEL)) return null;
	const image = item.content.find((part) => part?.type === "input_image");
	return { name: label.slice(ATTACHMENT_LABEL.length), dataUrl: image?.image_url ?? image?.imageUrl ?? image?.dataUrl ?? null };
}

/** The plain text and pasted-picture attachments of one pi user message.
 * A `User attachment <name>` text part is a LABEL for the image part that
 * follows it, never rendered into the bubble text; every other text part is
 * ordinary turn text, joined with '\n'. Each image maps to an attachment in
 * content order: its name comes from `attachmentNames[i]` when present, else
 * the adjacent label, else `attachment-<i+1>`. An image with no bytes (too
 * large to persist) is dropped rather than left as an empty thumbnail. */
function piUserContentParts(content, attachmentNames) {
	if (typeof content === "string") return { text: content, attachments: [] };
	if (!Array.isArray(content)) return { text: "", attachments: [] };
	const names = Array.isArray(attachmentNames) ? attachmentNames : [];
	const texts = [];
	const attachments = [];
	let pendingLabel = null;
	let imageIndex = 0;
	for (const part of content) {
		if (part?.type === "text") {
			const text = part.text || "";
			if (text.startsWith(ATTACHMENT_LABEL)) { pendingLabel = text.slice(ATTACHMENT_LABEL.length); continue; }
			if (text) texts.push(text);
			continue;
		}
		if (part?.type === "image") {
			const name = names[imageIndex] ?? pendingLabel ?? `attachment-${imageIndex + 1}`;
			const dataUrl = typeof part.data === "string" && part.data.startsWith("data:") ? part.data : (part.data ? `data:${part.mimeType || "image/png"};base64,${part.data}` : null);
			if (dataUrl) attachments.push({ name, dataUrl });
			pendingLabel = null;
			imageIndex += 1;
		}
	}
	return { text: texts.join("\n"), attachments };
}

function isLegacyItem(item) {
	if (item?.type === "message" || item?.type === "function_call" || item?.type === "function_call_output") return true;
	if (Array.isArray(item?.content)) return item.content.some((part) => part?.type === "input_text" || part?.type === "input_image" || part?.type === "output_text");
	return false;
}

/** Convert a history of pi Messages (or, for older sessions still in flight
 * through the caller, the pre-v2 codex items) into the one transcript view
 * consumed by the panel. */
export function transcriptFromHistory(history = []) {
	const transcript = [];
	const seenReceiptIds = new Set();
	const turnErrors = Array.isArray(history?.turnErrors) ? history.turnErrors : [];
	const expandedHistory = [];
	for (let index = 0; index < history.length; index += 1) {
		expandedHistory.push(history[index]);
		for (const error of turnErrors) if (error.afterMessage === index + 1) expandedHistory.push({ kind: "persisted-turn-error", error });
	}
	for (const error of turnErrors) if (!Number.isInteger(error.afterMessage) || error.afterMessage > history.length) expandedHistory.push({ kind: "persisted-turn-error", error });

	// Legacy (codex item) state.
	const legacyCalls = new Map();
	let legacyPendingAttachments = [];
	const flushLegacyAttachments = (text = "") => {
		const attachments = legacyPendingAttachments.filter((entry) => entry.dataUrl);
		legacyPendingAttachments = [];
		if (!text && !attachments.length) return;
		transcript.push(attachments.length ? { kind: "user", text, attachments } : { kind: "user", text });
	};

	// Pi message state.
	const piCalls = new Map();
	let piPendingAttachments = [];
	const flushPiAttachments = (text = "") => {
		const attachments = piPendingAttachments.filter((entry) => entry.dataUrl);
		piPendingAttachments = [];
		const isFrame = OBSERVATION_LABEL.test(text);
		if (isFrame) {
			if (attachments.length) transcript.push({ kind: "user", attachments });
			return;
		}
		if (!text && !attachments.length) return;
		transcript.push(attachments.length ? { kind: "user", text, attachments } : { kind: "user", text });
	};

	for (const item of expandedHistory) {
		if (item?.kind === "persisted-turn-error") {
			transcript.push({ kind: "failure", code: item.error.code, message: item.error.message });
			continue;
		}
		if (isLegacyItem(item)) {
			if (item?.type === "message") {
				const text = textOf(item.content);
				if (item.role === "user") flushLegacyAttachments(text);
				else if (text) transcript.push({ kind: "assistant", text });
				continue;
			}
			if (item?.role === "user") {
				const attachment = legacyAttachmentPart(item);
				if (attachment) { legacyPendingAttachments.push(attachment); continue; }
				flushLegacyAttachments(cleanUserText(textOf(item.content.filter((part) => part?.type === "input_text"))));
				continue;
			}
			if (legacyPendingAttachments.length) flushLegacyAttachments();
			if (item?.type === "function_call") {
				const tool = { kind: "tool", name: item.name || "tool", label: String(item.name || "tool").replaceAll("_", " "), ok: true, elapsedMs: null };
				transcript.push(tool);
				legacyCalls.set(item.call_id, tool);
				continue;
			}
			if (item?.type !== "function_call_output") continue;
			let output = null;
			try { output = JSON.parse(item.output); } catch { /* keep an unstructured tool output successful */ }
			const tool = legacyCalls.get(item.call_id);
			if (tool) {
				tool.ok = output?.ok !== false && !output?.error;
				if (Number.isFinite(output?.elapsedMs)) tool.elapsedMs = output.elapsedMs;
			}
			const receipt = output?.receiptId ? output : output?.receipt;
			if (receipt?.receiptId && !seenReceiptIds.has(receipt.receiptId)) {
				seenReceiptIds.add(receipt.receiptId);
				transcript.push({ kind: "receipt", receiptId: receipt.receiptId, summary: receiptSummary(receipt) });
			}
			continue;
		}

		// pi Message.
		if (item?.role === "user") {
			const { text, attachments } = piUserContentParts(item.content, item.attachmentNames);
			if (attachments.length) piPendingAttachments.push(...attachments);
			const cleaned = cleanUserText(text);
			if (cleaned) flushPiAttachments(cleaned);
			continue;
		}
		if (piPendingAttachments.length) flushPiAttachments();
		if (item?.role === "assistant") {
			const parts = Array.isArray(item.content) ? item.content : [];
			const text = parts.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
			if (text) transcript.push({ kind: "assistant", text });
			for (const part of parts) {
				if (part?.type !== "toolCall") continue;
				const tool = { kind: "tool", name: part.name || "tool", label: String(part.name || "tool").replaceAll("_", " "), ok: true, elapsedMs: null };
				transcript.push(tool);
				if (part.id) piCalls.set(part.id, tool);
			}
			continue;
		}
		if (item?.role === "toolResult") {
			const tool = piCalls.get(item.toolCallId);
			// A result the turn's plan changed in carries the whole list (plan-tool.mjs); the panel keeps its turn's last one.
			if (tool) tool.ok = !item.isError; if (Array.isArray(item.details?.plan)) transcript.push({ kind: "plan", steps: item.details.plan });
			const receiptId = item.details?.receiptId;
			if (receiptId && !seenReceiptIds.has(receiptId)) {
				seenReceiptIds.add(receiptId);
				transcript.push({ kind: "receipt", receiptId, summary: receiptSummary(item.details) });
			}
			continue;
		}
	}
	return transcript;
}
