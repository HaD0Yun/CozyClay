import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { MessageUpdateEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { type BtwContext, BtwController, type BtwStreamEvent, registerBtwCommand, wrapText } from "../src/btw.ts";

type StreamedMessage = MessageUpdateEvent["message"];

const MODEL = {
	id: "test-model",
	provider: "test-provider",
	api: "openai-completions",
	name: "Test Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as Model<Api>;

interface Call {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

interface Harness {
	ctx: BtwContext;
	calls: Call[];
	widgets: (string[] | undefined)[];
	notices: { message: string; type?: string }[];
	escape: (data: string) => { consume?: boolean; data?: string } | undefined;
	releases: number;
	emit: (event: BtwStreamEvent) => void;
	finish: () => void;
	setIdle: (idle: boolean) => void;
}

/** A streaming assistant message as `message_update` delivers it mid-turn. */
function partialAssistant(content: unknown[]): StreamedMessage {
	return { role: "assistant", content, timestamp: 0 } as unknown as StreamedMessage;
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

/**
 * Fake context whose stream is driven by the test: `emit` pushes events into
 * the in-flight `for await`, `finish` closes it.
 */
function createHarness(options?: { entries?: SessionEntry[]; auth?: { ok: false; error: string } }): Harness {
	const calls: Call[] = [];
	const widgets: (string[] | undefined)[] = [];
	const notices: { message: string; type?: string }[] = [];
	const entries = options?.entries ?? [];
	let idle = true;
	let releases = 0;
	let escape: (data: string) => { consume?: boolean; data?: string } | undefined = () => undefined;
	const queue: BtwStreamEvent[] = [];
	let wake: (() => void) | undefined;
	let closed = false;

	const harness: Harness = {
		calls,
		widgets,
		notices,
		releases: 0,
		escape: (data) => escape(data),
		emit: (event) => {
			queue.push(event);
			wake?.();
		},
		finish: () => {
			closed = true;
			wake?.();
		},
		setIdle: (value) => {
			idle = value;
		},
		ctx: {
			ui: {
				setWidget: (_key, content) => {
					widgets.push(content);
				},
				notify: (message, type) => {
					notices.push({ message, type });
				},
				onTerminalInput: (handler) => {
					escape = handler;
					return () => {
						releases += 1;
						harness.releases = releases;
					};
				},
			},
			model: MODEL,
			modelRegistry: {
				getProvider: () => ({
					streamSimple: (_model, context, streamOptions) => {
						calls.push({ context, options: streamOptions });
						return {
							async *[Symbol.asyncIterator]() {
								while (true) {
									const event = queue.shift();
									if (event) {
										yield event;
										continue;
									}
									if (closed) return;
									await new Promise<void>((resolve) => {
										wake = resolve;
									});
								}
							},
						};
					},
				}),
				getApiKeyAndHeaders: async () => options?.auth ?? { ok: true, apiKey: "key" },
			},
			sessionManager: {
				getEntries: () => entries,
				getLeafId: () => entries.at(-1)?.id ?? null,
			},
			isIdle: () => idle,
			getSystemPrompt: () => "SYSTEM",
		},
	};
	return harness;
}

function lastWidget(harness: Harness): string[] | undefined {
	return harness.widgets.at(-1);
}

describe("/btw side question", () => {
	let controller: BtwController;

	beforeEach(() => {
		controller = new BtwController();
	});

	it("rejects an empty question without calling the provider", async () => {
		const harness = createHarness();
		await controller.run("   ", harness.ctx);
		assert.deepEqual(harness.notices, [{ message: "Usage: /btw <question>", type: "warning" }]);
		assert.equal(harness.calls.length, 0);
		assert.equal(controller.hasActiveRequest(), false);
	});

	it("surfaces an auth failure instead of streaming", async () => {
		const harness = createHarness({ auth: { ok: false, error: 'No API key found for "test-provider"' } });
		await controller.run("which entity owns the key light", harness.ctx);
		assert.deepEqual(harness.notices, [
			{ message: '/btw: No API key found for "test-provider"', type: "error" },
		]);
		assert.equal(harness.calls.length, 0);
	});

	it("sends the session context, the question, and no tools", async () => {
		const harness = createHarness({ entries: [userEntry("a", null, "stage the scene")] });
		const running = controller.run("which light is key", harness.ctx);
		harness.emit({ type: "text_delta", delta: "the spot" });
		harness.finish();
		await running;

		assert.equal(harness.calls.length, 1);
		const context = harness.calls[0].context;
		assert.equal(context.systemPrompt, "SYSTEM");
		// `tools` must be absent, not an empty array: an empty toolConfig is a
		// hard 400 on LiteLLM -> Bedrock once the session has tool history.
		assert.equal("tools" in context, false);
		assert.equal(context.messages.length, 2);
		assert.deepEqual(context.messages[0].content, [{ type: "text", text: "stage the scene" }]);
		const question = context.messages[1];
		assert.equal(question.role, "user");
		const text = Array.isArray(question.content) ? question.content[0] : undefined;
		assert.ok(text && text.type === "text");
		assert.match(text.text, /Do not call tools/);
		assert.match(text.text, /which light is key/);
		assert.equal(harness.calls[0].options?.apiKey, "key");
	});

	it("replays only the text of the in-flight assistant message", async () => {
		const harness = createHarness({ entries: [userEntry("a", null, "stage the scene")] });
		controller.trackAssistantMessage(
			partialAssistant([
				{ type: "text", text: "staging now" },
				{ type: "toolCall", id: "1", name: "stage_scene", arguments: {} },
			]),
		);
		const running = controller.run("status?", harness.ctx);
		harness.finish();
		await running;

		const messages = harness.calls[0].context.messages;
		assert.equal(messages.length, 2);
		const question = messages[1];
		const text = Array.isArray(question.content) ? question.content[0] : undefined;
		assert.ok(text && text.type === "text");
		assert.match(text.text, /in-progress answer so far:\nstaging now/);
		assert.doesNotMatch(text.text, /stage_scene/);
	});

	it("drops the in-flight replay once the turn ends", async () => {
		const harness = createHarness();
		controller.trackAssistantMessage(partialAssistant([{ type: "text", text: "half" }]));
		controller.clearAssistantTracking();
		const running = controller.run("status?", harness.ctx);
		harness.finish();
		await running;
		const messages = harness.calls[0].context.messages;
		assert.equal(messages.length, 1);
		const text = Array.isArray(messages[0].content) ? messages[0].content[0] : undefined;
		assert.ok(text && text.type === "text");
		assert.doesNotMatch(text.text, /in-progress answer/);
	});

	it("streams deltas into the widget and marks completion", async () => {
		const harness = createHarness();
		const running = controller.run("who owns Cube", harness.ctx);
		harness.emit({ type: "text_delta", delta: "the " });
		harness.emit({ type: "text_delta", delta: "director" });
		harness.finish();
		await running;

		const widget = lastWidget(harness);
		assert.deepEqual(widget, ["btw who owns Cube", "the director", "Esc dismiss"]);
		assert.equal(controller.hasActiveRequest(), true);
	});

	it("renders a stream error", async () => {
		const harness = createHarness();
		const running = controller.run("who owns Cube", harness.ctx);
		harness.emit({ type: "error", error: { errorMessage: "provider exploded" } });
		harness.finish();
		await running;

		assert.deepEqual(lastWidget(harness), ["btw who owns Cube", "failed: provider exploded", "Esc dismiss"]);
	});

	it("consumes Esc and aborts the request while the agent is idle", async () => {
		const harness = createHarness();
		const running = controller.run("who owns Cube", harness.ctx);
		await Promise.resolve();
		const result = harness.escape("\u001b");
		harness.finish();
		await running;

		assert.deepEqual(result, { consume: true });
		assert.equal(controller.hasActiveRequest(), false);
		assert.equal(lastWidget(harness), undefined);
		assert.equal(harness.releases, 1);
	});

	it("consumes Esc while the agent is streaming instead of killing the turn", async () => {
		// Reported from a real session: Esc is what the widget offers, and
		// mid-turn is exactly when /btw is used, so following the hint aborted
		// the director turn the question was about -- minutes of Blender work
		// gone for pressing the documented key. The abort survives as a second
		// press, once the widget and this handler are gone.
		const harness = createHarness();
		harness.setIdle(false);
		const running = controller.run("who owns Cube", harness.ctx);
		await Promise.resolve();
		const result = harness.escape("\u001b");
		harness.finish();
		await running;

		assert.deepEqual(result, { consume: true });
		assert.equal(controller.hasActiveRequest(), false);
		assert.equal(lastWidget(harness), undefined);
	});

	it("keeps asking in one thread and carries the earlier exchanges", async () => {
		// Without this every question arrived cold, so a follow-up had to
		// restate what it was following up on.
		const harness = createHarness();
		assert.equal(controller.toggle(harness.ctx), true);

		const first = controller.run("which entity owns that light", harness.ctx);
		await Promise.resolve();
		harness.emit({ type: "text_delta", delta: "the Walker rig" });
		harness.finish();
		await first;

		const second = controller.run("and its parent", harness.ctx);
		await Promise.resolve();
		harness.finish();
		await second;

		const asked = harness.calls.at(-1)?.context.messages.at(-1);
		const text = (asked?.content as { text: string }[])[0].text;
		assert.match(text, /Earlier in this side thread:/);
		assert.match(text, /Q: which entity owns that light/);
		assert.match(text, /A: the Walker rig/);
		assert.match(text, /and its parent/);
		assert.deepEqual(controller.thread(), [
			{ question: "which entity owns that light", answer: "the Walker rig" },
		]);
	});

	it("does not record an answer that failed", async () => {
		// A half sentence carried forward would read as something the model meant.
		const harness = createHarness();
		controller.toggle(harness.ctx);
		const running = controller.run("who owns Cube", harness.ctx);
		await Promise.resolve();
		harness.emit({ type: "error", error: { errorMessage: "upstream refused" } });
		harness.finish();
		await running;

		assert.deepEqual(controller.thread(), []);
	});

	it("closes the thread on Esc and forgets it", async () => {
		const harness = createHarness();
		controller.toggle(harness.ctx);
		const running = controller.run("who owns Cube", harness.ctx);
		await Promise.resolve();
		harness.emit({ type: "text_delta", delta: "the Walker rig" });
		harness.finish();
		await running;
		assert.equal(controller.thread().length, 1);

		harness.escape("\u001b");

		assert.equal(controller.isConversing(), false);
		// Forgotten deliberately: a reopened /btw that remembered an hour-old
		// conversation would answer against context the user forgot giving it.
		assert.deepEqual(controller.thread(), []);
	});

	it("toggling off closes the thread the same way", async () => {
		const harness = createHarness();
		controller.toggle(harness.ctx);
		assert.equal(controller.isConversing(), true);
		assert.equal(controller.toggle(harness.ctx), false);
		assert.deepEqual(controller.thread(), []);
		assert.equal(lastWidget(harness), undefined);
	});

	it("says on screen that typed input is being swallowed", async () => {
		// The thread silently eats what the user types; a widget that did not
		// say so is one keystroke from looking like a hung session.
		const harness = createHarness();
		controller.toggle(harness.ctx);
		const widget = lastWidget(harness);
		assert.ok(widget);
		assert.match(widget.join("\n"), /type to keep asking, Esc or \/btw to leave/);
	});

	it("ignores escape sequences that are not a bare Esc", async () => {
		const harness = createHarness();
		const running = controller.run("who owns Cube", harness.ctx);
		await Promise.resolve();
		assert.equal(harness.escape("\u001b[A"), undefined);
		assert.equal(controller.hasActiveRequest(), true);
		harness.finish();
		await running;
	});

	it("cancels the previous request when a second /btw starts", async () => {
		const first = createHarness();
		const firstRun = controller.run("first", first.ctx);
		await Promise.resolve();
		const second = createHarness();
		const secondRun = controller.run("second", second.ctx);
		second.finish();
		await secondRun;
		first.finish();
		await firstRun;

		assert.equal(first.releases, 1);
		assert.deepEqual(lastWidget(second), ["btw second", "...", "Esc dismiss"]);
	});
});

describe("wrapText", () => {
	it("wraps on word boundaries and preserves blank lines", () => {
		assert.deepEqual(wrapText("alpha beta gamma delta epsilon", 20), ["alpha beta gamma", "delta epsilon"]);
		assert.deepEqual(wrapText("a\n\nb", 20), ["a", "", "b"]);
	});

	it("hard-splits words longer than the width", () => {
		assert.deepEqual(wrapText("x".repeat(45), 20), ["x".repeat(20), "x".repeat(20), "xxxxx"]);
	});
});

describe("registerBtwCommand", () => {
	it("registers /btw and the turn-tracking listeners", () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const events: string[] = [];
		const pi = {
			registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commands.set(name, options);
			},
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		const controller = registerBtwCommand(pi);

		const command = commands.get("btw");
		assert.ok(command);
		assert.equal(
			command.description,
			"Ask an ephemeral side question, or toggle a side thread with no argument",
		);
		assert.deepEqual(events, [
			"input",
			"message_update",
			"message_end",
			"agent_end",
			"session_before_switch",
		]);
		assert.equal(controller.hasActiveRequest(), false);
	});
});
