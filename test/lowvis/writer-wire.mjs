// A provider in the CLIProxyAPI's place for the motion writer's tests: its model list, and a scripted writer whose
// calls are given as a list of tool arguments (each call thinks, then calls motion once; after the last one it writes
// a report). It records every request body. The tests read the requests the harness sent, block by block.
import { once } from "node:events";
import { createServer } from "node:http";

const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); };

/** calls: [toolArguments | [toolArguments, ...] (several calls in one message), ...]; report: the closing text, or a function (step) -> text.
 *  listFails: the first n requests for the model list answer 500; lists.asked counts those requests. */
export async function scriptedProvider({ calls, report = "Made.\nMissing: none", served = ["claude-opus-5-5"], listFails = 0 }) {
	const requests = [], lists = { asked: 0 };
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const path = new URL(req.url, "http://local").pathname;
		if (path === "/v1/models") {
			if (++lists.asked <= listFails) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "down" } })); return; }
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: served.map(id => ({ id, owned_by: "anthropic" })) })); return;
		}
		const body = Buffer.concat(chunks).toString("utf8"), parsed = JSON.parse(body), step = parsed.messages.filter(m => m.role === "assistant").length;
		requests.push(body);
		const blocks = [{ type: "thinking", thinking: `step ${step}: read the numbers and the pictures.`, signature: `sig-${step}` }];
		if (step < calls.length) (Array.isArray(calls[step]) ? calls[step] : [calls[step]]).forEach((input, k) => blocks.push({ type: "tool_use", id: `w-${step + 1}${k ? `-${k}` : ""}`, name: "motion", input }));
		else blocks.push({ type: "text", text: typeof report === "function" ? report(step) : report });
		const events = [{ type: "message_start", message: { id: `msg-${step}`, type: "message", role: "assistant", content: [], model: parsed.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
		blocks.forEach((block, index) => {
			if (block.type === "thinking") events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
			else if (block.type === "text") events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
			else events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
			events.push({ type: "content_block_stop", index });
		});
		events.push({ type: "message_delta", delta: { stop_reason: step < calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
		sse(res, events);
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	return { server, requests, lists, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** The blocks of a request in the order the API reads its prefix (tools, system, then each message's content), as JSON text without the cache mark, and the positions of the marked ones. */
export function wireBlocks(body) {
	const parsed = typeof body === "string" ? JSON.parse(body) : body;
	const out = [], marks = [];
	const push = (where, block) => { const { cache_control: mark, ...rest } = block; if (mark) marks.push(out.length); out.push(`${where}:${JSON.stringify(rest)}`); };
	for (const tool of parsed.tools ?? []) push("tool", tool);
	for (const block of Array.isArray(parsed.system) ? parsed.system : parsed.system ? [{ type: "text", text: parsed.system }] : []) push("system", block);
	parsed.messages.forEach((message, i) => { for (const block of typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content) push(`${i}.${message.role}`, block); });
	return { blocks: out, marks };
}
