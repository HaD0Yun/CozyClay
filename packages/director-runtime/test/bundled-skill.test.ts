import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	ARDY_MOTION_SKILL_DIGEST,
	ARDY_MOTION_SKILL_PATH,
	bundledSkillsPromptBlock,
	DIRECTOR_PROMPT,
	VISUAL_QA_SKILL_DIGEST,
	VISUAL_QA_SKILL_PATH,
} from "../src/resource-loader.ts";

describe("bundled director skills", () => {
	it("skill files match their pinned digests (fail-closed integrity)", () => {
		for (const [path, expectedDigest] of [
			[ARDY_MOTION_SKILL_PATH, ARDY_MOTION_SKILL_DIGEST],
			[VISUAL_QA_SKILL_PATH, VISUAL_QA_SKILL_DIGEST],
		] as const) {
			const content = readFileSync(path, "utf8");
			const digest = createHash("sha256").update(content).digest("hex");
			assert.equal(digest, expectedDigest);
		}
	});

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
		assert.ok(block.includes("read tool"));
	});

	it("ardy-motion covers generation, apply, and the post-apply QA handoff", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		for (const marker of [
			"omb-ardy-generate",
			"apply_motion",
			"entity_id",
			"motion_id",
			"--duration",
			"--seed",
			"transform_entity",
			"A person",
			"--segment",
			"hand_shapes",
			"continuity",
			"visual-qa",
		]) {
			assert.ok(content.includes(marker), `skill must mention ${marker}`);
		}
		assert.match(content, /[Nn]ever (concatenate|splice)/, "skill must ban npz splicing");
		assert.ok(
			content.indexOf("visual-qa") > content.lastIndexOf("apply_motion"),
			"visual-qa handoff must happen after apply_motion",
		);
		const validatedPresets = [
			"relaxed",
			"open",
			"fist",
			"soft_fist",
			"point",
			"two_finger",
			"cup",
			"grasp",
			"thumb_extended",
			"three_finger",
			"hook",
		];
		assert.ok(
			content.includes(
				`validated library (\`1.1.0\`) vocabulary is exactly: ${validatedPresets.map((preset) => `\`${preset}\``).join(", ")}`,
			),
			"skill must list the exact versioned validated preset vocabulary",
		);
		for (const invalidatedPreset of ["pinch", "precision_pinch", "ok", "spread", "flat"]) {
			assert.doesNotMatch(content, new RegExp(`\\b${invalidatedPreset}\\b`));
		}
		assert.match(content, /explicit preset for both left and right/);
		assert.match(content, /request-time, per-side, and clip-wide/);
		assert.match(content, /Omitted sides resolve to `relaxed`/);
		assert.match(content, /Within-clip hand changes .* deferred/);
		assert.match(content, /not a runtime classifier/);
		assert.match(content, /do not route from action, object, chair, or other keyword templates/);
	});

	it("visual-qa covers lightweight evidence, actor-object fit, and minimal correction", () => {
		const content = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		for (const marker of [
			"capture_viewport",
			"render_qa_frames",
			"target region",
			"max_jump_frame",
			"transform_entity",
			"One correction pass",
			"add_camera",
			"rigidly splayed fingers",
			"Do not build montages",
			"failure, not an advisory",
			"applied_hand_shapes",
			"same `motion_id`",
			"changing only the failed side",
			"never regenerate correct body motion",
		]) {
			assert.ok(content.includes(marker), `visual QA skill must mention ${marker}`);
		}
		assert.match(content, /hand_shapes.*both values.*applied_hand_shapes/);
		const validatedPresets = [
			"relaxed",
			"open",
			"fist",
			"soft_fist",
			"point",
			"two_finger",
			"cup",
			"grasp",
			"thumb_extended",
			"three_finger",
			"hook",
		];
		assert.ok(
			content.includes(
				`library (\`1.1.0\`) as fail-closed. Its vocabulary is exactly: ${validatedPresets.map((preset) => `\`${preset}\``).join(", ")}`,
			),
			"visual QA skill must list the exact versioned validated preset vocabulary",
		);
		for (const invalidatedPreset of ["pinch", "precision_pinch", "ok", "spread", "flat"]) {
			assert.doesNotMatch(content, new RegExp(`\\b${invalidatedPreset}\\b`));
		}
	});

	it("skills pin the numeric preflight obligations and rise arithmetic", () => {
		const ardy = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		const visualQa = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		for (const marker of ["inspect_relations", "preflight_motion"]) {
			assert.ok(ardy.includes(marker), `ardy-motion skill must mention ${marker}`);
			assert.ok(visualQa.includes(marker), `visual QA skill must mention ${marker}`);
		}
		for (const marker of ["contact_windows", "(count-1)", "Uniform offset", "parent Empty"]) {
			assert.ok(visualQa.includes(marker), `visual QA skill must mention ${marker}`);
		}
		for (const marker of ["Preflight gate — compare, then apply.", "numbers, not adjectives"]) {
			assert.ok(ardy.includes(marker), `ardy-motion skill must mention ${marker}`);
		}
		// Workflow order: measure -> generate -> gate -> apply.
		const inspectIndex = ardy.indexOf("inspect_relations");
		const generateIndex = ardy.indexOf("## 3. Generate and bake");
		const gateIndex = ardy.indexOf("Preflight gate");
		const applyIndex = ardy.indexOf('op: "apply_motion"');
		for (const index of [inspectIndex, generateIndex, gateIndex, applyIndex]) {
			assert.ok(index >= 0, "ordering markers must all be present");
		}
		assert.ok(
			inspectIndex < generateIndex && generateIndex < gateIndex && gateIndex < applyIndex,
			"ardy-motion must order inspect_relations < generation < preflight gate < apply_motion",
		);
	});

	it("director prompt routes motion and post-generation verification to skills", () => {
		assert.ok(DIRECTOR_PROMPT.includes("ardy-motion"));
		assert.ok(DIRECTOR_PROMPT.includes("visual-qa"));
		assert.ok(DIRECTOR_PROMPT.includes("add_camera"));
		assert.ok(DIRECTOR_PROMPT.includes("Euler rotations are radians"));
		// Detailed workflows live only in lazily-read skills.
		assert.ok(!DIRECTOR_PROMPT.includes("omb-ardy-generate"));
		assert.ok(!DIRECTOR_PROMPT.includes("One correction pass"));
	});
});
