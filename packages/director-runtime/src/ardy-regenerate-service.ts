import type {
	ArdyRegenerateDroppedConstraintV1,
	ArdyRegenerateErrorCode,
	ArdyRegenerateRequestV1,
	ArdyRegenerateResultV1,
} from "@cclay/protocol";
import { parseArdyRegenerateRequest, parseArdyRegenerateResult } from "@cclay/protocol";
import type { ArdyArchiveService } from "./ardy-archive-service.ts";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export const ARDY_REGENERATE_WRAPPER = "cclay-ardy-generate";

const REGEN_PROMPT = "regenerate";
const REGEN_DURATION_SECONDS = "600";

export interface ArdyRegenerateCliResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type ArdyRegenerateCliRunner = (
	argv: readonly string[],
) => Promise<ArdyRegenerateCliResult> | ArdyRegenerateCliResult;

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
}

export interface ArdyRegenerateHandlerOptions extends ArdyMotionKernelOptions {
	readonly applyMotion: ArdyRegenerateApplyMotionDispatch;
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
	const argv: string[] = [REGEN_PROMPT, "--duration", REGEN_DURATION_SECONDS, "--base-motion", request.base_motion_id];
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

/** Deterministic generator boundary; it owns archive reads, argv, and stdout parsing. */
export class ArdyMotionKernel {
	readonly #runCli: ArdyRegenerateCliRunner;
	readonly #archive: Pick<ArdyArchiveService, "read" | "commitGenerated">;

	constructor(options: ArdyMotionKernelOptions) {
		this.#runCli = options.runCli;
		this.#archive = options.archive;
	}

	async regenerate(request: ArdyRegenerateRequestV1): Promise<ArdyRegenerateResultV1> {
		try {
			await this.#archive.read(request.base_motion_id);
			for (const pose of request.full_body) {
				await this.#archive.read(pose.synthetic_motion_id);
			}
		} catch (error) {
			throw new ArdyRegenerateGenerationError(
				`motion archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}

		let cliResult: ArdyRegenerateCliResult;
		try {
			cliResult = await this.#runCli(buildConstraintArgv(request));
		} catch (error) {
			throw new ArdyRegenerateGenerationError(
				`wrapper could not run: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (cliResult.status !== 0) {
			throw new ArdyRegenerateGenerationError(
				`wrapper exited ${cliResult.status}${cliResult.stderr ? `: ${cliResult.stderr.trim()}` : ""}`,
			);
		}
		const lines = cliResult.stdout
			.trim()
			.split("\n")
			.filter((line) => line.trim() !== "");
		if (lines.length === 0) {
			throw new ArdyRegenerateGenerationError("wrapper produced no stdout");
		}
		let wrapperJson: unknown;
		try {
			wrapperJson = JSON.parse(lines[lines.length - 1]);
		} catch (error) {
			throw new ArdyRegenerateGenerationError("wrapper stdout is not parseable JSON", { cause: error });
		}
		if (
			typeof wrapperJson !== "object" ||
			wrapperJson === null ||
			typeof (wrapperJson as { frames?: unknown }).frames !== "number"
		) {
			throw new ArdyRegenerateGenerationError("wrapper JSON is missing a numeric frames count");
		}
		let result: ArdyRegenerateResultV1;
		try {
			result = parseArdyRegenerateResult(
				adaptWrapperJsonToResult(
					wrapperJson,
					request,
					dropOutOfRangeConstraints(request, (wrapperJson as { frames: number }).frames),
				),
			);
		} catch (error) {
			if (error instanceof ArdyRegenerateError) {
				throw error;
			}
			throw new ArdyRegenerateGenerationError(
				`wrapper JSON does not satisfy the regenerate result schema: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		try {
			await this.#archive.commitGenerated(result.motion_id);
		} catch (error) {
			throw new ArdyRegenerateGenerationError(
				`generated motion archive could not be committed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		return result;
	}
}

/** Typed orchestration boundary that validates concurrency then commits kernel output. */
export class ArdyRegenerateService {
	readonly #kernel: ArdyMotionKernel;
	readonly #applyMotion: ArdyRegenerateApplyMotionDispatch;

	constructor(options: ArdyRegenerateHandlerOptions) {
		this.#kernel = new ArdyMotionKernel(options);
		this.#applyMotion = options.applyMotion;
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
		if (context.request?.expected_revision_id !== request.expected_revision_id) {
			throw new ArdyRegenerateRevisionMismatchError(
				request.expected_revision_id,
				context.request?.expected_revision_id,
			);
		}
		const result = await this.#kernel.regenerate(request);
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
