import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBootRuntime, parseBootArguments } from "../src/boot.ts";

const sentinel = "omb-sentinel-secret-DO-NOT-LOG";

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

test("G013 real-provider startup keeps the sentinel out of argv, stdout, stderr, and project files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omb-g013-"));
	const args = [
		"--import", new URL(import.meta.resolve("tsx")).pathname, new URL("../src/main.ts", import.meta.url).pathname,
		"--port", "0", "--provider", "anthropic", "--model", "claude-haiku-4-5",
	];
	const child = spawn(process.execPath, args, {
		cwd: directory,
		env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: sentinel },
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
