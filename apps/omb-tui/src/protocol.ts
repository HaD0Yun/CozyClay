import {
	parseServerMessage,
	type ClientMessage,
	type DirectorTranscript,
	type DirectorTranscriptRequest,
	type DirectorToolName,
	type DirectorTurn,
	type DirectorTurnDelta,
	type DirectorTurnEvent,
	type ServerMessage,
} from "@oh-my-blender/protocol";

export type { DirectorTranscript, DirectorTranscriptRequest, DirectorToolName };
export type DirectorEvent = DirectorTurnEvent;
export type DirectorTurnRequest = DirectorTurn;
export type DirectorStreamMessage =
	| DirectorTurnDelta
	| Extract<DirectorTurnEvent, { type: "director_assistant_utterance" }>;

export interface LegacyAttachTicket {
	readonly type: "attach_ticket";
	readonly role: "bridge";
	readonly ticket: string;
	readonly expires_in_ms: number;
	readonly launch_id: string;
	readonly runtime_directory?: string;
}

export interface BridgeStatus {
	readonly type: "bridge_status";
	readonly attached: boolean;
}

export type DirectorServerMessage = ServerMessage | LegacyAttachTicket | BridgeStatus;
export type DirectorClientMessage = ClientMessage;

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

function isBridgeStatus(value: Record<string, unknown>): value is Record<string, unknown> & BridgeStatus {
	return hasExactKeys(value, ["type", "attached"]) &&
		value.type === "bridge_status" &&
		typeof value.attached === "boolean";
}

function isLegacyAttachTicket(value: Record<string, unknown>): value is Record<string, unknown> & LegacyAttachTicket {
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
	try {
		parseServerMessage(value);
		return true;
	} catch {
		return isRecord(value) && (isLegacyAttachTicket(value) || isBridgeStatus(value));
	}
}

export function isDirectorStreamMessage(value: unknown): value is DirectorStreamMessage {
	return isRecord(value) &&
		(value.type === "director_turn_delta" || value.type === "director_assistant_utterance") &&
		isDirectorServerMessage(value);
}
