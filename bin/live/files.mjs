import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { ensureMcpRuntime } from "../mcp-runtime.mjs";
import { LiveCliError } from "./client.mjs";
import { pngFromCaptureFrame, pngFromDataUrl } from "./studio.mjs";

export async function captureToFile(command, out, framing) {
	const value = await command(framing ? "capture_framing_png" : "capture_frame", {});
	const bytes = framing ? pngFromDataUrl(value?.dataUrl) : pngFromCaptureFrame(value);
	writeFileSync(out, bytes);
	return { path: out, width: value.width, height: value.height, bytes: bytes.byteLength, ...(!framing ? { assertions: value.assertions } : {}) };
}

export async function saveToFile(command, out, force) {
	if (!out.endsWith(".cclayproject")) throw new LiveCliError("USAGE", "--out must end in .cclayproject");
	const value = await command("describe", {});
	if (!Array.isArray(value?.document?.scenes) || !value.document.scenes.length) throw new LiveCliError("EDITOR_ERROR", "Live editor returned no scene document to save.");
	// A source checkout has mcp/ next to bin/; an installed package keeps it in the staged MCP runtime.
	const module = existsSync(new URL("../../mcp/project-camera.mjs", import.meta.url))
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
