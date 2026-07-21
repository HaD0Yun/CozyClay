import assert from "node:assert/strict";
import test from "node:test";
import { OMB_SLASH_COMMANDS, parseSlashInput } from "../src/commands.ts";

test("non-slash input is a prompt and slash-like paths are not commands", () => {
	assert.deepEqual(parseSlashInput("move the laptop"), { kind: "prompt" });
	assert.deepEqual(parseSlashInput("  hi  "), { kind: "prompt" });
	// A path mid-sentence is a prompt; only a leading slash token is a command.
	assert.deepEqual(parseSlashInput("look at /tmp/scene"), { kind: "prompt" });
});

test("known commands parse with arguments", () => {
	assert.deepEqual(parseSlashInput("/help"), { kind: "command", name: "help", args: "" });
	assert.deepEqual(parseSlashInput("/export scene.md"), { kind: "command", name: "export", args: "scene.md" });
	assert.deepEqual(parseSlashInput("/quit"), { kind: "command", name: "quit", args: "" });
	assert.deepEqual(parseSlashInput("/EXIT"), { kind: "command", name: "exit", args: "" });
});

test("unknown slash input is reported, never forwarded as a prompt", () => {
	assert.deepEqual(parseSlashInput("/definitely-not-a-command now"), {
		kind: "unknown",
		name: "definitely-not-a-command",
	});
});

test("every pi builtin slash command name is recognized", () => {
	const piBuiltins = [
		"settings", "model", "scoped-models", "export", "import", "share", "copy",
		"name", "session", "changelog", "hotkeys", "fork", "clone", "tree", "trust",
		"login", "logout", "new", "compact", "resume", "reload", "quit",
	];
	const known = new Set(OMB_SLASH_COMMANDS.map((command) => command.name));
	for (const name of piBuiltins) {
		assert.equal(known.has(name), true, `pi builtin /${name} must be recognized by omb`);
		const parsed = parseSlashInput(`/${name}`);
		assert.equal(parsed.kind, "command", `/${name} must parse as a command`);
	}
});

test("omb director commands exist alongside the pi set", () => {
	const known = new Set(OMB_SLASH_COMMANDS.map((command) => command.name));
	for (const name of ["help", "attach", "blender", "status", "clear", "exit"]) {
		assert.equal(known.has(name), true, `/${name} must exist`);
	}
});
