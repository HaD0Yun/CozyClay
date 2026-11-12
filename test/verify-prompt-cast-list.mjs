#!/usr/bin/env node
// composePrompt takes the cast as one list and describes every entry (#1213).

import { composePrompt, deriveShot } from "../src/shot.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const base = { shot, environment: "a sunlit modern living room", style: "35mm film look" };
const subjects = [
	{ description: "a young woman in a tan coat", posePhrase: "arms crossed" },
	{ description: "an old man with a cane", posePhrase: "" },
	{ description: "a child with a red balloon", posePhrase: "waving" },
];

const THREE =
	"Three subjects. Subject 1: a young woman in a tan coat, arms crossed. Subject 2: an old man with a cane. Subject 3: a child with a red balloon, waving. Each subject exactly matches their own body pose and placement shown in the blocking frame.";
const three = composePrompt({ ...base, subjects });
expect("three subjects get the three-subject sentence", three.includes(` ${THREE} Environment: a sunlit modern living room.`), three);

const SHEET =
	"All subjects are the characters from the attached character sheet. Each one exactly matches their own body pose and placement shown in the blocking frame.";
const sheeted = composePrompt({ ...base, subjects, hasCharSheet: true });
expect("three subjects with a character sheet get the all-subjects sentence", sheeted.includes(` ${SHEET} Environment: a sunlit modern living room.`), sheeted);
expect("the character sheet replaces every description", subjects.every((entry) => !sheeted.includes(entry.description)), sheeted);

const ten = Array.from({ length: 10 }, (_, i) => ({ description: `person ${i + 1}`, posePhrase: "" }));
const tenPrompt = composePrompt({ ...base, subjects: ten });
expect("ten subjects are spelled out", tenPrompt.includes("Ten subjects. Subject 1: person 1.") && tenPrompt.includes("Subject 10: person 10. Each subject"), tenPrompt);
const eleven = [...ten, { description: "person 11", posePhrase: "" }];
const elevenPrompt = composePrompt({ ...base, subjects: eleven });
expect("eleven subjects are counted in digits", elevenPrompt.includes("11 subjects. Subject 1: person 1.") && elevenPrompt.includes("Subject 11: person 11. Each subject"), elevenPrompt);

if (failures) process.exit(1);
console.log("composePrompt cast list PASS");
