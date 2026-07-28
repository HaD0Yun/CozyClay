import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { buildProjectManifest } from "@cclay/director-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseSceneSnapshot } from "../../blender-protocol/src/snapshot.ts";
import { createDirectorSession, DIRECTOR_TOOL_ALLOWLIST } from "../src/session.ts";

describe("director runtime session", () => {
	const unregister: Array<() => void> = [];
	afterEach(() => {
		while (unregister.length > 0) unregister.pop()?.();
	});

	it("calls inspect_project through a live bridge in a real AgentSession", async () => {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("scene inspected"),
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		const fixture = JSON.parse(
			await readFile(
				new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
				"utf8",
			),
		);
		const manifest = buildProjectManifest(parseSceneSnapshot(fixture));
		let calls = 0;
		const session = await createDirectorSession({
			bridge: {
				inspectProject: async () => {
					calls += 1;
					return manifest;
				},
				applyCameraPlan: async () => {
					throw new Error("not invoked");
				},
				stageScene: async () => {
					throw new Error("not invoked");
				},
			},
			model,
			modelRuntime,
		});
		assert.deepEqual(session.getActiveToolNames(), ["inspect_project", "stage_scene", "apply_camera_plan"]);
		try {
			await session.prompt("inspect this Blender scene");
			assert.equal(calls, 1);
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			assert.match(JSON.stringify(toolResult), new RegExp(manifest.revision));
			assert.equal(session.messages.at(-1)?.role, "assistant");
		} finally {
			session.dispose();
		}
	});

	it("keeps the production allowlist closed to the authorized director tools", () => {
		assert.deepEqual(DIRECTOR_TOOL_ALLOWLIST, [
			"inspect_project",
			"inspect_bridge_state",
			"inspect_performance",
			"inspect_visual_qa_metrics",
			"stage_scene",
			"apply_camera_plan",
			"render_qa_frames",
			"repair_bridge",
			"apply_performance_mode",
			"create_fall_motion",
			"replace_camera_action",
		]);
	});
});
