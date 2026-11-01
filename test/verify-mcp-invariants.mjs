#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRECTORIES = ["src", "tools", "bin", "mcp"];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const ROOT_DEPENDENCY_ALLOWLIST = Object.freeze({
	// the anthropic-subscription lane spawns the official Claude Code binary through the SDK
	"@anthropic-ai/claude-agent-sdk": "^0.3.306",
	"@earendil-works/pi-agent-core": "1.4.0",
	"@earendil-works/pi-ai": "1.4.0",
	"@earendil-works/pi-codemode": "1.4.0",
	// JSON Schema → Zod shape for the SDK's tool() definitions (SDK already depends on zod)
	zod: "^4.6.7",
});
const MCP_DEPENDENCY_BASELINE = Object.freeze({
	"@modelcontextprotocol/sdk": "^1.32.2",
	// compare_sculpt decodes JPEG references locally (#730); BSD-3-Clause, no dependencies.
	"jpeg-js": "0.4.4",
	ws: "^8.19.0",
	zod: "^3.25.0",
});
const RAW_EXECUTION_ARGUMENTS = new Set([
	"code", "script", "scriptpath", "expression", "eval", "command", "cmd", "shell", "source",
]);
const CRDT_PACKAGES = ["yjs", "automerge", "loro", "sharedb", "ot-json0", "ot-text"];
const PROTOCOL_PATTERNS = [
	/["']tasks\/(?:get|result|list|update)["']/,
	/["']server\/discover["']/,
	/resultType\s*:\s*["']input_required["']/,
	/["']2026-07-28["']/,
];
const EXECUTABLE_ENTRYPOINTS = ["bin/cozyclay.mjs", "mcp/server.mjs"];

function filesBelow(directory) {
	return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory() && entry.name === "node_modules") return [];
		if (entry.isDirectory()) return filesBelow(path);
		return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
	}).sort();
}

function readSources() {
	return Object.fromEntries(
		SOURCE_DIRECTORIES.flatMap(filesBelow).map((path) => [path, readFileSync(resolve(ROOT, path), "utf8")]),
	);
}

function lineAt(source, offset) {
	return source.slice(0, offset).split("\n").length;
}

function matches(source, pattern) {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	const expression = new RegExp(pattern.source, flags);
	return [...source.matchAll(expression)];
}

function sourceFailures(sources, pattern, label) {
	return Object.entries(sources).flatMap(([path, source]) =>
		matches(source, pattern).map((match) => `${label} ${path}:${lineAt(source, match.index)} ${match[0]}`),
	);
}

// The tools are declared in mcp/tool-handlers.mjs as `tool("name", {...})`
// entries and registered from there by mcp/server.mjs, which may still call
// `registerTool("name", {...})` directly. Both shapes are scanned, so moving a
// tool between the two files cannot quietly drop it out of this contract.
const TOOL_DECLARATION_SITES = [
	{ path: "mcp/tool-handlers.mjs", keyword: "tool" },
	{ path: "mcp/server.mjs", keyword: "registerTool" },
];

function toolBlocks(source, keyword = "registerTool") {
	const registrations = [...source.matchAll(new RegExp(`(?<![\\w$.])${keyword}\\(\\s*\\n\\s*["']([^"']+)["']`, "g"))];
	return registrations.map((match, index) => ({
		name: match[1],
		body: source.slice(match.index, registrations[index + 1]?.index),
		line: lineAt(source, match.index),
	}));
}

function liveHandlers(app) {
	const start = app.indexOf("const liveQueries = {");
	if (start < 0) return [];
	const body = app.slice(start, app.indexOf("\n\t};", start));
	return [...body.matchAll(/^\t{2,3}([a-z][a-z0-9_]*)\s*(?::|,)/gm)].map((match, index, all) => ({
		name: match[1],
		line: lineAt(app, start + match.index),
		body: body.slice(match.index, all[index + 1]?.index),
	}));
}

function schemaBody(body) {
	const start = body.indexOf("inputSchema:");
	const open = body.indexOf("{", start);
	if (start < 0 || open < 0) return "";
	let depth = 0;
	for (let index = open; index < body.length; index += 1) {
		if (body[index] === "{") depth += 1;
		if (body[index] === "}") depth -= 1;
		if (depth === 0) return body.slice(open + 1, index);
	}
	return "";
}

function rawArgumentFailures(scope, name, body, line, path, pattern) {
	return matches(body, pattern)
		.filter((match) => RAW_EXECUTION_ARGUMENTS.has(match[1].replaceAll(/[_-]/g, "").toLowerCase()))
		.map((match) => `G009 ${scope} ${name} accepts raw execution argument ${match[1]} at ${path}:${line + lineAt(body, match.index) - 1}`);
}

function verifyG009(sources) {
	const server = sources["mcp/server.mjs"] ?? "";
	const app = sources["src/App.jsx"] ?? "";
	const tools = TOOL_DECLARATION_SITES.flatMap(({ path, keyword }) =>
		toolBlocks(sources[path] ?? "", keyword).map((tool) => ({ ...tool, path })),
	);
	const handlers = liveHandlers(app);
	const failures = [
		// A rename that stops this parser finding the tools would turn every check
		// below into a vacuous pass, so an empty scan is itself a failure.
		...(tools.length === 0 ? [`G009 no MCP tool declarations found in ${TOOL_DECLARATION_SITES.map(({ path }) => path).join(" or ")}`] : []),
		...tools.flatMap((tool) => rawArgumentFailures("tool", tool.name, schemaBody(tool.body), tool.line, tool.path, /\b([A-Za-z_$][\w$-]*)\s*:/g)),
		...handlers.flatMap((handler) => rawArgumentFailures("live handler", handler.name, handler.body, handler.line, "src/App.jsx", /\bargs\.([A-Za-z_$][\w$-]*)\b/g)),
	];
	const handlerSources = {
		"mcp/server.mjs": server,
		"mcp/tool-handlers.mjs": sources["mcp/tool-handlers.mjs"] ?? "",
		"mcp/live-hub.mjs": sources["mcp/live-hub.mjs"] ?? "",
		"src/live-control.js": sources["src/live-control.js"] ?? "",
		"src/App.jsx": app,
	};
	for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\b/, /(?:node:)?vm\b/, /node:child_process|\bchild_process\b/, /(?<!\.)\b(?:spawn|exec|execFile|fork)\s*\(/, /\bimport\s*\(/]) {
		failures.push(...sourceFailures(handlerSources, pattern, "G009 forbidden execution primitive"));
	}
	return { failures, tools, handlers };
}

function verifyG010(sources) {
	const failures = [];
	for (const [path, source] of Object.entries(sources)) {
		for (const match of matches(source, /(?:\bimport\s+|\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)/g)) {
			if (CRDT_PACKAGES.some((name) => match[1] === name || match[1].startsWith(`${name}/`))) {
				failures.push(`G010 CRDT/OT import ${match[1]} at ${path}:${lineAt(source, match.index)}`);
			}
		}
	}
	const requiredPath = [
		["mcp/server.mjs", "createToolHandlers("],
		["mcp/tool-handlers.mjs", 'liveHub.command("run_action",'],
		["mcp/live-hub.mjs", 'type: "cmd"'],
		["src/live-control.js", "dispatchLiveFrame"],
		// Sculpt mode taps finished results on the way out; the handlers themselves are unchanged.
		["src/App.jsx", "handlers: sculptTap.wrap({ ...liveQueries, ...studioBindingRef.current.handlers })"],
		["src/studio-app-binding.js", "commandBus().run("],
	];
	for (const [path, token] of requiredPath) {
		if (!sources[path]?.includes(token)) failures.push(`G010 mutation path is missing ${path} -> ${token}`);
	}
	return { failures };
}

function verifyG012(sources) {
	const mcpSources = Object.fromEntries(Object.entries(sources).filter(([path]) => path.startsWith("mcp/")));
	return { failures: PROTOCOL_PATTERNS.flatMap((pattern) => sourceFailures(mcpSources, pattern, "G012 unsupported protocol construct")) };
}

function sameObject(left, right) {
	const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function verifyG013(packages) {
	const rootDependencies = packages.root.dependencies ?? {};
	const mcpDependencies = packages.mcp.dependencies ?? {};
	return {
		failures: [
			...(sameObject(rootDependencies, ROOT_DEPENDENCY_ALLOWLIST) ? [] : [`G013 root runtime dependencies must equal the pi allow-list: ${JSON.stringify(rootDependencies)}`]),
			...(sameObject(mcpDependencies, MCP_DEPENDENCY_BASELINE) ? [] : [`G013 mcp runtime dependencies drifted from baseline: ${JSON.stringify(mcpDependencies)}`]),
		],
	};
}

function verifyExecutableEntrypoints(entrypointModes) {
	return {
		failures: Object.entries(entrypointModes).flatMap(([path, mode]) =>
			(mode & 0o111) === 0 ? [`published entrypoint is not executable: ${path} mode=${(mode & 0o777).toString(8)}`] : [],
		),
	};
}

function isLoopbackConstant(source, value) {
	return new RegExp(`\\b(?:const|let)\\s+${value}\\s*=\\s*["']127\\.0\\.0\\.1["']`).test(source);
}

function loopbackSites(sources) {
	const listeners = [];
	const urls = [];
	const failures = [
		...sourceFailures(sources, /0\.0\.0\.0|\bINADDR_ANY\b/, "G014 non-loopback bind"),
	];
	for (const [path, source] of Object.entries(sources)) {
		for (const match of matches(source, /(?:\b\w+\.)?listen\s*\(|\bnew\s+WebSocketServer\s*\(/g)) {
			const line = lineAt(source, match.index);
			const call = source.slice(match.index, source.indexOf("\n", match.index) + 240);
			const allowed = /["']127\.0\.0\.1["']/.test(call)
				|| [...call.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)].some((name) => isLoopbackConstant(source, name[1]));
			listeners.push(`${path}:${line}`);
			if (!allowed) failures.push(`G014 listener is not bound to 127.0.0.1 at ${path}:${line}`);
		}
		for (const match of matches(source, /(?:https?|wss?):\/\/([^/"'`\s:]+)(?::\d+)?/g)) {
			const line = lineAt(source, match.index);
			const parserBase = source.slice(Math.max(0, match.index - 32), match.index).includes("new URL(");
			if (parserBase || !/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0)$/.test(match[1])) continue;
			urls.push(`${path}:${line} ${match[0]}`);
			if (match[1] !== "127.0.0.1") failures.push(`G014 client URL is not 127.0.0.1 at ${path}:${line}: ${match[0]}`);
		}
	}
	return { failures, listeners, urls };
}

function packages() {
	return {
		root: JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")),
		mcp: JSON.parse(readFileSync(resolve(ROOT, "mcp/package.json"), "utf8")),
	};
}

// NTFS has no executable bit, so on Windows read the mode git will publish from the index.
function indexMode(path) {
	return Number.parseInt(execFileSync("git", ["ls-files", "--stage", "--", path], { cwd: ROOT, encoding: "utf8" }).split(" ")[0], 8);
}

function entrypointModes() {
	return Object.fromEntries(EXECUTABLE_ENTRYPOINTS.map((path) => [path, process.platform === "win32" ? indexMode(path) : statSync(resolve(ROOT, path)).mode]));
}

function runChecks(sources, manifest, modes) {
	return [verifyG009(sources), verifyG010(sources), verifyG012(sources), verifyG013(manifest), loopbackSites(sources), verifyExecutableEntrypoints(modes)];
}

function selfTest(name, checks) {
	const failure = checks.flatMap((check) => check.failures)[0];
	if (!failure) throw new Error(`self-test ${name} did not fail`);
	console.log(`SELF-TEST ${name} detector rejected fixture: ${failure}`);
}

function runSelfTests() {
	selfTest("G009", [verifyG009({ "mcp/server.mjs": 'registerTool(\n"run", { inputSchema: { code: z.string() } }, async () => eval("x"));', "src/App.jsx": "" })]);
	selfTest("G009 registry", [verifyG009({ "mcp/tool-handlers.mjs": 'tool(\n"run", { inputSchema: { command: z.string() } }, async () => 0);', "src/App.jsx": "" })]);
	selfTest("G009 empty scan", [verifyG009({ "src/App.jsx": "" })]);
	selfTest("G010", [verifyG010({ "mcp/server.mjs": 'import y from "yjs";', "mcp/live-hub.mjs": 'const frame = { type: "cmd" };', "src/live-control.js": "dispatchLiveFrame", "src/App.jsx": "liveHandlersRef.current = {" })]);
	selfTest("G012", [verifyG012({ "mcp/server.mjs": 'const method = "tasks/get";' })]);
	selfTest("G013", [verifyG013({ root: { dependencies: { ...ROOT_DEPENDENCY_ALLOWLIST } }, mcp: { dependencies: { ...MCP_DEPENDENCY_BASELINE, drift: "1.0.0" } } })]);
	selfTest("G013 extra root dependency", [verifyG013({ root: { dependencies: { ...ROOT_DEPENDENCY_ALLOWLIST, "left-pad": "1.0.0" } }, mcp: { dependencies: { ...MCP_DEPENDENCY_BASELINE } } })]);
	selfTest("G013 non-exact root pin", [verifyG013({ root: { dependencies: { ...ROOT_DEPENDENCY_ALLOWLIST, "@earendil-works/pi-ai": "^0.85.1" } }, mcp: { dependencies: { ...MCP_DEPENDENCY_BASELINE } } })]);
	selfTest("G014", [loopbackSites({ "mcp/server.mjs": 'server.listen(5173, "0.0.0.0");' })]);
	selfTest("executable entrypoints", [verifyExecutableEntrypoints({ "mcp/server.mjs": 0o100644, "bin/cozyclay.mjs": 0o100755 })]);
}

runSelfTests();
const sources = readSources();
const modes = entrypointModes();
const [g009, g010, g012, g013, g014, executableEntrypoints] = runChecks(sources, packages(), modes);
const failures = [g009, g010, g012, g013, g014, executableEntrypoints].flatMap((check) => check.failures);
console.log(`G009 MCP tools scanned=${g009.tools.length} across ${[...new Set(g009.tools.map((tool) => tool.path))].join(", ")}: ${g009.tools.map((tool) => tool.name).join(", ")}`);
console.log(`G009 live handlers scanned=${g009.handlers.length}: ${g009.handlers.map((handler) => handler.name).join(", ")}`);
console.log("G010 agent mutation path: MCP registry -> tool handler -> run_action WebSocket frame -> dispatchLiveFrame -> Studio binding -> command bus");
console.log(`G010 source files scanned=${Object.keys(sources).length}; CRDT/OT imports=0`);
console.log(`G012 MCP source files scanned=${Object.keys(sources).filter((path) => path.startsWith("mcp/")).length}; unsupported protocol constructs=0`);
console.log(`G013 root runtime dependencies allow-list=${Object.keys(ROOT_DEPENDENCY_ALLOWLIST).join(", ")}; MCP baseline=${JSON.stringify(MCP_DEPENDENCY_BASELINE)}`);
console.log(`G014 listen sites checked=${g014.listeners.length}: ${g014.listeners.join(", ")}`);
console.log(`G014 loopback client URL sites checked=${g014.urls.length}: ${g014.urls.join(", ")}`);
console.log(`Executable entrypoints checked=${EXECUTABLE_ENTRYPOINTS.length}: ${EXECUTABLE_ENTRYPOINTS.map((path) => `${path}=${(modes[path] & 0o777).toString(8)}`).join(", ")}`);
if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL ${failure}`);
	process.exit(1);
}
console.log("PASS MCP invariants G009, G010, G012, G013, G014 and executable entrypoints");
