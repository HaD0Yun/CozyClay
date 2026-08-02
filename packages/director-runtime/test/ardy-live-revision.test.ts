// The regeneration handler's staleness guard. expected_revision_id is checked
// against the CURRENT project revision (liveRevisionId, read fresh) before the
// generator runs, and bound again at apply time, because a regenerate run
// costs minutes of GPU time and the scene can move while it is in flight.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArdyRegenerateRequestV1, ArdyRegenerateResultV1 } from "@cclay/protocol";
import {
	type ArdyRegenerateApplyMotionDispatch,
	ArdyRegenerateApplyMotionError,
	ArdyRegenerateRevisionMismatchError,
	createArdyRegenerateHandler,
} from "../src/ardy-regenerate-service.ts";
import type { DirectorHandlerContext } from "../src/inspect-service.ts";

const revision = "a".repeat(64);
const entityId = "00000000-0000-4000-8000-000000000001";
const requestId = "regen-live-rev";

const request: ArdyRegenerateRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	base_motion_id: "wave-base-1",
	expected_revision_id: revision,
	effectors: [{ frame: 10, joint: "LeftFoot", x: 0.12, y: 0.18, z: 0.55 }],
	full_body: [],
	root_2d: [],
	requested_at_ms: 1700000000000,
};

function wrapperJson(): string {
	return JSON.stringify({
		motion_id: "regen-motion-1",
		duration_s: 5.0,
		path: ".cclay/motions/regen-motion-1.npz",
		base_motion_id: "wave-base-1",
		frames: 100,
		fps: 20,
		residual: null,
		continuity: { mean_jump_m: 0.012, max_jump_m: 0.04, max_jump_frame: 47 },
		waypoints: [],
	});
}

function makeContext(): DirectorHandlerContext {
	return { signal: new AbortController().signal };
}

function makeHandler(options: {
	readonly liveRevisionId: () => string;
	readonly onGenerated?: (motionId: string, result: ArdyRegenerateResultV1) => Promise<void>;
	readonly applyMotion?: ArdyRegenerateApplyMotionDispatch;
}) {
	const events: string[] = [];
	const runCalls: string[][] = [];
	const dispatchCalls: { motionId: string; entityId: string; revision: string }[] = [];
	const handler = createArdyRegenerateHandler({
		runCli: (argv) => {
			runCalls.push([...argv]);
			events.push("run");
			return { status: 0, stdout: wrapperJson(), stderr: "" };
		},
		applyMotion: (motionId, entityId, expectedRevisionId, context) => {
			events.push("apply");
			if (options.applyMotion !== undefined) {
				return options.applyMotion(motionId, entityId, expectedRevisionId, context);
			}
			dispatchCalls.push({ motionId, entityId, revision: expectedRevisionId });
			return Promise.resolve({ resulting_revision_id: "b".repeat(64) });
		},
		archive: {
			async read(motionId: string): Promise<Uint8Array> {
				events.push(`read:${motionId}`);
				return new Uint8Array();
			},
			async commitGenerated(motionId: string): Promise<void> {
				events.push(`commit:${motionId}`);
			},
		},
		liveRevisionId: options.liveRevisionId,
		onGenerated: options.onGenerated,
	});
	return { handler, events, runCalls, dispatchCalls };
}

test("a request whose expected_revision_id differs from the live revision fails before any CLI call", async () => {
	const { handler, runCalls, dispatchCalls } = makeHandler({
		liveRevisionId: () => "b".repeat(64),
	});

	await assert.rejects(handler(request, makeContext()), (error: unknown) => {
		return error instanceof ArdyRegenerateRevisionMismatchError && error.code === "REVISION_MISMATCH";
	});
	assert.equal(runCalls.length, 0, "the generator must not run for a stale request");
	assert.equal(dispatchCalls.length, 0, "apply_motion must not run for a stale request");
});

test("a request whose expected_revision_id matches the live revision proceeds through generation and apply", async () => {
	const { handler, events, runCalls, dispatchCalls } = makeHandler({
		liveRevisionId: () => revision,
	});

	const { result, resulting_revision_id } = await handler(request, makeContext());

	assert.equal(runCalls.length, 1, "the generator must run exactly once for a current request");
	assert.equal(result.motion_id, "regen-motion-1");
	assert.equal(result.request_id, requestId);
	assert.equal(resulting_revision_id, "b".repeat(64));
	assert.equal(dispatchCalls.length, 1);
	assert.equal(dispatchCalls[0].revision, revision, "the apply binds against the request's expected_revision_id");
	assert.deepEqual(events, ["read:wave-base-1", "run", "commit:regen-motion-1", "apply"]);
});

test("a revision that moves between generation and apply fails at the apply-time check, archive committed, no motion applied", async () => {
	let live = revision;
	const conflict = new Error("apply_motion expected aaaa, current revision is bbbb");
	const { handler, events } = makeHandler({
		// Fresh when the request starts: the pre-kernel check passes.
		liveRevisionId: () => live,
		applyMotion: async () => {
			// The scene moved while the generator ran. The dispatch re-binds
			// against the request's expected_revision_id and rejects before
			// any motion is applied.
			live = "b".repeat(64);
			throw conflict;
		},
	});

	await assert.rejects(handler(request, makeContext()), (error: unknown) => {
		return error instanceof ArdyRegenerateApplyMotionError && error.cause === conflict;
	});
	assert.deepEqual(
		events,
		["read:wave-base-1", "run", "commit:regen-motion-1", "apply"],
		"the archive commit must be observable before the apply-time rejection",
	);
	assert.equal(events.includes("apply:ok"), false, "no motion may be applied when the apply-time check rejects");
});

test("onGenerated is awaited after the result parses and before the archive commit", async () => {
	const seen: { motionId: string; result: ArdyRegenerateResultV1 }[] = [];
	const { handler, events } = makeHandler({
		liveRevisionId: () => revision,
		onGenerated: async (motionId, result) => {
			seen.push({ motionId, result });
			events.push(`generated:${motionId}`);
		},
	});

	const { result } = await handler(request, makeContext());

	assert.deepEqual(
		events,
		["read:wave-base-1", "run", "generated:regen-motion-1", "commit:regen-motion-1", "apply"],
		"the hook must run after the wrapper result parses and before commitGenerated",
	);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].motionId, "regen-motion-1");
	// The hook receives the fully parsed result, so it can only have run
	// after parsing succeeded.
	assert.deepEqual(seen[0].result, result);
});

test("omitting onGenerated leaves the kernel behavior unchanged", async () => {
	const { handler, events } = makeHandler({ liveRevisionId: () => revision });

	const { result } = await handler(request, makeContext());

	assert.deepEqual(events, ["read:wave-base-1", "run", "commit:regen-motion-1", "apply"]);
	assert.equal(result.motion_id, "regen-motion-1");
	assert.equal(result.frames, 100);
});
