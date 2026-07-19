import {
	parseDirectorTurnEvent,
	parseServerMessage,
	type ClientMessage,
	type DirectorToolName,
	type DirectorTurn,
	type DirectorTurnEvent,
	type ServerMessage,
} from "@oh-my-blender/protocol";

export type { DirectorToolName };
export type DirectorEvent = DirectorTurnEvent;
export type DirectorTurnRequest = DirectorTurn;

export interface DirectorTranscriptRequest {
	readonly type: "director_transcript_request";
	readonly id: string;
	readonly cursor: number;
	readonly page_size: number;
}

export interface DirectorTranscript {
	readonly type: "director_transcript";
	readonly id: string;
	readonly session_id: string;
	readonly events: readonly DirectorEvent[];
	readonly next_cursor: number | null;
}

export interface ControllerAuth {
	readonly type: "controller_auth";
	readonly resume_token: string;
	readonly launch_id: string;
}

export interface AttachTicket {
	readonly type: "attach_ticket";
	readonly role: "bridge";
	readonly ticket: string;
	readonly expires_in_ms: number;
	readonly launch_id: string;
	readonly runtime_directory?: string;
}

export interface IssueAttachTicket {
	readonly type: "issue_attach_ticket";
	readonly role: "bridge";
}

export type DirectorServerMessage = Exclude<ServerMessage, { readonly type: "director_transcript" }> |
	DirectorTranscript |
	ControllerAuth |
	AttachTicket;
export type DirectorClientMessage = Exclude<ClientMessage, { readonly type: "director_transcript_request" }> |
	DirectorTranscriptRequest |
	IssueAttachTicket;

const UUID_V4_LOWERCASE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key)) &&
		keys.every((key) => required.includes(key) || optional.includes(key));
}

function isControllerAuth(value: Record<string, unknown>): value is Record<string, unknown> & ControllerAuth {
	return hasExactKeys(value, ["type", "resume_token", "launch_id"]) &&
		value.type === "controller_auth" &&
		typeof value.resume_token === "string" &&
		BASE64URL_32.test(value.resume_token) &&
		typeof value.launch_id === "string" &&
		UUID_V4_LOWERCASE.test(value.launch_id);
}

function isAttachTicket(value: Record<string, unknown>): value is Record<string, unknown> & AttachTicket {
	return hasExactKeys(
		value,
		["type", "role", "ticket", "expires_in_ms", "launch_id"],
		["runtime_directory"],
	) &&
		value.type === "attach_ticket" &&
		value.role === "bridge" &&
		typeof value.ticket === "string" &&
		BASE64URL_32.test(value.ticket) &&
		Number.isSafeInteger(value.expires_in_ms) &&
		(value.expires_in_ms as number) >= 100 &&
		(value.expires_in_ms as number) <= 60_000 &&
		typeof value.launch_id === "string" &&
		UUID_V4_LOWERCASE.test(value.launch_id) &&
		(!Object.hasOwn(value, "runtime_directory") || typeof value.runtime_directory === "string");
}

function isDirectorTranscript(value: Record<string, unknown>): value is Record<string, unknown> & DirectorTranscript {
	if (
		!hasExactKeys(value, ["type", "id", "session_id", "events", "next_cursor"]) ||
		value.type !== "director_transcript" ||
		typeof value.id !== "string" ||
		!UUID_V4_LOWERCASE.test(value.id) ||
		typeof value.session_id !== "string" ||
		!UUID_V4_LOWERCASE.test(value.session_id) ||
		!Array.isArray(value.events) ||
		value.events.length > 64 ||
		(value.next_cursor !== null &&
			(!Number.isSafeInteger(value.next_cursor) ||
				(value.next_cursor as number) < 1 ||
				(value.next_cursor as number) > 10_000))
	) return false;
	try {
		for (const event of value.events) parseDirectorTurnEvent(event);
		return true;
	} catch {
		return false;
	}
}

export function isDirectorServerMessage(value: unknown): value is DirectorServerMessage {
	if (isRecord(value)) {
		if (value.type === "controller_auth") return isControllerAuth(value);
		if (value.type === "attach_ticket") return isAttachTicket(value);
		if (value.type === "director_transcript") return isDirectorTranscript(value);
	}
	try {
		parseServerMessage(value);
		return true;
	} catch {
		return false;
	}
}
