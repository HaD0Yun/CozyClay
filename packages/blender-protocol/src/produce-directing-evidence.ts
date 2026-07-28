import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

/**
 * Bridge result for the produce_directing_evidence method: the add-on analyzed
 * the live scene, wrote a canonical DirectingAnalysisEvidenceV1 document, and
 * registered its sha256 in the runtime trust registry so apply_camera_plan can
 * accept it. All digests are runtime-produced, never model-supplied.
 */
export const ProduceDirectingEvidenceResultV1Schema = exact({
	schema_version: Type.Literal(1),
	evidence_sha256: Type.String({ pattern: HASH_64 }),
	revision_id: Type.String({ pattern: HASH_64 }),
	scene_hash: Type.String({ pattern: HASH_64 }),
	frame_range: exact({
		start: Type.Integer({ minimum: 0 }),
		end: Type.Integer({ minimum: 0 }),
	}),
	byte_length: Type.Integer({ minimum: 1 }),
});

export type ProduceDirectingEvidenceResultV1 = Static<typeof ProduceDirectingEvidenceResultV1Schema>;

export function parseProduceDirectingEvidenceResult(input: unknown): ProduceDirectingEvidenceResultV1 {
	let parsed: ProduceDirectingEvidenceResultV1;
	try {
		parsed = Parse(ProduceDirectingEvidenceResultV1Schema, input);
	} catch {
		throw new Error(
			"INVALID_PRODUCE_EVIDENCE_RESULT: result must match the closed ProduceDirectingEvidenceResultV1 schema",
		);
	}
	if (parsed.frame_range.start > parsed.frame_range.end) {
		throw new Error("INVALID_PRODUCE_EVIDENCE_RESULT: frame_range start must not exceed end");
	}
	return parsed;
}
