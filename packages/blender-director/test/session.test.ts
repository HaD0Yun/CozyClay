import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProjectManifest, parseSceneSnapshot } from "../src/manifest.ts";
import { createDirectorSession } from "../src/session.ts";

describe("Blender director session", () => {
	const unregister: Array<() => void> = [];

	afterEach(() => {
		while (unregister.length > 0) unregister.pop()?.();
	});

	it("lets a real Pi session inspect a Blender project without write tools", async () => {
		// Given a deterministic model and a parsed Blender scene
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("scene inspected"),
		]);
		const authStorage = new InMemoryCredentialStore();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: faux.api,
			models: faux.models,
		});
		const manifest = createProjectManifest(
			parseSceneSnapshot({
				schemaVersion: 2,
				scene: {
					name: "Boxing",
					frameStart: 1,
					frameEnd: 384,
					fps: 24,
					activeCamera: null,
				},
				render: { resolutionX: 1920, resolutionY: 1080, resolutionPercentage: 100 },
				objects: [],
				cameras: [],
				markers: [],
				animations: [],
			}),
		);

		// When Pi handles a natural-language directing request
		const session = await createDirectorSession({ manifest, model, modelRuntime });
		try {
			await session.prompt("inspect this Blender scene");

			// Then the only tool result is the current Blender manifest
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			assert.equal(toolResult?.role, "toolResult");
			assert.match(JSON.stringify(toolResult), new RegExp(manifest.revision));
			assert.equal(session.messages.at(-1)?.role, "assistant");
		} finally {
			session.dispose();
		}
	});
});
