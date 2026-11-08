// SDK messages -> the Studio panel's frames (text.delta, thinking.delta, tool.compose, tool.start,
// tool.done, error, done: the shapes of agent-runner.mjs), and -> pi-shaped history messages for
// the session store (session-store.mjs), which the panel's transcript restore and the bench log
// reader read: assistant { content: [text, thinking, toolCall] } and toolResult { toolCallId }.

const PREFIX = "mcp__cozyclay__";
const FLUSH_MS = 400;
const MIN_BATCH = 16;
const ARG_TEXT_MAX = 200;
const RESULT_TEXT_MAX = 400;
// A model-written track payload can hold 30,000+ numbers; frames and logs keep a summary of it.
const FRAME_ARRAY_MAX = 24;
const HISTORY_ARRAY_MAX = 1000;

const strip = name => (String(name ?? "").startsWith(PREFIX) ? String(name).slice(PREFIX.length) : String(name ?? "tool"));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Long strings clipped, long arrays cut to a head and a count, nesting bounded. */
function compact(value, { text = Infinity, array, depth = 0 }) {
	if (typeof value === "string") return clip(value, text);
	if (!value || typeof value !== "object") return value;
	if (depth > 6) return "[nested]";
	if (Array.isArray(value)) {
		const head = value.slice(0, value.length > array ? 8 : array).map(item => compact(item, { text, array, depth: depth + 1 }));
		return value.length > array ? { length: value.length, head } : head;
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, { text, array, depth: depth + 1 })]));
}

// Claude Code adds "[Image: source: <file it saved>]" beside each image; the image placeholder says enough.
const SAVED_IMAGE = /^\[Image: source: [^\]]*\]$/;
const resultBlocks = content => (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [])
	.filter(block => !(block?.type === "text" && SAVED_IMAGE.test(String(block.text ?? "").trim())));
const resultText = content => resultBlocks(content).filter(block => block?.type === "text").map(block => block.text ?? "").join("\n");

/** [width, height] of a base64 PNG or JPEG image block, or null. */
function imageSize(block) {
	const data = block?.source?.data ?? block?.data;
	if (typeof data !== "string" || !data) return null;
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	for (let i = 2; i + 9 < bytes.length;) {
		if (bytes[i] !== 0xff) { i += 1; continue; }
		const marker = bytes[i + 1];
		if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { i += marker === 0xff ? 1 : 2; continue; }
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
		i += 2 + bytes.readUInt16BE(i + 2);
	}
	return null;
}

const piUsage = usage => {
	const input = usage?.input_tokens ?? 0, output = usage?.output_tokens ?? 0;
	const cacheRead = usage?.cache_read_input_tokens ?? 0, cacheWrite = usage?.cache_creation_input_tokens ?? 0;
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
};
const STOP = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", refusal: "error" };

function resultError(message) {
	const errors = Array.isArray(message.errors) ? message.errors.filter(item => typeof item === "string" && item) : [];
	if (errors.length) return clip(errors.join("; "), 600);
	if (typeof message.result === "string" && message.result) return clip(message.result, 600);
	return `The Claude Code turn ended without an answer (${message.subtype ?? "unknown"}).`;
}

/**
 * historyMessages(sdkMessage, { clock, toolName }) -> pi messages for sessionStore.append.
 * An assistant message gives one assistant message (the SDK sends one per content block; the caller
 * merges those of one response by responseId). A user message gives one toolResult per tool_result,
 * images replaced by "[image WxH]". toolName(id) names a call's tool (createFrameMapper().toolName).
 */
export function historyMessages(sdkMessage, { clock = Date.now, toolName = () => undefined } = {}) {
	const message = sdkMessage?.message;
	if (sdkMessage?.type === "assistant" && Array.isArray(message?.content)) {
		const content = message.content.flatMap(block => {
			if (block?.type === "text") return [{ type: "text", text: block.text ?? "" }];
			if (block?.type === "thinking") return [{ type: "thinking", thinking: block.thinking ?? "" }];
			if (block?.type === "redacted_thinking") return [{ type: "thinking", thinking: "", redacted: true }];
			if (block?.type === "tool_use") return [{ type: "toolCall", id: block.id, name: strip(block.name), arguments: compact(block.input ?? {}, { array: HISTORY_ARRAY_MAX }) }];
			return [];
		});
		return content.length ? [{ role: "assistant", content, api: "anthropic-messages", provider: "v4", model: message.model ?? null, usage: piUsage(message.usage), stopReason: STOP[message.stop_reason] ?? "stop", timestamp: clock(), responseId: message.id ?? null }] : [];
	}
	if (sdkMessage?.type !== "user" || !Array.isArray(message?.content)) return [];
	return message.content.filter(block => block?.type === "tool_result").map(block => {
		const text = resultBlocks(block.content).map(part => {
			if (part?.type === "text") return part.text ?? "";
			if (part?.type !== "image") return "";
			const size = imageSize(part);
			return size ? `[image ${size[0]}x${size[1]}]` : "[image]";
		}).filter(Boolean).join("\n");
		return { role: "toolResult", toolCallId: block.tool_use_id, toolName: toolName(block.tool_use_id) ?? "tool", content: [{ type: "text", text }], isError: Boolean(block.is_error), timestamp: clock() };
	});
}

/**
 * createFrameMapper({ push, clock }) -> { onMessage(sdkMessage), toolName(callId), finish() }
 * push gets Studio frames. Text and thinking come from the partial stream events, or from the
 * assistant message when its response was not streamed. thinking.delta is batched (FLUSH_MS).
 * A non-success result pushes an error frame; finish() pushes the one done frame.
 */
export function createFrameMapper({ push, clock = Date.now }) {
	const calls = new Map(), streamed = new Set();
	let response = null, thinking = "", flushedAt = clock(), usage = null, finished = false;
	const flush = () => {
		if (!thinking) return;
		push({ type: "thinking.delta", text: thinking });
		thinking = "";
		flushedAt = clock();
	};
	const onStream = event => {
		if (event?.type === "message_start") { response = event.message?.id ?? null; return; }
		if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") { flush(); push({ type: "tool.compose", index: event.index, name: strip(event.content_block.name) }); return; }
		if (event?.type !== "content_block_delta") return;
		if (event.delta?.type === "thinking_delta") {
			if (response) streamed.add(response);
			thinking += event.delta.thinking ?? "";
			if (clock() - flushedAt >= FLUSH_MS && thinking.length >= MIN_BATCH) flush();
		} else if (event.delta?.type === "text_delta") {
			if (response) streamed.add(response);
			flush();
			push({ type: "text.delta", text: event.delta.text ?? "" });
		}
	};
	const onAssistant = message => {
		const id = message.message?.id, quiet = streamed.has(id);
		for (const block of message.message?.content ?? []) {
			if (block?.type === "text" && !quiet && block.text) { flush(); push({ type: "text.delta", text: block.text }); }
			else if (block?.type === "thinking" && !quiet && block.thinking) { thinking += block.thinking; flush(); }
			else if (block?.type === "tool_use" && !calls.has(block.id)) {
				flush();
				const name = strip(block.name), args = compact(block.input ?? {}, { text: ARG_TEXT_MAX, array: FRAME_ARRAY_MAX });
				calls.set(block.id, { name, at: clock() });
				push({ type: "tool.start", callId: block.id, name, label: typeof args.op === "string" ? `${name} ${args.op}` : name, args });
			}
		}
	};
	const onUser = message => {
		for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
			if (block?.type !== "tool_result") continue;
			const call = calls.get(block.tool_use_id), text = clip(resultText(block.content), RESULT_TEXT_MAX);
			const images = resultBlocks(block.content).filter(part => part?.type === "image").length;
			flush();
			push({ type: "tool.done", callId: block.tool_use_id, ok: !block.is_error, elapsedMs: call ? Math.max(0, Math.round(clock() - call.at)) : 0, result: { text, images }, ...(block.is_error ? { error: text || "The tool failed." } : {}) });
		}
	};
	return {
		onMessage(message) {
			if (finished || !message || typeof message !== "object") return;
			if (message.type === "stream_event") onStream(message.event);
			else if (message.type === "assistant") onAssistant(message);
			else if (message.type === "user") onUser(message);
			else if (message.type === "result") {
				usage = message.usage ?? usage;
				if (message.subtype !== "success" || message.is_error) { flush(); push({ type: "error", code: "upstream", message: resultError(message) }); }
			}
		},
		toolName: callId => calls.get(callId)?.name,
		finish() {
			if (finished) return;
			finished = true;
			flush();
			push({ type: "done", ...(usage ? { usage: piUsage(usage) } : {}) });
		},
	};
}
