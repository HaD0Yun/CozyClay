#!/usr/bin/env node
// The prompts of the Studio agent and the task coordinator under the lowvis engine carry no guidance of the old motion
// engine (rule 2, rule 3), and the old engine's prompts stay as they are.
import assert from "node:assert/strict";
import { studioSystemPrompt } from "../../bin/agent/studio-motion-reference.mjs";
import { STUDIO_SYSTEM_PROMPT } from "../../bin/agent/studio-prompt.mjs";
import { MOTION_TOOL_PARAGRAPH, NO_MOTION_PARAGRAPH } from "../../bin/agent/studio-prompt-lowvis.mjs";
import { MAIN_SYSTEM_PROMPT, mainSystemPrompt } from "../../bin/agent/main-prompt.mjs";

// the forbidden tokens of the plan's todo 4
const FORBIDDEN = ["motion.compile", "motion.describe", "motion.fill", "motion.primitive", "MotionBricks", "motion-reference", "output.observations", "output.stuck", "reachGrip",
	"skill flip", "compile", "qa.blocking", "specId", "smokeCigarette", "spec.objects", "observations.", "motion.sample", "Key the extremes"];

for (const motion of [true, false]) {
	const text = await studioSystemPrompt({ engine: "lowvis", motion });
	assert.deepEqual(FORBIDDEN.filter(token => text.includes(token)), [], `lowvis Studio prompt (motion ${motion})`);
	assert.doesNotMatch(text, /previsMode|storyboard/i);
	assert.ok(text.endsWith(`\n\n${motion ? MOTION_TOOL_PARAGRAPH : NO_MOTION_PARAGRAPH}`));
	assert.match(text, /\n- rig: cast only the block figure \(model x-bot-tpose\)\.\n/);
	assert.doesNotMatch(text, /Y Bot|y-bot-tpose/, "a new character is never the old Y Bot body");
}
// the motion tool takes the agent's note; the user's message goes to it by itself (motion-door.mjs)
assert.match(MOTION_TOOL_PARAGRAPH, /The user's message of this turn reaches the tool by itself, as typed; request is your own note:/);
assert.doesNotMatch(MOTION_TOOL_PARAGRAPH, /own words/);
const old = await studioSystemPrompt({ engine: "old" });
assert.ok(old.startsWith(STUDIO_SYSTEM_PROMPT) && old.includes("<motion-reference>"), "the old engine keeps its prompt and reference");
console.log("PASS the lowvis Studio prompt has none of the forbidden tokens; the old one keeps its reference");

const coordinator = mainSystemPrompt({ engine: "lowvis" });
for (const token of ["QA problems", "motion.compile", "design_motion"]) assert.equal(coordinator.includes(token), false, token);
assert.match(coordinator, /\n8\. Body motion of rig characters is one ordinary task that calls its motion tool/);
assert.match(coordinator, /When other tasks build what the motion needs, it dependsOn them\./);
assert.match(coordinator, /missing field \("Missing: \.\.\."\) is the motion tool's own Missing line: repeat it to the user unchanged in meaning\./);
assert.equal(mainSystemPrompt({ engine: "old" }), MAIN_SYSTEM_PROMPT);
console.log("PASS the lowvis coordinator prompt has no QA problems, motion.compile or design_motion; the old one is unchanged");
