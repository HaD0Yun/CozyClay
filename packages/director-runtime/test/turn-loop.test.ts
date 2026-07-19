import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildProjectManifest } from "@oh-my-blender/director-core";
import type { CameraPlanV1, StageSceneRequestV1 } from "@oh-my-blender/protocol";
import { parseSceneSnapshot } from "../../blender-protocol/src/snapshot.ts";
import { createDirectorTurnLoop } from "../src/turn-loop.ts";

const CHILD_REVISION = "b".repeat(64);
const REPAIR_REVISION = "c".repeat(64);
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const IMAGE_BYTES = Buffer.from(IMAGE_DATA, "base64");
const ARTIFACT_DIGEST = createHash("sha256").update(IMAGE_BYTES).digest("hex");

const stageRequest = (revision: string): StageSceneRequestV1 => ({
	schema_version: 1,
	expected_revision_id: revision,
	operations: [
		{
			op: "add_primitive",
			primitive_type: "CUBE",
			name: "Hero",
			location: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
	],
});

const cameraPlan = (revision: string): CameraPlanV1 => ({
	schema_version: 1,
	expected_revision_id: revision,
	evidence_sha256: "e".repeat(64),
	output_format: { width: 640, height: 360 },
	keyframes: [
		{
			frame: 1,
			pose: { position: [0, -5, 2], look_at: [0, 0, 0], up: [0, 0, 1], vertical_fov_radians: 0.7 },
			transition: "smooth",
		},
	],
});

describe("bounded director turn loop", () => {
	const unregister: Array<() => void> = [];
	afterEach(() => {
		while (unregister.length > 0) unregister.pop()?.();
	});

	async function runtime(responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0]) {
		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		faux.setResponses(responses);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		return { model, modelRuntime };
	}

	async function initialManifest() {
		const fixture = JSON.parse(
			await readFile(
				new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
				"utf8",
			),
		);
		return buildProjectManifest(parseSceneSnapshot(fixture));
	}

	it("runs inspect, one primary mutation, inspect, QA, and one repair deterministically", async () => {
		const initial = await initialManifest();
		const stage = stageRequest(initial.revision);
		const repair = cameraPlan(CHILD_REVISION);
		const render = { schema_version: 1 as const, revision_id: CHILD_REVISION, frames: [1] };
		const configured = await runtime([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_scene", stage), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("render_qa_frames", render), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("apply_camera_plan", repair), { stopReason: "toolUse" }),
			fauxAssistantMessage("Built the hero scene, checked a QA frame, and repaired the camera."),
		]);
		const calls: string[] = [];
		let inspections = 0;
		const toolEvents: Array<{ type: string; toolName: string; digest?: string }> = [];
		const loop = createDirectorTurnLoop({
			...configured,
			bridge: {
				inspectProject: async () => {
					calls.push("inspect_project");
					inspections += 1;
					return inspections === 1 ? initial : { ...initial, revision: CHILD_REVISION };
				},
				stageScene: async () => {
					calls.push("stage_scene");
					return { resulting_revision_id: CHILD_REVISION, entity_identities: [] };
				},
				applyCameraPlan: async () => {
					calls.push("apply_camera_plan");
					return { resulting_revision_id: REPAIR_REVISION };
				},
				renderQaFrames: async () => {
					calls.push("render_qa_frames");
					return {
						schema_version: 1,
						revision_id: CHILD_REVISION,
						profile_version: "omb-qa-png-v1",
						frames: [
							{
								frame: 1,
								width: 640,
								height: 360,
								profile_version: "omb-qa-png-v1",
								byte_length: IMAGE_BYTES.byteLength,
								sha256: ARTIFACT_DIGEST,
								uri: `omb-artifact://sha256/${ARTIFACT_DIGEST}`,
								image: { mime_type: "image/png", data_base64: IMAGE_DATA },
							},
						],
					};
				},
			},
		});
		try {
			const result = await loop.run({
				prompt: "Build a hero product shot and correct the camera if QA needs it.",
				expectedRevisionId: initial.revision,
				signal: new AbortController().signal,
				onToolEvent: (event) => toolEvents.push(event),
			});
			assert.deepEqual(calls, [
				"inspect_project",
				"stage_scene",
				"inspect_project",
				"render_qa_frames",
				"apply_camera_plan",
			]);
			assert.equal(result.resultingRevisionId, REPAIR_REVISION);
			assert.match(result.summary, /hero scene/);
			assert.deepEqual(result.toolCallOrder, calls);
			assert.deepEqual(
				toolEvents.map((event) => event.type),
				[
					"started",
					"finished",
					"started",
					"finished",
					"started",
					"finished",
					"started",
					"finished",
					"started",
					"finished",
				],
			);
			assert.ok(
				toolEvents
					.filter((event) => event.type === "finished")
					.every((event) => /^[0-9a-f]{64}$/.test(event.digest ?? "")),
			);
		} finally {
			loop.dispose();
		}
	});

	it("fails closed when a model exceeds the one-repair budget", async () => {
		const initial = await initialManifest();
		const configured = await runtime([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_scene", stageRequest(initial.revision)), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("render_qa_frames", { schema_version: 1, revision_id: CHILD_REVISION, frames: [1] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("apply_camera_plan", cameraPlan(CHILD_REVISION)), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_scene", stageRequest(REPAIR_REVISION)), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		let inspections = 0;
		const loop = createDirectorTurnLoop({
			...configured,
			bridge: {
				inspectProject: async () => {
					inspections += 1;
					return inspections === 1 ? initial : { ...initial, revision: CHILD_REVISION };
				},
				stageScene: async () => ({ resulting_revision_id: CHILD_REVISION, entity_identities: [] }),
				applyCameraPlan: async () => ({ resulting_revision_id: REPAIR_REVISION }),
				renderQaFrames: async () => ({
					schema_version: 1,
					revision_id: CHILD_REVISION,
					profile_version: "omb-qa-png-v1",
					frames: [],
				}),
			},
		});
		try {
			await assert.rejects(
				loop.run({
					prompt: "overwork it",
					expectedRevisionId: initial.revision,
					signal: new AbortController().signal,
				}),
				/DIRECTOR_LOOP_REPAIR_BUDGET/,
			);
		} finally {
			loop.dispose();
		}
	});
	it("can run a second turn after cancelling a blocked tool", async () => {
		const initial = await initialManifest();
		const configured = await runtime([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_scene", stageRequest(initial.revision)), { stopReason: "toolUse" }),
			fauxAssistantMessage("cancelled"),
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Recovered on the second turn."),
		]);
		let inspections = 0;
		let stageStarted!: () => void;
		const stageStart = new Promise<void>((resolve) => {
			stageStarted = resolve;
		});
		const loop = createDirectorTurnLoop({
			...configured,
			bridge: {
				inspectProject: async () => {
					inspections += 1;
					return initial;
				},
				stageScene: async (_request, context) => {
					stageStarted();
					return new Promise((_resolve, reject) => {
						context.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
					});
				},
				applyCameraPlan: async () => ({ resulting_revision_id: CHILD_REVISION }),
				renderQaFrames: async () => ({
					schema_version: 1,
					revision_id: initial.revision,
					profile_version: "omb-qa-png-v1",
					frames: [],
				}),
			},
		});
		try {
			const controller = new AbortController();
			const first = loop.run({
				prompt: "start then block",
				expectedRevisionId: initial.revision,
				signal: controller.signal,
			});
			await stageStart;
			controller.abort();
			await assert.rejects(first);

			const second = await loop.run({
				prompt: "inspect and finish",
				expectedRevisionId: initial.revision,
				signal: new AbortController().signal,
			});
			assert.equal(second.summary, "Recovered on the second turn.");
			assert.equal(inspections, 3);
		} finally {
			loop.dispose();
		}
	});
	it("rejects a concurrent run while the initial session is being created", async () => {
		const initial = await initialManifest();
		const configured = await runtime([
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Initial turn completed."),
		]);
		const loop = createDirectorTurnLoop({
			...configured,
			bridge: {
				inspectProject: async () => initial,
				stageScene: async () => ({ resulting_revision_id: CHILD_REVISION, entity_identities: [] }),
				applyCameraPlan: async () => ({ resulting_revision_id: CHILD_REVISION }),
				renderQaFrames: async () => ({
					schema_version: 1,
					revision_id: initial.revision,
					profile_version: "omb-qa-png-v1",
					frames: [],
				}),
			},
		});
		try {
			const first = loop.run({
				prompt: "create the session",
				expectedRevisionId: initial.revision,
				signal: new AbortController().signal,
			});
			await assert.rejects(
				loop.run({
					prompt: "race session creation",
					expectedRevisionId: initial.revision,
					signal: new AbortController().signal,
				}),
				/DIRECTOR_LOOP_BUSY/,
			);
			assert.equal((await first).summary, "Initial turn completed.");
		} finally {
			loop.dispose();
		}
	});
});
