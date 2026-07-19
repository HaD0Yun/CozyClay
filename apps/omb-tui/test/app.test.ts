import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { DirectorTui } from "../src/app.ts";
import { connectController, type BridgeAttachTicket, type ControllerSession } from "../src/controller.ts";

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

interface Handoff {
	readonly project_id: string;
	readonly ticket: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function websocketFrame(value: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(value));
	const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
	header[0] = 0x81;
	header[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
	let maskOffset = 2;
	if (payload.length >= 126) {
		header.writeUInt16BE(payload.length, 2);
		maskOffset = 4;
	}
	const mask = Buffer.from([3, 5, 7, 11]);
	mask.copy(header, maskOffset);
	const masked = Buffer.from(payload);
	for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index & 3]!;
	return Buffer.concat([header, masked]);
}

async function connectBridge(port: number, ticket: string): Promise<{ socket: Socket; status: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => {
			socket.write(
				`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nAuthorization: Bearer ${ticket}\r\nX-OMB-Role: bridge\r\n\r\n`,
			);
		});
		let response = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("bridge handshake timed out"));
		}, 2_000);
		socket.on("data", function handshake(chunk) {
			response += chunk.toString("latin1");
			const end = response.indexOf("\r\n\r\n");
			if (end === -1) return;
			clearTimeout(timer);
			socket.off("data", handshake);
			const status = response.slice(0, response.indexOf("\r\n"));
			resolve({ socket, status });
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitForHandoff(file: string, excludedTicket?: string): Promise<Handoff> {
	const deadline = Date.now() + 7_000;
	while (Date.now() < deadline) {
		try {
			const handoff = JSON.parse(await readFile(file, "utf8")) as Handoff;
			if (handoff.ticket !== excludedTicket) return handoff;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("attach handoff timed out");
}

test("real daemon bridge loss reissues a distinct one-use handoff and TUI teardown stops cadence", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-real-reissue-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	let pid: number | undefined;
	let app: DirectorTui | undefined;
	let running: Promise<void> | undefined;
	let bridge: Socket | undefined;
	try {
		const session = await connectController({
			projectDirectory,
			runtimeBaseDirectory,
			daemonArguments: ["--faux"],
			environment: { ...process.env, OMB_NODE_EXECUTABLE: process.execPath },
			repositoryRoot,
		});
		pid = session.pid;
		const terminal = new CapturingTerminal();
		app = new DirectorTui(session, terminal);
		running = app.run();
		const handoffFile = path.join(session.runtimeDirectory, "attach-handoff.json");
		const first = await waitForHandoff(handoffFile);
		assert.match(first.ticket, /^[A-Za-z0-9_-]{43}$/);

		const attached = await connectBridge(session.port, first.ticket);
		assert.match(attached.status, /^HTTP\/1\.1 101 /);
		bridge = attached.socket;
		bridge.write(websocketFrame({
			type: "hello",
			protocol: 2,
			addon_version: "bridge-integration-test",
			blender_version: "4.3",
			project_id: first.project_id,
			client_nonce: randomBytes(16).toString("base64url"),
			capabilities: ["mutation_bridge_v2"],
		}));
		const attachedDeadline = Date.now() + 1_000;
		while (!terminal.output.includes("Blender attached")) {
			if (Date.now() >= attachedDeadline) throw new Error("real bridge attachment was not observed");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await assert.rejects(access(handoffFile), { code: "ENOENT" });
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		await assert.rejects(access(handoffFile), { code: "ENOENT" });

		bridge.destroy();
		bridge = undefined;
		const replacement = await waitForHandoff(handoffFile, first.ticket);
		assert.notEqual(replacement.ticket, first.ticket, "bridge loss must cause observable ticket reissue");

		const reattached = await connectBridge(session.port, replacement.ticket);
		assert.match(reattached.status, /^HTTP\/1\.1 101 /);
		bridge = reattached.socket;
		bridge.write(websocketFrame({
			type: "hello",
			protocol: 2,
			addon_version: "bridge-integration-test",
			blender_version: "4.3",
			project_id: replacement.project_id,
			client_nonce: randomBytes(16).toString("base64url"),
			capabilities: ["mutation_bridge_v2"],
		}));
		await assert.rejects(access(handoffFile), { code: "ENOENT" });
		const replay = await connectBridge(session.port, replacement.ticket);
		assert.doesNotMatch(replay.status, /^HTTP\/1\.1 101 /);
		replay.socket.destroy();

		await app.exit();
		await running;
		app = undefined;
		bridge.destroy();
		bridge = undefined;
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		await assert.rejects(access(handoffFile), { code: "ENOENT" });
	} finally {
		bridge?.destroy();
		if (app !== undefined) {
			await app.exit();
			await running;
		}
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
		await rm(root, { recursive: true, force: true });
	}
});
