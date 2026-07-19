import {
	parseServerMessage,
	type ClientMessage,
	type DirectorTranscript,
	type DirectorTranscriptRequest,
	type DirectorToolName,
	type DirectorTurn,
	type DirectorTurnEvent,
	type ServerMessage,
} from "@oh-my-blender/protocol";

export type { DirectorTranscript, DirectorTranscriptRequest, DirectorToolName };
export type DirectorEvent = DirectorTurnEvent;
export type DirectorTurnRequest = DirectorTurn;

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

export type DirectorServerMessage = ServerMessage | ControllerAuth | AttachTicket;
export type DirectorClientMessage = ClientMessage | IssueAttachTicket;

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

export function isDirectorServerMessage(value: unknown): value is DirectorServerMessage {
	if (isRecord(value)) {
		if (value.type === "controller_auth") return isControllerAuth(value);
		if (value.type === "attach_ticket") return isAttachTicket(value);
	}
	try {
		parseServerMessage(value);
		return true;
	} catch {
		return false;
	}
}
