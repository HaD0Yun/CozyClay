/**
 * `/btw <question>` — ephemeral side question.
 *
 * The director session is long-running: a single turn can hold a Blender
 * prepared transaction open for minutes. Asking "btw, which entity owns that
 * light?" must therefore neither interrupt the turn nor enter the session
 * history, or the next mutation would be planned against a polluted context.
 *
 * The command runs a one-shot side-channel request:
 *   - it snapshots the current system prompt plus the session context,
 *   - it appends the question as a transient user message,
 *   - it sends no tools at all, and
 *   - it never writes an entry back to the session.
 *
 * Pi executes extension commands immediately even while the agent is
 * streaming (see `interactive-mode.ts`, which routes `/`-commands through
 * `session.prompt()` without queueing them), so `/btw` answers mid-turn.
 */

import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "cclay-btw";
const MAX_WIDGET_WIDTH = 100;
const ESCAPE = "\u001b";

const BTW_INSTRUCTIONS = [
	"<btw>",
	"This is an ephemeral side question about the current CozyClay session.",
	"Answer briefly and directly from the conversation context you already have.",
	"Do not call tools, do not touch the Blender scene, and do not resume the main task.",
	"",
	"Question:",
].join("\n");

/** The `ctx.ui` surface `/btw` needs. Structural so tests need no TUI. */
export interface BtwUi {
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
}

/** Provider slice used for the side-channel call. */
export interface BtwStreamProvider {
	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AsyncIterable<BtwStreamEvent>;
}

export type BtwStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "error"; error: Pick<AssistantMessage, "errorMessage"> }
	| { type: string };

/**
 * The `ExtensionCommandContext` slice `/btw` needs. Read-only by
 * construction: nothing here can append to the session, which is what keeps
 * the side question ephemeral.
 */
export interface BtwContext {
	ui: BtwUi;
	model: Model<Api> | undefined;
	modelRegistry: {
		getProvider(provider: string): BtwStreamProvider | undefined;
		getApiKeyAndHeaders(
			model: Model<Api>,
		): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	sessionManager: {
		getEntries: ExtensionCommandContext["sessionManager"]["getEntries"];
		getLeafId: ExtensionCommandContext["sessionManager"]["getLeafId"];
	};
	isIdle(): boolean;
	getSystemPrompt(): string;
}

/** One question and the answer it got, held only for the open side thread. */
export interface BtwExchange {
	question: string;
	answer: string;
}

interface ActiveRequest {
	question: string;
	abort: AbortController;
	ui: BtwUi;
	answer: string;
	state: "running" | "complete" | "error";
	error?: string;
	releaseInput: () => void;
}

/** Greedy word wrap. Long words are hard-split so the widget never overflows. */
export function wrapText(text: string, width: number): string[] {
	const limit = Math.max(width, 20);
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of paragraph.split(" ")) {
			let pending = word;
			while (pending.length > limit) {
				if (current.length > 0) {
					lines.push(current);
					current = "";
				}
				lines.push(pending.slice(0, limit));
				pending = pending.slice(limit);
			}
			if (current.length === 0) {
				current = pending;
			} else if (current.length + 1 + pending.length <= limit) {
				current = `${current} ${pending}`;
			} else {
				lines.push(current);
				current = pending;
			}
		}
		lines.push(current);
	}
	return lines;
}

/**
 * The in-flight answer is quoted inside the question rather than replayed as
 * an assistant message: a half-streamed turn usually ends in a tool call whose
 * result does not exist yet, and replaying that pair is a hard error on
 * Anthropic-style APIs.
 */
function renderQuestion(question: string, inFlightAnswer: string, thread: readonly BtwExchange[]): string {
	const partial = inFlightAnswer ? `\n\nYour in-progress answer so far:\n${inFlightAnswer}` : "";
	// The thread is quoted for the same reason the in-flight answer is: these
	// exchanges never existed as real provider turns, and synthesizing
	// assistant messages for them would mean inventing a provider, a model and
	// a usage record that no request ever produced.
	const earlier = thread.length
		? `\n\nEarlier in this side thread:\n${thread
				.map((exchange) => `Q: ${exchange.question}\nA: ${exchange.answer}`)
				.join("\n\n")}\n\nNow:`
		: "";
	return `${BTW_INSTRUCTIONS}${earlier}\n${question}${partial}\n</btw>`;
}

/** The message shape Pi streams through `message_update`. */
type StreamedMessage = MessageUpdateEvent["message"];

/** Text-only view of a partial assistant message. */
function partialAssistantText(message: StreamedMessage | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

/**
 * Owns the single in-flight side question and the widget that renders it.
 * A second `/btw` cancels the first: two concurrent side channels would race
 * on the same widget key.
 */
export class BtwController {
	#active: ActiveRequest | undefined;
	#inFlightAssistant: StreamedMessage | undefined;
	/**
	 * Exchanges in the open side thread, oldest first. Held here and nowhere
	 * else: the whole point of /btw is that none of this reaches the session,
	 * so continuity has to be carried by the controller.
	 */
	#thread: BtwExchange[] = [];
	#conversing = false;
	/** Last ui seen, so the thread can be closed with nothing in flight. */
	#lastUi: BtwUi | undefined;

	/** Whether typed input is currently going to the side channel. */
	isConversing(): boolean {
		return this.#conversing;
	}

	/** Exchanges in the open thread, oldest first. */
	thread(): readonly BtwExchange[] {
		return this.#thread;
	}

	/**
	 * Toggle the side thread. Turning it off drops the thread, because a
	 * reopened /btw that silently remembered a conversation from an hour ago
	 * would answer against context the user has forgotten giving it.
	 */
	toggle(ctx: BtwContext): boolean {
		this.#conversing = !this.#conversing;
		if (!this.#conversing) {
			this.#thread = [];
			this.#closeWidget(ctx.ui);
		} else {
			this.#renderIdleThread(ctx);
		}
		return this.#conversing;
	}

	/** Leave the side thread if it is open. Safe to call when it is not. */
	leave(): void {
		if (!this.#conversing) return;
		const ui = this.#active?.ui ?? this.#lastUi;
		this.#conversing = false;
		this.#thread = [];
		this.dismiss();
		// Also when nothing was in flight: between questions the widget is the
		// only sign the thread is open, and dismiss() has no request to clear.
		if (ui) this.#closeWidget(ui);
	}

	#closeWidget(ui: BtwUi): void {
		ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
	}

	/** Latest streaming assistant text, so a mid-turn question sees the half-written answer. */
	trackAssistantMessage(message: StreamedMessage): void {
		if (message.role === "assistant") this.#inFlightAssistant = message;
	}

	clearAssistantTracking(): void {
		this.#inFlightAssistant = undefined;
	}

	hasActiveRequest(): boolean {
		return this.#active !== undefined;
	}

	async run(args: string, ctx: BtwContext): Promise<void> {
		const question = args.trim();
		if (!question) {
			ctx.ui.notify("Usage: /btw <question>", "warning");
			return;
		}

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No active model available for /btw.", "error");
			return;
		}
		const provider = ctx.modelRegistry.getProvider(model.provider);
		if (!provider) {
			ctx.ui.notify(`No provider registered for "${model.provider}".`, "error");
			return;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`/btw: ${auth.error}`, "error");
			return;
		}

		this.dismiss();

		const request: ActiveRequest = {
			question,
			abort: new AbortController(),
			ui: ctx.ui,
			answer: "",
			state: "running",
			releaseInput: () => {},
		};
		request.releaseInput = ctx.ui.onTerminalInput((data) => {
			if (data !== ESCAPE) return undefined;
			// Always consumed while the widget is up. Letting Esc through
			// during streaming -- which is precisely when /btw is most useful --
			// meant that reaching for the documented "Esc dismiss" killed the
			// turn the question was about, and a director turn can be minutes
			// of Blender work. The escape hatch survives as a second press:
			// once this handler is released with the widget, Esc aborts the
			// turn exactly as it always has.
			// Esc is also how you leave the thread: the widget says so, and
			// having it clear the answer but silently keep swallowing typed
			// input would be the worse surprise.
			this.leave();
			this.dismiss();
			return { consume: true };
		});
		this.#active = request;
		this.#render(request);

		try {
			const stream = provider.streamSimple(model, this.#buildContext(ctx, question), {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: request.abort.signal,
			});
			for await (const event of stream) {
				if (this.#active !== request) return;
				if (event.type === "text_delta" && "delta" in event) {
					request.answer += event.delta;
					this.#render(request);
					continue;
				}
				if (event.type === "error" && "error" in event) {
					request.state = "error";
					request.error = event.error.errorMessage ?? "request failed";
					this.#render(request);
					return;
				}
			}
			if (this.#active !== request) return;
			request.state = "complete";
			this.#render(request);
			// Only a completed answer joins the thread. Recording an aborted or
			// failed one would carry a half sentence into the next question as
			// if the model had meant it.
			// An empty answer is recorded as nothing rather than as a turn where
			// the model said nothing, which is what a later question would read
			// it as.
			if (this.#conversing && request.answer) {
				this.#thread.push({ question: request.question, answer: request.answer });
			}
		} catch (error) {
			if (this.#active !== request) return;
			request.state = "error";
			request.error = error instanceof Error ? error.message : String(error);
			this.#render(request);
		}
	}

	/** Abort the in-flight request, if any, and clear the widget. */
	dismiss(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		active.abort.abort();
		active.releaseInput();
		active.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
	}

	#buildContext(ctx: BtwContext, question: string): Context {
		const session = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const messages: Message[] = convertToLlm(session.messages);
		messages.push({
			role: "user",
			content: [{ type: "text", text: renderQuestion(question, partialAssistantText(this.#inFlightAssistant), this.#thread) }],
			timestamp: Date.now(),
		});
		// `tools` stays absent. An empty array is not equivalent: LiteLLM to
		// Bedrock rejects a request that carries an empty toolConfig, and
		// `tool_choice: "none"` needs a tools list to be meaningful.
		return { systemPrompt: ctx.getSystemPrompt(), messages };
	}

	#render(request: ActiveRequest): void {
		const width = Math.min(process.stdout.columns ?? MAX_WIDGET_WIDTH, MAX_WIDGET_WIDTH);
		const lines = [`btw ${request.question}`];
		if (request.state === "error") {
			lines.push(...wrapText(`failed: ${request.error ?? "unknown error"}`, width));
		} else if (request.answer) {
			lines.push(...wrapText(request.answer, width));
		} else {
			lines.push("...");
		}
		lines.push(this.#footer(request.state));
		request.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	}

	#footer(state: ActiveRequest["state"]): string {
		if (state === "running") return this.#conversing ? "Esc leave btw" : "Esc cancel /btw";
		if (!this.#conversing) return "Esc dismiss";
		// Said plainly, because while the thread is open typed input no longer
		// reaches the agent, and a user who does not know that is one keystroke
		// from thinking the session has hung.
		return "btw thread: type to keep asking, Esc or /btw to leave";
	}

	/** The between-questions widget, so an open thread is never invisible. */
	#renderIdleThread(ctx: BtwContext): void {
		this.#lastUi = ctx.ui;
		const width = Math.min(process.stdout.columns ?? MAX_WIDGET_WIDTH, MAX_WIDGET_WIDTH);
		const last = this.#thread.at(-1);
		const lines = last
			? [`btw ${last.question}`, ...wrapText(last.answer, width)]
			: ["btw thread open"];
		lines.push(this.#footer("complete"));
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	}
}

/** Register `/btw` on the extension API. */
export function registerBtwCommand(pi: ExtensionAPI): BtwController {
	const controller = new BtwController();

	pi.registerCommand("btw", {
		description: "Ask an ephemeral side question, or toggle a side thread with no argument",
		handler: (args, ctx) => {
			// Bare /btw toggles the thread. With a question it stays the
			// one-shot it always was, so the old muscle memory is untouched --
			// and asking one while the thread is open just continues it.
			if (args.trim()) return controller.run(args, ctx);
			const open = controller.toggle(ctx);
			ctx.ui.notify(
				open ? "btw thread open: typed input goes to the side channel" : "btw thread closed",
				"info",
			);
			return Promise.resolve();
		},
	});

	pi.on("input", (event, ctx) => {
		if (!controller.isConversing()) return { action: "continue" as const };
		// Slash commands stay with the agent, or /btw could not close the very
		// thread that is swallowing the input.
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" as const };
		void controller.run(event.text, ctx as unknown as BtwContext);
		return { action: "handled" as const };
	});

	pi.on("message_update", (event) => {
		controller.trackAssistantMessage(event.message);
	});
	pi.on("message_end", () => {
		controller.clearAssistantTracking();
	});
	pi.on("agent_end", () => {
		controller.clearAssistantTracking();
	});
	pi.on("session_before_switch", () => {
		controller.leave();
		controller.dismiss();
		controller.clearAssistantTracking();
	});

	return controller;
}
