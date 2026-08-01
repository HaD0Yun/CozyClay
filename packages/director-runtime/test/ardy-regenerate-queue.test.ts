// The queue's job is to run each add-on request exactly once and to never let
// one disappear. Both are failure modes you only see under concurrency or
// after a crash, so the tests here create those conditions rather than
// checking that a happy-path sweep returns something.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	recoverAbandonedClaims,
	regenerateQueuePaths,
	removeOrphanedSyntheticPoses,
	sweepRegenerateRequests,
	writeRegenerateRequest,
} from "../src/ardy-regenerate-queue.ts";
import { ArdyRegenerateGenerationError, ArdyRegenerateRevisionMismatchError } from "../src/ardy-regenerate-service.ts";

const REVISION = "a".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function aRequest(requestId: string, overrides: Record<string, unknown> = {}) {
	return {
		schema_version: 1 as const,
		request_id: requestId,
		entity_id: ENTITY,
		base_motion_id: "base-clip",
		expected_revision_id: REVISION,
		effectors: [{ frame: 3, joint: "RightHand" as const, x: 0.1, y: 0.2, z: 0.3 }],
		full_body: [],
		root_2d: [],
		requested_at_ms: 1_700_000_000_000,
		...overrides,
	};
}

function aResult(requestId: string, motionId = "regenerated-clip") {
	return {
		schema_version: 1 as const,
		request_id: requestId,
		motion_id: motionId,
		frames: 240,
		achieved_error_m: 0.004,
		residual: { max_error_m: 0.004, mean_error_m: 0.002, worst_frame: 3, worst_joint: "RightHand" as const },
		continuity: { mean_jump_m: 0.0, max_jump_m: 0.0, max_jump_frame: 0 },
		dropped_constraints: [],
	};
}

describe("ardy regenerate queue", () => {
	let project: string;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-queue-"));
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it("returns nothing when the add-on has never published a request", async () => {
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => assert.fail("handler must not run"),
			contextFor: () => ({}),
		});
		assert.deepEqual(entries, []);
	});

	it("runs each request once and removes it", async () => {
		await writeRegenerateRequest(project, aRequest("req-a"));
		await writeRegenerateRequest(project, aRequest("req-b"));
		const seen: string[] = [];
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async (params) => {
				const request = params as { request_id: string };
				seen.push(request.request_id);
				return { result: aResult(request.request_id), resulting_revision_id: "b".repeat(64) };
			},
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});

		assert.deepEqual(seen.sort(), ["req-a", "req-b"]);
		assert.equal(entries.length, 2);
		// Asserted explicitly: the queue records a failure rather than
		// throwing, so counting outcome files alone cannot tell a successful
		// sweep from one where every request blew up.
		for (const entry of entries) {
			assert.equal(
				entry.outcome.status,
				"succeeded",
				entry.outcome.status === "failed" ? entry.outcome.message : "",
			);
		}
		const paths = regenerateQueuePaths(project);
		assert.deepEqual(await readdir(paths.requests), []);
		assert.deepEqual((await readdir(paths.outcomes)).sort(), ["req-a.json", "req-b.json"]);
	});

	it("does not hand the same request to two concurrent sweeps", async () => {
		await writeRegenerateRequest(project, aRequest("only-once"));
		let running = 0;
		let overlapped = false;
		const handler = async (params: unknown) => {
			running += 1;
			overlapped ||= running > 1;
			// Yield so a genuinely concurrent sweep has the chance to claim
			// the same file; without the atomic rename it would.
			await new Promise((resolve) => setTimeout(resolve, 20));
			running -= 1;
			return {
				result: aResult((params as { request_id: string }).request_id),
				resulting_revision_id: "b".repeat(64),
			};
		};
		const options = {
			projectDirectory: project,
			handler,
			contextFor: (request: { expected_revision_id: string }) => ({
				request: { expected_revision_id: request.expected_revision_id },
			}),
		};

		const [first, second] = await Promise.all([sweepRegenerateRequests(options), sweepRegenerateRequests(options)]);

		assert.equal(overlapped, false, "the two sweeps ran the same request at once");
		assert.equal(first.length + second.length, 1, "exactly one sweep may claim the request");
		const claimed = [...first, ...second][0];
		assert.equal(
			claimed.outcome.status,
			"succeeded",
			claimed.outcome.status === "failed" ? claimed.outcome.message : "",
		);
		assert.deepEqual(await readdir(regenerateQueuePaths(project).outcomes), ["only-once.json"]);
	});

	it("records a failure instead of losing the request", async () => {
		// The add-on has already detached its IK layer, so a failure that
		// wrote nothing would look exactly like a host that never started.
		await writeRegenerateRequest(project, aRequest("doomed"));
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => {
				throw new ArdyRegenerateGenerationError("wrapper exited 1: checkpoint missing");
			},
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});

		assert.equal(entries.length, 1);
		const outcome = entries[0].outcome;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "GENERATION_FAILED");
		assert.match(outcome.status === "failed" ? outcome.message : "", /checkpoint missing/);
		const written = JSON.parse(await readFile(join(regenerateQueuePaths(project).outcomes, "doomed.json"), "utf8"));
		assert.equal(written.status, "failed");
		assert.deepEqual(await readdir(regenerateQueuePaths(project).requests), []);
	});

	it("reports a stale request as a revision mismatch, not a generation failure", async () => {
		await writeRegenerateRequest(project, aRequest("stale"));
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => {
				throw new ArdyRegenerateRevisionMismatchError(REVISION, "c");
			},
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});
		const outcome = entries[0].outcome;
		assert.equal(outcome.status === "failed" && outcome.error_code, "REVISION_MISMATCH");
	});

	it("fails a malformed request rather than feeding it to the generator", async () => {
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.requests, { recursive: true });
		await writeFile(join(paths.requests, "junk.json"), JSON.stringify({ schema_version: 1 }), "utf8");
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => assert.fail("handler must not run on a malformed request"),
			contextFor: () => ({}),
		});
		const outcome = entries[0].outcome;
		assert.equal(outcome.status === "failed" && outcome.error_code, "INVALID_ARDY_REGENERATE_REQUEST");
		// Addressed by filename so the failure is still findable even though
		// the request id could not be read out of the body.
		assert.equal(outcome.request_id, "junk");
	});

	it("recovers a request a crashed host left claimed", async () => {
		// A host that dies mid-generation leaves the claim behind. Nothing
		// else will ever look at that file again, so without recovery the
		// animator's edits are simply gone -- and the add-on has already
		// detached, so the scene cannot produce the request a second time.
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.requests, { recursive: true });
		await writeFile(join(paths.requests, "crasher.json.claimed"), JSON.stringify(aRequest("crasher")), "utf8");

		const beforeRecovery = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => assert.fail("a claimed request is not pending"),
			contextFor: () => ({}),
		});
		assert.deepEqual(beforeRecovery, [], "a claim must not be swept as if it were pending");

		const recovered = await recoverAbandonedClaims(project);
		assert.equal(recovered.length, 1);
		assert.match(recovered[0], /crasher\.json$/);
		assert.deepEqual(await readdir(paths.requests), ["crasher.json"]);

		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async (params) => ({
				result: aResult((params as { request_id: string }).request_id),
				resulting_revision_id: "b".repeat(64),
			}),
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
	});

	it("writes outcomes owner-only and leaves no partial files", async () => {
		await writeRegenerateRequest(project, aRequest("perms"));
		const [entry] = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async (params) => ({
				result: aResult((params as { request_id: string }).request_id),
				resulting_revision_id: "b".repeat(64),
			}),
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});
		assert.equal(entry.outcome.status, "succeeded", entry.outcome.status === "failed" ? entry.outcome.message : "");
		const paths = regenerateQueuePaths(project);
		const info = await stat(join(paths.outcomes, "perms.json"));
		assert.equal(info.mode & 0o777, 0o600);
		assert.deepEqual(
			(await readdir(paths.outcomes)).filter((name) => name.endsWith(".partial")),
			[],
		);
	});

	it("rejects an outcome the closed schema would not accept", async () => {
		await writeRegenerateRequest(project, aRequest("bad-result"));
		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => ({
				// frames is required and must be a positive integer; a handler
				// returning junk must not be written out as a success.
				result: { schema_version: 1, motion_id: "x" },
				resulting_revision_id: "b".repeat(64),
			}),
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});
		assert.equal(entries[0].outcome.status, "failed");
	});

	it("deletes the request's synthetic poses whether it succeeded or failed", async () => {
		// The add-on mints a fresh synthetic id per attempt, so nothing ever
		// overwrites these. Leaving them on the failure path leaks one archive
		// per attempt into the project's motion library.
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.motions, { recursive: true });
		for (const id of ["cclay-pose-aaaa-f8", "cclay-pose-bbbb-f8"]) {
			await writeFile(join(paths.motions, `${id}.npz`), "not really an npz", "utf8");
		}
		await writeRegenerateRequest(
			project,
			aRequest("ok", { full_body: [{ frame: 8, synthetic_motion_id: "cclay-pose-aaaa-f8" }] }),
		);
		await writeRegenerateRequest(
			project,
			aRequest("boom", { full_body: [{ frame: 8, synthetic_motion_id: "cclay-pose-bbbb-f8" }] }),
		);

		await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async (params) => {
				const request = params as { request_id: string };
				if (request.request_id === "boom") {
					throw new ArdyRegenerateGenerationError("wrapper exited 1");
				}
				return { result: aResult(request.request_id), resulting_revision_id: "b".repeat(64) };
			},
			contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
		});

		assert.deepEqual(await readdir(paths.motions), []);
	});

	it("removes synthetic poses a crashed host orphaned, but not ones still claimed", async () => {
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.motions, { recursive: true });
		await writeFile(join(paths.motions, "cclay-pose-orphan-f1.npz"), "x", "utf8");
		await writeFile(join(paths.motions, "cclay-pose-wanted-f2.npz"), "x", "utf8");
		// A real clip must survive: the sweep only owns the synthetic prefix.
		await writeFile(join(paths.motions, "a-person-walks.npz"), "x", "utf8");
		await writeRegenerateRequest(
			project,
			aRequest("pending", { full_body: [{ frame: 2, synthetic_motion_id: "cclay-pose-wanted-f2" }] }),
		);

		const removed = await removeOrphanedSyntheticPoses(project);

		assert.deepEqual(removed, ["cclay-pose-orphan-f1.npz"]);
		assert.deepEqual((await readdir(paths.motions)).sort(), ["a-person-walks.npz", "cclay-pose-wanted-f2.npz"]);
	});

	it("does not replay a request when its existing outcome is corrupt", async () => {
		const paths = regenerateQueuePaths(project);
		const poseId = "cclay-pose-corrupt-f8";
		await mkdir(paths.motions, { recursive: true });
		await writeFile(join(paths.motions, `${poseId}.npz`), "x", "utf8");
		await writeRegenerateRequest(
			project,
			aRequest("corrupt-outcome", { full_body: [{ frame: 8, synthetic_motion_id: poseId }] }),
		);
		await mkdir(paths.outcomes, { recursive: true });
		const outcomePath = join(paths.outcomes, "corrupt-outcome.json");
		await writeFile(outcomePath, "{not json", "utf8");

		let handlerCalls = 0;
		await assert.rejects(
			sweepRegenerateRequests({
				projectDirectory: project,
				handler: async () => {
					handlerCalls += 1;
					return { result: aResult("corrupt-outcome"), resulting_revision_id: "b".repeat(64) };
				},
				contextFor: () => ({}),
			}),
		);

		assert.equal(handlerCalls, 0);
		assert.equal(await readFile(outcomePath, "utf8"), "{not json");
		assert.deepEqual(await readdir(paths.requests), ["corrupt-outcome.json.claimed"]);
		assert.deepEqual(await readdir(paths.motions), [`${poseId}.npz`]);
	});

	it("does not replay a request when its existing outcome cannot be read", async () => {
		const paths = regenerateQueuePaths(project);
		const poseId = "cclay-pose-unreadable-f8";
		await mkdir(paths.motions, { recursive: true });
		await writeFile(join(paths.motions, `${poseId}.npz`), "x", "utf8");
		await writeRegenerateRequest(
			project,
			aRequest("unreadable-outcome", { full_body: [{ frame: 8, synthetic_motion_id: poseId }] }),
		);
		await mkdir(join(paths.outcomes, "unreadable-outcome.json"), { recursive: true });

		let handlerCalls = 0;
		await assert.rejects(
			sweepRegenerateRequests({
				projectDirectory: project,
				handler: async () => {
					handlerCalls += 1;
					return { result: aResult("unreadable-outcome"), resulting_revision_id: "b".repeat(64) };
				},
				contextFor: () => ({}),
			}),
		);

		assert.equal(handlerCalls, 0);
		assert.deepEqual(await readdir(paths.requests), ["unreadable-outcome.json.claimed"]);
		assert.deepEqual(await readdir(paths.motions), [`${poseId}.npz`]);
		assert.deepEqual(await readdir(paths.outcomes), ["unreadable-outcome.json"]);
	});
	it("does not regenerate a second time for a claim whose outcome already landed", async () => {
		// The crash window that matters: runClaimed writes the outcome before
		// it clears the claim, so dying in between leaves BOTH on disk. A
		// recovery that trusts the claim alone runs the generator again and
		// commits a second revision for one animator action.
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.requests, { recursive: true });
		await mkdir(paths.motions, { recursive: true });
		await writeFile(join(paths.motions, "cclay-pose-done-f8.npz"), "x", "utf8");
		await writeFile(
			join(paths.requests, "already-ran.json.claimed"),
			JSON.stringify(
				aRequest("already-ran", {
					full_body: [{ frame: 8, synthetic_motion_id: "cclay-pose-done-f8" }],
				}),
			),
			"utf8",
		);
		await mkdir(paths.outcomes, { recursive: true });
		await writeFile(
			join(paths.outcomes, "already-ran.json"),
			JSON.stringify({
				schema_version: 1,
				request_id: "already-ran",
				status: "succeeded",
				result: aResult("already-ran", "committed-clip"),
				resulting_revision_id: "c".repeat(64),
			}),
			"utf8",
		);

		const recovered = await recoverAbandonedClaims(project);
		assert.deepEqual(recovered, [], "a finished request must not be re-queued");

		const entries = await sweepRegenerateRequests({
			projectDirectory: project,
			handler: async () => assert.fail("the generator must not run a second time"),
			contextFor: () => ({}),
		});
		assert.deepEqual(entries, []);

		// The recorded answer survives untouched, and the leftovers are gone.
		const kept = JSON.parse(await readFile(join(paths.outcomes, "already-ran.json"), "utf8"));
		assert.equal(kept.result.motion_id, "committed-clip");
		assert.deepEqual(await readdir(paths.requests), []);
		assert.deepEqual(await readdir(paths.motions), []);
	});

	it("keeps the synthetic poses when the outcome could not be written", async () => {
		// The poses ARE the replay input. Deleting them before the outcome is
		// durable turns a crash in that window into a request that can never
		// be run again, so the ordering is checked rather than assumed.
		const paths = regenerateQueuePaths(project);
		await mkdir(paths.motions, { recursive: true });
		await writeFile(join(paths.motions, "cclay-pose-keep-f8.npz"), "x", "utf8");
		await writeRegenerateRequest(
			project,
			aRequest("interrupted", {
				full_body: [{ frame: 8, synthetic_motion_id: "cclay-pose-keep-f8" }],
			}),
		);
		// A file where the outcome directory must go, so writeOutcomeAtomically
		// fails after the handler has already done its work.
		await rm(paths.outcomes, { recursive: true, force: true });
		await writeFile(paths.outcomes, "not a directory", "utf8");

		await assert.rejects(
			sweepRegenerateRequests({
				projectDirectory: project,
				handler: async (params) => ({
					result: aResult((params as { request_id: string }).request_id),
					resulting_revision_id: "b".repeat(64),
				}),
				contextFor: (request) => ({ request: { expected_revision_id: request.expected_revision_id } }),
			}),
		);

		assert.deepEqual(await readdir(paths.motions), ["cclay-pose-keep-f8.npz"]);
		assert.deepEqual(await readdir(paths.requests), ["interrupted.json.claimed"]);
	});
});
