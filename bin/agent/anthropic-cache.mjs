// Anthropic prompt-cache breakpoints, added to the request payload right before it is sent (agent-runner.mjs onPayload).
// Caching is a prefix match that is looked up only at marked blocks: a prefix no request marked is never read again.
// A mark finds an earlier request's entry only by walking back at most 20 positions from itself (thinking blocks are no
// position, a run of tool calls or of tool results is one), so a read point must sit where the earlier entry was written.

const marked = (block) => Boolean(block?.cache_control);
const contentOf = (message) => (Array.isArray(message?.content) ? message.content : []);
// A user message that is not a tool result: a prompt (a Studio turn's message, a steer).
const isPromptMessage = (message) => message?.role === "user" && !(Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
// A Studio prompt: its studio context, live or superseded, opens one of its text blocks.
const isStudioPrompt = (message) => message?.role === "user" && contentOf(message).some((block) => block?.type === "text" && typeof block.text === "string" && block.text.startsWith("<studio-context"));
// The API takes no mark on thinking blocks or on empty text.
const cacheableBlock = (block) => Boolean(block) && !/thinking/.test(block.type ?? "") && !(block.type === "text" && !block.text);
const withoutMark = ({ cache_control: _mark, ...block }) => block;

/** Anthropic prompt-cache breakpoints on the stable prefix (#716): pi-ai's
 * anthropic-messages builder already marks the system blocks, the last tool
 * and the last user block by default; this fills a missing mark on the last
 * system block and the last tool, never past the API's 4 breakpoints, and
 * never on tools for a model whose compat declares them unsupported.
 * It also marks the last block before the newest prompt: a new Studio prompt
 * supersedes the context of the one before it (studioContextDiet), so the
 * prefix the next turn still shares ends right before this prompt. On a
 * Studio conversation it marks the last block before the prompt before it as
 * well: that is where the previous turn wrote the prefix this request still
 * shares, and a previous turn longer than 20 positions leaves it out of the
 * reach of every later mark, so the whole conversation would be written again
 * (14 of 23 new requests in one long session). When the four run short, the
 * marks on the tools and on any system block but the last give way to these
 * two: the last system block's mark covers everything before it. */
export function withAnthropicCacheBreakpoints(payload, model) {
	if (!payload || typeof payload !== "object") return undefined;
	let system = Array.isArray(payload.system) ? payload.system : [];
	let tools = Array.isArray(payload.tools) ? payload.tools : [];
	let messages = Array.isArray(payload.messages) ? payload.messages : [];
	const blocks = [...system, ...tools, ...messages.flatMap(contentOf)];
	let count = blocks.filter(marked).length;
	// the lifetime pi-ai chose (a 1-hour mark must not follow a 5-minute one)
	const cacheControl = blocks.find(marked)?.cache_control ?? { type: "ephemeral" };
	const mark = (block) => ({ ...block, cache_control: cacheControl });
	if (system.length && !marked(system.at(-1)) && count < 4) {
		system = [...system.slice(0, -1), mark(system.at(-1))];
		count += 1;
	}
	// The newest prompt, and on a Studio conversation the newest prompt before the last answer: the one whose turn the
	// previous request belonged to (two prompts may follow each other with no answer between them).
	const studio = messages.some(isStudioPrompt);
	const prompt = messages.findLastIndex(studio ? isStudioPrompt : isPromptMessage);
	const answer = studio ? messages.findLastIndex((message) => message?.role === "assistant") : -1;
	const answered = answer > 0 ? messages.slice(0, answer).findLastIndex(isStudioPrompt) : -1;
	const targets = [...new Set([answered, prompt])].filter((index) => index > 0).map((index) => index - 1).filter((index) => contentOf(messages[index]).some(cacheableBlock) && !contentOf(messages[index]).some(marked));
	const spare = [...tools, ...system.slice(0, -1)].filter(marked).length;
	const giveWay = spare > 0 && marked(system.at(-1)) && count + targets.length > 4;
	if (giveWay) {
		tools = tools.map((tool) => marked(tool) ? withoutMark(tool) : tool);
		system = [...system.slice(0, -1).map((block) => marked(block) ? withoutMark(block) : block), system.at(-1)];
		count -= spare;
	}
	for (const index of targets) {
		if (count >= 4) break;
		const at = messages[index].content.findLastIndex(cacheableBlock);
		messages = messages.map((message, i) => i === index ? { ...message, content: message.content.map((block, j) => j === at ? mark(block) : block) } : message);
		count += 1;
	}
	// pi-ai 1.4 appends a defer_loading placeholder tool; the API rejects cache_control on deferred tools.
	const lastTool = tools.findLastIndex((tool) => !tool?.defer_loading);
	if (lastTool !== -1 && !giveWay && !marked(tools[lastTool]) && model?.compat?.supportsCacheControlOnTools !== false && count < 4) tools = tools.map((tool, index) => index === lastTool ? mark(tool) : tool);
	const next = { ...payload };
	if (system !== payload.system && system.length) next.system = system;
	if (tools !== payload.tools && tools.length) next.tools = tools;
	if (messages !== payload.messages && messages.length) next.messages = messages;
	return next.system === payload.system && next.tools === payload.tools && next.messages === payload.messages ? undefined : next;
}
