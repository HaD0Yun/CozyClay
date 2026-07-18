import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInspectHandler } from "@oh-my-blender/director-runtime";
import { start } from "../../../apps/omb-daemon/src/daemon.ts";

// Deliberately large relative to loopback WebSocket frame dispatch (expected
// sub-millisecond): the integration test's TIMEOUT/cancel/BUSY exercise never
// waits for this delay to elapse -- every request it sends against this
// daemon is timed out, cancelled, or rejected BUSY before this provider
// would ever resolve naturally. The delay only needs to be "large enough
// that a natural completion race is not a plausible flake even under heavy
// CI scheduling jitter", not "as short as possible"; 3s gives roughly a
// 1000x margin over expected loopback dispatch latency.
const RESPONSE_DELAY_MS = 3000;
const faux = registerFauxProvider();
const delayedResponse = async () => {
	await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
	return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
};
faux.setResponses([delayedResponse, delayedResponse, delayedResponse]);
const credentials = new InMemoryCredentialStore();
await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
const model = faux.getModel();
modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
const daemon = await start({ port: 0, handlers: { inspect_project: createInspectHandler({ model, modelRuntime }) } });
await daemon.stopped;
faux.unregister();
process.exit(0);
