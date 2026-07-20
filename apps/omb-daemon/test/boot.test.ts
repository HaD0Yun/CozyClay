import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBootRuntime, parseBootArguments } from "../src/boot.ts";

const sentinel = "omb-sentinel-secret-DO-NOT-LOG";
const tsconfigPath = new URL("../../../tsconfig.json", import.meta.url).pathname;
async function seedProject(directory: string): Promise<string> {
	const projectId = randomUUID();
	await mkdir(join(directory, ".omb"), { recursive: true });
	await writeFile(
		join(directory, ".omb", "project.json"),
		JSON.stringify({ schema_version: 1, project_id: projectId, current_revision_id: "0".repeat(64) }),
	);
	return projectId;
}

function clientTextFrame(value: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(value));
	const extendedBytes = payload.length < 126 ? 0 : payload.length <= 65_535 ? 2 : 8;
	const header = Buffer.alloc(2 + extendedBytes + 4);
	header[0] = 0x81;
	header[1] = 0x80 | (extendedBytes === 0 ? payload.length : extendedBytes === 2 ? 126 : 127);
	if (extendedBytes === 2) header.writeUInt16BE(payload.length, 2);
	if (extendedBytes === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
	const maskOffset = 2 + extendedBytes;
	header.fill(0x5a, maskOffset);
	const masked = Buffer.from(payload);
	for (let index = 0; index < masked.length; index++) masked[index] ^= 0x5a;
	return Buffer.concat([header, masked]);
}

function webSocketPayload(frame: Buffer, masked: boolean): Buffer {
	const lengthCode = frame[1]! & 0x7f;
	let payloadOffset = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
	if (!masked) return frame.subarray(payloadOffset);
	const mask = frame.subarray(payloadOffset, payloadOffset + 4);
	payloadOffset += 4;
	const payload = Buffer.from(frame.subarray(payloadOffset));
	for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3]!;
	return payload;
}

test("G013 requires an explicit real provider/model or explicit faux mode", () => {
	assert.throws(() => parseBootArguments(["--port", "0"]), /NOT_CONFIGURED/);
	assert.throws(() => parseBootArguments(["--faux", "--provider", "anthropic", "--model", "claude-haiku-4-5"]), /mutually exclusive/);
	assert.deepEqual(parseBootArguments(["--port", "0", "--faux"]), { port: 0, mode: "faux" });
	assert.throws(
		() => parseBootArguments(["--provider", "anthropic", "--model", "claude-haiku-4-5", "--api-key", sentinel]),
		/unsupported argument/,
	);
});

test("G013 rejects missing, empty, duplicate, and unsupported provider/model arguments", async () => {
	for (const argv of [
		["--provider", "anthropic"],
		["--model", "claude-haiku-4-5"],
		["--provider", "", "--model", "claude-haiku-4-5"],
		["--provider", "anthropic", "--model", ""],
		["--provider", "anthropic", "--provider", "openai", "--model", "claude-haiku-4-5"],
	]) assert.throws(() => parseBootArguments(argv), /NOT_CONFIGURED|must be supplied exactly once/);

	await assert.rejects(createBootRuntime(parseBootArguments(["--provider", "unknown", "--model", "x"]), {}), /UNSUPPORTED_PROVIDER/);
	await assert.rejects(createBootRuntime(parseBootArguments(["--provider", "anthropic", "--model", "unknown"]), {}), /UNSUPPORTED_MODEL/);
});
test("G013 rejects Azure OpenAI at boot because isolated endpoint configuration is unsupported", async () => {
	const boot = parseBootArguments(["--provider", "azure-openai-responses", "--model", "gpt-4"]);
	await assert.rejects(
		createBootRuntime(boot, { AZURE_OPENAI_API_KEY: sentinel }),
		/UNSUPPORTED_PROVIDER.*does not support isolated API-key boot/,
	);
});

test("G013 requires the provider-standard nonempty credential and never includes its value in diagnostics", async () => {
	const boot = parseBootArguments(["--provider", "anthropic", "--model", "claude-haiku-4-5"]);
	await assert.rejects(createBootRuntime(boot, {}), /MISSING_CREDENTIAL.*ANTHROPIC_API_KEY/);
	await assert.rejects(createBootRuntime(boot, { ANTHROPIC_API_KEY: "" }), /MISSING_CREDENTIAL.*ANTHROPIC_API_KEY/);
	try {
		await createBootRuntime(parseBootArguments(["--provider", "anthropic", "--model", "unknown"]), { ANTHROPIC_API_KEY: sentinel });
		assert.fail("expected unsupported model");
	} catch (error) {
		assert.doesNotMatch(String(error), new RegExp(sentinel));
	}
});

test("G013 loads a supported catalog model through an in-memory credential store without network access", async () => {
	const runtime = await createBootRuntime(
		parseBootArguments(["--provider", "anthropic", "--model", "claude-haiku-4-5"]),
		{ ANTHROPIC_API_KEY: sentinel },
	);
	try {
		assert.equal(runtime.model.provider, "anthropic");
		assert.equal(runtime.model.id, "claude-haiku-4-5");
		assert.equal(runtime.credentialEnvironmentVariable, "ANTHROPIC_API_KEY");
	} finally {
		await runtime.dispose();
	}
});

test("openai-codex boots through the isolated env with an OAuth access token as the credential", async () => {
	const boot = parseBootArguments(["--provider", "openai-codex", "--model", "gpt-5.6-sol"]);
	await assert.rejects(createBootRuntime(boot, {}), /MISSING_CREDENTIAL.*OPENAI_CODEX_ACCESS_TOKEN/);
	const runtime = await createBootRuntime(boot, { OPENAI_CODEX_ACCESS_TOKEN: sentinel });
	try {
		assert.equal(runtime.model.provider, "openai-codex");
		assert.equal(runtime.model.id, "gpt-5.6-sol");
		assert.equal(runtime.credentialEnvironmentVariable, "OPENAI_CODEX_ACCESS_TOKEN");
	} finally {
		await runtime.dispose();
	}
});

test("G013 real-provider startup keeps the sentinel out of argv, stdout, stderr, and project files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omb-g013-"));
	await seedProject(directory);
	const args = [
		"--import", new URL(import.meta.resolve("tsx")).pathname, new URL("../src/main.ts", import.meta.url).pathname,
		"--port", "0", "--provider", "anthropic", "--model", "claude-haiku-4-5",
	];
	const child = spawn(process.execPath, args, {
		cwd: directory,
		env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: tsconfigPath, ANTHROPIC_API_KEY: sentinel },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (bytes) => {
		stdout += bytes;
	});
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("startup timeout")), 5_000);
			child.stdout.once("data", () => {
				clearTimeout(timeout);
				resolve();
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				reject(new Error(`daemon exited during startup with ${code}`));
			});
		});
		assert.doesNotMatch(args.join(" "), new RegExp(sentinel));
		assert.doesNotMatch(stdout, new RegExp(sentinel));
		assert.doesNotMatch(stderr, new RegExp(sentinel));
		child.kill();
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		for (const relativePath of await readdir(directory, { recursive: true })) {
			const path = join(directory, relativePath);
			if ((await stat(path)).isFile()) {
				assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(sentinel));
			}
		}
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(directory, { recursive: true, force: true });
	}
});

test("G013 faux daemon keeps credentials out of every real WebSocket frame", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omb-g013-websocket-"));
	const projectId = await seedProject(directory);
	const snapshot = JSON.parse(
		await readFile(
			new URL("../../../packages/blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	const args = [
		"--import", new URL(import.meta.resolve("tsx")).pathname, new URL("../src/main.ts", import.meta.url).pathname,
		"--port", "0", "--faux",
	];
	const child = spawn(process.execPath, args, {
		cwd: directory,
		env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: tsconfigPath, ANTHROPIC_API_KEY: sentinel },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let socket: Socket | undefined;
	let stderr = "";
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	try {
		const startup = await new Promise<Record<string, unknown>>((resolve, reject) => {
			let stdout = "";
			const timeout = setTimeout(() => reject(new Error("startup timeout")), 5_000);
			child.stdout.on("data", (bytes) => {
				stdout += bytes;
				const newline = stdout.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timeout);
				resolve(JSON.parse(stdout.slice(0, newline)));
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				reject(new Error(`daemon exited during startup with ${code}: ${stderr}`));
			});
		});
		const port = startup.port;
		const bearerToken = startup.bearer_token;
		if (typeof port !== "number" || typeof bearerToken !== "string") {
			throw new Error("invalid startup record");
		}

		let handshakeBuffer = Buffer.alloc(0);
		const connected = await new Promise<{ readonly socket: Socket; readonly trailing: Buffer }>((resolve, reject) => {
			const candidate = connect(port, "127.0.0.1", () => {
				candidate.write(
					`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					`Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
					`Authorization: Bearer ${bearerToken}\r\n\r\n`,
				);
			});
			const onData = (bytes: Buffer) => {
				handshakeBuffer = Buffer.concat([handshakeBuffer, bytes]);
				const end = handshakeBuffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				candidate.off("data", onData);
				const headers = handshakeBuffer.subarray(0, end + 4).toString("latin1");
				if (!headers.startsWith("HTTP/1.1 101 Switching Protocols")) {
					candidate.destroy();
					reject(new Error(headers.split("\r\n", 1)[0]));
					return;
				}
				resolve({ socket: candidate, trailing: handshakeBuffer.subarray(end + 4) });
			};
			candidate.on("data", onData);
			candidate.once("error", reject);
		});
		socket = connected.socket;

		const daemonInboundFrames: Buffer[] = [];
		const daemonOutboundFrames: Buffer[] = [];
		const messages: Record<string, unknown>[] = [];
		let serverBuffer = Buffer.alloc(0);
		const consumeServerFrames = (bytes: Buffer) => {
			serverBuffer = Buffer.concat([serverBuffer, bytes]);
			while (serverBuffer.length >= 2) {
				let payloadLength = serverBuffer[1]! & 0x7f;
				let payloadOffset = 2;
				if (payloadLength === 126) {
					if (serverBuffer.length < 4) return;
					payloadLength = serverBuffer.readUInt16BE(2);
					payloadOffset = 4;
				} else if (payloadLength === 127) {
					if (serverBuffer.length < 10) return;
					payloadLength = Number(serverBuffer.readBigUInt64BE(2));
					payloadOffset = 10;
				}
				const frameLength = payloadOffset + payloadLength;
				if (serverBuffer.length < frameLength) return;
				const frame = Buffer.from(serverBuffer.subarray(0, frameLength));
				serverBuffer = serverBuffer.subarray(frameLength);
				daemonOutboundFrames.push(frame);
				if ((frame[0]! & 0x0f) === 1) {
					const parsed: unknown = JSON.parse(frame.subarray(payloadOffset).toString("utf8"));
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						messages.push(parsed as Record<string, unknown>);
					}
				}
			}
		};
		socket.on("data", consumeServerFrames);
		if (connected.trailing.length > 0) consumeServerFrames(connected.trailing);

		const send = (value: unknown) => {
			const frame = clientTextFrame(value);
			daemonInboundFrames.push(frame);
			socket?.write(frame);
		};
		const nextMessage = async (predicate: (message: Record<string, unknown>) => boolean) => {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const message = messages.find(predicate);
				if (message !== undefined) return message;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error("WebSocket message timeout");
		};

		send({
			type: "hello",
			protocol: 1,
			addon_version: "test",
			blender_version: "4.3",
			project_id: projectId,
			client_nonce: Buffer.alloc(16, 7).toString("base64url"),
		});
		await nextMessage((message) => message.type === "hello_ack");

		const requestId = randomUUID();
		send({
			type: "request",
			id: requestId,
			method: "inspect_project",
			params: { snapshot },
			expected_revision_id: "be8b5bc1f52ad393d57e7b37242909fa5d30e161ca44741d604b8ac9777dee48",
			deadline_ms: 5_000,
		});
		const response = await nextMessage((message) => message.type === "response" && message.id === requestId);
		assert.equal(response.resulting_revision_id, "be8b5bc1f52ad393d57e7b37242909fa5d30e161ca44741d604b8ac9777dee48");

		send({ type: "shutdown", reason: "test_complete" });
		await nextMessage((message) => message.type === "shutdown_ack");
		if (child.exitCode === null) {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("daemon shutdown timeout")), 5_000);
				child.once("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}

		assert.ok(daemonInboundFrames.length >= 3);
		assert.ok(daemonOutboundFrames.length >= 3);
		assert.equal(serverBuffer.length, 0);
		for (const frame of daemonInboundFrames) {
			assert.equal(webSocketPayload(frame, true).includes(sentinel), false);
		}
		for (const frame of daemonOutboundFrames) {
			assert.equal(webSocketPayload(frame, false).includes(sentinel), false);
		}
		assert.doesNotMatch(stderr, new RegExp(sentinel));
	} finally {
		socket?.destroy();
		if (child.exitCode === null) child.kill();
		await rm(directory, { recursive: true, force: true });
	}
});
test("main refuses missing, corrupt, and invalid project state before listening", async () => {
	const cases = [
		{ name: "missing", contents: undefined },
		{ name: "corrupt", contents: "{" },
		{
			name: "invalid",
			contents: JSON.stringify({
				schema_version: 1,
				project_id: "not-a-uuid",
				current_revision_id: "0".repeat(64),
			}),
		},
	] as const;
	for (const failure of cases) {
		const directory = await mkdtemp(join(tmpdir(), `omb-project-${failure.name}-`));
		try {
			if (failure.contents !== undefined) {
				await mkdir(join(directory, ".omb"), { recursive: true });
				await writeFile(join(directory, ".omb", "project.json"), failure.contents);
			}
			const child = spawn(
				process.execPath,
				[
					"--import",
					new URL(import.meta.resolve("tsx")).pathname,
					new URL("../src/main.ts", import.meta.url).pathname,
					"--port",
					"0",
					"--faux",
				],
				{
					cwd: directory,
					env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: tsconfigPath },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (bytes) => {
				stdout += bytes;
			});
			child.stderr.on("data", (bytes) => {
				stderr += bytes;
			});
			const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
			assert.equal(exitCode, 1);
			assert.equal(stdout, "");
			assert.equal(stderr, "PROJECT_CONFIGURATION_ERROR: project is unavailable\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
