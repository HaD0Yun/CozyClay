// Durable queue write-ahead record for the ARDY bridges (generate and
// in-between). The "generated" record is written ATOMICALLY AFTER runCli
// returns and its result parses — the first moment the motion id exists —
// and BEFORE commitGenerated is called. A crash before this record means
// nothing was committed, so a replay may safely re-run the generator; a
// crash after it must never re-run the generator, because the request_id
// already consumed a run and produced an archive. The record then flips to
// "committed" once the motion archive is committed, and to "applied" after
// the director applies the motion to the entity — so a replay can see
// exactly where each request_id stopped.
//
// The record is request-scoped (request_id + motion_id), not entity-scoped:
// two requests may legitimately target the same entity, but each generator
// run belongs to exactly one request.
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { exact, hash, motionId, requestId } from "./schema-grammar.ts";

const ArdyQueueProgressGeneratedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("generated"),
	motion_id: motionId(),
});

const ArdyQueueProgressCommittedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("committed"),
	motion_id: motionId(),
});

const ArdyQueueProgressAppliedV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("applied"),
	motion_id: motionId(),
	resulting_revision_id: hash(),
});

// motion_id is required on all three members (it is the whole point of the
// "generated" record — the id does not exist before it); only "applied"
// carries resulting_revision_id, because only an applied record has one.
export const ArdyQueueProgressV1Schema = Type.Union([
	ArdyQueueProgressGeneratedV1Schema,
	ArdyQueueProgressCommittedV1Schema,
	ArdyQueueProgressAppliedV1Schema,
]);
export type ArdyQueueProgressV1 = Static<typeof ArdyQueueProgressV1Schema>;

export function parseArdyQueueProgress(input: unknown): ArdyQueueProgressV1 {
	try {
		return Parse(ArdyQueueProgressV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_QUEUE_PROGRESS: record must match the closed ardy queue progress schema");
	}
}
