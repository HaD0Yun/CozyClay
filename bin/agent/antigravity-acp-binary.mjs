// Locating (and, on the user's sign-in click, fetching) Google's official antigravity-acp binary
// for the google-antigravity lane. CozyClay never bundles it (its license is proprietary,
// https://antigravity.google/terms): the archive comes from the ACP Registry's own entry
// (https://github.com/agentclientprotocol/registry, served from cdn.agentclientprotocol.com), is
// downloaded from dl.google.com as published, checked against the registry's sha256, unpacked
// unmodified into CozyClay's cache, and run as-is — what Zed and JetBrains do with the same entry.
// Order: ANTIGRAVITY_ACP_EXECUTABLE (a binary the user installed), then the cached download.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_AGENT_ID = "antigravity-acp";
// The registry entry as of 1.5.2: the fallback when the registry cannot be read.
export const PINNED_ENTRY = Object.freeze({
	version: "1.5.2",
	binary: {
		"darwin-aarch64": { archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip", cmd: "./agy_acp_server.par", sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845" },
		"darwin-x86_64": { archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-x86_64.zip", cmd: "./agy_acp_server.par", sha256: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06" },
		"linux-x86_64": { archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip", cmd: "./agy_acp_server.par", args: ["--uid="], sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852" },
		"linux-aarch64": { archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip", cmd: "./agy_acp_server.par", args: ["--uid="], sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb" },
		"windows-x86_64": { archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-x86_64.zip", cmd: "./agy_acp_server.exe", sha256: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6" },
		"windows-aarch64": { archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-arm64.zip", cmd: "./agy_acp_server.exe", sha256: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab" },
	},
});
// Only Google's own download host is accepted for the archive.
const OFFICIAL_ARCHIVE = /^https:\/\/dl\.google\.com\/agy-extensions\/releases\//;

/** The registry's platform key for this machine ("darwin-aarch64", "windows-x86_64", ...). */
export function platformKey(platform = process.platform, arch = process.arch) {
	const os = platform === "win32" ? "windows" : platform;
	const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
	return `${os}-${cpu}`;
}

function cacheRoot(env = process.env) {
	return join(env.XDG_CACHE_HOME || env.LOCALAPPDATA || join(homedir(), ".cache"), "cozyclay", "antigravity-acp");
}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const targetOf = (entry, key) => entry?.binary?.[key];
const installDir = (env, version, key) => join(cacheRoot(env), `${version}-${key}`);
const commandPath = (dir, cmd) => join(dir, cmd.replace(/^\.\//, ""));

/** `{ command, args, source }` for a usable binary, or `{ command: undefined, tried }`. Never downloads. */
export function locateAntigravityAcp({ env = process.env, platform = process.platform, arch = process.arch, entry = PINNED_ENTRY } = {}) {
	const tried = [];
	const override = env.ANTIGRAVITY_ACP_EXECUTABLE;
	if (override) {
		const path = isAbsolute(override) ? override : join(process.cwd(), override);
		tried.push(path);
		if (isFile(path)) return { command: path, args: [], source: "override", tried };
	}
	const key = platformKey(platform, arch);
	const target = targetOf(entry, key);
	if (target) {
		const path = commandPath(installDir(env, entry.version, key), target.cmd);
		tried.push(path);
		if (isFile(path)) return { command: path, args: target.args ?? [], source: "cache", version: entry.version, tried };
	}
	return { command: undefined, tried, supported: !!target };
}

/** The live registry entry for antigravity-acp, or the pinned one when the registry is unreachable. */
async function registryEntry({ fetch = globalThis.fetch } = {}) {
	try {
		const response = await fetch(REGISTRY_URL);
		if (!response.ok) return PINNED_ENTRY;
		const body = await response.json();
		const agent = (Array.isArray(body?.agents) ? body.agents : []).find((item) => item?.id === REGISTRY_AGENT_ID);
		return agent?.distribution?.binary && agent.version ? { version: agent.version, binary: agent.distribution.binary } : PINNED_ENTRY;
	} catch { return PINNED_ENTRY; }
}

/**
 * Resolves the binary, downloading the official archive first when none is present. `notify`
 * gets progress lines for the sign-in card. Throws (code ANTIGRAVITY_UNSUPPORTED / ANTIGRAVITY_INSTALL)
 * with what the user can do instead.
 */
export async function ensureAntigravityAcp({ env = process.env, platform = process.platform, arch = process.arch, fetch = globalThis.fetch, notify = () => {}, unzip = defaultUnzip } = {}) {
	const pinned = locateAntigravityAcp({ env, platform, arch });
	if (pinned.command) return pinned;
	const entry = await registryEntry({ fetch });
	const cached = locateAntigravityAcp({ env, platform, arch, entry });
	if (cached.command) return cached;
	const key = platformKey(platform, arch);
	const target = targetOf(entry, key);
	if (!target) throw Object.assign(new Error(`Google publishes no Antigravity agent for ${key}. Install it yourself and set ANTIGRAVITY_ACP_EXECUTABLE to its path.`), { code: "ANTIGRAVITY_UNSUPPORTED" });
	if (!OFFICIAL_ARCHIVE.test(target.archive)) throw Object.assign(new Error("The registry named a download outside dl.google.com; CozyClay refuses it."), { code: "ANTIGRAVITY_INSTALL" });
	notify({ type: "progress", message: `Downloading Google's Antigravity agent ${entry.version} from dl.google.com…` });
	const response = await fetch(target.archive);
	if (!response.ok) throw Object.assign(new Error(`The Antigravity agent download failed (HTTP ${response.status}).`), { code: "ANTIGRAVITY_INSTALL" });
	const bytes = Buffer.from(await response.arrayBuffer());
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (target.sha256 && digest !== target.sha256) throw Object.assign(new Error("The Antigravity agent download did not match the registry's checksum; nothing was installed."), { code: "ANTIGRAVITY_INSTALL" });
	const dir = installDir(env, entry.version, key);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const archive = join(dir, "download.zip");
	writeFileSync(archive, bytes);
	try {
		await unzip(archive, dir, platform);
	} finally { rmSync(archive, { force: true }); }
	const command = commandPath(dir, target.cmd);
	if (!existsSync(command)) throw Object.assign(new Error("The Antigravity agent archive did not contain its program."), { code: "ANTIGRAVITY_INSTALL" });
	if (platform !== "win32") chmodSync(command, 0o755);
	notify({ type: "progress", message: "Antigravity agent ready." });
	return { command, args: target.args ?? [], source: "cache", version: entry.version, tried: [command] };
}

async function defaultUnzip(archive, dir, platform) {
	const run = promisify(execFile);
	// Windows 10+ ships bsdtar as tar.exe, which reads zip; macOS and Linux have unzip.
	if (platform === "win32") await run("tar", ["-xf", archive, "-C", dir]);
	else await run("unzip", ["-oq", archive, "-d", dir]);
}
