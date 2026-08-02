// Shared host-side runner plumbing for the three ARDY queues (regenerate,
// generate, in-between). All three run the SAME wrapper script from the
// repository, with the same execFile discipline and the same stage_scene
// apply binding, so the constants, the argv-array wrapper runner, and the
// apply_motion plan builder live here once instead of once per runner.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StageSceneRequestV1 } from "@cclay/protocol";
import { ARDY_REGENERATE_WRAPPER, type ArdyCliResult, type ArdyCliRunner } from "@cclay/director-runtime";

// Long because a constrained ARDY run goes out to a GPU box over ssh and back.
// A wrapper that hangs past this is a stuck run, and killing it produces a
// recorded failure the animator can see instead of a queue that never moves.
export const CLI_TIMEOUT_MS = 30 * 60 * 1000;
// stdout is one JSON line; anything approaching this is a runaway.
export const CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TICK_MS = 5_000;
// The wrapper ships with the repository, not with the project directory the
// host runs in: `cwd` is the animator's .blend folder, which has no scripts/.
// Resolved from this module so it survives being launched from anywhere.
// All three ARDY queues share the one wrapper script.
export const REPO_WRAPPER_PATH = fileURLToPath(
	new URL(`../../../scripts/${ARDY_REGENERATE_WRAPPER}`, import.meta.url),
);

// argv is passed as an array to execFile, never a shell string, so a
// constraint coordinate cannot escape its positional slot.
export function runWrapper(wrapperPath: string, cwd: string): ArdyCliRunner {
	return (argv: readonly string[]): Promise<ArdyCliResult> =>
		new Promise((resolve) => {
			execFile(
				wrapperPath,
				[...argv],
				{ cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER_BYTES },
				(error, stdout, stderr) => {
					// A non-zero exit is data, not an exception: the queue turns
					// it into a recorded failure so the add-on can recover the
					// rig instead of waiting forever.
					const status =
						error === null ? 0 : typeof error.code === "number" ? error.code : 1;
					resolve({ status, stdout, stderr: error === null ? stderr : `${stderr}${error.message}` });
				},
			);
		});
}

/**
 * The apply_motion the generated clip needs, expressed as a stage_scene
 * plan so it travels the same validated, committed path every other mutation
 * takes. Building a second application route would be a second place for the
 * revision bookkeeping to be wrong.
 */
export function applyMotionRequest(
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
): StageSceneRequestV1 {
	return {
		schema_version: 1,
		expected_revision_id: expectedRevisionId,
		operations: [{ op: "apply_motion", entity_id: entityId, motion_id: motionId }],
	};
}
