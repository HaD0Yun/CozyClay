import {
	type ArdyRegenerateQueueOutcomeV1,
	type ArdyRegenerateRequestV1,
	ArdyRegenerateRequestV1Schema,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ArdyRegenerateToolRequestSchema = Type.Omit(ArdyRegenerateRequestV1Schema, ["schema_version"], {
	additionalProperties: false,
});

export interface ArdyRegenerateBridge {
	regenerate(request: ArdyRegenerateRequestV1): Promise<ArdyRegenerateQueueOutcomeV1>;
}

export function createArdyRegenerateTool(bridge: ArdyRegenerateBridge) {
	return defineTool({
		name: "ardy_regenerate",
		label: "ardy_regenerate",
		description:
			"Requires an existing base motion; submits validated constraints through the durable host queue and applies the validated result as a durable project mutation.",
		parameters: ArdyRegenerateToolRequestSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, request) => {
			const result = await bridge.regenerate({ schema_version: 1, ...request });
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
