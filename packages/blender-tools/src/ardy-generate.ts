import {
	type ArdyGenerateQueueOutcomeV1,
	type ArdyGenerateRequestV1,
	ArdyGenerateRequestV1Schema,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ArdyGenerateToolRequestSchema = Type.Omit(ArdyGenerateRequestV1Schema, ["schema_version"], {
	additionalProperties: false,
});

export interface ArdyGenerateBridge {
	generate(request: ArdyGenerateRequestV1): Promise<ArdyGenerateQueueOutcomeV1>;
}

export function createArdyGenerateTool(bridge: ArdyGenerateBridge) {
	return defineTool({
		name: "ardy_generate",
		label: "ardy_generate",
		description:
			"Submits an unconstrained text-to-motion generation prompt through the durable host queue and commits the validated result as a durable project mutation. The first pass carries no pose constraints, so nothing in its outcome is contact-verified: a pose constraint proves skeleton placement, NOT sole contact, and a residual near zero is not ground-contact verification. Verify the deformed sole against the support surface with inspect_pose_contacts after apply_motion.",
		parameters: ArdyGenerateToolRequestSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, request) => {
			const result = await bridge.generate({ schema_version: 1, ...request });
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
