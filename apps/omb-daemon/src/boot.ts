import { InMemoryCredentialStore, type Context, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES: Readonly<Record<string, string>> = {
	"ant-ling": "ANT_LING_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	huggingface: "HF_TOKEN",
	"kimi-coding": "KIMI_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	minimax: "MINIMAX_API_KEY",
	mistral: "MISTRAL_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	openai: "OPENAI_API_KEY",
	// OAuth access tokens (JWT with embedded account claim) pass through the
	// same isolated env boot; the Codex API extracts the account id from the JWT.
	"openai-codex": "OPENAI_CODEX_ACCESS_TOKEN",
	"opencode-go": "OPENCODE_API_KEY",
	opencode: "OPENCODE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	together: "TOGETHER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	xai: "XAI_API_KEY",
	"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
	zai: "ZAI_API_KEY",
};

export type BootArguments =
	| { readonly port: number; readonly mode: "faux" }
	| { readonly port: number; readonly mode: "provider"; readonly provider: string; readonly model: string };

export interface BootRuntime {
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly credentialEnvironmentVariable?: string;
	dispose(): Promise<void>;
}

function singleValue(argv: readonly string[], flag: string): string | undefined {
	const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
	if (indexes.length === 0) return undefined;
	if (indexes.length !== 1 || indexes[0] === argv.length - 1 || argv[indexes[0]! + 1]!.startsWith("--")) {
		throw new Error(`NOT_CONFIGURED: ${flag} must be supplied exactly once with a nonempty value`);
	}
	const value = argv[indexes[0]! + 1]!;
	if (value.trim() === "") throw new Error(`NOT_CONFIGURED: ${flag} must be supplied exactly once with a nonempty value`);
	return value;
}

export function parseBootArguments(argv: readonly string[]): BootArguments {
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--faux") continue;
		if (argument === "--port" || argument === "--provider" || argument === "--model") {
			index++;
			continue;
		}
		throw new Error("INVALID_ARGUMENT: unsupported argument; credentials must be supplied only through the environment");
	}
	const portValue = singleValue(argv, "--port");
	const port = portValue === undefined ? 0 : Number(portValue);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("INVALID_ARGUMENT: --port must be an integer from 0 through 65535");
	}
	const fauxCount = argv.filter((value) => value === "--faux").length;
	if (fauxCount > 1) throw new Error("NOT_CONFIGURED: --faux may be supplied only once");
	const provider = singleValue(argv, "--provider");
	const model = singleValue(argv, "--model");
	if (fauxCount === 1) {
		if (provider !== undefined || model !== undefined) {
			throw new Error("NOT_CONFIGURED: --faux and --provider/--model are mutually exclusive");
		}
		return { port, mode: "faux" };
	}
	if (provider === undefined || model === undefined) {
		throw new Error("NOT_CONFIGURED: explicit --provider <id> and --model <id> are required");
	}
	return { port, mode: "provider", provider, model };
}

function fauxResultRevision(details: unknown): string {
	if (typeof details !== "object" || details === null || Array.isArray(details)) {
		throw new Error("FAUX_SCENARIO_INVALID: tool result details are missing");
	}
	const value = details as Record<string, unknown>;
	for (const key of ["resulting_revision_id", "revision", "revision_id"]) {
		const revision = value[key];
		if (typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision)) return revision;
	}
	throw new Error("FAUX_SCENARIO_INVALID: tool result revision is missing");
}

function fauxScenarioResponse(context: Context) {
	let lastUserIndex = -1;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		if (context.messages[index]?.role === "user") {
			lastUserIndex = index;
			break;
		}
	}
	const current = context.messages.slice(lastUserIndex + 1);
	const toolResults = current.filter((message) => message.role === "toolResult");
	const user = context.messages[lastUserIndex];
	const prompt =
		user?.role === "user"
			? typeof user.content === "string"
				? user.content
				: user.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
			: "";

	if (prompt === "Inspect the current Blender project before directing it.") {
		return toolResults.length === 0
			? fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" })
			: fauxAssistantMessage("scene inspected");
	}

	switch (toolResults.length) {
		case 0:
			return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
		case 1: {
			const revision = fauxResultRevision(toolResults[0]!.details);
			return fauxAssistantMessage(
				fauxToolCall("stage_scene", {
					schema_version: 1,
					expected_revision_id: revision,
					operations: [
						{
							op: "add_primitive",
							primitive_type: "CUBE",
							name: "OMB Hero",
							location: [0, 0, 0],
							rotation: [0, 0, 0],
							scale: [1, 1, 1],
						},
					],
				}),
				{ stopReason: "toolUse" },
			);
		}
		case 2:
			return fauxAssistantMessage(fauxToolCall("inspect_project", {}), { stopReason: "toolUse" });
		case 3: {
			const revision = fauxResultRevision(toolResults[2]!.details);
			return fauxAssistantMessage(
				fauxToolCall("render_qa_frames", { schema_version: 1, revision_id: revision, frames: [1] }),
				{ stopReason: "toolUse" },
			);
		}
		case 4: {
			const revision = fauxResultRevision(toolResults[3]!.details);
			return fauxAssistantMessage(
				fauxToolCall("apply_camera_plan", {
					schema_version: 1,
					expected_revision_id: revision,
					evidence_sha256: "e".repeat(64),
					output_format: { width: 640, height: 360 },
					keyframes: [
						{
							frame: 0,
							pose: {
								position: [0, 2.15, 5.2],
								look_at: [0, 0.9, 0],
								up: [0, 1, 0],
								vertical_fov_radians: 0.47108996144172666,
							},
							transition: "smooth",
						},
						{
							frame: 79,
							pose: {
								position: [-0.38, 2.15, 5.88],
								look_at: [-0.38, 0.9, 0.88],
								up: [0, 1, 0],
								vertical_fov_radians: 0.47108996144172666,
							},
							transition: "smooth",
						},
					],
				}),
				{ stopReason: "toolUse" },
			);
		}
		default:
			return fauxAssistantMessage("Built the OMB hero scene, verified QA, and repaired the camera.");
	}
}

export async function createBootRuntime(
	boot: BootArguments,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BootRuntime> {
	const credentials = new InMemoryCredentialStore();
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	if (boot.mode === "faux") {
		const faux = registerFauxProvider();
		faux.setResponses(Array.from({ length: 256 }, () => fauxScenarioResponse));
		const model = faux.getModel();
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		return {
			model,
			modelRuntime,
			dispose: async () => {
				await credentials.delete(model.provider);
				faux.unregister();
			},
		};
	}

	if (modelRuntime.getProvider(boot.provider) === undefined) {
		throw new Error(`UNSUPPORTED_PROVIDER: provider '${boot.provider}' is not in the built-in catalog`);
	}
	const credentialEnvironmentVariable = PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES[boot.provider];
	if (credentialEnvironmentVariable === undefined) {
		throw new Error(`UNSUPPORTED_PROVIDER: provider '${boot.provider}' does not support isolated API-key boot`);
	}
	const model = modelRuntime.getModel(boot.provider, boot.model);
	if (model === undefined) {
		throw new Error(`UNSUPPORTED_MODEL: model '${boot.model}' is not available for provider '${boot.provider}'`);
	}
	const key = environment[credentialEnvironmentVariable];
	if (key === undefined || key.trim() === "") {
		throw new Error(`MISSING_CREDENTIAL: ${credentialEnvironmentVariable} must contain a nonempty API key`);
	}
	if (boot.provider === "openai-codex") {
		// openai-codex has no api-key auth path; store the env-supplied access
		// token as a non-refreshable oauth credential. With allowModelNetwork
		// disabled the runtime never attempts a refresh before expiry.
		await credentials.modify(boot.provider, async () => ({
			type: "oauth",
			access: key,
			refresh: "",
			expires: jwtExpiryMilliseconds(key) ?? Date.now() + 8 * 60 * 60 * 1000,
		}));
	} else {
		await credentials.modify(boot.provider, async () => ({ type: "api_key", key }));
	}
	return {
		model: model as Model<string>,
		modelRuntime,
		credentialEnvironmentVariable,
		dispose: async () => {
			await credentials.delete(boot.provider);
		},
	};
}

function jwtExpiryMilliseconds(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined) return undefined;
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const exp = (claims as { exp?: unknown }).exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
		const expires = exp * 1000;
		return expires > Date.now() ? expires : undefined;
	} catch {
		return undefined;
	}
}
