// ARDY first-pass generation: run the UNCONSTRAINED wrapper against a single
// prompt and commit the generated motion archive.
//
// The unconstrained first pass MUST NOT carry --base-motion or any
// constraint flag: the wrapper rejects --base-motion when no constraint flag
// is present and rejects constraint flags without --base-motion
// (scripts/cclay-ardy-generate:228-235), so argv is exactly
// [prompt, "--duration", seconds, ("--seed", seed)?]. The project directory
// is NOT an argv word -- the request schema carries no project field -- so
// the runner supplies it as the wrapper's cwd, exactly like the regenerate
// runner (apps/cclay-extension/src/regenerate-queue-runner.ts) and the
// wrapper's own --project default ($PWD).
//
// Failure mapping onto the closed 7-code union: a wrapper exit whose stderr
// names an unset CCLAY_ARDY_HOST or an ssh/scp client failure (unreachable
// host, refused connection, auth failure) is ARDY_HOST_UNAVAILABLE --
// distinct from GENERATION_FAILED, which is reserved for the generation
// itself failing (non-zero exit for another reason, unparseable output,
// archive commit refusal). The wrapper is the authority on host
// availability: it validates CCLAY_ARDY_HOST itself and prints exactly
// "cclay-ardy-generate: CCLAY_ARDY_HOST is required ..." when it is unset
// (scripts/cclay-ardy-generate:502), and every ssh/scp client diagnostic is
// prefixed "ssh:" / "scp:" on its own line.
import type { ArdyGenerateErrorCode, ArdyGenerateRequestV1, ArdyGenerateResultV1 } from "@cclay/protocol";
import { parseArdyGenerateRequest, parseArdyGenerateResult } from "@cclay/protocol";
import type { ArdyArchiveService } from "./ardy-archive-service.ts";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export const ARDY_GENERATE_WRAPPER = "cclay-ardy-generate";

const HOST_UNAVAILABLE_PATTERNS = [
	// The wrapper's exact unset-host diagnostic (scripts/cclay-ardy-generate:502).
	/CCLAY_ARDY_HOST is required/,
	// ssh/scp client failures -- Could not resolve hostname, connect
	// refused/timed out, Permission denied -- are prefixed "ssh:" / "scp:"
	// at the start of a line by the OpenSSH clients the wrapper shells out
	// to. A remote Python failure inside the generation is a traceback and
	// never matches; that stays GENERATION_FAILED.
	/(^|\n)\s*(ssh|scp):/,
];

/**
 * Whether a non-zero wrapper exit means the ARDY box itself was unreachable
 * (or never configured) rather than the generation failing. Shared by the
 * generate and in-between services; the wrapper is the authority, this only
 * classifies its stderr.
 */
export function isArdyHostUnavailableFailure(stderr: string): boolean {
	return HOST_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export interface ArdyGenerateCliResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type ArdyGenerateCliRunner = (argv: readonly string[]) => Promise<ArdyGenerateCliResult> | ArdyGenerateCliResult;

export interface ArdyGenerateApplyMotionResult {
	readonly resulting_revision_id: string;
}

export type ArdyGenerateApplyMotionDispatch = (
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
	context: DirectorHandlerContext,
) => Promise<ArdyGenerateApplyMotionResult>;

export class ArdyGenerateError extends Error {
	readonly code: ArdyGenerateErrorCode;

	constructor(code: ArdyGenerateErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ArdyGenerateError";
		this.code = code;
	}
}

export class ArdyGenerateInvalidRequestError extends ArdyGenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("INVALID_ARDY_GENERATE_REQUEST", message, options);
		this.name = "ArdyGenerateInvalidRequestError";
	}
}

export class ArdyGenerateRevisionMismatchError extends ArdyGenerateError {
	constructor(expectedRevisionId: string, actualRevisionId: unknown) {
		super(
			"REVISION_MISMATCH",
			`generate expected ${expectedRevisionId}, request expected ${String(actualRevisionId)}`,
		);
		this.name = "ArdyGenerateRevisionMismatchError";
	}
}

export class ArdyGenerateHostUnavailableError extends ArdyGenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("ARDY_HOST_UNAVAILABLE", message, options);
		this.name = "ArdyGenerateHostUnavailableError";
	}
}

export class ArdyGenerateGenerationError extends ArdyGenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("GENERATION_FAILED", message, options);
		this.name = "ArdyGenerateGenerationError";
	}
}

export class ArdyGenerateApplyMotionError extends ArdyGenerateError {
	constructor(message: string, options?: ErrorOptions) {
		super("APPLY_FAILED", message, options);
		this.name = "ArdyGenerateApplyMotionError";
	}
}

export interface ArdyGenerateKernelOptions {
	readonly runCli: ArdyGenerateCliRunner;
	readonly archive: Pick<ArdyArchiveService, "commitGenerated">;
	// Seam for write-ahead progress records: awaited once the wrapper result
	// has been parsed and before the generated archive is committed, so an
	// intent recorded here is durable before the commit is observable. When
	// absent, the kernel behaves exactly as before the seam existed.
	readonly onGenerated?: (motionId: string, result: ArdyGenerateResultV1) => Promise<void>;
}

export interface ArdyGenerateHandlerOptions extends ArdyGenerateKernelOptions {
	readonly applyMotion: ArdyGenerateApplyMotionDispatch;
	// The CURRENT project revision, read fresh on every generate call. The
	// request's expected_revision_id is checked against it before the
	// generator runs, so a request written against an older scene fails fast
	// instead of spending GPU minutes on a clip that would be rejected at
	// apply time. Required, not optional with a fallback: an optional
	// freshness check that silently defaults is how the tautological context
	// comparison got in.
	readonly liveRevisionId: () => string;
}

// The wrapper validates --duration as a fixed-point decimal
// (^[0-9]+([.][0-9]+)?$, scripts/cclay-ardy-generate:103), so an exponent
// form -- reachable from schema-valid durations like 1e-7 -- must fail as an
// invalid request instead of being rejected by the wrapper hours later.
function formatDurationSeconds(value: number): string {
	const text = String(value);
	if (text.includes("e") || text.includes("E")) {
		throw new ArdyGenerateInvalidRequestError(`duration ${value} is not a fixed-point number`);
	}
	return text;
}

function buildGenerateArgv(request: ArdyGenerateRequestV1): string[] {
	const argv = [request.prompt, "--duration", formatDurationSeconds(request.duration_seconds)];
	if (request.seed !== null) {
		argv.push("--seed", String(request.seed));
	}
	return argv;
}

function adaptWrapperJsonToResult(wrapperJson: unknown, request: ArdyGenerateRequestV1): unknown {
	if (typeof wrapperJson !== "object" || wrapperJson === null) {
		throw new ArdyGenerateGenerationError("wrapper stdout is not a JSON object");
	}
	const wrapper = wrapperJson as { motion_id?: unknown; frames?: unknown; duration_s?: unknown };
	if (typeof wrapper.motion_id !== "string") {
		throw new ArdyGenerateGenerationError("wrapper JSON is missing motion_id");
	}
	if (typeof wrapper.frames !== "number" || !Number.isInteger(wrapper.frames)) {
		throw new ArdyGenerateGenerationError("wrapper JSON is missing an integer frames count");
	}
	return {
		schema_version: 1,
		request_id: request.request_id,
		motion_id: wrapper.motion_id,
		frames: wrapper.frames,
		// The wrapper echoes the requested duration back as duration_s; when
		// an older wrapper omits it, the request's own value is the exact
		// number that was passed as --duration.
		duration_seconds: typeof wrapper.duration_s === "number" ? wrapper.duration_s : request.duration_seconds,
		// The wrapper does not echo the seed; the request is the only source.
		seed: request.seed,
	};
}

/** Deterministic generator boundary; it owns argv and stdout parsing. */
export class ArdyGenerateKernel {
	readonly #runCli: ArdyGenerateCliRunner;
	readonly #archive: Pick<ArdyArchiveService, "commitGenerated">;
	readonly #onGenerated: ((motionId: string, result: ArdyGenerateResultV1) => Promise<void>) | undefined;

	constructor(options: ArdyGenerateKernelOptions) {
		this.#runCli = options.runCli;
		this.#archive = options.archive;
		this.#onGenerated = options.onGenerated;
	}

	async generate(request: ArdyGenerateRequestV1): Promise<ArdyGenerateResultV1> {
		// Built before the runner try/catch so an unrepresentable duration
		// fails as an INVALID request, not as a GENERATION failure.
		const argv = buildGenerateArgv(request);
		let cliResult: ArdyGenerateCliResult;
		try {
			cliResult = await this.#runCli(argv);
		} catch (error) {
			throw new ArdyGenerateGenerationError(
				`wrapper could not run: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (cliResult.status !== 0) {
			if (isArdyHostUnavailableFailure(cliResult.stderr)) {
				throw new ArdyGenerateHostUnavailableError(`ardy host unavailable: ${cliResult.stderr.trim()}`);
			}
			throw new ArdyGenerateGenerationError(
				`wrapper exited ${cliResult.status}${cliResult.stderr ? `: ${cliResult.stderr.trim()}` : ""}`,
			);
		}
		const lines = cliResult.stdout
			.trim()
			.split("\n")
			.filter((line) => line.trim() !== "");
		if (lines.length === 0) {
			throw new ArdyGenerateGenerationError("wrapper produced no stdout");
		}
		let wrapperJson: unknown;
		try {
			wrapperJson = JSON.parse(lines[lines.length - 1]);
		} catch (error) {
			throw new ArdyGenerateGenerationError("wrapper stdout is not parseable JSON", { cause: error });
		}
		if (
			typeof wrapperJson !== "object" ||
			wrapperJson === null ||
			typeof (wrapperJson as { frames?: unknown }).frames !== "number"
		) {
			throw new ArdyGenerateGenerationError("wrapper JSON is missing a numeric frames count");
		}
		let result: ArdyGenerateResultV1;
		try {
			result = parseArdyGenerateResult(adaptWrapperJsonToResult(wrapperJson, request));
		} catch (error) {
			if (error instanceof ArdyGenerateError) {
				throw error;
			}
			throw new ArdyGenerateGenerationError(
				`wrapper JSON does not satisfy the generate result schema: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		// Awaited after the wrapper result parses, before the archive commit
		// makes the motion observable to the rest of the project.
		if (this.#onGenerated !== undefined) {
			await this.#onGenerated(result.motion_id, result);
		}
		try {
			await this.#archive.commitGenerated(result.motion_id);
		} catch (error) {
			throw new ArdyGenerateGenerationError(
				`generated motion archive could not be committed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		return result;
	}
}

/** Typed orchestration boundary that validates concurrency then commits kernel output. */
export class ArdyGenerateService {
	readonly #kernel: ArdyGenerateKernel;
	readonly #applyMotion: ArdyGenerateApplyMotionDispatch;
	readonly #liveRevisionId: () => string;

	constructor(options: ArdyGenerateHandlerOptions) {
		this.#kernel = new ArdyGenerateKernel(options);
		this.#applyMotion = options.applyMotion;
		this.#liveRevisionId = options.liveRevisionId;
	}

	async generate(
		params: unknown,
		context: DirectorHandlerContext,
	): Promise<{ result: ArdyGenerateResultV1; resulting_revision_id: string }> {
		let request: ArdyGenerateRequestV1;
		try {
			request = parseArdyGenerateRequest(params);
		} catch (error) {
			throw new ArdyGenerateInvalidRequestError(error instanceof Error ? error.message : String(error), {
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
			throw new ArdyGenerateRevisionMismatchError(request.expected_revision_id, liveRevisionId);
		}
		const result = await this.#kernel.generate(request);
		try {
			const applied = await this.#applyMotion(
				result.motion_id,
				request.entity_id,
				request.expected_revision_id,
				context,
			);
			return { result, resulting_revision_id: applied.resulting_revision_id };
		} catch (error) {
			if (error instanceof ArdyGenerateError) {
				throw error;
			}
			throw new ArdyGenerateApplyMotionError(error instanceof Error ? error.message : String(error), {
				cause: error,
			});
		}
	}
}

export function createArdyGenerateHandler(options: ArdyGenerateHandlerOptions) {
	const service = new ArdyGenerateService(options);
	return service.generate.bind(service);
}
