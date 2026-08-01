// FAILURE B regression: a parked `waitForAttach()` caller must keep the process
// alive, and an idle bridge must not.
//
// `scheduleReconnect()` is the only code path that can settle an attach waiter,
// and it used to unref its timer unconditionally. An unref'd timer does not hold
// the loop open, so a caller awaiting `waitForAttach()` in an otherwise idle
// process could be parked behind work Node had already decided it was free to
// stop doing. In CI this surfaced as node:test reporting "Promise resolution is
// still pending but the event loop has already resolved" on the first
// `bridge-reattach.test.ts` test that starts no FakeAddon and arms no ref'd
// timer, cancelling every test after it. It passed on macOS only because
// residual handles from the previous test's teardown happened to outlive the
// reconnect timer — which is why the in-suite tests cannot prove this and the
// assertion runs in a child process instead.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BlenderBridge } from "../src/bridge.ts";

const WAITER_FIXTURE = fileURLToPath(new URL("./fixtures/attach-waiter-entry.ts", import.meta.url));
const IDLE_FIXTURE = fileURLToPath(new URL("./fixtures/idle-bridge-entry.ts", import.meta.url));

interface ChildOutcome {
	readonly stdout: string;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** Runs a fixture to completion or kills it, reporting how it ended either way. */
function runFixture(fixture: string, project: string, timeoutMs: number): Promise<ChildOutcome> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			["--import", "tsx", fixture, project],
			{ timeout: timeoutMs, killSignal: "SIGKILL" },
			(error, stdout) => {
				const failure = error as (Error & { code?: number | null; signal?: NodeJS.Signals | null }) | null;
				if (failure !== null && failure.code === undefined && failure.signal === undefined) {
					reject(failure);
					return;
				}
				resolve({ stdout, code: failure?.code ?? 0, signal: failure?.signal ?? null });
			},
		);
		child.on("error", reject);
	});
}

test("a parked attach waiter keeps the process alive", async () => {
	// No .cclay directory: discovery is absent, which is the ordinary "Blender
	// has not opened yet" state, so the waiter legitimately never settles.
	const project = await mkdtemp(path.join(tmpdir(), "cclay-keepalive-"));
	try {
		const outcome = await runFixture(WAITER_FIXTURE, project, 4_000);
		assert.match(outcome.stdout, /^WAITER_PARKED$/m, "fixture never reached waitForAttach");
		assert.doesNotMatch(
			outcome.stdout,
			/^LOOP_DRAINED$/m,
			"the event loop drained while an attach waiter was still parked: waitForAttach() can never settle",
		);
		assert.equal(outcome.signal, "SIGKILL", "the process should have stayed alive until the harness killed it");
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("an idle bridge with no attach waiters still lets the process exit", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-keepalive-idle-"));
	try {
		const outcome = await runFixture(IDLE_FIXTURE, project, 8_000);
		assert.match(outcome.stdout, /^IDLE_STARTED$/m);
		assert.equal(outcome.signal, null, "an idle bridge must not hold the process open");
		assert.equal(outcome.code, 0);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("a waiter is settled by malformed discovery rather than parked forever", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-keepalive-stale-"));
	const bridge = new BlenderBridge(project);
	try {
		await mkdir(path.join(project, ".cclay"));
		await writeFile(path.join(project, ".cclay", "bridge-endpoint.json"), "{");
		await bridge.start();
		await assert.rejects(bridge.waitForAttach(), /ADDON_STALE/);
	} finally {
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("aborting the last waiter returns the bridge to an unref'd reconnect timer", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-keepalive-abort-"));
	const bridge = new BlenderBridge(project);
	try {
		await bridge.start();
		const controller = new AbortController();
		const waiting = assert.rejects(bridge.waitForAttach(controller.signal), /ATTACH_ABORTED/);
		controller.abort();
		await waiting;
		const timer = (bridge as unknown as { reconnectTimer?: { hasRef?: () => boolean } }).reconnectTimer;
		assert.equal(timer?.hasRef?.() ?? false, false, "no waiters remain, so the timer must not hold the loop open");
	} finally {
		await bridge.close();
		await rm(project, { recursive: true, force: true });
	}
});

test("close settles a pending waiter and clears the reconnect timer", async () => {
	const project = await mkdtemp(path.join(tmpdir(), "cclay-keepalive-close-"));
	const bridge = new BlenderBridge(project);
	try {
		await bridge.start();
		const waiting = assert.rejects(bridge.waitForAttach(), /BRIDGE_CLOSED/);
		await bridge.close();
		await waiting;
		assert.equal((bridge as unknown as { reconnectTimer?: unknown }).reconnectTimer, undefined);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
