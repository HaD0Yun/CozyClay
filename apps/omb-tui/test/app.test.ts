import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { DirectorTui } from "../src/app.ts";
import type { BridgeAttachTicket, ControllerSession } from "../src/controller.ts";

class CapturingTerminal implements Terminal {
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;
	output = "";
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.output += data; }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class FakeControllerSession {
	readonly initialMessages = [];
	issueCount = 0;
	private bridgeListener: (attached: boolean) => void = () => {};
	private ticketResolvers: Array<(ticket: BridgeAttachTicket) => void> = [];
	onMessage(): () => void { return () => {}; }
	onDisconnect(): () => void { return () => {}; }
	onBridgeStatus(listener: (attached: boolean) => void): () => void {
		this.bridgeListener = listener;
		return () => { this.bridgeListener = () => {}; };
	}
	emitBridgeStatus(attached: boolean): void { this.bridgeListener(attached); }
	issueBridgeTicket(): Promise<BridgeAttachTicket> {
		this.issueCount++;
		return new Promise((resolve) => this.ticketResolvers.push(resolve));
	}
	resolveTicket(expiresInMs = 12_345): void {
		this.ticketResolvers.shift()?.({ runtimeDirectory: "/secret/runtime", ticket: "S".repeat(43), expiresInMs });
	}
	sendTurn(): string { return "22222222-2222-4222-8222-222222222222"; }
	cancel(): void {}
	async disconnect(): Promise<void> {}
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

test("bridge handoff reissues without overlap, tracks attachment, and stops on teardown", async () => {
	const session = new FakeControllerSession();
	const terminal = new CapturingTerminal();
	const app = new DirectorTui(session as unknown as ControllerSession, terminal);
	const running = app.run();

	session.emitBridgeStatus(false);
	assert.equal(session.issueCount, 1, "detached status must issue immediately");
	await new Promise((resolve) => setTimeout(resolve, 5_100));
	assert.equal(session.issueCount, 1, "a pending request must not overlap the five-second reissue");

	session.resolveTicket();
	await settle();
	assert.match(terminal.output, /Blender attach: handoff ready \(expires in 13s\)/);
	assert.doesNotMatch(terminal.output, /\/secret\/runtime|S{43}/);

	session.emitBridgeStatus(true);
	await settle();
	assert.match(terminal.output, /Blender attached/);
	session.emitBridgeStatus(false);
	assert.equal(session.issueCount, 2, "detaching again must resume with immediate issuance");
	session.resolveTicket();
	await settle();

	await app.exit();
	await running;
	const countAfterExit = session.issueCount;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(session.issueCount, countAfterExit, "teardown must stop ticket timers");
});
