// The first-pass generate service: exact unconstrained argv, the staleness
// guard, the ARDY_HOST_UNAVAILABLE / GENERATION_FAILED split, and the
// commit-before-apply ordering. Everything runs through a fake CLI runner and
// a fake archive -- the wrapper itself shells to a GPU box over ssh, which
// no unit test can do, and the wrapper's own guard behavior is covered by
// test/ardy-generate-cli.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArdyGenerateRequestV1, ArdyGenerateResultV1 } from "@cclay/protocol";
import {
	type ArdyGenerateApplyMotionDispatch,
	ArdyGenerateApplyMotionError,
	type ArdyGenerateCliRunner,
	ArdyGenerateGenerationError,
	ArdyGenerateHostUnavailableError,
	ArdyGenerateInvalidRequestError,
	ArdyGenerateRevisionMismatchError,
	createArdyGenerateHandler,
} from "../src/ardy-generate-service.ts";
import type { DirectorHandlerContext } from "../src/inspect-service.ts";

const revision = "a".repeat(64);
const entityId = "00000000-0000-4000-8000-000000000001";
// The add-on mints request ids as uuid4 hex (32 chars), used verbatim as
// filenames; the fixture is a real one.
const requestId = "0123456789abcdef0123456789abcdef";

// A minimal schema-valid generate request. seed is the only optional field.
const baseRequest: ArdyGenerateRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	expected_revision_id: revision,
	prompt: "a person waves both hands",
	duration_seconds: 5,
	seed: 7,
	requested_at_ms: 1_700_000_000_000,
};

// The wrapper's unconstrained-mode stdout: one JSON line carrying motion_id,
// frames, fps, the requested duration echo (duration_s), and the measured
// continuity. The handler projects it into the generate result schema.
function wrapperJson(overrides: Partial<{ motion_id: string; frames: number; duration_s: number }> = {}): string {
	const motionId = overrides.motion_id ?? "wave-hands-01";
	return JSON.stringify({
		motion_id: motionId,
		frames: overrides.frames ?? 100,
		fps: 20,
		duration_s: overrides.duration_s ?? 5,
		path: `.cclay/motions/${motionId}.npz`,
		continuity: { mean_jump_m: 0.012, max_jump_m: 0.04, max_jump_frame: 47 },
	});
}

function makeContext(): DirectorHandlerContext {
	return { signal: new AbortController().signal };
}

// A fake CLI runner that records the argv it received and returns a canned
// wrapper stdout. Tests override status/stdout/stderr to inject failures.
function makeRunner(canned: Partial<{ status: number; stdout: string; stderr: string }> = {}): {
	runner: ArdyGenerateCliRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner: ArdyGenerateCliRunner = (argv) => {
		calls.push([...argv]);
		return {
			status: canned.status ?? 0,
			stdout: canned.stdout ?? wrapperJson(),
			stderr: canned.stderr ?? "",
		};
	};
	return { runner, calls };
}

// A fake apply_motion dispatch that records its inputs and returns a new
// revision. Tests override it to inject a failure.
function makeDispatch(
	overrides: Partial<{
		resultingRevisionId: string;
		throwError: Error;
	}> = {},
): {
	dispatch: ArdyGenerateApplyMotionDispatch;
	calls: { motionId: string; entityId: string; revision: string }[];
} {
	const calls: { motionId: string; entityId: string; revision: string }[] = [];
	const dispatch: ArdyGenerateApplyMotionDispatch = async (motionId, entityId, expectedRevisionId) => {
		calls.push({ motionId, entityId, revision: expectedRevisionId });
		if (overrides.throwError !== undefined) throw overrides.throwError;
		return { resulting_revision_id: overrides.resultingRevisionId ?? "b".repeat(64) };
	};
	return { dispatch, calls };
}

function createHandler(
	runCli: ArdyGenerateCliRunner,
	applyMotion: ArdyGenerateApplyMotionDispatch,
	liveRevision: string = revision,
) {
	return createArdyGenerateHandler({
		runCli,
		applyMotion,
		liveRevisionId: () => liveRevision,
		archive: {
			async commitGenerated(): Promise<void> {},
		},
	});
}

test("generate argv: a minimal request is exactly prompt, --duration, and nothing else", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	const minimal: ArdyGenerateRequestV1 = { ...baseRequest, seed: null };
	await handler(minimal, makeContext());

	assert.equal(calls.length, 1);
	assert.deepEqual(
		calls[0],
		["a person waves both hands", "--duration", "5"],
		"the unconstrained first pass must carry the prompt positional, --duration, and NO --base-motion",
	);
	assert.ok(!calls[0]!.includes("--base-motion"), "--base-motion must be absent from the generate argv");
	assert.ok(!calls[0]!.includes("--seed"), "--seed must be absent when the request has no seed");
	assert.ok(!calls[0]!.includes("--constrain"), "no constraint flag may reach the unconstrained wrapper");
});

test("generate argv: a seeded request adds exactly --seed <n>, and a fractional duration keeps its fixed-point form", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	const seeded: ArdyGenerateRequestV1 = { ...baseRequest, duration_seconds: 0.15 };
	await handler(seeded, makeContext());

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], ["a person waves both hands", "--duration", "0.15", "--seed", "7"]);
	assert.ok(!calls[0]!.includes("--base-motion"), "--base-motion must be absent from the generate argv");
});

test("generate argv: an exponent-form duration is rejected as an invalid request before any CLI call", async () => {
	// The wrapper validates --duration as ^[0-9]+([.][0-9]+)?$; 1e-7 is a
	// schema-valid duration (0 < d <= 1200) that would only fail on the box.
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	const request: ArdyGenerateRequestV1 = { ...baseRequest, duration_seconds: 1e-7 };
	await assert.rejects(handler(request, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateInvalidRequestError && error.code === "INVALID_ARDY_GENERATE_REQUEST";
	});
	assert.equal(calls.length, 0, "the wrapper must not run with an unrepresentable duration");
	assert.equal(dispatchCalls.length, 0);
});

test("generate success: the parsed result, the archive commit, and apply_motion all land once", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const events: string[] = [];
	const handler = createArdyGenerateHandler({
		liveRevisionId: () => revision,
		runCli: (argv) => {
			events.push("run");
			return runner(argv);
		},
		applyMotion: async (motionId, entityId, expectedRevisionId, context) => {
			events.push("apply");
			return dispatch(motionId, entityId, expectedRevisionId, context);
		},
		archive: {
			async commitGenerated(motionId: string): Promise<void> {
				events.push(`commit:${motionId}`);
			},
		},
	});

	const { result, resulting_revision_id } = await handler(baseRequest, makeContext());

	assert.equal(calls.length, 1, "exactly one CLI invocation");
	assert.deepEqual(events, ["run", "commit:wave-hands-01", "apply"], "commit must precede apply");
	assert.equal(dispatchCalls.length, 1);
	assert.equal(dispatchCalls[0]!.motionId, "wave-hands-01");
	assert.equal(dispatchCalls[0]!.entityId, entityId);
	assert.equal(dispatchCalls[0]!.revision, revision, "apply binds against the request's expected_revision_id");
	assert.equal(resulting_revision_id, "b".repeat(64));

	const expected: ArdyGenerateResultV1 = {
		schema_version: 1,
		request_id: requestId,
		motion_id: "wave-hands-01",
		frames: 100,
		duration_seconds: 5,
		seed: 7,
	};
	assert.deepEqual(result, expected);
});

test("generate success: the request's own duration is used when the wrapper JSON omits duration_s", async () => {
	// A wrapper that predates duration_s cannot report it; the request's own
	// value is the exact number that was passed as --duration.
	const missing = JSON.parse(wrapperJson()) as Record<string, unknown>;
	delete missing.duration_s;
	const runnerMissing: ArdyGenerateCliRunner = () => ({ status: 0, stdout: JSON.stringify(missing), stderr: "" });
	const { dispatch } = makeDispatch();
	const handler = createHandler(runnerMissing, dispatch);

	const { result } = await handler({ ...baseRequest, duration_seconds: 2.5, seed: null }, makeContext());

	assert.equal(result.duration_seconds, 2.5);
});

test("generate STALE: a mismatched expected_revision_id fails before any CLI or apply call", async () => {
	let cliRan = false;
	const runner: ArdyGenerateCliRunner = () => {
		cliRan = true;
		return { status: 0, stdout: wrapperJson(), stderr: "" };
	};
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	// The live project revision has moved past what the request was built on.
	const handler = createHandler(runner, dispatch, "b".repeat(64));

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateRevisionMismatchError && error.code === "REVISION_MISMATCH";
	});
	assert.equal(cliRan, false, "the generator must not run for a stale request");
	assert.equal(dispatchCalls.length, 0, "apply_motion must not run for a stale request");
});

test("generate HOST: an unset CCLAY_ARDY_HOST is ARDY_HOST_UNAVAILABLE, distinct from GENERATION_FAILED", async () => {
	// The wrapper's exact unset-host diagnostic (scripts/cclay-ardy-generate:502).
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr: "cclay-ardy-generate: CCLAY_ARDY_HOST is required (for example, user@gpu-host)",
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateHostUnavailableError && error.code === "ARDY_HOST_UNAVAILABLE";
	});
	assert.equal(dispatchCalls.length, 0, "apply_motion must not run when the host is unavailable");
});

test("generate HOST: an ssh connection failure is ARDY_HOST_UNAVAILABLE too", async () => {
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr:
			"cclay-ardy-generate: generating on fake-host ...\nssh: connect to host fake-host port 22: Connection refused",
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateHostUnavailableError && error.code === "ARDY_HOST_UNAVAILABLE";
	});
	assert.equal(dispatchCalls.length, 0);
});

test("generate HOST: a remote generation failure stays GENERATION_FAILED, not ARDY_HOST_UNAVAILABLE", async () => {
	// The remote python failed inside the generation; the box was reachable.
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr:
			'Traceback (most recent call last):\n  File "generate.py", line 88, in <module>\nRuntimeError: checkpoint missing',
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateGenerationError && error.code === "GENERATION_FAILED";
	});
	assert.equal(dispatchCalls.length, 0);
});

test("generate failure 1: unparseable wrapper stdout fails closed and apply_motion never runs", async () => {
	const { runner } = makeRunner({ status: 0, stdout: "not json at all" });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), ArdyGenerateGenerationError);
	assert.equal(dispatchCalls.length, 0);
});

test("generate failure 2: wrapper JSON missing the integer frames count fails closed", async () => {
	const { runner } = makeRunner({ status: 0, stdout: '{"motion_id":"x","duration_s":5}' });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), ArdyGenerateGenerationError);
	assert.equal(dispatchCalls.length, 0);
});

test("generate failure 3: a commit refusal is GENERATION_FAILED and apply_motion never runs", async () => {
	const { runner } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const commitFailure = new Error("generated motion npz is malformed");
	const handler = createArdyGenerateHandler({
		liveRevisionId: () => revision,
		runCli: runner,
		applyMotion: dispatch,
		archive: {
			async commitGenerated(): Promise<void> {
				throw commitFailure;
			},
		},
	});

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return (
			error instanceof ArdyGenerateGenerationError &&
			error.code === "GENERATION_FAILED" &&
			error.cause === commitFailure
		);
	});
	assert.equal(dispatchCalls.length, 0, "a motion whose archive could not be committed must never be applied");
});

test("generate failure 4: an apply failure records APPLY_FAILED", async () => {
	const { runner } = makeRunner();
	const conflict = new Error("apply_motion expected aaaa, current revision is bbbb");
	const { dispatch } = makeDispatch({ throwError: conflict });
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateApplyMotionError && error.code === "APPLY_FAILED" && error.cause === conflict;
	});
});

test("generate: a malformed request never reaches the generator", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler({ schema_version: 1, prompt: "x" }, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateInvalidRequestError && error.code === "INVALID_ARDY_GENERATE_REQUEST";
	});
	assert.equal(calls.length, 0);
	assert.ok(dispatch);
});

test("generate: a leading-hyphen prompt is rejected at parse, never emitted to argv", async () => {
	// The wrapper's argument loop has no `--` marker, so a prompt like
	// "-a person waving" would be parsed as an unknown option. The protocol
	// schema rejects it, and the service must fail as INVALID before any
	// argv is built.
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const handler = createHandler(runner, dispatch);

	await assert.rejects(handler({ ...baseRequest, prompt: "-a person waving" }, makeContext()), (error: unknown) => {
		return error instanceof ArdyGenerateInvalidRequestError && error.code === "INVALID_ARDY_GENERATE_REQUEST";
	});
	assert.equal(calls.length, 0, "the wrapper must never receive argv a leading-hyphen prompt would break");
	assert.ok(dispatch);
});
