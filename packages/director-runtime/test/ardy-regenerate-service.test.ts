import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArdyRegenerateRequestV1, ArdyRegenerateResultV1 } from "@cclay/protocol";
import {
	type ArdyRegenerateApplyMotionDispatch,
	type ArdyRegenerateCliRunner,
	createArdyRegenerateHandler,
} from "../src/ardy-regenerate-service.ts";
import type { DirectorHandlerContext } from "../src/inspect-service.ts";

const revision = "a".repeat(64);
const entityId = "00000000-0000-4000-8000-000000000001";
const requestId = "regen-req-1";

// A minimal, schema-valid regenerate request carrying all three constraint
// kinds. effectors + full_body + root_2d must all survive into argv without
// overwriting each other (acceptance: the three flags coexist in argv).
const baseRequest: ArdyRegenerateRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	base_motion_id: "wave-base-1",
	expected_revision_id: revision,
	effectors: [
		{ frame: 10, joint: "LeftFoot", x: 0.12, y: 0.18, z: 0.55 },
		{ frame: 46, joint: "RightHand", x: -0.3, y: 1.2, z: 0.1 },
	],
	full_body: [{ frame: 30, synthetic_motion_id: "pose-synthetic-1" }],
	root_2d: [
		{ frame: 5, x: 0.0, z: 0.0, heading: 1.5707963 },
		{ frame: 20, x: 1.0, z: 0.5, heading: null },
	],
	requested_at_ms: 1700000000000,
};

// The wrapper's constrained-mode stdout: one JSON line carrying motion_id,
// frames, and the remote body (residual, continuity, ...). The handler
// projects this into the regenerate result schema. residual is present here
// so achieved_error_m derives from residual.max_error_m.
function wrapperJson(overrides: Partial<{ motion_id: string; frames: number }> = {}): string {
	const motionId = overrides.motion_id ?? "regen-motion-1";
	const frames = overrides.frames ?? 100;
	return JSON.stringify({
		motion_id: motionId,
		duration_s: 5.0,
		path: `.cclay/motions/${motionId}.npz`,
		base_motion_id: "wave-base-1",
		frames,
		fps: 20,
		target_space: "skeleton_joint_center",
		surface_contact_verified: false,
		residual: {
			max_error_m: 0.031,
			mean_error_m: 0.018,
			worst_frame: 46,
			worst_joint: "RightHand",
		},
		continuity: {
			mean_jump_m: 0.012,
			max_jump_m: 0.04,
			max_jump_frame: 47,
		},
		waypoints: [],
	});
}

function makeContext(expectedRevision: string = revision): DirectorHandlerContext {
	return {
		signal: new AbortController().signal,
		request: { expected_revision_id: expectedRevision },
	};
}

// A fake CLI runner that records the argv it received and returns a canned
// wrapper stdout. The default returns a success JSON line; tests override
// status/stdout to inject failures.
function makeRunner(canned: Partial<{ status: number; stdout: string; stderr: string }> = {}): {
	runner: ArdyRegenerateCliRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner: ArdyRegenerateCliRunner = (argv) => {
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
// revision. Tests override it to inject a revision-conflict failure.
function makeDispatch(
	overrides: Partial<{
		resultingRevisionId: string;
		throwError: Error;
	}> = {},
): { dispatch: ArdyRegenerateApplyMotionDispatch; calls: { motionId: string; entityId: string; revision: string }[] } {
	const calls: { motionId: string; entityId: string; revision: string }[] = [];
	const dispatch: ArdyRegenerateApplyMotionDispatch = async (motionId, entityId, expectedRevisionId) => {
		calls.push({ motionId, entityId, revision: expectedRevisionId });
		if (overrides.throwError !== undefined) throw overrides.throwError;
		return { resulting_revision_id: overrides.resultingRevisionId ?? "b".repeat(64) };
	};
	return { dispatch, calls };
}

test("regenerate success: all three constraint kinds ride distinct flags in argv and do not overwrite each other", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	const { result, resulting_revision_id } = await handler(baseRequest, makeContext());

	// Exactly one CLI invocation, with one argv array.
	assert.equal(calls.length, 1);
	const argv = calls[0];

	// The three kinds must each appear as their own flag block.
	const constrainFlags = argv.filter((token) => token === "--constrain");
	const poseFlags = argv.filter((token) => token === "--constrain-pose");
	const pathFlags = argv.filter((token) => token === "--constrain-path");
	assert.equal(constrainFlags.length, 2, "two --constrain blocks (one per effector)");
	assert.equal(poseFlags.length, 1, "one --constrain-pose block");
	assert.equal(pathFlags.length, 2, "two --constrain-path blocks");

	// --base-motion present once, before any constraint.
	assert.equal(argv.filter((t) => t === "--base-motion").length, 1);
	const baseIdx = argv.indexOf("--base-motion");
	assert.equal(argv[baseIdx + 1], "wave-base-1");

	// Effector 1 block lands intact: frame, joint, x, y, z.
	const c1 = argv.indexOf("--constrain");
	assert.deepEqual(argv.slice(c1 + 1, c1 + 6), ["10", "LeftFoot", "0.12", "0.18", "0.55"]);
	// Effector 2 block lands intact and is a SEPARATE --constrain block.
	const c2 = argv.indexOf("--constrain", c1 + 1);
	assert.deepEqual(argv.slice(c2 + 1, c2 + 6), ["46", "RightHand", "-0.3", "1.2", "0.1"]);

	// Full-body pose block: src-motion-id, src-frame "0", dst-frame.
	const p = argv.indexOf("--constrain-pose");
	assert.deepEqual(argv.slice(p + 1, p + 4), ["pose-synthetic-1", "0", "30"]);

	// apply_motion received the generated motion_id and the request's
	// entity_id + expected_revision_id, and the handler returned its revision.
	assert.equal(dispatchCalls.length, 1);
	assert.equal(dispatchCalls[0].motionId, "regen-motion-1");
	assert.equal(dispatchCalls[0].entityId, entityId);
	assert.equal(dispatchCalls[0].revision, revision);
	assert.equal(resulting_revision_id, "b".repeat(64));

	// Result parsed through the closed schema.
	const expected: ArdyRegenerateResultV1 = {
		schema_version: 1,
		request_id: requestId,
		motion_id: "regen-motion-1",
		frames: 100,
		achieved_error_m: 0.031,
		residual: {
			max_error_m: 0.031,
			mean_error_m: 0.018,
			worst_frame: 46,
			worst_joint: "RightHand",
		},
		continuity: { mean_jump_m: 0.012, max_jump_m: 0.04, max_jump_frame: 47 },
		dropped_constraints: [],
	};
	assert.deepEqual(result, expected);
});

test("regenerate success: heading null is emitted as the literal 'none'", async () => {
	const { runner, calls } = makeRunner();
	const { dispatch } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	// Request with a null-heading waypoint and a numeric-heading waypoint.
	const request: ArdyRegenerateRequestV1 = {
		...baseRequest,
		effectors: [],
		full_body: [],
		root_2d: [
			{ frame: 5, x: 0.0, z: 0.0, heading: null },
			{ frame: 20, x: 1.0, z: 0.5, heading: 0.7853982 },
		],
	};
	await handler(request, makeContext());

	const argv = calls[0];
	// First --constrain-path block: heading slot is "none".
	const p1 = argv.indexOf("--constrain-path");
	assert.deepEqual(argv.slice(p1 + 1, p1 + 5), ["5", "0", "0", "none"]);
	// Second block: heading slot is the numeric literal, not "none".
	const p2 = argv.indexOf("--constrain-path", p1 + 1);
	assert.deepEqual(argv.slice(p2 + 1, p2 + 5), ["20", "1", "0.5", "0.7853982"]);
});

test("regenerate failure 1: CLI non-zero exit raises and apply_motion is never called", async () => {
	const { runner } = makeRunner({ status: 1, stdout: "", stderr: "base motion npz not found" });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	await assert.rejects(handler(baseRequest, makeContext()), /ARDY_REGENERATE_CLI_ERROR/);
	assert.equal(dispatchCalls.length, 0, "apply_motion must not run after a CLI failure");
});

test("regenerate failure 1b: unparseable CLI stdout raises and apply_motion is never called", async () => {
	const { runner } = makeRunner({ status: 0, stdout: "not json at all" });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	await assert.rejects(handler(baseRequest, makeContext()), /ARDY_REGENERATE_INVALID_JSON/);
	assert.equal(dispatchCalls.length, 0);
});

test("regenerate failure 1c: runner throws synchronously raises a CLI error and apply_motion is never called", async () => {
	const runner: ArdyRegenerateCliRunner = () => {
		throw new Error("spawn EACCES");
	};
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	await assert.rejects(handler(baseRequest, makeContext()), /ARDY_REGENERATE_CLI_ERROR: spawn EACCES/);
	assert.equal(dispatchCalls.length, 0);
});

test("regenerate failure 2: apply_motion revision conflict propagates as-is", async () => {
	const { runner } = makeRunner();
	const conflict = new Error("STALE_BASE: apply_motion expected aaaa, current revision is bbbb");
	const { dispatch } = makeDispatch({ throwError: conflict });
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	// The dispatch's own error surfaces verbatim; the handler does not wrap or
	// swallow it, so the caller sees the real revision-conflict message.
	await assert.rejects(handler(baseRequest, makeContext()), (error: unknown) => error === conflict);
});

test("regenerate failure 3: constraints past the result frames are dropped and recorded, run still succeeds", async () => {
	// The fake runner returns a clip of only 25 frames, but the request
	// targets frames 30 (full_body) and 46 (effector) — both out of range.
	// A real wrapper would have rejected these locally before ssh; with a
	// fake runner the post-hoc safety net is what catches them, and a drop is
	// a warning, not a failure.
	const { runner } = makeRunner({ stdout: wrapperJson({ frames: 25 }) });
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	const { result } = await handler(baseRequest, makeContext());

	// apply_motion still ran: the run succeeded despite the drops.
	assert.equal(dispatchCalls.length, 1);

	// The out-of-range frames (46 effector, 30 pose) are recorded with a
	// reason; the in-range frames (10 effector, 5 and 20 path) are not.
	const droppedFrames = result.dropped_constraints.map((d) => d.frame).sort((a, b) => a - b);
	assert.deepEqual(droppedFrames, [30, 46]);
	for (const drop of result.dropped_constraints) {
		assert.ok(drop.reason.length > 0, "every dropped constraint carries a reason");
		assert.match(drop.reason, /outside the generated clip/);
	}
	// The whole result still parsed through the closed schema.
	assert.equal(result.motion_id, "regen-motion-1");
	assert.equal(result.frames, 25);
});

test("regenerate STALE_BASE: a mismatched expected_revision_id fails before any CLI or apply_motion call", async () => {
	let cliRan = false;
	const runner: ArdyRegenerateCliRunner = () => {
		cliRan = true;
		return { status: 0, stdout: wrapperJson(), stderr: "" };
	};
	const { dispatch, calls: dispatchCalls } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	await assert.rejects(handler(baseRequest, makeContext("b".repeat(64))), /STALE_BASE/);
	assert.equal(cliRan, false, "CLI must not run on a stale revision");
	assert.equal(dispatchCalls.length, 0, "apply_motion must not run on a stale revision");
});

test("regenerate success with null residual: achieved_error_m is null and the run still succeeds", async () => {
	// A run that constrains only the root path has no end-effector target, so
	// measure_residuals returns None; the wrapper JSON carries residual:null
	// and the adapter must keep achieved_error_m null (not zero).
	const { runner } = makeRunner({
		stdout: JSON.stringify({
			motion_id: "path-only-1",
			duration_s: 5.0,
			path: ".cclay/motions/path-only-1.npz",
			base_motion_id: "wave-base-1",
			frames: 80,
			fps: 20,
			residual: null,
			continuity: { mean_jump_m: 0.01, max_jump_m: 0.03, max_jump_frame: 1 },
			waypoints: [],
		}),
	});
	const { dispatch } = makeDispatch();
	const handler = createArdyRegenerateHandler({ runCli: runner, applyMotion: dispatch });

	const request: ArdyRegenerateRequestV1 = {
		...baseRequest,
		effectors: [],
		full_body: [],
		root_2d: [{ frame: 5, x: 0.0, z: 0.0, heading: null }],
	};
	const { result } = await handler(request, makeContext());

	assert.equal(result.achieved_error_m, null);
	assert.equal(result.residual, null);
	assert.equal(result.dropped_constraints.length, 0);
});
