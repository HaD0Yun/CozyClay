// How the v4 engine starts Claude Code: the child environment (the Studio's CLIProxyAPI credential,
// its own config home, append-only history), the sdk.query() options, and the proxy credential.
// Measured with the real binary against a fake upstream (design appendix B, probe P2): these options
// give model claude-opus-5-5, effort high, adaptive summarized thinking, our prompt as the top-level
// system text, only the cozyclay MCP tools, and Claude Code's own user agent.
import { readFileSync } from "node:fs";
import { resolveClaudeCodeExecutable } from "../claude-code-executable.mjs";
import { cliproxyBase } from "../cliproxy-provider.mjs";
import { V4_SYSTEM_PROMPT } from "./prompt.mjs";

const MODEL = "claude-opus-5-5";
const TOOL_NAMES = ["js", "track", "measure", "render", "qa"].map(name => `mcp__cozyclay__${name}`);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; } })();

// Names that would make Claude Code spend another credential or reach another gateway.
const DROPPED = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]);
const dropped = name => DROPPED.has(name) || /^CLAUDE_CODE_OAUTH_TOKEN/.test(name) || /^CLAUDE_CODE_USE_/.test(name);

/**
 * childEnv(parent, { baseUrl, token }, { configDir }) -> the env for the Claude Code process.
 * Keeps PATH, HOME and the rest of the parent; never log the result (it holds the proxy key).
 */
export function childEnv(parent, { baseUrl, token }, { configDir }) {
	const env = {};
	for (const [name, value] of Object.entries(parent ?? {})) if (typeof value === "string" && !dropped(name)) env[name] = value;
	return {
		...env,
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: token,
		CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_AGENT_SDK_CLIENT_APP: `cozyclay-v4/${VERSION}`,
		// The SDK session is the history: no compaction rewrites it.
		DISABLE_COMPACT: "1",
		DISABLE_AUTOUPDATER: "1",
		// The probe ran with this; it keeps telemetry and update checks off the proxy.
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		MAX_MCP_OUTPUT_TOKENS: "100000",
	};
}

/** The panel's effort in the SDK's words; the Studio wire also carries none, minimal and ultra. */
const sdkEffort = effort => (EFFORTS.has(effort) ? effort : effort === "ultra" ? "max" : effort === "none" || effort === "minimal" ? "low" : "high");

/**
 * queryOptions({ server, effort, sessionId, resume, cwd, env, abortController, executable }) -> sdk.query options.
 * Exactly one of sessionId (first turn) and resume (later turns) is set.
 */
export function queryOptions({ server, effort, sessionId, resume, cwd, env, abortController, executable }) {
	return {
		model: MODEL,
		effort: sdkEffort(effort),
		thinking: { type: "adaptive", display: "summarized" },
		tools: [],
		mcpServers: { cozyclay: server },
		allowedTools: TOOL_NAMES.slice(),
		permissionMode: "dontAsk",
		settingSources: [],
		strictMcpConfig: true,
		systemPrompt: V4_SYSTEM_PROMPT,
		includePartialMessages: true,
		persistSession: true,
		...(resume ? { resume } : { sessionId }),
		cwd,
		env,
		pathToClaudeCodeExecutable: executable ?? resolveClaudeCodeExecutable({ env }),
		...(abortController ? { abortController } : {}),
	};
}

/**
 * proxyAuth(models) -> { baseUrl, token } from the Studio's CLIProxyAPI provider: its key from
 * models.getAuth("cliproxy") (providers.mjs makes the same call), its address from the provider's
 * anthropic-messages model (no /v1), else cliproxyBase().
 */
export async function proxyAuth(models, { env = process.env } = {}) {
	let auth;
	try { auth = await models?.getAuth?.("cliproxy"); } catch { auth = undefined; }
	const token = auth?.auth?.apiKey;
	if (typeof token !== "string" || !token) throw Object.assign(new Error("v4 needs the CLIProxyAPI sign-in (its Claude models)."), { code: "auth" });
	let listed;
	try { listed = models?.getModels?.("cliproxy") ?? []; } catch { listed = []; }
	const model = listed.find(entry => entry?.api === "anthropic-messages" && typeof entry.baseUrl === "string");
	const baseUrl = model ? model.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") : cliproxyBase({ env, credential: auth });
	return { baseUrl, token };
}
