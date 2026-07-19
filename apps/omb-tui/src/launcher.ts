import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parseStartupRecord, type StartupRecord } from "@oh-my-blender/protocol";

const BASE_ENVIRONMENT_ALLOWLIST = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	"TEMP",
	"TMP",
	"SYSTEMROOT",
] as const;
const DAEMON_TERMINATION_TIMEOUT_MS = 250;

const PROVIDER_CREDENTIALS: Readonly<Record<string, string>> = {
	"ant-ling": "ANT_LING_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	huggingface: "HF_TOKEN",
	"kimi-coding": "KIMI_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	minimax: "MINIMAX_API_KEY",
	mistral: "MISTRAL_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	openai: "OPENAI_API_KEY",
	"openai-codex": "OPENAI_CODEX_ACCESS_TOKEN",
	"opencode-go": "OPENCODE_API_KEY",
	opencode: "OPENCODE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	together: "TOGETHER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	xai: "XAI_API_KEY",
	"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
	zai: "ZAI_API_KEY",
};

export interface LaunchDaemonOptions {
	readonly projectDirectory: string;
	readonly repositoryRoot: string;
	readonly daemonArguments: readonly string[];
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly runtimeBaseDirectory?: string;
	readonly startupTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface LaunchedDaemon {
	readonly startup: StartupRecord;
	readonly child: ChildProcess;
}

async function verifiedExecutable(configured: string): Promise<string> {
	if (!path.isAbsolute(configured)) {
		throw new Error("DAEMON_EXECUTABLE_UNSAFE: executable path must be absolute");
	}
	let metadata;
	let resolved: string;
	try {
		[metadata, resolved] = await Promise.all([lstat(configured), realpath(configured)]);
		await access(configured, constants.X_OK);
	} catch {
		throw new Error("DAEMON_EXECUTABLE_UNSAFE: executable could not be safely resolved");
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (metadata.isSymbolicLink() || !metadata.isFile() || resolved !== configured || (uid !== undefined && metadata.uid !== uid)) {
		throw new Error("DAEMON_EXECUTABLE_UNSAFE: executable must be an owned executable regular nonsymlink file");
	}
	return resolved;
}

function flagValue(arguments_: readonly string[], flag: string): string | undefined {
	const index = arguments_.indexOf(flag);
	if (index === -1 || arguments_.lastIndexOf(flag) !== index || index === arguments_.length - 1) return undefined;
	return arguments_[index + 1];
}

function validateDaemonArguments(arguments_: readonly string[]): void {
	if (arguments_.length === 1 && arguments_[0] === "--faux") return;
	if (
		arguments_.length !== 4 ||
		arguments_[0] !== "--provider" ||
		arguments_[2] !== "--model" ||
		!arguments_[1] ||
		!arguments_[3]
	) {
		throw new Error("INVALID_ARGUMENT: use --faux or --provider <id> --model <id>");
	}
}

function isolatedEnvironment(
	arguments_: readonly string[],
	source: Readonly<Record<string, string | undefined>>,
	runtimeBaseDirectory: string | undefined,
	repositoryRoot: string,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of BASE_ENVIRONMENT_ALLOWLIST) {
		if (source[name]) environment[name] = source[name];
	}
	if (runtimeBaseDirectory !== undefined) {
		environment.XDG_RUNTIME_DIR = runtimeBaseDirectory;
		environment.TMPDIR = runtimeBaseDirectory;
	}
	environment.TSX_TSCONFIG_PATH = path.join(repositoryRoot, "tsconfig.json");
	const provider = flagValue(arguments_, "--provider");
	if (provider !== undefined) {
		const credentialName = PROVIDER_CREDENTIALS[provider];
		if (credentialName === undefined) throw new Error(`UNSUPPORTED_PROVIDER: provider '${provider}' does not support isolated boot`);
		const credential = source[credentialName];
		if (!credential?.trim()) throw new Error(`MISSING_CREDENTIAL: ${credentialName} must contain a nonempty API key`);
		environment[credentialName] = credential;
	}
	return environment;
}

async function resolveTsxLoader(repositoryRoot: string): Promise<string> {
	let directory = repositoryRoot;
	while (true) {
		const candidate = path.join(directory, "node_modules/tsx/dist/loader.mjs");
		try {
			const metadata = await lstat(candidate);
			if (metadata.isFile() && !metadata.isSymbolicLink()) return await realpath(candidate);
		} catch {}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("NOT_CONFIGURED: tsx runtime is unavailable");
}

async function commandFor(options: LaunchDaemonOptions): Promise<{ executable: string; arguments: string[] }> {
	const installed = options.environment.OMB_DAEMON_EXECUTABLE;
	const node = options.environment.OMB_NODE_EXECUTABLE;
	if (installed !== undefined && node !== undefined) {
		throw new Error("INVALID_ARGUMENT: both OMB_DAEMON_EXECUTABLE and OMB_NODE_EXECUTABLE are set");
	}
	if (installed === undefined && node === undefined) {
		throw new Error("NOT_CONFIGURED: set OMB_DAEMON_EXECUTABLE or OMB_NODE_EXECUTABLE");
	}
	if (installed !== undefined) {
		return { executable: await verifiedExecutable(installed), arguments: ["--port", "0", ...options.daemonArguments] };
	}
	const executable = await verifiedExecutable(node!);
	const tsxLoader = await resolveTsxLoader(options.repositoryRoot);
	return {
		executable,
		arguments: [
			"--import",
			tsxLoader,
			path.join(options.repositoryRoot, "apps/omb-daemon/src/main.ts"),
			"--port",
			"0",
			...options.daemonArguments,
		],
	};
}

function readStartup(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<StartupRecord> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("CONTROLLER_RECONNECT_ABORTED"));
			return;
		}
		if (child.stdout === null) return reject(new Error("DAEMON_START_FAILED: startup stdout is unavailable"));
		let buffer = "";
		let settled = false;
		const finish = (error: Error | undefined, record?: StartupRecord) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.off("error", onError);
			child.off("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve(record!);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > 64 * 1024) return finish(new Error("DAEMON_START_FAILED: startup record exceeded limit"));
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const record = parseStartupRecord(JSON.parse(buffer.slice(0, newline)));
				if (record.pid !== child.pid) throw new Error("startup pid mismatch");
				finish(undefined, record);
			} catch {
				finish(new Error("DAEMON_START_FAILED: invalid startup record"));
			}
		};
		const onError = () => finish(new Error("DAEMON_START_FAILED: daemon process could not start"));
		const onExit = () => finish(new Error("DAEMON_START_FAILED: daemon exited before startup"));
		const onAbort = () => finish(new Error("CONTROLLER_RECONNECT_ABORTED"));
		const timer = setTimeout(() => finish(new Error("DAEMON_START_FAILED: startup timed out")), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function waitForExit(child: ChildProcess, timeoutMs?: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const onExit = () => {
			if (timer !== undefined) clearTimeout(timer);
			resolve(true);
		};
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				child.off("exit", onExit);
				resolve(false);
			}, timeoutMs);
		}
		child.once("exit", onExit);
	});
}

export async function terminateDaemon(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.ref();
	try {
		if (!child.kill("SIGTERM")) return;
		if (await waitForExit(child, DAEMON_TERMINATION_TIMEOUT_MS)) return;
		if (!child.kill("SIGKILL")) return;
		await waitForExit(child);
	} finally {
		child.unref();
	}
}

export async function launchDaemon(options: LaunchDaemonOptions): Promise<LaunchedDaemon> {
	if (options.signal?.aborted) throw new Error("CONTROLLER_RECONNECT_ABORTED");
	validateDaemonArguments(options.daemonArguments);
	const command = await commandFor(options);
	const environment = isolatedEnvironment(
		options.daemonArguments,
		options.environment,
		options.runtimeBaseDirectory,
		options.repositoryRoot,
	);
	if (options.signal?.aborted) throw new Error("CONTROLLER_RECONNECT_ABORTED");
	const child = spawn(command.executable, command.arguments, {
		cwd: options.projectDirectory,
		detached: true,
		env: environment,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
	try {
		const startup = await readStartup(child, options.startupTimeoutMs ?? 5_000, options.signal);
		child.stdout?.destroy();
		child.unref();
		return { startup, child };
	} catch (error) {
		await terminateDaemon(child);
		throw error;
	}
}
