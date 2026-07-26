import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Guaranteed-unreachable hostname: DNS resolution fails immediately, so the
// wrapper's first scp/ssh call errors out in milliseconds. Used to prove a
// well-formed invocation cleared every local guard and reached the point
// where it would talk to the ARDY box, without ever touching the real host.
const UNREACHABLE_HOST = "cclay-test-invalid-host.invalid";

function makeProject(): string {
	const root = mkdtempSync(join(tmpdir(), "cclay-ardy-cli-"));
	mkdirSync(join(root, ".cclay", "motions"), { recursive: true });
	writeFileSync(join(root, ".cclay", "project.json"), "{}\n");
	return root;
}

/** Stage an empty placeholder npz for a motion_id so local existence checks pass. */
function writeMotion(project: string, id: string): void {
	writeFileSync(join(project, ".cclay", "motions", `${id}.npz`), "");
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

/** Run the wrapper with no positional prompt (for --segment cases, which reject one). */
function runNoPrompt(project: string, args: string[]): { status: number; output: string } {
	try {
		const output = execFileSync(WRAPPER, ["--project", project, ...args], {
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

/**
 * Run the wrapper against an unreachable ARDY host and return its exit code
 * plus merged output. Local validation must have passed for the wrapper to
 * reach scp/ssh at all, so any exit here proves the well-formed case cleared
 * every guard without contacting the real box.
 */
function runToSsh(project: string, args: string[]): { status: number; output: string } {
	try {
		const output = execFileSync(WRAPPER, ["x", "--project", project, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CCLAY_ARDY_HOST: UNREACHABLE_HOST },
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
/**
 * Drive the wrapper PAST remote-command construction by shadowing ssh/scp on
 * PATH with fakes, so the suite can observe the exact command the wrapper
 * assembled at scripts/cclay-ardy-generate:393-410 instead of dying at the
 * first real scp.
 *
 * The fake scp exits 0 (it neither uploads nor downloads anything). The fake
 * ssh appends its full argv to a capture file and prints a one-line JSON
 * object with positive integer frames/fps so the wrapper's parser proceeds.
 * The wrapper still fails AFTER the captured generation ssh: the fake scp at
 * the download step writes no npz, so the subsequent chmod on the missing file
 * exits non-zero under `set -e`. That is expected and out of scope — the
 * captured command is the observation under test, not the final exit status.
 */
function runWithFakeTransport(
	project: string,
	args: string[],
): { status: number; output: string; sshRecords: string[][]; pythonCalls: number } {
	const binDir = mkdtempSync(join(tmpdir(), "cclay-ardy-fake-bin-"));
	// Keep the capture inside binDir so one recursive remove cleans everything.
	const capture = join(binDir, "ssh-argv.txt");
	// Fake scp: succeed without moving any bytes.
	const fakeScp = join(binDir, "scp");
	writeFileSync(fakeScp, `#!/bin/sh\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
	// Fake ssh: record its full argv and emit a minimal valid JSON line so the
	// wrapper's json_int/last-line parser proceeds past command construction.
	// Each invocation writes its argc first, then that many NUL-terminated
	// tokens, so one process is one record. A flat NUL stream cannot distinguish
	// two generation calls from one, which is exactly the cardinality this
	// harness has to assert. A double-NUL terminator would be ambiguous too,
	// because POSIX argv permits an EMPTY element, which encodes as a bare NUL;
	// argc framing is unambiguous since NUL itself cannot occur inside argv.
	// The capture path travels through the environment rather than being
	// interpolated into the script text: a TMPDIR containing whitespace or shell
	// metacharacters would otherwise break the redirection or be parsed as syntax.
	// The fake ssh RUNS the remote command in a fake remote root, rather than only
	// recording it. Counting occurrences of the script path in the command text is
	// not sound: `for _ in 1 2; do $REMOTE_CMD; done` mentions it once and runs it
	// twice. The stub `.venv/bin/python` records each invocation, so what gets
	// counted is remote process cardinality.
	const remoteRoot = join(binDir, "remote");
	const fakePython = join(remoteRoot, "ardy", ".venv", "bin", "python");
	mkdirSync(join(remoteRoot, "ardy", ".venv", "bin"), { recursive: true });
	mkdirSync(join(remoteRoot, "ardy", "scripts"), { recursive: true });
	writeFileSync(fakePython, `#!/bin/sh\necho "$@" >> "$CCLAY_FAKE_PY_CALLS"\nprintf '{"frames":60,"fps":20}\\n'\n`, {
		encoding: "utf8",
		mode: 0o755,
	});
	chmodSync(fakePython, 0o755);
	const pyCalls = join(binDir, "python-calls.txt");
	const fakeSsh = join(binDir, "ssh");
	writeFileSync(
		fakeSsh,
		`#!/bin/sh\n{ printf '%s\\0' "$#" "$@"; } >> "$CCLAY_FAKE_SSH_CAPTURE"\n` +
			`shift $(( $# - 1 ))\ncd "$CCLAY_FAKE_REMOTE_ROOT" || exit 1\nsh -c "$1"\n`,
		{ encoding: "utf8", mode: 0o755 },
	);
	chmodSync(fakeScp, 0o755);
	chmodSync(fakeSsh, 0o755);
	try {
		const output = execFileSync(WRAPPER, ["x", "--project", project, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				CCLAY_ARDY_HOST: "fake-host",
				CCLAY_FAKE_SSH_CAPTURE: capture,
				CCLAY_FAKE_REMOTE_ROOT: remoteRoot,
				CCLAY_FAKE_PY_CALLS: pyCalls,
			},
		});
		return { status: 0, output, sshRecords: readCapture(capture), pythonCalls: countLines(pyCalls) };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return {
			status: failure.status ?? -1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
			sshRecords: readCapture(capture),
			pythonCalls: countLines(pyCalls),
		};
	} finally {
		rmSync(binDir, { recursive: true, force: true });
	}
}

/**
 * One record per fake-ssh process, each record being that process's argv.
 *
 * The stream is argc-framed: each process wrote its argument count, then that
 * many NUL-terminated tokens. Consuming argc tokens at a time preserves record
 * boundaries even when an argv element is the empty string, which a double-NUL
 * terminator could not distinguish from a process boundary.
 */
function readCapture(capture: string): string[][] {
	let raw: string;
	try {
		raw = readFileSync(capture, "utf8");
	} catch {
		// No file means the wrapper never invoked the fake ssh. Zero records, and
		// the cardinality assertions fail rather than pass vacuously.
		return [];
	}
	const tokens = raw.split("\0");
	// The trailing NUL leaves one empty element; drop only that one.
	if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
	const records: string[][] = [];
	let index = 0;
	while (index < tokens.length) {
		const head = tokens[index] ?? "";
		// Fail closed: a lenient parse would let a truncated tail be discarded
		// silently, and one valid record plus corruption would still read as
		// exactly one.
		if (!/^\d+$/.test(head)) {
			throw new Error(`fake-ssh capture is malformed: expected argc, got ${JSON.stringify(head)}`);
		}
		const argc = Number.parseInt(head, 10);
		if (index + 1 + argc > tokens.length) {
			throw new Error(`fake-ssh capture is truncated: argc ${argc} exceeds the remaining tokens`);
		}
		records.push(tokens.slice(index + 1, index + 1 + argc));
		index += 1 + argc;
	}
	return records;
}

/** The argv records whose remote command runs the constrained generator. */
function generationRecords(records: string[][]): string[][] {
	return records.filter((record) => record.some((token) => token.includes(CONSTRAINED_SCRIPT)));
}

const CONSTRAINED_SCRIPT = "scripts/cclay_constrained_generate.py";

/**
 * How many times the captured remote commands would RUN the generator.
 *
 * One ssh record is not one remote execution: passing `"$REMOTE_CMD ||
 * $REMOTE_CMD"` to a single ssh keeps the record count at one while the remote
 * shell runs the generator twice. So count occurrences of the script path inside
 * the commands, not the transports carrying them.
 */
function countLines(path: string): number {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0).length;
	} catch {
		return 0;
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

describe("cclay-ardy-generate --constrain-orient/--constrain-pose/--constrain-path guards", () => {
	it("rejects --constrain-orient without a base motion", () => {
		const { status, output } = run(makeProject(), ["--constrain-orient", "5", "LeftFoot", "1", "0", "0", "0"]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient needs --base-motion/);
	});

	it("rejects --constrain-pose without a base motion", () => {
		const { status, output } = run(makeProject(), ["--constrain-pose", "abc", "1", "2"]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-pose needs --base-motion/);
	});

	it("rejects --constrain-path without a base motion", () => {
		const { status, output } = run(makeProject(), ["--constrain-path", "5", "0.1", "0.2", "none"]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-path needs --base-motion/);
	});

	it("rejects --constrain-orient combined with segment mode", () => {
		const root = makeProject();
		const { status, output } = runNoPrompt(root, [
			"--segment",
			"a person walks",
			"2",
			"--base-motion",
			"abc",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient and --segment are mutually exclusive/);
	});

	it("rejects --constrain-pose combined with segment mode", () => {
		const root = makeProject();
		const { status, output } = runNoPrompt(root, [
			"--segment",
			"a person walks",
			"2",
			"--base-motion",
			"abc",
			"--constrain-pose",
			"abc",
			"1",
			"2",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-pose and --segment are mutually exclusive/);
	});

	it("rejects --constrain-path combined with segment mode", () => {
		const root = makeProject();
		const { status, output } = runNoPrompt(root, [
			"--segment",
			"a person walks",
			"2",
			"--base-motion",
			"abc",
			"--constrain-path",
			"5",
			"0.1",
			"0.2",
			"none",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-path and --segment are mutually exclusive/);
	});

	it("rejects a non-integer --constrain-orient frame", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain-orient",
			"five",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient frame must be a non-negative integer/);
	});

	it("rejects a non-numeric --constrain-orient quaternion component", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1",
			"0",
			"sideways",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient qw qx qy qz must be numbers/);
	});

	it("rejects an unknown --constrain-orient joint", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain-orient",
			"5",
			"Elbow",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /LeftFoot, RightFoot, LeftHand, or RightHand/);
	});

	it("rejects a --constrain-path heading that is neither numeric nor 'none'", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain-path",
			"5",
			"0.1",
			"0.2",
			"sideways",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-path heading must be a number or 'none'/);
	});

	it("rejects a --constrain-pose src-motion-id whose npz does not exist", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, ["--base-motion", "abc", "--constrain-pose", "missing-pose", "1", "2"]);
		assert.equal(status, 1);
		assert.match(output, /--constrain-pose source motion npz not found/);
	});

	it("accepts a well-formed --constrain-orient paired with a matching --constrain and reaches the point where it would ssh", () => {
		// An ARDY end-effector constraint conditions position AND rotation on the
		// same frame+joint, so --constrain-orient is only well-formed when a
		// --constrain pins the same joint at the same frame. The unit quaternion
		// (1,0,0,0) has norm 1.0, inside the remote's abs(norm-1.0) <= 1e-3 band.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /no matching --constrain/);
		assert.doesNotMatch(output, /must be a unit quaternion/);
	});

	it("rejects a --constrain-orient with no matching --constrain at the same frame+joint, locally", () => {
		// Mirrors the remote parse_orientations rule: an orientation alone is a
		// half-specified pose, so the request must die before ssh instead of
		// loading the model and failing on the box.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient LeftFoot at frame 5 has no matching --constrain/);
		assert.doesNotMatch(output, /syncing/);
	});

	it("rejects a --constrain-orient whose joint differs from the only --constrain, locally", () => {
		// Same rule, different joint at the same frame: the pair is still
		// unanchored because the position targets the other end effector.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"5",
			"RightHand",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient RightHand at frame 5 has no matching --constrain/);
		assert.doesNotMatch(output, /syncing/);
	});

	it("rejects a --constrain-orient whose frame differs from the only --constrain, locally", () => {
		// Same rule, same joint at a different frame: position and rotation no
		// longer describe one pose.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"6",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient LeftFoot at frame 6 has no matching --constrain/);
		assert.doesNotMatch(output, /syncing/);
	});

	it("rejects a non-unit --constrain-orient quaternion locally, not on the box", () => {
		// (1.5,0,0,0) has norm 1.5; the remote requires abs(norm-1.0) <= 1e-3.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1.5",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /must be a unit quaternion, got norm 1\.500000/);
		assert.doesNotMatch(output, /syncing/);
	});

	it("accepts a --constrain-orient quaternion at the near-unit boundary norm 1.001 and reaches the point where it would ssh", () => {
		// abs(1.001 - 1.0) == 1e-3, exactly the remote tolerance, so this is
		// the last accepted value just inside the band.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1.001",
			"0",
			"0",
			"0",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /must be a unit quaternion/);
	});

	it("rejects a --constrain-orient quaternion just outside the unit band (norm 1.0011), locally", () => {
		// abs(1.0011 - 1.0) == 1.1e-3 > 1e-3, the first rejected value.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0.1",
			"0.2",
			"0.3",
			"--constrain-orient",
			"5",
			"LeftFoot",
			"1.0011",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /must be a unit quaternion, got norm 1\.001100/);
		assert.doesNotMatch(output, /syncing/);
	});

	it("accepts a well-formed --constrain-pose and reaches the point where it would ssh", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		writeMotion(root, "other");
		const { status, output } = runToSsh(root, ["--base-motion", "abc", "--constrain-pose", "other", "1", "2"]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /source motion npz not found/);
	});

	it("accepts a well-formed --constrain-path and reaches the point where it would ssh", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--base-motion",
			"abc",
			"--constrain-path",
			"5",
			"0.1",
			"-0.2",
			"none",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /heading must be a number/);
	});
});

describe("cclay-ardy-generate clip frame range guards", () => {
	it("caps --duration at the add-on's own 24000-frame ceiling", () => {
		// Not an arbitrary bound: 1200 s x 20 fps == motion_retarget.MAX_FRAMES, so a
		// longer clip could never be applied even if the box generated it. The cap
		// also keeps duration * 20 inside awk's integer range -- printf "%d"
		// saturates at LLONG_MAX for a ~19-digit duration, which silently clamped
		// the frame limit BELOW the real bound and began rejecting valid frames
		// (red-team round-2 finding R2-B1).
		for (const duration of ["1200.1", "999999999999999999999", "0"]) {
			const { status, output } = run(makeProject(), [
				"--duration",
				duration,
				"--base-motion",
				"abc",
				"--constrain",
				"10",
				"LeftFoot",
				"0",
				"0",
				"0",
			]);
			assert.equal(status, 2, `duration ${duration} must be rejected`);
			assert.match(output, /--duration must be > 0 and <= 1200 seconds/);
			assert.doesNotMatch(output, /syncing/, "must not reach scp");
		}
	});
	it("rejects a constrained --duration whose int(duration*20) is under 3 frames, locally", () => {
		// Mirrors the remote cclay_constrained_generate.py main() floor:
		// int(duration * fps) < 3 is rejected because inter-frame continuity
		// is undefined below three frames. The wrapper uses the SAME
		// int(duration * 20) truncation as CLIP_FRAME_LIMIT, so 0.05 -> 1
		// frame and 0.10 -> 2 frames both die before ssh.
		for (const duration of ["0.05", "0.1"]) {
			const { status, output } = run(makeProject(), [
				"--duration",
				duration,
				"--base-motion",
				"abc",
				"--constrain",
				"0",
				"LeftFoot",
				"0",
				"0",
				"0",
			]);
			assert.equal(status, 2, `duration ${duration} must be rejected`);
			assert.match(output, /a clip needs at least 3 so inter-frame continuity is defined/);
			assert.doesNotMatch(output, /syncing/, "must not reach scp");
		}
	});

	it("accepts the constrained --duration boundary 0.15 (int(0.15*20)==3) and reaches the point where it would ssh", () => {
		// int(0.15 * 20) == 3 is the first duration the remote accepts; frame 2
		// is the last valid clip frame (< 3), proving the floor and the frame
		// bound agree on the boundary.
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--duration",
			"0.15",
			"--base-motion",
			"abc",
			"--constrain",
			"2",
			"LeftFoot",
			"0",
			"0",
			"0",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /a clip needs at least 3/);
	});

	it("rejects a --constrain frame equal to duration * 20 (first invalid frame)", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"100",
			"LeftFoot",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain frame must satisfy 0 <= frame < 100/);
	});

	it("accepts a --constrain frame just below duration * 20 (last valid frame) and reaches the point where it would ssh", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"99",
			"LeftFoot",
			"0",
			"0",
			"0",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /out of range/);
	});

	it("rejects the 20-digit --constrain-orient frame from the reproducer without reaching ssh", () => {
		// No writeMotion(): the frame-range guard must fire before the base
		// motion's npz existence is even checked, so this proves the huge
		// frame is caught purely by the local range check.
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain-orient",
			"99999999999999999999",
			"LeftFoot",
			"1",
			"0",
			"0",
			"0",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-orient frame must satisfy 0 <= frame < 100/);
		assert.doesNotMatch(output, /syncing constrained script/);
	});

	it("rejects a --constrain-pose dst-frame equal to duration * 20", () => {
		const { status, output } = run(makeProject(), ["--base-motion", "abc", "--constrain-pose", "other", "1", "100"]);
		assert.equal(status, 2);
		assert.match(output, /--constrain-pose dst-frame frame must satisfy 0 <= frame < 100/);
	});

	it("computes the clip frame bound from --duration even when --duration appears after the constraint flag", () => {
		// duration 1 -> limit 20 frames; frame 30 is only rejected if the
		// wrapper picks up the --duration that comes AFTER --constrain,
		// proving the bound is computed once parsing is fully done, not
		// inline while --constrain is parsed.
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"30",
			"LeftFoot",
			"0",
			"0",
			"0",
			"--duration",
			"1",
		]);
		assert.equal(status, 2);
		assert.match(output, /--constrain frame must satisfy 0 <= frame < 20 \(duration 1s at 20 fps\)/);
	});
});

describe("cclay-ardy-generate --contact-threshold/--root-margin guards", () => {
	it("rejects --contact-threshold without a base motion", () => {
		const { status, output } = run(makeProject(), ["--contact-threshold", "0.6"]);
		assert.equal(status, 2);
		assert.match(output, /--contact-threshold needs --base-motion/);
	});

	it("rejects --root-margin without a base motion", () => {
		const { status, output } = run(makeProject(), ["--root-margin", "0.1"]);
		assert.equal(status, 2);
		assert.match(output, /--root-margin needs --base-motion/);
	});

	it("rejects --contact-threshold given twice", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0",
			"0",
			"0",
			"--contact-threshold",
			"0.3",
			"--contact-threshold",
			"0.4",
		]);
		assert.equal(status, 2);
		assert.match(output, /--contact-threshold may only be given once/);
	});

	it("rejects --root-margin given twice", () => {
		const { status, output } = run(makeProject(), [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0",
			"0",
			"0",
			"--root-margin",
			"0.1",
			"--root-margin",
			"0.2",
		]);
		assert.equal(status, 2);
		assert.match(output, /--root-margin may only be given once/);
	});

	for (const threshold of ["0", "1", "1.5"]) {
		it(`rejects --contact-threshold ${threshold}`, () => {
			const { status, output } = run(makeProject(), [
				"--base-motion",
				"abc",
				"--constrain",
				"5",
				"LeftFoot",
				"0",
				"0",
				"0",
				"--contact-threshold",
				threshold,
			]);
			assert.equal(status, 2);
			assert.match(output, /--contact-threshold must be a number strictly between 0 and 1/);
		});
	}

	for (const margin of ["-0.1", "0.6"]) {
		it(`rejects --root-margin ${margin}`, () => {
			const { status, output } = run(makeProject(), [
				"--base-motion",
				"abc",
				"--constrain",
				"5",
				"LeftFoot",
				"0",
				"0",
				"0",
				"--root-margin",
				margin,
			]);
			assert.equal(status, 2);
			assert.match(output, /--root-margin must be a number 0\.\.0\.5/);
		});
	}

	it("accepts the --contact-threshold boundaries 0.001 and 0.999", () => {
		for (const threshold of ["0.001", "0.999"]) {
			const root = makeProject();
			writeMotion(root, "abc");
			const { status, output } = runToSsh(root, [
				"--base-motion",
				"abc",
				"--constrain",
				"5",
				"LeftFoot",
				"0",
				"0",
				"0",
				"--contact-threshold",
				threshold,
			]);
			assert.notEqual(status, 2, `threshold ${threshold}: ${output}`);
			assert.match(output, /syncing constrained script and base motion/);
			assert.doesNotMatch(output, /must be a number strictly between/);
		}
	});

	it("accepts the --root-margin boundaries 0 and 0.5", () => {
		for (const margin of ["0", "0.5"]) {
			const root = makeProject();
			writeMotion(root, "abc");
			const { status, output } = runToSsh(root, [
				"--base-motion",
				"abc",
				"--constrain",
				"5",
				"LeftFoot",
				"0",
				"0",
				"0",
				"--root-margin",
				margin,
			]);
			assert.notEqual(status, 2, `margin ${margin}: ${output}`);
			assert.match(output, /syncing constrained script and base motion/);
			assert.doesNotMatch(output, /must be a number 0\.\.0\.5/);
		}
	});

	it("accepts a well-formed combined --contact-threshold/--root-margin invocation and reaches the point where it would ssh", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = runToSsh(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0",
			"0",
			"0",
			"--contact-threshold",
			"0.6",
			"--root-margin",
			"0.1",
		]);
		assert.notEqual(status, 2);
		assert.match(output, /syncing constrained script and base motion/);
		assert.doesNotMatch(output, /needs --base-motion/);
		assert.doesNotMatch(output, /must be a number/);
	});

	it("rejects --samples as an unknown option before reaching ssh", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { status, output } = run(root, [
			"--base-motion",
			"abc",
			"--constrain",
			"5",
			"LeftFoot",
			"0",
			"0",
			"0",
			"--samples",
			"3",
		]);
		assert.equal(status, 2);
		assert.match(output, /unknown option --samples/);
		assert.doesNotMatch(output, /syncing constrained script and base motion/);
	});
});

// The constrained remote-command construction block
// (scripts/cclay-ardy-generate:393-410) is unreachable under runToSsh: the
// fake unreachable host kills the wrapper at the first scp, BEFORE the block
// runs. These tests shadow ssh/scp on PATH so the wrapper proceeds past the
// sync step, assembles REMOTE_CMD, and invokes the fake ssh — whose captured
// argv is a real observation of that block executing, not a simulation. The
// wrapper is expected to fail AFTER the captured ssh (the fake scp download
// writes no npz, so the post-download chmod exits non-zero); we assert on the
// captured command, not the final status.
describe("cclay-ardy-generate constrained remote command construction", () => {
	const BASE_ARGS = ["--base-motion", "abc", "--constrain", "5", "LeftFoot", "0.1", "0.2", "0.3"] as const;

	it("runs the constrained generator exactly once and forwards the script plus --prompt/--base/--output", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { sshRecords, pythonCalls } = runWithFakeTransport(root, [...BASE_ARGS]);
		// Non-empty only if the wrapper actually invoked ssh past the sync step;
		// runToSsh dies at scp and would leave this empty.
		assert.notEqual(sshRecords.length, 0, "wrapper never reached the ssh remote-command call");
		const generations = generationRecords(sshRecords);
		// Cardinality, and EXECUTIONS rather than transports or command text. One
		// ssh record is not one execution, because `"$REMOTE_CMD || $REMOTE_CMD"`
		// is one record and two runs; and counting the script path in the command
		// is not either, because `for _ in 1 2; do $REMOTE_CMD; done` mentions it
		// once and runs it twice. So the fake ssh executes the command and a stub
		// remote python records every invocation.
		assert.equal(generations.length, 1, `expected exactly one constrained generation ssh, got ${generations.length}`);
		assert.equal(pythonCalls, 1, "the remote command must RUN the generator exactly once");
		const remote = generations[0].join(" ");
		assert.match(remote, /--prompt/);
		assert.match(remote, /--base/);
		assert.match(remote, /--output/);
	});

	it("does not forward --num-samples (best-of-N sampling was removed)", () => {
		const root = makeProject();
		writeMotion(root, "abc");
		const { sshRecords, pythonCalls } = runWithFakeTransport(root, [...BASE_ARGS]);
		const generations = generationRecords(sshRecords);
		assert.equal(generations.length, 1, "wrapper never reached the ssh remote-command call");
		assert.equal(pythonCalls, 1, "one real remote generator execution");
		assert.doesNotMatch(generations[0].join(" "), /--num-samples/);
	});

	it("forwards --contact-threshold and --root-margin when given, proving the harness can observe forwarding", () => {
		// This is the vacuity guard for the --num-samples test above: if the
		// harness could not observe the forwarding block at all, the
		// --num-samples assertion would pass trivially. Real flags that the
		// block forwards (scripts/cclay-ardy-generate:408-409) MUST appear.
		const root = makeProject();
		writeMotion(root, "abc");
		const { sshRecords, pythonCalls } = runWithFakeTransport(root, [
			...BASE_ARGS,
			"--contact-threshold",
			"0.6",
			"--root-margin",
			"0.1",
		]);
		const generations = generationRecords(sshRecords);
		assert.equal(generations.length, 1, "wrapper never reached the ssh remote-command call");
		assert.equal(pythonCalls, 1, "one real remote generator execution");
		const remote = generations[0].join(" ");
		assert.match(remote, /--contact-threshold/);
		assert.match(remote, /--root-margin/);
	});
});
