// The turn's CozyClay tools as an MCP server the Antigravity agent connects to (ACP session/new
// `mcpServers`, type "http"): the same host-handoff the Claude lane builds with the SDK's MCP
// server. tools/list advertises pi's tool schemas; tools/call never runs anything — it reports the
// call to the stream (which hands it to CozyClay's harness and ends the turn) and answers with the
// handoff note. Loopback only, one random bearer secret per turn, gone when the turn ends.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const TOOL_SERVER_NAME = "cozyclay-tools";
const TOOL_HANDOFF_MESSAGE = "Not an error: this is the normal host handoff. " +
	"CozyClay runs this tool on the host and returns its result as the next user message. " +
	"Stop here and wait for that result; do not mention this message to the user.";
const MCP_PROTOCOL_FALLBACK = "2025-06-18";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** pi tools → MCP tool definitions (pi's parameters already are JSON Schema). */
function mcpToolDefinitions(piTools = []) {
	return piTools.map((tool) => ({
		name: tool.name,
		description: typeof tool.description === "string" ? tool.description : "",
		inputSchema: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
	}));
}

/**
 * Starts the bridge. `onToolCall({ name, arguments })` sees every call. Resolves to
 * `{ server: <ACP McpServerHttp>, close() }`.
 */
export async function startToolBridge(piTools, { onToolCall } = {}) {
	const secret = randomBytes(24).toString("hex");
	const tools = mcpToolDefinitions(piTools);
	const known = new Set(tools.map((tool) => tool.name));
	const answer = (message) => {
		const { id, method, params } = message ?? {};
		if (id === undefined || id === null) return undefined; // notifications/* need no reply
		const result = (value) => ({ jsonrpc: "2.0", id, result: value });
		if (method === "initialize") {
			return result({
				protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_FALLBACK,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: TOOL_SERVER_NAME, version: "1.0.0" },
			});
		}
		if (method === "ping") return result({});
		if (method === "tools/list") return result({ tools });
		if (method === "tools/call") {
			const name = params?.name;
			if (!known.has(name)) return result({ content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
			const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
			try { onToolCall?.({ name, arguments: args }); } catch { /* the handoff note still goes back */ }
			return result({ content: [{ type: "text", text: TOOL_HANDOFF_MESSAGE }], isError: true });
		}
		return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
	};
	const server = createServer((req, res) => {
		if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401).end(); return; }
		if (req.method === "DELETE") { res.writeHead(200).end(); return; }
		if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (res.writableEnded) return;
			let body;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
				res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
				return;
			}
			const replies = (Array.isArray(body) ? body : [body]).map(answer).filter(Boolean);
			if (!replies.length) { res.writeHead(202).end(); return; }
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "cozyclay" });
			res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	return {
		server: {
			type: "http",
			name: TOOL_SERVER_NAME,
			url: `http://127.0.0.1:${port}/mcp`,
			headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
		},
		close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
	};
}
