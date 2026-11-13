// The anthropic-subscription lane is one-shot: the SDK query gets no live conversation, so pi's
// message history is replayed into a single user message as labelled text, followed by an
// instruction to answer only the final user message. Tool calls stay host-side — a historical
// tool call or result is described, never re-executed by Claude Code.
const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function appendEntry(blocks, entry) {
	if (typeof entry === "string") {
		if (entry.length > 0) blocks.push({ type: "text", text: entry });
		return entry.trim().length > 0;
	}
	if (!isRecord(entry)) {
		blocks.push({ type: "text", text: "[unsupported content block omitted]" });
		return false;
	}
	if (entry.type === "text" && typeof entry.text === "string") {
		blocks.push({ type: "text", text: entry.text });
		return entry.text.trim().length > 0;
	}
	if (entry.type === "image" && typeof entry.data === "string" && IMAGE_MEDIA_TYPES.includes(entry.mimeType)) {
		blocks.push({ type: "image", source: { type: "base64", media_type: entry.mimeType, data: entry.data } });
		return true;
	}
	if (entry.type === "image") {
		blocks.push({ type: "text", text: `[image block omitted: unsupported media type ${entry.mimeType ?? "unknown"}]` });
		return false;
	}
	blocks.push({ type: "text", text: `[unsupported content block omitted: ${entry.type}]` });
	return false;
}

/** pi content (string or block array) → SDK content blocks appended to `blocks`; true when anything visible landed. */
function appendSdkContentBlocks(blocks, content) {
	if (typeof content === "string") return appendEntry(blocks, content);
	if (!Array.isArray(content)) return false;
	let visible = false;
	for (const entry of content) visible = appendEntry(blocks, entry) || visible;
	return visible;
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") return `Historical tool call (non-executable): ${block.name} args=${JSON.stringify(block.arguments)}`;
			return `[${block.type}]`;
		})
		.filter(Boolean)
		.join("\n");
}

const CONVERSATION_HISTORY_CLOSER = "\n</conversation_history>";
export const RESPOND_TO_USER_INSTRUCTION = 'The above is the conversation history so far, provided as context. Respond as the assistant to the user message below only. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.';
/** A replay that ends with tool results (a fallback mid-turn) has no new user message; the last entries are the model's own tool outputs, not user input. */
export const CONTINUE_TURN_INSTRUCTION = 'The above is the conversation history so far, provided as context. There is no new user message: the last entries are results of tool calls you made in your current turn, not anything the user sent. Continue that turn as the assistant. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.';

/**
 * pi's context.messages → one SDK user message of content blocks. History is labelled text with a
 * closing tag, then the instruction, then the final user message's own blocks (images included).
 */
export function buildPromptBlocks(context) {
	const blocks = [];
	const pushText = (text) => blocks.push({ type: "text", text });
	// the system messages carry the prompt and tools, which reach the SDK through its own options
	const messages = (context.messages ?? []).filter((message) => message.role !== "system");
	const finalMessage = messages.at(-1);
	const finalUserMessage = finalMessage?.role === "user" ? finalMessage : undefined;
	const history = finalUserMessage ? messages.slice(0, -1) : messages;
	const continuesTurn = !finalUserMessage && history.at(-1)?.role === "toolResult";
	if (history.length > 0) {
		pushText("<conversation_history>\n");
		let hasPreviousTurn = false;
		const pushPrefix = (label) => {
			pushText(`${hasPreviousTurn ? "\n\n" : ""}${label}\n`);
			hasPreviousTurn = true;
		};
		for (const message of history) {
			if (message.role === "user") {
				pushPrefix("USER:");
				if (!appendSdkContentBlocks(blocks, message.content)) pushText("(no visible content)");
				continue;
			}
			if (message.role === "assistant") {
				pushPrefix("ASSISTANT:");
				const text = contentToText(message.content);
				if (text.length > 0) pushText(text);
				continue;
			}
			if (message.role === "toolResult") {
				pushPrefix(`TOOL RESULT (historical ${message.toolName}, id=${message.toolCallId}):`);
				if (!appendSdkContentBlocks(blocks, message.content)) pushText("(no visible content)");
			}
		}
		pushText(CONVERSATION_HISTORY_CLOSER);
	}
	pushText(continuesTurn ? CONTINUE_TURN_INSTRUCTION : RESPOND_TO_USER_INSTRUCTION);
	if (finalUserMessage && !appendSdkContentBlocks(blocks, finalUserMessage.content)) pushText("(no visible content)");
	return blocks;
}

/** The SDK's stream-json prompt shape: one user message, delivered as an async iterable. */
export function buildPromptStream(promptBlocks) {
	return (async function* () {
		yield {
			type: "user",
			message: { role: "user", content: promptBlocks },
			parent_tool_use_id: null,
			session_id: "prompt",
		};
	})();
}
