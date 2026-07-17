import { createHash } from "node:crypto";
import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

interface ResourceExtensionPaths {
	skillPaths?: unknown[];
	promptPaths?: unknown[];
	themePaths?: unknown[];
}

export const DIRECTOR_PROMPT = "You direct Blender through explicit, inspectable tools. Never invent scene state.";
export const DIRECTOR_PROMPT_DIGEST = "59a08cefea73ba66e89561cca3e50a98664ddfb863ce38ee8bcd516ad3997e73";

function isEmptyRequest(request: ResourceExtensionPaths): boolean {
	return (
		(request.skillPaths?.length ?? 0) === 0 &&
		(request.promptPaths?.length ?? 0) === 0 &&
		(request.themePaths?.length ?? 0) === 0
	);
}

export class BundledDirectorResourceLoader implements ResourceLoader {
	private runtime = createExtensionRuntime();

	getExtensions() {
		return { extensions: [], errors: [], runtime: this.runtime };
	}

	getSkills() {
		return { skills: [], diagnostics: [] };
	}

	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}

	getThemes() {
		return { themes: [], diagnostics: [] };
	}

	getAgentsFiles() {
		return { agentsFiles: [] };
	}

	getSystemPrompt() {
		return DIRECTOR_PROMPT;
	}

	getAppendSystemPrompt() {
		return [];
	}

	extendResources(request: ResourceExtensionPaths): void {
		if (!isEmptyRequest(request)) throw new Error("RESOURCE_EXTENSION_DENIED");
	}

	async reload(): Promise<void> {
		this.runtime = createExtensionRuntime();
	}

	promptDigest(): string {
		return createHash("sha256").update(DIRECTOR_PROMPT).digest("hex");
	}
}
