import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Model, OpenAIResponsesOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	buildPrioritySimpleOptions,
	getOpenAIServiceTierConfigPath,
	isFastModeSupported,
	parseOpenAIServiceTierConfig,
	readOpenAIServiceTierConfig,
	withPriorityServiceTier,
	writeOpenAIServiceTierConfig,
} from "../src/openai-service-tier.ts";

function model(
	api: "openai-responses" | "openai-codex-responses",
	provider: string,
	id: string,
): Pick<Model<"openai-responses" | "openai-codex-responses">, "api" | "provider" | "id"> {
	return { api, provider, id } as Pick<Model<"openai-responses" | "openai-codex-responses">, "api" | "provider" | "id">;
}

function completeModel<TApi extends "openai-responses" | "openai-codex-responses">(
	api: TApi,
	provider: "openai" | "openai-codex",
	id: string,
): Model<TApi> {
	return {
		api,
		provider,
		id,
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		contextWindow: 128_000,
		maxTokens: 32_000,
	};
}

describe("OpenAI service tier configuration", () => {
	it("accepts only the closed versioned configuration shape", () => {
		assert.deepEqual(parseOpenAIServiceTierConfig({ schema_version: 1, active: true }), {
			schema_version: 1,
			active: true,
		});
		assert.equal(parseOpenAIServiceTierConfig({ schema_version: 1, active: true, extra: false }), undefined);
		assert.equal(parseOpenAIServiceTierConfig({ schema_version: 2, active: true }), undefined);
		assert.equal(parseOpenAIServiceTierConfig({ schema_version: 1, active: "true" }), undefined);
		assert.equal(parseOpenAIServiceTierConfig([]), undefined);
	});

	it("persists and reads the active state atomically through its project-local path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cclay-fast-"));
		try {
			await writeOpenAIServiceTierConfig(cwd, true);
			assert.deepEqual(await readOpenAIServiceTierConfig(cwd), { active: true });
			assert.deepEqual(JSON.parse(await readFile(getOpenAIServiceTierConfigPath(cwd), "utf8")), {
				schema_version: 1,
				active: true,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed when the project configuration is malformed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cclay-fast-"));
		try {
			await writeOpenAIServiceTierConfig(cwd, false);
			await writeFile(getOpenAIServiceTierConfigPath(cwd), "not json", { encoding: "utf8" });
			const result = await readOpenAIServiceTierConfig(cwd);
			assert.equal(result.active, false);
			assert.match(result.warning ?? "", /disabled/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("OpenAI fast mode resolution", () => {
	it("supports only approved OpenAI transport, provider, and model combinations", () => {
		assert.equal(isFastModeSupported(model("openai-codex-responses", "openai-codex", "gpt-5.6-sol")), true);
		assert.equal(isFastModeSupported(model("openai-responses", "openai", "gpt-5.5")), true);
		assert.equal(isFastModeSupported(model("openai-responses", "openai", "gpt-5.3")), false);
		assert.equal(isFastModeSupported(model("openai-responses", "openrouter", "gpt-5.6-sol")), false);
	});

	it("preserves incoming options and injects priority only while enabled for a supported model", () => {
		const options: OpenAIResponsesOptions = {
			apiKey: "key",
			headers: { "x-test": "preserved" },
			reasoningEffort: "high",
		};
		const supported = model("openai-responses", "openai", "gpt-5.6-terra");
		const enabled = withPriorityServiceTier(supported, options, true);
		assert.deepEqual(enabled, { ...options, serviceTier: "priority" });
		assert.notEqual(enabled, options);
		assert.equal(withPriorityServiceTier(supported, options, false), options);
		assert.equal(withPriorityServiceTier(model("openai-responses", "openai", "gpt-5.3"), options, true), options);
	});

	it("converts simple-stream options to priority full options without dropping request controls", () => {
		const model = completeModel("openai-codex-responses", "openai-codex", "gpt-5.6-sol");
		const options: SimpleStreamOptions = {
			apiKey: "key",
			reasoning: "high",
			headers: { "x-test": "preserved" },
			sessionId: "session",
			maxTokens: 4096,
		};

		assert.deepEqual(buildPrioritySimpleOptions(model, options, true), {
			apiKey: "key",
			reasoning: "high",
			headers: { "x-test": "preserved" },
			sessionId: "session",
			maxTokens: 4096,
			reasoningEffort: "high",
			serviceTier: "priority",
		});
		assert.equal(buildPrioritySimpleOptions(model, options, false), undefined);
	});
});
