// The ONE ARDY generation kernel, shared by the regenerate, generate, and
// in-between capabilities.
//
// All three capabilities run the same wrapper (scripts/cclay-ardy-generate)
// and consume the same shaped stdout: one JSON line with motion_id and
// frames. What differs per capability is the preflight that must pass before
// the wrapper runs (regenerate and in-between validate their archive inputs;
// the unconstrained first pass has none), the argv builder, the projection
// of the wrapper JSON onto the capability's result schema, and the closed
// error classes the failures map onto. This file implements the shared
// mechanics exactly once -- invoke the runner with an argv array, classify
// the exit, parse and validate the wrapper JSON, await the onGenerated seam,
// commit through ArdyArchiveService.commitGenerated -- and the three
// services parameterize it with their capability-specific pieces. A mutation
// to the wrapper contract is now one change in one place, not three clones
// that drift.
//
// Failure classification: a wrapper exit whose stderr names an unset
// CCLAY_ARDY_HOST or an ssh/scp client failure (unreachable host, refused
// connection, auth failure) is ARDY_HOST_UNAVAILABLE -- distinct from
// GENERATION_FAILED, which is reserved for the generation itself failing
// (non-zero exit for another reason, unparseable output, archive commit
// refusal). The wrapper is the authority on host availability: it validates
// CCLAY_ARDY_HOST itself and prints exactly
// "cclay-ardy-generate: CCLAY_ARDY_HOST is required ..." when it is unset
// (scripts/cclay-ardy-generate:502), and every ssh/scp client diagnostic is
// prefixed "ssh:" / "scp:" on its own line.
import type { ArdyArchiveService } from "./ardy-archive-service.ts";

export interface ArdyCliResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type ArdyCliRunner = (argv: readonly string[]) => Promise<ArdyCliResult> | ArdyCliResult;

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
 * (or never configured) rather than the generation failing. The wrapper is
 * the authority, this only classifies its stderr.
 */
export function isArdyHostUnavailableFailure(stderr: string): boolean {
	return HOST_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

// The capability-specific pieces the shared kernel is parameterised by: the
// preflight that must pass before the wrapper runs (archive input checks for
// the constrained capabilities, none for the unconstrained first pass), the
// argv builder, the wrapper-JSON projection, the closed result parser, and
// the error factories for the capability's own error classes.
export interface ArdyKernelCapability<RequestT, ResultT extends { readonly motion_id: string }, ErrorT extends Error> {
	readonly runCli: ArdyCliRunner;
	readonly archive: Pick<ArdyArchiveService, "commitGenerated">;
	// Seam for write-ahead progress records: awaited once the wrapper result
	// has been parsed and before the generated archive is committed, so an
	// intent recorded here is durable before the commit is observable. When
	// absent, the kernel behaves exactly as before the seam existed.
	readonly onGenerated?: (motionId: string, result: ResultT) => Promise<void>;
	// Capability-specific preflight, awaited before the wrapper runs. It
	// throws the capability's own errors (archive-input failures for the
	// constrained capabilities); a preflight that fails must never cost a
	// GPU run.
	readonly preflight: (request: RequestT) => Promise<void>;
	readonly buildArgv: (request: RequestT) => string[];
	// Projects the parsed wrapper JSON onto the capability's result shape.
	// Throws the capability's own errors on a malformed wrapper body; the
	// kernel rethrows those and wraps everything else as a generation
	// failure (see isKnownError).
	readonly adaptWrapperJson: (wrapperJson: unknown, request: RequestT) => unknown;
	readonly parseResult: (value: unknown) => ResultT;
	// The closed failure-union member for the generation itself failing.
	readonly generationError: (message: string, errorOptions?: ErrorOptions) => ErrorT;
	// Capabilities that classify host-unavailability supply the classifier
	// and the matching error factory; the regeneration capability keeps its
	// historic all-failures-are-GENERATION_FAILED behavior and supplies
	// neither.
	readonly isHostUnavailable?: (stderr: string) => boolean;
	readonly hostUnavailableError?: (message: string, errorOptions?: ErrorOptions) => ErrorT;
	// Distinguishes the capability's own errors (thrown by the adapter or a
	// preflight) from plain parse failures, so the former propagate with
	// their code and the latter become GENERATION_FAILED with the schema
	// diagnostic.
	readonly isKnownError: (error: unknown) => boolean;
	// Capability name for the parse-failure diagnostic ("generate" /
	// "regenerate" / "inbetween").
	readonly resultSchemaName: string;
}

/**
 * Deterministic generator boundary shared by all three ARDY capabilities; it
 * owns the wrapper invocation, argv, and stdout parsing. The capability
 * supplies everything that differs; everything that is the same lives here.
 */
export class ArdyMotionKernel<RequestT, ResultT extends { readonly motion_id: string }, ErrorT extends Error> {
	readonly #capability: ArdyKernelCapability<RequestT, ResultT, ErrorT>;

	constructor(capability: ArdyKernelCapability<RequestT, ResultT, ErrorT>) {
		this.#capability = capability;
	}

	async run(request: RequestT): Promise<ResultT> {
		// The capability's own preflight runs BEFORE the wrapper: archive
		// inputs must be known-present before a multi-minute GPU run is spent.
		await this.#capability.preflight(request);
		// Built before the runner try/catch so an unrepresentable argv value
		// (an exponent-form duration or coordinate) fails as the capability's
		// INVALID-request error, not as a generation failure.
		const argv = this.#capability.buildArgv(request);
		let cliResult: ArdyCliResult;
		try {
			cliResult = await this.#capability.runCli(argv);
		} catch (error) {
			throw this.#capability.generationError(
				`wrapper could not run: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (cliResult.status !== 0) {
			const hostUnavailableError = this.#capability.hostUnavailableError;
			if (hostUnavailableError !== undefined && this.#capability.isHostUnavailable?.(cliResult.stderr) === true) {
				throw hostUnavailableError(`ardy host unavailable: ${cliResult.stderr.trim()}`);
			}
			throw this.#capability.generationError(
				`wrapper exited ${cliResult.status}${cliResult.stderr ? `: ${cliResult.stderr.trim()}` : ""}`,
			);
		}
		const lines = cliResult.stdout
			.trim()
			.split("\n")
			.filter((line) => line.trim() !== "");
		if (lines.length === 0) {
			throw this.#capability.generationError("wrapper produced no stdout");
		}
		let wrapperJson: unknown;
		try {
			wrapperJson = JSON.parse(lines[lines.length - 1]);
		} catch (error) {
			throw this.#capability.generationError("wrapper stdout is not parseable JSON", { cause: error });
		}
		if (
			typeof wrapperJson !== "object" ||
			wrapperJson === null ||
			typeof (wrapperJson as { frames?: unknown }).frames !== "number"
		) {
			throw this.#capability.generationError("wrapper JSON is missing a numeric frames count");
		}
		let result: ResultT;
		try {
			result = this.#capability.parseResult(this.#capability.adaptWrapperJson(wrapperJson, request));
		} catch (error) {
			if (this.#capability.isKnownError(error)) {
				throw error;
			}
			throw this.#capability.generationError(
				`wrapper JSON does not satisfy the ${this.#capability.resultSchemaName} result schema: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
		// Awaited after the wrapper result parses, before the archive commit
		// makes the motion observable to the rest of the project.
		if (this.#capability.onGenerated !== undefined) {
			await this.#capability.onGenerated(result.motion_id, result);
		}
		try {
			await this.#capability.archive.commitGenerated(result.motion_id);
		} catch (error) {
			throw this.#capability.generationError(
				`generated motion archive could not be committed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		return result;
	}
}
