import assert from "node:assert/strict";
import { aiReferenceFacts, buildAiReferencePrompt } from "../src/ai-reference-prompt.js";
import { aiReferenceEntries } from "../src/ai-reference-pack.js";

// The night-street previs the rules were found on: 4 shots, cuts at 1.6 / 6.7 / 20.1 s.
const shots = [
	{ name: "Truck", startFrame: 0, endFrame: 37, caption: "A black luxury pickup rolls toward us; the driver flicks his cigarette ash out of the window" },
	{ name: "Corner", startFrame: 38, endFrame: 159, caption: "The hitman waits on his motorcycle at the corner, then follows the truck" },
	{ name: "Hit", startFrame: 160, endFrame: 482, caption: "" },
	{ name: "Away", startFrame: 483, endFrame: 719 },
];
const shotCameras = [
	{ phrase: "a fast push-in (dolly in) from a medium shot to a close-up", focalMm: 50.2 },
	{ phrase: "a crane down, the camera sinking from high angle to eye level, then a tracking move", focalMm: 50 },
	{ phrase: "a tracking move, then a slow pull-out (dolly out) from a medium shot to a wide shot", focalMm: 50 },
	{ phrase: "a slow orbit around the subject, arcing 150 degrees", focalMm: 35 },
];
const facts = aiReferenceFacts({ shots, fps: 24, cast: ["Driver", " Hitman ", ""], shotCameras, setting: "  New York, Lower East Side at night  " });

assert.equal(facts.durationS, 30, "the last shot ends at 720 frames = 30 s");
assert.deepEqual(facts.cuts, [1.58, 6.67, 20.13], "a cut is every shot start after the first");
assert.deepEqual(facts.cast, ["Driver", "Hitman"], "empty names drop, names are trimmed");
assert.equal(facts.setting, "New York, Lower East Side at night");
assert.equal(facts.shots[0].focalMm, 50);
assert.equal(facts.shots[3].lens, "normal");
assert.equal(facts.shots[2].action, "");
assert.equal(facts.shots[3].action, "", "a shot without a caption has no action");
assert.ok(facts.shots.every((shot) => shot.moving));

const prompt = buildAiReferencePrompt(facts);
const paragraphs = prompt.split("\n\n");
assert.equal(paragraphs.length, 5, "roles, damaged copy, place, shots, live action");
assert.equal(paragraphs[0], "@img1 is Driver. @img2 is Hitman. Use these images only for faces and clothes, not their poses or backgrounds.");
assert.match(paragraphs[1], /^@vid1 is a badly compressed low-resolution copy of the film\./);
assert.match(paragraphs[1], /rough placeholders; fill the place in fully/);
assert.equal((prompt.match(/@vid1/g) ?? []).length, 1, "the video is named exactly once");
assert.doesNotMatch(prompt, /previs|storyboard|mosaic|keyframe|guide|blockout|exactly/i, "the prompt never names the method or points at the reference's look");
assert.equal(paragraphs[2], "New York, Lower East Side at night. The film has 4 shots, and the camera keeps moving inside each one.");
assert.match(paragraphs[3], /^Shot 1 \(0-1\.6 s\), 50mm, one continuous move: a fast push-in \(dolly in\) from a medium shot to a close-up\. A black luxury pickup rolls toward us; the driver flicks his cigarette ash out of the window\. /);
assert.match(paragraphs[3], /Cut to shot 2 \(1\.6-6\.7 s\), 50mm, one continuous move: a crane down/);
assert.match(paragraphs[3], /Cut to shot 3 \(6\.7-20\.1 s\), 50mm, one continuous move: a tracking move, then a slow pull-out \(dolly out\) from a medium shot to a wide shot\. Cut to shot 4/, "a shot without a caption is its camera only");
assert.match(paragraphs[3], /Cut to shot 4 \(20\.1-30 s\), 35mm, one continuous move: a slow orbit around the subject, arcing 150 degrees\.$/);
assert.equal(paragraphs[4], "Real live-action footage shot on 35mm film, natural light, visible film grain. No on-screen text.");

// Static shots, no cast, no setting: the shape line says nothing about moving.
const still = buildAiReferencePrompt(aiReferenceFacts({
	shots: [{ startFrame: 24, endFrame: 47 }, { startFrame: 0, endFrame: 23, caption: "She waits." }],
	fps: 24,
	shotCameras: [{ phrase: "static, locked-off shot" }, {}],
}));
const stillParagraphs = still.split("\n\n");
assert.equal(stillParagraphs.length, 4, "no cast paragraph without a cast");
assert.match(stillParagraphs[0], /^@vid1 is/);
assert.equal(stillParagraphs[1], "The film has 2 shots.");
assert.equal(stillParagraphs[2], "Shot 1 (0-1 s), static, locked-off shot. She waits. Cut to shot 2 (1-2 s), static, locked-off shot.", "shots are ordered by start frame");

// One moving shot.
const one = buildAiReferencePrompt(aiReferenceFacts({ shots: [{ startFrame: 0, endFrame: 47 }], fps: 24, shotCameras: [{ phrase: "a slow pan to the left" }] }));
assert.match(one, /The film is one shot, and the camera keeps moving\./);
assert.match(one, /Shot 1 \(0-2 s\), one continuous move: a slow pan to the left\./);

// The pack carries the prompt and the facts, and its README explains the tags.
const entries = aiReferenceEntries({
	video: new Uint8Array([0]), fps: 24, frameCount: 720, shotCount: 4, size: { width: 1280, height: 720 },
	extra: [{ name: "prompt.txt", data: `${prompt}\n` }, { name: "scene-facts.json", data: JSON.stringify(facts) }],
});
assert.deepEqual(entries.map((entry) => entry.name), ["reference.mp4", "prompt.txt", "scene-facts.json", "README.txt"]);
assert.match(entries.at(-1).data, /prompt\.txt: paste it as the prompt/);
assert.match(entries.at(-1).data, /Krea: @vid-1, @img-1/);
const bare = aiReferenceEntries({ video: new Uint8Array([0]), fps: 24, frameCount: 24, shotCount: 1, size: { width: 1280, height: 720 } });
assert.doesNotMatch(bare.at(-1).data, /prompt\.txt/, "no prompt line without a prompt");

console.log("AI reference prompt verified");
