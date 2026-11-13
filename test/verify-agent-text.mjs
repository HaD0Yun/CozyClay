#!/usr/bin/env node
// verify-agent-text: text a model, an agent or a user reads says what the code does.
// Each check reads the real string or the real function output.
import { strict as assert } from "node:assert";
import { buildPromptBlocks } from "../bin/agent/anthropic-subscription-prompt.mjs";
import { STUDIO_SYSTEM_PROMPT } from "../bin/agent/studio-prompt.mjs";
import { SUPERVISOR_RUBRIC } from "../bin/agent/supervisor.mjs";
import { V4_SYSTEM_PROMPT, sceneBrief } from "../bin/agent/v4/prompt.mjs";
import { floorLiftWarnings } from "../src/studio-support-gap.js";

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check("replay placeholder claims an image only when an image block was appended", () => {
	const PLACEHOLDER = "(see attached image)";
	const texts = blocks => blocks.filter(block => block.type === "text").map(block => block.text);
	const hasImage = blocks => blocks.some(block => block.type === "image");
	const emptyResult = buildPromptBlocks({ messages: [
		{ role: "user", content: "look" },
		{ role: "toolResult", toolName: "inspect_studio", toolCallId: "c1", content: "" },
		{ role: "user", content: "next" },
	] });
	assert.ok(!hasImage(emptyResult) && !texts(emptyResult).includes(PLACEHOLDER), JSON.stringify(texts(emptyResult)));
	const bmp = buildPromptBlocks({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/bmp", data: "AA==" }] }] });
	assert.ok(!hasImage(bmp) && !texts(bmp).includes(PLACEHOLDER), JSON.stringify(texts(bmp)));
});

check("the Studio prompt names the 4x2 contact sheet for 7-8 named frames", () => {
	assert.doesNotMatch(STUDIO_SYSTEM_PROMPT, /returns one image of 6 frames sampled across the range, tiled 3x2 row-major/);
	assert.match(STUDIO_SYSTEM_PROMPT, /4x2/);
});

check("the supervisor rubric's examples use only index-visible actions (object.update is agentHidden)", () => {
	assert.doesNotMatch(SUPERVISOR_RUBRIC, /"object\.update"/);
});

check("the v4 prompt names the motion.compile compiler instead of an undefined old engine", () => {
	const installed = sceneBrief({ character: { id: "c", model: "m", position: [0, 0, 0], yaw: 0 }, installed: { frames: 24, raw: false }, frameCount: 24 });
	for (const text of [V4_SYSTEM_PROMPT, installed]) assert.doesNotMatch(text, /old.engine/i);
	assert.match(V4_SYSTEM_PROMPT, /motion\.compile/);
	assert.match(installed, /motion\.compile/);
});

check("the FLOOR_LIFT warning a user reads has no rendering jargon and keeps its 120-character cut", () => {
	const [one] = floorLiftWarnings(["a"], () => "Crate");
	assert.match(one.message, /^Crate lifted 3 mm off the deck/);
	assert.doesNotMatch(one.message, /z-fight/);
	const [long] = floorLiftWarnings(["a"], () => "N".repeat(200));
	assert.equal([...long.message].length, 120);
});

const { createToolHandlers } = await import("../mcp/tool-handlers.mjs");
const tool = name => createToolHandlers({}).find(entry => entry.name === name);

check("remove_character does not claim the last character cannot be removed", () => {
	assert.doesNotMatch(tool("remove_character").description, /cannot be removed/);
});

check("render_prompt does not claim the set reaches the prompt", () => {
	assert.doesNotMatch(tool("render_prompt").description, /cast and set/);
});

check("render_prompt pose phrases name the framed character and the next visible character", () => {
	const { pose_phrase, pose2_phrase } = tool("render_prompt").inputSchema;
	assert.match(pose_phrase.description, /framed character/);
	assert.match(pose2_phrase.description, /next visible character/);
});

let failed = 0;
for (const [name, fn] of checks) {
	try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n  ${error.message.split("\n")[0]}`); }
}
if (failed) { console.log(`\n${failed} of ${checks.length} checks failed`); process.exit(1); }
console.log(`\nPASS agent text (${checks.length} checks)`);
process.exit(0);
