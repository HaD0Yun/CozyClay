import { summariseCanvasResult } from "./agent-tools.mjs";
import { createReasoningFrames } from "./turn-frames.mjs";
import { sanitizeUpstreamDetail } from "./agent-routes.mjs";
import { budgetStudioRequest } from "./studio-context-budget.mjs";
import { createRetryingStream } from "./agent-stream.mjs";
import { NETWORK_CODES, frameCodeOf } from "./agent-failure-codes.mjs";

const DEFAULT_MODEL = "gpt-6-astra";

// Bounded provider retries (issue #379) run in agent-stream.mjs, around each
// request (pi classifies 429/5xx/network as transient via
// `isRetryableAssistantError`). `maxRetryDelayMs` caps how long a single
// request sleeps for a provider-requested Retry-After before pi's own
// SDK-level retry gives up and surfaces the error to us.
const RETRY_MAX_DELAY_MS = 20000;

const AUTH_ERROR_PATTERN = /\b(401|403)\b|unauthorized|forbidden/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i;
const OVERLOAD_PATTERN = /\b529\b|overloaded/i;
// Checked after the three above: a request that never got an HTTP answer, when only pi-ai's folded string survives.
const NETWORK_PATTERN = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network error/i;

// A numeric HTTP status, one per code. 401/403 both read as "unauthorized";
// 529 (Anthropic's overload status) reads as "overloaded"; every other 5xx
// (500, 502, 503, 504, ...) reads as the generic "upstream" — status always
// wins over whatever words happen to be in the message (an overload message
// with a 500 status is still "upstream", not "overloaded").
const STATUS_CODES = { 401: "unauthorized", 403: "unauthorized", 429: "rate_limit", 529: "overloaded" };
function statusToCode(status) {
	if (STATUS_CODES[status]) return STATUS_CODES[status];
	if (Number.isInteger(status) && status >= 500 && status <= 599) return "upstream";
}

/** Classify a failed message into the runner's frozen vocabulary (unauthorized,
 * rate_limit, overloaded, network, upstream). pi folds status and code into one
 * string (`formatProviderError`), so the patterns mirror pi's retryability
 * check; `errorCode`, the structure agent-stream.mjs kept from a thrown error
 * (a socket code or "TypeError"), decides first. Message-only fallback: use
 * `classifyError` at the run_end boundary so a structured status wins first. */
export function classifyProviderError(message, errorCode) {
	if (errorCode === "TypeError" || NETWORK_CODES.has(errorCode)) return "network";
	if (AUTH_ERROR_PATTERN.test(message)) return "unauthorized";
	if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (OVERLOAD_PATTERN.test(message)) return "overloaded";
	return NETWORK_PATTERN.test(message) ? "network" : "upstream";
}

function extractStatus(message) {
	const match = /\b(401|403|429|5\d\d)\b/.exec(message);
	return match ? Number(match[1]) : undefined;
}

function extractErrorStatus(error) {
	const candidate = error?.status ?? error?.details?.status ?? error?.details?.httpStatus;
	return Number.isInteger(candidate) ? candidate : undefined;
}

/** Classify a failed run's error object into `{code, status}`. A numeric
 * status on the error boundary (a thrown Error's `.status`, or a future pi
 * `OperationError.details.status`) is checked FIRST and wins outright; the
 * message-text regex is only a fallback for the status pi actually ships
 * today (folded into the string, see `formatProviderError` in pi-ai) or for
 * an unrecognized status code. Called only at provider response and run
 * failure boundaries — a tool's own failure text never reaches this function
 * (see the `tool_end` branch in `mapEvents`, which never calls this). */
export function classifyError(error) {
	const message = typeof error?.message === "string" ? error.message : "";
	const structuredStatus = extractErrorStatus(error);
	const status = structuredStatus ?? extractStatus(message);
	const code = (structuredStatus !== undefined ? statusToCode(structuredStatus) : undefined) ?? classifyProviderError(message, typeof error?.errorCode === "string" ? error.errorCode : undefined);
	return { code, status };
}

function dataUrlImage(dataUrl) {
	const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

function publicDetails(result) {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "dataUrl"));
}

function errorFrame(error, aborted = false) {
	return {
		type: "error",
		code: aborted || error?.name === "AbortError" ? "aborted" : frameCodeOf(error),
		message: error?.message || "The model or live editor could not complete this turn.",
		...(Number.isInteger(error?.status) ? { status: error.status } : {}),
	};
}

class FrameQueue {
	values = [];
	waiters = [];
	closed = false;
	push(value) {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}
	async next() {
		if (this.values.length) return { value: this.values.shift(), done: false };
		if (this.closed) return { value: undefined, done: true };
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const next = await this.next();
			if (next.done) return;
			yield next.value;
		}
	}
}

function attachmentMessage(attachment, index) {
	const image = dataUrlImage(attachment?.dataUrl);
	return {
		role: "user",
		content: [
			{ type: "text", text: `User attachment ${attachment?.name || index + 1}` },
			...(image ? [image] : []),
		],
	};
}

function studioAttachmentContent(attachments) {
	return (Array.isArray(attachments) ? attachments : []).flatMap((attachment, index) => {
		const image = dataUrlImage(attachment?.dataUrl);
		return image ? [{ type: "text", text: `User attachment ${attachment?.name || index + 1}` }, image] : [];
	});
}

function studioUserMessage(input) {
	const contextText = typeof input.studioContextText === "string"
		? input.studioContextText
		: `<studio-context>\n${input.contextText || ""}\n</studio-context>`;
	return {
		role: "user",
		content: [
			...studioAttachmentContent(input.attachments),
			{ type: "text", text: `${contextText}\n${input.text || ""}` },
		],
	};
}

const STUDIO_CONTEXT_PREFIX = "<studio-context>";
const STUDIO_CONTEXT_BLOCK = /^<studio-context>\n([\s\S]*?)\n<\/studio-context>/;
const STUDIO_CONTEXT_SUPERSEDED = "<studio-context superseded/>";
const escapeStudioJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
const isStudioContextPart = (part) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(STUDIO_CONTEXT_PREFIX);

function withoutInspectContext(part) {
	if (part?.type !== "text" || typeof part.text !== "string") return part;
	let parsed;
	try { parsed = JSON.parse(part.text); } catch { return part; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, "context")) return part;
	const { context: _context, ...rest } = parsed;
	return { ...part, text: JSON.stringify(rest) };
}

/** The Studio per-request context diet (#716), applied to the provider view
 * only (the Agent's transformContext): every <studio-context> but the latest is
 * replaced by a superseded marker, every inspect_studio result but the most
 * recent tool result drops its re-embedded `context`, and the latest
 * context's static actionIndex moves to the end of the system prompt. The
 * stored transcript is never touched; edited messages are new objects. */
function studioContextDiet({ messages, systemPrompt }) {
	let latestContext = -1;
	let latestToolResult = -1;
	messages.forEach((message, index) => {
		if (message?.role === "user" && Array.isArray(message.content) && message.content.some(isStudioContextPart)) latestContext = index;
		if (message?.role === "toolResult") latestToolResult = index;
	});
	let actionIndex;
	const edited = messages.map((message, index) => {
		if (message?.role === "toolResult" && message.toolName === "inspect_studio" && index !== latestToolResult && Array.isArray(message.content)) {
			const content = message.content.map(withoutInspectContext);
			return content.some((part, i) => part !== message.content[i]) ? { ...message, content } : message;
		}
		if (message?.role !== "user" || !Array.isArray(message.content) || !message.content.some(isStudioContextPart)) return message;
		const content = message.content.map((part) => {
			if (!isStudioContextPart(part)) return part;
			const block = STUDIO_CONTEXT_BLOCK.exec(part.text);
			if (index !== latestContext) return { ...part, text: block ? STUDIO_CONTEXT_SUPERSEDED + part.text.slice(block[0].length) : STUDIO_CONTEXT_SUPERSEDED };
			if (!block) return part;
			let context;
			try { context = JSON.parse(block[1]); } catch { return part; }
			if (!context || typeof context !== "object" || !Array.isArray(context.actionIndex)) return part;
			({ actionIndex } = context);
			const { actionIndex: _actionIndex, ...rest } = context;
			return { ...part, text: `${STUDIO_CONTEXT_PREFIX}\n${escapeStudioJson(rest)}\n</studio-context>${part.text.slice(block[0].length)}` };
		});
		return { ...message, content };
	});
	return {
		messages: edited,
		systemPrompt: actionIndex ? `${systemPrompt}\n<actions>\n${JSON.stringify(actionIndex)}\n</actions>` : systemPrompt,
	};
}

/** Anthropic prompt-cache breakpoints on the stable prefix (#716): pi-ai's
 * anthropic-messages builder already marks the system blocks, the last tool
 * and the last user block by default; this only fills a missing mark on the
 * last system block and the last tool, never past the API's 4 breakpoints,
 * and never on tools for a model whose compat declares them unsupported. */
export function withAnthropicCacheBreakpoints(payload, model) {
	if (!payload || typeof payload !== "object") return undefined;
	const marked = (block) => Boolean(block?.cache_control);
	const system = Array.isArray(payload.system) ? payload.system : [];
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const messageBlocks = (Array.isArray(payload.messages) ? payload.messages : []).flatMap((message) => Array.isArray(message?.content) ? message.content : []);
	let count = [...system, ...tools, ...messageBlocks].filter(marked).length;
	const cacheControl = { type: "ephemeral" };
	let next = payload;
	if (system.length && !marked(system.at(-1)) && count < 4) {
		next = { ...next, system: [...system.slice(0, -1), { ...system.at(-1), cache_control: cacheControl }] };
		count += 1;
	}
	// pi-ai 1.4 appends a defer_loading placeholder tool; the API rejects cache_control on deferred tools.
	const lastTool = tools.findLastIndex((tool) => !tool?.defer_loading);
	if (lastTool !== -1 && !marked(tools[lastTool]) && model?.compat?.supportsCacheControlOnTools !== false && count < 4) {
		next = { ...next, tools: tools.map((tool, index) => index === lastTool ? { ...tool, cache_control: cacheControl } : tool) };
	}
	return next === payload ? undefined : next;
}

function studioObservationMessage(observation) {
	return {
		role: "user",
		content: [
			{ type: "text", text: `Studio ${observation?.kind === "plan" ? "plan observation (top view)" : "frame observation"} at scene revision ${JSON.stringify(observation?.revision ?? null)}${observation?.receiptId ? `, receipt ${observation.receiptId}` : ""}` },
			{ type: "image", data: observation.data, mimeType: observation.mimeType },
		],
	};
}

/**
 * The runner is deliberately the only module in the bin/agent chain that
 * knows about pi. Keep these imports lazy: the package-isolation checks start
 * bin/cozyclay.mjs without node_modules installed.
 *
 * One session is one pi-agent-core `Agent`: its transcript (the system prompt
 * and tool declarations ride in its system messages), its model and thinking
 * level, and its steering queue. Each turn is one `agent.prompt()`.
 */
export function createAgentRunner({ models: suppliedModels, sessionStore, tools = [], systemPrompt = "", clock = () => performance.now(), fauxProvider, onQuota, codexBaseUrl, cliproxyBaseUrl, auth, credentials, keys, env } = {}) {
	const openSessions = new Map();
	let models = suppliedModels;
	let piModules;

	const loadPi = async () => {
		if (piModules) return piModules;
		const [{ Agent }, ai] = await Promise.all([import("@earendil-works/pi-agent-core"), import("@earendil-works/pi-ai")]);
		piModules = { Agent, ai };
		return piModules;
	};

	const ensureModels = async () => {
		const pi = await loadPi();
		if (!models) {
			const { createModels } = await import("./providers.mjs");
			models = await createModels({ codexBaseUrl, cliproxyBaseUrl, auth, credentials, keys, env });
		}
		if (fauxProvider) {
			const provider = fauxProvider.provider || fauxProvider;
			if (typeof models.setProvider === "function") models.setProvider(provider);
		}
		return { pi, models };
	};

	const openSession = async (sessionId, { surface = "workflow" } = {}) => {
		if (openSessions.has(sessionId)) return openSessions.get(sessionId).public;
		await ensureModels();
		const state = {
			sessionId,
			surface,
			agent: null,
			active: null,
			persisted: 0,
			lastInput: null,
			unsubscribers: [],
		};
		// The conversation: the transcript minus its system messages, which carry the prompt and the tool declarations.
		const conversation = () => (state.agent?.state.messages ?? []).filter((message) => message.role !== "system");

		// An aborted turn's assistant message must never reach sessionStore, even
		// when the generation itself finished normally before the cancellation
		// registered (pi only stops the run from starting a FURTHER turn; it does
		// not retroactively un-stream an already-committed message, so the run's
		// own outcome arrives too late — by then `turn_end` has already flushed
		// the completed turn through this same `persist`). The one reliable
		// abort signal is therefore "was THIS still-active turn aborted", tracked
		// synchronously on `state.active` the instant `publicSession.abort` is
		// called or the caller's signal fires (see below) — not any one event's shape.
		// The user message (and any toolResult from a tool that finished before
		// the abort) are real, completed history and ARE persisted; only the
		// assistant role is withheld, as is any assistant pi itself ended as
		// failed or cancelled.
		const persist = async () => {
			if (!state.agent || !sessionStore?.append) return;
			const messages = conversation();
			if (messages.length <= state.persisted) return;
			const aborted = state.active?.abortRequested === true;
			const newlyGenerated = messages.slice(state.persisted);
			const withheld = (message) => message?.role === "assistant" && (aborted || message.stopReason === "error" || message.stopReason === "aborted");
			const failedAssistant = newlyGenerated.find(withheld);
			// A tool call the abort cut short never finished: its result is not history either.
			const cutShort = (message) => message?.role === "toolResult" && state.active?.abortedCalls.has(message.toolCallId);
			const pending = newlyGenerated.filter((message) => !withheld(message) && !cutShort(message));
			state.persisted = messages.length;
			const input = state.lastInput || {};
			if (pending.length) await sessionStore.append(sessionId, pending, { surface, ...(input.meta || {}) });
			// One record per turn: an abort mid-tool withholds two assistants (the tool call, then the request it stopped).
			if (failedAssistant && sessionStore.appendTurnError && !state.active?.turnErrorRecorded) {
				if (state.active) state.active.turnErrorRecorded = true;
				const cancelled = aborted || failedAssistant.stopReason === "aborted";
				const rawMessage = failedAssistant.errorMessage || "The model or live editor could not complete this turn.";
				const message = cancelled ? "The turn was aborted." : sanitizeUpstreamDetail(JSON.stringify({ message: rawMessage })) || rawMessage;
				const code = cancelled ? "aborted" : classifyProviderError(rawMessage, failedAssistant.errorCode);
				await sessionStore.appendTurnError(sessionId, { code, message, at: new Date().toISOString() }, { surface, ...(input.meta || {}) });
			}
		};

		// pi calls AgentTool.execute(toolCallId, params, signal, onUpdate) — the
		// `signal` it passes is the one that fires when `session.abort()` cancels
		// the run, so tools MUST receive it as-is (not `state.lastInput.signal`,
		// which is only a fallback for callers that never wired a signal at all).
		const adapters = async (input) => {
			const { toAgentTools } = await import("./pi-tools.mjs");
			const activeTools = input?.tools || tools;
			return toAgentTools(activeTools, { signal: state.lastInput?.signal, emit: (event) => state.lastInput?.emit?.(event) });
		};

		// The Workflow surface's ONE quota frame per turn, sent as early as
		// possible (#379, F2 pass 5 finding 4): `sendQuota` fires the moment
		// anything else is about to reach the browser (see `pushFrame` below),
		// using the freshest codex response headers captured so far (from the
		// `codexResponseObserver` seam wired around `agent.prompt` in `start`, or
		// the Agent's `onResponse`) or the null-quota shape when none arrived yet
		// (a non-codex provider, or a codex call that has not resolved headers
		// yet). Each finished provider request (agent-stream.mjs `onAttempt`) is a
		// pure fallback for a turn that somehow reaches full completion without
		// ever calling `pushFrame` — `sendQuota` is idempotent (`quotaSent` guards
		// both paths), so at most one quota frame is ever sent, exactly like before.
		const sendQuota = (queue, input) => {
			if (!state.active || state.active.quotaSent) return;
			state.active.quotaSent = true;
			const headers = state.active.lastResponseHeaders || {};
			const frame = input?.quotaEvent ? input.quotaEvent(headers, state.currentModel) : {
				type: "quota", plan: null,
				primary: { usedPercent: null, windowMinutes: null, resetAt: null },
				credits: { has: null },
			};
			queue.push(frame);
			for (const pending of state.active.pendingFrames) queue.push(pending);
			state.active.pendingFrames = [];
		};
		const emitQuota = (queue, input) => {
			if (input?.surface === "studio") return; // quotaSent is set at turn start; no quota frame ever
			sendQuota(queue, input);
		};

		// Every finished provider request counts, failed attempts included (agent-stream.mjs retries in place).
		// On the Studio surface, a request that reported a prompt also tells the panel its context: that prompt (input + cache read + cache write,
		// this request only, never the turn's sum) against the model's catalog window (src/workflow/agent-context-meter.js).
		const countAttempt = (message) => {
			const usage = state.active?.usage; if (!usage) return;
			usage.requests += 1; const prompt = ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (Number.isFinite(message?.usage?.[key]) ? message.usage[key] : 0), 0);
			for (const key of ["input", "output", "cacheRead", "cacheWrite"]) if (Number.isFinite(message?.usage?.[key])) usage[key] += message.usage[key];
			if (Number.isFinite(message?.usage?.cost?.total)) state.active.cost = (state.active.cost ?? 0) + message.usage.cost.total;
			// held until the agent's message_end (or the turn's end): the stream finishes before the agent has handed on its last text deltas
			if (prompt > 0 && state.lastInput?.surface === "studio") state.active.pendingContext = { type: "context", tokens: prompt, window: state.currentModel?.contextWindow > 0 ? state.currentModel.contextWindow : null };
		};

		// A Codex 401 earns one forced credential refresh per turn and one more try of the same request: completed tools
		// stay completed, and the failed attempt stays out of the transcript and the JSONL.
		const refreshAuth = async (model, message) => {
			if (model?.provider !== "openai-codex" || !state.active || state.active.authRetried
				|| classifyError({ message: message.errorMessage }).code !== "unauthorized") return false;
			state.active.authRetried = true;
			try { await state.registry?.getAuth?.("openai-codex", { minOAuthValidityMs: Number.MAX_SAFE_INTEGER }); } catch { /* the retried call resolves credentials again and surfaces any refresh failure */ }
			return true;
		};

		// Studio only, on the provider view (studioContextDiet, then studio-context-budget.mjs): the stored transcript and the
		// persisted history keep every context, result, script and image whole. The prompt is the leading system message.
		const studioView = async (messages) => {
			if (state.lastInput?.surface !== "studio") return messages;
			const head = messages[0]?.role === "system" ? messages[0] : null;
			const prompt = typeof head?.content === "string" ? head.content : (head?.content ?? []).map((part) => part?.text ?? "").join("");
			const view = budgetStudioRequest(studioContextDiet({ messages: head ? messages.slice(1) : messages, systemPrompt: prompt }));
			return head ? [{ ...head, content: view.systemPrompt }, ...view.messages] : view.messages;
		};

		const ensureAgent = async (input) => {
			const { pi, models: registry } = await ensureModels();
			const activePrompt = input.systemPrompt || (input.surface === "studio" ? await (await import("./studio-motion-reference.mjs")).studioSystemPrompt() : systemPrompt);
			const { resolveModel, resolveEffort } = await import("./providers.mjs");
			const requested = input.model || DEFAULT_MODEL;
			const slash = requested.indexOf("/");
			const provider = slash === -1 ? "openai-codex" : requested.slice(0, slash);
			const modelId = slash === -1 ? requested : requested.slice(slash + 1);
			const direct = registry.getModel(provider, modelId);
			const selected = direct ? { provider, modelId, model: direct } : await resolveModel(requested, { models: registry });
			// Preserve an omitted effort (off for a new session, else the session's
			// level). For explicit none, off reaches pi-ai as no reasoning level,
			// avoiding the provider's clamp of unsupported off back up to low.
			const thinkingLevel = input.effort === undefined ? undefined : await resolveEffort(selected.model, input.effort);
			state.registry = registry;
			if (!state.agent) {
				const restored = sessionStore?.read?.(sessionId);
				state.agent = new pi.Agent({
					initialState: { systemPrompt: activePrompt, model: selected.model, thinkingLevel: thinkingLevel ?? "off", tools: await adapters(input), messages: restored?.history ?? [] },
					streamFn: createRetryingStream({ ai: pi.ai, models: registry, refreshAuth, onAttempt: (message) => { countAttempt(message); emitQuota(state.active?.queue, state.lastInput); } }),
					transformContext: studioView,
					// keeps the output limit this request really sent, for a turn that runs out of it (finish)
					onPayload: (payload, model) => { if (state.active) state.active.maxTokens = payload?.max_tokens ?? payload?.max_completion_tokens ?? payload?.max_output_tokens; return model?.api === "anthropic-messages" ? withAnthropicCacheBreakpoints(payload, model) : undefined; },
					onResponse: (response) => { if (state.active && response?.headers) state.active.lastResponseHeaders = response.headers; },
					sessionId,
					// pi-agent-core's Agent attributes requests to pi (OpenRouter, NVIDIA NIM and OpenCode headers); these are
					// CozyClay's requests, and pi 0.99 sent no attribution, so none is sent.
					identity: { attribution: null },
					toolExecution: "sequential",
					steeringMode: "one-at-a-time",
					maxRetryDelayMs: RETRY_MAX_DELAY_MS,
					...(codexBaseUrl ? { transport: "sse" } : {}),
				});
				state.persisted = restored?.history?.length ?? 0;
				state.unsubscribers.push(state.agent.subscribe(async (event) => { if (event.type === "turn_end" || event.type === "agent_end") await persist(); }));
			}
			state.currentModel = selected.model;
			state.provider = selected.provider;
			state.agent.state.model = selected.model;
			if (thinkingLevel !== undefined) state.agent.state.thinkingLevel = thinkingLevel;
			return { registry, selected };
		};

		const mapEvents = (queue) => {
			const toolStartedAt = new Map();
			const toolStarted = new Set();
			const toolCompleted = new Set();
			// The frame gate must never hold a turn's first visible output waiting
			// on generation to finish (#379, F2 pass 5 finding 4): the ONLY thing it
			// still waits for is the quota frame itself, and only long enough to
			// send it (synchronously, using whatever codex headers are known so far,
			// or the null shape) immediately ahead of this frame — never queued for
			// later. Studio's `quotaSent` is already true at turn start, so this is
			// a no-op there and every frame passes straight through.
			const pushFrame = (frame) => {
				if (state.active && !state.active.quotaSent && frame.type !== "quota") sendQuota(queue, state.lastInput);
				queue.push(frame);
			};
			// The reasoning summary and the tool call being written, for the panel (turn-frames.mjs).
			const reasoning = createReasoningFrames(pushFrame, clock);
			const startTool = (event) => {
				if (toolStarted.has(event.toolCallId)) return;
				toolStarted.add(event.toolCallId);
				toolStartedAt.set(event.toolCallId, clock());
				const activeTools = state.lastInput?.tools || tools;
				const tool = (Array.isArray(activeTools) ? activeTools : []).find((candidate) => candidate.name === event.toolName);
				pushFrame({ type: "tool.start", callId: event.toolCallId, name: event.toolName, label: tool?.label || event.toolName.replaceAll("_", " "), args: summariseCanvasResult(event.args) });
			};
			const endTool = (event) => {
				if (toolCompleted.has(event.toolCallId)) return;
				// A call the run's abort ended (pi-tools.mjs untilAborted) stays unfinished, as under the removed
				// AgentHarness: the route reports it cancelled and the panel shows it stopped with an unknown result.
				if (event.isError && state.agent?.signal?.aborted) { state.active?.abortedCalls.add(event.toolCallId); return; }
				startTool(event);
				toolCompleted.add(event.toolCallId);
				const started = toolStartedAt.get(event.toolCallId) ?? clock();
				const elapsedMs = Math.round(clock() - started);
				const details = event.result?.details;
				if (event.isError) {
					const message = event.result?.content?.find((part) => part.type === "text")?.text || "Tool execution failed.";
					pushFrame({ type: "tool.done", callId: event.toolCallId, ok: false, elapsedMs, error: message });
				} else pushFrame({ type: "tool.done", callId: event.toolCallId, ok: true, elapsedMs, result: details });
			};
			const finish = (event) => {
				if (state.active?.pendingFrames.length) { for (const pending of state.active.pendingFrames) queue.push(pending); state.active.pendingFrames = []; }
				// The run's outcome is its last assistant message: the Agent ends a
				// failed or cancelled request there (stopReason error/aborted).
				const last = event.messages.findLast((message) => message.role === "assistant");
				// #947: a request that hit its output limit before any answer or tool call (reasoning alone can use it up)
				// is a failure, not an empty success; with some text or a tool call it completes as before.
				const outOfTokens = last?.stopReason === "length" && !last.content?.some((part) => part?.type === "toolCall" || (part?.type === "text" && part.text))
					? `The model used all ${state.active?.maxTokens ?? state.currentModel?.maxTokens} output tokens before answering. Lower the reasoning effort or raise the output limit.` : null;
				const status = last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" || outOfTokens ? "error" : "completed";
				// #379 / 16q: an acknowledged Studio Stop whose held tool already settled
				// with a real structured outcome (tool.done above) calls `abort(reason,
				// { quiet: true })` purely to stop the model from being prompted again —
				// it is not a genuine mid-generation cancellation the browser needs to be
				// told about a second time via a synthesized error. Only THIS run's own
				// quiet flag suppresses the error frame; a stop with no active job (no
				// resolvable outcome) never sets it and still surfaces error{aborted}.
				const quiet = status === "aborted" && state.active?.quietAbort;
				if (status !== "completed" && !quiet) {
					const rawMessage = last?.errorMessage || (status === "aborted" ? "The turn was aborted." : "The model or live editor could not complete this turn.");
					const truncated = /ended before a terminal response event/i.test(rawMessage);
					const classified = status === "aborted" ? { code: "aborted", status: undefined } : classifyError({ message: rawMessage, errorCode: last?.errorCode });
					const code = status === "aborted" ? "aborted" : truncated || outOfTokens ? "truncated" : classified.code;
					const detail = sanitizeUpstreamDetail(JSON.stringify({ message: rawMessage }));
					const fallback = code === "aborted" ? "The turn was aborted." : code === "truncated" ? "The model stream ended before a terminal response event." : "The model or live editor could not complete this turn.";
					queue.push({ type: "error", code, message: outOfTokens || detail || fallback, ...(classified.status ? { status: classified.status } : {}) });
				}
				if (state.active.pendingContext) queue.push(state.active.pendingContext); queue.push({ type: "done", usage: { ...state.active.usage }, ...(state.lastInput?.reportCost ? { cost: state.active.cost ?? 0 } : {}) });
				queue.close();
			};
			return state.agent.subscribe((event) => {
				if (event.type === "message_update") {
					reasoning.onMessageEvent(event.assistantMessageEvent);
					if (event.assistantMessageEvent?.type === "text_delta") pushFrame({ type: "text.delta", text: event.assistantMessageEvent.delta });
				} else if (event.type === "tool_execution_start") startTool(event);
				else if (event.type === "tool_execution_end") endTool(event); else if (event.type === "message_end" && state.active?.pendingContext) { pushFrame(state.active.pendingContext); state.active.pendingContext = null; }
				else if (event.type === "agent_end") finish(event);
			});
		};

		const start = async function* (input = {}) {
			if (state.active) {
				yield { type: "error", code: "busy", message: "busy" };
				yield { type: "done" };
				return;
			}
			const queue = new FrameQueue();
			// Studio never sends a quota frame at all (unchanged, #379): mark it sent
			// up front so `pushFrame`'s gate never holds Studio's first frame.
			state.active = { queue, quotaSent: input.surface === "studio", pendingFrames: [], authRetried: false, abortRequested: false, abortedCalls: new Set(), lastResponseHeaders: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 } };
			state.lastInput = input;
			const controller = input.signal ? null : new AbortController();
			const signal = input.signal || controller.signal;
			state.lastInput.signal = signal;
			// The caller's own signal (a Stop, a disconnect, a deadline) aborts the turn exactly like session.abort() does.
			const cancel = () => { if (state.active) state.active.abortRequested = true; state.agent?.abort(); };
			const run = (async () => {
				let removeEventListeners;
				try {
					await ensureAgent(input);
					// Keep the transcript, but replace per-turn tool closures (admission,
					// workspace and cancellation). Auth retry reuses these same bindings.
					// The Tasks switch swaps the whole tool set inside one session; the
					// Agent declares the change to the model in a system message.
					if (input.tools !== undefined) state.agent.state.tools = await adapters(input);
					removeEventListeners = mapEvents(queue);
					// Compose and deliver once; agent-stream.mjs retries provider calls in place without
					// repeating attachments, captures or completed tool executions.
					let prompts;
					if (input.surface === "studio") {
						const studioContext = typeof input.studioContextText === "string" ? input.studioContextText : `<studio-context>\n${input.contextText || ""}\n</studio-context>`;
						const attachments = Array.isArray(input.attachments) ? input.attachments : [];
						if (input.frameObservation) {
							prompts = [studioUserMessage({ ...input, studioContextText: studioContext }), studioObservationMessage(input.frameObservation)];
						} else {
							// Same shape as studioUserMessage/attachmentMessage: one text part per
							// attachment label immediately followed by its image, then the studio
							// context and the user prompt as their OWN text parts (not concatenated
							// into one string) so session-store's transcriptFromHistory restores
							// the prompt text and the attachment names intact (#379, F2 pass 5).
							prompts = [{ role: "user", content: [...studioAttachmentContent(attachments), { type: "text", text: studioContext }, { type: "text", text: input.text || "" }] }];
						}
					} else {
						let text = input.text || "";
						const activeTools = input.tools || tools;
						if (input.attachFrame && activeTools.internal?.capture) {
							const callId = "attached-frame";
							const started = clock();
							queue.push({ type: "tool.start", callId, name: tools.internal.capture.name, label: tools.internal.capture.label || "capture blocking frame", args: {} });
							try {
								const captured = await tools.internal.capture.handler({}, { signal });
								queue.push({ type: "tool.done", callId, ok: true, elapsedMs: Math.round(clock() - started), result: publicDetails(captured) });
								text += `\nAttached frame imageId: ${captured.imageId}`;
							} catch (error) {
								queue.push({ type: "tool.done", callId, ok: false, elapsedMs: Math.round(clock() - started), error: error.message });
								throw error;
							}
						}
						prompts = [...(Array.isArray(input.attachments) ? input.attachments : []).map(attachmentMessage), { role: "user", content: [{ type: "text", text }] }];
					}
					const now = Date.now();
					prompts = prompts.map((message) => ({ timestamp: now, ...message }));
					signal.addEventListener("abort", cancel, { once: true });
					// The seam that lets the browser see codex quota headers before the
					// response body is read (#379, F2 pass 5 finding 4): `codexResponseObserver`
					// (bin/agent/providers.mjs) is an AsyncLocalStorage whose store this ONE
					// runner call sets for the duration of `prompt`; the process-wide fetch
					// patch it installs calls back into it the instant a `/codex/responses`
					// Response exists, correlated back to this turn by async context alone.
					const { codexResponseObserver } = await import("./providers.mjs");
					await codexResponseObserver.run((response) => { if (state.active) state.active.lastResponseHeaders = response.headers; }, () => {
						const prompted = state.agent.prompt(prompts);
						if (signal.aborted) cancel();
						return prompted;
					});
				} catch (error) {
					if (!queue.closed) { queue.push(errorFrame(error, signal.aborted)); queue.push({ type: "done" }); queue.close(); }
				} finally {
					signal.removeEventListener("abort", cancel);
					removeEventListeners?.();
				}
			})();
			try { yield* queue; } finally { await run; state.active = null; }
		};

		const publicSession = {
			start,
			steer: async (text, images = []) => state.agent?.steer({ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }),
			abort: async (reason, { quiet = false } = {}) => {
				// Set synchronously, before the run winds down: any `persist` that runs
				// after this point — for the turn that is active right now — must
				// withhold its assistant message, whether or not the underlying
				// generation happens to finish before pi's cancellation actually takes
				// effect. `quiet` (#379 / 16q) additionally withholds the run's error
				// frame this abort would otherwise cause: the caller already has a real,
				// settled tool outcome to show instead (a Studio Stop that the motion
				// runtime acknowledged) and is only using this abort to stop the model
				// from being prompted again.
				if (state.active) { state.active.abortRequested = true; if (quiet) state.active.quietAbort = true; }
				if (!state.agent?.state.isStreaming) return { ok: false, reason };
				state.agent.abort();
				return { ok: true };
			},
			snapshot: async () => (state.agent ? { streaming: state.agent.state.isStreaming, pendingToolCalls: [...state.agent.state.pendingToolCalls], messages: conversation().length } : null),
			close: async () => { for (const unsubscribe of state.unsubscribers.splice(0)) unsubscribe(); state.agent?.abort(); await state.agent?.waitForIdle(); },
		};
		state.public = publicSession;
		openSessions.set(sessionId, state);
		return publicSession;
	};

	return { openSession, close: async () => { for (const state of openSessions.values()) await state.public.close(); openSessions.clear(); } };
}
