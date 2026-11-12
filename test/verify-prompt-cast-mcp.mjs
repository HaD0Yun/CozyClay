#!/usr/bin/env node
// render_prompt describes every visible character (#1213).
//
// Through the MCP handlers, without a server: a cast of three visible
// characters must reach the prompt as three subjects, the framed character
// first and the others in cast order. A hidden character stays out.
// This file has its own process because the handler module keeps state.

import { strict as assert } from "node:assert";
import { createToolHandlers } from "../mcp/tool-handlers.mjs";

const tools = createToolHandlers({});
const call = async (name, args) => {
	const result = await tools.find((entry) => entry.name === name).handler(args);
	assert.equal(result.isError, undefined, `${name} failed: ${result.content[0].text}`);
	return result.content[0].text;
};
const promptArgs = { mode: "image", environment: "an empty stage", style: "plain", camera_move: "hold", pose_phrase: "", pose2_phrase: "" };
const count = (text, part) => text.split(part).length - 1;

const A = "a courier in a yellow raincoat";
const B = "a florist with an apron";
const C = "a cyclist in a blue helmet";
const D = "a stagehand dressed in black";

await call("place_character", { character: "A", subject: A });
await call("add_character", { subject: B, x: 1.2, z: 0, facing: 0 });
await call("add_character", { subject: C, x: -1.2, z: 0, facing: 0 });

const three = await call("render_prompt", promptArgs);
assert.ok(three.includes("Three subjects."), `the prompt does not announce three subjects:\n${three}`);
assert.ok(three.includes("Subject 3:"), `the prompt has no third subject:\n${three}`);
for (const who of [A, B, C]) assert.equal(count(three, who), 1, `"${who}" is not described exactly once:\n${three}`);
assert.ok(three.indexOf(A) < three.indexOf(B) && three.indexOf(B) < three.indexOf(C), `the subjects are not in cast order:\n${three}`);
console.log("PASS render_prompt describes three visible characters in cast order");

await call("focus_character", { character: "B" });
const framedB = await call("render_prompt", promptArgs);
assert.ok(framedB.includes(`Subject 1: ${B}.`), `the framed character is not the first subject:\n${framedB}`);
assert.ok(framedB.indexOf(B) < framedB.indexOf(A) && framedB.indexOf(A) < framedB.indexOf(C), `after the framed character the others are not in cast order:\n${framedB}`);
for (const who of [A, B, C]) assert.equal(count(framedB, who), 1, `"${who}" is not described exactly once:\n${framedB}`);
console.log("PASS render_prompt lists the framed character first, then the others in cast order");

await call("add_character", { subject: D, x: 2.4, z: 0, facing: 0 });
await call("place_character", { character: "D", hidden: true });
const withHidden = await call("render_prompt", promptArgs);
assert.ok(withHidden.includes("Three subjects."), `a hidden character changed the subject count:\n${withHidden}`);
assert.ok(!withHidden.includes(D), `a hidden character reached the prompt:\n${withHidden}`);
console.log("PASS render_prompt leaves a hidden character out");

console.log("\nPASS render_prompt cast");
