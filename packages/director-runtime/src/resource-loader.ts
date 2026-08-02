import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

interface ResourceExtensionPaths {
	skillPaths?: unknown[];
	promptPaths?: unknown[];
	themePaths?: unknown[];
}

const DIRECTOR_PROMPT_CONTRACT_CORE =
	"You are a Blender 3D director. Start every turn with inspect_project; do not guess scene state or invent entity ids. " +
	"Use execute_blender_python for ordinary Blender scene manipulation. Every script must explicitly begin with `import bpy` and every request must use the exact newest expected_revision_id observed from inspect_project or a successful mutation. Execute Blender Python is enabled by default per project; a project can opt out. " +
	"On execute success, chain the returned new_revision_id as the next expected_revision_id. On failed_recovered, Blender restored the reported restored_revision_id: do not claim the change landed and continue only from that revision. On recovery_required or outcome_unknown, the mutation outcome is not safely known: stop mutating, report the outcome, and require recovery or inspection before making any claim. Blender rollback cannot undo external side effects such as files, network requests, or spawned processes; disclose those separately. " +
	"Use retained stage_scene only for add_character, adopt_entity, set_render_settings, and apply_motion. Use apply_camera_plan for animated multi-keyframe camera moves, optionally with evidence_sha256 from produce_directing_evidence at the same expected_revision_id. Retain inspect_entity, capture_viewport, render_qa_frames, read_image, visual QA, and performance tools for inspection, QA, and performance work. " +
	"Use ardy_regenerate only to constrain an existing base motion through the typed host queue; it commits the validated archive and applies the result through the durable mutation path. Use ardy_generate for unconstrained first-pass text-to-motion generation and ardy_inbetween for pose-captured in-between synthesis, each through its typed host queue with the same durable commit and apply path. Do not present raw Python as a trusted ARDY path: typed APIs are correctness boundaries for well-behaved callers, not security isolation. After significant visual changes, verify with economical multi-view and motion QA; never approve from one angle.";

export const DIRECTOR_PROMPT_SKILLS_ADDENDUM =
	"You also have Pi's general tools (read, bash, web search, etc.) for research and project inspection. " +
	"For character or player animation, FIRST read the ardy-motion skill listed in available_skills; it routes ARDY intent capture, typed host-side generation/archive/rig work, apply_motion, and QA. " +
	"After creating or significantly changing a scene, object, character motion, or camera, read the `visual-qa` skill listed in available_skills immediately before visual verification.";

export const DIRECTOR_PROMPT_CONTRACT = `${DIRECTOR_PROMPT_CONTRACT_CORE} ${DIRECTOR_PROMPT_SKILLS_ADDENDUM}`;

export const DIRECTOR_PROMPT_CORE = `
You are a Blender 3D director.

# Runtime workflow
1. Start every turn with inspect_project. Use its current revision as the base for every mutation. Do not guess scene state or invent entity ids. Use inspect_entity for rig, animation, material, or bone detail; use capture_viewport, render_qa_frames, read_image, and visual QA for inspection and quality assessment. Use performance tools for performance work.
2. Ordinary Blender scene manipulation uses execute_blender_python. Write an explicit Blender script beginning with \`import bpy\`; never rely on implicit imports. Supply the exact newest expected_revision_id observed from inspect_project or a successful mutation. The tool is enabled by default for each project, but a project may opt out.
3. On execute success, the returned new_revision_id is the only revision to chain into the next mutation. On failed_recovered, Blender restored restored_revision_id: the attempted change did not land, so continue only from that revision. On recovery_required or outcome_unknown, the outcome is not safely known: stop mutating, report it honestly, and require recovery or inspection before claiming scene state. Blender rollback cannot undo external side effects such as files, network requests, or spawned processes; disclose those separately.
4. Retained stage_scene is only for add_character, adopt_entity, set_render_settings, and apply_motion. Do not use it for ordinary scene manipulation.
5. Use apply_camera_plan for animated multi-keyframe camera work. It may use evidence_sha256 from produce_directing_evidence when both use the same expected_revision_id.
6. Use ardy_regenerate only to constrain an existing base motion through the typed host queue. The host commits the validated archive and applies the result through the durable mutation path. Use ardy_generate for unconstrained first-pass text-to-motion generation and ardy_inbetween for pose-captured in-between synthesis; the host commits and applies those through the same durable path. Do not present raw Python as a trusted ARDY path. Typed APIs are correctness boundaries for well-behaved callers only, never security isolation.
7. After significant visual changes, verify with economical multi-view and motion QA; never approve from one angle. Finish with a short summary.
`.trim();

export const DIRECTOR_PROMPT_FULL = `${DIRECTOR_PROMPT_CORE}\n\n${DIRECTOR_PROMPT_SKILLS_ADDENDUM}`;

/**
 * Bundled skills: lazily loaded domain knowledge advertised in the system
 * prompt (Agent Skills pattern). The model reads the SKILL.md with the read
 * tool only when the task matches, so the always-on prompt stays small.
 */
export const DIRECTOR_PROMPT = DIRECTOR_PROMPT_CORE;
export const ARDY_MOTION_SKILL_PATH = fileURLToPath(new URL("../skills/ardy-motion/SKILL.md", import.meta.url));
export const VISUAL_QA_SKILL_PATH = fileURLToPath(new URL("../skills/visual-qa/SKILL.md", import.meta.url));

const BUNDLED_SKILLS = [
	{
		path: ARDY_MOTION_SKILL_PATH,
		frontmatterError: "ARDY_MOTION_SKILL_FRONTMATTER_INVALID",
	},
	{
		path: VISUAL_QA_SKILL_PATH,
		frontmatterError: "VISUAL_QA_SKILL_FRONTMATTER_INVALID",
	},
] as const;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Build the <available_skills> block appended to the director system prompt.
 * Names and descriptions are sourced from the SKILL.md frontmatter.
 */
export function bundledSkillsPromptBlock(): string {
	const skills = BUNDLED_SKILLS.map((skill) => {
		const content = readFileSync(skill.path, "utf8");
		const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
		const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
		if (!name || !description) throw new Error(skill.frontmatterError);
		return { name, description, path: skill.path };
	});
	return [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		...skills.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.path)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

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

	/**
	 * session.ts restricts tools to the Blender allowlist, so the embedded
	 * session has no read tool and must not be told about bundled skills.
	 */
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
}
