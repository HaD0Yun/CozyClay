import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS } from "@cclay/blender-tools";
import {
	assertDirectorToolConstructionPaths,
	DIRECTOR_TOOL_ALLOWLIST,
	UNCONDITIONAL_DIRECTOR_TOOLS,
} from "../src/session.ts";

// The embedded director session keeps a fixed tool allowlist.
//
// `ardy_regenerate`, `ardy_generate`, and `ardy_inbetween` are the authorized
// ARDY model surfaces. Each factory can only submit a closed request to its
// host-owned durable queue; all three are host-backed, so a session whose
// bridge carries no ARDY host omits them from the constructed set.

// This list is deliberately duplicated: that duplication is the point. Changing
// the catalog requires a matching deliberate edit here.
const EXPECTED_DIRECTOR_TOOL_ALLOWLIST = [
	"inspect_project",
	"inspect_bridge_state",
	"inspect_performance",
	"inspect_entity",
	"inspect_pose_contacts",
	"inspect_relations",
	"inspect_visual_qa_metrics",
	"preflight_motion",
	"capture_viewport",
	"read_image",
	"produce_directing_evidence",
	"stage_scene",
	"apply_camera_plan",
	"render_qa_frames",
	"repair_bridge",
	"apply_performance_mode",
	"create_fall_motion",
	"replace_camera_action",
	"ardy_regenerate",
	"ardy_generate",
	"ardy_inbetween",
	"execute_blender_python",
];

describe("director tool allowlist invariant", () => {
	it("is exactly the authorized director tools, in order", () => {
		assert.deepEqual(DIRECTOR_TOOL_ALLOWLIST, EXPECTED_DIRECTOR_TOOL_ALLOWLIST);
	});

	it("is derived from the embedded-eligible catalog", () => {
		assert.deepEqual(
			DIRECTOR_TOOL_ALLOWLIST,
			EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS.filter(({ embeddedEligible }) => embeddedEligible).map(({ name }) => name),
		);
	});

	it("includes exactly the three typed queued ARDY surfaces", () => {
		const catalogNames: readonly string[] = EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS.map(({ name }) => name);
		for (const name of ["ardy_regenerate", "ardy_generate", "ardy_inbetween"]) {
			assert.equal(catalogNames.includes(name), true, `catalog must include ${name}`);
		}
		assert.deepEqual(catalogNames.filter((name) => name.startsWith("ardy_")).sort(), [
			"ardy_generate",
			"ardy_inbetween",
			"ardy_regenerate",
		]);
	});

	it("has no duplicate catalog entries", () => {
		const catalogNames = EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS.map(({ name }) => name);
		assert.equal(new Set(catalogNames).size, catalogNames.length);
	});
	it("rejects an eligible catalog name with no construction path", () => {
		assert.throws(
			() => assertDirectorToolConstructionPaths(["inspect_project"], {}),
			/DIRECTOR_TOOL_ALLOWLIST_MISMATCH/,
		);
	});

	it("names every unconditional tool the session must always construct", () => {
		// These have no bridge precondition, so a construction path that yields
		// nothing for one of them is a defect rather than an absent capability.
		// Keep this list in step with the paths that ignore their bridge.
		assert.deepEqual([...UNCONDITIONAL_DIRECTOR_TOOLS], ["inspect_project", "read_image"]);
		const catalogNames: readonly string[] = EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS.map(({ name }) => name);
		for (const name of UNCONDITIONAL_DIRECTOR_TOOLS) {
			assert.equal(catalogNames.includes(name), true, `unconditional tool missing from catalog: ${name}`);
		}
	});
});
