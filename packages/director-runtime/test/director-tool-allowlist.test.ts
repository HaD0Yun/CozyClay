import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIRECTOR_TOOL_ALLOWLIST } from "../src/session.ts";

// The embedded director session keeps a fixed tool allowlist.
//
// Why this test exists: the ARDY constraint-regeneration feature exposes a
// mutating generation surface (ardy_regenerate / ardy_generate). It would be
// convenient to hand that surface to the embedded director by adding its tool
// name to DIRECTOR_TOOL_ALLOWLIST. Doing so dissolves the product boundary:
// the LLM would drive the shader/generator directly, so what the user sees is
// no longer the deterministic pipeline the director is supposed to orchestrate
// but whatever the model improvises turn to turn. The regeneration surface must
// stay on the host side (a bridge the director can call into only through the
// authorized mutating tools it already has), never as a director tool in its
// own right. Lock the closed four-tool set down so any such addition fails this
// test before it can ship.

describe("director tool allowlist invariant", () => {
	it("is exactly the authorized director tools, in order", () => {
		assert.deepEqual(DIRECTOR_TOOL_ALLOWLIST, [
			"inspect_project",
			"inspect_bridge_state",
			"inspect_performance",
			"inspect_visual_qa_metrics",
			"stage_scene",
			"apply_camera_plan",
			"render_qa_frames",
			"repair_bridge",
			"apply_performance_mode",
			"create_fall_motion",
			"replace_camera_action",
		]);
	});

	it("admits no ardy/generate/regenerate tool name", () => {
		for (const name of DIRECTOR_TOOL_ALLOWLIST) {
			assert.doesNotMatch(name, /ardy|generat/i, `allowlist leaks a generation tool: ${name}`);
		}
	});

	it("has no duplicate or extra entries beyond the authorized set", () => {
		// `as const` makes the tuple readonly and length-typed at compile time;
		// this is the runtime mirror that catches a reordered or padded array
		// slipped past the type system.
		assert.equal(DIRECTOR_TOOL_ALLOWLIST.length, 11);
		assert.equal(new Set(DIRECTOR_TOOL_ALLOWLIST).size, 11);
	});
});
