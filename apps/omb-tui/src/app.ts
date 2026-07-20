import {
	Container,
	Editor,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
	getKeybindings,
	type Component,
	type EditorTheme,
	type Terminal,
} from "@earendil-works/pi-tui";
import { connectController, reconnectController, type ControllerSession } from "./controller.ts";
import { InterruptController } from "./interrupt.ts";
import type { DirectorServerMessage } from "./protocol.ts";
import {
	appendTranscriptNotice,
	createTranscriptState,
	evaluatePromptSubmission,
	formatStatus,
	markTurnSubmitted,
	reduceDirectorMessage,
	type TranscriptState,
} from "./transcript.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";

const identity = (text: string) => text;

const EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

export interface RunDirectorTuiOptions {
	readonly projectDirectory: string;
	readonly daemonArguments: readonly string[];
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly repositoryRoot?: string;
	readonly runtimeBaseDirectory?: string;
	readonly terminal?: Terminal;
}

function isTerminalMessage(message: DirectorServerMessage): boolean {
	return message.type === "director_turn_completed" ||
		message.type === "director_turn_failed" ||
		message.type === "director_turn_cancelled" ||
		message.type === "error";
}

class DirectorLayout implements Component {
	private readonly header: Container;
	private readonly viewport: TranscriptViewport;
	private readonly footer: Container;
	private readonly terminal: Terminal;
	private readonly setViewportHeight: (height: number) => void;

	constructor(
		header: Container,
		viewport: TranscriptViewport,
		footer: Container,
		terminal: Terminal,
		setViewportHeight: (height: number) => void,
	) {
		this.header = header;
		this.viewport = viewport;
		this.footer = footer;
		this.terminal = terminal;
		this.setViewportHeight = setViewportHeight;
	}

	invalidate(): void {
		this.header.invalidate();
		this.viewport.invalidate();
		this.footer.invalidate();
	}

	render(width: number): string[] {
		const header = this.header.render(width);
		const footer = this.footer.render(width);
		this.setViewportHeight(Math.max(1, this.terminal.rows - header.length - footer.length));
		return [...header, ...this.viewport.render(width), ...footer];
	}
}

export class DirectorTui {
	private session: ControllerSession;
	private readonly reconnect: ((signal: AbortSignal) => Promise<ControllerSession>) | undefined;
	private readonly tui: TUI;
	private readonly viewport: TranscriptViewport;
	private readonly statusText = new Text("", 1, 0);
	private readonly bridgeText = new Text("", 1, 0);
	private readonly input: Editor;
	private viewportHeight = 1;
	private readonly interruptController = new InterruptController();
	private state: TranscriptState = createTranscriptState();
	private connectionStatus: "connected" | "reconnecting" | "disconnected" = "connected";
	private stopped = false;
	private reconnecting = false;
	private readonly reconnectAbortController = new AbortController();
	private reconnectPromise: Promise<void> | undefined;
	private resolveStopped!: () => void;
	private readonly stoppedPromise: Promise<void>;
	private removeMessageListener: () => void = () => {};
	private removeDisconnectListener: () => void = () => {};
	private removeInputListener: () => void = () => {};
	private removeBridgeStatusListener: () => void = () => {};
	private bridgeTicketTimer: ReturnType<typeof setInterval> | undefined;
	private bridgeTicketPending = false;

	constructor(
		session: ControllerSession,
		terminal: Terminal = new ProcessTerminal(),
		reconnect?: (signal: AbortSignal) => Promise<ControllerSession>,
	) {
		this.session = session;
		this.reconnect = reconnect;
		this.tui = new TUI(terminal, true);
		this.viewport = new TranscriptViewport({ getHeight: () => this.viewportHeight });
		this.input = new Editor(this.tui, EDITOR_THEME, { paddingX: 1 });
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		for (const message of session.initialMessages) this.state = reduceDirectorMessage(this.state, message);
		this.viewport.replace(this.state.events);
		for (const notice of this.state.notices) this.viewport.appendNotice(notice);

		const header = new Container();
		header.addChild(new Text("oh-my-blender director", 1, 0));
		const footer = new Container();
		footer.addChild(new Spacer(1));
		footer.addChild(this.bridgeText);
		footer.addChild(this.statusText);
		footer.addChild(new Text("Prompt", 1, 0));
		footer.addChild(this.input);
		this.tui.addChild(new DirectorLayout(
			header,
			this.viewport,
			footer,
			terminal,
			(height) => { this.viewportHeight = height; },
		));
		this.tui.setFocus(this.input);
		this.input.onSubmit = (prompt) => this.submit(prompt);
		this.render();
	}

	async run(): Promise<void> {
		this.attachSession(this.session);
		this.removeInputListener = this.tui.addInputListener((data) => {
			const keybindings = getKeybindings();
			if (keybindings.matches(data, "tui.editor.pageUp")) {
				this.viewport.scrollPage(-1);
				this.render();
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.editor.pageDown")) {
				this.viewport.scrollPage(1);
				this.render();
				return { consume: true };
			}
			if (!keybindings.matches(data, "tui.input.copy")) return undefined;
			const action = this.interruptController.interrupt(this.state.activeRequestId);
			if (action.action === "cancel") {
				this.session.cancel(action.requestId);
				this.state = { ...this.state, status: "cancelling" };
				this.render();
			} else {
				void this.exit();
			}
			return { consume: true };
		});
		this.tui.start();
		this.render();
		await this.stoppedPromise;
	}

	async exit(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.reconnectAbortController.abort();
		if (this.reconnectPromise !== undefined) await this.reconnectPromise;
		this.removeMessageListener();
		this.removeDisconnectListener();
		this.removeBridgeStatusListener();
		clearInterval(this.bridgeTicketTimer);
		this.removeInputListener();
		await this.session.disconnect();
		await this.tui.terminal.drainInput(250, 25);
		this.tui.stop();
		this.resolveStopped();
	}

	private submit(prompt: string): void {
		const gate = evaluatePromptSubmission(this.state, prompt);
		if (gate.prompt === undefined) {
			if (prompt.trim().length === 0) this.input.setText("");
			if (gate.notice !== undefined) this.appendNotice(gate.notice);
			this.render();
			return;
		}
		try {
			const requestId = this.session.sendTurn(gate.prompt);
			this.input.addToHistory(gate.prompt);
			this.input.setText("");
			this.state = markTurnSubmitted(this.state, requestId);
		} catch (error) {
			this.appendNotice(error instanceof Error ? error.message : "prompt submission failed");
		}
		this.render();
	}

	private appendNotice(notice: string): void {
		this.state = appendTranscriptNotice(this.state, notice);
		this.viewport.appendNotice(notice);
	}

	private receive(message: DirectorServerMessage): void {
		const noticeCount = this.state.notices.length;
		this.state = reduceDirectorMessage(this.state, message);
		switch (message.type) {
			case "director_transcript":
				this.viewport.replace(message.events);
				break;
			case "director_turn_delta":
			case "director_turn_started":
			case "director_assistant_utterance":
			case "director_tool_call_started":
			case "director_tool_call_finished":
			case "director_turn_completed":
			case "director_turn_failed":
			case "director_turn_cancelled":
				this.viewport.accept(message);
				break;
		}
		for (const notice of this.state.notices.slice(noticeCount)) this.viewport.appendNotice(notice);
		if (isTerminalMessage(message)) this.interruptController.turnTerminated();
		this.render();
	}

	private render(): void {
		this.statusText.setText(formatStatus(this.state, this.connectionStatus));
		this.input.disableSubmit = this.connectionStatus !== "connected" ||
			this.state.activeRequestId !== undefined ||
			this.state.status === "cancelling";
		this.tui.requestRender();
	}

	private attachSession(session: ControllerSession): void {
		this.removeMessageListener();
		this.removeDisconnectListener();
		this.removeBridgeStatusListener();
		this.session = session;
		for (const message of session.initialMessages) this.receive(message);
		this.removeMessageListener = session.onMessage((message) => this.receive(message));
		this.removeBridgeStatusListener = session.onBridgeStatus((attached) => {
			if (session !== this.session || this.stopped) return;
			if (attached) {
				clearInterval(this.bridgeTicketTimer);
				this.bridgeTicketTimer = undefined;
				this.bridgeText.setText("Blender attached");
				this.render();
				return;
			}
			this.startBridgeTicketReissue();
		});
		this.removeDisconnectListener = session.onDisconnect(() => {
			if (this.stopped || session !== this.session) return;
			this.connectionStatus = this.reconnect === undefined ? "disconnected" : "reconnecting";
			this.state = { ...this.state, activeRequestId: undefined, taskStatus: undefined };
			this.viewport.discardEphemeral();
			this.render();
			if (this.reconnect !== undefined) {
				this.reconnectPromise = this.reconnectLoop();
				void this.reconnectPromise;
			}
		});
	}

	private startBridgeTicketReissue(): void {
		if (this.bridgeTicketTimer !== undefined) return;
		void this.issueBridgeTicket();
		this.bridgeTicketTimer = setInterval(() => void this.issueBridgeTicket(), 5_000);
		this.bridgeTicketTimer.unref();
	}

	private async issueBridgeTicket(): Promise<void> {
		if (this.bridgeTicketPending || this.stopped) return;
		this.bridgeTicketPending = true;
		try {
			const ticket = await this.session.issueBridgeTicket();
			this.bridgeText.setText(
				`Blender attach: handoff ready (expires in ${Math.ceil(ticket.expiresInMs / 1_000)}s)`,
			);
			this.render();
		} catch (error) {
			this.appendNotice(error instanceof Error ? error.message : "attach ticket unavailable");
			this.render();
		} finally {
			this.bridgeTicketPending = false;
		}
	}

	private async reconnectLoop(): Promise<void> {
		if (this.reconnecting || this.reconnect === undefined) return;
		this.reconnecting = true;
		let delayMs = 1_000;
		try {
			while (!this.stopped) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, delayMs);
					const signal = this.reconnectAbortController.signal;
					function done(): void {
						clearTimeout(timer);
						signal.removeEventListener("abort", done);
						resolve();
					}
					signal.addEventListener("abort", done, { once: true });
					timer.unref();
				});
				if (this.stopped) return;
				try {
					const session = await this.reconnect(this.reconnectAbortController.signal);
					if (this.stopped) {
						await session.disconnect();
						return;
					}
					this.connectionStatus = "connected";
					this.attachSession(session);
					this.render();
					return;
				} catch {
					delayMs = Math.min(delayMs * 2, 30_000);
				}
			}
		} finally {
			this.reconnecting = false;
		}
	}
}

export async function runDirectorTui(options: RunDirectorTuiOptions): Promise<void> {
	const session = await connectController(options);
	const app = new DirectorTui(session, options.terminal, (signal) => reconnectController(options, signal));
	const close = () => {
		void app.exit();
	};
	process.once("SIGHUP", close);
	process.once("SIGTERM", close);
	try {
		await app.run();
	} finally {
		process.off("SIGHUP", close);
		process.off("SIGTERM", close);
	}
}
