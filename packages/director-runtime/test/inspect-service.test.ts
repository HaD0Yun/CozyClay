import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { canonicalRevision } from "@oh-my-blender/director-core";
import { createInspectHandler } from "../src/inspect-service.ts";

const unregister: Array<() => void> = [];
afterEach(() => {
	while (unregister.length) unregister.pop()?.();
});

async function setup(responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0]) {
	const faux = registerFauxProvider();
	unregister.push(faux.unregister);
	faux.setResponses(responses);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
	return { model, modelRuntime };
}

it("validates a snapshot and returns the inspected canonical manifest", async () => {
	const runtime = await setup([
		fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const snapshot = JSON.parse(
		await readFile(
			new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	const result = await createInspectHandler(runtime)({ snapshot }, { signal: new AbortController().signal } as never);
	assert.equal(result.resulting_revision_id, canonicalRevision(snapshot));
	assert.deepEqual(result.result, {
		revision: canonicalRevision(snapshot),
		sceneName: snapshot.scene.name,
		objectNames: snapshot.objects.map((object: { name: string }) => object.name),
	});
});

it("accepts a matching expected revision", async () => {
	const runtime = await setup([
		fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const snapshot = JSON.parse(
		await readFile(
			new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	const revision = canonicalRevision(snapshot);
	const result = await createInspectHandler(runtime)({ snapshot }, {
		signal: new AbortController().signal,
		request: { expected_revision_id: revision },
	} as never);
	assert.equal(result.resulting_revision_id, revision);
});

it("rejects a stale expected revision before creating a session", async () => {
	const runtime = await setup([]);
	const snapshot = JSON.parse(
		await readFile(
			new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	await assert.rejects(
		createInspectHandler(runtime)({ snapshot }, {
			signal: new AbortController().signal,
			request: { expected_revision_id: "stale" },
		} as never),
		/STALE_BASE/,
	);
});
it("aborts an active Pi turn", async () => {
	const runtime = await setup([]);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(createInspectHandler(runtime)({ snapshot: {} }, { signal: controller.signal } as never));
});
