import {
	getKeybindings,
	Input,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
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
	formatTranscript,
	markTurnSubmitted,
	reduceDirectorMessage,
	type TranscriptState,
} from "./transcript.ts";

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

export class DirectorTui {
	private session: ControllerSession;
	private readonly reconnect: ((signal: AbortSignal) => Promise<ControllerSession>) | undefined;
	private readonly tui: TUI;
	private readonly transcriptText = new Text("", 1, 0);
	private readonly statusText = new Text("", 1, 0);
	private readonly bridgeText = new Text("", 1, 0);
	private readonly input = new Input();
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

	constructor(
		session: ControllerSession,
		terminal: Terminal = new ProcessTerminal(),
		reconnect?: (signal: AbortSignal) => Promise<ControllerSession>,
	) {
		this.session = session;
		this.reconnect = reconnect;
		this.tui = new TUI(terminal, true);
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		for (const message of session.initialMessages) this.state = reduceDirectorMessage(this.state, message);
		this.tui.addChild(new Text("oh-my-blender director", 1, 0));
		this.tui.addChild(this.transcriptText);
		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.bridgeText);
		this.tui.addChild(this.statusText);
		this.tui.addChild(new Text("Prompt", 1, 0));
		this.tui.addChild(this.input);
		this.tui.setFocus(this.input);
		this.input.onSubmit = (prompt) => this.submit(prompt);
		this.render();
	}

	async run(): Promise<void> {
		this.attachSession(this.session);
		this.removeInputListener = this.tui.addInputListener((data) => {
			if (!getKeybindings().matches(data, "tui.input.copy")) return undefined;
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
		try {
			const ticket = await this.session.issueBridgeTicket();
			this.bridgeText.setText(
				`Blender attach: runtime=${ticket.runtimeDirectory} ticket=${ticket.ticket} expires=${ticket.expiresInMs}ms`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "attach ticket unavailable";
			this.state = appendTranscriptNotice(this.state, message);
		}
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
		this.removeInputListener();
		await this.session.disconnect();
		await this.tui.terminal.drainInput(250, 25);
		this.tui.stop();
		this.resolveStopped();
	}

	private submit(prompt: string): void {
		const gate = evaluatePromptSubmission(this.state, prompt);
		if (gate.prompt === undefined) {
			if (prompt.trim().length === 0) this.input.setValue("");
			if (gate.notice !== undefined) this.state = appendTranscriptNotice(this.state, gate.notice);
			this.render();
			return;
		}
		try {
			const requestId = this.session.sendTurn(gate.prompt);
			this.input.setValue("");
			this.state = markTurnSubmitted(this.state, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : "prompt submission failed";
			this.state = appendTranscriptNotice(this.state, message);
		}
		this.render();
	}

	private receive(message: DirectorServerMessage): void {
		this.state = reduceDirectorMessage(this.state, message);
		if (isTerminalMessage(message)) this.interruptController.turnTerminated();
		this.render();
	}

	private render(): void {
		this.transcriptText.setText(formatTranscript(this.state) || "No turns yet.");
		this.statusText.setText(formatStatus(this.state, this.connectionStatus));
		this.tui.requestRender();
	}
	private attachSession(session: ControllerSession): void {
		this.removeMessageListener();
		this.removeDisconnectListener();
		this.session = session;
		for (const message of session.initialMessages) this.receive(message);
		this.removeMessageListener = session.onMessage((message) => this.receive(message));
		this.removeDisconnectListener = session.onDisconnect(() => {
			if (this.stopped || session !== this.session) return;
			this.connectionStatus = this.reconnect === undefined ? "disconnected" : "reconnecting";
			this.state = { ...this.state, activeRequestId: undefined, taskStatus: undefined };
			this.render();
			if (this.reconnect !== undefined) {
				this.reconnectPromise = this.reconnectLoop();
				void this.reconnectPromise;
			}
		});
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
