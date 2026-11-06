import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { ensureMcpRuntime } from "../mcp-runtime.mjs";
import { LiveCliError } from "./client.mjs";

/** `--op` for one operation or a list of them, `-f` for a file holding either;
 * `{ "ops": [...] }` additionally carries collisionPolicy. */
export function operationArguments(flags, verb, UsageError) {
	const file = flags.get("-f") ?? flags.get("--file");
	const hasFile = file !== undefined;
	const hasInline = flags.has("--op");
	if (hasFile === hasInline) throw new UsageError(`${verb} needs exactly one of --op '<json>' or -f ops.json`);
	let raw;
	if (hasFile) {
		try {
			raw = readFileSync(String(file), "utf8");
		} catch (error) {
			throw new UsageError(`could not read ${file}: ${error.message}`);
		}
	} else {
		raw = String(flags.get("--op"));
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new UsageError(`${hasFile ? String(file) : "--op"} is not valid JSON: ${error.message}`);
	}
	if (Array.isArray(parsed)) return { ops: parsed };
	if (parsed !== null && typeof parsed === "object") return Array.isArray(parsed.ops) ? parsed : { ops: [parsed] };
	throw new UsageError(`${verb} expects one operation object, an array of them, or { "ops": [ … ] }`);
}

export async function saveToFile(command, out, force) {
	if (!out.endsWith(".cclayproject")) throw new LiveCliError("USAGE", "--out must end in .cclayproject");
	const value = await command("describe", {});
	if (!Array.isArray(value?.document?.scenes) || !value.document.scenes.length) throw new LiveCliError("EDITOR_ERROR", "Live editor returned no scene document to save.");
	// A source checkout (a .git at the package root, as bin/cozyclay.mjs decides) imports mcp/ directly. An installed
	// package ships mcp/ too, but its src/ imports three, which installs do not carry, so it loads the staged MCP runtime.
	const module = existsSync(new URL("../../.git", import.meta.url))
		? await import("../../mcp/project-camera.mjs")
		: await import(pathToFileURL(join(await ensureMcpRuntime(), "mcp", "project-camera.mjs")).href);
	const serialized = module.serializeSavedProject({ ...value, name: value.name ?? value.sceneName });
	try {
		writeFileSync(out, serialized, { encoding: "utf8", flag: force ? "w" : "wx" });
	} catch (error) {
		if (error.code === "EEXIST") throw new LiveCliError("FILE_EXISTS", "The output file already exists; use --force to overwrite it.");
		throw error;
	}
	return { ok: true, path: out, bytes: Buffer.byteLength(serialized) };
}
