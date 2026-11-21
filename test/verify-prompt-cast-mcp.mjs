#!/usr/bin/env node
// render_prompt describes every visible character (#1213).
//
// Through the MCP handlers, without a server: a cast of three visible
// characters must reach the prompt as three subjects, the framed character
// first and the others in cast order. A hidden character stays out.
// This file has its own process because the handler module keeps state.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createToolHandlers, state } from "../mcp/tool-handlers.mjs";

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

await test("pose phrases bind to stable IDs across the full visible cast", async () => {
	const cast = state.doc.scenes.find(scene => scene.id === state.doc.activeSceneId).stage.characters.filter(character => !character.hidden);
	const poses = Object.fromEntries(cast.map((character, index) => [character.id, `POSE_${index}_SENTINEL`]));
	assert.deepEqual(tools.find(tool => tool.name === "render_prompt").inputSchema.pose_phrases.parse(poses), poses);
	const rendered = await call("render_prompt", { ...promptArgs, pose_phrases: poses });
	const ordered = [...cast].sort((left, right) => rendered.indexOf(left.subject) - rendered.indexOf(right.subject));
	for (const [index, character] of ordered.entries()) {
		const marker = poses[character.id], position = rendered.indexOf(marker);
		assert.equal(count(rendered, marker), 1, "every supplied pose survives exactly once");
		assert.ok(position > rendered.indexOf(character.subject), "the pose follows its own character description");
		if (ordered[index + 1]) assert.ok(position < rendered.indexOf(ordered[index + 1].subject), "another character cannot acquire this pose");
	}
	const legacy = await call("render_prompt", { ...promptArgs, pose_phrase: "LEGACY_FRAMED_SENTINEL", pose2_phrase: "LEGACY_NEXT_SENTINEL" });
	assert.equal(count(legacy, "LEGACY_FRAMED_SENTINEL"), 1);
	assert.equal(count(legacy, "LEGACY_NEXT_SENTINEL"), 1);
});

await test("28 cast members keep valid unique IDs and numbered report labels", async () => {
	const cast = () => state.doc.scenes.find(scene => scene.id === state.doc.activeSceneId).stage.characters;
	while (cast().length < 28) await call("add_character", { subject: `CAST_${cast().length}_SENTINEL`, x: cast().length, z: 0, facing: 0 });
	const ids = cast().map(character => character.id);
	assert.equal(new Set(ids).size, 28);
	for (const id of ids) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
	const report = await call("describe_scene", {});
	const rows = [...report.matchAll(/^\s+Character (\d+) (\S+)\s/gm)].map(match => ({ number: Number(match[1]), id: match[2] }));
	assert.deepEqual(rows, ids.map((id, index) => ({ number: index + 1, id })));
	const poses = Object.fromEntries(ids.map((id, index) => [id, `FULL_CAST_POSE_${index}_SENTINEL`]));
	const rendered = await call("render_prompt", { ...promptArgs, pose_phrases: poses });
	for (const character of cast()) assert.equal(count(rendered, poses[character.id]), character.hidden ? 0 : 1);
	const last = ids.at(-1);
	await call("place_character", { character: last, x: 91 });
	assert.equal(cast().find(character => character.id === last).x, 91);
	await call("remove_character", { character: ids[1] });
	assert.equal(cast().find(character => character.id === last).x, 91);
	assert.equal(cast().some(character => character.id === ids[1]), false);
});

await test("pose dictionaries use only supplied values for prototype-named IDs", async () => {
	const cast = state.doc.scenes.find(scene => scene.id === state.doc.activeSceneId).stage.characters;
	cast[0].id = "constructor";
	const empty = await call("render_prompt", { ...promptArgs, pose_phrases: Object.create(null) });
	assert.equal(await call("render_prompt", { ...promptArgs, pose_phrases: {} }), empty);
	const supplied = await call("render_prompt", { ...promptArgs, pose_phrases: { constructor: "OWN_POSE_SENTINEL" } });
	assert.equal(count(supplied, "OWN_POSE_SENTINEL"), 1);
});
