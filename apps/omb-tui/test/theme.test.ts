import assert from "node:assert/strict";
import test from "node:test";
import { createTheme } from "../src/theme.ts";
import { TranscriptViewport } from "../src/transcript-viewport.ts";
import type { DirectorTurnEvent } from "@oh-my-blender/protocol";

const at = new Date().toISOString();

function started(sequence: number, prompt: string): DirectorTurnEvent {
	return { type: "director_turn_started", id: `id-${sequence}`, sequence, at, prompt };
}

test("createTheme(true) emits ANSI styles and createTheme(false) is passthrough", () => {
	const on = createTheme(true);
	const off = createTheme(false);
	assert.match(on.accent("x"), /^\x1b\[[0-9;]+mx\x1b\[[0-9;]+m$/);
	assert.match(on.muted("x"), /^\x1b\[[0-9;]+mx\x1b\[[0-9;]+m$/);
	assert.equal(off.accent("x"), "x");
	assert.equal(off.ok("x"), "x");
	assert.equal(off.bold("x"), "x");
});

test("viewport styles prompts and tool lifecycle events", () => {
	let height = 40;
	const viewport = new TranscriptViewport({ getHeight: () => height });
	viewport.accept(started(0, "stage a cube"));
	viewport.accept({
		type: "director_tool_call_started",
		id: "id-0",
		sequence: 1,
		at,
		tool_call_id: "tc-1",
		tool_name: "stage_scene",
		params_summary: "stage_scene(operations)",
	});
	viewport.accept({
		type: "director_tool_call_finished",
		id: "id-0",
		sequence: 2,
		at,
		tool_call_id: "tc-1",
		tool_name: "stage_scene",
		is_error: false,
		result_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	});
	viewport.accept({
		type: "director_turn_failed",
		id: "id-0",
		sequence: 3,
		at,
		code: "STALE_BASE",
		message: "expected revision moved",
		retryable: true,
	});
	const output = viewport.render(120).join("\n");
	assert.match(output, /❯ stage a cube/);
	assert.match(output, /⚙ stage_scene/);
	assert.match(output, /✓ stage_scene/);
	assert.doesNotMatch(output, /a{20}/, "long result digests must be truncated");
	assert.match(output, /✗ STALE_BASE: expected revision moved/);
});

test("viewport separates consecutive turns with a blank line", () => {
	const viewport = new TranscriptViewport({ getHeight: () => 40 });
	viewport.accept(started(0, "first"));
	viewport.accept(started(1, "second"));
	const lines = viewport.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
	const first = lines.findIndex((line) => line.includes("first"));
	const second = lines.findIndex((line) => line.includes("second"));
	assert.notEqual(first, -1);
	assert.notEqual(second, -1);
	assert.equal(lines.slice(first + 1, second).some((line) => line === ""), true, "turns must be visually separated");
});
