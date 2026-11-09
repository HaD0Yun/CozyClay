#!/usr/bin/env node
// The v4 engine on the pi loop: the "v4pi/claude-opus-5-5" model entry (models.mjs), the V4Tool -> pi AgentTool
// adapter (pi-tools.mjs, images as image blocks) and one Studio turn through a faked pi runner (pi-turn.mjs):
// the V4 prompt, contextView "plain", the brief or state line as studioContextText, frames passed through, cleanup.
import { deepStrictEqual } from "node:assert";
import { V4_MODEL_KEY, V4_PI_MODEL_KEY, isV4Model, isV4PiModel, withV4Models } from "../../bin/agent/v4/models.mjs";
import { toV4AgentTools } from "../../bin/agent/v4/pi-tools.mjs";
import { runV4PiStudioTurn } from "../../bin/agent/v4/pi-turn.mjs";
import { V4_SYSTEM_PROMPT } from "../../bin/agent/v4/prompt.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const same = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };
const show = value => JSON.stringify(value)?.slice(0, 300);
async function rejection(promise) {
	try { await promise; return null; } catch (error) { return error; }
}

// ---- a. models ----
expect("isV4PiModel(V4_PI_MODEL_KEY)", isV4PiModel(V4_PI_MODEL_KEY) === true);
expect("isV4Model is false for the pi key", isV4Model(V4_PI_MODEL_KEY) === false);
expect("V4_PI_MODEL_KEY value", V4_PI_MODEL_KEY === "v4pi/claude-opus-5-5", V4_PI_MODEL_KEY);
const signedIn = withV4Models({ providers: [{ id: "cliproxy", signedIn: true, authSource: "file" }], models: [] });
const v4Provider = signedIn.providers.find(provider => provider.id === "v4");
const keys = v4Provider?.models?.map(model => model.key) ?? [];
expect("v4 provider lists both keys", keys.includes(V4_MODEL_KEY) && keys.includes(V4_PI_MODEL_KEY), show(keys));
expect("listing.models has the pi entry", signedIn.models.some(model => model.id === V4_PI_MODEL_KEY), show(signedIn.models));
expect("listing.models has the Claude Code entry", signedIn.models.some(model => model.id === V4_MODEL_KEY), show(signedIn.models));
const signedOut = { providers: [{ id: "cliproxy", signedIn: false }], models: [] };
expect("signed out: listing unchanged", withV4Models(signedOut) === signedOut);

// ---- b. toV4AgentTools ----
const calls = [];
const fakeRender = { name: "render", description: "d", inputSchema: { type: "object", additionalProperties: false, properties: { n: { type: "integer" } } }, run: async (args, call) => { calls.push(call); return { text: "two views", data: { n: args.n }, images: [{ data: "AAAA", mimeType: "image/png" }, { data: "BBBB" }] }; } };
const [render] = toV4AgentTools([fakeRender]);
expect("AgentTool name", render.name === "render", render.name);
expect("AgentTool label", render.label === "render", render.label);
expect("AgentTool parameters", Boolean(render.parameters) && typeof render.parameters === "object");
expect("AgentTool execute", typeof render.execute === "function");
const rendered = await render.execute("c1", { n: 2 });
expect("execute content: text then image blocks", same(rendered.content, [{ type: "text", text: "two views" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/png" }]), show(rendered.content));
expect("execute details", same(rendered.details, { text: "two views", images: 2 }), show(rendered.details));
expect("run called from model", calls.length === 1 && calls[0].from === "model", show(calls));
const [failing] = toV4AgentTools([{ name: "qa", inputSchema: { type: "object", properties: {} }, run: async () => ({ text: "boom", isError: true, images: [{ data: "CCCC" }] }) }]);
const failed = await failing.execute("c3", {});
expect("isError result returns an error result with its text and images kept", failed?.isError === true && same(failed.content, [{ type: "text", text: "boom" }, { type: "image", data: "CCCC", mimeType: "image/png" }]), show(failed));
const invalid = await rejection(render.execute("c2", { n: "x" }));
expect("invalid args reject INVALID_ARGUMENT", invalid?.code === "INVALID_ARGUMENT", `${invalid?.code} ${invalid?.message}`);
expect("invalid args do not call run", calls.length === 1, String(calls.length));
const [throwing] = toV4AgentTools([{ name: "js", inputSchema: { type: "object", properties: {} }, run: async () => { throw new Error("bad"); } }]);
const thrown = await rejection(throwing.execute("c4", {}));
expect("a throw from run propagates", thrown?.message === "bad", String(thrown?.message));

// ---- c. runV4PiStudioTurn ----
const hub = { command: async name => (name === "describe" ? { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0, rot: 0, scale: 1 }], activeCharacterId: "char-a", objects: [] } : {}) };
const studioTools = { internal: { invoke: async () => ({}) } };
const loadToolSet = async () => ({ tools: [fakeRender, { name: "js", description: "j", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, run: async () => ({ text: "ok" }) }], close() {} });
function turn({ sessionId, sessionStore = { read: () => null }, runnerFor }) {
	const captured = [], frames = [];
	runnerFor ??= async () => ({ openSession: async () => ({ start: async function* (input) { captured.push(input); yield { type: "text.delta", text: "hi" }; yield { type: "done" }; } }) });
	const session = {};
	const res = { writableEnded: false, end() { this.writableEnded = true; } };
	const value = { sessionId, text: "jump", context: { host: { workspaceHandle: "w", workspaceId: "ws" }, scene: { name: "Scene", frameCount: 120 } } };
	const run = runV4PiStudioTurn({ value, session, send: frame => frames.push(frame), close: () => {}, res, controller: new AbortController(), studioTools, hub, sessionStore, runnerFor, studioIdentity: host => host, admission: { host: { workspaceId: "ws" } }, loadToolSet });
	return { run, captured, frames, session, res };
}

const t1 = turn({ sessionId: "s1" });
const result = await t1.run;
const input = t1.captured[0] ?? {};
expect("turn returns true", result === true, String(result));
expect("start called once", t1.captured.length === 1, String(t1.captured.length));
expect("systemPrompt is the V4 prompt", input.systemPrompt === V4_SYSTEM_PROMPT);
expect("contextView plain", input.contextView === "plain", String(input.contextView));
expect("model cliproxy/claude-opus-5-5", input.model === "cliproxy/claude-opus-5-5", String(input.model));
expect("effort defaults to high", input.effort === "high", String(input.effort));
expect("tools are the v4 tools", same(input.tools?.map(tool => tool.name), ["render", "js"]) && input.tools.every(tool => typeof tool.execute === "function"), show(input.tools?.map(tool => tool.name)));
expect("first turn: studioContextText is the scene brief", /^<studio-context>\nScene \(metres/.test(input.studioContextText ?? "") && input.studioContextText.endsWith("</studio-context>") && !input.studioContextText.includes("jump"), show(input.studioContextText));
expect("text is the user's text", input.text === "jump", String(input.text));
expect("frames pass through", same(t1.frames, [{ type: "text.delta", text: "hi" }, { type: "done" }]), show(t1.frames));
expect("res ended", t1.res.writableEnded === true);
expect("session turn cleared", t1.session.controller === null && t1.session.activeTurnId === null, show(t1.session));
expect("session host set", same(t1.session.host, { workspaceHandle: "w", workspaceId: "ws" }), show(t1.session.host));

const t2 = turn({ sessionId: "s2", sessionStore: { read: () => ({ history: [{ role: "user" }] }) } });
await t2.run;
expect("later turn: studioContextText is the state line", /^<studio-context>\nTrack: /.test(t2.captured[0]?.studioContextText ?? ""), show(t2.captured[0]?.studioContextText));

const t3 = turn({ sessionId: "s3", runnerFor: async () => { throw new Error("no proxy"); } });
await t3.run;
expect("runner failure: error then done", same(t3.frames, [{ type: "error", code: "upstream", message: "no proxy" }, { type: "done" }]), show(t3.frames));
expect("runner failure: res ended", t3.res.writableEnded === true);

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
process.exit(0);
