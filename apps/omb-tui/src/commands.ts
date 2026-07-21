/**
 * Slash-command surface for the director TUI.
 *
 * Mirrors the pi coding-agent builtin command set so muscle memory carries
 * over, plus director-specific commands. Every leading-slash token is parsed
 * here first: a slash input NEVER reaches the model as a director turn.
 *
 * Commands act on one of three lanes:
 * - "local"  — handled entirely inside the TUI process
 * - "notice" — recognized pi command with no director equivalent; explains why
 *              and points at the closest workflow
 */

export interface OmbSlashCommand {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	/** pi commands that have no director-daemon equivalent map to a notice. */
	readonly notice?: string;
}

export type SlashParseResult =
	| { readonly kind: "prompt" }
	| { readonly kind: "command"; readonly name: string; readonly args: string }
	| { readonly kind: "unknown"; readonly name: string };

const PI_ONLY = (name: string, description: string, hint: string): OmbSlashCommand => ({
	name,
	description,
	notice: `/${name} (${description}) has no director equivalent — ${hint}`,
});

export const OMB_SLASH_COMMANDS: readonly OmbSlashCommand[] = [
	// Director-native commands.
	{ name: "help", description: "List available commands" },
	{ name: "status", description: "Show connection, turn, and project state" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "attach", description: "Issue a fresh Blender attach handoff" },
	{ name: "blender", description: "Launch Blender attached to this project" },
	{ name: "copy", description: "Copy the last director reply to the clipboard" },
	{ name: "export", description: "Export the transcript to a file", argumentHint: "[path]" },
	{ name: "clear", description: "Clear the transcript view (durable history is kept)" },
	{ name: "new", description: "Clear the transcript view (durable history is kept)" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "model", description: "Show the model this daemon was started with" },
	{ name: "quit", description: "Quit the director TUI (daemon keeps running)" },
	{ name: "exit", description: "Quit the director TUI (daemon keeps running)" },
	// pi builtins with no director-daemon equivalent: recognized, explained.
	PI_ONLY("settings", "settings menu", "daemon options are launch flags on the omb command"),
	PI_ONLY("scoped-models", "model cycling", "the director runs one pinned model per daemon"),
	PI_ONLY("import", "import a session", "the director transcript is durable in .omb/ per project"),
	PI_ONLY("share", "share as gist", "use /export and share the file"),
	PI_ONLY("name", "set session name", "director sessions are named by their project directory"),
	PI_ONLY("changelog", "show changelog", "see the oh-my-blender git log"),
	PI_ONLY("fork", "fork the session", "scene history is a revision chain; forking is not supported"),
	PI_ONLY("clone", "clone the session", "scene history is a revision chain; cloning is not supported"),
	PI_ONLY("tree", "navigate session tree", "scene history is a linear revision chain"),
	PI_ONLY("trust", "trust the project", "the daemon only ever runs its four typed Blender tools"),
	PI_ONLY("login", "provider login", "run: gjc /login (the omb launcher reads the gjc auth store)"),
	PI_ONLY("logout", "provider logout", "manage credentials with gjc"),
	PI_ONLY("compact", "compact context", "director turns are stateless against the durable scene"),
	PI_ONLY("resume", "resume a session", "run omb inside the project directory you want to resume"),
	PI_ONLY("reload", "reload config", "restart the TUI; the daemon and scene state survive"),
];

const COMMANDS_BY_NAME: ReadonlyMap<string, OmbSlashCommand> = new Map(
	OMB_SLASH_COMMANDS.map((command) => [command.name, command]),
);

export function findSlashCommand(name: string): OmbSlashCommand | undefined {
	return COMMANDS_BY_NAME.get(name.toLowerCase());
}

export function parseSlashInput(text: string): SlashParseResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "prompt" };
	const spaceIndex = trimmed.indexOf(" ");
	const token = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
	const name = token.toLowerCase();
	// A leading token with path separators ("/tmp/x") is not a command shape;
	// treat it as an unknown command rather than silently prompting the model,
	// because a real prompt starting with a bare path is almost always a typo.
	if (name.length === 0 || !/^[a-z][a-z0-9-]*$/.test(name)) {
		return { kind: "unknown", name: token };
	}
	if (!COMMANDS_BY_NAME.has(name)) return { kind: "unknown", name: token };
	const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { kind: "command", name, args };
}

export function formatCommandHelp(): string {
	const native = OMB_SLASH_COMMANDS.filter((command) => command.notice === undefined);
	const piOnly = OMB_SLASH_COMMANDS.filter((command) => command.notice !== undefined);
	const lines = ["Commands:"];
	for (const command of native) {
		const hint = command.argumentHint === undefined ? "" : ` ${command.argumentHint}`;
		lines.push(`  /${command.name}${hint} — ${command.description}`);
	}
	lines.push(`Recognized pi commands without a director equivalent: ${piOnly.map((c) => `/${c.name}`).join(" ")}`);
	return lines.join("\n");
}

/** Slash-only autocomplete: no file completion (path popups trap prompts). */
export class SlashCommandAutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: { value: string; label: string; description?: string }[]; prefix: string } | null> {
		if (cursorLine !== 0) return null;
		const before = (lines[0] ?? "").slice(0, cursorCol);
		if (!before.startsWith("/") || before.includes(" ") || before.includes("\t")) return null;
		const prefix = before.toLowerCase();
		const items = OMB_SLASH_COMMANDS
			.filter((command) => `/${command.name}`.startsWith(prefix))
			.map((command) => ({
				value: `/${command.name}`,
				label: command.argumentHint === undefined ? `/${command.name}` : `/${command.name} ${command.argumentHint}`,
				description: command.description,
			}));
		return items.length === 0 ? null : { items, prefix: before };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: { value: string },
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] ?? "";
		const start = Math.max(0, cursorCol - prefix.length);
		const nextLine = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
		const nextLines = [...lines];
		nextLines[cursorLine] = nextLine;
		return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
	}
}
