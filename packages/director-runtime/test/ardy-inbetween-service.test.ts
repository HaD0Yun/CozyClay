// The in-between pose service: exact constrained argv (the regenerate
// invocation plus one --constrain-pose block per captured pose), the
// pre-run archive checks that map to BASE_MOTION_NOT_FOUND and
// POSE_CAPTURE_FAILED, the staleness guard, the host-unavailable split, and
// the commit-before-apply ordering. Everything runs through a fake CLI
// runner and a fake archive -- the wrapper itself shells to a GPU box over
// ssh, which no unit test can do.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArdyInbetweenRequestV1, ArdyInbetweenResultV1 } from "@cclay/protocol";
import {
	type ArdyInbetweenApplyMotionDispatch,
	ArdyInbetweenApplyMotionError,
	ArdyInbetweenBaseMotionNotFoundError,
	type ArdyInbetweenCliRunner,
	ArdyInbetweenGenerationError,
	ArdyInbetweenHostUnavailableError,
	ArdyInbetweenInvalidRequestError,
	ArdyInbetweenPoseCaptureFailedError,
	ArdyInbetweenRevisionMismatchError,
	createArdyInbetweenHandler,
	inbetweenSyntheticPoseIds,
} from "../src/ardy-inbetween-service.ts";
import type { DirectorHandlerContext } from "../src/inspect-service.ts";

const revision = "a".repeat(64);
const entityId = "00000000-0000-4000-8000-000000000001";
const requestId = "0123456789abcdef0123456789abcdef";

// Every pose_frames entry shares the constant offset scene_frame -
// clip_frame = 100, exactly what the add-on's affine mapping
// (clip_frame = scene_frame - start_frame) produces.
const baseRequest: ArdyInbetweenRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	expected_revision_id: revision,
	base_motion_id: "walk-forward-01",
	pose_frames: [
		{ scene_frame: 100, clip_frame: 0 },
		{ scene_frame: 160, clip_frame: 60 },
		{ scene_frame: 220, clip_frame: 120 },
	],
	requested_at_ms: 1_700_000_000_000,
};

// The synthetic pose ids the add-on's capture_evaluated_pose mints for this
// request: cclay-pose-<request_id>-<index + 1>, in declared order.
const poseIds = inbetweenSyntheticPoseIds(baseRequest);

// The wrapper's constrained-mode stdout: one JSON line carrying motion_id,
// frames, fps, the measured continuity, and the remote body.
function wrapperJson(overrides: Partial<{ motion_id: string; frames: number }> = {}): string {
	const motionId = overrides.motion_id ?? "climb-steps-01";
	return JSON.stringify({
		motion_id: motionId,
		duration_s: 600,
		path: `.cclay/motions/${motionId}.npz`,
		base_motion_id: "walk-forward-01",
		frames: overrides.frames ?? 12000,
		fps: 20,
		target_space: "skeleton_joint_center",
		surface_contact_verified: false,
		residual: { max_error_m: 0.031, mean_error_m: 0.018, worst_frame: 24, worst_joint: "RightHand" },
		continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
		waypoints: [],
	});
}

function makeContext(): DirectorHandlerContext {
	return { signal: new AbortController().signal };
}

function makeRunner(canned: Partial<{ status: number; stdout: string; stderr: string }> = {}): {
	runner: ArdyInbetweenCliRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner: ArdyInbetweenCliRunner = (argv) => {
		calls.push([...argv]);
		return {
			status: canned.status ?? 0,
			stdout: canned.stdout ?? wrapperJson(),
			stderr: canned.stderr ?? "",
		};
	};
	return { runner, calls };
}

function makeDispatch(
	overrides: Partial<{
		resultingRevisionId: string;
		throwError: Error;
	}> = {},
): {
	dispatch: ArdyInbetweenApplyMotionDispatch;
	calls: { motionId: string; entityId: string; revision: string }[];
} {
	const calls: { motionId: string; entityId: string; revision: string }[] = [];
	const dispatch: ArdyInbetweenApplyMotionDispatch = async (motionId, entityId, expectedRevisionId) => {
		calls.push({ motionId, entityId, revision: expectedRevisionId });
		if (overrides.throwError !== undefined) throw overrides.throwError;
		return { resulting_revision_id: overrides.resultingRevisionId ?? "b".repeat(64) };
	};
	return { dispatch, calls };
}

// A fake archive whose reads succeed for every motion unless a test names a
// missing one, and whose commit records the committed motion id.
function makeArchive(missing: ReadonlySet<string> = new Set()) {
	const events: string[] = [];
	return {
		events,
		archive: {
			async read(motionId: string): Promise<Uint8Array> {
				events.push(`read:${motionId}`);
				if (missing.has(motionId)) {
					throw new Error(`ARDY_ARCHIVE_NOT_FOUND: motion ${motionId} was not found`);
				}
				return new Uint8Array();
			},
			async commitGenerated(motionId: string): Promise<void> {
				events.push(`commit:${motionId}`);
			},
		},
	};
}

function createHandler(
	runCli: ArdyInbetweenCliRunner,
	applyMotion: ArdyInbetweenApplyMotionDispatch,
	options: { liveRevision?: string; missing?: ReadonlySet<string> } = {},
) {
	const { archive } = makeArchive(options.missing);
	return {
		handler: createArdyInbetweenHandler({
			runCli,
			applyMotion,
			liveRevisionId: () => options.liveRevision ?? revision,
			archive,
		}),
	};
}

test("inbetween argv: the constrained invocation with one four-word --constrain-pose block per captured pose", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await handler(baseRequest, makeContext());

	assert.equal(calls.length, 1);
	const argv = calls[0]!;
	assert.deepEqual(
		argv,
		[
			"regenerate",
			"--duration",
			"600",
			"--base-motion",
			"walk-forward-01",
			"--constrain-pose",
			poseIds[0],
			"0",
			"0",
			"--constrain-pose",
			poseIds[1],
			"0",
			"60",
			"--constrain-pose",
			poseIds[2],
			"0",
			"120",
		],
		"argv must be asserted element by element",
	);
	// --base-motion present exactly once, before any constraint.
	assert.equal(argv.filter((token) => token === "--base-motion").length, 1);
	// Each --constrain-pose contributes exactly four words: flag, src
	// motion id, src-frame "0", dst-frame.
	const poseFlags = argv.filter((token) => token === "--constrain-pose");
	assert.equal(poseFlags.length, 3);
	let firstPose = argv.indexOf("--constrain-pose");
	for (let index = 0; index < 3; index++) {
		const block = argv.slice(firstPose + 1, firstPose + 4);
		assert.deepEqual(block, [poseIds[index], "0", String(baseRequest.pose_frames[index]!.clip_frame)]);
		firstPose = argv.indexOf("--constrain-pose", firstPose + 1);
	}
});

test("inbetween synthetic ids: derived with the add-on's exact cclay-pose-<request_id>-<n> rule", async () => {
	assert.deepEqual(poseIds, [
		"cclay-pose-0123456789abcdef0123456789abcdef-1",
		"cclay-pose-0123456789abcdef0123456789abcdef-2",
		"cclay-pose-0123456789abcdef0123456789abcdef-3",
	]);
	// The single-pose form is the ordinal-1 id.
	const single: ArdyInbetweenRequestV1 = {
		...baseRequest,
		pose_frames: [{ scene_frame: 100, clip_frame: 0 }],
	};
	assert.deepEqual(inbetweenSyntheticPoseIds(single), ["cclay-pose-0123456789abcdef0123456789abcdef-1"]);
});

test("inbetween success: reads base and every pose before runCli, then commit, then apply", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { archive, events } = makeArchive();
	const handler = createArdyInbetweenHandler({
		liveRevisionId: () => revision,
		runCli: runner,
		applyMotion: dispatch,
		archive,
	});

	const { result, resulting_revision_id } = await handler(baseRequest, makeContext());

	assert.equal(calls.length, 1, "exactly one CLI invocation");
	assert.deepEqual(
		events,
		[
			"read:walk-forward-01",
			`read:${poseIds[0]}`,
			`read:${poseIds[1]}`,
			`read:${poseIds[2]}`,
			"commit:climb-steps-01",
		],
		"both archive preflights must precede the wrapper run",
	);
	// apply is dispatched by the service, outside the kernel's event list.
	assert.equal(dispatchCalls.length, 1);
	assert.equal(dispatchCalls[0]!.motionId, "climb-steps-01");
	assert.equal(dispatchCalls[0]!.entityId, entityId);
	assert.equal(dispatchCalls[0]!.revision, revision, "apply binds against the request's expected_revision_id");
	assert.equal(resulting_revision_id, "b".repeat(64));

	const expected: ArdyInbetweenResultV1 = {
		schema_version: 1,
		request_id: requestId,
		motion_id: "climb-steps-01",
		frames: 12000,
		captured_frames: 3,
		base_motion_id: "walk-forward-01",
		continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
		dropped_constraints: [],
	};
	assert.deepEqual(result, expected);
});

test("inbetween BASE_MOTION_NOT_FOUND: a missing base archive fails before the wrapper runs", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch, { missing: new Set(["walk-forward-01"]) });

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenBaseMotionNotFoundError && error.code === "BASE_MOTION_NOT_FOUND";
	});
	assert.equal(calls.length, 0, "the wrapper must not run when the base archive is missing");
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween POSE_CAPTURE_FAILED: a missing synthetic pose archive fails before the wrapper runs", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	// The base exists; the second captured pose's archive does not.
	const { handler } = createHandler(runner, dispatch, { missing: new Set([poseIds[1]!]) });

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenPoseCaptureFailedError && error.code === "POSE_CAPTURE_FAILED";
	});
	assert.equal(calls.length, 0, "the wrapper must not run when a captured pose is missing");
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween STALE: a mismatched expected_revision_id fails before any CLI or apply call", async () => {
	let cliRan = false;
	const runner: ArdyInbetweenCliRunner = () => {
		cliRan = true;
		return { status: 0, stdout: wrapperJson(), stderr: "" };
	};
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch, { liveRevision: "b".repeat(64) });

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenRevisionMismatchError && error.code === "REVISION_MISMATCH";
	});
	assert.equal(cliRan, false, "the generator must not run for a stale request");
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween HOST: an unset CCLAY_ARDY_HOST is ARDY_HOST_UNAVAILABLE, distinct from GENERATION_FAILED", async () => {
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr: "cclay-ardy-generate: CCLAY_ARDY_HOST is required (for example, user@gpu-host)",
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenHostUnavailableError && error.code === "ARDY_HOST_UNAVAILABLE";
	});
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween HOST: an ssh connection failure is ARDY_HOST_UNAVAILABLE too", async () => {
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr:
			"cclay-ardy-generate: generating on fake-host ...\nssh: connect to host fake-host port 22: Connection refused",
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenHostUnavailableError && error.code === "ARDY_HOST_UNAVAILABLE";
	});
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween HOST: a remote generation failure stays GENERATION_FAILED", async () => {
	const { runner } = makeRunner({
		status: 1,
		stdout: "",
		stderr: "Traceback (most recent call last):\nRuntimeError: checkpoint missing",
	});
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenGenerationError && error.code === "GENERATION_FAILED";
	});
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween failure 1: unparseable wrapper stdout fails closed and apply_motion never runs", async () => {
	const { runner } = makeRunner({ status: 0, stdout: "not json at all" });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), ArdyInbetweenGenerationError);
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween failure 2: wrapper JSON without the measured continuity fails the closed result schema", async () => {
	const missing = JSON.parse(wrapperJson()) as Record<string, unknown>;
	delete missing.continuity;
	const { runner } = makeRunner({ status: 0, stdout: JSON.stringify(missing) });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), ArdyInbetweenGenerationError);
	assert.equal(dispatchCalls.length, 0);
});

test("inbetween failure 3: a commit refusal is GENERATION_FAILED and apply_motion never runs", async () => {
	const { runner } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const commitFailure = new Error("generated motion npz is malformed");
	const handler = createArdyInbetweenHandler({
		liveRevisionId: () => revision,
		runCli: runner,
		applyMotion: dispatch,
		archive: {
			async read(): Promise<Uint8Array> {
				return new Uint8Array();
			},
			async commitGenerated(): Promise<void> {
				throw commitFailure;
			},
		},
	});

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return (
			error instanceof ArdyInbetweenGenerationError &&
			error.code === "GENERATION_FAILED" &&
			error.cause === commitFailure
		);
	});
	assert.equal(dispatchCalls.length, 0, "a motion whose archive could not be committed must never be applied");
});

test("inbetween failure 4: an apply failure records APPLY_FAILED", async () => {
	const { runner } = makeRunner();
	const conflict = new Error("apply_motion expected aaaa, current revision is bbbb");
	const { dispatch } = makeDispatch({ throwError: conflict });
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => {
		return (
			error instanceof ArdyInbetweenApplyMotionError && error.code === "APPLY_FAILED" && error.cause === conflict
		);
	});
});

test("inbetween: a malformed request never reaches the generator", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const { handler } = createHandler(runner, dispatch);

	await assert.rejects(handler({ schema_version: 1, base_motion_id: "x" }, makeContext()), (error: unknown) => {
		return error instanceof ArdyInbetweenInvalidRequestError && error.code === "INVALID_ARDY_INBETWEEN_REQUEST";
	});
	assert.equal(calls.length, 0);
});
