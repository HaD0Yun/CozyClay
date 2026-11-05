/**
 * What a terminal controller has to know about the Studio command surface:
 * which editor to talk to, how an admitted command is framed, and how the
 * bytes an editor answers with become a PNG on disk.
 *
 * Everything here is JSON in and JSON out. The schemas live in
 * src/studio-agent-protocol.js and stay there: the editor validates every
 * envelope it receives, so a copy of those rules in the CLI would only be a
 * second source of truth that can drift.
 */
import { randomUUID } from "node:crypto";

import { LiveCliError } from "./client.mjs";
import { selectWorkspaceRule } from "./workspace.mjs";

/** The four fields that name one document incarnation on one workspace. */
const IDENTITY = ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"];

/**
 * The hub never guesses which editor a command reaches, so neither does this.
 * `pickWorkspace` in bin/agent/agent-tools.mjs makes the same choice for the
 * Agent panel via the shared `selectWorkspaceRule`: prefer the tab the
 * operator authors in, fall back to the Workflow page's embedded Studio, and
 * refuse anything ambiguous. The CLI only needs `capture_framing_png` to
 * consider an editor authoring-capable; it never imports assets on its own.
 */
export function selectWorkspace(editors, requested) {
	return selectWorkspaceRule({ details: editors, requested, requiredCommands: ["capture_framing_png"] });
}

/** Status as a terminal reads it: the labels an operator recognises, not the
 * raw hello meta. */
export const describeEditors = (editors) => editors.map((editor) => ({
	handle: editor.handle,
	project: editor.meta?.project ?? null,
	scene: editor.meta?.scene ?? null,
	cast: editor.meta?.cast ?? null,
	embed: editor.meta?.embed === true,
	connectedAt: editor.connectedAt ?? null,
	lastSeenMs: editor.lastSeenMs ?? null,
	inFlight: editor.inFlight ?? 0,
}));

/**
 * The admission envelope, built from one `inspect_studio {scope:"selection"}`
 * read: the document this command was authored against and the scene revision
 * it expects. The editor rejects the command outright when either moved; it
 * carries no per-entity tokens, because the scene revision already bumps on
 * every authored change and a retired token only refuses a legitimate retry.
 */
export function admissionEnvelope(name, args, inspected) {
	// inspect_studio answers the host and revision at its top level; an older
	// editor embedded a whole context. Admission needs only those two.
	const context = inspected?.context ?? inspected;
	if (!context?.host || !context.revision) {
		throw new LiveCliError("EDITOR_ERROR", "The editor did not return a Studio context to admit this command against.");
	}
	const host = Object.fromEntries(IDENTITY.map((key) => [key, context.host[key]]));
	return {
		name,
		args,
		commandId: randomUUID(),
		host,
		expectedRevision: context.revision.scene,
	};
}

export function pngFromDataUrl(dataUrl) {
	const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === "string" ? dataUrl.trim() : "");
	if (!match) throw new LiveCliError("EDITOR_ERROR", "The editor answered without PNG bytes.");
	return Buffer.from(match[1], "base64");
}

export function pngFromCaptureFrame(value) {
	if (typeof value?.data !== "string" || value.encoding !== "base64") {
		throw new LiveCliError("EDITOR_ERROR", "The editor answered capture_frame without inline base64 PNG bytes.");
	}
	return Buffer.from(value.data, "base64");
}

/** Several visual references share one --out: the first takes the given name,
 * the rest are numbered beside it. */
export function numberedPath(path, index) {
	if (index === 0) return path;
	const dot = path.lastIndexOf(".");
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return dot > slash ? `${path.slice(0, dot)}-${index + 1}${path.slice(dot)}` : `${path}-${index + 1}`;
}

/** Optional inspect filters and entity paging, shared with the CLI parser. */
export function inspectArguments(flags, integerFlag) {
	const args = {};
	if (flags.has("--ids")) args.ids = String(flags.get("--ids")).split(",").map(value => value.trim()).filter(Boolean);
	for (const key of ["query", "cursor"]) if (flags.has(`--${key}`)) args[key] = String(flags.get(`--${key}`));
	if (flags.has("--limit")) args.limit = integerFlag(flags, "--limit");
	return args;
}
