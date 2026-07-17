import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createInspectProjectTool,
	type InspectProjectBridge,
} from "../../blender-tools/src/inspect-project.ts";
import {
	BundledDirectorResourceLoader,
	DIRECTOR_PROMPT_DIGEST,
} from "./resource-loader.ts";

export const DIRECTOR_TOOL_ALLOWLIST = ["inspect_project"] as const;

export interface DirectorSessionOptions {
	readonly bridge: InspectProjectBridge;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
}

export async function createDirectorSession(options: DirectorSessionOptions) {
	const cwd = options.cwd ?? process.cwd();
	const resourceLoader = new BundledDirectorResourceLoader();
	const { session } = await createAgentSession({
		cwd,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel: "off",
		resourceLoader,
		customTools: [createInspectProjectTool(options.bridge)],
		tools: [...DIRECTOR_TOOL_ALLOWLIST],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});

	const effectiveTools = session.getActiveToolNames();
	if (
		effectiveTools.length !== DIRECTOR_TOOL_ALLOWLIST.length ||
		effectiveTools.some((name, index) => name !== DIRECTOR_TOOL_ALLOWLIST[index])
	) {
		session.dispose();
		throw new Error(`DIRECTOR_TOOL_ALLOWLIST_MISMATCH: ${effectiveTools.join(",")}`);
	}
	if (resourceLoader.promptDigest() !== DIRECTOR_PROMPT_DIGEST) {
		session.dispose();
		throw new Error("DIRECTOR_PROMPT_DIGEST_MISMATCH");
	}

	return session;
}
