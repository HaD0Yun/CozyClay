import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { buildProjectManifest } from "@cclay/director-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseSceneSnapshot } from "../../blender-protocol/src/snapshot.ts";
import {
	createDirectorTurnLoop,
	type DirectorTurnPublication,
	DirectorTurnPublicationError,
} from "../src/turn-loop.ts";

/**
 * Frozen daemon integration contract: `createDirectorTurnHandler().run` accepts
 * one `DirectorTurnPublicationCallback`. It receives camel-case `text_delta`,
 * `assistant_utterance`, `started`, and `finished` publications. Calls are
 * strictly serial; each returned promise covers persistence and broadcast, and
 * run settlement is the terminal barrier: the daemon may append its terminal
 * event only after run settles. Rejected callbacks stop all later publications
 * and surface as `DirectorTurnPublicationError`.
 */

const SENTINEL = "SENTINEL_PARTIAL_PROVIDER_METADATA_MUST_NOT_LEAK";
const TURN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_REVISION = "b".repeat(64);

async function initialManifest() {
	const fixture = JSON.parse(
		await readFile(
			new URL("../../blender-protocol/test/fixtures/blender-exported-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	return buildProjectManifest(parseSceneSnapshot(fixture));
}

describe("director runtime streaming adapter", () => {
	const unregister: Array<() => void> = [];
	afterEach(() => {
		while (unregister.length > 0) unregister.pop()?.();
	});

	async function runtime(
		responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0],
		tokenSize = 1_024,
	) {
		const faux = registerFauxProvider({ tokenSize: { min: tokenSize, max: tokenSize } });
		unregister.push(faux.unregister);
		faux.setResponses(responses);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		return { model, modelRuntime };
	}

	async function loopFor(
		responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0],
		tokenSize?: number,
	) {
		const initial = await initialManifest();
		const configured = await runtime(responses, tokenSize);
		const loop = createDirectorTurnLoop({
			...configured,
			bridge: {
				inspectProject: async () => initial,
				stageScene: async () => ({
					resulting_revision_id: CHILD_REVISION,
					entity_identities: [],
					applied_hand_shapes: [],
				}),
				applyCameraPlan: async () => ({ resulting_revision_id: CHILD_REVISION }),
				renderQaFrames: async () => ({
					schema_version: 1,
					expected_revision_id: initial.revision,
					profile_version: "cclay-qa-png-v1",
					frames: [],
				}),
			},
		});
		return { initial, loop };
	}

	it("publishes only sanitized text fields in text/tool/text order before the terminal barrier", async () => {
		const poisonedFirst = {
			...fauxAssistantMessage(
				[
					fauxThinking(SENTINEL),
					fauxText("before tool one"),
					fauxText("before tool two"),
					fauxToolCall("inspect_project", {}),
				],
				{ stopReason: "toolUse", responseId: SENTINEL },
			),
			errorMessage: SENTINEL,
		};
		const { initial, loop } = await loopFor([
			poisonedFirst,
			fauxAssistantMessage([fauxText("after tool"), fauxToolCall("inspect_project", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("complete"),
		]);
		const publications: DirectorTurnPublication[] = [];
		let callbacksInFlight = 0;
		let maxCallbacksInFlight = 0;
		try {
			const result = await loop.run({
				turnId: TURN_ID,
				prompt: "inspect twice",
				expectedRevisionId: initial.revision,
				signal: new AbortController().signal,
				onPublication: async (publication) => {
					callbacksInFlight += 1;
					maxCallbacksInFlight = Math.max(maxCallbacksInFlight, callbacksInFlight);
					await new Promise((resolve) => setTimeout(resolve, 1));
					publications.push(publication);
					callbacksInFlight -= 1;
				},
			});
			const observedOrder = [...publications.map((publication) => publication.type), "terminal"];
			assert.deepEqual(observedOrder, [
				"text_delta",
				"assistant_utterance",
				"text_delta",
				"assistant_utterance",
				"started",
				"finished",
				"text_delta",
				"assistant_utterance",
				"started",
				"finished",
				"text_delta",
				"assistant_utterance",
				"terminal",
			]);
			assert.equal(maxCallbacksInFlight, 1);
			assert.equal(result.summary, "complete");
			assert.equal(JSON.stringify(publications).includes(SENTINEL), false);

			const deltas = publications.filter(
				(publication): publication is Extract<DirectorTurnPublication, { type: "text_delta" }> =>
					publication.type === "text_delta",
			);
			const utterances = publications.filter(
				(publication): publication is Extract<DirectorTurnPublication, { type: "assistant_utterance" }> =>
					publication.type === "assistant_utterance",
			);
			assert.deepEqual(
				deltas.map(({ turnId, contentIndex, deltaSequence, delta }) => ({
					turnId,
					contentIndex,
					deltaSequence,
					delta,
				})),
				[
					{ turnId: TURN_ID, contentIndex: 1, deltaSequence: 0, delta: "before tool one" },
					{ turnId: TURN_ID, contentIndex: 2, deltaSequence: 0, delta: "before tool two" },
					{ turnId: TURN_ID, contentIndex: 0, deltaSequence: 0, delta: "after tool" },
					{ turnId: TURN_ID, contentIndex: 0, deltaSequence: 0, delta: "complete" },
				],
			);
			assert.deepEqual(
				utterances.map(({ content, throughDeltaSequence }) => ({ content, throughDeltaSequence })),
				[
					{ content: "before tool one", throughDeltaSequence: 0 },
					{ content: "before tool two", throughDeltaSequence: 0 },
					{ content: "after tool", throughDeltaSequence: 0 },
					{ content: "complete", throughDeltaSequence: 0 },
				],
			);
			assert.equal(new Set(utterances.map((publication) => publication.segmentId)).size, 3);
			assert.equal(utterances[0]?.segmentId, utterances[1]?.segmentId);
			for (let index = 0; index < deltas.length; index += 1) {
				assert.equal(deltas[index]?.segmentId, utterances[index]?.segmentId);
			}
		} finally {
			loop.dispose();
		}
	});

	it("coalesces at the 2048-byte threshold and never emits an oversized delta", async () => {
		const content = "x".repeat(4_100);
		const { initial, loop } = await loopFor(
			[
				fauxAssistantMessage([fauxText(content), fauxToolCall("inspect_project", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			1,
		);
		const publications: DirectorTurnPublication[] = [];
		try {
			await loop.run({
				turnId: TURN_ID,
				prompt: "stream a large utterance",
				expectedRevisionId: initial.revision,
				signal: new AbortController().signal,
				onPublication: (publication) => {
					publications.push(publication);
				},
			});
			const deltas = publications.filter(
				(publication): publication is Extract<DirectorTurnPublication, { type: "text_delta" }> =>
					publication.type === "text_delta" && publication.contentIndex === 0,
			);
			assert.deepEqual(
				deltas.slice(0, 2).map((publication) => Buffer.byteLength(publication.delta)),
				[2_048, 2_048],
			);
			assert.ok(deltas.every((publication) => Buffer.byteLength(publication.delta) <= 4_096));
			assert.deepEqual(
				deltas.slice(0, 3).map((publication) => publication.deltaSequence),
				[0, 1, 2],
			);
			const utterance = publications.find(
				(publication): publication is Extract<DirectorTurnPublication, { type: "assistant_utterance" }> =>
					publication.type === "assistant_utterance" && publication.content === content,
			);
			assert.equal(utterance?.throughDeltaSequence, 2);
		} finally {
			loop.dispose();
		}
	});

	it("stops every later publication after the first callback failure", async () => {
		const { initial, loop } = await loopFor([
			fauxAssistantMessage([fauxText("persist me"), fauxToolCall("inspect_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("must not leak"), fauxToolCall("inspect_project", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("also must not leak"),
		]);
		const publications: DirectorTurnPublication[] = [];
		try {
			await assert.rejects(
				loop.run({
					turnId: TURN_ID,
					prompt: "fail transcript persistence",
					expectedRevisionId: initial.revision,
					signal: new AbortController().signal,
					onPublication: (publication) => {
						publications.push(publication);
						if (publication.type === "assistant_utterance") throw new Error("injected append failure");
					},
				}),
				DirectorTurnPublicationError,
			);
			assert.deepEqual(
				publications.map((publication) => publication.type),
				["text_delta", "assistant_utterance"],
			);
			assert.equal(JSON.stringify(publications).includes("must not leak"), false);
		} finally {
			loop.dispose();
		}
	});

	it("does not emit queued or timed publications after cancellation", async () => {
		const { initial, loop } = await loopFor(
			[
				fauxAssistantMessage([fauxText("x".repeat(8_192)), fauxToolCall("inspect_project", {})], {
					stopReason: "toolUse",
				}),
			],
			1,
		);
		const controller = new AbortController();
		const publications: DirectorTurnPublication[] = [];
		try {
			await assert.rejects(
				loop.run({
					turnId: randomUUID(),
					prompt: "cancel streaming",
					expectedRevisionId: initial.revision,
					signal: controller.signal,
					onPublication: (publication) => {
						publications.push(publication);
						controller.abort();
					},
				}),
			);
			const countAtSettlement = publications.length;
			await new Promise((resolve) => setTimeout(resolve, 75));
			assert.equal(publications.length, countAtSettlement);
			assert.equal(countAtSettlement, 1);
		} finally {
			loop.dispose();
		}
	});
});
