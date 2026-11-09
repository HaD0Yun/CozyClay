#!/usr/bin/env node
// The v4 engine against the REAL Claude Code binary (through the Agent SDK) and a fake Anthropic upstream
// on 127.0.0.1 (design appendix B, probe P2). Two Studio turns run through runV4StudioTurn with fake hub,
// tools and credential: turn 1 calls mcp__cozyclay__js (whose result carries a 1200x675 PNG) and then
// answers; turn 2 resumes the SDK session. SKIP (exit 0) when no Claude Code binary resolves.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { resolveClaudeCodeExecutable } from "../../bin/agent/claude-code-executable.mjs";
import { createSessionStore } from "../../bin/agent/session-store.mjs";
import { V4_MODEL_KEY } from "../../bin/agent/v4/models.mjs";
import { V4_SYSTEM_PROMPT } from "../../bin/agent/v4/prompt.mjs";
import { runV4StudioTurn } from "../../bin/agent/v4/studio-turn.mjs";

// ---- fixtures (the same block is in verify-v4-engine.mjs and verify-v4-engine-wire.mjs) ----
// The five tool schemas of design section 3, and fake V4Tools whose descriptions sit at their caps.
const SCHEMAS = {
	js: { type: "object", additionalProperties: false, required: ["code"], properties: {
		code: { type: "string", description: "Body of an async function. await works. Top-level declarations that start a line persist to later calls." },
		timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 } } },
	track: { type: "object", additionalProperties: false, required: ["op"], properties: {
		op: { enum: ["set", "patch", "commit", "info", "get", "clear"] }, frames: { type: "integer", minimum: 1, maximum: 2400 },
		rot: { type: "array", items: { type: "number" } }, hips: { type: "array", items: { type: "number" } },
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 }, bones: { type: "array", items: { type: "string" } },
		objects: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["pos", "quat"],
			properties: { pos: { type: "array", items: { type: "number" } }, quat: { type: "array", items: { type: "number" } } } } },
		label: { type: "string", maxLength: 80 } } },
	measure: { type: "object", additionalProperties: false, required: [], properties: {
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 }, step: { type: "integer", minimum: 1, maximum: 24 },
		what: { type: "array", items: { enum: ["penetration", "contacts", "balance", "limits", "speed"] } },
		parts: { type: "array", items: { type: "string" } }, against: { type: "array", items: { type: "string" } }, skin: { type: "boolean" },
		tolerance: { type: "number", minimum: 0, maximum: 0.1 }, maxRows: { type: "integer", minimum: 1, maximum: 200 } } },
	render: { type: "object", additionalProperties: false, required: [], properties: {
		views: { type: "array", items: { anyOf: [{ enum: ["judge", "side", "front", "track", "hands", "feet"] },
			{ type: "object", additionalProperties: false, required: ["eye", "target"], properties: { name: { type: "string" }, eye: { type: "array", items: { type: "number" } },
				target: { type: "array", items: { type: "number" } }, fovDeg: { type: "number" }, up: { type: "array", items: { type: "number" } } } }] } },
		frames: { anyOf: [{ type: "array", items: { type: "integer", minimum: 0 } }, { enum: ["events", "even"] }] },
		count: { type: "integer", minimum: 1, maximum: 24 }, from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 },
		tile: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "integer", minimum: 64, maximum: 1280 }, height: { type: "integer", minimum: 64, maximum: 1280 } } },
		longEdge: { type: "integer", minimum: 256, maximum: 2576 }, labels: { type: "boolean" },
		overlay: { type: "object", additionalProperties: false, properties: { com: { type: "boolean" }, contacts: { type: "boolean" }, trail: { type: "boolean" } } } } },
	qa: { type: "object", additionalProperties: false, required: [], properties: {
		from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 }, kinds: { type: "array", items: { type: "string" } },
		maxGroups: { type: "integer", minimum: 1, maximum: 50 }, hands: { type: "boolean" } } },
};
const CAPS = { js: 9000, track: 2000, measure: 2000, render: 2000, qa: 2000 };
const capped = (name, size) => `${name}: ${"Plain English words about what this tool does and how to call it. ".repeat(Math.ceil(size / 60))}`.slice(0, size);
/** Five fake V4Tools; run(args, call) answers { data, text, images? } from `answers[name]` or a plain text. */
function fakeTools(answers = {}) {
	return Object.keys(SCHEMAS).map(name => ({ name, description: capped(name, CAPS[name]), inputSchema: SCHEMAS[name],
		run: async (args, call) => (answers[name] ? answers[name](args, call) : { data: { name }, text: `${name} ok` }) }));
}
/** A valid w x h RGB PNG (noise), base64 without the data: prefix. */
function pngBase64(width, height) {
	const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type, data) => { const head = Buffer.alloc(4), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]); };
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let i = 0; i < rows.length; i += 1) rows[i] = (i * 2654435761 >>> 24) & 255;
	for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
	const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
// The bench barbell set (design 3.2 fixture records).
const RECORD = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
const BARBELL = [
	{ ...RECORD, id: "barbell", name: "Barbell", renderer: "empty", x: 0, y: 0.225, z: 0.35, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, footprint: { width: 0, depth: 0 }, height: 0, supportY: 0 },
	{ ...RECORD, id: "barbell-bar", name: "Barbell bar", renderer: "cylinder", x: -1, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.028, scaleY: 2, scaleZ: 0.028, parent: "barbell" },
	{ ...RECORD, id: "barbell-plate-l", name: "Barbell plate left", renderer: "cylinder", x: 0.77, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
	{ ...RECORD, id: "barbell-plate-r", name: "Barbell plate right", renderer: "cylinder", x: -0.83, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
];
// ---- end of fixtures ----

const BUDGET_MS = 90_000;
const BODY_MAX = 48_000;
const TOOL_NAMES = ["js", "track", "measure", "render", "qa"].map(name => `mcp__cozyclay__${name}`);
let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` -- ${detail}`}`);
	if (!condition) failures += 1;
}

try { resolveClaudeCodeExecutable({ env: process.env }); } catch (error) {
	console.log(`SKIP v4 engine wire: no Claude Code binary (${String(error.message).slice(0, 160)})`);
	process.exit(0);
}
const started = Date.now();
const watchdog = setTimeout(() => { console.log(`FAIL v4 engine wire: over ${BUDGET_MS / 1000} s`); process.exit(1); }, BUDGET_MS);
watchdog.unref();

// The fake upstream: /v1/messages answers Anthropic SSE. The first request that ends on a user text gets a
// tool_use of mcp__cozyclay__js; every other one gets a short text.
const requests = [];
let toolUses = 0, nextId = 0;
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); res.end(); };
const reply = blocks => {
	const message = { id: `msg_${nextId += 1}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } };
	const events = [{ type: "message_start", message }];
	blocks.forEach((block, index) => {
		if (block.type === "text") events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		else events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		events.push({ type: "content_block_stop", index });
	});
	events.push({ type: "message_delta", delta: { stop_reason: blocks.some(block => block.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } }, { type: "message_stop" });
	return events;
};
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", chunk => { raw += chunk; });
	req.on("end", () => {
		let body;
		try { body = JSON.parse(raw); } catch { body = null; }
		requests.push({ url: req.url, method: req.method, ua: req.headers["user-agent"] ?? "", auth: req.headers.authorization ?? "", apiKey: req.headers["x-api-key"] ?? "", bytes: Buffer.byteLength(raw), body });
		if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
		// Claude Code puts role "system" reminders after the user turn, so look at the last user message.
		const last = Array.isArray(body?.messages) ? body.messages.findLast(message => message?.role === "user") : null;
		const endsOnResult = Array.isArray(last?.content) && last.content.some(part => part?.type === "tool_result");
		if (!endsOnResult && body?.model === "claude-opus-5-5" && toolUses === 0) {
			toolUses += 1;
			sse(res, reply([{ type: "text", text: "Plan: build the squat in js." }, { type: "tool_use", id: "toolu_wire_1", name: "mcp__cozyclay__js", input: { code: "// squat\nreturn 1" } }]));
		} else sse(res, reply([{ type: "text", text: endsOnResult ? "Built a squat." : "Turn two done." }]));
	});
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const tmp = mkdtempSync(join(tmpdir(), "v4-wire-"));
const store = createSessionStore(join(tmp, "agent-sessions"));
const image = pngBase64(1200, 675);
const jsCalls = [];
const models = { getAuth: async id => (id === "cliproxy" ? { auth: { apiKey: "fake-proxy-key" } } : undefined), getModels: id => (id === "cliproxy" ? [{ id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: base }] : []) };
const describe = { activeCharacterId: "char-a", characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 }], objects: BARBELL };
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: mkdtempSync(join(tmpdir(), "v4-wire-home-")), ANTHROPIC_API_KEY: "sk-ant-must-not-be-used" };
const sessionId = randomUUID();

async function studioTurn(text) {
	const frames = [], controller = new AbortController(), session = { controller, activeTurnId: "t", host: null };
	const value = { surface: "studio", sessionId, turnId: randomUUID(), text, effort: "high", model: V4_MODEL_KEY, context: { host: { workspaceHandle: "ws-1", workspaceId: "w1", documentEpoch: 1, sceneId: "s1", sceneEpoch: 1 }, scene: { name: "Gym", frameCount: 120 } } };
	await runV4StudioTurn({ value, session, send: frame => frames.push(frame), close: () => {}, res: { writableEnded: false, end() { this.writableEnded = true; } }, controller,
		studioTools: { internal: { invoke: async () => ({ ok: true }) } }, hub: { command: async () => describe }, sessionStore: store, models, env, studioIdentity: host => host, admission: { host: value.context.host },
		loadToolSet: async () => ({ tools: fakeTools({ js: async (args, call) => { jsCalls.push({ args, from: call.from }); return { data: { ok: true }, text: "ok, 3 ms. kept: (none)", images: [{ data: image, mimeType: "image/png", label: "judge f0-f12" }] }; } }), close: () => {} }) });
	return { frames, session };
}

try {
	const one = await studioTurn("Do one slow squat.");
	const turn1Ms = Date.now() - started;
	const two = await studioTurn("Hold the bottom a little longer.");
	const main = requests.filter(entry => entry.body?.model === "claude-opus-5-5" && Array.isArray(entry.body?.messages));
	const [first, second, third] = main;
	// V4_WIRE_DUMP=<file> keeps the three request bodies for a look.
	if (process.env.V4_WIRE_DUMP) writeFileSync(process.env.V4_WIRE_DUMP, JSON.stringify(main.map(entry => entry.body), null, 1));
	console.log(`requests: ${requests.length} (${requests.map(entry => `${entry.method} ${entry.url} ${entry.bytes} B`).join("; ")})`);
	console.log(`first request: ${first?.bytes} bytes, tools ${(first?.body?.tools ?? []).map(tool => tool.name).join(", ")}, ua ${first?.ua}`);
	expect("wire: three model requests (tool call, its result, turn two)", main.length === 3, String(main.length));
	expect("wire: model claude-opus-5-5, effort high, adaptive thinking", first?.body?.model === "claude-opus-5-5" && first.body.output_config?.effort === "high" && first.body.thinking?.type === "adaptive", JSON.stringify([first?.body?.output_config, first?.body?.thinking]));
	const system = Array.isArray(first?.body?.system) ? first.body.system : [];
	expect("wire: the v4 system prompt is a top-level system block", system.some(block => typeof block?.text === "string" && block.text.includes(V4_SYSTEM_PROMPT)) && !JSON.stringify(first?.body?.messages ?? []).includes("You animate one character in CozyClay"), JSON.stringify(system.map(block => String(block?.text ?? "").slice(0, 60))));
	const names = (first?.body?.tools ?? []).map(tool => tool.name);
	expect("wire: tools are the five mcp__cozyclay__ tools (plus DeferredToolPlaceholder at most), no built-in tool", names.filter(name => name !== "DeferredToolPlaceholder").sort().join() === TOOL_NAMES.slice().sort().join() && names.length <= 6, names.join(","));
	expect(`wire: first request body <= ${BODY_MAX} bytes`, first?.bytes <= BODY_MAX, String(first?.bytes));
	expect("wire: native Claude Code user agent with the cozyclay-v4 client-app tag", /^claude-cli\//.test(first?.ua ?? "") && /client-app\/cozyclay-v4\//.test(first?.ua ?? ""), first?.ua);
	expect("wire: the proxy key as the bearer token, never the parent's Anthropic key", main.every(entry => entry.auth === "Bearer fake-proxy-key" && !entry.apiKey) && !requests.some(entry => `${entry.auth}${entry.apiKey}${JSON.stringify(entry.body ?? {})}`.includes("sk-ant-must-not-be-used")), JSON.stringify(main.map(entry => [entry.auth.slice(0, 12), entry.apiKey.slice(0, 6)])));
	const result = (second?.body?.messages?.findLast(message => message?.role === "user")?.content ?? []).find(part => part?.type === "tool_result");
	const resultImage = (Array.isArray(result?.content) ? result.content : []).find(part => part?.type === "image");
	expect("wire: the js tool ran in the sidecar (from model)", jsCalls.length === 1 && jsCalls[0].from === "model" && jsCalls[0].args.code === "// squat\nreturn 1", JSON.stringify(jsCalls));
	expect("wire: request 2 carries the tool_result with an image block", result?.tool_use_id === "toolu_wire_1" && resultImage?.source?.type === "base64" && /^image\//.test(resultImage.source.media_type ?? ""), JSON.stringify(result)?.slice(0, 300));
	const turn1User = JSON.stringify(first?.body?.messages?.[0]?.content ?? "");
	const thirdText = JSON.stringify(third?.body?.messages ?? []);
	expect("wire: turn 2 resumes: it carries turn 1's messages, tool call and result", thirdText.includes("Do one slow squat.") && thirdText.includes("toolu_wire_1") && thirdText.includes("Built a squat.") && thirdText.includes("Hold the bottom a little longer.") && turn1User.includes("Subject: char-a"), thirdText.slice(0, 300));
	const types = one.frames.map(frame => frame.type);
	const done = one.frames.find(frame => frame.type === "tool.done");
	expect("wire: turn 1 frames: text, tool.start js, tool.done with one image, done", types.includes("text.delta") && one.frames.some(frame => frame.type === "tool.start" && frame.name === "js") && done?.ok === true && done.result?.images === 1 && types.at(-1) === "done" && !types.includes("error"), types.join(","));
	expect("wire: turn 2 ends with done and no error", two.frames.at(-1)?.type === "done" && !two.frames.some(frame => frame.type === "error") && two.session.controller === null, JSON.stringify(two.frames.filter(f => f.type === "error")));
	const history = readFileSync(join(tmp, "agent-sessions", `${sessionId}.jsonl`), "utf8").split("\n").filter(Boolean).slice(1).map(line => JSON.parse(line).message);
	expect("wire: session history has the toolCall and its toolResult", history.some(m => m.role === "assistant" && m.content.some(part => part.type === "toolCall" && part.id === "toolu_wire_1" && part.name === "js")) && history.some(m => m.role === "toolResult" && m.toolCallId === "toolu_wire_1" && /\[image \d+x\d+\]/.test(m.content[0].text) && !m.content[0].text.includes("[Image: source:")), JSON.stringify(history.map(m => m.role)));
	console.log(`timing: turn 1 ${turn1Ms} ms, both turns ${Date.now() - started} ms`);
	expect(`wire: under ${BUDGET_MS / 1000} s`, Date.now() - started < BUDGET_MS);
} catch (error) {
	expect("wire: ran without throwing", false, error?.stack ?? String(error));
} finally {
	server.close();
	server.closeAllConnections?.();
}
console.log(`v4 engine wire: ${failures ? "FAIL" : "PASS"}`);
process.exit(failures ? 1 : 0);
