// The turn review's repair round: a failure that stays after a repair is sent again with its new numbers, a check the
// model ran over other frames or on an old receipt does not count as told, a subject fully hidden or out of the picture
// within its own shot is a failure, and a capsule figure is judged by its drawn surface (centre line plus radius).
import assert from "node:assert/strict";
import { createTurnReview, reviewedStart, reviewFindings } from "../bin/agent/studio-review.mjs";
import { placementChecks, framingChecks, sampledFramingChecks } from "../src/studio-agent-commands.js";
import { proxyFigureBounds } from "../src/character-kind.js";
import { PROXY_BODY_RADIUS } from "../src/proxy-figure-shape.js";

console.warn = () => {};
const hubAt = revision => ({ async command(name) { return name === "inspect_studio" ? { revision: { scene: revision.at }, relations: [], characters: [{ id: "hero" }], camera: {}, entityIds: ["hero", "lamp", "cube-1"] } : null; } });
const subject = (frame, id, codes, inFrame, hidden = 0) => ({ frame, codes, screenFraction: 0.5, subjects: [{ id, codes, inFrame, hidden }] });
const framing = (sampledFrames, issueFrames) => ({ checks: { framing: { sampledFrames, issueFrames } } });
const edit = id => [{ type: "tool.start", callId: id, name: "arrange_objects", args: {} }, { type: "tool.done", callId: id, ok: true, result: { authored: true, affectedIds: ["lamp"] } }];
const loop = async (runs, review) => {
	const inputs = [], frames = [];
	const start = async function* (input) { inputs.push(input); yield* runs[inputs.length - 1] ?? [{ type: "done" }]; };
	for await (const frame of reviewedStart({ start, now: () => 0, review })({ text: "go", attachments: [] })) frames.push(frame);
	return { inputs, text: frames.filter(f => f.type === "text.delta").map(f => f.text).join(""), reviewText: inputs.slice(1).map(i => i.review?.[0]?.text ?? "") };
};

// ---- defect 1: what an earlier round sent is sent again after a repair when it still fails ----
{
	const revision = { at: 1 }, measured = [];
	const invoke = async (_name, args) => (args.checks.includes("framing") ? measured.at(-1).framing : measured.at(-1).placement);
	const review = createTurnReview({ invoke, hub: hubAt(revision), workspaceHandle: "w" });
	const runs = [[...edit("a"), { type: "done" }], [...edit("b"), { type: "done" }], [{ type: "done" }]];
	const at = (n, m) => async (...args) => { revision.at = n; measured.push(m); return review(...args); };
	const cut50 = framing([0, 10], [subject(0, "hero", ["CLIPPED"], 0.5), subject(10, "hero", ["CLIPPED"], 0.5)]);
	const cut80 = framing([0, 10], [subject(10, "hero", ["CLIPPED"], 0.8)]);
	const lamp = { checks: { placement: { overlapIds: [], unsupportedIds: ["lamp"], supportGapM: { lamp: 0.4 } } } };
	let round = 0;
	const mixed = await loop(runs, (...args) => (round++ === 0 ? at(1, { framing: cut50, placement: { checks: { placement: { overlapIds: [] } } } }) : at(2, { framing: cut80, placement: lamp }))(...args));
	assert.equal(mixed.inputs.length, 3, "two review turns");
	assert.match(mixed.reviewText[1], /hero cut by the frame edge at frame 10 \(least in the picture: 80%/, "a failure that stays after a repair is sent again with its new value");
	assert.match(mixed.reviewText[1], /above what is under it: lamp/);
	// partial progress (50% -> 90%) is new numbers: the model gets another round
	round = 0;
	const cut90 = framing([0, 10], [subject(10, "hero", ["CLIPPED"], 0.9)]);
	const partial = await loop([[...edit("a"), { type: "done" }], [...edit("b"), { type: "done" }], [{ type: "done" }]], (...args) => (round++ === 0 ? at(3, { framing: cut50, placement: {} }) : at(4, { framing: cut90, placement: {} }))(...args));
	assert.equal(partial.inputs.length, 3, "partial progress is not the same failure back");
	// the same failure back after a repair ends the loop and the user hears it
	round = 0;
	const same = await loop([[...edit("a"), { type: "done" }], [...edit("b"), { type: "done" }]], (...args) => at(5 + round++, { framing: cut50, placement: {} })(...args));
	assert.equal(same.inputs.length, 2, "the same failure back: no third run");
	assert.match(same.text, /- framing: hero cut by the frame edge at frames 0–10 \(least in the picture: 50%/, "the user hears what stays (rule 7)");
}

// ---- defect 2: the model's own check of other frames does not answer the whole-clip review ----
{
	const whole = framing([0, 200, 250, 300], [subject(0, "hero", ["CLIPPED"], 0.9), subject(200, "hero", ["CLIPPED"], 0.1), subject(250, "hero", ["CLIPPED"], 0.3), subject(300, "hero", ["CLIPPED"], 0.5)]);
	const review = createTurnReview({ invoke: async (_n, args) => (args.checks.includes("framing") ? whole : null), hub: hubAt({ at: 7 }), workspaceHandle: "w" });
	const own = [{ revision: 7, evidenceRevision: 7, stale: false, checks: { framing: { sampledFrames: [0, 10], issueFrames: [subject(0, "hero", ["CLIPPED"], 0.9)] } } }];
	const result = await review({ edited: true, ids: [], motionIds: [], stage: false }, "go", { own });
	assert.deepEqual(result.findings, ["framing: hero cut by the frame edge at frames 0–300 (least in the picture: 10% of its body)"], "a check over frames 0-10 does not answer frames 200-300");
	const same = await review({ edited: true, ids: [], motionIds: [], stage: false }, "go", { own: [{ ...own[0], checks: whole.checks }] });
	assert.equal(same.content, null, "the same line from the model's own check of this revision: no review turn");
}

// ---- defect 3: a stale receipt is not a check of this revision ----
{
	const overlap = { checks: { placement: { overlapIds: ["cube-1"], maximumFootprintOverlapM: 0.3 } } };
	const review = createTurnReview({ invoke: async (_n, args) => (args.checks.includes("placement") ? overlap : null), hub: hubAt({ at: 7 }), workspaceHandle: "w" });
	const edits = { edited: true, ids: ["cube-1"], motionIds: [], stage: false };
	const stale = await review(edits, "go", { own: [{ revision: 7, evidenceRevision: 5, stale: true, ...overlap }] });
	assert.deepEqual(stale.findings, ["placement: overlapping another body: cube-1 (footprints overlap up to 0.3 m)"], "old evidence returned at revision 7 was not a measurement of revision 7");
	const fresh = await review(edits, "go", { own: [{ revision: 7, evidenceRevision: 7, stale: false, ...overlap }] });
	assert.equal(fresh.content, null);
}

// ---- defect 4: within one shot, a subject fully hidden or out of the picture is its worst value ----
const capsule = (id, x, extra = {}) => ({ id, model: "proxy-figure", posture: "stand", x, y: 0, z: 0, rot: 0, scale: 1, ...extra });
const box = (id, extra) => ({ id, name: id, renderer: "cube", x: 0, y: 0, z: 0, rotX: 0, rot: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, footprint: { width: 1, depth: 1 }, height: 1, hidden: false, ...extra });
const camera = { position: { x: 0, y: 1, z: 6 }, lookAt: { x: 0, y: 0.9, z: 0 }, focalMm: 35, sensorId: "fullFrame" };
const shotScene = (characters, objects = [], shots = [{ id: "s1", startFrame: 0, endFrame: 50 }]) => ({ frame: 0, floorY: 0, objects, characters, camera, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 }, shotDocument: { shots } });
const ports = { bounds: ({ entity }) => proxyFigureBounds(entity), sampleStateAt: (frame, state) => ({ ...state, frame, ...(state.at?.(frame) ?? {}) }) };
const samples = [0, 10, 20, 30, 40, 50];
{
	const wall = h => box("wall", { z: 3, footprint: { width: 3, depth: 0.2 }, height: h });
	const hiddenBy = h => ({ ...shotScene([capsule("A", 0)]), at: f => (f >= 20 && f <= 40 ? { objects: [wall(h)] } : {}) });
	const full = reviewFindings({ framing: { checks: { framing: sampledFramingChecks(["A"], hiddenBy(3), ports, samples) } } });
	assert.deepEqual(full, ["framing: A mostly hidden behind props at frames 20–40 (most hidden: 100%)"], "fully hidden inside its own shot is the worst value, not 'not in the shot'");
	const out = { ...shotScene([capsule("A", 0)]), at: f => (f >= 20 && f <= 40 ? { characters: [capsule("A", 8)] } : {}) };
	assert.deepEqual(reviewFindings({ framing: { checks: { framing: sampledFramingChecks(["A"], out, ports, samples) } } }), ["framing: A cut by the frame edge at frames 20–40 (least in the picture: 0% of its body)"], "out of the picture inside its own shot");
	// two shots: B is never in shot s1 (frames 0-10) and in s2 fully: not a failure of s1
	const two = { ...shotScene([capsule("A", 0), capsule("B", 20)], [], [{ id: "s1", startFrame: 0, endFrame: 15 }, { id: "s2", startFrame: 16, endFrame: 50 }]), at: f => (f >= 16 ? { camera: { ...camera, position: { x: 20, y: 1, z: 6 }, lookAt: { x: 20, y: 0.9, z: 0 } } } : {}) };
	const lines = reviewFindings({ framing: { checks: { framing: sampledFramingChecks(["B"], two, ports, samples) } } });
	assert.deepEqual(lines, [], "a figure out of a shot it is never in is not cut by that shot's edge");
}

// ---- defect 5: a capsule figure is its centre line plus radius ----
{
	const bounds = { bounds: ({ entity }) => (entity.model === "proxy-figure" ? proxyFigureBounds(entity) : null) };
	const pair = d => ({ frame: 0, floorY: 0, objects: [], characters: [capsule("a", 0), capsule("b", d)] });
	for (const d of [0.12, 0.2, 0.3, 0.4]) assert.deepEqual(placementChecks(["a"], pair(d), bounds).overlapIds, ["b"], `capsules ${d} m apart are inside each other`);
	assert.deepEqual(placementChecks(["a"], pair(0.5), bounds).overlapIds, [], "capsules 0.5 m apart only stand close");
	const crate = { frame: 0, floorY: 0, objects: [box("crate", { x: 0 })], characters: [capsule("fig", 0.5)] };
	assert.deepEqual(placementChecks(["fig"], crate, bounds).overlapIds, ["crate"], "a capsule centred on a crate face has half its body in the crate");
	for (const sink of [0.05, 0.1, 0.2]) {
		const stage = { frame: 0, floorY: 0, objects: [box("stage", { footprint: { width: 3, depth: 3 }, height: 0.5 })], characters: [capsule("fig", 0, { y: 0.5 - sink })] };
		assert.deepEqual(placementChecks(["fig"], stage, bounds).overlapIds, ["stage"], `feet ${sink} m under the stage top`);
	}
	const slab = { frame: 0, floorY: 0, objects: [box("floor", { footprint: { width: 10, depth: 10 }, height: 0.023 })], characters: [capsule("fig", 0, { y: 0.02 })] };
	assert.deepEqual(placementChecks(["fig"], slab, bounds).overlapIds, [], "3 mm in a floor slab is touching");
	// the frame edge: find where the centre line leaves the picture; a radius inside that, the skin is already cut
	const at = x => shotScene([capsule("fig", x)]);
	const coreOnly = { bounds: ({ entity }) => { const { radii: _, ...rest } = proxyFigureBounds(entity); return rest; } };
	let edge = 0;
	while (!framingChecks(["fig"], at(edge), coreOnly).clipped) edge += 0.01;
	assert.equal(framingChecks(["fig"], at(edge - PROXY_BODY_RADIUS / 2), bounds).clipped, true, "half the body width past the edge is cut");
	assert.equal(framingChecks(["fig"], at(edge - PROXY_BODY_RADIUS / 2), coreOnly).clipped, false, "the centre line alone missed it");
	assert.equal(framingChecks(["fig"], at(0), bounds).clipped, false, "a capsule in the middle of the picture is not cut");
}
console.log("PASS review repair");
