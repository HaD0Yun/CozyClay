// ARDY constrained regeneration: re-run the CONSTRAINED wrapper against a
// base clip with measured effector, full-body, and root-path targets, and
// commit the regenerated motion archive.
//
// The generation mechanics are the shared ArdyMotionKernel
// (./ardy-motion-kernel.ts), parameterized here with the constrained
// capability: the archive-input preflight (base clip plus every synthetic
// pose), the constraint argv builder, and the regenerate result adapter
// (including the post-hoc dropped-constraint safety net). The regeneration
// capability deliberately keeps its historic failure classification: every
// non-zero wrapper exit is GENERATION_FAILED -- unlike generate and
// in-between, it does not split off ARDY_HOST_UNAVAILABLE.
import type {
	ArdyRegenerateDroppedConstraintV1,
	ArdyRegenerateErrorCode,
	ArdyRegenerateRequestV1,
	ArdyRegenerateResultV1,
} from "@cclay/protocol";
import {
	ARDY_CONSTRAINED_DURATION_SECONDS,
	ARDY_CONSTRAINED_PROMPT,
	parseArdyRegenerateRequest,
	parseArdyRegenerateResult,
} from "@cclay/protocol";
import type { ArdyArchiveService } from "./ardy-archive-service.ts";
import { type ArdyCliResult, type ArdyCliRunner, ArdyMotionKernel } from "./ardy-motion-kernel.ts";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export const ARDY_REGENERATE_WRAPPER = "cclay-ardy-generate";

export type ArdyRegenerateCliResult = ArdyCliResult;

export type ArdyRegenerateCliRunner = ArdyCliRunner;

export interface ArdyRegenerateApplyMotionResult {
	readonly resulting_revision_id: string;
}

export type ArdyRegenerateApplyMotionDispatch = (
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
	context: DirectorHandlerContext,
) => Promise<ArdyRegenerateApplyMotionResult>;

export class ArdyRegenerateError extends Error {
	readonly code: ArdyRegenerateErrorCode;

	constructor(code: ArdyRegenerateErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ArdyRegenerateError";
		this.code = code;
	}
}

export class ArdyRegenerateRevisionMismatchError extends ArdyRegenerateError {
	constructor(expectedRevisionId: string, actualRevisionId: unknown) {
		super(
			"REVISION_MISMATCH",
			`regenerate expected ${expectedRevisionId}, request expected ${String(actualRevisionId)}`,
		);
		this.name = "ArdyRegenerateRevisionMismatchError";
	}
}

export class ArdyRegenerateInvalidRequestError extends ArdyRegenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("INVALID_ARDY_REGENERATE_REQUEST", message, options);
		this.name = "ArdyRegenerateInvalidRequestError";
	}
}

export class ArdyRegenerateGenerationError extends ArdyRegenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("GENERATION_FAILED", message, options);
		this.name = "ArdyRegenerateGenerationError";
	}
}

export class ArdyRegenerateApplyMotionError extends ArdyRegenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("GENERATION_FAILED", message, options);
		this.name = "ArdyRegenerateApplyMotionError";
	}
}

export interface ArdyMotionKernelOptions {
	readonly runCli: ArdyRegenerateCliRunner;
	readonly archive: Pick<ArdyArchiveService, "read" | "commitGenerated">;
	// Seam for write-ahead progress records: awaited once the wrapper result
	// has been parsed and before the generated archive is committed, so an
	// intent recorded here is durable before the commit is observable. When
	// absent, the kernel behaves exactly as before the seam existed.
	readonly onGenerated?: (motionId: string, result: ArdyRegenerateResultV1) => Promise<void>;
}

export interface ArdyRegenerateHandlerOptions extends ArdyMotionKernelOptions {
	readonly applyMotion: ArdyRegenerateApplyMotionDispatch;
	// The CURRENT project revision, read fresh on every regenerate call. The
	// request's expected_revision_id is checked against it before the
	// generator runs, so a request written against an older scene fails fast
	// instead of spending GPU minutes on a clip that would be rejected at
	// apply time. Required, not optional with a fallback: an optional
	// freshness check that silently defaults is how the tautological context
	// comparison got in.
	readonly liveRevisionId: () => string;
}

interface DroppedConstraint {
	readonly frame: number;
	readonly reason: string;
}

function formatNumber(value: number): string {
	const text = String(value);
	if (text.includes("e") || text.includes("E")) {
		throw new ArdyRegenerateInvalidRequestError(`coordinate ${value} is not a fixed-point number`);
	}
	return text;
}

function buildConstraintArgv(request: ArdyRegenerateRequestV1): string[] {
	const argv: string[] = [
		ARDY_CONSTRAINED_PROMPT,
		"--duration",
		ARDY_CONSTRAINED_DURATION_SECONDS,
		"--base-motion",
		request.base_motion_id,
	];
	for (const target of request.effectors) {
		argv.push(
			"--constrain",
			String(target.frame),
			target.joint,
			formatNumber(target.x),
			formatNumber(target.y),
			formatNumber(target.z),
		);
	}
	for (const pose of request.full_body) {
		argv.push("--constrain-pose", pose.synthetic_motion_id, "0", String(pose.frame));
	}
	for (const waypoint of request.root_2d) {
		argv.push(
			"--constrain-path",
			String(waypoint.frame),
			formatNumber(waypoint.x),
			formatNumber(waypoint.z),
			waypoint.heading === null ? "none" : formatNumber(waypoint.heading),
		);
	}
	return argv;
}

function requestedConstraintFrames(request: ArdyRegenerateRequestV1): { frame: number; kind: string }[] {
	return [
		...request.effectors.map((target) => ({ frame: target.frame, kind: "constrain" })),
		...request.full_body.map((pose) => ({ frame: pose.frame, kind: "constrain-pose" })),
		...request.root_2d.map((waypoint) => ({ frame: waypoint.frame, kind: "constrain-path" })),
	];
}

function dropOutOfRangeConstraints(request: ArdyRegenerateRequestV1, frames: number): DroppedConstraint[] {
	return requestedConstraintFrames(request)
		.filter((entry) => entry.frame < 0 || entry.frame >= frames)
		.map((entry) => ({
			frame: entry.frame,
			reason: `--${entry.kind} frame ${entry.frame} is outside the generated clip (0..<${frames}); dropped after generation`,
		}));
}

function adaptWrapperJsonToResult(
	wrapperJson: unknown,
	request: ArdyRegenerateRequestV1,
	dropped: readonly DroppedConstraint[],
): unknown {
	if (typeof wrapperJson !== "object" || wrapperJson === null) {
		throw new ArdyRegenerateGenerationError("wrapper stdout is not a JSON object");
	}
	const wrapper = wrapperJson as {
		motion_id?: unknown;
		frames?: unknown;
		residual?: unknown;
		continuity?: unknown;
	};
	if (typeof wrapper.motion_id !== "string") {
		throw new ArdyRegenerateGenerationError("wrapper JSON is missing motion_id");
	}
	if (typeof wrapper.frames !== "number" || !Number.isInteger(wrapper.frames)) {
		throw new ArdyRegenerateGenerationError("wrapper JSON is missing an integer frames count");
	}
	const achievedErrorM =
		wrapper.residual !== null && typeof wrapper.residual === "object" && "max_error_m" in wrapper.residual
			? (wrapper.residual as { max_error_m: unknown }).max_error_m
			: null;
	const droppedConstraints: ArdyRegenerateDroppedConstraintV1[] = dropped.map((entry) => ({
		frame: entry.frame,
		reason: entry.reason,
	}));
	return {
		schema_version: 1,
		request_id: request.request_id,
		motion_id: wrapper.motion_id,
		frames: wrapper.frames,
		achieved_error_m: achievedErrorM,
		residual: wrapper.residual,
		continuity: wrapper.continuity,
		dropped_constraints: droppedConstraints,
	};
}

/** Typed orchestration boundary that validates concurrency then commits kernel output. */
export class ArdyRegenerateService {
	// The shared kernel, bound to the constrained capability: the archive
	// input preflight, the constraint argv, and the regenerate result
	// adapter (with the post-hoc dropped-constraint safety net). The
	// regenerate capability keeps its historic all-failures-are-
	// GENERATION_FAILED classification and supplies no host-unavailable
	// split.
	readonly #kernel: ArdyMotionKernel<ArdyRegenerateRequestV1, ArdyRegenerateResultV1, ArdyRegenerateError>;
	readonly #applyMotion: ArdyRegenerateApplyMotionDispatch;
	readonly #liveRevisionId: () => string;

	constructor(options: ArdyRegenerateHandlerOptions) {
		this.#kernel = new ArdyMotionKernel({
			runCli: options.runCli,
			archive: options.archive,
			onGenerated: options.onGenerated,
			preflight: async (request) => {
				try {
					await options.archive.read(request.base_motion_id);
					for (const pose of request.full_body) {
						await options.archive.read(pose.synthetic_motion_id);
					}
				} catch (error) {
					throw new ArdyRegenerateGenerationError(
						`motion archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
			},
			buildArgv: buildConstraintArgv,
			// The kernel has already verified a numeric frames count before
			// calling the adapter, so the drop safety net can read it here.
			adaptWrapperJson: (wrapperJson, request) =>
				adaptWrapperJsonToResult(
					wrapperJson,
					request,
					dropOutOfRangeConstraints(request, (wrapperJson as { frames: number }).frames),
				),
			parseResult: parseArdyRegenerateResult,
			generationError: (message, errorOptions) => new ArdyRegenerateGenerationError(message, errorOptions),
			isKnownError: (error) => error instanceof ArdyRegenerateError,
			resultSchemaName: "regenerate",
		});
		this.#applyMotion = options.applyMotion;
		this.#liveRevisionId = options.liveRevisionId;
	}

	async regenerate(
		params: unknown,
		context: DirectorHandlerContext,
	): Promise<{ result: ArdyRegenerateResultV1; resulting_revision_id: string }> {
		let request: ArdyRegenerateRequestV1;
		try {
			request = parseArdyRegenerateRequest(params);
		} catch (error) {
			throw new ArdyRegenerateInvalidRequestError(error instanceof Error ? error.message : String(error), {
				cause: error,
			});
		}
		// Fast-fail staleness guard: expected_revision_id is the revision the
		// animator's scene had when the request was built. Compare it against
		// the CURRENT project revision, read fresh, so a request written
		// against an older scene fails here instead of spending a multi-minute
		// GPU run on a clip that could never commit. The apply-time binding
		// below is kept as well: the revision can move again while the
		// generator is running.
		const liveRevisionId = this.#liveRevisionId();
		if (request.expected_revision_id !== liveRevisionId) {
			throw new ArdyRegenerateRevisionMismatchError(request.expected_revision_id, liveRevisionId);
		}
		const result = await this.#kernel.run(request);
		try {
			const applied = await this.#applyMotion(
				result.motion_id,
				request.entity_id,
				request.expected_revision_id,
				context,
			);
			return { result, resulting_revision_id: applied.resulting_revision_id };
		} catch (error) {
			if (error instanceof ArdyRegenerateError) {
				throw error;
			}
			throw new ArdyRegenerateApplyMotionError(error instanceof Error ? error.message : String(error), {
				cause: error,
			});
		}
	}
}

export function createArdyRegenerateHandler(options: ArdyRegenerateHandlerOptions) {
	const service = new ArdyRegenerateService(options);
	return service.regenerate.bind(service);
}
