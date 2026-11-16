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
assert.match(coordinator, /\n8\. Body motion of rig characters is one task that calls its motion tool/);
// the order: the motion task sets up what the bodies use; what needs its result depends on it, light needs only the request
assert.match(coordinator, /adds the characters and every object a body touches, stands on, sits on, holds or moves that the scene lacks/);
assert.match(coordinator, /so their tasks dependsOn the motion task \(not each other\), and no task builds an object a body uses before it; light, sky and ground need only the request\./);
assert.match(coordinator, /which objects the motion uses \(ids and boxes\) and the floor region the bodies cross\./);
assert.match(coordinator, /A task that only makes new things needs no scope key: send an empty scope/);
assert.match(coordinator, /its report is the check of the motion, so it ends done even with verify or an unmet criterion \(its summary carries them\), and the tasks that depend on it start then\./);
assert.match(coordinator, / a new shot needs no key and a range for it over free frames only its shot:<id> \(growing the take, re-timing or moving into frames another shot uses takes timeline\),/);
assert.ok(MAIN_SYSTEM_PROMPT.includes(" a new shot or shot ranges take timeline,"), "the old coordinator keeps its shot rule");
for (const gone of ["In a task the motion tool adds nothing", "When other tasks build what the motion needs", "\"make a cup, then have her pick it up\"", "a camera that frames a motion still being made", "still needs one scope key"]) assert.equal(coordinator.includes(gone), false, gone);
assert.ok(MAIN_SYSTEM_PROMPT.includes("\"make a cup, then have her pick it up\" is one task") && MAIN_SYSTEM_PROMPT.includes("still needs one scope key"), "the old coordinator keeps its text");
// the Studio agent: motion first, dress in place, the report is the check of the motion
assert.match(MOTION_TOOL_PARAGRAPH, /When the user asks for body motion, call motion \{ request \} first, before you build or change the set\./);
assert.match(MOTION_TOOL_PARAGRAPH, /give a stand-in its look in place with object\.sculpt \{ id, recipe \}/);
assert.match(MOTION_TOOL_PARAGRAPH, /An edit of such an object answers motionFit/);
assert.match(MOTION_TOOL_PARAGRAPH, /do not check the body motion again with verify_result\./);
assert.doesNotMatch(MOTION_TOOL_PARAGRAPH, /once the set and the characters the motion needs exist|outside a task/);
// only what depends on where the body goes is put after the motion's result; used is in the result (a plain turn's call answers started)
{
	const after = MOTION_TOOL_PARAGRAPH.slice(MOTION_TOOL_PARAGRAPH.indexOf("waits for its result"), MOTION_TOOL_PARAGRAPH.indexOf("Do not move, resize"));
	assert.ok(after.length > 0 && /object\.sculpt/.test(after) && /camera/.test(after), after);
	assert.doesNotMatch(after, /light|does not touch/, "light and what the body does not touch do not wait for the result");
	assert.match(MOTION_TOOL_PARAGRAPH, /its result names in used/);
	assert.doesNotMatch(MOTION_TOOL_PARAGRAPH, /its answer names in used/);
}
{
	const lowvis = await studioSystemPrompt({ engine: "lowvis", motion: true });
	assert.match(lowvis, /\n2\. Staging first, before any camera: the motion tool places the rig characters that move and the objects their bodies use; place the rest of the cast and the set around them\./);
	assert.match(lowvis, /verify_result checks placement and framing for targets/);
	assert.ok(STUDIO_SYSTEM_PROMPT.includes("2. Staging first: place and face the cast") && STUDIO_SYSTEM_PROMPT.includes("verify_result checks placement, framing and motion"), "the old prompt keeps both");
	const { taskHeader } = await import("../../bin/agent/studio-tasks.mjs");
	const task = { taskId: "t1", scope: [], instructions: "x" };
	assert.match(taskHeader(task), /A motion is done at its first take/, "the old task header keeps its take check");
	const header = taskHeader(task, { lowvis: true, deps: [{ taskId: "m", title: "motion", summary: { reply: "Done.", used: "The motion uses these objects as boxes (...)." }, changed: ["sculpt-2"] }] });
	assert.doesNotMatch(header, /contact_sheet|A motion is done/);
	assert.match(header, /\(anchor 7 cm off the bar\)\.\n/);
	assert.match(header, /Earlier task m \(motion\) is done: Done\. It changed: sculpt-2\. The motion uses these objects as boxes \(\.\.\.\)\./);
}
assert.match(coordinator, /missing field \("Missing: \.\.\."\) is the motion tool's own Missing line: repeat it to the user unchanged in meaning\./);
assert.equal(mainSystemPrompt({ engine: "old" }), MAIN_SYSTEM_PROMPT);
console.log("PASS the lowvis coordinator prompt has no QA problems, motion.compile or design_motion; the old one is unchanged");
