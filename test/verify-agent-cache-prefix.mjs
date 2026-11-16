#!/usr/bin/env node
// The prompt-cache prefix of Studio requests, read from the request bodies the real runner sends to a stand-in
// Anthropic endpoint (the cliproxy lane). Caching is a prefix match looked up only at marked blocks, so:
//   - two task sessions of one request send the same tools and system prompt, marked, on every call: a task reads
//     what a sibling wrote, and no call-varying value sits before that mark;
//   - a coordinator session whose every turn supersedes the previous turn's studio context marks the last block
//     before the newest prompt, so turn 3 reads the conversation up to turn 2's prompt from what turn 2 marked
//     (before this, turn 3 shared only the system prompt with turn 2 and wrote the whole conversation again);
//   - every marked prefix of a coordinator request is sent unchanged by every later request that still holds it;
//   - no request carries more than the API's four marks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "cozyclay-cache-prefix-"));
process.env.COZYCLAY_CONFIG_DIR = configDir;
process.on("exit", () => rmSync(configDir, { recursive: true, force: true }));
const [{ createAgentRunner }, providers, { encodeStudioContext }, { contextFixture }] = await Promise.all([
	import("../bin/agent/agent-runner.mjs"),
	import("../bin/agent/providers.mjs"),
	import("../src/studio-agent-context.js"),
	import("./verify-studio-agent-protocol.mjs"),
]);

// A stand-in /v1/messages: a prompt that asks for a tool gets one tool call, everything else a short text answer.
const bodies = [];
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
const reply = (index, block, delta, stop) => sse([
	{ type: "message_start", message: { id: `msg-${index}`, type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: block },
	{ type: "content_block_delta", index: 0, delta },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]);
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (new URL(req.url, "http://local").pathname !== "/v1/messages") { res.writeHead(404); res.end(); return; }
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	bodies.push(body);
	const last = body.messages.at(-1), wantsTool = last.role === "user" && last.content.some(block => block.type === "text" && block.text.includes("[call inspect]"));
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(wantsTool
		? reply(bodies.length, { type: "tool_use", id: `toolu_${bodies.length}`, name: "inspect_studio", input: {} }, { type: "input_json_delta", partial_json: "{\"scope\":\"selection\"}" }, "tool_use")
		: reply(bodies.length, { type: "text", text: "" }, { type: "text_delta", text: `answer ${bodies.length}` }, "end_turn"));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const models = await providers.createModels({ auth: { readStored: () => undefined }, keys: { readKeys: () => ({}) }, env: { CLIPROXY_API_KEY: "cache-prefix-key", CLIPROXY_BASE_URL: base } });
assert.ok(models.getModel("cliproxy", "claude-opus-5-5"), "the cliproxy lane serves claude-opus-5-5 on anthropic-messages");

const tools = [{ name: "inspect_studio", description: "Read the scene.", parameters: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: false }, handler: async ({ scope }) => ({ ok: true, scope, revision: { scene: 41 } }) }];
const context = (scene, extra = {}) => encodeStudioContext({ ...contextFixture(), revision: { scene, physics: 9, view: 18 }, ...extra });
const runner = createAgentRunner({ models, env: { COZYCLAY_MOTION_ENGINE: "lowvis" } });
async function turn(sessionId, { text, contextText, systemPrompt }) {
	const session = await runner.openSession(sessionId, { surface: "studio" });
	const from = bodies.length;
	for await (const frame of session.start({ surface: "studio", model: "cliproxy/claude-opus-5-5", effort: "medium", text, contextText, tools, ...(systemPrompt ? { systemPrompt } : {}) })) {
		assert.notEqual(frame.type, "error", `${sessionId}: ${JSON.stringify(frame)}`);
	}
	return bodies.slice(from);
}

// The request as the cache sees it: tools, then system blocks, then message blocks, each with its mark.
const strip = ({ cache_control: _mark, ...block }) => block;
function units(body) {
	const out = [];
	for (const tool of body.tools ?? []) out.push({ key: JSON.stringify(["tool", strip(tool)]), mark: Boolean(tool.cache_control), message: -1, system: false });
	for (const block of body.system ?? []) out.push({ key: JSON.stringify(["system", strip(block)]), mark: Boolean(block.cache_control), message: -1, system: true });
	body.messages.forEach((message, i) => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content)
		.forEach((block, j) => out.push({ key: JSON.stringify(["message", i, message.role, j, strip(block)]), mark: Boolean(block.cache_control), message: i, system: false })));
	return out;
}
const bytes = (list, end) => list.slice(0, end).map(unit => unit.key).join("\n");
const marks = body => { const list = units(body); return list.flatMap((unit, i) => unit.mark ? [{ end: i + 1, message: unit.message, system: unit.system, bytes: bytes(list, i + 1) }] : []); };
const startsWith = (body, prefix) => bytes(units(body), prefix.end) === prefix.bytes;
const promptIndex = body => body.messages.findLastIndex(message => message.role === "user" && !message.content.some(block => block.type === "tool_result"));

// --- two task sessions of one request -------------------------------------------------------------------------------
const header = (id, scope) => `<task id="${id}">\nYou are one of several tasks working on this scene at once. Your scope: ${scope}.\n</task>\n[call inspect] Do the ${scope} part.`;
const taskA = await turn("task-a", { text: header("a", "stage"), contextText: context(41) });
const taskB = await turn("task-b", { text: header("b", "object:bench"), contextText: context(42) });
assert.equal(taskA.length, 2, "task a: a tool call, then its answer"); assert.equal(taskB.length, 2, "task b: a tool call, then its answer");
const systemMark = body => marks(body).find(mark => mark.system);
assert.ok(systemMark(taskA[0]), "a task request marks its system prompt");
for (const body of [...taskA, ...taskB]) {
	assert.ok(marks(body).length <= 4, "no request carries more than four marks");
	assert.equal(systemMark(body).bytes, systemMark(taskA[0]).bytes, "every call of both tasks sends the same tools and system prompt, marked: one task reads what the other wrote");
}
console.log(`PASS task sessions: both tasks send the same marked tools + system prefix (${systemMark(taskA[0]).bytes.length} bytes) on every call; what differs (context, task header) comes after it`);

// --- a coordinator session over three turns, each turn's context superseding the one before ------------------------
const coordinator = "You are the coordinator. Hand the work to tasks.";
const board = n => `\n<task-board>${JSON.stringify(Array.from({ length: n }, (_, i) => ({ taskId: `t${i}`, status: i ? "running" : "done" })))}</task-board>`;
const turns = [];
turns.push(await turn("coordinator", { systemPrompt: coordinator, text: "[call inspect] A man sits on a bench, then stands.", contextText: context(41) + board(0) }));
turns.push(await turn("coordinator", { systemPrompt: coordinator, text: "(Task events arrived.) [call inspect]", contextText: context(45) + board(2) }));
turns.push(await turn("coordinator", { systemPrompt: coordinator, text: "(Task events arrived.)", contextText: context(52) + board(3) }));
turns.push(await turn("coordinator", { systemPrompt: coordinator, text: "(Task events arrived.)", contextText: context(60) + board(4) }));
await runner.close();
server.close();
const all = turns.flat();
for (const body of all) assert.ok(marks(body).length <= 4, "no request carries more than four marks");
// A request reads an entry an earlier request wrote at one of its marks when it sends that marked prefix unchanged and
// one of its own marks lies at most 20 blocks after it (the API looks back that far from each mark).
const readable = (body, earlier) => earlier.flatMap(marks).filter(old => startsWith(body, old) && marks(body).some(mark => mark.end >= old.end && mark.end - old.end <= 20));
for (let k = 2; k < turns.length; k += 1) {
	const first = turns[k][0], before = promptIndex(turns[k - 1].at(-1)) - 1;
	const reach = Math.max(-1, ...readable(first, turns[k - 1]).map(old => old.message));
	assert.ok(reach >= before, `turn ${k + 1}: it reads from turn ${k}'s entries up to message ${reach}, not to the end of turn ${k - 1} (message ${before})`);
}
// every marked prefix that ends before a request's newest prompt is sent unchanged by all later requests
all.forEach((body, i) => {
	for (const mark of marks(body).filter(mark => mark.message < promptIndex(body))) {
		for (const later of all.slice(i + 1)) assert.ok(startsWith(later, mark), `request ${i + 1}: its marked prefix (to message ${mark.message}) is sent unchanged later`);
	}
});
console.log(`PASS coordinator: from turn 3 on, each turn reads the conversation up to the previous prompt from a mark the previous turn sent; no earlier marked prefix changes in ${all.length} requests`);
