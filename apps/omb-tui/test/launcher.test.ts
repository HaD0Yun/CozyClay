import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchDaemon, terminateDaemon, type LaunchedDaemon } from "../src/launcher.ts";

const launchId = "33333333-3333-4333-8333-333333333333";

async function writeStandIn(root: string, source: string): Promise<string> {
	const executable = path.join(root, "daemon-stand-in.mjs");
	await writeFile(executable, `#!/usr/bin/env node\n${source}`);
	await chmod(executable, 0o700);
	return realpath(executable);
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (true) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() >= deadline) throw new Error(`child process ${pid} was not reaped`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("termination escalates to SIGKILL and reaps a SIGTERM-ignoring daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-termination-"));
	const projectDirectory = path.join(root, "project");
	await mkdir(projectDirectory);
	const executable = await writeStandIn(
		root,
		`process.on("SIGTERM", () => {});
console.log(JSON.stringify({
  type: "omb_daemon_ready",
  protocol: 1,
  port: 12345,
  pid: process.pid,
  launch_id: "${launchId}",
  bearer_token: "${"B".repeat(43)}",
  expires_in_ms: 10000
}));
setInterval(() => {}, 1000);
`,
	);
	let pid: number | undefined;
	try {
		const daemon = await launchDaemon({
			projectDirectory,
			repositoryRoot: root,
			daemonArguments: ["--faux"],
			environment: { OMB_DAEMON_EXECUTABLE: executable, PATH: process.env.PATH },
		});
		pid = daemon.startup.pid;
		await terminateDaemon(daemon.child);
		assert.equal(daemon.child.signalCode, "SIGKILL");
		await waitForProcessExit(pid);
	} finally {
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("abort during command discovery prevents spawning the daemon", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-pre-spawn-abort-"));
	const projectDirectory = path.join(root, "project");
	const marker = path.join(projectDirectory, "spawned");
	await mkdir(projectDirectory);
	const executable = await writeStandIn(root, `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(marker)}, "spawned");\n`);
	const abortController = new AbortController();
	try {
		const startedAt = Date.now();
		const launch = launchDaemon({
			projectDirectory,
			repositoryRoot: root,
			daemonArguments: ["--faux"],
			environment: { OMB_DAEMON_EXECUTABLE: executable, PATH: process.env.PATH },
			signal: abortController.signal,
		});
		queueMicrotask(() => abortController.abort());
		await assert.rejects(launch, /CONTROLLER_RECONNECT_ABORTED/);
		assert.ok(Date.now() - startedAt < 500, "pre-spawn abort should settle promptly");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await assert.rejects(readFile(marker), { code: "ENOENT" });
	} finally {
		abortController.abort();
		await rm(root, { recursive: true, force: true });
	}
});

test("faux daemon receives the exact closed child environment", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-environment-"));
	const projectDirectory = path.join(root, "project");
	const runtimeBaseDirectory = path.join(root, "runtime");
	const marker = path.join(root, "environment.json");
	await Promise.all([mkdir(projectDirectory), mkdir(runtimeBaseDirectory)]);
	const executable = await writeStandIn(
		root,
		`import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(marker)}, JSON.stringify(process.env));
console.log(JSON.stringify({ type: "omb_daemon_ready", protocol: 1, port: 12345, pid: process.pid, launch_id: "${launchId}", bearer_token: "${"B".repeat(43)}", expires_in_ms: 10000 }));
setInterval(() => {}, 1000);
`,
	);
	let daemon: LaunchedDaemon | undefined;
	try {
		daemon = await launchDaemon({
			projectDirectory,
			repositoryRoot: root,
			runtimeBaseDirectory,
			daemonArguments: ["--faux"],
			environment: {
				OMB_DAEMON_EXECUTABLE: executable,
				PATH: process.env.PATH,
				HOME: "/allowed/home",
				TMPDIR: "/unselected/tmp",
				XDG_RUNTIME_DIR: "/untrusted/xdg",
				ANTHROPIC_API_KEY: "must-not-leak",
				UNRELATED_SECRET: "must-not-leak",
			},
		});
		const environment = JSON.parse(await readFile(marker, "utf8")) as Record<string, string>;
		delete environment.__CF_USER_TEXT_ENCODING;
		assert.deepEqual(environment, {
			HOME: "/allowed/home",
			PATH: process.env.PATH,
			TMPDIR: runtimeBaseDirectory,
			TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
			XDG_RUNTIME_DIR: runtimeBaseDirectory,
		});
	} finally {
		if (daemon !== undefined) await terminateDaemon(daemon.child);
		await rm(root, { recursive: true, force: true });
	}
});

test("daemon launch rejects a relative runtime base directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "omb-tui-relative-runtime-"));
	const projectDirectory = path.join(root, "project");
	await mkdir(projectDirectory);
	const executable = await writeStandIn(root, "setInterval(() => {}, 1000);\n");
	try {
		await assert.rejects(
			launchDaemon({
				projectDirectory,
				repositoryRoot: root,
				runtimeBaseDirectory: "relative/runtime",
				daemonArguments: ["--faux"],
				environment: { OMB_DAEMON_EXECUTABLE: executable },
			}),
			/INVALID_ARGUMENT: runtime base directory must be absolute/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
