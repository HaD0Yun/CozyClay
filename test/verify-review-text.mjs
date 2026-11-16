// What the turn's review tells the model (bin/agent/review-findings.mjs, studio-review.mjs): one line per distinct
// finding, findings that are true for what a viewer sees, and nothing the model was already told.
import assert from "node:assert/strict";
import { reviewFindings, createTurnReview, reviewedStart } from "../bin/agent/studio-review.mjs";
import { frameRuns } from "../bin/agent/review-findings.mjs";
import { placementChecks, sampledFramingChecks } from "../src/studio-agent-commands.js";
import { proxyFigureBounds } from "../src/character-kind.js";

console.warn = () => {};

// ---- 1. one line per distinct finding ----
assert.equal(frameRuns([0, 72, 144, 287], [0, 72, 144, 215, 287, 359]), "0–144, 287");
const everyFrame = [0, 72, 144, 215, 287, 359];
const issue = (frame, subjects) => ({ frame, codes: [...new Set(subjects.flatMap(s => s.codes))], screenFraction: 0.5, subjects });
// the shape one recorded review had: the same two codes at all six samples, once a line per frame
const legacy = reviewFindings({ framing: { checks: { framing: { sampledFrames: everyFrame, issueFrames: everyFrame.map(frame => ({ frame, codes: ["CLIPPED", "OCCLUDED"] })) } } } });
assert.deepEqual(legacy, ["framing: CLIPPED, OCCLUDED at frames 0–359"], "an editor that does not name subjects: one line per set of codes");
const cut = reviewFindings({ framing: { checks: { framing: { sampledFrames: everyFrame, issueFrames: [287, 359].map(frame => issue(frame, [{ id: "man", codes: ["CLIPPED"], inFrame: frame === 287 ? 0.85 : 0.6, hidden: 0 }])) } } } });
assert.deepEqual(cut, ["framing: man cut by the frame edge at frames 287–359 (least in the picture: 60% of its body)"], "many frames, one line, the worst value");
const floating = reviewFindings({ placement: { checks: { placement: { overlapIds: [], unsupportedIds: ["lamp", "cup"], supportGapM: { lamp: 0.4, cup: 1.68 } } } } });
assert.deepEqual(floating, ["placement: floating over 1 cm: lamp, cup (highest gap 1.68 m)"]);

// ---- 2. findings true for what a viewer sees ----
const capsule = (id, x, extra = {}) => ({ id, model: "proxy-figure", posture: "stand", x, y: 0, z: 0, rot: 0, scale: 1, ...extra });
const box = (id, extra) => ({ id, name: id, renderer: "cube", x: 0, y: 0, z: 0, rotX: 0, rot: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, footprint: { width: 1, depth: 1 }, height: 1, hidden: false, ...extra });
const bare = ({ entity }) => { const { min, max } = proxyFigureBounds(entity); return { min, max }; };
// 2a. a capsule figure standing on a floor slab whose top is 3 mm above its feet
const slab = { frame: 0, floorY: 0, characters: [capsule("fig", 0, { y: 0.02 })], objects: [box("floor", { footprint: { width: 10, depth: 10 }, height: 0.023 })] };
assert.deepEqual(placementChecks(["fig"], slab, { bounds: bare }).overlapIds, ["floor"], "before: a capsule had no body points, so its box against the slab counted as overlap");
assert.deepEqual(placementChecks(["fig"], slab, { bounds: ({ entity }) => proxyFigureBounds(entity) }).overlapIds, [], "a capsule on a slab does not stand in it");
const table = { ...slab, objects: [box("table", { height: 0.75 })] };
assert.deepEqual(placementChecks(["fig"], table, { bounds: ({ entity }) => proxyFigureBounds(entity) }).overlapIds, ["table"], "a capsule standing in a table still does");
// 2b. two rigged bodies 1.9 m apart whose hands meet: 20 finger bones at each hand, as a 65-bone rig has
const rigBody = (x, reach) => {
	const points = [];
	for (let y = 0.1; y <= 1.75; y += 0.1) points.push({ x, y, z: 0 });
	for (let i = 0; i < 20; i++) points.push({ x: reach + (i % 5) * 0.004, y: 1.0 + Math.floor(i / 5) * 0.004, z: 0 });
	const xs = points.map(p => p.x);
	return { min: { x: Math.min(...xs) - 0.1, y: 0, z: -0.15 }, max: { x: Math.max(...xs) + 0.1, y: 1.8, z: 0.15 }, points, bones: [] };
};
const handOff = { frame: 0, floorY: 0, objects: [], characters: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 1.9, z: 0 }] };
const at = { a: rigBody(0, 0.93), b: rigBody(1.9, 0.95) };
assert.deepEqual(placementChecks(["a", "b"], handOff, { bounds: ({ entity }) => at[entity.id] }).overlapIds, [], "hands that meet are not two bodies in each other");
const inside = { a: rigBody(0, 0.5), b: rigBody(0.05, 0.55) };
assert.deepEqual(placementChecks(["a", "b"], handOff, { bounds: ({ entity }) => inside[entity.id] }).overlapIds.sort(), ["a", "b"], "a body standing in another still overlaps");
// 2c. two shots: frames 0-10 frame A, frame 20 frames B; each figure is out of the other's shot
const camOn = x => ({ position: { x, y: 1, z: 5 }, lookAt: { x, y: 0.9, z: 0 }, focalMm: 35, sensorId: "fullFrame" });
const two = (b, cameraAt20, pose = {}) => ({ frame: 0, floorY: 0, objects: [], characters: [capsule("A", 0), capsule("B", b, pose)], camera: camOn(0), filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 }, cameraAt20 });
const sampleStateAt = (frame, state) => (frame < 20 ? state : { ...state, frame, camera: state.cameraAt20 });
const ports = { bounds: ({ entity }) => proxyFigureBounds(entity), sampleStateAt };
const review = state => sampledFramingChecks(["A", "B"], state, ports, [0, 10, 20]);
const shots = review(two(20, camOn(20)));
assert.deepEqual(shots.issueFrames.map(i => i.frame), [0, 10, 20], "the cast as a whole fails every sample");
assert.deepEqual(reviewFindings({ framing: { checks: { framing: { ...shots, issueFrames: shots.issueFrames.map(({ subjects: _, ...rest }) => rest) } } } }), ["framing: CLIPPED at frames 0–20"], "before: the review sent that as a failure");
assert.deepEqual(reviewFindings({ framing: { checks: { framing: shots } } }), [], "a figure out of a shot it is not in is not cut by its edge");
const never = review(two(20, camOn(0)));
assert.deepEqual(reviewFindings({ framing: { checks: { framing: never } } }), ["framing: not in the picture at any of the 3 sampled frames: B"], "a figure no sample shows is said once");
// B lies from x 2 to 3.7: a quarter of it in A's shot (frames 0-10), all of it in its own (frame 20)
const edge = review(two(2, camOn(2.5), { posture: "lie", rot: 90 }));
const edgeLines = reviewFindings({ framing: { checks: { framing: edge } } });
assert.equal(edgeLines.length, 1, JSON.stringify(edge.issueFrames));
assert.match(edgeLines[0], /^framing: B cut by the frame edge at frames 0–10 \(least in the picture: \d+% of its body\)$/, "a figure the frame edge cuts is still a failure");

// ---- 3. nothing the model was already told ----
const hub = { async command(name) { return name === "inspect_studio" ? { revision: { scene: 7 }, relations: [], characters: [{ id: "hero" }], camera: {}, entityIds: ["cube-1", "hero"] } : null; } };
const failing = { checks: { placement: { overlapIds: ["cube-1"], maximumFootprintOverlapM: 0.3 }, framing: { sampledFrames: [0, 10], issueFrames: [issue(0, [{ id: "hero", codes: ["OCCLUDED"], inFrame: 1, hidden: 0.7 }])] } } };
const turnReview = createTurnReview({ invoke: async () => failing, hub, workspaceHandle: "w" });
const edits = { edited: true, ids: ["cube-1"], motionIds: [], stage: false };
const plain = await turnReview(edits, "go");
assert.deepEqual(plain.findings, ["placement: footprints overlap for cube-1 (deepest 0.3 m)", "framing: hero mostly hidden behind props at frame 0 (most hidden: 70%)"]);
const ownCheck = { revision: 7, checks: { placement: { overlapIds: ["cube-1"] } } };
assert.deepEqual((await turnReview(edits, "go", { own: [ownCheck] })).findings, [plain.findings[1]], "the model's own check of this revision already gave it the overlap");
assert.deepEqual((await turnReview(edits, "go", { own: [{ ...ownCheck, revision: 6 }] })).findings, plain.findings, "a check of an earlier revision does not count");
const allTold = await turnReview(edits, "go", { told: new Set(plain.keys) });
assert.deepEqual([allTold.content, allTold.findings, allTold.left], [null, [], plain.findings], "nothing new: no review turn, and what still fails is kept for the user");

// the loop: a repair that brings back only what was sent ends the turn; the model's own answer is not repeated
const edit = (id, extra = []) => [{ type: "tool.start", callId: id, name: "arrange_objects", args: {} }, { type: "tool.done", callId: id, ok: true, result: { authored: true, affectedIds: ["cube-1"] } }, ...extra];
const loop = async (runs, reviewFn) => {
	const inputs = [], frames = [];
	const start = async function* (input) { inputs.push(input); yield* runs[inputs.length - 1] ?? [{ type: "done" }]; };
	for await (const frame of reviewedStart({ start, now: () => 0, review: reviewFn })({ text: "go", attachments: [] })) frames.push(frame);
	return { inputs, frames, text: frames.filter(f => f.type === "text.delta").map(f => f.text).join("") };
};
const again = await loop([[...edit("a"), { type: "done" }], [...edit("b"), { type: "done" }], [...edit("c"), { type: "done" }]], turnReview);
assert.equal(again.inputs.length, 2, "one review turn: the second review has nothing new");
assert.match(again.text, /Still failing after a repair, left as it is:\n- placement: footprints overlap for cube-1/, "the user hears what stays (rule 7)");
const verified = [{ type: "tool.start", callId: "v", name: "verify_result", args: {} }, { type: "tool.done", callId: "v", ok: true, result: failing.checks && { revision: 7, checks: failing.checks } }];
const knew = await loop([[...edit("a", verified), { type: "done" }]], turnReview);
assert.deepEqual([knew.inputs.length, knew.text], [1, ""], "the model's own check of this revision found the same: no review turn");
console.log("PASS review text");
