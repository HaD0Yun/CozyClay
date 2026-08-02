import {
	type ArdyInbetweenQueueOutcomeV1,
	type ArdyInbetweenRequestV1,
	ArdyInbetweenRequestV1Schema,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ArdyInbetweenToolRequestSchema = Type.Omit(ArdyInbetweenRequestV1Schema, ["schema_version"], {
	additionalProperties: false,
});

export interface ArdyInbetweenBridge {
	inbetween(request: ArdyInbetweenRequestV1): Promise<ArdyInbetweenQueueOutcomeV1>;
}

export function createArdyInbetweenTool(bridge: ArdyInbetweenBridge) {
	return defineTool({
		name: "ardy_inbetween",
		label: "ardy_inbetween",
		description:
			"Submits pose-constrained in-between generation through the durable host queue and commits the validated result as a durable project mutation. A pose constraint proves skeleton placement, NOT sole contact: a residual near zero is not ground-contact verification. Verify the deformed sole against the support surface with inspect_pose_contacts after apply_motion.",
		parameters: ArdyInbetweenToolRequestSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, request) => {
			const result = await bridge.inbetween({ schema_version: 1, ...request });
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
