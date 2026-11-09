import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

function normaliseStep(step) {
	if (typeof step === "string") return { type: "text", text: step };
	if (step?.type === "text" || step?.type === "toolCall") return step;
	if (step?.type === "tool_call") return { ...step, type: "toolCall" };
	if (step?.toolCall) return { ...step.toolCall, type: "toolCall" };
	return step;
}

function messageForSteps(steps) {
	const content = [];
	for (const raw of steps) {
		const step = normaliseStep(raw);
		if (!step) continue;
		if (step.type === "text") content.push(fauxText(step.text ?? ""));
		if (step.type === "toolCall") content.push(fauxToolCall(step.name, step.arguments ?? step.args ?? {}, { id: step.id }));
	}
	return content.length ? fauxAssistantMessage(content) : null;
}

function responseMessages(steps) {
	const messages = [];
	let content = [];
	for (const raw of steps) {
		if (Array.isArray(raw)) {
			const grouped = messageForSteps(raw);
			if (grouped) messages.push(grouped);
			continue;
		}
		const step = normaliseStep(raw);
		if (!step) continue;
		if (step.type === "text") {
			content.push(fauxText(step.text ?? ""));
			continue;
		}
		if (step.type === "toolCall") {
			content.push(fauxToolCall(step.name, step.arguments ?? step.args ?? {}, { id: step.id }));
			messages.push(fauxAssistantMessage(content));
			content = [];
		}
	}
	if (content.length) messages.push(fauxAssistantMessage(content));
	return messages;
}

/**
 * A deterministic pi model for route and runner tests. `script()` accepts the
 * compact sequence used by the agent tests; text immediately before a tool
 * call stays in that assistant message, matching the browser's old loop.
 */
export function createFakeModel({ models = createModels(), provider = "faux", modelId = "scripted", modelName = "Scripted" } = {}) {
	const calls = [];
	const faux = fauxProvider({
		provider,
		models: [{ id: modelId, name: modelName, reasoning: true, input: ["text", "image"] }],
	});
	// Faux response factories are the public fixture's observation point: the
	// context is exactly what pi handed to the provider for each request.
	const originalSet = faux.setResponses.bind(faux);
	const install = (messages) => {
		const wrapped = messages.map((message) => async (context) => {
			calls.push(context);
			return message;
		});
		originalSet(wrapped);
	};
	const fixture = {
		provider: faux.provider,
		models,
		fauxProvider: faux,
		calls,
		script(steps) {
			const messages = responseMessages(Array.isArray(steps) ? steps : []);
			install(messages);
		},
	};
	if (models?.setProvider) models.setProvider(faux.provider);
	return fixture;
}
