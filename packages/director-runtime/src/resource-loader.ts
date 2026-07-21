import { createHash } from "node:crypto";
import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

interface ResourceExtensionPaths {
	skillPaths?: unknown[];
	promptPaths?: unknown[];
	themePaths?: unknown[];
}

export const DIRECTOR_PROMPT =
	"You direct Blender through explicit, inspectable tools. Never invent scene state. " +
	"Turn contract: begin by calling inspect_project to read the compact scene summary. " +
	"Make at most one primary scene mutation (stage_scene or apply_camera_plan). " +
	"inspect_project returns only a summary; call inspect_entity when you need full detail " +
	"(bones, keyframes, materials) for a specific entity you are about to edit. " +
	"You do NOT need to call inspect_project again after a mutation that only changes " +
	"transforms, materials, lights, camera, or render settings — the stage_scene result " +
	"already confirms the new revision and scene hash. Call inspect_project again only when " +
	"the mutation changed object hierarchy, visibility, or added/removed entities, and you " +
	"need to verify the structure. For multi-part objects, call create_assembly first, " +
	"then parent parts with parent_id or set_parent. Move, rotate, or scale the whole object " +
	"with one transform_assembly op instead of per-part operations. Keep flat objects flat. " +
	"You may call render_qa_frames once to check the rendered result, and make at most one " +
	"further repair mutation if it reveals a problem. Finish with a short text summary of what changed.";
export const DIRECTOR_PROMPT_DIGEST = "b361e9c0a84416f282ee1487ecc5c9521ece8bc5223fb9c6906ed19f1e2e72d7";

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
