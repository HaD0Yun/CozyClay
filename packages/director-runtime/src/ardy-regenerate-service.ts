// Deterministic, LLM-free ARDY constraint regeneration surface. Re-runs the
// constrained generator (scripts/cclay-ardy-generate in constraint mode)
// against a base motion with measured end-effector targets, full-body
// synthetic poses, and a 2D root path, then applies the generated motion_id
// through the stage_scene apply_motion dispatch and returns the parsed
// regenerate result. This is a mutating director surface: the request carries
// expected_revision_id for optimistic-concurrency parity with stage_scene and
// camera_plan, and apply_motion is committed against that same revision.
//
// The handler owns no subprocess and no network. The CLI runner and the
// apply_motion dispatch are injected so the surface stays a pure state
// machine that tests drive with fakes (no ARDY box, no Blender, no LLM). The
// CLI argv is built as a string array and handed to the runner verbatim, so
// no shell interpolation ever touches a constraint coordinate — the runner is
// expected to exec the wrapper with argv passing straight through (the same
// non-shell rule cclay-ardy-generate enforces on its own remote ssh quoting).
//
// Constraint frame bounding (step 5) is a post-hoc safety net, not the
// primary guard. The wrapper rejects out-of-range frames locally against
// int(duration*20) BEFORE any ssh, and the remote _parse_frame rejects them
// again against the loaded clip; both would make the run fail. This handler
// re-checks every requested constraint against the SUCCESS result's `frames`
// anyway, because the runner is injected and a fake runner can return a
// shorter clip than the constraints targeted. Anything outside
// 0 <= frame < frames is dropped and recorded in dropped_constraints with a
// reason; a drop is a warning, never a failure, matching the residual-
// reporting contract that a constrained run still succeeds when the sampler
// could not satisfy a target.

import type {
	ArdyRegenerateDroppedConstraintV1,
	ArdyRegenerateRequestV1,
	ArdyRegenerateResultV1,
} from "@cclay/protocol";
import { parseArdyRegenerateRequest, parseArdyRegenerateResult } from "@cclay/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

// The wrapper path is resolved by the runner, not by this handler, so the
// handler never reaches into the filesystem. Keeping it out of the argv the
// handler builds lets a test runner point at any path (or ignore it) without
// the handler second-guessing the resolution.
export const ARDY_REGENERATE_WRAPPER = "cclay-ardy-generate";

// The wrapper requires a positional prompt and a --duration even in
// constraint mode (it builds a slug from the prompt and uses the duration to
// cap clip frames locally). Regeneration re-uses the base motion's clip, so a
// placeholder prompt and a generous duration are passed; the constrained
// remote script keys off --base, not the prompt text, for the pose source.
// The duration cap (1200s, line 261 of the wrapper) bounds the local frame
// check the wrapper runs before ssh, so a value comfortably above any real
// clip keeps the wrapper from rejecting a legitimate constraint frame.
const REGEN_PROMPT = "regenerate";
const REGEN_DURATION_SECONDS = "600";

export interface ArdyRegenerateCliResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Runs the cclay-ardy-generate wrapper with the assembled argv. The runner is
// responsible for exec (no shell) and for surfacing a non-zero exit as a
// non-zero status; it MUST NOT join argv into a shell string, or a constraint
// coordinate could be re-interpreted as a flag. The default runner shells out
// to the wrapper via child_process.spawn with shell:false, matching how the
// ardy-motion skill drives it; tests inject a fake that returns a canned
// result without touching the filesystem or the network.
export type ArdyRegenerateCliRunner = (
	argv: readonly string[],
) => Promise<ArdyRegenerateCliResult> | ArdyRegenerateCliResult;

export interface ArdyRegenerateApplyMotionResult {
	readonly resulting_revision_id: string;
}

// Applies the freshly generated motion_id to the requesting entity and commits
// it against expected_revision_id. Mirrors the stage_scene apply_motion path:
// the dispatch builds a one-operation stage_scene plan (apply_motion for
// entity_id + motion_id), runs the bridge, and commits the candidate, failing
// the whole regenerate if the revision moved underneath it. Injected so tests
// can fake a revision-conflict failure (failure-injection 2) without a real
// project store.
export type ArdyRegenerateApplyMotionDispatch = (
	motionId: string,
	entityId: string,
	expectedRevisionId: string,
	context: DirectorHandlerContext,
) => Promise<ArdyRegenerateApplyMotionResult>;

export interface ArdyRegenerateHandlerOptions {
	readonly runCli: ArdyRegenerateCliRunner;
	readonly applyMotion: ArdyRegenerateApplyMotionDispatch;
}

// One row of the dropped-constraints log, scoped to the constraint kind so the
// reason names the flag the wrapper would have rejected. Kept private to the
// handler; the public result only carries the schema's {frame, reason} pair.
interface DroppedConstraint {
	readonly frame: number;
	readonly reason: string;
}

function formatNumber(value: number): string {
	// The wrapper's number grammar is ^-?[0-9]+([.][0-9]+)?$; Number.toString
	// never emits exponent form for the magnitudes a constraint coordinate
	// takes, but guard against it anyway so a 1e-21 never slips through and
	// trips the wrapper's regex.
	const text = String(value);
	if (text.includes("e") || text.includes("E")) {
		throw new Error(`ARDY_REGENERATE_INVALID_COORDINATE: coordinate ${value} is not a fixed-point number`);
	}
	return text;
}

// Builds the wrapper argv from the parsed request. Each constraint becomes its
// own repeatable flag block, so the three kinds never collapse onto each
// other and never share a token. Coordinates are formatted as individual argv
// elements, never concatenated, so a value cannot escape its positional slot.
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
		// --constrain-pose copies the full-body pose at src-frame 0 of the
		// synthetic motion onto dst-frame. The regenerate request carries the
		// synthetic_motion_id and the dst-frame (request.frame); the src-frame
		// is pinned to 0 because the synthetic pose is a single-key frame 0
		// archive the ardy-motion skill stages for exactly this copy.
		argv.push("--constrain-pose", pose.synthetic_motion_id, "0", String(pose.frame));
	}
	for (const waypoint of request.root_2d) {
		// heading null => literal "none" (free heading); a real number is the
		// pinned heading in radians. The wrapper's grammar accepts exactly
		// "none" or a number here, so the literal must not be quoted or
		// upper-cased.
		const heading = waypoint.heading === null ? "none" : formatNumber(waypoint.heading);
		argv.push(
			"--constrain-path",
			String(waypoint.frame),
			formatNumber(waypoint.x),
			formatNumber(waypoint.z),
			heading,
		);
	}
	return argv;
}

// Collects every requested constraint frame, tagged with its kind, so the
// post-hoc range check can name the flag in the drop reason.
interface RequestedConstraintFrame {
	readonly frame: number;
	readonly kind: "constrain" | "constrain-pose" | "constrain-path";
}

function requestedConstraintFrames(request: ArdyRegenerateRequestV1): RequestedConstraintFrame[] {
	const frames: RequestedConstraintFrame[] = [];
	for (const target of request.effectors) {
		frames.push({ frame: target.frame, kind: "constrain" });
	}
	for (const pose of request.full_body) {
		frames.push({ frame: pose.frame, kind: "constrain-pose" });
	}
	for (const waypoint of request.root_2d) {
		frames.push({ frame: waypoint.frame, kind: "constrain-path" });
	}
	return frames;
}

// Drops constraints whose frame falls outside 0 <= frame < frames. The frames
// count comes from the SUCCESS result JSON (the remote clip's actual length),
// so this only runs after the CLI succeeded; a drop is recorded, not thrown.
function dropOutOfRangeConstraints(request: ArdyRegenerateRequestV1, frames: number): { dropped: DroppedConstraint[] } {
	const dropped: DroppedConstraint[] = [];
	for (const entry of requestedConstraintFrames(request)) {
		if (entry.frame < 0 || entry.frame >= frames) {
			dropped.push({
				frame: entry.frame,
				reason: `--${entry.kind} frame ${entry.frame} is outside the generated clip (0..<${frames}); dropped after generation`,
			});
		}
	}
	return { dropped };
}

// The wrapper's constrained-mode stdout is one JSON line shaped
// {"motion_id","duration_s","path","base_motion_id",<remote body>} where the
// remote body (scripts/ardy/cclay_constrained_generate.py:main) carries
// frames, fps, residual, continuity, waypoints, ... The regenerate result
// schema is a narrower projection of that body plus the request's
// request_id, so this adapter picks the fields the schema requires and leaves
// the residual/continuity sub-objects untouched (they already match the
// schema shape). achieved_error_m is null when residual is null (a run that
// constrained only a path or only a pose has no end-effector target to
// summarize), matching measure_residuals' None-not-zero contract.
function adaptWrapperJsonToResult(
	wrapperJson: unknown,
	request: ArdyRegenerateRequestV1,
	dropped: readonly DroppedConstraint[],
): unknown {
	if (typeof wrapperJson !== "object" || wrapperJson === null) {
		throw new Error("ARDY_REGENERATE_INVALID_JSON: wrapper stdout is not a JSON object");
	}
	const wrapper = wrapperJson as {
		motion_id?: unknown;
		frames?: unknown;
		residual?: unknown;
		continuity?: unknown;
	};
	if (typeof wrapper.motion_id !== "string") {
		throw new Error("ARDY_REGENERATE_INVALID_JSON: wrapper JSON is missing motion_id");
	}
	if (typeof wrapper.frames !== "number" || !Number.isInteger(wrapper.frames)) {
		throw new Error("ARDY_REGENERATE_INVALID_JSON: wrapper JSON is missing an integer frames count");
	}
	const residual = wrapper.residual;
	const achievedErrorM =
		residual !== null && typeof residual === "object" && "max_error_m" in residual
			? (residual as { max_error_m: unknown }).max_error_m
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
		residual,
		continuity: wrapper.continuity,
		dropped_constraints: droppedConstraints,
	};
}

export function createArdyRegenerateHandler(options: ArdyRegenerateHandlerOptions) {
	return async (
		params: unknown,
		context: DirectorHandlerContext,
	): Promise<{ result: ArdyRegenerateResultV1; resulting_revision_id: string }> => {
		// 1. Parse the request through the closed protocol schema.
		const request = parseArdyRegenerateRequest(params);

		// 2. Optimistic-concurrency guard: the director must commit against the
		// revision it read. A mismatch fails before any CLI or apply_motion
		// call, matching stage_scene/render_qa_frames' STALE_BASE pattern.
		if (context.request?.expected_revision_id !== request.expected_revision_id) {
			throw new Error(
				`STALE_BASE: regenerate expected ${request.expected_revision_id}, request expected ${String(context.request?.expected_revision_id)}`,
			);
		}

		// 3. Expand the three constraint kinds into wrapper argv. The array is
		// handed to the runner verbatim; no shell string is ever built here.
		const argv = buildConstraintArgv(request);

		// 4. Run the CLI. A non-zero exit or unparseable JSON fails the
		// regenerate without applying any motion, so a generation failure can
		// never leave a half-applied motion on the entity.
		let cliResult: ArdyRegenerateCliResult;
		try {
			cliResult = await options.runCli(argv);
		} catch (error) {
			throw new Error(`ARDY_REGENERATE_CLI_ERROR: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (cliResult.status !== 0) {
			throw new Error(
				`ARDY_REGENERATE_CLI_ERROR: wrapper exited ${cliResult.status}${cliResult.stderr ? `: ${cliResult.stderr.trim()}` : ""}`,
			);
		}
		const stdoutText = cliResult.stdout.trim();
		if (stdoutText === "") {
			throw new Error("ARDY_REGENERATE_INVALID_JSON: wrapper produced no stdout");
		}
		// The wrapper prints exactly one JSON line; tolerate a trailing
		// newline or stray progress text by parsing the LAST non-empty line,
		// mirroring the wrapper's own CON_JSON = SEQ_STDOUT##*$'\n'* rule.
		const lines = stdoutText.split("\n").filter((line) => line.trim() !== "");
		const jsonLine = lines[lines.length - 1];
		let wrapperJson: unknown;
		try {
			wrapperJson = JSON.parse(jsonLine);
		} catch {
			throw new Error(`ARDY_REGENERATE_INVALID_JSON: wrapper stdout is not parseable JSON`);
		}

		// 5. Frame-range safety net: drop constraints outside 0 <= frame <
		// frames (measured on the SUCCESS result), recording each drop. A drop
		// is a warning, never a failure.
		if (
			typeof wrapperJson !== "object" ||
			wrapperJson === null ||
			typeof (wrapperJson as { frames?: unknown }).frames !== "number"
		) {
			throw new Error("ARDY_REGENERATE_INVALID_JSON: wrapper JSON is missing a numeric frames count");
		}
		const frames = (wrapperJson as { frames: number }).frames;
		const { dropped } = dropOutOfRangeConstraints(request, frames);

		// Adapt the wrapper JSON to the result schema shape and parse it back
		// through the closed schema, so an unexpected shape still fails closed.
		const adapted = adaptWrapperJsonToResult(wrapperJson, request, dropped);
		const result = parseArdyRegenerateResult(adapted);

		// 6. Apply the generated motion through the injected dispatch, passing
		// the same expected_revision_id the request carried. A revision
		// conflict (or any dispatch failure) propagates as-is — the motion was
		// generated but NOT committed, and the caller sees the error.
		const applied = await options.applyMotion(
			result.motion_id,
			request.entity_id,
			request.expected_revision_id,
			context,
		);

		// 7. The result is already parsed; return it with the revision the
		// apply_motion dispatch committed.
		return { result, resulting_revision_id: applied.resulting_revision_id };
	};
}
