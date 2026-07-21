import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
	formatTranscript,
	markTurnSubmitted,
	reduceDirectorMessage,
	type TranscriptState,
} from "./transcript.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";
import {
	findSlashCommand,
	formatCommandHelp,
	parseSlashInput,
	SlashCommandAutocompleteProvider,
} from "./commands.ts";
import { theme } from "./theme.ts";

const EDITOR_THEME: EditorTheme = {
	borderColor: theme.muted,
	selectList: {
		selectedPrefix: theme.accent,
		selectedText: theme.bold,
		description: theme.muted,
		scrollInfo: theme.muted,
		noMatch: theme.muted,
	},
};

/** Full-width dim horizontal rule. */
class Rule implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return [theme.muted("─".repeat(Math.max(1, Math.floor(width))))];
	}
}

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
	private readonly projectDirectory: string;
	private readonly daemonArguments: readonly string[];
	private bridgeStatusPlain = "";

	constructor(
		session: ControllerSession,
		terminal: Terminal = new ProcessTerminal(),
		reconnect?: (signal: AbortSignal) => Promise<ControllerSession>,
		context?: { readonly projectDirectory?: string; readonly daemonArguments?: readonly string[] },
	) {
		this.projectDirectory = context?.projectDirectory ?? process.cwd();
		this.daemonArguments = context?.daemonArguments ?? [];
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
		header.addChild(new Text(
			`${theme.accent("◆")} ${theme.bold("oh-my-blender")} ${theme.muted("director")}`,
			1,
			0,
		));
		header.addChild(new Rule());
		const footer = new Container();
		footer.addChild(new Spacer(1));
		footer.addChild(new Rule());
		footer.addChild(this.bridgeText);
		footer.addChild(this.statusText);
		footer.addChild(new Text(
			theme.muted("Enter send · Ctrl-C cancel/exit · PgUp/PgDn scroll"),
			1,
			0,
		));
		footer.addChild(this.input);
		this.tui.addChild(new DirectorLayout(
			header,
			this.viewport,
			footer,
			terminal,
			(height) => { this.viewportHeight = height; },
		));
		this.tui.setFocus(this.input);
		this.input.setAutocompleteProvider(new SlashCommandAutocompleteProvider());

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
		const parsed = parseSlashInput(prompt);
		if (parsed.kind === "unknown") {
			this.input.addToHistory(prompt.trim());
			this.input.setText("");
			this.appendNotice(`Unknown command: /${parsed.name} — /help lists available commands`);
			this.render();
			return;
		}
		if (parsed.kind === "command") {
			this.input.addToHistory(prompt.trim());
			this.input.setText("");
			this.executeCommand(parsed.name, parsed.args);
			this.render();
			return;
		}
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

	private executeCommand(name: string, args: string): void {
		const command = findSlashCommand(name);
		if (command?.notice !== undefined) {
			this.appendNotice(command.notice);
			return;
		}
		switch (name) {
			case "help":
				this.appendNotice(formatCommandHelp());
				return;
			case "quit":
			case "exit":
				void this.exit();
				return;
			case "clear":
			case "new":
				this.viewport.replace([]);
				this.appendNotice("Transcript view cleared - durable history stays in .omb/ and returns on reattach.");
				return;
			case "hotkeys":
				this.appendNotice(
					"Hotkeys:\n  Enter — send prompt or run command\n  Ctrl-C — cancel active turn; twice to exit\n  PgUp/PgDn — scroll transcript\n  Tab — accept autocomplete\n  Up/Down — prompt history / autocomplete selection",
				);
				return;
			case "model":
				this.appendNotice(
					this.daemonArguments.length === 0
						? "Daemon launch arguments are unknown to this controller session."
						: `Daemon model configuration: ${this.daemonArguments.join(" ")}\nTo switch models, exit and relaunch: omb --provider <id> --model <id>`,
				);
				return;
			case "status":
			case "session": {
				const bridge = this.bridgeStatusPlain;
				this.appendNotice(
					[
						"Session:",
						`  project: ${this.projectDirectory}`,
						`  connection: ${this.connectionStatus} | ${this.state.status}`,
						`  bridge: ${bridge === "" ? "unknown" : bridge}`,
						`  transcript events: ${this.state.events.length}`,
						this.daemonArguments.length === 0 ? undefined : `  daemon: ${this.daemonArguments.join(" ")}`,
					].filter((line): line is string => line !== undefined).join("\n"),
				);
				return;
			}
			case "attach":
				this.startBridgeTicketReissue();
				this.appendNotice("Blender attach handoff issued - open Blender's Oh My Blender panel and press Connect.");
				return;
			case "blender":
				this.launchBlender();
				return;
			case "copy":
				this.copyLastReply();
				return;
			case "export":
				void this.exportTranscript(args);
				return;
			default:
				this.appendNotice(`Unknown command: /${name} — /help lists available commands`);
		}
	}

	private launchBlender(): void {
		const candidates = [
			process.env.OMB_BLENDER_EXECUTABLE,
			"/opt/homebrew/bin/blender",
			"/Applications/Blender.app/Contents/MacOS/Blender",
		].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
		const executable = candidates.find((candidate) => existsSync(candidate)) ?? "blender";
		const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const attachScript = path.join(repositoryRoot, "scripts", "blender_attach.py");
		try {
			const child = spawn(executable, ["--python", attachScript], {
				cwd: this.projectDirectory,
				env: { ...process.env, OMB_PROJECT_DIR: this.projectDirectory, OMB_REPO: repositoryRoot },
				detached: true,
				stdio: "ignore",
			});
			child.on("error", (error) => {
				this.appendNotice(`Blender launch failed: ${error.message} — set OMB_BLENDER_EXECUTABLE`);
				this.render();
			});
			child.unref();
			this.startBridgeTicketReissue();
			this.appendNotice("Launching Blender for this project - it will attach via handoff discovery.");
		} catch (error) {
			this.appendNotice(error instanceof Error ? error.message : "Blender launch failed");
		}
	}

	private copyLastReply(): void {
		let content: string | undefined;
		for (const event of this.state.events) {
			if (event.type === "director_assistant_utterance") content = event.content;
			else if (event.type === "director_turn_completed") content = event.summary;
		}
		if (content === undefined) {
			this.appendNotice("Nothing to copy yet.");
			return;
		}
		try {
			const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {
				this.appendNotice("Clipboard unavailable (pbcopy not found).");
				this.render();
			});
			child.stdin.end(content);
			this.appendNotice(`Copied the last director reply (${content.length} chars).`);
		} catch {
			this.appendNotice("Clipboard unavailable.");
		}
	}

	private async exportTranscript(argument: string): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const target = argument === ""
			? path.join(this.projectDirectory, `omb-transcript-${stamp}.md`)
			: path.resolve(this.projectDirectory, argument);
		try {
			await access(target).then(
				() => { throw new Error(`refusing to overwrite ${target}`); },
				() => undefined,
			);
			await writeFile(target, `${formatTranscript(this.state)}\n`, { flag: "wx" });
			this.appendNotice(`Transcript exported to ${target}`);
		} catch (error) {
			this.appendNotice(error instanceof Error ? error.message : "transcript export failed");
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

	private statusIndicator(): string {
		if (this.connectionStatus !== "connected") return theme.warn("●");
		switch (this.state.status) {
			case "failed":
			case "disconnected":
				return theme.err("●");
			case "running":
			case "cancelling":
			case "connecting":
				return theme.warn("●");
			default:
				return theme.ok("●");
		}
	}

	private render(): void {
		this.statusText.setText(
			`${this.statusIndicator()} ${theme.muted(formatStatus(this.state, this.connectionStatus))}`,
		);
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
				this.bridgeStatusPlain = "Blender attached";
				this.bridgeText.setText(`${theme.ok("⚡")} Blender attached`);
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
			const message = `Blender attach: handoff ready (expires in ${Math.ceil(ticket.expiresInMs / 1_000)}s)`;
			this.bridgeStatusPlain = message;
			this.bridgeText.setText(theme.muted(message));
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
	const app = new DirectorTui(
		session,
		options.terminal,
		(signal) => reconnectController(options, signal),
		{ projectDirectory: options.projectDirectory, daemonArguments: options.daemonArguments },
	);
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
