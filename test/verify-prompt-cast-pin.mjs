#!/usr/bin/env node
// Pins the whole generation prompt for one and two subjects (#1213).
//
// The expected strings below are main's real output, captured before the cast
// became a list. They must not change: a prompt that already works for one or
// two characters keeps its exact words when a third character is supported.

import { composePrompt, deriveShot } from "../src/shot.js";

const EXPECTED = {
	onePosed: "Photorealistic cinematic film still, medium-wide shot at 24mm lens, eye level, seen from the front, the face toward the camera. Subject: a young woman in a tan coat, arms crossed, exactly matching the body pose and placement shown in the blocking frame. Environment: a sunlit modern living room. 35mm film look, the full figure with the environment clearly visible, deep focus. Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting. 16:9.",
	oneBare: "Photorealistic cinematic film still, medium-wide shot at 24mm lens, eye level, seen from the front, the face toward the camera. Subject: a young woman in a tan coat, exactly matching the body pose and placement shown in the blocking frame. Environment: a sunlit modern living room. 35mm film look, the full figure with the environment clearly visible, deep focus. Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting. 16:9.",
	two: "Photorealistic cinematic film still, medium-wide shot at 24mm lens, eye level, seen from the front, the face toward the camera. Two subjects. Subject 1: a young woman in a tan coat, arms crossed. Subject 2: an old man with a cane. Each subject exactly matches their own body pose and placement shown in the blocking frame. Environment: a sunlit modern living room. 35mm film look, the full figure with the environment clearly visible, deep focus. Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting. 16:9.",
	oneSheet: "Photorealistic cinematic film still, medium-wide shot at 24mm lens, eye level, seen from the front, the face toward the camera. The subject is the character from the attached character sheet, exactly matching the body pose and placement shown in the blocking frame. Environment: a sunlit modern living room. 35mm film look, the full figure with the environment clearly visible, deep focus. Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting. 16:9.",
	twoSheet: "Photorealistic cinematic film still, medium-wide shot at 24mm lens, eye level, seen from the front, the face toward the camera. Both subjects are the characters from the attached character sheet. Each one exactly matches their own body pose and placement shown in the blocking frame. Environment: a sunlit modern living room. 35mm film look, the full figure with the environment clearly visible, deep focus. Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting. 16:9.",
};

const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const base = { shot, environment: "a sunlit modern living room", style: "35mm film look" };
const woman = "a young woman in a tan coat";
const man = "an old man with a cane";

const ACTUAL = {
	onePosed: composePrompt({ ...base, subject: woman, posePhrase: "arms crossed" }),
	oneBare: composePrompt({ ...base, subject: woman }),
	two: composePrompt({ ...base, subject: woman, posePhrase: "arms crossed", subject2: man, pose2Phrase: "" }),
	oneSheet: composePrompt({ ...base, subject: woman, posePhrase: "arms crossed", hasCharSheet: true }),
	twoSheet: composePrompt({ ...base, subject: woman, posePhrase: "arms crossed", subject2: man, pose2Phrase: "waving", hasCharSheet: true }),
};

let failures = 0;
for (const [name, expected] of Object.entries(EXPECTED)) {
	const ok = ACTUAL[name] === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${name} prompt is unchanged${ok ? "" : `\n  expected: ${expected}\n  actual:   ${ACTUAL[name]}`}`);
	if (!ok) failures += 1;
}

if (failures) process.exit(1);
console.log("one- and two-subject prompt pin PASS");
