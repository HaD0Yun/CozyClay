import type { DirectorEvent, DirectorServerMessage } from "./protocol.ts";

export type { DirectorServerMessage } from "./protocol.ts";

export type TranscriptStatus = "disconnected" | "connecting" | "idle" | "running" | "cancelling" | "failed";

export interface TranscriptState {
	readonly events: readonly DirectorEvent[];
	readonly eventKeys: ReadonlySet<string>;
	readonly notices: readonly string[];
	readonly status: TranscriptStatus;
	readonly activeRequestId?: string;
	readonly taskStatus?: string;
}

export function createTranscriptState(status: TranscriptStatus = "idle"): TranscriptState {
	return { events: [], eventKeys: new Set(), notices: [], status };
}
export function markTurnSubmitted(state: TranscriptState, requestId: string): TranscriptState {
	return { ...state, status: "running", activeRequestId: requestId, taskStatus: "queued" };
}

export function appendTranscriptNotice(state: TranscriptState, notice: string): TranscriptState {
	return { ...state, notices: [...state.notices, notice] };
}

function eventKey(event: DirectorEvent): string {
	return `${event.id}:${event.sequence}`;
}

function terminal(event: DirectorEvent): boolean {
	return event.type === "director_turn_completed" ||
		event.type === "director_turn_failed" ||
		event.type === "director_turn_cancelled";
}

function statusAfterEvent(event: DirectorEvent): TranscriptStatus {
	if (event.type === "director_turn_failed") return "failed";
	return terminal(event) ? "idle" : "running";
}

function appendEvent(state: TranscriptState, event: DirectorEvent): TranscriptState {
	const key = eventKey(event);
	if (state.eventKeys.has(key)) return state;
	const eventKeys = new Set(state.eventKeys);
	eventKeys.add(key);
	return {
		...state,
		events: [...state.events, event],
		eventKeys,
		status: statusAfterEvent(event),
		activeRequestId: terminal(event) ? undefined : event.id,
		taskStatus: undefined,
	};
}

function replaceTranscript(state: TranscriptState, events: readonly DirectorEvent[]): TranscriptState {
	const unique: DirectorEvent[] = [];
	const eventKeys = new Set<string>();
	for (const event of events) {
		const key = eventKey(event);
		if (eventKeys.has(key)) continue;
		eventKeys.add(key);
		unique.push(event);
	}
	const last = unique.at(-1);
	return {
		...state,
		events: unique,
		eventKeys,
		status: last === undefined ? "idle" : statusAfterEvent(last),
		activeRequestId: last === undefined || terminal(last) ? undefined : last.id,
		taskStatus: undefined,
	};
}

export function reduceDirectorMessage(state: TranscriptState, message: DirectorServerMessage): TranscriptState {
	switch (message.type) {
		case "director_transcript":
			return replaceTranscript(state, message.events);
		case "director_turn_started":
		case "director_tool_call_started":
		case "director_tool_call_finished":
		case "director_turn_completed":
		case "director_turn_failed":
		case "director_turn_cancelled":
			return appendEvent(state, message);
		case "progress":
			return {
				...state,
				status: "running",
				activeRequestId: message.id,
				taskStatus: `${message.phase} ${message.completed}/${message.total}`,
			};
		case "cancel_ack":
			return message.status === "accepted" ? { ...state, status: "cancelling", activeRequestId: message.id } : state;
		case "error": {
			const notices = [...state.notices, `${message.code}: ${message.message}`];
			// An error for a request other than the active turn (e.g. a rejected
			// duplicate submission) must not clear active-turn tracking.
			if (state.activeRequestId !== undefined && message.id !== state.activeRequestId) {
				return { ...state, notices };
			}
			return {
				...state,
				status: "failed",
				activeRequestId: undefined,
				notices,
				taskStatus: undefined,
			};
		}
		default:
			return state;
	}
}

/** Client-side submit gate: empty prompts are dropped, one turn at a time. */
export function evaluatePromptSubmission(
	state: TranscriptState,
	prompt: string,
): { readonly prompt?: string; readonly notice?: string } {
	const trimmed = prompt.trim();
	if (trimmed.length === 0) return {};
	if (state.activeRequestId !== undefined || state.status === "cancelling") {
		return { notice: "A director turn is still active - wait for it to finish or press Ctrl-C to cancel." };
	}
	return { prompt: trimmed };
}

function formatEvent(event: DirectorEvent): string {
	switch (event.type) {
		case "director_turn_started":
			return `> ${event.prompt}`;
		case "director_tool_call_started":
			return `[${event.tool_name}] started ${event.params_summary}`;
		case "director_tool_call_finished":
			return `[${event.tool_name}] ${event.is_error ? "failed" : "finished"} ${event.result_digest}`;
		case "director_turn_completed":
			return event.summary;
		case "director_turn_failed":
			return `${event.code}: ${event.message}`;
		case "director_turn_cancelled":
			return "Turn cancelled.";
	}
}

export function formatTranscript(state: TranscriptState): string {
	return [...state.events.map(formatEvent), ...state.notices].join("\n");
}

export function formatStatus(
	state: TranscriptState,
	connection: "connected" | "reconnecting" | "disconnected",
): string {
	const task = state.taskStatus === undefined ? "" : ` | ${state.taskStatus}`;
	return `${connection} | ${state.status}${task}`;
}
