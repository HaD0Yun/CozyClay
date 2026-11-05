// The analytics of one agent turn, owned by the browser request (createHttpTransport.turn in agent-client.js):
// agent:turn_requested, the validated execution_telemetry frames, the terminal agent:turn_<outcome>, then exactly one
// agent:turn_summary and the post-turn edit window (post-turn-edits.js). Only closed values leave here: never tool
// names, arguments, messages or authored text.
import { bucketMs } from "../analytics.js";
import { bucketLong, refusalCodeOf } from "../analytics-strict.js";
import { bucketFrictionCount } from "../analytics-friction.js";
import { AGENT_TOOL_CATEGORIES, EXECUTION_TELEMETRY_VALUES } from "../execution-telemetry.js";
import { closePostTurnWindow, openPostTurnWindow } from "../post-turn-edits.js";
import { AGENT_FAILURE_CODES } from "./agent-failure-codes.js";
import { noteTurnOutcome } from "./connect-telemetry.js";
import { notePromptTurnEnded, takePrompt } from "./prompt-telemetry.js";

const validTelemetryId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
	&& Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const advisory = (read, fallback) => { try { return read(); } catch { return fallback; } };

// motion.compile drafts per turn correlation id (src/commands/motion3.js). A turn that never finishes must not leak:
// past this many turns the oldest is forgotten.
const DRAFT_TURNS = 16;
// The post-turn window's timer never keeps a process (a test, the sidecar's node checks) alive.
const windowTimers = {
	set: (fn, ms) => { const timer = setTimeout(fn, ms); timer?.unref?.(); return timer; },
	clear: (timer) => clearTimeout(timer), now: () => Date.now(),
};
const drafts = new Map();

/** One compiled draft of `turnId` (the bus context's turnId): { clean, problems, stuck }. */
export function noteTurnDraft(turnId, { clean, problems, stuck } = {}) {
	if (typeof turnId !== "string" || !turnId) return;
	const draft = { clean: Boolean(clean), problems: Number.isFinite(problems) ? problems : 0 };
	const row = drafts.get(turnId);
	if (row) { row.n += 1; row.last = draft; row.stuck ||= Boolean(stuck); return; }
	drafts.set(turnId, { n: 1, first: draft, last: draft, stuck: Boolean(stuck) });
	while (drafts.size > DRAFT_TURNS) drafts.delete(drafts.keys().next().value);
}

/** The drafts part of agent:turn_summary for `turnId`; the turn's drafts are cleared. */
function takeDrafts(turnId) {
	const row = drafts.get(turnId);
	drafts.delete(turnId);
	if (!row) return { drafts: "0", qa_trend: "na", stuck: false };
	const qa = (draft) => (draft.clean ? "clean" : "problems");
	const trend = row.n < 2 ? "na" : row.last.problems < row.first.problems ? "improved" : row.last.problems > row.first.problems ? "worse" : "flat";
	return { drafts: bucketFrictionCount(row.n), qa_first: qa(row.first), qa_last: qa(row.last), qa_trend: trend, stuck: row.stuck };
}

// "TARGET_NOT_READY: The scene is not ready." -- the sidecar sends a refused Studio call as tool.done { ok: false }
// with the code only as the error's prefix (bin/agent/pi-tools.mjs formatToolError). A stop is no refusal.
const refusalOf = (event) => {
	if (event.ok === false) {
		const code = /^([A-Z][A-Z0-9_]*):/.exec(typeof event.error === "string" ? event.error : "")?.[1];
		return code && code !== "ABORTED" ? code : null;
	}
	return event.result?.ok === false && typeof event.result.code === "string" ? event.result.code : null;
};

/** The tool part of agent:turn_summary, read from the turn's tool.start / tool.done frames. */
function createToolTally(clock, startedAt) {
	const started = new Set(), done = new Set(), refusals = new Map();
	let calls = 0, failed = 0, refused = 0, stale = 0, authored = false, firstAt = null;
	return {
		note(event) {
			const id = typeof event?.callId === "string" ? event.callId : null;
			if (event?.type === "tool.start") {
				if (id && started.has(id)) return;
				if (id) started.add(id);
				calls += 1;
				if (firstAt === null) firstAt = clock();
				return;
			}
			if (event?.type !== "tool.done" || (id && done.has(id))) return;
			if (id) done.add(id);
			if (event.ok === false) failed += 1;
			if (event.ok === true && event.result?.authored === true) authored = true;
			if (event.autoRebased === true) stale += 1;
			const code = refusalOf(event);
			if (code) { refused += 1; const key = refusalCodeOf(code); refusals.set(key, (refusals.get(key) ?? 0) + 1); }
		},
		applied() { authored = true; },
		props(outcome) {
			let top = "none", most = 0;
			for (const [code, n] of refusals) if (n > most) { top = code; most = n; }
			const open = [...started].some((id) => !done.has(id));
			return {
				tool_calls: bucketFrictionCount(calls), tool_failed: bucketFrictionCount(failed), refused: bucketFrictionCount(refused), refusal_top: top,
				stale_retry: bucketFrictionCount(stale), authored,
				...(firstAt === null ? {} : { first_tool: bucketLong(firstAt - startedAt) }),
				cancel_phase: outcome !== "cancelled" ? "na" : calls === 0 ? "before_tool" : open ? "during_tool" : "after_tool",
			};
		},
	};
}

// The real browser request owns the attempt, including HTTP refusal and Stop.
// These IDs never use panel session IDs, model call IDs or authored content.
/** `surface` is already resolved: "studio" or "workflow". */
export function startAgentTurn({ surface, capture, now, correlationId = null }) {
	// The next turn ends the previous turn's edit window.
	closePostTurnWindow();
	const turnId = advisory(() => {
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}, null);
	const clock = () => advisory(() => { const value = now(); return Number.isFinite(value) ? value : NaN; }, NaN);
	// A Studio turn already has a host-owned id and its frozen envelope has no
	// room for a second one, so the sidecar names its frames with THAT id. The
	// analytics id stays the local hex one: it is the only id analytics accepts.
	const matchId = correlationId ?? turnId;
	const startedAt = clock();
	let terminal = false;
	let applied = false;
	const tools = new Map();
	const seenTools = new Set();
	const tally = createToolTally(clock, startedAt);
	const emit = (event, props) => {
		if (!turnId) return;
		try { Promise.resolve(capture(event, props)).catch(() => {}); } catch { /* telemetry is advisory */ }
	};
	const finish = (outcome, failureCode) => {
		if (terminal) return;
		terminal = true;
		noteTurnOutcome(outcome); notePromptTurnEnded(outcome);
		if (outcome === "cancelled") {
			for (const [id, tool] of tools) {
				if (!seenTools.has(id)) emit("agent:tool_executed", { turn_id: turnId, tool_category: tool.category, outcome: "cancelled", duration_bucket: bucketMs(clock() - tool.startedAt) });
			}
		}
		tools.clear();
		emit(`agent:turn_${outcome}`, { turn_id: turnId, duration_bucket: bucketMs(clock() - startedAt), ...(outcome !== "succeeded" ? { failure_code: failureCode } : {}), ...(outcome === "failed" ? origin : {}) });
		const summary = advisory(() => ({ turn_id: turnId, outcome, wall: bucketLong(clock() - startedAt), ...tally.props(outcome), ...takeDrafts(matchId) }), null);
		if (summary) emit("agent:turn_summary", summary);
		// Only a Studio turn is followed by Studio edits; the Workflow canvas has no edit groups to count.
		if (turnId && surface === "studio") openPostTurnWindow(turnId, emit, windowTimers);
	};
	emit("agent:turn_requested", { surface, turn_id: turnId });
	// The prompt the panel staged as it sent this turn (prompt-telemetry.js), with the same turn id.
	const prompt = takePrompt(turnId);
	if (prompt) emit("agent:prompt_sent", prompt);
	// A failed turn names its provider and, for openai-compatible, the server address's class (#1043), so failures
	// split by provider and by local vs hosted server without a join. The prompt's own closed values, never the address.
	const origin = prompt ? { provider: prompt.provider, ...(prompt.endpoint ? { endpoint: prompt.endpoint } : {}) } : {};
	return {
		turnId,
		cancel: () => finish("cancelled", "aborted"),
		fail: (code) => finish("failed", AGENT_FAILURE_CODES.has(code) ? code : "unknown"),
		/** A tool.start / tool.done frame the panel sees (after replay dedupe). */
		tool(event) {
			if (!terminal) advisory(() => tally.note(event), null);
		},
		frame(frame) {
			// Local sidecar frames are still an untrusted boundary. Reject the whole
			// frame, including extra fields, before dedupe or analytics capture.
			try {
				if (!turnId || terminal) return;
				if (frame.type === "execution_tool_started") {
					if (!exactKeys(frame, ["type", "turn_id", "telemetry_id", "tool_category"]) || frame.turn_id !== matchId
						|| !validTelemetryId(frame.telemetry_id) || !AGENT_TOOL_CATEGORIES.includes(frame.tool_category)) return;
					if (!tools.has(frame.telemetry_id) && !seenTools.has(frame.telemetry_id)) tools.set(frame.telemetry_id, { category: frame.tool_category, startedAt: clock() });
					return;
				}
				const { event, props } = frame;
				if (props?.turn_id !== matchId) return;
				if (event === "agent:tool_executed") {
					if (!exactKeys(frame, ["type", "event", "props", "telemetry_id"]) || !validTelemetryId(frame.telemetry_id)
						|| !exactKeys(props, ["turn_id", "tool_category", "outcome", "duration_bucket"])
						|| !AGENT_TOOL_CATEGORIES.includes(props.tool_category) || !["succeeded", "failed", "cancelled"].includes(props.outcome)
						|| !EXECUTION_TELEMETRY_VALUES.duration_bucket.has(props.duration_bucket) || seenTools.has(frame.telemetry_id)) return;
					seenTools.add(frame.telemetry_id);
					tools.delete(frame.telemetry_id);
					emit(event, { turn_id: turnId, tool_category: props.tool_category, outcome: props.outcome, duration_bucket: props.duration_bucket });
					return;
				}
				if (!exactKeys(frame, ["type", "event", "props"])) return;
				if (event === "agent:result_applied") {
					if (!applied && exactKeys(props, ["turn_id"])) { applied = true; tally.applied(); emit(event, { turn_id: turnId }); }
					return;
				}
				if (!["agent:turn_succeeded", "agent:turn_failed", "agent:turn_cancelled"].includes(event)) return;
				const outcome = event.slice("agent:turn_".length);
				const hasFailure = Object.hasOwn(props, "failure_code");
				if (!exactKeys(props, ["turn_id", "duration_bucket", ...(hasFailure ? ["failure_code"] : [])])
					|| !EXECUTION_TELEMETRY_VALUES.duration_bucket.has(props.duration_bucket)
					|| (hasFailure && (outcome === "succeeded" || !AGENT_FAILURE_CODES.has(props.failure_code)))) return;
				finish(outcome, outcome === "cancelled" ? "aborted" : props.failure_code || "unknown");
			} catch { /* foreign getters and malformed telemetry cannot affect a turn */ }
		},
	};
}

// The agent-busy signal (the update notice disables "Update now" while a turn runs, src/update/UpdateDialog.jsx).
// createAgentTransport wraps every transport it returns, so the dock, an embedded Studio panel and sculpt mode all count.
let runningTurns = 0;
const turnListeners = new Set();
const notifyTurns = () => {
	for (const listener of [...turnListeners]) { try { listener(runningTurns > 0); } catch { /* a listener cannot break a turn */ } }
};

/** True while any transport.turn() returned by createAgentTransport has not settled. */
export const agentTurnRunning = () => runningTurns > 0;

/** `listener(running)` on every turn start and end; returns the unsubscribe. */
export function subscribeAgentTurns(listener) {
	turnListeners.add(listener);
	return () => { turnListeners.delete(listener); };
}

/** Replace transport.turn in place so every end path (done, error, throw, abort) clears the signal. */
export function trackAgentTurns(transport) {
	const turn = transport?.turn;
	if (typeof turn !== "function") return transport;
	transport.turn = async function trackedTurn(...args) {
		runningTurns += 1;
		notifyTurns();
		try {
			return await turn.apply(this, args);
		} finally {
			runningTurns -= 1;
			notifyTurns();
		}
	};
	return transport;
}
