import type { ProduceDirectingEvidenceResultV1 } from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ProduceDirectingEvidenceRequest {
	readonly frame_start?: number;
	readonly frame_end?: number;
}

export interface ProduceDirectingEvidenceBridge {
	produceDirectingEvidence(request: ProduceDirectingEvidenceRequest): Promise<ProduceDirectingEvidenceResultV1>;
}

export function createProduceDirectingEvidenceTool(bridge: ProduceDirectingEvidenceBridge) {
	return defineTool({
		name: "produce_directing_evidence",
		label: "produce_directing_evidence",
		description:
			"Analyze the current Blender scene's animation and produce a digest-authorized directing-analysis evidence document. Returns evidence_sha256 (authorized for apply_camera_plan), the bound revision_id and scene_hash, and the analyzed frame_range. Call this immediately before apply_camera_plan and pass the returned evidence_sha256 plus the SAME revision as expected_revision_id in the camera plan. Optional frame_start/frame_end restrict the analyzed range; omit both to analyze the scene frame range.",
		parameters: Type.Object(
			{
				frame_start: Type.Optional(Type.Integer({ minimum: 0 })),
				frame_end: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.produceDirectingEvidence(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
