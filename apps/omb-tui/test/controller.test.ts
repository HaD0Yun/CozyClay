import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectController } from "../src/controller.ts";
import { controllerCredentialPath, defaultRuntimeBaseDirectory, discoverControllers } from "../src/discovery.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function processIsAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function waitForController(projectDirectory: string, runtimeBaseDirectory: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const controllers = await discoverControllers({ projectDirectory, runtimeBaseDirectory });
		if (controllers.length > 0) return controllers[0]!;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("controller discovery timed out");
}

test("real daemon spawn, detach, discovery reattach, and TUI exit preserve the daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-test-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	let spawnedPid: number | undefined;
	try {
		const first = await connectController({
			projectDirectory,
			runtimeBaseDirectory,
			daemonArguments: ["--faux"],
			environment: {
				...process.env,
				OMB_NODE_EXECUTABLE: process.execPath,
				TMPDIR: runtimeBaseDirectory,
			},
			repositoryRoot,
		});
		spawnedPid = first.pid;
		assert.equal(first.connectionKind, "spawned");
		assert.equal(await processIsAlive(first.pid), true);
		const credentialPath = controllerCredentialPath(first.runtimeDirectory);
		await access(credentialPath);
		const persisted = await readFile(credentialPath, "utf8");
		assert.equal(persisted.includes(first.resumeToken), true);
		assert.equal(credentialPath.startsWith(path.join(projectDirectory, ".omb")), false);
		const attach = await first.issueBridgeTicket();
		assert.equal(attach.runtimeDirectory, first.runtimeDirectory);
		assert.match(attach.ticket, /^[A-Za-z0-9_-]{43}$/);

		await first.disconnect();
		assert.equal(await processIsAlive(first.pid), true, "controller exit must not signal the daemon");

		const resumed = await connectController({
			projectDirectory,
			runtimeBaseDirectory,
			daemonArguments: ["--faux"],
			environment: {
				...process.env,
				OMB_NODE_EXECUTABLE: process.execPath,
				TMPDIR: runtimeBaseDirectory,
			},
			repositoryRoot,
		});
		assert.equal(resumed.connectionKind, "attached");
		assert.equal(resumed.pid, first.pid);
		assert.equal(await resumed.ping("reattached"), "reattached");
		await resumed.shutdown();
	} finally {
		if (spawnedPid !== undefined && await processIsAlive(spawnedPid)) process.kill(spawnedPid, "SIGTERM");
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime base selection rejects relative candidates and always returns an absolute path", () => {
	const absoluteTmp = path.join(path.parse(process.cwd()).root, "selected-tmp");
	assert.equal(
		defaultRuntimeBaseDirectory({ XDG_RUNTIME_DIR: "relative-xdg", TMPDIR: absoluteTmp }),
		absoluteTmp,
		"a relative XDG candidate must fall through to the next absolute candidate",
	);
	const fallback = defaultRuntimeBaseDirectory({ XDG_RUNTIME_DIR: "relative-xdg", TMPDIR: "relative-tmp" });
	assert.equal(path.isAbsolute(fallback), true, "platform fallback must be absolute");
	assert.notEqual(fallback, "relative-tmp");
});
test("XDG runtime resolution and daemon advertisement use the same directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-xdg-test-"));
	const projectDirectory = path.join(root, "project");
	const xdgRuntimeDirectory = path.join(root, "xdg");
	const tmpDirectory = path.join(root, "tmp");
	await Promise.all([mkdir(projectDirectory), mkdir(xdgRuntimeDirectory), mkdir(tmpDirectory)]);
	const environment = {
		...process.env,
		OMB_NODE_EXECUTABLE: process.execPath,
		XDG_RUNTIME_DIR: xdgRuntimeDirectory,
		TMPDIR: tmpDirectory,
	};
	let spawnedPid: number | undefined;
	try {
		assert.equal(defaultRuntimeBaseDirectory(environment), xdgRuntimeDirectory);
		const session = await connectController({
			projectDirectory,
			daemonArguments: ["--faux"],
			environment,
			repositoryRoot,
		});
		spawnedPid = session.pid;
		assert.equal(session.runtimeDirectory.startsWith(path.join(xdgRuntimeDirectory, "omb-")), true);
		assert.equal((await discoverControllers({
			projectDirectory,
			runtimeBaseDirectory: xdgRuntimeDirectory,
		})).length, 1);
		assert.equal((await discoverControllers({
			projectDirectory,
			runtimeBaseDirectory: tmpDirectory,
		})).length, 0);
		await session.shutdown();
	} finally {
		if (spawnedPid !== undefined && await processIsAlive(spawnedPid)) process.kill(spawnedPid, "SIGTERM");
		await rm(root, { recursive: true, force: true });
	}
});
test("SIGHUP exits the real TUI process without killing its detached daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-signal-test-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
	const child = spawn(
		process.execPath,
		["--import", tsxLoader, path.join(repositoryRoot, "apps/omb-tui/src/main.ts"), "--faux"],
		{
			cwd: projectDirectory,
			env: {
				...process.env,
				OMB_NODE_EXECUTABLE: process.execPath,
				TMPDIR: runtimeBaseDirectory,
				TSX_TSCONFIG_PATH: path.join(repositoryRoot, "tsconfig.json"),
			},
			stdio: "ignore",
		},
	);
	let daemonPid: number | undefined;
	try {
		const advertised = await waitForController(projectDirectory, runtimeBaseDirectory);
		daemonPid = advertised.pid;
		await new Promise((resolve) => setTimeout(resolve, 100));
		const exited = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("TUI did not exit after SIGHUP")), 3_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		child.kill("SIGHUP");
		await exited;
		assert.equal(await processIsAlive(advertised.pid), true);

		const resumed = await connectController({
			projectDirectory,
			runtimeBaseDirectory,
			daemonArguments: ["--faux"],
			environment: {
				...process.env,
				OMB_NODE_EXECUTABLE: process.execPath,
				TMPDIR: runtimeBaseDirectory,
			},
			repositoryRoot,
		});
		assert.equal(resumed.connectionKind, "attached");
		assert.equal(await resumed.ping("signal-reattach"), "signal-reattach");
		await resumed.shutdown();
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		if (daemonPid !== undefined && await processIsAlive(daemonPid)) process.kill(daemonPid, "SIGTERM");
		await rm(root, { recursive: true, force: true });
	}
});
