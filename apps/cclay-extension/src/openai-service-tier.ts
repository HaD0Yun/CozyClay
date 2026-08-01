import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	clampThinkingLevel,
	type Model,
	openAICodexResponsesApi,
	type OpenAICodexResponsesOptions,
	openAIResponsesApi,
	type OpenAIResponsesOptions,
	registerApiProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "openai-service-tier.json";
const STATUS_KEY = "openai-service-tier";
const SUPPORTED_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

type FastModeModel = Pick<Model<"openai-responses" | "openai-codex-responses">, "api" | "provider" | "id">;


export interface OpenAIServiceTierConfig {
	schema_version: 1;
	active: boolean;
}

export interface ReadOpenAIServiceTierConfigResult {
	active: boolean;
	warning?: string;
}

export function getOpenAIServiceTierConfigPath(cwd: string): string {
	return join(cwd, ".cclay", CONFIG_FILE_NAME);
}

export function parseOpenAIServiceTierConfig(value: unknown): OpenAIServiceTierConfig | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("active")) return undefined;
	if (record.schema_version !== 1 || typeof record.active !== "boolean") return undefined;
	return { schema_version: 1, active: record.active };
}

export async function readOpenAIServiceTierConfig(cwd: string): Promise<ReadOpenAIServiceTierConfigResult> {
	const path = getOpenAIServiceTierConfigPath(cwd);
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		const config = parseOpenAIServiceTierConfig(parsed);
		if (config) return { active: config.active };
		return { active: false, warning: "Fast mode configuration is invalid; fast mode is disabled." };
	} catch (error) {
		if (isMissingFileError(error)) return { active: false };
		return { active: false, warning: "Fast mode configuration could not be read; fast mode is disabled." };
	}
}

export async function writeOpenAIServiceTierConfig(cwd: string, active: boolean): Promise<void> {
	const path = getOpenAIServiceTierConfigPath(cwd);
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true });
	await writeFile(temporaryPath, `${JSON.stringify({ schema_version: 1, active })}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		try {
			await chmod(temporaryPath, 0o600);
		} catch (error) {
			if (!isUnsupportedPermissionError(error)) throw error;
		}
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export function isFastModeSupported(model: FastModeModel | undefined): boolean {
	return (
		model !== undefined &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses") &&
		(model.provider === "openai" || model.provider === "openai-codex") &&
		SUPPORTED_MODEL_IDS.has(model.id)
	);
}

export function withPriorityServiceTier<T extends OpenAIResponsesOptions | OpenAICodexResponsesOptions>(
	model: FastModeModel,
	options: T | undefined,
	active: boolean,
): T | (T & { serviceTier: "priority" }) | undefined {
	if (!active || !isFastModeSupported(model)) return options;
	return { ...options, serviceTier: "priority" } as T & { serviceTier: "priority" };
}

export function buildPrioritySimpleOptions(
	model: Model<"openai-responses" | "openai-codex-responses">,
	options: SimpleStreamOptions | undefined,
	active: boolean,
): (SimpleStreamOptions & (OpenAIResponsesOptions | OpenAICodexResponsesOptions)) | undefined {
	if (!active || !isFastModeSupported(model)) return undefined;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return {
		...options,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : undefined),
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
		serviceTier: "priority",
	};
}

export async function registerOpenAIServiceTier(pi: ExtensionAPI, cwd: string): Promise<void> {
	const persisted = await readOpenAIServiceTierConfig(cwd);
	let active = persisted.active;
	let startupWarning = persisted.warning;
	pi.registerFlag("fast", { description: "Enable OpenAI priority service tier", type: "boolean", default: false });

	const openAIResponses = openAIResponsesApi();
	const openAICodexResponses = openAICodexResponsesApi();
	registerApiProvider({
		api: "openai-responses",
		stream: (model, context, options) =>
			openAIResponses.stream(model, context, withPriorityServiceTier(model, options, active)),
		streamSimple: (model, context, options) => {
			const priorityOptions = buildPrioritySimpleOptions(model, options, active);
			return priorityOptions === undefined
				? openAIResponses.streamSimple(model, context, options)
				: openAIResponses.stream(model, context, priorityOptions);
		},
	});
	registerApiProvider({
		api: "openai-codex-responses",
		stream: (model, context, options) =>
			openAICodexResponses.stream(model, context, withPriorityServiceTier(model, options, active)),
		streamSimple: (model, context, options) => {
			const priorityOptions = buildPrioritySimpleOptions(model, options, active);
			return priorityOptions === undefined
				? openAICodexResponses.streamSimple(model, context, options)
				: openAICodexResponses.stream(model, context, priorityOptions);
		},
	});

	const updateStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		if (active && isFastModeSupported(ctx.model)) {
			ctx.ui.setStatus(STATUS_KEY, "Fast: priority");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const statusMessage = (model: FastModeModel | undefined): string => {
		if (!active) return "Fast mode is off.";
		return isFastModeSupported(model)
			? "Fast mode is on (OpenAI priority tier)."
			: "Fast mode is on, but the current model does not support the OpenAI priority tier.";
	};

	pi.registerCommand("fast", {
		description: "Set OpenAI priority tier: /fast [on|off|status]",
		getArgumentCompletions: () => ["on", "off", "status"].map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status" || action === "") {
				ctx.ui.notify(statusMessage(ctx.model), active && !isFastModeSupported(ctx.model) ? "warning" : "info");
				updateStatus(ctx);
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			active = action === "on";
			await writeOpenAIServiceTierConfig(cwd, active);
			ctx.ui.notify(statusMessage(ctx.model), active && !isFastModeSupported(ctx.model) ? "warning" : "info");
			updateStatus(ctx);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("fast") === true && !active) {
			active = true;
			await writeOpenAIServiceTierConfig(cwd, active);
		}
		if (startupWarning) {
			ctx.ui.notify(startupWarning, "warning");
			startupWarning = undefined;
		}
		if (active && !isFastModeSupported(ctx.model)) {
			ctx.ui.notify("Fast mode is on, but the current model does not support the OpenAI priority tier.", "warning");
		}
		updateStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isUnsupportedPermissionError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOSYS" || error.code === "EOPNOTSUPP" || error.code === "EPERM");
}
