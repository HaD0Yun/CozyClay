// Crash-window matrix for the shared ARDY queue's write-ahead machinery.
//
// The guarantee under test is deliberately narrower than "exactly-once GPU
// dispatch": once a `generated` record exists for a request_id, the queue
// never runs the generator again for it. A crash after the wrapper returned
// but before that record landed is a bounded residual that costs at most one
// extra run -- case 3a proves exactly that by counting the TOTAL runCli
// invocations across both passes, and the three-crash case proves the
// residual is PER CRASH in that window, not per request, by counting four
// runs across four passes. Every case below plants the exact on-disk
// state a host kill would leave (request claim, progress record, motion
// claims, outcome, inputs), then replays, asserting ALL FOUR dimensions
// through assertCrashDimensions: total runCli invocations, archive entry
// count, apply invocations, and residual `.claim` files. Counters are never
// reset mid-test. The queue is driven through the shared mechanics
// (sweepArdyQueue) with a fake generate-only kernel and the real
// MotionArchiveStore, so recovery, re-validation and republishing are
// exercised for real.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ArdyQueueProgressV1 } from "@cclay/protocol";
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { MotionArchiveStore } from "../src/ardy-archive-service.ts";
import {
	type ArdyQueueSweepEntry,
	type ArdyQueueWriteAhead,
	type ArdyQueueWriteAheadDescriptor,
	recoverAbandonedArdyClaims,
	sweepArdyQueue,
	writeArdyQueueProgress,
	writeArdyQueueRequest,
} from "../src/ardy-queue.ts";

const REQUEST_DIR = "harness-requests";
const OUTCOME_DIR = "harness-outcomes";
const PROGRESS_DIR = "harness-progress";
const REVISION = "a".repeat(64);
// The revision a successful apply commits. The simulated director revision
// state advances from REVISION to this on every successful apply, so a
// replay that re-applies a landed apply is rejected as a mismatch.
const ADVANCED_REVISION = "b".repeat(64);

// --- closed harness schemas -------------------------------------------------

const HarnessRequestSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		request_id: Type.String({ minLength: 1, maxLength: 256 }),
		// The mutation guard the apply dispatch binds against: identical
		// role to the capability queues' expected_revision_id. A `committed`
		// replay re-applies bound to the SAME id, so a landed apply is
		// rejected as a revision mismatch instead of double-applying.
		expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		inputs: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
type HarnessRequest = Static<typeof HarnessRequestSchema>;

const HarnessResultSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		request_id: Type.String({ minLength: 1, maxLength: 256 }),
		motion_id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
	},
	{ additionalProperties: false },
);
type HarnessResult = Static<typeof HarnessResultSchema>;

const HarnessOutcomeSchema = Type.Union([
	Type.Object(
		{
			schema_version: Type.Literal(1),
			request_id: Type.String({ minLength: 1, maxLength: 256 }),
			status: Type.Literal("succeeded"),
			result: HarnessResultSchema,
			resulting_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schema_version: Type.Literal(1),
			request_id: Type.String({ minLength: 1, maxLength: 256 }),
			status: Type.Literal("failed"),
			error_code: Type.Union([
				Type.Literal("HARNESS_FAILED"),
				Type.Literal("HARNESS_INTERRUPTED"),
				Type.Literal("REVISION_MISMATCH"),
			]),
			message: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
]);
type HarnessOutcome = Static<typeof HarnessOutcomeSchema>;
type HarnessErrorCode = "HARNESS_FAILED" | "HARNESS_INTERRUPTED" | "REVISION_MISMATCH";

// A closed failure union with no interrupted-commit member, standing in for
// a write-ahead queue whose union cannot carry that code; the condition then
// maps through the queue's own classifier instead of widening the union.
const RegenerateStyleOutcomeSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		request_id: Type.String({ minLength: 1, maxLength: 256 }),
		status: Type.Literal("failed"),
		error_code: Type.Literal("GENERATION_FAILED"),
		message: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
type RegenerateStyleOutcome = Static<typeof RegenerateStyleOutcomeSchema>;

class HarnessRevisionMismatchError extends Error {
	constructor(expectedRevisionId: string, currentRevisionId: string) {
		super(`revision mismatch: expected ${expectedRevisionId}, current revision is ${currentRevisionId}`);
		this.name = "HarnessRevisionMismatchError";
	}
}

function parseHarnessRequest(value: unknown): HarnessRequest {
	try {
		return Parse(HarnessRequestSchema, value);
	} catch {
		throw new Error("INVALID_HARNESS_REQUEST: request must match the closed harness schema");
	}
}

function parseHarnessResult(value: unknown): HarnessResult {
	try {
		return Parse(HarnessResultSchema, value);
	} catch {
		throw new Error("INVALID_HARNESS_RESULT: result must match the closed harness result schema");
	}
}

function parseHarnessOutcome(value: unknown): HarnessOutcome {
	try {
		return Parse(HarnessOutcomeSchema, value);
	} catch {
		throw new Error("INVALID_HARNESS_OUTCOME: outcome must match the closed harness schema");
	}
}

function parseRegenerateStyleOutcome(value: unknown): RegenerateStyleOutcome {
	try {
		return Parse(RegenerateStyleOutcomeSchema, value);
	} catch {
		throw new Error("INVALID_HARNESS_OUTCOME: outcome must match the closed regenerate-style schema");
	}
}

function harnessRequest(rid: string, inputs: readonly string[] = []): HarnessRequest {
	return { schema_version: 1, request_id: rid, expected_revision_id: REVISION, inputs: [...inputs] };
}

function harnessResult(rid: string, motionId: string): HarnessResult {
	return { schema_version: 1, request_id: rid, motion_id: motionId };
}

// --- real npz archives so the real store validates and republishes them -----

function u16(value: number): number[] {
	return [value & 255, value >>> 8];
}
function u32(value: number): number[] {
	return [value & 255, value >>> 8, value >>> 16, value >>> 24];
}
function npy(descr: string, shape: string, payload: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(`{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape}), }`);
	const padding = (16 - ((10 + header.length + 1) % 16)) % 16;
	const text = new Uint8Array([...header, ...new Array(padding).fill(32), 10]);
	return new Uint8Array([0x93, 78, 85, 77, 80, 89, 1, 0, ...u16(text.length), ...text, ...payload]);
}
function zip(members: readonly [string, Uint8Array][]): Uint8Array {
	const chunks: number[] = [];
	const central: number[] = [];
	for (const [name, payload] of members) {
		const nameBytes = new TextEncoder().encode(name);
		const offset = chunks.length;
		chunks.push(
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...payload,
		);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
	}
	const centralOffset = chunks.length;
	chunks.push(
		...central,
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(members.length),
		...u16(members.length),
		...u32(central.length),
		...u32(centralOffset),
		...u16(0),
	);
	return new Uint8Array(chunks);
}
function validArchive(options: { fps?: number; y?: number } = {}): Uint8Array {
	const rotations = new Float32Array(27 * 9);
	for (let joint = 0; joint < 27; joint++)
		for (let axis = 0; axis < 3; axis++) rotations[joint * 9 + axis * 3 + axis] = 1;
	const joints = new Float32Array(27 * 3);
	joints[1] = options.y ?? 1;
	return zip([
		["local_rot_mats.npy", npy("<f4", "1, 27, 3, 3", new Uint8Array(rotations.buffer))],
		["posed_joints.npy", npy("<f4", "1, 27, 3", new Uint8Array(joints.buffer))],
		["fps.npy", npy("<i4", "", new Uint8Array(new Int32Array([options.fps ?? 20]).buffer))],
	]);
}

// --- harness ----------------------------------------------------------------

interface Harness {
	readonly project: string;
	readonly descriptor: ArdyQueueWriteAheadDescriptor<HarnessRequest, HarnessOutcome, HarnessErrorCode>;
	// runCli and applies accumulate across EVERY pass of a test; they are
	// never reset, so totals are totals.
	readonly counters: { runCli: number; applies: number };
	// Simulated director revision state. apply binds against the request's
	// expected_revision_id and advances this on success, so a `committed`
	// replay of a landed apply is rejected as a mismatch. A test that
	// reconstructs a pre-apply crash state restores this to REVISION as part
	// of the planted state; the counters above are never touched.
	readonly revision: { current: string };
	// Motions-directory listings captured at the moment read() runs, so a
	// test can prove recovery ran FIRST and that losing claims survived until
	// the commit.
	readonly observedAtRead: string[][];
	readonly requestsDir: string;
	readonly outcomesDir: string;
	readonly progressDir: string;
	readonly inputsDir: string;
	readonly motionsDir: string;
	readonly store: MotionArchiveStore;
	readonly removeRequestInputs: (request: HarnessRequest) => Promise<void>;
	// Optional handler override for driving a pass with a simulated kill.
	sweep(handler?: (params: unknown) => Promise<{ result: unknown }>): Promise<ArdyQueueSweepEntry<HarnessOutcome>[]>;
	recover(): Promise<string[]>;
}

async function makeHarness(project: string): Promise<Harness> {
	const store = new MotionArchiveStore(project);
	const motionsDir = join(project, ".cclay", "motions");
	const requestsDir = join(project, ".cclay", REQUEST_DIR);
	const outcomesDir = join(project, ".cclay", OUTCOME_DIR);
	const progressDir = join(project, ".cclay", PROGRESS_DIR);
	const inputsDir = join(project, ".cclay", "harness-inputs");
	await mkdir(inputsDir, { recursive: true });
	const counters = { runCli: 0, applies: 0 };
	const revision = { current: REVISION };
	const observedAtRead: string[][] = [];
	const writeAhead: ArdyQueueWriteAhead<HarnessRequest> = {
		recoverGenerated: (motionId) => store.recoverGenerated(motionId),
		read: async (motionId) => {
			observedAtRead.push((await readdir(motionsDir)).sort());
			return store.read(motionId);
		},
		commitGenerated: (motionId) => store.commitGenerated(motionId),
		removeStaleClaims: (motionId) => store.removeStaleGeneratedClaims(motionId),
		apply: async (request) => {
			counters.applies += 1;
			if (request.expected_revision_id !== revision.current) {
				throw new HarnessRevisionMismatchError(request.expected_revision_id, revision.current);
			}
			revision.current = ADVANCED_REVISION;
			return { resulting_revision_id: revision.current };
		},
	};
	// The generate-only kernel: runCli, the wrapper's archive write, the
	// `generated` record (the kernel's onGenerated seam, carrying the full
	// parsed result), then the commit. It never applies -- the queue is the
	// single apply point.
	const handler = async (params: unknown): Promise<{ result: unknown }> => {
		const request = parseHarnessRequest(params);
		counters.runCli += 1;
		const motionId = `motion-${String(counters.runCli).padStart(12, "0")}`;
		const result = harnessResult(request.request_id, motionId);
		await store.write(motionId, validArchive());
		await writeArdyQueueProgress(progressDir, {
			schema_version: 1,
			request_id: request.request_id,
			status: "generated",
			motion_id: motionId,
			result,
		});
		await store.commitGenerated(motionId);
		return { result };
	};
	const descriptor: ArdyQueueWriteAheadDescriptor<HarnessRequest, HarnessOutcome, HarnessErrorCode> = {
		requestDirectory: REQUEST_DIR,
		outcomeDirectory: OUTCOME_DIR,
		progressDirectory: PROGRESS_DIR,
		interruptedCommitCode: "HARNESS_INTERRUPTED",
		parseRequest: parseHarnessRequest,
		parseOutcome: parseHarnessOutcome,
		parseResult: parseHarnessResult,
		classifyError: (error) => {
			if (error instanceof HarnessRevisionMismatchError) {
				return { code: "REVISION_MISMATCH", message: error.message };
			}
			return { code: "HARNESS_FAILED", message: error instanceof Error ? error.message : String(error) };
		},
		handler,
		writeAhead,
	};
	const removeRequestInputs = async (request: HarnessRequest): Promise<void> => {
		for (const name of request.inputs) {
			await rm(join(inputsDir, name), { force: true });
		}
	};
	return {
		project,
		descriptor,
		counters,
		revision,
		observedAtRead,
		requestsDir,
		outcomesDir,
		progressDir,
		inputsDir,
		motionsDir,
		store,
		removeRequestInputs,
		sweep: (handlerOverride?: (params: unknown) => Promise<{ result: unknown }>) =>
			sweepArdyQueue({
				projectDirectory: project,
				descriptor: handlerOverride === undefined ? descriptor : { ...descriptor, handler: handlerOverride },
				contextFor: () => ({}),
				removeRequestInputs,
			}),
		recover: () =>
			recoverAbandonedArdyClaims(
				project,
				{
					requestDirectory: REQUEST_DIR,
					outcomeDirectory: OUTCOME_DIR,
					progressDirectory: PROGRESS_DIR,
					parseRequest: parseHarnessRequest,
					parseOutcome: parseHarnessOutcome,
				},
				removeRequestInputs,
			),
	};
}

// --- planting helpers (the exact state a host kill leaves) -------------------

async function plantClaimedRequest(h: Harness, request: HarnessRequest): Promise<void> {
	await mkdir(h.requestsDir, { recursive: true });
	await writeFile(join(h.requestsDir, `${request.request_id}.json.claimed`), JSON.stringify(request), "utf8");
}

async function plantInputs(h: Harness, names: readonly string[]): Promise<void> {
	for (const name of names) {
		await writeFile(join(h.inputsDir, name), "input-bytes", "utf8");
	}
}

async function plantOutcome(h: Harness, requestId: string, outcome: HarnessOutcome): Promise<void> {
	await mkdir(h.outcomesDir, { recursive: true });
	await writeFile(join(h.outcomesDir, `${requestId}.json`), JSON.stringify(outcome, null, 1), "utf8");
}

function motionClaimName(motionId: string, uuid: string): string {
	return `.${motionId}.npz.${uuid}.claim`;
}

async function plantMotionClaim(
	h: Harness,
	motionId: string,
	uuid: string,
	bytes: Uint8Array | string,
	mtimeMs?: number,
): Promise<void> {
	await mkdir(h.motionsDir, { recursive: true });
	const path = join(h.motionsDir, motionClaimName(motionId, uuid));
	await writeFile(path, bytes);
	if (mtimeMs !== undefined) {
		await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
	}
}

async function plantCanonicalArchive(h: Harness, motionId: string, bytes: Uint8Array | string): Promise<void> {
	await mkdir(h.motionsDir, { recursive: true });
	await writeFile(join(h.motionsDir, `${motionId}.npz`), bytes);
}

async function claimFiles(h: Harness): Promise<string[]> {
	return (await readdir(h.motionsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".claim")).sort();
}

async function archiveFiles(h: Harness): Promise<string[]> {
	return (await readdir(h.motionsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".npz")).sort();
}

async function readOutcome(h: Harness, requestId: string): Promise<unknown> {
	return JSON.parse(await readFile(join(h.outcomesDir, `${requestId}.json`), "utf8"));
}

// Reconstructs the exact on-disk state a host kill leaves, from the durable
// artifacts a completed or failed pass produced: the outcome is removed (it
// had not been written yet at the crash instant), the claim is restored (it
// had not been retired), and the progress record is written to the status
// the crash interrupted. The runCli/applies counters keep running across
// the passes -- only the planted files describe the crash.
async function revertToCrashState(
	h: Harness,
	request: HarnessRequest,
	record: ArdyQueueProgressV1 | undefined,
): Promise<void> {
	await rm(join(h.outcomesDir, `${request.request_id}.json`), { force: true });
	await plantClaimedRequest(h, request);
	if (record !== undefined) {
		await writeArdyQueueProgress(h.progressDir, record);
	}
}

// The shared four-dimension assertion every crash case must make: TOTAL
// runCli invocations across all passes, archive entry count, apply
// invocations, and residual `.claim` files. A case that omits one of these
// is not a complete crash proof.
async function assertCrashDimensions(
	h: Harness,
	expected: { readonly runCli: number; readonly archives: number; readonly applies: number; readonly claims: number },
	label: string,
): Promise<void> {
	assert.equal(h.counters.runCli, expected.runCli, `${label}: total runCli invocations across all passes`);
	assert.equal(h.counters.applies, expected.applies, `${label}: apply invocations across all passes`);
	assert.equal((await archiveFiles(h)).length, expected.archives, `${label}: archive entries`);
	assert.equal((await claimFiles(h)).length, expected.claims, `${label}: residual .claim files`);
}

const UUID_LOW = "11111111-1111-4111-8111-111111111111";
const UUID_HIGH = "ffffffff-ffff-4fff-8fff-ffffffffffff";

describe("ardy queue write-ahead crash matrix", () => {
	let project: string;
	let h: Harness;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-matrix-"));
		h = await makeHarness(project);
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it("1: a kill between publish and claim leaves the request intact for the next sweep to claim once", async () => {
		const rid = "a".repeat(32);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, harnessRequest(rid));

		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.equal(
			entries[0].outcome.status === "succeeded" && entries[0].outcome.result.motion_id,
			"motion-000000000001",
		);
		assert.deepEqual(await readdir(h.requestsDir), []);
		assert.deepEqual(await readdir(h.progressDir), [], "the progress record is retired with the claim");
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 1, claims: 0 }, "case 1");
	});

	it("2: a kill after the claim and before any progress is recovered with inputs intact and regenerated on replay", async () => {
		const rid = "b".repeat(32);
		const input = "pose-b.npz";
		await plantInputs(h, [input]);
		await plantClaimedRequest(h, harnessRequest(rid, [input]));

		// The claim is not pending work: recovery puts it back with its
		// inputs untouched.
		assert.deepEqual(await h.sweep(), [], "a claim must not be swept as if it were pending");
		const recovered = await h.recover();
		assert.equal(recovered.length, 1);
		assert.match(recovered[0], /\.json$/);
		assert.deepEqual(await readdir(h.inputsDir), [input], "recovery must not consume the replay inputs");

		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.deepEqual(await readdir(h.requestsDir), []);
		assert.deepEqual(await readdir(h.inputsDir), [], "the inputs are retired once the outcome is durable");
		// No record existed, so the replay ran the generator: that is the
		// bounded residual, observed here as the total across both passes.
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 1, claims: 0 }, "case 2");
	});

	it("3a: a kill between the wrapper returning and the generated record costs at most one extra run", async () => {
		const rid = "c".repeat(32);
		const request = harnessRequest(rid);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, request);

		// Original run, driven in-process so its runCli is COUNTED, not
		// planted: the wrapper returns (its archive is on disk) and the host
		// dies in the seam before the generated record lands. The kernel's
		// failure stops the queue before any record, commit, apply, or
		// outcome.
		const first = await h.sweep(async (_params) => {
			h.counters.runCli += 1;
			await h.store.write(`motion-${String(h.counters.runCli).padStart(12, "0")}`, validArchive());
			throw new Error("simulated kill: wrapper returned, generated record never landed");
		});
		assert.equal(first.length, 1);
		assert.equal(first[0].outcome.status, "failed");
		assert.equal(h.counters.runCli, 1, "the original run consumed one runCli");

		// The crash state: archive present, claim present, NO record, NO
		// outcome. The in-process failure path wrote a failed outcome and
		// retired the claim; remove those to reconstruct exactly what the
		// kill left on disk. The counters keep running.
		await revertToCrashState(h, request, undefined);
		await h.recover();

		// Replay: nothing was recorded, so the queue runs the generator
		// again -- the total is 2, never more.
		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.deepEqual(
			(await archiveFiles(h)).sort(),
			["motion-000000000001.npz", "motion-000000000002.npz"],
			"the first pass's orphan archive has no record, so nothing claims it",
		);
		await assertCrashDimensions(h, { runCli: 2, archives: 2, applies: 1, claims: 0 }, "case 3a");
	});

	it("3a (three crashes): the pre-record residual is one extra run PER CRASH, not one per request (4 total)", async () => {
		// The guarantee wording in ardy-queue.ts (the header property list)
		// bounds the residual per crash in the pre-record window: N
		// consecutive crashes there cost N runs. Three crashed passes plus
		// the completing one is exactly four runCli invocations -- a bound
		// per REQUEST would cap the extra runs at one.
		const rid = "9a".repeat(16);
		const request = harnessRequest(rid);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, request);

		// Three consecutive crashes in the same seam: each pass lets the
		// wrapper return (its archive lands on disk) and dies before the
		// `generated` record. The counters accumulate across every pass --
		// nothing is reset between crashes, so the total is a total.
		for (let crash = 0; crash < 3; crash++) {
			const crashed = await h.sweep(async (_params) => {
				h.counters.runCli += 1;
				await h.store.write(`motion-${String(h.counters.runCli).padStart(12, "0")}`, validArchive());
				throw new Error(`simulated kill ${crash + 1}: wrapper returned, generated record never landed`);
			});
			assert.equal(crashed.length, 1);
			assert.equal(
				crashed[0].outcome.status,
				"failed",
				`crash pass ${crash + 1} must fail before any record, commit, or apply`,
			);
			assert.equal(h.counters.runCli, crash + 1, `crash pass ${crash + 1} consumed exactly one run`);
			// Reconstruct the exact post-kill disk state: no `generated`
			// record, outcome absent, claim restored. The crashed passes'
			// orphan archives stay on disk, exactly as case 3a's single
			// crash leaves one; nothing ever claims them.
			await revertToCrashState(h, request, undefined);
			await h.recover();
		}

		// The fourth pass completes: the record lands and the apply commits
		// exactly once. The three orphans plus the committed archive make
		// four archive entries, mirroring the four runCli invocations.
		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.equal(
			entries[0].outcome.status === "succeeded" && entries[0].outcome.result.motion_id,
			"motion-000000000004",
			"the completing pass is the fourth run",
		);
		await assertCrashDimensions(h, { runCli: 4, archives: 4, applies: 1, claims: 0 }, "case 3a (three crashes)");
	});

	it("3a companion: once the generated record exists, any number of replays never runs the generator again (total stays 1)", async () => {
		const rid = "ab".repeat(16);
		const request = harnessRequest(rid);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, request);

		// Original run completes in-process: one runCli, one record, one
		// apply.
		const first = await h.sweep();
		assert.equal(first.length, 1);
		assert.equal(first[0].outcome.status, "succeeded");
		assert.equal(h.counters.runCli, 1, "the original run consumed one runCli");
		const motionId = first[0].outcome.status === "succeeded" ? first[0].outcome.result.motion_id : "";
		const recordedResult = first[0].outcome.status === "succeeded" ? first[0].outcome.result : {};

		// Each replay iteration plants a crash AFTER the generated record
		// existed and BEFORE the apply landed: claim present, generated
		// record present (the full recorded result), no outcome, and the
		// revision still at REVISION because the crash predates the apply.
		// The runCli counter is never reset.
		for (let replay = 0; replay < 2; replay++) {
			h.revision.current = REVISION;
			await revertToCrashState(h, request, {
				schema_version: 1,
				request_id: rid,
				status: "generated",
				motion_id: motionId,
				result: recordedResult,
			});
			await h.recover();
			const entries = await h.sweep();
			assert.equal(entries.length, 1, `replay ${replay + 1} must produce one outcome`);
			assert.equal(entries[0].outcome.status, "succeeded", `replay ${replay + 1} must complete`);
			assert.equal(h.counters.runCli, 1, `replay ${replay + 1} must not run the generator`);
		}
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 3, claims: 0 }, "case 3a companion");
	});

	it("3b1: a kill inside commitGenerated after the claim rename recovers the claim with zero extra runCli", async () => {
		const rid = "d".repeat(32);
		const motionId = "motion-dddddddddddd";
		const bytes = validArchive({ fps: 21 });
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		await plantMotionClaim(h, motionId, UUID_LOW, bytes);

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), bytes);
		assert.deepEqual(await readdir(h.progressDir), [], "the progress record is retired with the claim");
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 3b1");
	});

	it("3b2: archive and claim both gone with a generated record is a terminal interrupted-commit, zero runCli", async () => {
		const rid = "e".repeat(32);
		const motionId = "motion-eeeeeeeeeeee";
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(entries[0].outcome.status, "failed");
		assert.equal(entries[0].outcome.status === "failed" && entries[0].outcome.error_code, "HARNESS_INTERRUPTED");
		const message = entries[0].outcome.status === "failed" ? entries[0].outcome.message : "";
		assert.match(message, new RegExp(motionId), "the failure must name the motion id");
		assert.match(message, /NEW request_id/, "the operator must resubmit under a new id");
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 3b2");
	});

	it("3b2 (no interrupted-commit member): the same condition maps through classifyError, not a widened union", async () => {
		// Some closed failure unions have no interrupted-commit member. Such
		// a queue maps the condition through its own classifier instead of
		// widening the union: the outcome carries the queue's own failure
		// code with the interrupted message intact.
		const rid = "f".repeat(32);
		const motionId = "motion-ffffffffffff";
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		const regenerateStyleDescriptor: ArdyQueueWriteAheadDescriptor<
			HarnessRequest,
			RegenerateStyleOutcome,
			"GENERATION_FAILED"
		> = {
			requestDirectory: REQUEST_DIR,
			outcomeDirectory: OUTCOME_DIR,
			progressDirectory: PROGRESS_DIR,
			parseRequest: parseHarnessRequest,
			parseOutcome: parseRegenerateStyleOutcome,
			parseResult: parseHarnessResult,
			classifyError: (error) => ({
				code: "GENERATION_FAILED",
				message: error instanceof Error ? error.message : String(error),
			}),
			handler: h.descriptor.handler,
			writeAhead: h.descriptor.writeAhead,
		};

		await h.recover();
		const entries = await sweepArdyQueue({
			projectDirectory: project,
			descriptor: regenerateStyleDescriptor,
			contextFor: () => ({}),
			removeRequestInputs: h.removeRequestInputs,
		});

		assert.equal(entries.length, 1);
		assert.equal(entries[0].outcome.status, "failed");
		assert.equal(entries[0].outcome.status === "failed" && entries[0].outcome.error_code, "GENERATION_FAILED");
		const message = entries[0].outcome.status === "failed" ? entries[0].outcome.message : "";
		assert.match(message, new RegExp(motionId));
		assert.match(message, /NEW request_id/);
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 3b2 fallback");
	});

	it("3b3: a kill after the internal write but before the claim unlink keeps the claim until the post-commit sweep", async () => {
		const rid = "a1".repeat(16);
		const motionId = "motion-a1a1a1a1a1a1";
		const bytes = validArchive({ fps: 22 });
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		// commitGenerated had already republished the canonical archive and
		// died before unlinking its claim; both hold the same bytes.
		await plantCanonicalArchive(h, motionId, bytes);
		await plantMotionClaim(h, motionId, UUID_LOW, bytes);

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		// Recovery never unlinks on mere existence: the claim is still on
		// disk when read() runs and is swept only after the commit succeeds.
		assert.ok(
			h.observedAtRead.length > 0 &&
				h.observedAtRead.every((listing) => listing.includes(motionClaimName(motionId, UUID_LOW))),
			"the claim must survive recovery and the readability check; only the post-commit sweep removes it",
		);
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), bytes);
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 3b3");
	});

	it("3b3 (stale-claim sweep fails): a cleanup failure after the commit never fails the request", async () => {
		const rid = "c3".repeat(16);
		const motionId = "motion-c3c3c3c3c3c3";
		const bytes = validArchive({ fps: 30 });
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		// commitGenerated had already republished the canonical archive and
		// died before unlinking its claim; both hold the same bytes.
		await plantCanonicalArchive(h, motionId, bytes);
		await plantMotionClaim(h, motionId, UUID_LOW, bytes);

		await h.recover();

		// The replay's post-commit claim sweep is best-effort (ardy-queue.ts,
		// runArdyClaimedReplay): the canonical bytes are committed by then,
		// so a leftover claim is inert garbage. Failing the request over it
		// would cost the operator another generator run for a request that
		// already succeeded.
		const failingSweep: ArdyQueueWriteAheadDescriptor<HarnessRequest, HarnessOutcome, HarnessErrorCode> = {
			...h.descriptor,
			writeAhead: {
				...h.descriptor.writeAhead,
				removeStaleClaims: async () => {
					throw new Error("simulated stale-claim cleanup failure");
				},
			},
		};
		const entries = await sweepArdyQueue({
			projectDirectory: project,
			descriptor: failingSweep,
			contextFor: () => ({}),
			removeRequestInputs: h.removeRequestInputs,
		});

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		// The recorded result is returned verbatim and the revision advanced
		// exactly once -- the cleanup failure changed none of it.
		assert.equal(
			entries[0].outcome.status === "succeeded" && entries[0].outcome.result.motion_id,
			motionId,
			"the recorded result is returned, not synthesized",
		);
		assert.equal(h.revision.current, ADVANCED_REVISION, "the replay's apply committed exactly once");
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), bytes);
		assert.deepEqual(await readdir(h.progressDir), [], "the progress record is retired with the claim");
		assert.deepEqual(await readdir(h.requestsDir), [], "the request claim is retired despite the cleanup failure");
		// The garbage survives: the request succeeds DESPITE the unremoved
		// claim -- the point is the outcome, not the sweep.
		assert.deepEqual(
			await claimFiles(h),
			[motionClaimName(motionId, UUID_LOW)],
			"the stale claim is inert garbage that survives the request, never a reason to fail it",
		);
		await assertCrashDimensions(
			h,
			{ runCli: 0, archives: 1, applies: 1, claims: 1 },
			"case 3b3 stale-claim sweep failure",
		);
	});

	it("3b4: two claims pick the newest by mtime, losers are removed only after the commit", async () => {
		const rid = "b1".repeat(16);
		const motionId = "motion-b1b1b1b1b1b1";
		const older = validArchive({ fps: 23 });
		const newer = validArchive({ fps: 24 });
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		await plantMotionClaim(h, motionId, UUID_LOW, older, 1_700_000_000_000);
		await plantMotionClaim(h, motionId, UUID_HIGH, newer, 1_700_000_000_001);

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		// The loser was still on disk when read() ran (after the restore,
		// before the commit); only the post-commit sweep removes it.
		assert.ok(
			h.observedAtRead.length > 0 &&
				h.observedAtRead.every((listing) => listing.includes(motionClaimName(motionId, UUID_LOW))),
			"the losing claim must survive until the canonical archive is present",
		);
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), newer);
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 3b4");
	});

	it("3b4 (tie): identical mtimes break on the UUID segment descending", async () => {
		const rid = "c1".repeat(16);
		const motionId = "motion-c1c1c1c1c1c1";
		const low = validArchive({ fps: 25 });
		const high = validArchive({ fps: 26 });
		const tied = 1_700_000_000_000;
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		await plantMotionClaim(h, motionId, UUID_LOW, low, tied);
		await plantMotionClaim(h, motionId, UUID_HIGH, high, tied);

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), high);
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 3b4 tie");
	});

	it("3c: a kill after commitGenerated returns and before the committed record replays with zero runCli and one revision, running the recover-read-commit trio", async () => {
		const rid = "d1".repeat(16);
		const motionId = "motion-d1d1d1d1d1d1";
		const bytes = validArchive({ fps: 27 });
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		await plantCanonicalArchive(h, motionId, bytes);

		await h.recover();

		// The planted canonical archive already looks committed, so a replay
		// that skipped the recover-read-commit trio would satisfy every
		// dimension assertion below. The trio is therefore counted: the
		// replay must actually run recoverGenerated, read, and
		// commitGenerated -- in that order -- before the apply, exactly as
		// runArdyClaimedReplay's fixed order requires.
		const trio = { recover: 0, read: 0, commit: 0 };
		const instrumentedWriteAhead: ArdyQueueWriteAhead<HarnessRequest> = {
			recoverGenerated: async (motionId) => {
				trio.recover += 1;
				return h.descriptor.writeAhead.recoverGenerated(motionId);
			},
			read: async (motionId) => {
				trio.read += 1;
				return h.descriptor.writeAhead.read(motionId);
			},
			commitGenerated: async (motionId) => {
				trio.commit += 1;
				return h.descriptor.writeAhead.commitGenerated(motionId);
			},
			removeStaleClaims: (motionId) => h.descriptor.writeAhead.removeStaleClaims(motionId),
			apply: (request, context, motionId) => h.descriptor.writeAhead.apply(request, context, motionId),
		};
		const entries = await sweepArdyQueue({
			projectDirectory: project,
			descriptor: { ...h.descriptor, writeAhead: instrumentedWriteAhead },
			contextFor: () => ({}),
			removeRequestInputs: h.removeRequestInputs,
		});

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.deepEqual(
			trio,
			{ recover: 1, read: 1, commit: 1 },
			"case 3c: the replay must run the recover-read-commit trio; a replay that skips it must not pass",
		);
		assert.deepEqual(new Uint8Array(await readFile(join(h.motionsDir, `${motionId}.npz`))), bytes);
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 3c");
	});

	it("4: a kill after apply and before the terminal outcome replays the applied record with zero applies and the recorded result verbatim", async () => {
		const rid = "e1".repeat(16);
		const request = harnessRequest(rid);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, request);

		// Original run completes in-process; its outcome is the reference
		// the replay must reproduce exactly.
		const first = await h.sweep();
		assert.equal(first.length, 1);
		const firstOutcome = first[0].outcome;
		assert.equal(firstOutcome.status, "succeeded");

		// The kill: the apply's revision commit is durable, the `applied`
		// record is not. The applied record is reconstructed from the
		// completed pass's own values (motion, full result, revision), so
		// the replay returns the RECORDED result verbatim, not a synthesis.
		const motionId = firstOutcome.status === "succeeded" ? firstOutcome.result.motion_id : "";
		await revertToCrashState(h, request, {
			schema_version: 1,
			request_id: rid,
			status: "applied",
			motion_id: motionId,
			result: firstOutcome.status === "succeeded" ? firstOutcome.result : {},
			resulting_revision_id: firstOutcome.status === "succeeded" ? firstOutcome.resulting_revision_id : "",
		});
		await h.recover();

		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0].outcome, firstOutcome, "the replayed outcome is deep-equal to the first outcome");
		assert.deepEqual(await readdir(h.progressDir), [], "the progress record is retired with the claim");
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 1, claims: 0 }, "case 4");
	});

	it("4b: a kill during apply (record still committed) replays the apply", async () => {
		const rid = "f1".repeat(16);
		const motionId = "motion-f1f1f1f1f1f1";
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "committed",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
		});
		await plantCanonicalArchive(h, motionId, validArchive({ fps: 29 }));

		await h.recover();
		const entries = await h.sweep();

		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		// The kill happened before the mutation committed, so the replay's
		// re-apply binds against the unadvanced revision and succeeds.
		await assertCrashDimensions(h, { runCli: 0, archives: 1, applies: 1, claims: 0 }, "case 4b");
	});

	it("4c: a kill after apply returned but before the applied record re-applies and the mutation boundary rejects it", async () => {
		const rid = "ef".repeat(16);
		const request = harnessRequest(rid);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, request);

		// Original run completes in-process: the apply landed durably and
		// advanced the simulated revision.
		const first = await h.sweep();
		assert.equal(first.length, 1);
		const firstOutcome = first[0].outcome;
		assert.equal(firstOutcome.status, "succeeded");
		assert.equal(h.revision.current, ADVANCED_REVISION, "the first apply advanced the revision once");

		// The kill: the apply's revision commit is durable, the `applied`
		// record is not. Reconstruct the crash state: claim present,
		// COMMITTED record present (with the full recorded result), no
		// outcome, and the revision still advanced (the apply DID land).
		const motionId = firstOutcome.status === "succeeded" ? firstOutcome.result.motion_id : "";
		await revertToCrashState(h, request, {
			schema_version: 1,
			request_id: rid,
			status: "committed",
			motion_id: motionId,
			result: firstOutcome.status === "succeeded" ? firstOutcome.result : {},
		});
		await h.recover();

		// Replay: the queue re-applies bound to the SAME expected_revision_id
		// from the request; the mutation boundary rejects it because the
		// first apply already advanced the revision. That is the
		// apply-window contract: a conservative false-negative failure,
		// never a double apply.
		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.equal(entries[0].outcome.status, "failed");
		assert.equal(entries[0].outcome.status === "failed" && entries[0].outcome.error_code, "REVISION_MISMATCH");
		const message = entries[0].outcome.status === "failed" ? entries[0].outcome.message : "";
		assert.match(message, /revision mismatch/, "the failure must be the mutation boundary's mismatch");
		assert.equal(h.revision.current, ADVANCED_REVISION, "the replay must not advance the revision again");
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 2, claims: 0 }, "case 4c");
	});

	it("5: a kill after the outcome write and before retirement replays the recorded outcome with no second apply", async () => {
		const rid = "ab".repeat(16);
		const motionId = "motion-abababababab";
		const recorded: HarnessOutcome = {
			schema_version: 1,
			request_id: rid,
			status: "succeeded",
			result: { schema_version: 1, request_id: rid, motion_id: motionId },
			resulting_revision_id: REVISION,
		};
		const input = "pose-ab.npz";
		await plantInputs(h, [input]);
		await plantClaimedRequest(h, harnessRequest(rid, [input]));
		await plantOutcome(h, rid, recorded);
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "applied",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
			resulting_revision_id: REVISION,
		});
		// The claim is not pending work; the startup sequence is recovery
		// first, which sees the terminal outcome and retires the leftovers
		// without re-running anything.
		assert.deepEqual(await h.sweep(), [], "a claim must not be swept as if it were pending");
		await h.recover();
		assert.deepEqual(await h.sweep(), []);

		assert.deepEqual(await readdir(h.requestsDir), [], "the leftovers are cleared");
		assert.deepEqual(await readdir(h.inputsDir), []);
		assert.deepEqual(await readdir(h.progressDir), [], "the stale progress record is retired too");
		assert.deepEqual(
			await readOutcome(h, rid),
			recorded,
			"the recorded outcome is the answer and is never rewritten",
		);
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 5");
	});

	it("5b: a pending request whose outcome already landed returns it and retires the stale progress record", async () => {
		// A request can still be pending while its outcome exists when a host
		// died between the outcome write and the claim retirement and the
		// claim was later re-queued; the sweep must return the recorded
		// outcome and clear the stale progress record with the claim.
		const rid = "bc".repeat(16);
		const motionId = "motion-bcbcbcbcbcbc";
		const recorded: HarnessOutcome = {
			schema_version: 1,
			request_id: rid,
			status: "succeeded",
			result: { schema_version: 1, request_id: rid, motion_id: motionId },
			resulting_revision_id: REVISION,
		};
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, harnessRequest(rid));
		await plantOutcome(h, rid, recorded);
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "applied",
			motion_id: motionId,
			result: harnessResult(rid, motionId),
			resulting_revision_id: REVISION,
		});

		const entries = await h.sweep();

		assert.deepEqual(
			entries.map((entry) => entry.outcome),
			[recorded],
		);
		assert.deepEqual(await readdir(h.requestsDir), []);
		assert.deepEqual(await readdir(h.progressDir), [], "the stale progress record is retired with the claim");
		assert.deepEqual(await readOutcome(h, rid), recorded);
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 5b");
	});
	it("K2: the claim is deleted only after the outcome is durable -- no silent-loss window", async () => {
		// M9-proof. The header property "No silent loss" IS this order: the
		// outcome must be durable BEFORE the claim (the replay token) is
		// deleted, so a kill in that window can never leave a request with
		// no claim and no outcome -- a state that could never be run again
		// and whose caller would wait forever. The only callback the queue
		// invokes inside the retirement window is removeRequestInputs (the
		// FIRST retirement step; the progress record and the claim are
		// removed only after it), so it is the observation point: a
		// retirement-order swap that deletes the claim before the outcome
		// write makes this callback observe the outcome ABSENT, which must
		// never happen.
		const rid = "77".repeat(16);
		const input = "pose-77.npz";
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, harnessRequest(rid, [input]));
		await plantInputs(h, [input]);

		const windowObservations: string[] = [];
		const instrumentedRemoveInputs = async (request: HarnessRequest): Promise<void> => {
			const outcomeExists = await stat(join(h.outcomesDir, `${rid}.json`))
				.then(() => true)
				.catch(() => false);
			const claimExists = await stat(join(h.requestsDir, `${rid}.json.claimed`))
				.then(() => true)
				.catch(() => false);
			windowObservations.push(`outcome=${outcomeExists} claim=${claimExists}`);
			assert.equal(
				outcomeExists,
				true,
				"no silent loss: when retirement begins the outcome must already be durable -- " +
					"a request with no claim and no outcome could never be run again",
			);
			assert.equal(
				claimExists,
				true,
				"the claim must still be present when retirement begins; it is deleted last, after the outcome is durable",
			);
			await h.removeRequestInputs(request);
		};

		const entries = await sweepArdyQueue({
			projectDirectory: project,
			descriptor: h.descriptor,
			contextFor: () => ({}),
			removeRequestInputs: instrumentedRemoveInputs,
		});
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0].outcome.status,
			"succeeded",
			entries[0].outcome.status === "failed" ? entries[0].outcome.message : "",
		);
		assert.ok(
			windowObservations.length > 0,
			"the retirement window must have been observed: the request carried inputs, so retirement removed them",
		);
		assert.deepEqual(await readdir(h.inputsDir), [], "the inputs are retired only after the outcome is durable");
		// Terminal state of a completed run: the outcome is on disk and the
		// claim is gone -- the caller can always read the answer.
		await stat(join(h.outcomesDir, `${rid}.json`));
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 1, claims: 0 }, "case K2");
	});

	it("6: a corrupt outcome file preserves the claim and inputs and is never overwritten", async () => {
		const rid = "cd".repeat(16);
		const input = "pose-cd.npz";
		await plantInputs(h, [input]);
		await plantClaimedRequest(h, harnessRequest(rid, [input]));
		await mkdir(h.outcomesDir, { recursive: true });
		const outcomePath = join(h.outcomesDir, `${rid}.json`);
		await writeFile(outcomePath, "{not json", "utf8");

		// The corrupt outcome surfaces during claim recovery -- before any
		// sweep -- and stops the run with the claim and inputs intact.
		await assert.rejects(h.recover());

		assert.equal(await readFile(outcomePath, "utf8"), "{not json", "the corrupt record must never be overwritten");
		assert.deepEqual(await readdir(h.requestsDir), [`${rid}.json.claimed`]);
		assert.deepEqual(await readdir(h.inputsDir), [input]);
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 6");
	});

	it("7: a corrupt progress record preserves the claim and inputs and never regenerates", async () => {
		const rid = "ef".repeat(16);
		const input = "pose-ef.npz";
		await plantInputs(h, [input]);
		await plantClaimedRequest(h, harnessRequest(rid, [input]));
		await mkdir(h.progressDir, { recursive: true });
		const progressPath = join(h.progressDir, `${rid}.json`);
		await writeFile(progressPath, "{not json", "utf8");

		// Recovery re-queues the claim (nothing terminal exists yet); the
		// sweep then hits the corrupt record and stops before any run.
		await h.recover();
		await assert.rejects(h.sweep());

		assert.equal(await readFile(progressPath, "utf8"), "{not json", "the corrupt record must never be overwritten");
		assert.deepEqual(await readdir(h.requestsDir), [`${rid}.json.claimed`]);
		assert.deepEqual(await readdir(h.inputsDir), [input]);
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 7");
	});

	it("7b: a record whose result fails the capability's closed schema is an operational error, never a reason to regenerate", async () => {
		// The record parses at the protocol layer (result is a bounded opaque
		// object there) but its result does not satisfy the descriptor's own
		// closed result parser. The queue validates on read -- before
		// anything runs -- and stops with the claim and record intact.
		const rid = "01".repeat(16);
		await plantClaimedRequest(h, harnessRequest(rid));
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: "motion-010101010101",
			result: { schema_version: 1, wrong: true },
		});

		await h.recover();
		await assert.rejects(h.sweep(), /closed result schema/);

		assert.deepEqual(await readdir(h.requestsDir), [`${rid}.json.claimed`]);
		assert.equal(h.counters.runCli, 0, "a record that cannot parse its result must never lead to regeneration");
		await assertCrashDimensions(h, { runCli: 0, archives: 0, applies: 0, claims: 0 }, "case 7b");
	});

	it("8: two concurrent sweeps on one request let exactly one claim win and produce one outcome", async () => {
		const rid = "34".repeat(16);
		await writeArdyQueueRequest(project, REQUEST_DIR, parseHarnessRequest, harnessRequest(rid));

		const [first, second] = await Promise.all([h.sweep(), h.sweep()]);

		assert.equal(first.length + second.length, 1, "exactly one sweep may claim the request");
		const entry = [...first, ...second][0];
		assert.equal(entry.outcome.status, "succeeded");
		assert.deepEqual(await readdir(h.outcomesDir), [`${rid}.json`]);
		assert.deepEqual(await readdir(h.progressDir), []);
		await assertCrashDimensions(h, { runCli: 1, archives: 1, applies: 1, claims: 0 }, "case 8");
	});
	it("K1: the atomic writer fsyncs the staged file and the containing directory, not just the rename", async () => {
		// M8-proof: durability is proven by observing the syscalls, not by
		// the comment in writeJsonAtomically. node:fs/promises exports no
		// FileHandle class in Node 24, so the shared prototype of the
		// writer's handles is reached through a real handle
		// (Object.getPrototypeOf) and its `sync` is replaced for the
		// duration of the write. Every FileHandle opened in that window --
		// the staged file's and the containing directory's -- is
		// instrumented, so deleting either fsync from writeJsonAtomically
		// removes the matching observation. No process.binding, no
		// production seam.
		const rid = "99".repeat(16);
		await mkdir(h.progressDir, { recursive: true });
		const sample = await open(join(h.progressDir, ".k1-probe"), "w");
		const handlePrototype = Object.getPrototypeOf(sample) as {
			sync: () => Promise<void>;
			stat: () => Promise<{ isDirectory(): boolean }>;
		};
		await sample.close();
		const originalSync = handlePrototype.sync;
		const syncs: string[] = [];
		handlePrototype.sync = async function (this: { stat: () => Promise<{ isDirectory(): boolean }> }) {
			const isDirectory = (await this.stat()).isDirectory();
			syncs.push(isDirectory ? "directory" : "file");
			return originalSync.call(this);
		};
		try {
			await writeArdyQueueProgress(h.progressDir, {
				schema_version: 1,
				request_id: rid,
				status: "generated",
				motion_id: "motion-999999999999",
				result: harnessResult(rid, "motion-999999999999"),
			});
		} finally {
			handlePrototype.sync = originalSync;
		}

		// writeJsonAtomically opens exactly two handles: the staged file
		// (synced BEFORE its close, hence before the rename) and the
		// containing directory (synced after). A writer that skips either
		// fsync -- or both -- fails this exact sequence.
		assert.deepEqual(
			syncs,
			["file", "directory"],
			"the staged file must be fsynced before the rename and the containing directory after it, " +
				"so a record a replay depends on survives a power loss, not just a process kill",
		);
		await stat(join(h.progressDir, `${rid}.json`));
	});

	it("progress records are written owner-only, atomically, with no partials left behind", async () => {
		const rid = "56".repeat(16);
		await writeArdyQueueProgress(h.progressDir, {
			schema_version: 1,
			request_id: rid,
			status: "generated",
			motion_id: "motion-565656565656",
			result: harnessResult(rid, "motion-565656565656"),
		});
		const info = await stat(join(h.progressDir, `${rid}.json`));
		assert.equal(info.mode & 0o777, 0o600, "progress records must be owner-only like outcomes");
		assert.deepEqual(
			(await readdir(h.progressDir)).filter((name) => name.endsWith(".partial")),
			[],
			"a reader must never observe a half-written record",
		);
	});
});
