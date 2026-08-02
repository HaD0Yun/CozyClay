// ARDY in-between pose generation: re-run the CONSTRAINED wrapper against a
// base clip, synthesizing the frames between full-body poses the add-on
// captured at scene frames.
//
// The synthetic pose archives are produced by the add-on's
// capture_evaluated_pose step (blender-addon/cclay/constraint_capture.py),
// which mints exactly `cclay-pose-<request_id>-<index + 1>` per pose_frames
// entry in declared order -- "the ordinal is the declared order, which is
// what the host reproduces when it rebuilds the --pose-from argv". The
// request schema deliberately does NOT carry them (the protocol is the
// add-on's capture contract, not the host's), so this service derives them
// with the identical rule and consumes them; it never captures.
//
// Both archive checks run BEFORE the wrapper: a missing base archive is
// BASE_MOTION_NOT_FOUND and a missing synthetic pose is POSE_CAPTURE_FAILED,
// and neither can burn a GPU run. The argv is the regenerate service's
// constrained invocation with the pose list as repeated
// [--constrain-pose <synthetic-id> 0 <clip_frame>] blocks:
//
//   [ARDY_CONSTRAINED_PROMPT, "--duration", ARDY_CONSTRAINED_DURATION_SECONDS,
//    "--base-motion", <base_motion_id>, "--constrain-pose", <id>, "0", <frame>, ...]
//
// clip_frame is pinned by the protocol to <= ARDY_CONSTRAINED_CLIP_FRAME_MAX
// (11999), the last index of the 600 s x 20 fps constrained clip the wrapper
// always generates, and the wrapper validates pose dst-frames against that
// same 0..<12000 bound locally before ssh -- so an out-of-range pose is
// structurally unreachable and dropped_constraints is always empty, unlike
// regenerate, whose constraint frames are unbounded in its request schema.
//
// The generation mechanics are the shared ArdyMotionKernel
// (./ardy-motion-kernel.ts), parameterized here with the in-between
// capability: the archive-input preflight (base clip plus every synthetic
// pose), the pose-list argv builder, and the in-between result adapter.
import type { ArdyInbetweenErrorCode, ArdyInbetweenRequestV1, ArdyInbetweenResultV1 } from "@cclay/protocol";
import {
	ARDY_CONSTRAINED_DURATION_SECONDS,
	ARDY_CONSTRAINED_PROMPT,
	parseArdyInbetweenRequest,
	parseArdyInbetweenResult,
} from "@cclay/protocol";
import type { ArdyArchiveService } from "./ardy-archive-service.ts";
import {
	type ArdyCliResult,
	type ArdyCliRunner,
	ArdyMotionKernel,
	isArdyHostUnavailableFailure,
} from "./ardy-motion-kernel.ts";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export const ARDY_INBETWEEN_WRAPPER = "cclay-ardy-generate";

// The exact id rule capture_evaluated_pose mints synthetic pose archives
// with (constraint_capture.py:1235-1237: f"cclay-pose-{request_id}-{index+1}").
// The service derives them so a sweep and the orphan lifecycle can name the
// same files; the add-on's comment there says the ordinal is the declared
// order, which is exactly what the --constrain-pose argv reproduces.
export function inbetweenSyntheticPoseIds(request: ArdyInbetweenRequestV1): string[] {
	return request.pose_frames.map((_, index) => `cclay-pose-${request.request_id}-${index + 1}`);
}

export type ArdyInbetweenCliResult = ArdyCliResult;

export type ArdyInbetweenCliRunner = ArdyCliRunner;

export interface ArdyInbetweenApplyMotionResult {
	readonly resulting_revision_id: string;
}

export type ArdyInbetweenApplyMotionDispatch = (
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
	context: DirectorHandlerContext,
) => Promise<ArdyInbetweenApplyMotionResult>;

export class ArdyInbetweenError extends Error {
	readonly code: ArdyInbetweenErrorCode;

	constructor(code: ArdyInbetweenErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ArdyInbetweenError";
		this.code = code;
	}
}

export class ArdyInbetweenInvalidRequestError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("INVALID_ARDY_INBETWEEN_REQUEST", message, options);
		this.name = "ArdyInbetweenInvalidRequestError";
	}
}

export class ArdyInbetweenRevisionMismatchError extends ArdyInbetweenError {
	constructor(expectedRevisionId: string, actualRevisionId: unknown) {
		super(
			"REVISION_MISMATCH",
			`inbetween expected ${expectedRevisionId}, request expected ${String(actualRevisionId)}`,
		);
		this.name = "ArdyInbetweenRevisionMismatchError";
	}
}

export class ArdyInbetweenBaseMotionNotFoundError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("BASE_MOTION_NOT_FOUND", message, options);
		this.name = "ArdyInbetweenBaseMotionNotFoundError";
	}
}

export class ArdyInbetweenPoseCaptureFailedError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("POSE_CAPTURE_FAILED", message, options);
		this.name = "ArdyInbetweenPoseCaptureFailedError";
	}
}

export class ArdyInbetweenHostUnavailableError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("ARDY_HOST_UNAVAILABLE", message, options);
		this.name = "ArdyInbetweenHostUnavailableError";
	}
}

export class ArdyInbetweenGenerationError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("GENERATION_FAILED", message, options);
		this.name = "ArdyInbetweenGenerationError";
	}
}

export class ArdyInbetweenApplyMotionError extends ArdyInbetweenError {
	constructor(message: string, options?: ErrorOptions) {
		super("APPLY_FAILED", message, options);
		this.name = "ArdyInbetweenApplyMotionError";
	}
}

export interface ArdyInbetweenKernelOptions {
	readonly runCli: ArdyInbetweenCliRunner;
	readonly archive: Pick<ArdyArchiveService, "read" | "commitGenerated">;
	// Seam for write-ahead progress records: awaited once the wrapper result
	// has been parsed and before the generated archive is committed, so an
	// intent recorded here is durable before the commit is observable. When
	// absent, the kernel behaves exactly as before the seam existed.
	readonly onGenerated?: (motionId: string, result: ArdyInbetweenResultV1) => Promise<void>;
}

export interface ArdyInbetweenHandlerOptions extends ArdyInbetweenKernelOptions {
	readonly applyMotion: ArdyInbetweenApplyMotionDispatch;
	// The CURRENT project revision, read fresh on every in-between call. The
	// request's expected_revision_id is checked against it before the
	// generator runs, so a request written against an older scene fails fast
	// instead of spending GPU minutes on a clip that would be rejected at
	// apply time. Required, not optional with a fallback: an optional
	// freshness check that silently defaults is how the tautological context
	// comparison got in.
	readonly liveRevisionId: () => string;
}

function buildInbetweenArgv(request: ArdyInbetweenRequestV1): string[] {
	const argv = [
		ARDY_CONSTRAINED_PROMPT,
		"--duration",
		ARDY_CONSTRAINED_DURATION_SECONDS,
		"--base-motion",
		request.base_motion_id,
	];
	// One four-word block per captured pose, in declared order: the synthetic
	// id (derived with the add-on's rule), src-frame "0" (the pose archives
	// are single-frame), and the clip frame the pose is bound to.
	const poseIds = inbetweenSyntheticPoseIds(request);
	for (let index = 0; index < request.pose_frames.length; index++) {
		argv.push("--constrain-pose", poseIds[index]!, "0", String(request.pose_frames[index]!.clip_frame));
	}
	return argv;
}

function adaptWrapperJsonToResult(wrapperJson: unknown, request: ArdyInbetweenRequestV1): unknown {
	if (typeof wrapperJson !== "object" || wrapperJson === null) {
		throw new ArdyInbetweenGenerationError("wrapper stdout is not a JSON object");
	}
	const wrapper = wrapperJson as { motion_id?: unknown; frames?: unknown; continuity?: unknown };
	if (typeof wrapper.motion_id !== "string") {
		throw new ArdyInbetweenGenerationError("wrapper JSON is missing motion_id");
	}
	if (typeof wrapper.frames !== "number" || !Number.isInteger(wrapper.frames)) {
		throw new ArdyInbetweenGenerationError("wrapper JSON is missing an integer frames count");
	}
	return {
		schema_version: 1,
		request_id: request.request_id,
		motion_id: wrapper.motion_id,
		frames: wrapper.frames,
		captured_frames: request.pose_frames.length,
		base_motion_id: request.base_motion_id,
		// Validated by the closed result schema; a wrapper JSON without the
		// measured continuity fails the parse below.
		continuity: wrapper.continuity,
		dropped_constraints: [],
	};
}

/**
 * The in-between capability's binding of the shared ArdyMotionKernel: the
 * archive-input preflight, the pose-list argv, and the in-between result
 * adapter. Kept as a named class so the write-ahead queue and tests
 * construct exactly the generate-only kernel (runCli through
 * commitGenerated, no apply).
 */
export class ArdyInbetweenKernel extends ArdyMotionKernel<
	ArdyInbetweenRequestV1,
	ArdyInbetweenResultV1,
	ArdyInbetweenError
> {
	constructor(options: ArdyInbetweenKernelOptions) {
		super({
			runCli: options.runCli,
			archive: options.archive,
			onGenerated: options.onGenerated,
			// Both preflights fail BEFORE the wrapper runs. Any failure to
			// read the base (missing, malformed, unreadable) is the closed
			// union's BASE_MOTION_NOT_FOUND; the generation itself never
			// started, so GENERATION_FAILED would be a lie.
			preflight: async (request) => {
				try {
					await options.archive.read(request.base_motion_id);
				} catch (error) {
					throw new ArdyInbetweenBaseMotionNotFoundError(
						`base motion archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
				try {
					for (const poseId of inbetweenSyntheticPoseIds(request)) {
						await options.archive.read(poseId);
					}
				} catch (error) {
					throw new ArdyInbetweenPoseCaptureFailedError(
						`synthetic pose archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
			},
			buildArgv: buildInbetweenArgv,
			adaptWrapperJson: adaptWrapperJsonToResult,
			parseResult: parseArdyInbetweenResult,
			generationError: (message, errorOptions) => new ArdyInbetweenGenerationError(message, errorOptions),
			hostUnavailableError: (message, errorOptions) => new ArdyInbetweenHostUnavailableError(message, errorOptions),
			isHostUnavailable: isArdyHostUnavailableFailure,
			isKnownError: (error) => error instanceof ArdyInbetweenError,
			resultSchemaName: "inbetween",
		});
	}

	inbetween(request: ArdyInbetweenRequestV1): Promise<ArdyInbetweenResultV1> {
		return this.run(request);
	}
}

/** Typed orchestration boundary that validates concurrency then commits kernel output. */
export class ArdyInbetweenService {
	readonly #kernel: ArdyInbetweenKernel;
	readonly #applyMotion: ArdyInbetweenApplyMotionDispatch;
	readonly #liveRevisionId: () => string;

	constructor(options: ArdyInbetweenHandlerOptions) {
		this.#kernel = new ArdyInbetweenKernel(options);
		this.#applyMotion = options.applyMotion;
		this.#liveRevisionId = options.liveRevisionId;
	}

	async inbetween(
		params: unknown,
		context: DirectorHandlerContext,
	): Promise<{ result: ArdyInbetweenResultV1; resulting_revision_id: string }> {
		let request: ArdyInbetweenRequestV1;
		try {
			request = parseArdyInbetweenRequest(params);
		} catch (error) {
			throw new ArdyInbetweenInvalidRequestError(error instanceof Error ? error.message : String(error), {
				cause: error,
			});
		}
		// Fast-fail staleness guard: same contract as the generate and
		// regenerate services -- see ArdyGenerateService.generate.
		const liveRevisionId = this.#liveRevisionId();
		if (request.expected_revision_id !== liveRevisionId) {
			throw new ArdyInbetweenRevisionMismatchError(request.expected_revision_id, liveRevisionId);
		}
		const result = await this.#kernel.inbetween(request);
		try {
			const applied = await this.#applyMotion(
				result.motion_id,
				request.entity_id,
				request.expected_revision_id,
				context,
			);
			return { result, resulting_revision_id: applied.resulting_revision_id };
		} catch (error) {
			if (error instanceof ArdyInbetweenError) {
				throw error;
			}
			throw new ArdyInbetweenApplyMotionError(error instanceof Error ? error.message : String(error), {
				cause: error,
			});
		}
	}
}

export function createArdyInbetweenHandler(options: ArdyInbetweenHandlerOptions) {
	const service = new ArdyInbetweenService(options);
	return service.inbetween.bind(service);
}
