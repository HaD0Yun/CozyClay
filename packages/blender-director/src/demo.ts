import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProjectManifest, parseSceneSnapshot } from "./manifest.ts";
import { createDirectorSession } from "./session.ts";

function readManifestPath(arguments_: readonly string[]): string {
	const flagIndex = arguments_.indexOf("--manifest");
	const path = flagIndex >= 0 ? arguments_[flagIndex + 1] : undefined;
	if (!path) throw new Error("Usage: npm run demo -- --manifest /path/to/blender-scene.json");
	return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

async function main(): Promise<void> {
	const manifestPath = readManifestPath(process.argv.slice(2));
	const rawSnapshot: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
	const manifest = createProjectManifest(parseSceneSnapshot(rawSnapshot));
	const faux = registerFauxProvider();
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("scene inspected"),
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: faux.api,
			models: faux.models,
		});
		const session = await createDirectorSession({ manifest, model, modelRuntime });
		try {
			await session.prompt("Inspect the current Blender project before directing it.");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			if (!toolResult) throw new Error("Pi completed without inspecting the Blender project");
			process.stdout.write(
				`${JSON.stringify({
					status: "ok",
					piTool: "inspect_project",
					revision: manifest.revision,
					scene: manifest.snapshot.scene.name,
					objects: manifest.snapshot.objects.map((object) => object.name),
				})}\n`,
			);
		} finally {
			session.dispose();
		}
	} finally {
		faux.unregister();
	}
}

await main();
