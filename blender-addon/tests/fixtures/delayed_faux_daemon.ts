import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInspectHandler } from "@oh-my-blender/director-runtime";
import { start } from "../../../apps/omb-daemon/src/daemon.ts";

const faux = registerFauxProvider();
faux.setResponses([
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
	},
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
	},
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
	},
]);
const credentials = new InMemoryCredentialStore();
await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
const model = faux.getModel();
modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
const daemon = await start({ port: 0, handlers: { inspect_project: createInspectHandler({ model, modelRuntime }) } });
await daemon.stopped;
faux.unregister();
process.exit(0);
