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

	it("ardy-motion documents constrained regeneration as the fix for measured contacts", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		for (const marker of [
			"--constrain",
			"--base-motion",
			"LeftFoot",
			"RightFoot",
			"LeftHand",
			"RightHand",
			"achieved_error_m",
			"base_error_m",
			"residual",
		]) {
			assert.ok(content.includes(marker), `skill must mention ${marker}`);
		}
		// Coordinate frames are the load-bearing detail: ARDY targets are Y-up
		// npz units while Blender is Z-up metres, so the skill must state the
		// conversion or the director will silently feed swapped axes.
		assert.match(content, /Y-up/, "skill must state the npz up axis");
		assert.match(content, /scale/, "skill must point at the preflight scale factor");
		assert.ok(content.includes("motion-local"), "skill must say targets are motion-local, not world space");
	});

	it("visual-qa routes per-contact offsets to constrained regeneration, not one transform", () => {
		const content = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		assert.ok(content.includes("--constrain"), "QA must name the constrained escape hatch");
		assert.ok(
			content.includes("Per-contact offset"),
			"QA must classify per-contact offsets separately from uniform ones",
		);
		// A stair layout is exactly the case a single transform cannot fix, so
		// the per-contact row must outrank the layout-refit row.
		assert.ok(
			content.indexOf("Per-contact offset") < content.indexOf("Layout mismatch"),
			"per-contact offset must be classified before layout mismatch",
		);
	});

	it("director prompt states that prompt numbers bias but do not bind ARDY", () => {
		assert.ok(/never sees the scene/.test(DIRECTOR_PROMPT), "prompt must say ARDY is scene-blind");
		assert.ok(/does not bind/.test(DIRECTOR_PROMPT), "prompt must say measured numbers in text are not constraints");
		// The prompt stays tool-level: the CLI surface belongs to the skill.
		assert.ok(!DIRECTOR_PROMPT.includes("--constrain"));
	});

	it("director prompt cannot steer the model into the motion fps conflict", () => {
		// The prompt used to say "fps 24 for cinematic" unconditionally while
		// apply_motion forces the scene to the motion's native 20 fps. Whichever
		// operation ran last won, silently: 20 fps keys at 24 played 20% fast,
		// and the reverse order discarded the requested fps.
		assert.match(DIRECTOR_PROMPT, /APPLY_MOTION_FPS_CONFLICT/, "prompt must name the error the director will hit");
		assert.match(
			DIRECTOR_PROMPT,
			/omit fps from set_render_settings/,
			"prompt must state the fix, not just the failure",
		);
		// The recommendation must be SCOPED before it is given, not merely
		// qualified somewhere later, or the model skims the number and walks
		// straight into the guard. Assert the ordering, not one phrasing.
		const render = DIRECTOR_PROMPT.slice(DIRECTOR_PROMPT.indexOf("- Render:"));
		const line = render.slice(0, render.indexOf("\n"));
		assert.ok(
			line.indexOf("no baked character motion") < line.indexOf("for casual"),
			"the fps recommendation must be scoped before it is offered",
		);
		// The cross-call hole is real and unenforced, so the prompt must carry the
		// rule the guard cannot, and must not claim enforcement it does not have.
		assert.match(
			DIRECTOR_PROMPT,
			/separate later plan is NOT checked/,
			"prompt must state that a later fps-only plan is unguarded",
		);
	});

	it("ardy-motion documents every constraint kind ARDY actually observes", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		// cclay used to wire only end-effector POSITIONS, so a hand reached the
		// right point with an arbitrary wrist axis, sitting was unreachable, and
		// a walk path was prose. Each flag must be documented or the director
		// cannot know the capability exists.
		for (const flag of ["--constrain-orient", "--constrain-pose", "--constrain-path"]) {
			assert.ok(content.includes(flag), `skill must document ${flag}`);
		}
		// Every claim must be a MEASURED number with its unconstrained pair, the
		// same discipline as achieved_error_m next to base_error_m.
		for (const field of [
			"achieved_error_deg",
			"base_error_deg",
			"shape_max_error_m",
			"base_shape_max_error_m",
			"achieved_error_m",
		]) {
			assert.ok(content.includes(field), `skill must cite the measured field ${field}`);
		}
		// The two rules a caller cannot infer and will otherwise get wrong.
		assert.match(
			content,
			/orientation with no position is rejected/,
			"skill must state that an orientation needs its matching position",
		);
		assert.match(content, /for every waypoint or for none/, "skill must state the all-or-nothing heading rule");
	});

	it("ardy-motion documents the hand track as authored, not generated", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		for (const marker of ["hand_track", "APPLY_MOTION_HAND_TRACK_INVALID", "contact_windows"]) {
			assert.ok(content.includes(marker), `skill must mention ${marker}`);
		}
		// The frame space is the whole reason a track is cheap to author: reuse the
		// contact frames instead of converting into scene frames a second time.
		assert.match(content, /0-based CLIP frame/, "skill must state the track frame space");
		// Finger timing is a rule we author. Selling it as model output would send a
		// later debugging pass into ARDY instead of into the keys.
		assert.match(content, /inferred, not generated/, "skill must not claim ARDY animates fingers");
		assert.ok(content.includes("mutually exclusive"), "skill must state hand_track excludes hand_shapes/hand_pose");
	});

	it("visual-qa separates a wrong hand shape from a wrongly timed one", () => {
		const content = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		assert.ok(content.includes("wrongly timed"), "QA must classify hand timing separately");
		assert.ok(
			content.indexOf("Wrong hand shape only") < content.indexOf("wrongly timed"),
			"a wrong shape is the cheaper fix and must be classified first",
		);
		// left/right only carry the resting shape once a track is involved.
		assert.match(content, /resting shape/, "QA must not read a track's state off left/right");
	});

	it("ardy-motion covers generation, apply, and the post-apply QA handoff", () => {
		const content = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		for (const marker of [
			"cclay-ardy-generate",
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
			content.lastIndexOf("visual-qa") > content.lastIndexOf("apply_motion"),
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
		// Within-clip changes used to be documented as deferred; they are now
		// hand_track, so the skill must route there instead of denying them.
		assert.doesNotMatch(content, /temporal hand tracks are deferred/);
		assert.match(content, /changes shape mid-clip/);
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

	it("skills state foot joints are not sole contact points and ban guessed offsets (issue #2)", () => {
		const ardy = readFileSync(ARDY_MOTION_SKILL_PATH, "utf8");
		const visualQa = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		for (const content of [ardy, visualQa]) {
			assert.match(content, /skeleton joint centers?, not sole contact points?/i, "must state Foot != sole contact");
		}
		assert.match(
			ardy,
			/achieved_error_m: 0\.0.*proves the joint reached its target/,
			"must say zero residual proves joint accuracy only",
		);
		assert.match(
			ardy,
			/guessed offset.*never acceptable as final verification/,
			"must ban a fixed guessed offset as final verification",
		);
		assert.match(
			ardy,
			/Use `foot_contacts` to find WHEN and WHICH foot is planted.*inspect_pose_contacts/,
			"must route from contact timing metadata to a deformed-sole/support measurement",
		);
		assert.match(ardy, /Prefer a natural, unconstrained base motion/, "must prefer natural base motion");
	});

	it("visual-qa enforces the numeric ±0.03 m sole-contact gate and multi-view rule", () => {
		const content = readFileSync(VISUAL_QA_SKILL_PATH, "utf8");
		for (const marker of [
			"inspect_pose_contacts",
			"support_gap_m",
			"inside_support_footprint",
			"surface_contact_verified",
		]) {
			assert.ok(content.includes(marker), `visual QA skill must mention ${marker}`);
		}
		assert.match(content, /±0\.03 m/, "must state the numeric gate as ±0.03 m");
		assert.match(
			content,
			/surface_contact_verified: false.*hard QA failure/,
			"a failed surface-contact check must be a hard failure, not an advisory",
		);
		assert.match(
			content,
			/never approve actor-object contact from a single camera angle/,
			"must require multiple views for contact/support relations",
		);
		assert.match(
			content,
			/end_pose\.resting: false.*hard failure|hard failure.*do not report completion/,
			"an unsupported/unstable ending must block completion",
		);
	});

	it("director prompt routes motion and post-generation verification to skills", () => {
		assert.ok(DIRECTOR_PROMPT.includes("ardy-motion"));
		assert.ok(DIRECTOR_PROMPT.includes("visual-qa"));
		assert.ok(DIRECTOR_PROMPT.includes("add_camera"));
		assert.ok(DIRECTOR_PROMPT.includes("Euler rotations are radians"));
		// Detailed workflows live only in lazily-read skills.
		assert.ok(!DIRECTOR_PROMPT.includes("cclay-ardy-generate"));
		assert.ok(!DIRECTOR_PROMPT.includes("One correction pass"));
	});
});
