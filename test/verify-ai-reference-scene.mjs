import assert from "node:assert/strict";
import { MIN_HEIGHT_SHARE, shotScene, shotSceneText } from "../src/ai-reference-scene.js";
import { aiReferenceFacts, buildAiReferencePrompt } from "../src/ai-reference-prompt.js";

// A fixed camera at eye height looking down -z (yaw 0, pitch 0), 45 degrees vertical.
const camera = { pos: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, fovDeg: 45 };
const box = (x, z, w, h) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [[x + sx * w, 0, z + sz * w], [x + sx * w, h, z + sz * w]]));
const fps = 24;
const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

const entities = [
	// Mina walks from the left of the picture to the right, 6 m away, over the 4 s shot.
	{ id: "a", name: "Mina", kind: "character", pointsAt: (f) => box(lerp(-2, 2, f / 95), -6, 0.25, 1.8) },
	// A truck is off the right edge until 2 s, then drives in toward the middle.
	{ id: "t", name: "red truck", kind: "object", pointsAt: (f) => box(f < 48 ? 30 : lerp(12, 0, (f - 48) / 47), -14, 1.2, 2.5) },
	// A house stands behind them the whole shot.
	{ id: "h", name: "corner shop", kind: "object", pointsAt: () => box(-3, -20, 3, 6) },
	// A cup far away is too small to name.
	{ id: "c", name: "cup", kind: "object", pointsAt: () => box(0, -40, 0.05, 0.1) },
	// Something behind the camera is never in frame.
	{ id: "b", name: "van", kind: "object", pointsAt: () => box(0, 5, 1, 2) },
];
const scene = shotScene({ startFrame: 0, endFrame: 95, fps, aspect: 16 / 9, cameraAt: () => camera, entities });

assert.deepEqual(scene.map((e) => e.name), ["Mina", "corner shop", "red truck"], "characters first, then things by size; tiny and unseen things drop");
const mina = scene[0].spans;
assert.equal(mina.length, 1);
assert.equal(mina[0].enters, null, "in frame from the first frame");
assert.equal(mina[0].leaves, null);
assert.equal(mina[0].across, "left-to-right");
assert.equal(mina[0].moving, true);
const truck = scene[2].spans[0];
assert.equal(truck.enters, "right");
assert.ok(truck.fromS >= 2 && truck.fromS <= 2.6, `the truck enters near 2 s, got ${truck.fromS}`);
assert.equal(scene[1].spans[0].moving, false);
assert.ok(MIN_HEIGHT_SHARE > 0);

const text = shotSceneText(scene);
assert.match(text, /^Mina moves across the frame from left to right\./);
assert.match(text, /Red truck enters from the right at 2(\.\d)? s/);
assert.match(text, /Also in frame: corner shop\.$/);
assert.doesNotMatch(text, /cup|van/);

// The prompt carries it after the shot's camera and caption.
const facts = aiReferenceFacts({ shots: [{ startFrame: 0, endFrame: 95, caption: "Mina hurries to the shop" }], fps, shotCameras: [{ phrase: "static, locked-off shot" }], shotScenes: [scene] });
assert.equal(facts.shots[0].inFrame.length, 3, "scene-facts.json keeps the measured spans");
const prompt = buildAiReferencePrompt(facts);
assert.match(prompt, /Shot 1 \(0-4 s\), static, locked-off shot\. Mina hurries to the shop\. Mina moves across the frame from left to right\./);
// Without scene facts the prompt is exactly what it was.
assert.doesNotMatch(buildAiReferencePrompt(aiReferenceFacts({ shots: [{ startFrame: 0, endFrame: 95 }], fps })), /in frame/i);

// A person who leaves the frame part way.
const exit = shotScene({ startFrame: 0, endFrame: 95, fps, cameraAt: () => camera, entities: [
	{ id: "a", name: "Jun", kind: "character", pointsAt: (f) => box(lerp(0, -12, f / 60), -6, 0.25, 1.8) },
] });
assert.equal(exit[0].spans[0].leaves, "left");
assert.match(shotSceneText(exit), /^Jun .*leaves on the left at \d/);
console.log("verify-ai-reference-scene: ok");
console.log(text);
console.log(shotSceneText(exit));
