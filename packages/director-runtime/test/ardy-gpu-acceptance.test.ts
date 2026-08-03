// The last caveat on issue #1, driven for real: the SAME production queue
// path ardy-stair-loop.test.ts proves against a FAKE wrapper is run here
// against the REAL scripts/cclay-ardy-generate wrapper, which ssh's to the
// REAL ARDY host (CCLAY_ARDY_HOST) and runs a REAL GPU generation. The
// harness shape is the stair loop's (makeHarness at ardy-stair-loop.test.ts
// :241, runner construction at :333-352) with exactly one changed seam:
// wrapperPath points at the repo's real wrapper instead of a stand-in
// script. What the stair loop could never establish -- real wrapper
// host/SSH/SCP behaviour, remote GPU generation, agreement between real
// wrapper metadata and real NPZ bytes, and the produced archive passing
// ArdyArchiveService write-time validation -- is asserted here from the
// actual generated npz.
//
// Gating: this test spends real GPU time, so it is OFF by default. It skips
// cleanly (never fails) unless CCLAY_GPU_ACCEPTANCE=1 AND CCLAY_ARDY_HOST is
// configured, so the default director-runtime suite is unaffected.
//
// The COMPLETE fake surface, identical to the stair loop:
//   - bridge.stageScene and bridge.finishDurableCommit, the two Blender-side
//     calls in the apply dispatch (apps/cclay-extension/src/cclay/index.ts
//     is canonicalize -> bridge.stageScene -> commitStageSceneMutation ->
//     bridge.finishDurableCommit). stageScene is simulated by recomputing
//     the add-on's mutation candidate with the SAME canonical child-revision
//     derivation commitStageSceneMutation validates against, and
//     finishDurableCommit is a no-op that advances the live-revision getter
//     exactly as the real bridge's ack advances bridge.revisionId.
//     Canonicalization and the durable ProjectStore commit are REAL.
// Real Blender is a separate axis, already covered by the add-on's own
// real-Blender fixtures, and is deliberately not exercised here.
//
// ardy_inbetween is NOT exercised, on purpose: the in-between path consumes
// the pose archives the add-on's Blender-side capture_evaluated_pose writes
// (cclay-pose-<request_id>-<n>.npz, blender-addon/cclay/constraint_capture
// .py). Without real Blender those poses cannot exist, and planting the
// synthetic archives the stair loop mints would be faking exactly the
// capture this story is about. This test proves the REAL generate leg; the
// in-between leg stays with the stair loop plus real-Blender coverage.
//
// runCli count: the real wrapper has no argv log, so exactly-one invocation
// is observed the way the wrapper makes it observable -- the wrapper stages
// one npz per invocation (.cclay/motions/<motion_id>.npz) and the runner's
// commitGenerated republishes it, so one archive entry means one invocation;
// and resubmitting the request id returns the recorded outcome through the
// queue's existing-outcome read (ardy-queue.ts:272) with zero new files.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { buildSceneManifestV4Revision, type ManifestForHashing, ProjectStore } from "@cclay/director-core";
import {
	ArdyArchiveService,
	commitStageSceneMutation,
	generateQueuePaths,
	isArdyHostConfigured,
	MotionArchiveStore,
} from "@cclay/director-runtime";
import {
	type ArdyGenerateRequestV1,
	canonicalizeStageScenePlan,
	parseSceneManifestV4,
	type SceneManifestV4,
	type StageSceneAppliedHandShape,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
	type StageSceneRequestV1,
} from "@cclay/protocol";
import { startGenerateQueueRunner } from "../../../apps/cclay-extension/src/generate-queue-runner.ts";

const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const GENERATE_REQUEST_ID = "abcdef0123456789abcdef0123456789";
const PROMPT = "a person waves both hands";

// The REAL wrapper, resolved from this module so it works regardless of cwd.
const REAL_WRAPPER_PATH = fileURLToPath(new URL("../../../scripts/cclay-ardy-generate", import.meta.url));

// The nine members ARDY's generators serialize (blender-addon/tests/
// test_stage_scene_validation.py:410 pins this direction).
const ARDY_MEMBER_NAMES = [
	"foot_contacts.npy",
	"fps.npy",
	"global_root_heading.npy",
	"global_rot_mats.npy",
	"local_rot_mats.npy",
	"posed_joints.npy",
	"root_positions.npy",
	"smooth_root_pos.npy",
	"text.npy",
];

const GPU_ACCEPTANCE_READY = process.env.CCLAY_GPU_ACCEPTANCE === "1" && isArdyHostConfigured();

// The project the loop starts from: a REAL V4 scene manifest (the same
// director-core parity fixture the stage-scene commit tests use), written
// into a REAL ProjectStore. R0 is the manifest's own recorded revision.
const initialManifest = parseSceneManifestV4(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v4-parity.json", import.meta.url),
			"utf8",
		),
	),
);
const R0 = initialManifest.revisionId;

function generateRequest(): ArdyGenerateRequestV1 {
	return {
		schema_version: 1,
		request_id: GENERATE_REQUEST_ID,
		entity_id: ENTITY,
		expected_revision_id: R0,
		prompt: PROMPT,
		duration_seconds: 5,
		seed: 7,
		requested_at_ms: 1_700_000_000_000,
	};
}

// --- Minimal real-npz reader -------------------------------------------------
// numpy savez writes a ZIP container of NPY members (stored, or deflated by
// some versions); this parses both so the invariants are asserted from the
// actual generated bytes, never from the wrapper's JSON.
interface ZipEntry {
	readonly name: string;
	readonly method: number;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	readonly offset: number;
}

interface NpzMember {
	readonly name: string;
	readonly descr: string;
	readonly shape: readonly number[];
	readonly payload: Uint8Array;
}

interface Descr {
	readonly byteOrder: "<" | ">" | "|";
	readonly kind: string;
	readonly width: number;
}

function readU16(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function parseZipEntries(archive: Uint8Array): ZipEntry[] {
	const windowStart = archive.length > 65_557 ? archive.length - 65_557 : 0;
	let eocd = -1;
	for (let cursor = archive.length - 22; cursor >= windowStart; cursor--) {
		if (readU32(archive, cursor) === 0x06054b50) {
			eocd = cursor;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a ZIP/NPZ archive (no end-of-central-directory record)");
	const count = readU16(archive, eocd + 10);
	const centralOffset = readU32(archive, eocd + 16);
	const entries: ZipEntry[] = [];
	let cursor = centralOffset;
	for (let index = 0; index < count; index++) {
		if (readU32(archive, cursor) !== 0x02014b50) throw new Error("malformed central directory entry");
		const method = readU16(archive, cursor + 10);
		const compressedSize = readU32(archive, cursor + 20);
		const uncompressedSize = readU32(archive, cursor + 24);
		const nameLength = readU16(archive, cursor + 28);
		const extraLength = readU16(archive, cursor + 30);
		const commentLength = readU16(archive, cursor + 32);
		const offset = readU32(archive, cursor + 42);
		const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
		entries.push({ name, method, compressedSize, uncompressedSize, offset });
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function extractMember(archive: Uint8Array, entry: ZipEntry): Uint8Array {
	if (readU32(archive, entry.offset) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
	const nameLength = readU16(archive, entry.offset + 26);
	const extraLength = readU16(archive, entry.offset + 28);
	const dataStart = entry.offset + 30 + nameLength + extraLength;
	if (dataStart + entry.compressedSize > archive.length) throw new Error(`${entry.name} data overruns the archive`);
	const data = archive.subarray(dataStart, dataStart + entry.compressedSize);
	if (entry.method === 0) {
		if (data.length !== entry.uncompressedSize) throw new Error(`${entry.name} stored size mismatch`);
		return new Uint8Array(data);
	}
	if (entry.method === 8) {
		return new Uint8Array(inflateRawSync(data, { maxOutputLength: entry.uncompressedSize }));
	}
	throw new Error(`${entry.name} uses unsupported zip method ${entry.method}`);
}

function parseNpyMember(name: string, bytes: Uint8Array): NpzMember {
	if (
		bytes.length < 10 ||
		bytes[0] !== 0x93 ||
		bytes[1] !== 0x4e ||
		bytes[2] !== 0x55 ||
		bytes[3] !== 0x4d ||
		bytes[4] !== 0x50 ||
		bytes[5] !== 0x59
	) {
		throw new Error(`${name} is not an NPY member`);
	}
	const version = bytes[6]!;
	const headerLength = version === 1 ? readU16(bytes, 8) : version === 2 || version === 3 ? readU32(bytes, 8) : -1;
	if (headerLength < 0 || 10 + headerLength > bytes.length) throw new Error(`${name} has an invalid NPY header`);
	const header = new TextDecoder().decode(bytes.subarray(10, 10 + headerLength));
	const descrMatch = /'descr':\s*'([^']+)'/.exec(header);
	const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
	if (descrMatch === null || shapeMatch === null) throw new Error(`${name} NPY header is missing descr or shape`);
	const shapeText = shapeMatch[1]!.trim();
	const shape =
		shapeText === ""
			? []
			: shapeText
					.split(",")
					.map((part) => part.trim())
					.filter((part) => part !== "")
					.map((part) => Number(part));
	return { name, descr: descrMatch[1]!, shape, payload: bytes.subarray(10 + headerLength) };
}

function loadNpz(archive: Uint8Array): Map<string, NpzMember> {
	const members = new Map<string, NpzMember>();
	for (const entry of parseZipEntries(archive)) {
		members.set(entry.name, parseNpyMember(entry.name, extractMember(archive, entry)));
	}
	if (members.size === 0) throw new Error("npz contains no members");
	return members;
}

function parseDescr(descr: string): Descr {
	const match = /^([<>=|])([A-Za-z])(\d*)$/.exec(descr);
	if (match === null) throw new Error(`unrecognized npz dtype descr '${descr}'`);
	return {
		byteOrder: match[1] as "<" | ">" | "|",
		kind: match[2]!,
		width: match[3] === "" ? 1 : Number(match[3]),
	};
}

function readNumeric(member: NpzMember, elementIndex: number): number {
	const descr = parseDescr(member.descr);
	if (descr.kind !== "f" && descr.kind !== "i" && descr.kind !== "u" && descr.kind !== "b") {
		throw new Error(`${member.name} is not a numeric member`);
	}
	const little = descr.byteOrder === "<" || descr.byteOrder === "|";
	const view = new DataView(member.payload.buffer, member.payload.byteOffset, member.payload.byteLength);
	const offset = elementIndex * descr.width;
	switch (descr.kind) {
		case "f":
			if (descr.width === 4) return view.getFloat32(offset, little);
			if (descr.width === 8) return view.getFloat64(offset, little);
			throw new Error(`${member.name} has unsupported float width ${descr.width}`);
		case "i":
			if (descr.width === 1) return view.getInt8(offset);
			if (descr.width === 2) return view.getInt16(offset, little);
			if (descr.width === 4) return view.getInt32(offset, little);
			if (descr.width === 8) return Number(view.getBigInt64(offset, little));
			throw new Error(`${member.name} has unsupported int width ${descr.width}`);
		case "u":
			if (descr.width === 1) return view.getUint8(offset);
			if (descr.width === 2) return view.getUint16(offset, little);
			if (descr.width === 4) return view.getUint32(offset, little);
			if (descr.width === 8) return Number(view.getBigUint64(offset, little));
			throw new Error(`${member.name} has unsupported uint width ${descr.width}`);
		default:
			throw new Error(`${member.name} is not numeric`);
	}
}

// --- Harness (the stair-loop shape; the only changed seam is wrapperPath) ---
interface Harness {
	readonly project: string;
	readonly store: MotionArchiveStore;
	readonly archiveService: ArdyArchiveService;
	readonly projectStore: ProjectStore;
	readonly motionsDir: string;
	readonly generatePaths: ReturnType<typeof generateQueuePaths>;
	// Mirrors the real bridge's revisionId: advanced by the fake
	// finishDurableCommit ack, read fresh by the runners' staleness guards.
	readonly bridgeRevision: { current: string };
	// Every apply_motion plan the real plan builder produced, in apply order.
	readonly applyPlans: StageSceneRequestV1[];
	// The production contexts the apply dispatches observed, in apply order.
	readonly bridgeContexts: unknown[];
	readonly generateRunner: ReturnType<typeof startGenerateQueueRunner>;
}

async function makeHarness(project: string): Promise<Harness> {
	const projectStore = new ProjectStore(project);
	await projectStore.writeProject({
		project_id: initialManifest.projectId,
		schema_version: 1,
		current_revision_id: R0,
		manifest: initialManifest,
	});
	const store = new MotionArchiveStore(project);
	const generatePaths = generateQueuePaths(project);
	const bridgeRevision = { current: R0 };
	const applyPlans: StageSceneRequestV1[] = [];
	const bridgeContexts: unknown[] = [];

	// The production mutation glue (apps/cclay-extension/src/cclay/index.ts),
	// with ONLY the two Blender-side calls faked (same as the stair loop).
	const mutationBridge = {
		stageScene: async (plan: StageScenePlanV1, context: unknown): Promise<StageSceneMutationCandidate> => {
			bridgeContexts.push(context);
			// The add-on's mutation candidate, rebuilt with the SAME canonical
			// child-revision derivation commitStageSceneMutation validates
			// against: the manifest hashes and the child revision id are
			// computed by production code, never chosen here.
			const current = await projectStore.readProject();
			const durableManifest = current.manifest as SceneManifestV4;
			const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = durableManifest;
			const manifestForHashing: ManifestForHashing = hashFree;
			const candidateManifest = buildSceneManifestV4Revision(manifestForHashing, plan.expected_revision_id, plan);
			const appliedHandShapes: StageSceneAppliedHandShape[] = [];
			for (const [index, operation] of plan.operations.entries()) {
				if (operation.op !== "apply_motion") continue;
				appliedHandShapes.push({
					operation_index: index,
					entity_id: operation.entity_id,
					motion_id: operation.motion_id,
					left: "relaxed",
					right: "relaxed",
					library_version: "1.1.0",
				});
			}
			return {
				expected_revision_id: plan.expected_revision_id,
				scene_hash: candidateManifest.sceneHash,
				manifest: candidateManifest,
				entity_identities: [],
				applied_hand_shapes: appliedHandShapes,
			};
		},
		finishDurableCommit: (resultingRevisionId: string): void => {
			// The Blender transaction ack; the real bridge also advances
			// bridge.revisionId here. Mirror exactly that: the live-revision
			// getter the runners' staleness guards read.
			bridgeRevision.current = resultingRevisionId;
		},
	};
	const stageScene = async (request: StageSceneRequestV1, context: unknown) => {
		applyPlans.push(request);
		const plan = canonicalizeStageScenePlan(request, randomUUID);
		const candidate = await mutationBridge.stageScene(plan, context);
		const result = await commitStageSceneMutation(projectStore, plan, candidate);
		await mutationBridge.finishDurableCommit(result.resulting_revision_id);
		return result;
	};

	const generateRunner = startGenerateQueueRunner({
		cwd: project,
		liveRevisionId: () => bridgeRevision.current,
		stageScene,
		// The one seam that differs from the stair-loop harness: the REAL
		// wrapper, talking to the REAL ARDY host.
		wrapperPath: REAL_WRAPPER_PATH,
		tickMs: 60_000,
		onError: (error) => {
			throw error;
		},
	});
	await generateRunner.started;

	return {
		project,
		store,
		archiveService: new ArdyArchiveService(store),
		projectStore,
		motionsDir: join(project, ".cclay", "motions"),
		generatePaths,
		bridgeRevision,
		applyPlans,
		bridgeContexts,
		generateRunner,
	};
}

async function motionFiles(project: string): Promise<string[]> {
	return (await readdir(join(project, ".cclay", "motions")).catch(() => [] as string[]))
		.filter((name) => name.endsWith(".npz"))
		.sort();
}

function assertProductionContext(context: unknown, expectedRevisionId: string, label: string): void {
	const record = context as { request?: { expected_revision_id?: unknown }; signal?: unknown } | null;
	assert.ok(
		record !== null && typeof record === "object",
		`${label}: the runner must pass the production request context`,
	);
	assert.equal(
		record.request?.expected_revision_id,
		expectedRevisionId,
		`${label}: the context binds the request's expected revision`,
	);
	assert.ok(record.signal instanceof AbortSignal, `${label}: the context carries the production AbortSignal timeout`);
}

// --- Evidence capture ---------------------------------------------------------
// When CCLAY_GPU_ACCEPTANCE_OUT is set, the test preserves the produced npz
// and a machine-readable summary there (used to write .artifacts/gpu-
// acceptance/report.md). Unset in the default suite; the test body is skipped
// anyway when gated off.
interface Evidence {
	readonly status: "succeeded" | "failed";
	readonly generate_wall_ms: number;
	readonly request_id: string;
	readonly prompt: string;
	readonly motion_id?: string;
	readonly npz_file?: string;
	readonly npz_sha256?: string;
	readonly frames?: number;
	readonly duration_seconds?: number;
	readonly fps?: number;
	readonly fps_descr?: string;
	readonly members?: { readonly name: string; readonly shape: readonly number[]; readonly descr: string }[];
	readonly frame0_hips?: readonly number[];
	readonly revision_from?: string;
	readonly revision_to?: string;
	readonly outcome?: unknown;
}

async function writeEvidence(outputDirectory: string, evidence: Evidence, project: string): Promise<void> {
	await mkdir(outputDirectory, { recursive: true });
	if (evidence.motion_id !== undefined) {
		const source = join(project, ".cclay", "motions", `${evidence.motion_id}.npz`);
		try {
			await copyFile(source, join(outputDirectory, `${evidence.motion_id}.npz`));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await writeFile(join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, "\t")}\n`);
}

describe("ardy gpu acceptance", () => {
	it(
		"REAL ardy_generate through the production queue runner: one GPU generation committed, archived, and applied, with the npz invariants asserted from the actual file",
		{ timeout: 2_100_000 },
		async (t) => {
			if (!GPU_ACCEPTANCE_READY) {
				t.skip(
					"gated: requires CCLAY_GPU_ACCEPTANCE=1 and a configured CCLAY_ARDY_HOST (real GPU acceptance; see file header)",
				);
				return;
			}
			const project = await mkdtemp(join(tmpdir(), "cclay-gpu-acceptance-"));
			const outputDirectory = process.env.CCLAY_GPU_ACCEPTANCE_OUT;
			let h: Harness | undefined;
			let evidence: Evidence | undefined;
			try {
				h = await makeHarness(project);

				const generateStartMs = performance.now();
				const generateOutcome = await h.generateRunner.generate(generateRequest());
				const generateWallMs = performance.now() - generateStartMs;

				assert.equal(
					generateOutcome.status,
					"succeeded",
					generateOutcome.status === "failed" ? generateOutcome.message : "",
				);
				assert.equal(generateOutcome.request_id, GENERATE_REQUEST_ID);
				const result = generateOutcome.status === "succeeded" ? generateOutcome.result : undefined;
				assert.ok(result !== undefined, "the generate outcome must carry a result");
				assert.equal(result.duration_seconds, 5, "the wrapper echoes the requested duration");
				assert.equal(result.seed, 7, "the request's seed reaches the result");
				const motionId = result.motion_id;

				// The revision advanced and was PERSISTED by the canonical
				// child-revision derivation, never chosen by this harness.
				const R1 = (await h.projectStore.readProject()).current_revision_id;
				assert.equal(
					generateOutcome.resulting_revision_id,
					R1,
					"the generate apply commits the canonical child revision",
				);
				assert.notEqual(R1, R0, "the canonical child revision must differ from its parent");
				assert.equal(
					h.bridgeRevision.current,
					R1,
					"the fake ack advances the live revision exactly as the bridge does",
				);
				assert.deepEqual(h.applyPlans, [
					{
						schema_version: 1,
						expected_revision_id: R0,
						operations: [{ op: "apply_motion", entity_id: ENTITY, motion_id: motionId }],
					},
				]);
				assertProductionContext(h.bridgeContexts[0], R0, "the generate apply dispatch");

				// Exactly one wrapper invocation, observed the way the real
				// wrapper makes it observable: one staged archive per run.
				const motions = await motionFiles(project);
				assert.deepEqual(
					motions,
					[`${motionId}.npz`],
					"exactly one archive entry: one real wrapper invocation staged exactly one npz",
				);

				// The produced bytes pass the real archive service's
				// write-time validation on read-back. Compared through
				// Buffer: assert.deepEqual rejects a Uint8Array against a
				// Buffer even when the bytes are identical.
				const archive = await readFile(join(project, ".cclay", "motions", `${motionId}.npz`));
				assert.deepEqual(
					Buffer.from(await h.archiveService.read(motionId)),
					archive,
					"ArdyArchiveService read-back must accept the committed archive",
				);

				// Assert the real npz invariants from the actual bytes.
				const members = loadNpz(archive);
				assert.deepEqual([...members.keys()].sort(), ARDY_MEMBER_NAMES, "the npz must carry ARDY's nine members");
				const rotations = members.get("local_rot_mats.npy")!;
				const joints = members.get("posed_joints.npy")!;
				const fpsMember = members.get("fps.npy")!;
				const frames = rotations.shape[0]!;
				assert.ok(frames >= 1, "the clip must have at least one frame");
				assert.deepEqual([...rotations.shape], [frames, 27, 3, 3], "local_rot_mats must be (F, 27, 3, 3)");
				assert.equal(parseDescr(rotations.descr).kind, "f", "local_rot_mats must be floating point");
				assert.deepEqual([...joints.shape], [frames, 27, 3], "posed_joints must be (F, 27, 3)");
				assert.equal(parseDescr(joints.descr).kind, "f", "posed_joints must be floating point");
				assert.deepEqual(fpsMember.shape, [], "fps must be a scalar");
				const fpsDescr = parseDescr(fpsMember.descr);
				assert.equal(fpsDescr.kind, "i", "fps must be integral");
				assert.equal(fpsDescr.width, 8, "fps must be int64");
				assert.equal(readNumeric(fpsMember, 0), 20, "fps must be 20");
				// Agreement between real wrapper metadata and real NPZ bytes:
				// the wrapper probed this exact npz for its frame count.
				assert.equal(
					result.frames,
					frames,
					"the wrapper's reported frames must equal the npz's actual frame count",
				);

				// Finiteness across every float member (the write-time
				// validator checks posed_joints + local_rot_mats; this checks
				// all of ARDY's carried floats from the parsed bytes).
				for (const member of members.values()) {
					if (parseDescr(member.descr).kind !== "f") continue;
					const count = member.shape.reduce((total, dim) => total * dim, 1);
					for (let index = 0; index < count; index++) {
						assert.ok(
							Number.isFinite(readNumeric(member, index)),
							`${member.name} element ${index} is not finite`,
						);
					}
				}

				// Frame-0 cskel27 Hips +Y dominant: the Y-up invariant
				// motion_preflight.py:459-462 enforces. The write-time
				// validator (ardy-archive-service.ts:303) already demanded
				// the stricter strict-> variant during commitGenerated.
				const hips = [readNumeric(joints, 0), readNumeric(joints, 1), readNumeric(joints, 2)];
				assert.ok(
					hips[1]! > 0 && Math.abs(hips[1]!) >= Math.abs(hips[0]!) && Math.abs(hips[1]!) >= Math.abs(hips[2]!),
					`frame-0 Hips must be +Y dominant, got ${JSON.stringify(hips)}`,
				);

				// Terminal queue state: request and progress retired, outcome
				// durable, nothing left in flight.
				assert.deepEqual(await readdir(h.generatePaths.requests), []);
				assert.deepEqual(await readdir(h.generatePaths.outcomes), [`${GENERATE_REQUEST_ID}.json`]);
				assert.deepEqual(await readdir(h.generatePaths.progress), []);

				// Resubmitting the same request id is a read of the recorded
				// outcome, never another run: byte-identical outcome, no new
				// archive entry, no second revision.
				const generateAgain = await h.generateRunner.generate(generateRequest());
				assert.deepEqual(
					generateAgain,
					generateOutcome,
					"resubmitting the request id must return the identical recorded outcome",
				);
				assert.deepEqual(
					await motionFiles(project),
					[`${motionId}.npz`],
					"resubmission must not invoke the wrapper again",
				);
				assert.equal(
					(await h.projectStore.readProject()).current_revision_id,
					R1,
					"resubmission must not commit another revision",
				);

				evidence = {
					status: "succeeded",
					generate_wall_ms: Math.round(generateWallMs),
					request_id: GENERATE_REQUEST_ID,
					prompt: PROMPT,
					motion_id: motionId,
					npz_file: `${motionId}.npz`,
					npz_sha256: createHash("sha256").update(archive).digest("hex"),
					frames,
					duration_seconds: result.duration_seconds,
					fps: 20,
					fps_descr: fpsMember.descr,
					members: [...members.keys()].sort().map((name) => {
						const member = members.get(name)!;
						return { name, shape: member.shape, descr: member.descr };
					}),
					frame0_hips: hips,
					revision_from: R0,
					revision_to: R1,
					outcome: generateOutcome,
				};
				console.log(`gpu-acceptance: ${JSON.stringify(evidence)}`);
			} finally {
				if (outputDirectory !== undefined) {
					try {
						await writeEvidence(
							outputDirectory,
							evidence ?? {
								status: "failed",
								generate_wall_ms: 0,
								request_id: GENERATE_REQUEST_ID,
								prompt: PROMPT,
							},
							project,
						);
					} catch (error) {
						console.error(
							`gpu-acceptance: could not write evidence to ${outputDirectory}: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
				await h?.generateRunner.stop();
				await rm(project, { recursive: true, force: true });
			}
		},
	);
});
