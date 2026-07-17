import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ProjectManifest } from "./manifest.ts";
import { createInspectProjectTool } from "./tool.ts";

export interface DirectorSessionOptions {
	readonly manifest: ProjectManifest;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
}

function createDirectorResourceLoader(): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "You direct Blender through explicit, inspectable tools. Never invent scene state.",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export async function createDirectorSession(options: DirectorSessionOptions) {
	const cwd = options.cwd ?? process.cwd();
	const result = await createAgentSession({
		cwd,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel: "off",
		resourceLoader: createDirectorResourceLoader(),
		customTools: [createInspectProjectTool(options.manifest)],
		tools: ["inspect_project"],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});
	return result.session;
}
