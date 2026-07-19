export type DirectorToolName =
	| "inspect_project"
	| "stage_scene"
	| "apply_camera_plan"
	| "render_qa_frames";

interface DirectorEventBase {
	readonly id: string;
	readonly sequence: number;
	readonly at: string;
}

export interface DirectorTurnStarted extends DirectorEventBase {
	readonly type: "director_turn_started";
	readonly prompt: string;
}

export interface DirectorToolCallStarted extends DirectorEventBase {
	readonly type: "director_tool_call_started";
	readonly tool_call_id: string;
	readonly tool_name: DirectorToolName;
	readonly params_summary: string;
}

export interface DirectorToolCallFinished extends DirectorEventBase {
	readonly type: "director_tool_call_finished";
	readonly tool_call_id: string;
	readonly tool_name: DirectorToolName;
	readonly result_digest: string;
	readonly is_error: boolean;
}

export interface DirectorTurnCompleted extends DirectorEventBase {
	readonly type: "director_turn_completed";
	readonly summary: string;
	readonly resulting_revision_id: string;
}

export interface DirectorTurnFailed extends DirectorEventBase {
	readonly type: "director_turn_failed";
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface DirectorTurnCancelled extends DirectorEventBase {
	readonly type: "director_turn_cancelled";
}

export type DirectorEvent =
	| DirectorTurnStarted
	| DirectorToolCallStarted
	| DirectorToolCallFinished
	| DirectorTurnCompleted
	| DirectorTurnFailed
	| DirectorTurnCancelled;

export interface DirectorTranscript {
	readonly type: "director_transcript";
	readonly id: string;
	readonly session_id: string;
	readonly events: readonly DirectorEvent[];
}

export type DirectorServerMessage =
	| DirectorEvent
	| DirectorTranscript
	| { readonly type: "hello_ack"; readonly [key: string]: unknown }
	| { readonly type: "controller_auth"; readonly resume_token: string; readonly launch_id: string }
	| { readonly type: "progress"; readonly id: string; readonly phase: string; readonly completed: number; readonly total: number }
	| { readonly type: "cancel_ack"; readonly id: string; readonly status: "accepted" | "already_terminal" | "unknown" }
	| { readonly type: "error"; readonly id: string; readonly code: string; readonly message: string; readonly retryable: boolean }
	| { readonly type: "pong"; readonly nonce: string }
	| { readonly type: "shutdown_ack" };

export interface DirectorTurnRequest {
	readonly type: "director_turn";
	readonly id: string;
	readonly prompt: string;
	readonly expected_revision_id: string;
	readonly deadline_ms: number;
}

export interface DirectorTranscriptRequest {
	readonly type: "director_transcript_request";
	readonly id: string;
}

export type DirectorClientMessage =
	| DirectorTurnRequest
	| DirectorTranscriptRequest
	| { readonly type: "cancel"; readonly id: string }
	| { readonly type: "ping"; readonly nonce: string }
	| { readonly type: "shutdown"; readonly reason: string }
	| Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasEventBase(value: Record<string, unknown>): boolean {
	return typeof value.id === "string" &&
		Number.isSafeInteger(value.sequence) &&
		(value.sequence as number) >= 0 &&
		typeof value.at === "string";
}

function isToolName(value: unknown): value is DirectorToolName {
	return value === "inspect_project" ||
		value === "stage_scene" ||
		value === "apply_camera_plan" ||
		value === "render_qa_frames";
}

function isDirectorEvent(value: unknown): value is DirectorEvent {
	if (!isRecord(value) || typeof value.type !== "string" || !hasEventBase(value)) return false;
	switch (value.type) {
		case "director_turn_started":
			return typeof value.prompt === "string";
		case "director_tool_call_started":
			return typeof value.tool_call_id === "string" &&
				isToolName(value.tool_name) &&
				typeof value.params_summary === "string";
		case "director_tool_call_finished":
			return typeof value.tool_call_id === "string" &&
				isToolName(value.tool_name) &&
				typeof value.result_digest === "string" &&
				typeof value.is_error === "boolean";
		case "director_turn_completed":
			return typeof value.summary === "string" && typeof value.resulting_revision_id === "string";
		case "director_turn_failed":
			return typeof value.code === "string" &&
				typeof value.message === "string" &&
				typeof value.retryable === "boolean";
		case "director_turn_cancelled":
			return true;
		default:
			return false;
	}
}


export function isDirectorServerMessage(value: unknown): value is DirectorServerMessage {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (isDirectorEvent(value)) return true;
	switch (value.type) {
		case "director_transcript":
			return typeof value.id === "string" &&
				typeof value.session_id === "string" &&
				Array.isArray(value.events) &&
				value.events.every(isDirectorEvent);
		case "hello_ack":
			return true;
		case "controller_auth":
			return typeof value.resume_token === "string" && typeof value.launch_id === "string";
		case "progress":
			return typeof value.id === "string" &&
				typeof value.phase === "string" &&
				Number.isSafeInteger(value.completed) &&
				Number.isSafeInteger(value.total);
		case "cancel_ack":
			return typeof value.id === "string" &&
				(value.status === "accepted" || value.status === "already_terminal" || value.status === "unknown");
		case "error":
			return typeof value.id === "string" &&
				typeof value.code === "string" &&
				typeof value.message === "string" &&
				typeof value.retryable === "boolean";
		case "pong":
			return typeof value.nonce === "string";
		case "shutdown_ack":
			return true;
		default:
			return false;
	}
}
