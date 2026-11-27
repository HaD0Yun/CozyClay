// ACP session/update → pi assistant-message events for the google-antigravity lane, the
// counterpart of anthropic-subscription-events.mjs. Text and thought chunks stream as pi text /
// thinking blocks; CozyClay tool calls arrive from the MCP bridge (acp-tool-bridge.mjs), whose
// arguments are the ones the agent actually sent, and become pi toolCall blocks.
import { randomUUID } from "node:crypto";

export function createAcpEventMapper({ output, stream }) {
	let open; // the text/thinking block chunks are appending to
	const close = () => {
		if (!open) return;
		const contentIndex = output.content.indexOf(open);
		if (open.type === "text") stream.push({ type: "text_end", contentIndex, content: open.text, partial: output });
		else stream.push({ type: "thinking_end", contentIndex, content: open.thinking, partial: output });
		open = undefined;
	};
	const append = (kind, text) => {
		if (typeof text !== "string" || !text) return;
		if (open?.type !== kind) {
			close();
			open = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", thinkingSignature: "" };
			output.content.push(open);
			stream.push({ type: `${kind}_start`, contentIndex: output.content.length - 1, partial: output });
		}
		const contentIndex = output.content.indexOf(open);
		if (kind === "text") open.text += text;
		else open.thinking += text;
		stream.push({ type: `${kind}_delta`, contentIndex, delta: text, partial: output });
	};
	return {
		/** One `session/update` notification's `update`. */
		update(update) {
			const kind = update?.sessionUpdate;
			if (kind === "agent_message_chunk" && update.content?.type === "text") append("text", update.content.text);
			else if (kind === "agent_thought_chunk" && update.content?.type === "text") append("thinking", update.content.text);
			else if (kind === "usage_update") applyUsage(output, update);
		},
		/** A CozyClay tool call the agent made through the bridge. */
		toolCall({ name, arguments: args }) {
			close();
			const block = { type: "toolCall", id: `toolu_agy_${randomUUID().replaceAll("-", "")}`, name, arguments: args ?? {} };
			output.content.push(block);
			const contentIndex = output.content.length - 1;
			const json = JSON.stringify(block.arguments);
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex, delta: json, partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			output.stopReason = "toolUse";
		},
		finish: close,
		get toolCalls() { return output.content.filter((block) => block.type === "toolCall").length; },
	};
}

/** ACP `session/prompt` stopReason → pi stopReason (a turn we cancelled for a tool handoff is toolUse). */
export function mapAcpStopReason(reason, { toolCalls = 0 } = {}) {
	if (toolCalls > 0) return "toolUse";
	if (reason === "max_tokens" || reason === "max_turn_requests") return "length";
	if (reason === "refusal") return "error";
	if (reason === "cancelled") return "aborted";
	return "stop";
}

function applyUsage(output, update) {
	const usage = update.usage ?? update;
	const number = (value) => (Number.isFinite(value) ? value : undefined);
	const input = number(usage.inputTokens), out = number(usage.outputTokens), cached = number(usage.cachedReadTokens ?? usage.cacheReadTokens);
	if (input !== undefined) output.usage.input = input;
	if (out !== undefined) output.usage.output = out;
	if (cached !== undefined) output.usage.cacheRead = cached;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/** pi prompt blocks (anthropic-subscription-prompt's SDK shape) → ACP ContentBlocks. */
export function toAcpContent(blocks) {
	const content = [];
	for (const block of blocks) {
		if (block.type === "text") {
			const last = content.at(-1);
			if (last?.type === "text") last.text += block.text;
			else content.push({ type: "text", text: block.text });
		} else if (block.type === "image" && block.source?.type === "base64") {
			content.push({ type: "image", mimeType: block.source.media_type, data: block.source.data });
		}
	}
	return content;
}
