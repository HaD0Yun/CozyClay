import { parseCameraPlan } from "@oh-my-blender/protocol";
import type { DirectorHandlerContext } from "./inspect-service.ts";

export function createApplyCameraPlanHandler() {
	return async (params: unknown, context: DirectorHandlerContext) => {
		const plan = parseCameraPlan(params);
		const expectedRevision = context.request?.expected_revision_id;
		if (expectedRevision !== plan.expected_revision_id) {
			throw new Error(
				`STALE_BASE: plan expected ${plan.expected_revision_id}, request expected ${String(expectedRevision)}`,
			);
		}
		if (context.applyCameraPlan === undefined) {
			throw new Error("MUTATION_BRIDGE_UNAVAILABLE: protocol v2 mutation bridge is required");
		}
		const result = await context.applyCameraPlan(plan, {
			signal: context.signal,
			reportProgress: (progress) => {
				context.reportProgress?.(progress.phase, progress.completed, progress.total);
			},
		});
		return { result, resulting_revision_id: result.resulting_revision_id };
	};
}
