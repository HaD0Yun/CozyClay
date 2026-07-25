import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guard-path coverage for the generation wrapper the ardy-motion skill drives.
 *
 * Every case here is rejected before the script reaches ssh/scp, so the suite
 * needs neither the ARDY box nor a GPU. That boundary is the point: a malformed
 * constrained request must fail locally with a directive message instead of
 * burning a remote generation or, worse, silently generating against swapped
 * axes.
 */
const WRAPPER = fileURLToPath(new URL("../../../scripts/cclay-ardy-generate", import.meta.url));

function makeProject(): string {
	const root = mkdtempSync(join(tmpdir(), "cclay-ardy-cli-"));
	mkdirSync(join(root, ".cclay", "motions"), { recursive: true });
	writeFileSync(join(root, ".cclay", "project.json"), "{}\n");
	return root;
}

/** Run the wrapper and return its exit code plus merged output. */
function run(project: string, args: string[]): { status: number; output: string } {
	try {
		const output = execFileSync(WRAPPER, ["x", "--project", project, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return {
			status: failure.status ?? -1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
		};
	}
}

describe("cclay-ardy-generate constraint guards", () => {
	it("rejects --constrain without a base motion", () => {
		const { status, output } = run(makeProject(), ["--constrain", "5", "LeftFoot", "0", "0", "0"]);
		assert.equal(status, 2);
		assert.match(output, /--constrain needs --base-motion/);
	});

	it("rejects --base-motion with nothing to constrain", () => {
		const { status, output } = run(makeProject(), ["--base-motion", "abc"]);
		assert.equal(status, 2);
		assert.match(output, /--base-motion is only used by --constrain/);
	});

	it("rejects a joint outside the four ARDY end effectors", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"Elbow",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /LeftFoot, RightFoot, LeftHand, or RightHand/);
	});

	it("rejects a non-numeric coordinate instead of passing it to the box", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0",
			"up",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /x y z must be numbers/);
	});

	it("accepts negative coordinates: npz space is signed around the motion origin", () => {
		// Rejected for the missing npz, NOT for the coordinates — proving the
		// numeric guard let -0.4 through.
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"missing-base",
			"--constrain",
			"5",
			"LeftFoot",
			"-0.4",
			"0.18",
			"-1.2",
		]);
		assert.equal(status, 1);
		assert.match(output, /base motion npz not found/);
		assert.doesNotMatch(output, /must be numbers/);
	});

	it("rejects constraints combined with segment mode", () => {
		const root = makeProject();
		try {
			const output = execFileSync(
				WRAPPER,
				[
					"--project",
					root,
					"--segment",
					"a person walks",
					"2",
					"--base-motion",
					"abc",
					"--constrain",
					"5",
					"LeftFoot",
					"0",
					"0",
					"0",
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			assert.fail(`expected a rejection, got: ${output}`);
		} catch (error) {
			const failure = error as { status?: number; stdout?: string; stderr?: string };
			assert.equal(failure.status, 2);
			assert.match(
				`${failure.stdout ?? ""}${failure.stderr ?? ""}`,
				/--constrain and --segment are mutually exclusive/,
			);
		}
	});
});
