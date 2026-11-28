import assert from "node:assert/strict";
import { buildBeatsInput, conversationText, parseBeats, BEATS_LIMITS } from "../bin/agent/shot-beats.mjs";
import { beatFrames } from "../src/ai-reference-beats.js";

// The model's answer: one action per shot index, code fences and stray text around the JSON tolerated.
assert.deepEqual(parseBeats('```json\n{"shots":[{"index":2,"action":"At 4 s Ben  jumps."},{"index":1,"action":"At 0 s Ana runs."}]}\n```', 2), ["At 0 s Ana runs.", "At 4 s Ben jumps."]);
assert.equal(parseBeats("I could not see the shots.", 2), null);
assert.equal(parseBeats('{"shots":[{"index":5,"action":"x"}]}', 2), null, "an index outside the film is dropped");

// The conversation keeps user and agent words, newest first when it is long, and no tool noise.
const talk = conversationText([{ kind: "user", text: "make a chase" }, { kind: "tool", text: "objects.arrange" }, { kind: "assistant", text: "Two buildings are up." }]);
assert.equal(talk, "USER: make a chase\nAGENT: Two buildings are up.");
const long = conversationText(Array.from({ length: 200 }, (_, i) => ({ kind: "user", text: `message ${i} `.repeat(20) })));
assert.ok(long.length <= BEATS_LIMITS.transcriptChars && long.includes("message 199"), "a long conversation keeps its newest part");

// Each picture follows its label on the film clock.
const content = buildBeatsInput({ cast: ["Ana", "Ben"], shots: [{ index: 1, startS: 0, endS: 10, camera: "a slow push-in", inFrame: "Ana is in the centre of the frame." }], frames: [{ shotIndex: 1, atS: 4, dataUrl: "data:image/jpeg;base64,AAAA" }, { shotIndex: 1, atS: 4.5, dataUrl: "not an image" }] });
assert.match(content[0].text, /CAST: Ana; Ben/);
assert.match(content[0].text, /Shot 1 \(0-10 s\), camera: a slow push-in\. Measured: Ana is in the centre/);
assert.match(content[0].text, /the scene was made without the agent/);
assert.deepEqual(content.slice(1), [{ type: "text", text: "Shot 1 at 4 s:" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }]);

// Half-second pictures from each shot's first frame to its last, thinned evenly past the cap.
const picks = beatFrames([{ startFrame: 0, endFrame: 47 }, { startFrame: 48, endFrame: 95 }], 24);
assert.deepEqual(picks.slice(0, 3).map((pick) => pick.atS), [0, 0.5, 1]);
assert.equal(picks.filter((pick) => pick.shotIndex === 2)[0].frame, 48);
const many = beatFrames([{ startFrame: 0, endFrame: 1439 }], 24);
assert.equal(many.length, 30);
assert.equal(many.at(-1).frame, 1439);
console.log("verify-shot-beats: ok");
