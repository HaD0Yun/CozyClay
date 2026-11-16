// Anthropic prompt-cache breakpoints, added to the request payload right before it is sent (agent-runner.mjs onPayload).
// Caching is a prefix match that is looked up only at marked blocks: a prefix no request marked is never read again.

const marked = (block) => Boolean(block?.cache_control);
// A user message that is not a tool result: a prompt (a Studio turn's message, a steer).
const isPromptMessage = (message) => message?.role === "user" && !(Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
// The API takes no mark on thinking blocks or on empty text.
const cacheableBlock = (block) => Boolean(block) && !/thinking/.test(block.type ?? "") && !(block.type === "text" && !block.text);

/** Anthropic prompt-cache breakpoints on the stable prefix (#716): pi-ai's
 * anthropic-messages builder already marks the system blocks, the last tool
 * and the last user block by default; this only fills a missing mark on the
 * last system block and the last tool, never past the API's 4 breakpoints,
 * and never on tools for a model whose compat declares them unsupported.
 * It also marks the last block before the newest prompt: a new Studio prompt
 * supersedes the context of the one before it (studioContextDiet), so the
 * prefix the next turn still shares ends right before this prompt. Without
 * that mark the next turn finds no cached entry past the system prompt and
 * writes the whole conversation again. */
export function withAnthropicCacheBreakpoints(payload, model) {
	if (!payload || typeof payload !== "object") return undefined;
	const system = Array.isArray(payload.system) ? payload.system : [];
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const messageBlocks = (Array.isArray(payload.messages) ? payload.messages : []).flatMap((message) => Array.isArray(message?.content) ? message.content : []);
	let count = [...system, ...tools, ...messageBlocks].filter(marked).length;
	// the lifetime pi-ai chose (a 1-hour mark must not follow a 5-minute one)
	const cacheControl = [...system, ...tools, ...messageBlocks].find(marked)?.cache_control ?? { type: "ephemeral" };
	let next = payload;
	if (system.length && !marked(system.at(-1)) && count < 4) {
		next = { ...next, system: [...system.slice(0, -1), { ...system.at(-1), cache_control: cacheControl }] };
		count += 1;
	}
	// pi-ai 1.4 appends a defer_loading placeholder tool; the API rejects cache_control on deferred tools.
	const lastTool = tools.findLastIndex((tool) => !tool?.defer_loading);
	if (lastTool !== -1 && !marked(tools[lastTool]) && model?.compat?.supportsCacheControlOnTools !== false && count < 4) {
		next = { ...next, tools: tools.map((tool, index) => index === lastTool ? { ...tool, cache_control: cacheControl } : tool) };
		count += 1;
	}
	const messages = Array.isArray(next.messages) ? next.messages : [];
	const prompt = messages.findLastIndex(isPromptMessage);
	const before = prompt > 0 && Array.isArray(messages[prompt - 1]?.content) ? messages[prompt - 1] : null;
	const target = before ? before.content.findLastIndex(cacheableBlock) : -1;
	if (target !== -1 && !before.content.some(marked) && count < 4) {
		const content = before.content.map((block, index) => index === target ? { ...block, cache_control: cacheControl } : block);
		next = { ...next, messages: messages.map((message, index) => index === prompt - 1 ? { ...message, content } : message) };
	}
	return next === payload ? undefined : next;
}
