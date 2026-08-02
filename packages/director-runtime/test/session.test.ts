import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildProjectManifest } from "@cclay/director-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseSceneSnapshot } from "../../blender-protocol/src/snapshot.ts";
import { createDirectorSession } from "../src/session.ts";

describe("director runtime session", () => {
	const unregister: Array<() => void> = [];
	afterEach(() => {
		while (unregister.length > 0) unregister.pop()?.();
	});

	it("calls inspect_project through a live bridge in a real AgentSession", async () => {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("scene inspected"),
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		const fixture = JSON.parse(
			await readFile(
				new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
				"utf8",
			),
		);
		const manifest = buildProjectManifest(parseSceneSnapshot(fixture));
		let calls = 0;
		const session = await createDirectorSession({
			bridge: {
				inspectProject: async () => {
					calls += 1;
					return manifest;
				},
				applyCameraPlan: async () => {
					throw new Error("not invoked");
				},
				stageScene: async () => {
					throw new Error("not invoked");
				},
			},
			model,
			modelRuntime,
		});
		assert.deepEqual(session.getActiveToolNames(), [
			"inspect_project",
			"read_image",
			"stage_scene",
			"apply_camera_plan",
		]);
		try {
			await session.prompt("inspect this Blender scene");
			assert.equal(calls, 1);
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			assert.match(JSON.stringify(toolResult), new RegExp(manifest.revision));
			assert.equal(session.messages.at(-1)?.role, "assistant");
		} finally {
			session.dispose();
		}
	});

	it("omits host-backed ARDY tools when no ARDY host bridge is configured and includes them when one is", async () => {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });

		const bridgeBase = {
			inspectProject: async () => {
				throw new Error("not invoked");
			},
		};

		const withoutHost = await createDirectorSession({ bridge: bridgeBase, model, modelRuntime });
		try {
			assert.deepEqual(withoutHost.getActiveToolNames(), ["inspect_project", "read_image"]);
		} finally {
			withoutHost.dispose();
		}

		const withHost = await createDirectorSession({
			bridge: {
				...bridgeBase,
				generate: async () => {
					throw new Error("not invoked");
				},
				inbetween: async () => {
					throw new Error("not invoked");
				},
			},
			model,
			modelRuntime,
		});
		try {
			assert.deepEqual(withHost.getActiveToolNames(), [
				"inspect_project",
				"read_image",
				"ardy_generate",
				"ardy_inbetween",
			]);
		} finally {
			withHost.dispose();
		}
	});

	it("leaves no temp agent directory behind after a session is disposed", async () => {
		// createDirectorSession mkdtemps an agentDir it owns. Disposal must remove
		// it, and so must any throw before the session takes ownership -- otherwise
		// every attempt leaves a directory in tmpdir. The failure half of that
		// contract is not reachable through this API: the only throws are internal
		// invariant guards that fire on a miswiring inside session.ts, so it is
		// covered by the try/catch there rather than by a test that would have to
		// corrupt the module to fire.
		// Point tmpdir at a private directory for the duration: other test files
		// create director sessions in parallel processes against the shared
		// system tmpdir, so a global count of agent directories is not stable.
		const previousTmp = process.env.TMPDIR;
		const isolated = mkdtempSync(join(tmpdir(), "cclay-session-test-"));
		process.env.TMPDIR = isolated;
		try {
			const faux = registerFauxProvider();
			unregister.push(faux.unregister);
			const credentials = new InMemoryCredentialStore();
			await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
			const session = await createDirectorSession({
				bridge: {
					inspectProject: async () => {
						throw new Error("not invoked");
					},
				},
				model,
				modelRuntime,
			});
			const owned = readdirSync(isolated).filter((entry) => entry.startsWith("cclay-director-agent-"));
			assert.equal(owned.length, 1, "expected the session to own exactly one temp agent directory");
			session.dispose();
			const leaked = readdirSync(isolated).filter((entry) => entry.startsWith("cclay-director-agent-"));
			assert.deepEqual(leaked, [], `dispose leaked temp agent directories: ${leaked.join(",")}`);
		} finally {
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});
