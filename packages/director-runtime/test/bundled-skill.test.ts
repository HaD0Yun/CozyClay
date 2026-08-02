import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ARDY_MOTION_SKILL_PATH, bundledSkillsPromptBlock, VISUAL_QA_SKILL_PATH } from "../src/resource-loader.ts";

const RETAINED_STAGE_SCENE_OPERATIONS = [
	"add_character",
	"adopt_entity",
	"set_render_settings",
	"apply_motion",
] as const;
const DELETED_STAGE_SCENE_GUIDANCE = ["transform_entity", "add_camera"] as const;

describe("bundled director skills", () => {
	it("frontmatter is a valid Agent Skills header", () => {
		for (const [path, expectedName] of [
			[ARDY_MOTION_SKILL_PATH, "ardy-motion"],
			[VISUAL_QA_SKILL_PATH, "visual-qa"],
		] as const) {
			const content = readFileSync(path, "utf8");
			const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
			const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
			assert.equal(name, expectedName);
			assert.ok(description && description.length > 0 && description.length <= 1024);
			assert.match(name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		}
	});

	it("prompt block advertises both skills with their on-disk locations", () => {
		const block = bundledSkillsPromptBlock();
		assert.ok(block.includes("<available_skills>"));
		for (const [name, path] of [
			["ardy-motion", ARDY_MOTION_SKILL_PATH],
			["visual-qa", VISUAL_QA_SKILL_PATH],
		] as const) {
			assert.ok(block.includes(`<name>${name}</name>`));
			assert.ok(block.includes(`<location>${path}</location>`));
		}
	});

	it("routes ordinary Blender work through execute_blender_python, not deleted stage_scene operations", () => {
		for (const path of [ARDY_MOTION_SKILL_PATH, VISUAL_QA_SKILL_PATH]) {
			const content = readFileSync(path, "utf8");
			assert.match(content, /execute_blender_python/);
			assert.match(content, /import bpy/);
			assert.match(content, /latest `expected_revision_id`/);
			for (const operation of RETAINED_STAGE_SCENE_OPERATIONS) {
				assert.ok(content.includes(operation), `${path} must retain ${operation}`);
			}
			for (const operation of DELETED_STAGE_SCENE_GUIDANCE) {
				assert.doesNotMatch(content, new RegExp(`\\b${operation}\\b`));
			}
		}
	});

	it("routes all three ARDY tools through typed host services and their queues", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		for (const marker of [
			"ardy_generate",
			"ardy_inbetween",
			"ardy_regenerate",
			"MotionArchiveStore",
			"ArdyArchiveService",
			"ArdyMotionKernel",
			"CharacterRigAdapter",
			"host-side queue",
			"durable outcome",
			"closed request",
		]) {
			assert.ok(content.includes(marker), `ardy-motion must mention ${marker}`);
		}
		assert.match(content, /unconstrained first-pass text-to-motion generation/);
		assert.match(content, /pose-captured in-between synthesis/);
		assert.match(content, /constrained regeneration of an existing base motion/);
		assert.match(content, /correctness boundaries for well-behaved callers/);
		assert.match(content, /not a security boundary/);
		assert.match(content, /Arbitrary `execute_blender_python` can bypass/);
		assert.match(content, /do not claim ARDY provides OS isolation or a drift detector/);
	});

	it("keeps measured ARDY preflight and pose-contact QA responsibilities distinct", () => {
		const ardy = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		const visualQa = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		for (const marker of ["inspect_relations", "preflight_motion", "apply_motion", "motion_id"]) {
			assert.ok(ardy.includes(marker), `ardy-motion must mention ${marker}`);
		}
		for (const marker of [
			"inspect_pose_contacts",
			"support_gap_m",
			"inside_support_footprint",
			"surface_contact_verified",
			"±0.03 m",
		]) {
			assert.ok(visualQa.includes(marker), `visual-qa must mention ${marker}`);
		}
		assert.match(ardy, /skeleton joint centers, not sole contact points/);
		assert.match(visualQa, /skeleton joint centers, not sole contact points/);
	});

	it("does not document the rejected --samples wrapper flag", () => {
		for (const path of [ARDY_MOTION_SKILL_PATH, VISUAL_QA_SKILL_PATH]) {
			const content = readFileSync(path, "utf8");
			assert.doesNotMatch(content, /--samples/);
		}
	});
});
