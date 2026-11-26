// What the motion writer's model calls send of the conversation (harness.mjs transformContext and onPayload).
// Only the latest call's images stay in the context: older tool results are sent as their text and a note. On the
// anthropic-messages wire no block a request sent changes in a later one, so each request reads from the prompt cache all
// of the conversation before its newest result, wherever the cache marks fall (a mark the provider adds on the last
// message included): a result's pictures follow its text, and the note that they were dropped later takes their place.

const DROPPED = "[the sheet images of this call are no longer shown: only the latest call's images are kept]";

/** Older tool results as their text: only the latest result that has images keeps them. */
export function latestImagesOnly(messages) {
	const hasImage = m => m.role === "toolResult" && Array.isArray(m.content) && m.content.some(c => c.type === "image");
	const last = messages.findLastIndex(hasImage);
	return messages.map((m, i) => i !== last && hasImage(m) ? { ...m, content: [...m.content.filter(c => c.type !== "image"), { type: "text", text: DROPPED }] } : m);
}

/** One tool_result block of the wire with its pictures (or the note that replaced them) taken out: [block, moved]. */
function split(block, pictured) {
	if (block.type !== "tool_result") return [block, []];
	if (Array.isArray(block.content) && block.content.some(c => c.type === "image")) pictured.add(block.tool_use_id);
	if (!pictured.has(block.tool_use_id)) return [block, []]; // a result that never went out with pictures stays as it was sent
	// pi-ai sends a result without pictures as one text (its texts joined by a line break), with pictures as blocks: the
	// result's text goes as that one text either way, so it is the same bytes before and after the drop
	if (typeof block.content === "string") {
		const tail = `\n${DROPPED}`;
		return block.content.endsWith(tail) ? [{ ...block, content: block.content.slice(0, -tail.length) }, [{ type: "text", text: DROPPED }]] : [block, []];
	}
	const texts = Array.isArray(block.content) ? block.content.filter(c => c.type === "text" && c.text !== DROPPED) : [];
	return texts.length ? [{ ...block, content: texts.map(c => c.text).join("\n") }, block.content.filter(c => !texts.includes(c))] : [block, []];
}

/**
 * The anthropic-messages request (pi-ai's payload) laid out so that no block a request sent changes in a later one. A
 * tool result sent with pictures sends them after the tool results of its message, its text staying the tool_result;
 * once they are dropped, the note that says so takes their place there. pictured: the ids of the tool calls whose results
 * went out with pictures, kept for the run. Two cache marks, with the lifetime of pi-ai's own marks, on the last block
 * before such pictures or note in each of the last two user messages (within the API's four marks, the newest first),
 * and none past pictures a later request drops (dropping: keepImages "latest"), so the next request reads all that went
 * before its newest result.
 */
export function wireForCache(payload, pictured, dropping) {
	const messages = (payload.messages ?? []).map(m => ({ ...m, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(({ cache_control: _drop, ...block }) => block) }));
	const end = new Map(); // a user message -> the number of its blocks before the ones moved after its tool results
	for (const m of messages.filter(m => m.role === "user")) {
		const parts = m.content.map(block => split(block, pictured)), moved = parts.flatMap(([, out]) => out);
		m.content = [...parts.map(([block]) => block), ...moved];
		end.set(m, m.content.length - moved.length);
	}
	const fixed = [...(Array.isArray(payload.system) ? payload.system : []), ...(payload.tools ?? [])].filter(b => b?.cache_control);
	const lifetime = fixed[0]?.cache_control ?? { type: "ephemeral" };
	let room = 4 - fixed.length;
	// the latest pictures may stand in an older message than the newest, when the calls after them made none
	const users = messages.filter(m => m.role === "user"), first = dropping ? users.findIndex(m => m.content.slice(end.get(m)).some(c => c.type === "image")) : -1;
	for (const m of users.slice(0, first < 0 ? users.length : first + 1).slice(-2).reverse()) {
		const at = end.get(m) - 1, block = m.content[at];
		if (room <= 0 || !block || /thinking/.test(block.type)) continue;
		m.content[at] = { ...block, cache_control: lifetime };
		room--;
	}
	return { ...payload, messages };
}
