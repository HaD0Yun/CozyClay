import { randomUUID } from "node:crypto";

import { selectWorkspaceRule } from "../live/workspace.mjs";

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const SYSTEM_PROMPT = "You are CozyClay's workflow agent. The user is looking at the Workflow canvas, and you work by building and running nodes on that canvas, so every step is visible and editable. Always call describe_workflow first to read the current graph. To render the scene in a new look: reuse the existing Scene node, add an Image node with model image-generation whose data.prompt is the user's intent, connect the Scene node to it with connect_workflow_nodes (sourceHandle render, targetHandle input), and when the user attached or mentioned a reference image, add one with add_reference_node and connect it to the same Image node's input handle; then call run_workflow. Finish with one or two sentences naming the nodes you created. Never describe results you did not run. Keep responses concise and practical. When the user pastes a prose prompt to turn into a scene, follow the prompt-to-scene rules in docs/agent-prompt-to-scene.md: ask at most 5 batched questions with defaults, infer and list as assumptions, and omit what the prompt never states.";

/** The Workflow page embeds the Studio as a live preview, so the hub usually
 * sees at least two editors. Prefer the tab the user is authoring in: any
 * workspace whose hello meta does not say embed:true. Fall back to the hub's
 * own single-workspace rule (which throws when the choice is ambiguous). */
export function pickWorkspace(liveHub, requiredCommands = ["capture_framing_png", "import_asset"], kind = "scene") {
	const details = typeof liveHub.workspaceHandleDetails === "function" ? liveHub.workspaceHandleDetails() : [];
	try {
		return selectWorkspaceRule({ details, requiredCommands, kind });
	} catch (error) {
		if (error?.code !== "NO_EDITOR" || kind !== "scene") throw error;
		// The hub's own rule would hand back whatever single workspace exists —
		// on the Workflow page that is the canvas, which cannot capture a frame.
		if (details.some((entry) => entry.meta?.kind === "workflow")) throw new Error("No scene editor is connected yet.");
		return liveHub.resolveWorkspace("agent turn");
	}
}

/** What the model gets back from a canvas command: ids, types, models and
 * small fields only. Data URLs become a size note and the echoed graph is
 * dropped — the model can call describe_workflow when it needs the graph. */
export function summariseCanvasResult(result) {
	const strip = (value) => {
		if (typeof value === "string") return value.startsWith("data:") ? `[image ${Math.round(value.length * 3 / 4 / 1024)} KB]` : value;
		if (Array.isArray(value)) return value.map(strip);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
		return value;
	};
	if (!result || typeof result !== "object") return result;
	const { graph, ...rest } = result;
	return strip(rest);
}

export function createAgentTools({ liveHub, handlers = [], session }) {
	const registry = new Map(handlers.map((tool) => [tool.name, tool]));
	const workspace = (kind = "scene") => {
		const key = kind === "workflow" ? "workflowHandle" : "workspaceHandle";
		// The panel session outlives page reloads, so a cached handle may name an
		// editor that is gone or the wrong kind of workspace; re-pick when it does.
		const details = typeof liveHub?.workspaceHandleDetails === "function" ? liveHub.workspaceHandleDetails() : [];
		const current = details.find((entry) => entry.handle === session[key]);
		const fits = current && ((current.meta?.kind === "workflow") === (kind === "workflow"));
		if (liveHub?.resolveWorkspace && !fits) session[key] = pickWorkspace(liveHub, kind === "workflow" ? [] : undefined, kind);
		return session[key];
	};
	// The embedded Studio says hello a moment after the canvas; give it up to
	// ten seconds before declaring that no scene editor exists.
	const warmingUp = (error) => /scene editor|renderer is not ready/i.test(error?.message ?? "");
	const untilReady = async (attempt) => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			try { return await attempt(); } catch (error) {
				if (!warmingUp(error) || Date.now() >= deadline) throw error;
				session.signal?.throwIfAborted?.();
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
	};
	const live = (name, args = {}, kind = "scene") => {
		if (!liveHub) throw new Error("Live editor is not connected.");
		return liveHub.command(name, args, workspace(kind));
	};
	const registered = async (name, args = {}) => {
		const tool = registry.get(name);
		if (!tool) throw new Error(`Tool ${name} is unavailable.`);
		const result = await tool.handler(args, { workspaceHandle: workspace("scene") });
		if (result?.isError) throw new Error("The live editor could not describe the scene.");
		return result;
	};
	const capture = {
		name: "capture_blocking_frame", description: "Capture the current blocking frame before rendering.", parameters: objectSchema(),
		handler: async () => {
			const result = await untilReady(() => live("capture_framing_png"));
			session.signal.throwIfAborted();
			const imageId = randomUUID();
			session.images.set(imageId, result.dataUrl);
			session.latestCaptureId = imageId;
			return { imageId, width: result.width, height: result.height };
		},
	};
	const reference = {
		name: "add_reference_node", description: "Add an attached or captured image to the canvas as a reference upload node.",
		parameters: objectSchema({ imageId: { type: "string" } }),
		handler: async ({ imageId } = {}) => {
			const dataUrl = session.images.get(imageId ?? session.latestCaptureId);
			if (!dataUrl) throw new Error("No reference image is available. Capture or attach one first.");
			return summariseCanvasResult(await live("add_node", { type: "upload", data: { image_url: dataUrl, fileName: "reference.png", mimeType: "image/png", outputs: [{ value: dataUrl }] } }, "workflow"));
		},
	};
	const workflow = [
		["describe_workflow", "Describe the current workflow canvas.", "get_graph", objectSchema()],
		["add_workflow_node", "Add a node to the workflow canvas.", "add_node", objectSchema({ type: { type: "string" }, model: { type: "string" }, data: { type: "object" }, position: { type: "object" } }, ["type"])],
		["update_workflow_node", "Update a workflow node.", "update_node", objectSchema({ id: { type: "string" }, data: { type: "object" } }, ["id", "data"])],
		["remove_workflow_node", "Remove a workflow node.", "remove_node", objectSchema({ id: { type: "string" } }, ["id"])],
		["connect_workflow_nodes", "Connect two workflow nodes.", "connect", objectSchema({ source: { type: "string" }, target: { type: "string" }, sourceHandle: { type: "string" }, targetHandle: { type: "string" } }, ["source", "target"])],
		["disconnect_workflow_nodes", "Disconnect workflow nodes.", "disconnect", objectSchema({ edgeId: { type: "string" } }, ["edgeId"])],
		["run_workflow", "Run the workflow locally.", "run_workflow", objectSchema()],
		["set_workflow_node_output", "Set a workflow node output.", "set_node_output", objectSchema({ id: { type: "string" }, value: {} }, ["id", "value"])],
		["focus_workflow_node", "Focus a workflow node.", "focus_node", objectSchema({ id: { type: "string" } }, ["id"])],
	].map(([name, description, command, parameters]) => ({ name, description, parameters, handler: async (args) => summariseCanvasResult(await live(command, args, "workflow")) }));
	const direct = ["describe_scene", "describe_shot"].map((name) => ({
		name, description: registry.get(name)?.description || name,
		parameters: objectSchema(), handler: () => registered(name),
	}));
	const tools = [reference, ...workflow, ...direct];
	// The sidecar captures the frame itself when the user attaches it; the
	// model never sees this tool, it builds an Image node instead.
	tools.internal = { capture };
	return tools;
}
