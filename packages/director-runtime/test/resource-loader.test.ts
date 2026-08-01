import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BundledDirectorResourceLoader,
	bundledSkillsPromptBlock,
	DIRECTOR_PROMPT_CONTRACT,
	DIRECTOR_PROMPT_CORE,
	DIRECTOR_PROMPT_FULL,
} from "../src/resource-loader.ts";

describe("bundled director resource loader", () => {
	it("directs ordinary Blender mutation through revisioned execute_blender_python", () => {
		for (const prompt of [DIRECTOR_PROMPT_CORE, DIRECTOR_PROMPT_CONTRACT, DIRECTOR_PROMPT_FULL]) {
			assert.match(prompt, /inspect_project/);
			assert.match(prompt, /execute_blender_python/);
			assert.match(prompt, /`import bpy`/);
			assert.match(prompt, /exact newest expected_revision_id/);
			assert.match(prompt, /new_revision_id/);
			assert.match(prompt, /enabled by default.*project (?:can|may) opt out/i);
			assert.match(prompt, /external side effects such as files, network requests, or spawned processes/);
		}
	});
	it("states every Blender execution outcome and retained stage_scene boundary", () => {
		for (const prompt of [DIRECTOR_PROMPT_CORE, DIRECTOR_PROMPT_CONTRACT]) {
			assert.match(prompt, /failed_recovered/);
			assert.match(prompt, /recovery_required/);
			assert.match(prompt, /outcome_unknown/);
			assert.match(
				prompt,
				/(?:Retained stage_scene is|Use retained stage_scene) only for add_character, adopt_entity, set_render_settings, and apply_motion/i,
			);
			for (const deletedOperation of [
				"add_primitive",
				"add_camera",
				"transform_entity",
				"set_material_color",
				"create_assembly",
			]) {
				assert.doesNotMatch(prompt, new RegExp(deletedOperation));
			}
		}
	});
	it("omits bundled skills from the embedded system prompt", () => {
		const loader = new BundledDirectorResourceLoader();
		const systemPrompt = loader.getSystemPrompt();

		// The embedded session has no read tool, so skill files cannot be advertised.
		assert.doesNotMatch(systemPrompt, /<available_skills>/);
		assert.doesNotMatch(systemPrompt, /Use the read tool/);
		assert.doesNotMatch(systemPrompt, /SKILL\.md/);
	});

	it("keeps skill guidance on the extension-facing prompt", () => {
		const extensionPrompt = `${DIRECTOR_PROMPT_FULL}\n\n${bundledSkillsPromptBlock()}`;

		assert.match(extensionPrompt, /FIRST read the ardy-motion skill listed in available_skills/);
		assert.match(extensionPrompt, /read the `visual-qa` skill listed in available_skills/);
		assert.match(extensionPrompt, /<available_skills>/);
	});

	it("retains substantive ARDY and visual QA guidance in the core prompt", () => {
		assert.match(DIRECTOR_PROMPT_CORE, /ardy_regenerate only to constrain an existing base motion/);
		assert.match(DIRECTOR_PROMPT_CORE, /Unconstrained text-to-motion generation is not exposed/);
		assert.match(
			DIRECTOR_PROMPT_CORE,
			/verify with economical multi-view and motion QA; never approve from one angle/,
		);
	});

	it("rejects resource extension requests", () => {
		const loader = new BundledDirectorResourceLoader();
		assert.throws(() => loader.extendResources({ skillPaths: ["/tmp/skill"] }), {
			message: "RESOURCE_EXTENSION_DENIED",
		});
	});
});
