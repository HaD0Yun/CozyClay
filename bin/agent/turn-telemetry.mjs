// The execution telemetry of an agent turn (moved unchanged from agent-routes.mjs): one emitter per turn, the tool
// category of a model-facing tool, and which canvas results prove an applied change.
import { randomBytes } from "node:crypto";

// Keep this local relay self-contained: minimal sidecar installs omit src/.
const advisory = (read, fallback) => { try { return read(); } catch { return fallback; } };
const telemetryId = () => advisory(() => randomBytes(16).toString("hex"), null);
const telemetryNow = () => advisory(() => { const value = performance.now(); return Number.isFinite(value) ? value : NaN; }, NaN);
const bucketMs = (ms) => !Number.isFinite(ms) || ms < 1000 ? "lt1s" : ms < 3000 ? "1-3s" : ms < 10000 ? "3-10s" : ms < 30000 ? "10-30s" : "gte30s";
export const agentToolCategory = (name) => {
	// Studio families are authored edits or reads; the analytics vocabulary has
	// no Studio-specific category, so a write says so and everything else does not.
	if (["arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "undo_edit"].includes(name)) return "scene_write";
	if (name === "run_workflow") return "workflow_run";
	if (name === "describe_workflow" || name === "focus_workflow_node") return "workflow_read";
	if (["add_workflow_node", "update_workflow_node", "remove_workflow_node", "connect_workflow_nodes", "disconnect_workflow_nodes", "set_workflow_node_output"].includes(name)) return "workflow_write";
	if (name === "capture_blocking_frame") return "frame_capture";
	if (name === "add_reference_node") return "scene_write";
	return "other";
};
// These existing canvas commands only return a node/edge after publishing a
// new insertion. Read/focus, generic accepted responses, update no-ops and run
// outputs (which can echo old values) are deliberately not application proof.
export const appliedCanvasResult = (name, result) => {
	if (name === "add_workflow_node" || name === "add_reference_node") return typeof result?.node?.id === "string" && result.node.id.length > 0;
	if (name === "connect_workflow_nodes") return typeof result?.edge?.id === "string" && result.edge.id.length > 0;
	return false;
};

/**
 * One execution-telemetry emitter, shared by both surfaces. The turn that owns
 * the correlation id owns its frames: a turn without one stays unobserved
 * rather than emitting frames nothing can correlate.
 */
export function createTurnTelemetry(send, turnId) {
	const turnStartedAt = telemetryNow();
	let applied = false;
	const emit = (event, props, toolId) => advisory(() => {
		if (turnId) send({ type: "execution_telemetry", event, props, ...(toolId ? { telemetry_id: toolId } : {}) });
	});
	return {
		/** One tool execution: the started frame now, its outcome when it ends. */
		toolStarted(category) {
			const startedAt = telemetryNow();
			const toolId = telemetryId();
			advisory(() => { if (turnId && toolId) send({ type: "execution_tool_started", turn_id: turnId, telemetry_id: toolId, tool_category: category }); });
			return {
				elapsedMs: () => Math.round(telemetryNow() - startedAt),
				executed: (outcome) => {
					if (toolId) emit("agent:tool_executed", { turn_id: turnId, tool_category: category, outcome, duration_bucket: bucketMs(telemetryNow() - startedAt) }, toolId);
				},
			};
		},
		/** The first proof that the scene actually changed, once per turn. */
		applied: () => advisory(() => { if (!applied) { applied = true; emit("agent:result_applied", { turn_id: turnId }); } }),
		finished: (outcome, failureCode) => emit(`agent:turn_${outcome}`, {
			turn_id: turnId,
			duration_bucket: bucketMs(telemetryNow() - turnStartedAt),
			...(outcome !== "succeeded" ? { failure_code: failureCode } : {}),
		}),
	};
}
