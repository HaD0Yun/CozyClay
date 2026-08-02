import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildProjectManifest } from "@cclay/director-core";
import { type ArdyGenerateQueueOutcomeV1, parseSceneSnapshot } from "@cclay/protocol";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

	it("omits the host-backed ARDY tools without a configured ARDY host and includes them with one", async () => {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });

		// Both bridges are present in BOTH sessions: only the injected
		// availability signal differs, so an omission below is the host gate,
		// not the absent-bridge mechanism. The signal is injected rather than
		// read from the ambient environment, so the outcome does not depend on
		// the machine the test runs on.
		const bridge = {
			inspectProject: async () => {
				throw new Error("not invoked");
			},
			generate: async () => {
				throw new Error("not invoked");
			},
			inbetween: async () => {
				throw new Error("not invoked");
			},
		};

		const withoutHost = await createDirectorSession({
			bridge,
			model,
			modelRuntime,
			ardyHostConfigured: false,
		});
		try {
			// createDirectorSession throws when a construction guard fails, so
			// a clean construction is itself the guard-pass assertion.
			assert.deepEqual(withoutHost.getActiveToolNames(), ["inspect_project", "read_image"]);
		} finally {
			withoutHost.dispose();
		}

		const withHost = await createDirectorSession({
			bridge,
			model,
			modelRuntime,
			ardyHostConfigured: true,
		});
		try {
			// Both names appear in catalog order: the allowlist subsequence
			// the constructed set is derived from.
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

	it("drives ardy_generate end to end through the assembled session when an ARDY host is configured", async () => {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		const requestId = "0123456789abcdef0123456789abcdef";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ardy_generate", {
					request_id: requestId,
					entity_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
					expected_revision_id: "a".repeat(64),
					prompt: "a person waves both hands",
					duration_seconds: 5,
					seed: null,
					requested_at_ms: 1_700_000_000_000,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("generated"),
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });

		// Annotated rather than inferred: a bare literal widens schema_version to
		// `number`, which does not satisfy the closed outcome's `1` literal.
		const outcome: ArdyGenerateQueueOutcomeV1 = {
			schema_version: 1,
			request_id: requestId,
			status: "succeeded" as const,
			result: {
				schema_version: 1,
				request_id: requestId,
				motion_id: "wave-hands-01",
				frames: 100,
				duration_seconds: 5,
				seed: null,
			},
			resulting_revision_id: "b".repeat(64),
		};
		let bridgeCalls = 0;
		const session = await createDirectorSession({
			bridge: {
				inspectProject: async () => {
					throw new Error("not invoked");
				},
				generate: async (request) => {
					bridgeCalls += 1;
					assert.equal(request.request_id, requestId, "the tool must forward the model's request verbatim");
					return outcome;
				},
				inbetween: async () => {
					throw new Error("not invoked");
				},
			},
			model,
			modelRuntime,
			ardyHostConfigured: true,
		});
		try {
			await session.prompt("generate a wave");
			assert.equal(bridgeCalls, 1, "the bridge must have been driven exactly once");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			assert.ok(toolResult !== undefined, "the tool result must reach the session messages");
			const serialized = JSON.stringify(toolResult);
			assert.match(serialized, /wave-hands-01/, "the outcome's motion_id must reach the caller");
			assert.match(
				serialized,
				new RegExp("b".repeat(64)),
				"the outcome's resulting_revision_id must reach the caller",
			);
			assert.equal(session.messages.at(-1)?.role, "assistant");
		} finally {
			session.dispose();
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
