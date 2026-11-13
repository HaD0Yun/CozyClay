#!/usr/bin/env node
// promptSubjects maps the studio cast to composePrompt's subjects list (#1213).

import { strict as assert } from "node:assert";
import { promptSubjects } from "../src/prompt-cast.js";
import { DEFAULT_POSE } from "../src/poses.js";
import { composePrompt, deriveShot } from "../src/shot.js";

const placeholder = { id: "char-a", subject: "" };
const a = { id: "a", subject: "a courier", pose: { prompt: "running" } };
const b = { id: "b", subject: "a florist", pose: { prompt: "kneeling" } };
const c = { id: "c", subject: "a cyclist", pose: null };
const d = { id: "d", subject: "", pose: { prompt: "" } };
const hidden = (character) => ({ ...character, hidden: true });

assert.deepEqual(promptSubjects([a, b, c], placeholder), [
	{ description: "a courier", posePhrase: "running" },
	{ description: "a florist", posePhrase: "kneeling" },
	{ description: "a cyclist", posePhrase: DEFAULT_POSE.prompt },
], "every visible character, in cast order, with its own pose phrase");
console.log("PASS every visible character, in cast order, with its own pose phrase");

assert.deepEqual(promptSubjects([c, a, d], placeholder).map((entry) => entry.description), ["a cyclist", "a courier", "a person"], "cast order is kept");
assert.deepEqual(promptSubjects([d], placeholder), [{ description: "a person", posePhrase: "" }], "no subject reads as a person; an empty phrase stays empty");
console.log("PASS cast order is kept and a subject-less character is a person");

assert.deepEqual(promptSubjects([a, hidden(b), c], placeholder).map((entry) => entry.description), ["a courier", "a cyclist"], "the second member is hidden, the third is visible");
assert.deepEqual(promptSubjects([hidden(a), b], placeholder).map((entry) => entry.description), ["a florist"], "a hidden first member is left out");
assert.deepEqual(promptSubjects([a, { ...b, hidden: false }], placeholder).length, 2, "hidden: false is visible");
console.log("PASS hidden characters are left out (second hidden, third visible: first and third)");

const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const prompt = composePrompt({ shot, environment: "a street", style: "film", subjects: promptSubjects([a, hidden(b), c], placeholder) });
assert.ok(
	prompt.includes(`Two subjects. Subject 1: a courier, running. Subject 2: a cyclist, ${DEFAULT_POSE.prompt}. Each subject`),
	`the prompt names the first and third characters:\n${prompt}`,
);
assert.ok(!prompt.includes("a florist"), `the hidden second character reached the prompt:\n${prompt}`);
console.log("PASS the prompt for a hidden second and visible third character names the first and the third");

// The studio passes charA as the fallback: the first cast member, or a placeholder for an empty cast.
const allHidden = [hidden(a), hidden(b)];
assert.deepEqual(promptSubjects(allHidden, allHidden[0]), [{ description: "a courier", posePhrase: "running" }], "none visible: the first cast member");
assert.deepEqual(promptSubjects([], placeholder), [{ description: "a person", posePhrase: DEFAULT_POSE.prompt }], "empty cast: the placeholder");
console.log("PASS with no visible character the list is the first cast member alone");

const noSubjects = composePrompt({ shot, environment: "a street", style: "film", subjects: [] });
const neutral = composePrompt({ shot, environment: "a street", style: "film", subjects: [{ description: "a person", posePhrase: "" }] });
assert.equal(noSubjects, neutral, "an empty list reads as one neutral subject");
console.log("PASS composePrompt with an empty list describes one neutral subject");

console.log("\npromptSubjects PASS");
