#!/usr/bin/env node
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInspectHandler } from "@oh-my-blender/director-runtime";
import { start } from "./daemon.ts";

const index = process.argv.indexOf("--port");
const port = index >= 0 ? Number(process.argv[index + 1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 through 65535");
if (!process.argv.includes("--faux")) throw new Error("NOT_CONFIGURED: a model provider is required (use --faux for the test provider)");

const faux = registerFauxProvider();
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
	fauxAssistantMessage("scene inspected"),
]);
const credentials = new InMemoryCredentialStore();
await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
const model = faux.getModel();
modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
const daemon = await start({ port, handlers: { inspect_project: createInspectHandler({ model, modelRuntime }) } });
// Architecture §4 cleanup order ends with "and exit": once the protocol
// shutdown drain completes, the child process must terminate even if the
// model runtime still holds event-loop handles.
await daemon.stopped;
faux.unregister();
process.exit(0);
