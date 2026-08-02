// Durable queue write-ahead record for the ARDY bridges (generate and
// in-between). The "generated" record is written ATOMICALLY AFTER runCli
// returns and its result parses — the first moment the motion id exists —
// and BEFORE commitGenerated is called. A crash before this record means
// nothing was committed, so a replay may safely re-run the generator (that
// is the bounded residual the queue documents: at most one extra run); a
// crash after it must never re-run the generator, because the request_id
// already consumed a run and produced an archive. The record then flips to
// "committed" once the motion archive is committed, and to "applied" after
// the director applies the motion to the entity — so a replay can see
// exactly where each request_id stopped.
//
// Every member carries the full capability `result` that the generator run
// produced, because a replay must be able to return the RECORDED result
// verbatim: the record is the single source of truth for it, and a result
// synthesized from motion_id alone cannot reconstruct a closed capability
// result. The result is deliberately opaque at this layer — each capability
// validates its own closed result shape with its own parser when the queue
// reads the record — and is only bounded here to a JSON object with a
// property ceiling far above any capability result, so the record schema
// stays closed without importing every capability's result schema into this
// file.
//
// The record is request-scoped (request_id + motion_id), not entity-scoped:
// two requests may legitimately target the same entity, but each generator
// run belongs to exactly one request.
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { exact, hash, motionId, requestId } from "./schema-grammar.ts";

// Bounded opaque result object: must be a JSON object (never null, a scalar,
// or an array) with at most 64 top-level properties. `maxProperties` only
// constrains the top level, so a nested object or a long array — the valid
// `dropped_constraints` list, for instance — could still make a record an
// unbounded blob. The real ceiling is therefore a serialized byte limit,
// enforced in parseArdyQueueProgress: a progress record is replay state that
// must be written and fsynced on every transition, so its size has to be
// bounded in bytes, not in property count.
const ArdyQueueProgressResultV1Schema = Type.Object({}, { additionalProperties: true, maxProperties: 64 });
export const ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES = 65536;

const ArdyQueueProgressGeneratedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("generated"),
	motion_id: motionId(),
	result: ArdyQueueProgressResultV1Schema,
});

const ArdyQueueProgressCommittedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("committed"),
	motion_id: motionId(),
	result: ArdyQueueProgressResultV1Schema,
});

const ArdyQueueProgressAppliedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("applied"),
	motion_id: motionId(),
	result: ArdyQueueProgressResultV1Schema,
	resulting_revision_id: hash(),
});

// motion_id and the capability result are required on all three members
// (the result exists the moment the generated record is written — the
// kernel parses it before the seam records anything); only "applied"
// carries resulting_revision_id, because only an applied record has one.
export const ArdyQueueProgressV1Schema = Type.Union([
	ArdyQueueProgressGeneratedV1Schema,
	ArdyQueueProgressCommittedV1Schema,
	ArdyQueueProgressAppliedV1Schema,
]);
export type ArdyQueueProgressV1 = Static<typeof ArdyQueueProgressV1Schema>;

export function parseArdyQueueProgress(input: unknown): ArdyQueueProgressV1 {
	let record: ArdyQueueProgressV1;
	try {
		record = Parse(ArdyQueueProgressV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_QUEUE_PROGRESS: record must match the closed ardy queue progress schema");
	}
	// Byte ceiling on the opaque result, which the schema cannot express. See
	// ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES above: maxProperties bounds only the
	// top level, so a nested object or a long dropped_constraints array would
	// otherwise be unbounded.
	const bytes = Buffer.byteLength(JSON.stringify(record.result), "utf8");
	if (bytes > ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES) {
		throw new Error(
			`INVALID_ARDY_QUEUE_PROGRESS: recorded result is ${bytes} bytes, over the ${ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES} byte ceiling`,
		);
	}
	return record;
}
