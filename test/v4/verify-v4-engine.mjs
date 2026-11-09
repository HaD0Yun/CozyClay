#!/usr/bin/env node
// The v4 engine with a fake Agent SDK (the pattern of test/verify-anthropic-subscription.mjs): query options,
// child env, MCP results, frames and pi history, the model fallback guard, the picker entry, client routing,
// the first-request size budget, and runV4StudioTurn end to end with fake hub, tools and store.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { createSessionStore } from "../../bin/agent/session-store.mjs";
import { isV4Model, V4_MODEL_KEY, V4_PI_MODEL_KEY, withV4Models } from "../../bin/agent/v4/models.mjs";
import { zodShape } from "../../bin/agent/v4/zod-shape.mjs";
import { createV4McpServer, toCallToolResult } from "../../bin/agent/v4/mcp-server.mjs";
import { childEnv, proxyAuth, queryOptions } from "../../bin/agent/v4/runner.mjs";
import { createFrameMapper, historyMessages } from "../../bin/agent/v4/frames.mjs";
import { sceneBrief, V4_SYSTEM_PROMPT } from "../../bin/agent/v4/prompt.mjs";
import { createV4Context, subjectOf } from "../../bin/agent/v4/context.mjs";
import { runV4StudioTurn } from "../../bin/agent/v4/studio-turn.mjs";
import { createHttpTransport } from "../../src/workflow/agent-client.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

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

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` -- ${detail}`}`);
	if (!condition) failures += 1;
}
const started = Date.now();
const TOOL_NAMES = ["js", "track", "measure", "render", "qa"].map(name => `mcp__cozyclay__${name}`);

/** A fake SDK: query() records its input and yields script(record, n) (messages, or functions that make them). */
function fakeSdk(script) {
	const calls = [];
	return {
		calls,
		tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
		createSdkMcpServer: config => ({ type: "sdk", name: config.name, config }),
		query: ({ prompt, options }) => {
			const record = { options, prompt: [], interrupted: 0, closed: 0 };
			calls.push(record);
			return {
				interrupt: async () => { record.interrupted += 1; },
				close: () => { record.closed += 1; },
				async *[Symbol.asyncIterator]() {
					for await (const message of prompt) record.prompt.push(message);
					for (const item of script(record, calls.length)) {
						if (record.closed) return;
						const message = typeof item === "function" ? await item(record) : item;
						if (message instanceof Error) throw message;
						if (message) yield message;
					}
				},
			};
		},
	};
}

const stream = event => ({ type: "stream_event", event, parent_tool_use_id: null });
const assistant = (id, block, model = "claude-opus-5-5") => ({ type: "assistant", parent_tool_use_id: null, message: { id, model, role: "assistant", content: [block], stop_reason: null, usage: { input_tokens: 10, output_tokens: 2 } } });
const success = { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 30, output_tokens: 9 } };
const textTurn = id => [stream({ type: "message_start", message: { id } }), stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }), assistant(id, { type: "text", text: "ok" }), stream({ type: "message_stop" }), success];

const describe = { activeCharacterId: "char-a", characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 }], objects: BARBELL,
	document: { activeSceneId: "s1", scenes: [{ id: "s1", objects: BARBELL, stage: { characters: [{ id: "char-a", motionTake: null }] } }] } };
const cliproxyModels = (key = "proxy-key") => ({
	getAuth: async id => (id === "cliproxy" && key ? { auth: { apiKey: key }, source: "stored credential" } : undefined),
	getModels: id => (id === "cliproxy" ? [{ id: "gpt-6", api: "openai-responses", baseUrl: "http://proxy.test:8317/v1" }, { id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "http://proxy.test:8317" }] : []),
});
const parentEnv = { PATH: "/usr/bin:/bin", HOME: "/home/test", CLAUDE_CODE_EXECUTABLE: process.execPath, ANTHROPIC_API_KEY: "sk-ant-should-drop", ANTHROPIC_BASE_URL: "http://wrong.test", CLAUDE_CODE_OAUTH_TOKEN: "oauth-drop", CLAUDE_CODE_OAUTH_TOKEN_2: "oauth-drop-2", CLAUDE_CODE_USE_BEDROCK: "1" };

/** One Studio turn through runV4StudioTurn with fakes; returns frames and the fakes. */
async function turn({ sdk, sessionId = randomUUID(), store, text = "Do a squat.", toolSets, models = cliproxyModels(), hubDescribe = describe, abortAfter, attachments }) {
	const frames = [], controller = new AbortController(), session = { controller, activeTurnId: "t", host: null };
	const res = { writableEnded: false, end() { this.writableEnded = true; } };
	let closed = 0;
	const hub = { command: async (name, args, handle) => { if (name !== "describe" || handle !== "ws-1") throw new Error(`unexpected ${name}`); return hubDescribe; } };
	const value = { surface: "studio", sessionId, turnId: randomUUID(), text, effort: "high", model: V4_MODEL_KEY, ...(attachments ? { attachments } : {}),
		context: { host: { workspaceHandle: "ws-1", workspaceId: "w1", documentEpoch: 1, sceneId: "s1", sceneEpoch: 1 }, scene: { name: "Gym", frameCount: 240 } } };
	const send = frame => { frames.push(frame); if (abortAfter && frame.type === abortAfter) controller.abort(); };
	const answer = await runV4StudioTurn({ value, session, send, close: () => { closed += 1; }, res, controller, studioTools: { internal: { invoke: async () => ({ ok: true }) } }, hub, sessionStore: store, models, env: parentEnv,
		studioIdentity: host => ({ ...host }), admission: { host: { ...value.context.host } },
		loadToolSet: async ctx => { const set = { tools: fakeTools(), close: () => { set.closed = true; }, ctx }; toolSets?.push(set); return set; }, loadSdk: async () => sdk });
	return { answer, frames, session, res, closed, value };
}

const tmp = mkdtempSync(join(tmpdir(), "v4-engine-"));
const store = createSessionStore(join(tmp, "agent-sessions"));
const v4Root = join(tmp, "v4");

// 1, 9: query options on turn 1 and turn 2 (resume), and the turn's end.
{
	const sdk = fakeSdk((_record, n) => textTurn(`msg_${n}`)), sets = [], sessionId = randomUUID();
	const one = await turn({ sdk, sessionId, store, toolSets: sets });
	const two = await turn({ sdk, sessionId, store, toolSets: sets, text: "Make it deeper." });
	const [first, second] = sdk.calls.map(call => call.options);
	expect("1 model, effort and adaptive summarized thinking", first.model === "claude-opus-5-5" && first.effort === "high" && first.thinking?.type === "adaptive" && first.thinking?.display === "summarized", JSON.stringify([first.model, first.effort, first.thinking]));
	expect("1 built-in tools off, the five cozyclay tools allowed", Array.isArray(first.tools) && first.tools.length === 0 && JSON.stringify(first.allowedTools) === JSON.stringify(TOOL_NAMES), JSON.stringify(first.allowedTools));
	expect("1 no canUseTool and no hooks: the tools run", !("canUseTool" in first) && !("hooks" in first) && first.permissionMode === "dontAsk", Object.keys(first).join(","));
	expect("1 settingSources [], strictMcpConfig, string system prompt, partial messages, persisted", Array.isArray(first.settingSources) && !first.settingSources.length && first.strictMcpConfig === true && first.systemPrompt === V4_SYSTEM_PROMPT && first.includePartialMessages === true && first.persistSession === true);
	expect("1 one in-process server cozyclay, alwaysLoad, 15 min timeout, five tools", first.mcpServers?.cozyclay?.config?.name === "cozyclay" && first.mcpServers.cozyclay.config.alwaysLoad === true && first.mcpServers.cozyclay.config.timeout === 900000 && first.mcpServers.cozyclay.config.tools.length === 5);
	expect("1 turn 1 uses the Studio sessionId, turn 2 resumes it", first.sessionId === sessionId && !("resume" in first) && second.resume === sessionId && !("sessionId" in second), JSON.stringify([first.sessionId, first.resume, second.sessionId, second.resume]));
	expect("1 cwd and config dir under v4Root (next to agent-sessions)", first.cwd === join(v4Root, "work") && first.env.CLAUDE_CONFIG_DIR === join(v4Root, "claude") && existsSync(join(v4Root, "claude")), first.cwd);
	expect("1 executable resolved from the child env", first.pathToClaudeCodeExecutable === process.execPath && first.abortController instanceof AbortController);
	const marker = JSON.parse(readFileSync(join(v4Root, "sessions", `${sessionId}.json`), "utf8"));
	expect("1 session marker counts turns", marker.sdkSessionId === sessionId && marker.turns === 2 && typeof marker.createdAt === "string", JSON.stringify(marker));
	expect("1 tool set built once per conversation and re-bound", sets.length === 1 && sets[0].ctx.character.id === "char-a" && typeof sets[0].ctx.studio.runAction === "function");
	const prompt1 = sdk.calls[0].prompt[0]?.message?.content?.[0]?.text ?? "", prompt2 = sdk.calls[1].prompt[0]?.message?.content?.[0]?.text ?? "";
	expect("3 turn 1 prompt is the scene brief then the request", prompt1.startsWith("Scene (") && prompt1.includes("Subject: char-a") && prompt1.endsWith("\n\nDo a squat."), prompt1.slice(0, 120));
	expect("3 turn 2 prompt is the request plus the track line", prompt2.startsWith("Make it deeper.\n\nTrack:") && !prompt2.includes("Subject:"), prompt2);
	for (const [label, run] of [["turn 1", one], ["turn 2", two]]) {
		expect(`9 ${label} ends with done, closes the stream, clears the running turn`, run.answer === true && run.frames.at(-1)?.type === "done" && run.frames.filter(f => f.type === "done").length === 1 && run.closed === 1 && run.res.writableEnded && run.session.controller === null && run.session.activeTurnId === null && run.session.host?.workspaceId === "w1",
			JSON.stringify(run.frames.map(f => f.type)));
	}
}

// 2: child env and the proxy credential.
{
	const auth = await proxyAuth(cliproxyModels());
	const env = childEnv(parentEnv, auth, { configDir: "/cfg/v4/claude" });
	expect("2 proxy base (no /v1) and key from the cliproxy credential", auth.baseUrl === "http://proxy.test:8317" && auth.token === "proxy-key", JSON.stringify(auth));
	expect("2 child env carries the proxy, its config dir and the client-app tag", env.ANTHROPIC_BASE_URL === "http://proxy.test:8317" && env.ANTHROPIC_AUTH_TOKEN === "proxy-key" && env.CLAUDE_CONFIG_DIR === "/cfg/v4/claude" && /^cozyclay-v4\/\d+\.\d+\.\d+/.test(env.CLAUDE_AGENT_SDK_CLIENT_APP) && env.DISABLE_COMPACT === "1" && env.DISABLE_AUTOUPDATER === "1" && env.MAX_MCP_OUTPUT_TOKENS === "100000");
	expect("2 child env drops other Anthropic credentials and keeps PATH and HOME", !("ANTHROPIC_API_KEY" in env) && !("CLAUDE_CODE_OAUTH_TOKEN" in env) && !("CLAUDE_CODE_OAUTH_TOKEN_2" in env) && !("CLAUDE_CODE_USE_BEDROCK" in env) && env.PATH === parentEnv.PATH && env.HOME === parentEnv.HOME, Object.keys(env).join(","));
	let refused = null;
	try { await proxyAuth(cliproxyModels(null)); } catch (error) { refused = error; }
	expect("2 no cliproxy credential: a clear error", refused?.message === "v4 needs the CLIProxyAPI sign-in (its Claude models).", refused?.message);
	const fallback = await proxyAuth({ getAuth: async () => ({ auth: { apiKey: "k" }, env: { CLIPROXY_BASE_URL: "http://box.test:9000/v1" } }), getModels: () => [] }, { env: {} });
	expect("2 without an anthropic model the base comes from cliproxyBase", fallback.baseUrl === "http://box.test:9000", fallback.baseUrl);
	const options = queryOptions({ server: {}, effort: "ultra", sessionId: "s", cwd: "/w", env: {}, executable: "/fake/claude" });
	expect("2 Studio efforts map to SDK efforts", options.effort === "max" && queryOptions({ server: {}, effort: "minimal", sessionId: "s", cwd: "/w", env: {}, executable: "/x" }).effort === "low" && queryOptions({ server: {}, sessionId: "s", cwd: "/w", env: {}, executable: "/x" }).effort === "high");
}

// 3: MCP results and the zod shapes.
{
	const sdk = fakeSdk(() => []);
	const image = pngBase64(8, 6);
	const calls = [];
	const tools = [
		{ name: "render", description: "d", inputSchema: SCHEMAS.render, run: async (args, call) => { calls.push({ args, call }); return { data: { ok: 1 }, text: "sheet 1", images: [{ data: image, mimeType: "image/png", label: "judge" }] }; } },
		{ name: "qa", description: "d", inputSchema: SCHEMAS.qa, run: async () => { throw new Error("No track yet: call track set first."); } },
	];
	const server = createV4McpServer(sdk, tools, { onCall: call => calls.push(call) });
	const [render, qa] = server.config.tools;
	const answer = await render.handler({ views: ["judge"] }, { signal: new AbortController().signal });
	expect("3 a text plus image result answers text and image blocks", answer.content.length === 2 && answer.content[0].type === "text" && answer.content[0].text === "sheet 1" && answer.content[1].type === "image" && answer.content[1].data === image && answer.content[1].mimeType === "image/png" && !answer.isError, JSON.stringify(answer).slice(0, 200));
	expect("3 run gets from model and a signal", calls[0].call.from === "model" && typeof calls[0].call.signal?.aborted === "boolean");
	const failed = await qa.handler({}, {});
	expect("3 a throwing tool answers isError with its message", failed.isError === true && failed.content[0].text === "No track yet: call track set first.", JSON.stringify(failed));
	expect("3 toCallToolResult keeps isError", toCallToolResult({ text: "bad", isError: true }).isError === true && toCallToolResult({ text: "fine" }).isError === undefined);
	const track = z.object(zodShape(SCHEMAS.track));
	const parsed = track.parse({ op: "set", frames: 2, objects: { barbell: { pos: [0, 1, 2], quat: [0, 0, 0, 1] } } });
	expect("3 zodShape keeps the keys of an additionalProperties map", parsed.objects?.barbell?.pos?.length === 3, JSON.stringify(parsed));
	expect("3 zodShape enforces enums, integer bounds and strict objects", !track.safeParse({ op: "nope" }).success && !track.safeParse({ op: "set", frames: 0 }).success && !track.safeParse({ op: "set", objects: { a: { pos: [], quat: [], x: 1 } } }).success);
	const views = z.object(zodShape(SCHEMAS.render));
	expect("3 zodShape anyOf: view names, custom views and frame lists", views.safeParse({ views: ["judge", { eye: [1, 2, 3], target: [0, 1, 0] }], frames: [0, 12] }).success && views.safeParse({ frames: "events" }).success && !views.safeParse({ frames: "odd" }).success);
}

// 4: a scripted stream -> frames, and the pi history in the session file.
{
	const image = pngBase64(1200, 675);
	const script = () => [
		{ type: "system", subtype: "init", model: "claude-opus-5-5" },
		stream({ type: "message_start", message: { id: "msg_a" } }),
		stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
		stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the squat: down for 12 frames, " } }),
		stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "then up." } }),
		assistant("msg_a", { type: "thinking", thinking: "Plan the squat: down for 12 frames, then up.", signature: "sig" }),
		stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Building it." } }),
		assistant("msg_a", { type: "text", text: "Building it." }),
		stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__cozyclay__js", input: {} } }),
		assistant("msg_a", { type: "tool_use", id: "toolu_1", name: "mcp__cozyclay__js", input: { code: `const T = rig.track(48);\n${"x".repeat(400)}`, rot: Array.from({ length: 5000 }, (_, i) => i) } }),
		stream({ type: "message_stop" }),
		{ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok, 412 ms. kept: T" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }, { type: "text", text: "[Image: source: /cfg/v4/claude/projects/x/tool-results/blob-1.png]" }] }] } },
		...textTurn("msg_b"),
	];
	const sdk = fakeSdk(script), sessionId = randomUUID();
	const { frames } = await turn({ sdk, sessionId, store });
	const types = frames.map(frame => frame.type);
	const start = frames.find(frame => frame.type === "tool.start"), done = frames.find(frame => frame.type === "tool.done");
	expect("4 frames: thinking.delta, text.delta, tool.start, tool.done, done", ["thinking.delta", "text.delta", "tool.start", "tool.done"].every(type => types.includes(type)) && types.at(-1) === "done" && types.indexOf("tool.start") < types.indexOf("tool.done"), types.join(","));
	expect("4 thinking batched into one frame per run", frames.filter(f => f.type === "thinking.delta").map(f => f.text).join("") === "Plan the squat: down for 12 frames, then up." && frames.filter(f => f.type === "thinking.delta").length === 1);
	expect("4 text streamed once (not again from the assistant message)", frames.filter(f => f.type === "text.delta").map(f => f.text).join("|") === "Building it.|ok", frames.filter(f => f.type === "text.delta").map(f => f.text).join("|"));
	expect("4 tool.start: prefix removed, long string clipped to 200, long array summarized", start?.callId === "toolu_1" && start.name === "js" && start.label === "js" && start.args.code.length === 200 && start.args.rot?.length === 5000 && start.args.rot.head.length === 8, JSON.stringify(start).slice(0, 300));
	expect("4 tool.done: same callId, ok, text clipped, one image", done?.callId === "toolu_1" && done.ok === true && Number.isFinite(done.elapsedMs) && done.result.text === "ok, 412 ms. kept: T" && done.result.images === 1, JSON.stringify(done));
	const lines = readFileSync(join(tmp, "agent-sessions", `${sessionId}.jsonl`), "utf8").split("\n").filter(Boolean).slice(1).map(line => JSON.parse(line));
	const messages = lines.map(line => line.message);
	const assistants = messages.filter(m => m.role === "assistant"), results = messages.filter(m => m.role === "toolResult");
	const call = assistants.flatMap(m => m.content).find(part => part.type === "toolCall");
	expect("4 session lines are { kind: message, message }", lines.length && lines.every(line => line.kind === "message"), JSON.stringify(lines.map(l => l.kind)));
	expect("4 the user message is stored first, its scene brief inside studio-context", messages[0].role === "user" && messages[0].content[0].text.startsWith("<studio-context>\nScene (") && messages[0].content[0].text.endsWith("</studio-context>\nDo a squat."));
	expect("4 one assistant message per response (blocks merged), with model and usage", assistants.length === 2 && assistants[0].content.map(part => part.type).join(",") === "thinking,text,toolCall" && assistants[0].model === "claude-opus-5-5" && Number.isFinite(assistants[0].usage?.input), JSON.stringify(assistants.map(m => m.content.map(p => p.type))));
	expect("4 toolCall { id, name (prefix removed), arguments }", call?.id === "toolu_1" && call.name === "js" && call.arguments.code.startsWith("const T = rig.track(48);") && call.arguments.rot?.length === 5000, JSON.stringify(call).slice(0, 200));
	expect("4 toolResult with the matching toolCallId, image as [image WxH]", results.length === 1 && results[0].toolCallId === "toolu_1" && results[0].toolName === "js" && results[0].isError === false && results[0].content[0].text === "ok, 412 ms. kept: T\n[image 1200x675]", JSON.stringify(results));
	const history = historyMessages({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "boom" }] } });
	expect("4 historyMessages: an error result keeps isError", history.length === 1 && history[0].isError === true && history[0].content[0].text === "boom");
	const pushed = [], mapper = createFrameMapper({ push: frame => pushed.push(frame), clock: () => 0 });
	mapper.onMessage({ type: "result", subtype: "error_during_execution", errors: ["upstream 529"] });
	mapper.finish(); mapper.finish();
	expect("4 a non-success result is an error then one done", pushed.map(f => f.type).join(",") === "error,done" && pushed[0].message === "upstream 529", JSON.stringify(pushed));
}

// 5: the model fallback guard.
{
	const sessionId = randomUUID();
	const sdk = fakeSdk(() => [stream({ type: "message_start", message: { id: "m" } }), assistant("m", { type: "text", text: "I can't help with that." }, "claude-opus-4-8"), assistant("m2", { type: "text", text: "more" }, "claude-opus-4-8"), success]);
	const { frames } = await turn({ sdk, sessionId, store });
	const error = frames.find(frame => frame.type === "error");
	expect("5 a claude-opus-4-8 answer gives a model_fallback error and an interrupt", error?.code === "model_fallback" && /claude-opus-4-8/.test(error.message) && sdk.calls[0].interrupted === 1, JSON.stringify(frames));
	expect("5 the fallback answer is not shown and the turn still ends with done", !frames.some(frame => frame.type === "text.delta") && frames.at(-1)?.type === "done" && frames.filter(f => f.type === "error").length === 1);
	expect("5 the fallback is recorded in the session history", store.read(sessionId)?.turnErrors?.some(row => row.code === "model_fallback"), JSON.stringify(store.read(sessionId)?.turnErrors));
	const refusal = fakeSdk(() => [{ type: "system", subtype: "model_refusal_fallback", original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8" }, success]);
	const second = await turn({ sdk: refusal, store });
	expect("5 a model_refusal_fallback notice also stops the turn", second.frames.some(f => f.type === "error" && f.code === "model_fallback") && refusal.calls[0].interrupted === 1);
}

// 6: the picker entry.
{
	const listing = { providers: [{ id: "openai-codex", signedIn: true, authSource: "chatgpt", models: [{ id: "gpt-6-astra", key: "openai-codex/gpt-6-astra" }] }, { id: "cliproxy", label: "CLIProxyAPI", signedIn: true, authSource: "file", models: [] }], models: [{ id: "openai-codex/gpt-6-astra", key: "openai-codex/gpt-6-astra" }], roles: { byMain: {} } };
	const listed = withV4Models(listing), provider = listed.providers.at(-1);
	expect("6 withV4Models appends the v4 provider after the others", provider.id === "v4" && provider.label === "CozyClay v4 motion" && provider.models[0].key === V4_MODEL_KEY && provider.models[0].id === "claude-opus-5-5" && provider.models[0].defaultEffort === "high" && provider.models[0].efforts[0] === "high", JSON.stringify(provider));
	expect("6 signedIn and authSource follow cliproxy", provider.signedIn === true && provider.authSource === "file");
	expect("6 the flat list carries v4 then v4pi last; roles kept", listed.models.at(-2).id === V4_MODEL_KEY && listed.models.at(-1).id === "v4pi/claude-opus-5-5" && listed.models.length === 3 && listed.roles === listing.roles);
	const signedOut = { ...listing, providers: listing.providers.map(p => (p.id === "cliproxy" ? { ...p, signedIn: false, authSource: null } : p)) };
	expect("6 cliproxy signed out: the listing is unchanged (no v4 entry)", withV4Models(signedOut) === signedOut && !withV4Models({ models: [] }).providers);
	expect("6 isV4Model matches only the v4 key", isV4Model(V4_MODEL_KEY) && !isV4Model("cliproxy/claude-opus-5-5") && !isV4Model(undefined));
}

// 7: agent-client sends a v4 turn to /agent/turn even with Tasks on.
{
	const sent = [];
	const transport = createHttpTransport({ surface: "studio", capture: () => {}, fetchImpl: async (url, init) => { sent.push({ url: String(url), tasks: init.headers["x-cozyclay-tasks"], body: JSON.parse(init.body) }); return new Response(`data: ${JSON.stringify({ type: "done" })}\n\n`); } });
	const studioTurn = { sessionId: "s", text: "squat", surface: "studio", turnId: "turn-v4", context: {}, tasks: true };
	await transport.turn({ ...studioTurn, model: V4_MODEL_KEY }, () => {});
	await transport.turn({ ...studioTurn, model: "cliproxy/claude-opus-5-5" }, () => {});
	await transport.turn({ ...studioTurn, model: V4_PI_MODEL_KEY }, () => {});
	expect("7 tasks on + v4 model: /agent/turn without the tasks header", sent[0].url.endsWith("/agent/turn") && sent[0].tasks === undefined && sent[0].body.model === V4_MODEL_KEY, JSON.stringify(sent[0]));
	expect("7 tasks on + another model: still /agent/main with the header", sent[1].url.endsWith("/agent/main") && sent[1].tasks === "on", JSON.stringify(sent[1]));
	expect("7 tasks on + v4pi model: /agent/turn without the tasks header", sent[2].url.endsWith("/agent/turn") && sent[2].tasks === undefined && sent[2].body.model === V4_PI_MODEL_KEY, JSON.stringify(sent[2]));
}

// 8: the first request's model-facing text stays small.
{
	const sk = skeletonFor("y-bot-tpose");
	const brief = sceneBrief({ character: { id: "char-a", model: "y-bot-tpose", position: [0, 0, 0], yaw: 0, scale: 1 }, sk, records: [...BARBELL, { id: "crate", name: "Crate", renderer: "cube", x: 0.6, y: 0, z: 0.9, rot: 15, rotX: 0, rotZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5, parent: null, footprint: { width: 1, depth: 1 }, height: 1 }], installed: null, frameCount: 240 });
	const schemas = fakeTools().map(tool => JSON.stringify(z.toJSONSchema(z.object(zodShape(tool.inputSchema))))).join("");
	const descriptions = fakeTools().map(tool => tool.description).join("");
	const total = V4_SYSTEM_PROMPT.length + descriptions.length + schemas.length + brief.length;
	console.log(`size: prompt ${V4_SYSTEM_PROMPT.length}, descriptions ${descriptions.length}, schemas ${schemas.length}, brief ${brief.length}, total ${total} chars (about ${Math.round(total / 3.5)} tokens)`);
	expect("8 system prompt under 5,000 chars, brief under 3,000", V4_SYSTEM_PROMPT.length < 5000 && brief.length <= 3000 && descriptions.length === 9000 + 4 * 2000);
	expect("8 prompt + five tools at their caps + schemas + bench brief <= 38,000 chars", total <= 38000, String(total));
	expect("8 the brief names the subject, height, groups and parts", /Subject: char-a, y-bot-tpose, position \[0, 0, 0\], yaw 0, standing height 1\.\d+ m/.test(brief) && brief.includes("- group barbell: pivot [0, 0.225, 0.35], parts barbell-bar, barbell-plate-l, barbell-plate-r") && brief.includes("- crate: cube") && brief.includes("Installed take: none.") && brief.includes("Timeline: 240 frames"), brief);
	const many = Array.from({ length: 80 }, (_, i) => ({ id: `box-${i}`, name: `Box ${i}`, renderer: "cube", x: i, y: 0, z: 0, rot: 0, scaleX: 1, scaleY: 1, scaleZ: 1, footprint: { width: 1, depth: 1 }, height: 1 }));
	const long = sceneBrief({ character: { id: "c", model: "y-bot-tpose", position: [0, 0, 0], yaw: 0 }, sk, records: many, frameCount: 24 });
	expect("8 a long scene list is cut at 3,000 chars with a count", long.length <= 3000 && /\.\.\. \d+ more \(all of them: rig\.scene in js\)\.$/.test(long), String(long.length));
}

// 9: failures, stop, resume recovery, subject, attachments.
{
	const noAuth = await turn({ sdk: fakeSdk(() => textTurn("m")), store, models: cliproxyModels(null) });
	expect("9 no cliproxy sign-in: an auth error frame, then done", noAuth.frames.map(f => f.type).join(",") === "error,done" && noAuth.frames[0].code === "auth" && noAuth.session.controller === null, JSON.stringify(noAuth.frames));
	const lazy = await turn({ sdk: fakeSdk(() => textTurn("m")), store, models: async () => { throw new Error("registry broke"); } });
	expect("9 a models builder that fails is the turn's error frame", lazy.frames[0]?.type === "error" && lazy.frames[0].message === "registry broke" && lazy.frames.at(-1).type === "done");
	const none = await turn({ sdk: fakeSdk(() => textTurn("m")), store, hubDescribe: { characters: [{ id: "p", model: "proxy-figure" }], objects: [] } });
	expect("9 no rigged character: TARGET_NOT_READY", none.frames[0]?.code === "TARGET_NOT_READY" && none.frames.at(-1).type === "done", JSON.stringify(none.frames));
	expect("9 subjectOf picks the active rigged character, else the only one", subjectOf({ activeCharacterId: "b", characters: [{ id: "a", model: "x-bot-tpose" }, { id: "b", model: "y-bot-tpose", x: 1, z: 2, rot: 90 }] }).position.join() === "1,0,2" && subjectOf({ characters: [{ id: "a", model: "x-bot-tpose", rot: 45 }] }).yaw === 45);
	const ctx = createV4Context({ describe, studioTools: { internal: { invoke: async (name, args) => ({ name, args }) } }, hub: { command: async (name, args, handle, options) => ({ name, args, handle, options }) }, workspaceHandle: "ws-9", signal: new AbortController().signal });
	const action = await ctx.studio.runAction("motion.v4.install", { characterId: "char-a" }), command = await ctx.studio.command("v4_render", { a: 1 }, { timeoutMs: 120000 });
	expect("9 ctx.studio.runAction is run_action, ctx.studio.command goes to the turn's handle", action.name === "run_action" && action.args.action === "motion.v4.install" && command.handle === "ws-9" && command.options.timeoutMs === 120000 && ctx.sk?.names?.length === 65 && (await ctx.records()) === BARBELL);
	const slow = fakeSdk(() => [stream({ type: "message_start", message: { id: "s" } }), stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } }), record => new Promise(resolve => setTimeout(() => resolve(record.interrupted ? null : assistant("s", { type: "text", text: "late" })), 50)), { type: "result", subtype: "error_during_execution", errors: ["interrupted"] }]);
	const stopped = await turn({ sdk: slow, store, abortAfter: "text.delta" });
	expect("9 Stop interrupts the query: one aborted error, then done", slow.calls[0].interrupted === 1 && stopped.frames.filter(f => f.type === "error").map(f => f.code).join() === "aborted" && stopped.frames.at(-1).type === "done", JSON.stringify(stopped.frames));
	const sessionId = randomUUID();
	await turn({ sdk: fakeSdk(() => textTurn("m")), sessionId, store });
	const lost = fakeSdk((_record, n) => (n === 1 ? [new Error(`No conversation found with session ID: ${sessionId}`)] : textTurn("m")));
	const recovered = await turn({ sdk: lost, sessionId, store, text: "again" });
	expect("9 a resume with no conversation starts fresh once and says so", lost.calls.length === 2 && lost.calls[0].options.resume === sessionId && lost.calls[1].options.sessionId && lost.calls[1].options.sessionId !== sessionId && recovered.frames.some(f => f.type === "text.delta" && /could not be resumed/.test(f.text)) && !recovered.frames.some(f => f.type === "error"), JSON.stringify(lost.calls.map(c => [c.options.resume, c.options.sessionId])));
	expect("9 the fresh start carries the scene brief again", (lost.calls[1].prompt[0]?.message?.content?.[0]?.text ?? "").startsWith("Scene ("));
	const crashedId = randomUUID();
	const crash = fakeSdk((_record, n) => (n === 1 ? [stream({ type: "message_start", message: { id: "c" } }), new Error("Claude Code process exited with code 1")] : textTurn("m")));
	const crashed = await turn({ sdk: crash, sessionId: crashedId, store });
	await turn({ sdk: crash, sessionId: crashedId, store, text: "again" });
	expect("9 a first turn that dies is an upstream error, and the next turn resumes its session", crashed.frames.some(f => f.type === "error" && f.code === "upstream" && /exited/.test(f.message)) && crashed.frames.at(-1).type === "done" && crash.calls[1].options.resume === crashedId, JSON.stringify([crashed.frames, crash.calls[1]?.options?.resume]));
	const pictured = fakeSdk(() => textTurn("m"));
	await turn({ sdk: pictured, store, attachments: [{ dataUrl: `data:image/png;base64,${pngBase64(4, 4)}`, name: "ref.png" }] });
	const block = pictured.calls[0].prompt[0]?.message?.content?.[1];
	expect("9 an attached picture becomes an image block", block?.type === "image" && block.source?.type === "base64" && block.source.media_type === "image/png", JSON.stringify(block)?.slice(0, 120));
}

// 10: the route. A v4 key takes the v4 branch of handleStudioTurn (here it stops at the missing proxy
// sign-in, before any SDK or tool set), and /agent/models lists v4 once cliproxy is signed in.
{
	process.env.COZYCLAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), "v4-engine-config-"));
	const { createAgentHandler } = await import("../../bin/agent/agent-routes.mjs");
	const { STUDIO_TOOL_FAMILIES } = await import("../../src/studio-agent-protocol.js");
	const identity = { workspaceId: "tab-v4", documentEpoch: "doc-v4", sceneId: "scene-v4", sceneEpoch: "scene-open-v4" };
	const context = () => ({
		schema: "studio-context-v1", host: { surface: "studio", workspaceHandle: "handle-v4", ...identity }, revision: { scene: 7, physics: 1, view: 1 },
		units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
		scene: { name: "Gym", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 0, characterCount: 1 }, selection: null, activeCharacterId: null,
		view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null,
		entities: [], entityPage: { returned: 0, total: 0, truncated: false, nextCursor: null }, shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
		capabilities: { profile: "studio-slice-1", tools: [...STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: false },
	});
	let cliproxyKey = null;
	const registry = { getModels: () => [], getAuth: async id => (id === "cliproxy" && cliproxyKey ? { auth: { apiKey: cliproxyKey } } : undefined) };
	const hubCommands = [];
	const liveHub = { command: async name => { hubCommands.push(name); throw new Error(`unexpected hub command ${name}`); } };
	const { createServer } = await import("node:http");
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: registry, liveHub, env: {},
		studioRuntime: { readContext: async () => context() }, sessionStore: createSessionStore(join(tmp, "route-sessions")), port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(error.stack); } else if (!res.writableEnded) res.end(); }));
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	try {
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: AbortSignal.timeout(20000), headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ surface: "studio", sessionId: randomUUID(), turnId: randomUUID(), text: "Do a squat.", model: V4_MODEL_KEY, effort: "high", context: context() }) });
		const events = (await response.text()).split("\n\n").map(block => /^data: (.+)$/m.exec(block)?.[1]).filter(Boolean).map(line => JSON.parse(line));
		expect("10 route: a v4 turn streams the v4 engine's frames (auth error, then done)", response.status === 200 && events.map(event => event.type).join(",") === "error,done" && events[0].code === "auth" && /CLIProxyAPI/.test(events[0].message), JSON.stringify(events));
		expect("10 route: the v4 branch made no editor call and no old-engine model call", hubCommands.length === 0, hubCommands.join(","));
		const before = await fetch(`${origin}/agent/models`, { headers: { origin } }).then(answer => answer.json());
		cliproxyKey = "proxy-key";
		const after = await fetch(`${origin}/agent/models`, { headers: { origin } }).then(answer => answer.json());
		expect("10 route: /agent/models has no v4 entry while cliproxy is signed out", !before.providers.some(provider => provider.id === "v4") && !before.models.some(model => model.id === V4_MODEL_KEY), JSON.stringify(before.providers.map(p => p.id)));
		expect("10 route: /agent/models lists v4/claude-opus-5-5 once cliproxy is signed in", after.providers.at(-1)?.id === "v4" && after.providers.at(-1).signedIn === true && after.models.some(model => model.id === V4_MODEL_KEY), JSON.stringify(after.providers.map(p => [p.id, p.signedIn])));
	} finally {
		await handler.close();
		await new Promise(resolve => server.close(resolve));
	}
}

console.log(`v4 engine: ${failures ? "FAIL" : "PASS"} in ${Date.now() - started} ms`);
process.exit(failures ? 1 : 0);
