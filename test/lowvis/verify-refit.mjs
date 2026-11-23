#!/usr/bin/env node
// A size change keeps the motion (bin/agent/motion-refit.mjs): the motion tool called without a request compiles each
// motion that plays again from the scene and spec kept with its takes, for the scale its characters have now, with no
// model, installs it and tells the engine's rows that are new or worse than at the old size.
//  1. the mechanism: the real engine, studioScene and installClip over a recording Studio; the take is replaced (its
//     size the new one, the kept scene the new scale), no scale is set (the character has it), no model is called
//  2. what it does not take over: a scene that changed otherwise (skipped: the writer is needed), a take that keeps no
//     spec (keptNone), a motion no size change touched (kept)
//  3. specs of this test's own, several scenes at sizes 0.6 to 1.3 (cube look): how often a spec's numbers, right for
//     the old size, come out with a new or worse row; printed, and every refit compiles and installs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip } from "../../src/lowvis/studio/install.js";
import { TRACK_RIG } from "../../src/lowvis/studio/take.js";
import { lookBody } from "../../src/lowvis/studio/figure.js";
import { decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { refitMotion } from "../../bin/agent/motion-refit.mjs";
import { keptTakes } from "../../bin/agent/motion-kept.mjs";
import { bodiesOf, bodyFitOf, rememberBodies } from "../../bin/agent/motion-fit.mjs";

const ENV = { COZYCLAY_FIGURE: "cube" }, B = lookBody("cube");
const box = (id, size, at, extra = {}) => ({ id, size, at, ...extra });
// scenes of this test's own: a hold of a prop, a seat, a hand at a world point, a place at a world point, a hand on a wall, a walk
const CASES = [
	{ name: "cup from a table", scene: { frames: 96, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [box("table", [0.8, 0.72, 0.6], [0, 0.36, 0.7]), box("cup", [0.08, 0.1, 0.08], [0.1, 0.77, 0.5], { moves: true })] }, spec: { a: [[10, "hold", { prop: "cup", hand: "R", over: 20 }], [40, "pose", { R: [-0.15, 0.35, 0.3], over: 20 }]] } },
	{ name: "sit on a stool", scene: { frames: 96, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [box("stool", [0.4, 0.45, 0.4], [0, 0.225, 1.2])] }, spec: { a: [[0, "walk", { to: [0, 0.85], heading: 180 }], [50, "sit", { on: "stool" }]] } },
	{ name: "hand at a world point", scene: { frames: 72, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [box("lamp", [0.2, 1.6, 0.2], [0.5, 0.8, 0.5])] }, spec: { a: [[10, "pose", { R: { world: [0.35, 1.45, 0.45] }, over: 20 }]] } },
	{ name: "a box placed on a shelf", scene: { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [box("crate", [0.3, 0.3, 0.3], [0, 0.85, 0.4], { moves: true }), box("shelf", [0.8, 1.2, 0.3], [0, 0.6, 0.9])] }, spec: { a: [[5, "carry", { prop: "crate", over: 15 }], [60, "place", { prop: "crate", at: [0, 1.35, 0.85], over: 30 }]] } },
	{ name: "a hand on a wall", scene: { frames: 72, characters: [{ id: "a", at: [0, 0], heading: 90 }], props: [box("wall", [0.2, 2, 2], [0.55, 1, 0])] }, spec: { a: [[5, "pose", { R: { on: "wall", at: [-0.1, 0.4, 0] }, over: 20 }]] } },
	{ name: "a walk to a mark", scene: { frames: 96, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: [[5, "walk", { to: [0.5, 2.4] }]] } },
];
const SIZES = [0.6, 0.8, 0.95, 1.1, 1.3];

/** The kept source of a motion written at scale 1: what the writer's last compile held (compile-tool.mjs state.last). */
function written(c, k) {
	const tool = createCompileTool({ name: `refit-src-${k}`, variant: "studio", figure: "cube" }), r = tool.call({ scene: c.scene, spec: c.spec });
	assert.equal(r.status, "ok", `${c.name}: ${r.error}`);
	return { name: `agent-20260101-00000${k}-src0`, scene: tool.state.last.scene, spec: tool.state.last.spec };
}
/** A Studio whose describe answer holds the motion: the props as Studio objects, character a at `scale`, its take keeping `source`. */
function studioOf(source, scale, { moved = 0, bare = false } = {}) {
	const objects = (source.scene.props ?? []).filter(p => !p.moves).map(p => ({ id: `obj-${p.id}`, name: p.id, renderer: "cube", x: p.at[0] + moved, y: p.at[1] - p.size[1] / 2, z: p.at[2], rot: 0, footprint: { width: p.size[0], depth: p.size[2] }, height: p.size[1] }));
	const characters = [{ id: "a", model: TRACK_RIG, x: 0, z: 0, rot: 0, scale }];
	const motionTake = bare ? { spec: { raw: {} } } : { spec: { lowvis: source } };
	const read = { document: { activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "a", motionTake }] } }] }, characters, objects };
	const steps = [];
	return { steps, hub: { command: async () => read }, invoke: async (action, args) => { steps.push([action, args]); return { affectedIds: [args?.characterId ?? args?.id ?? "x"] }; } };
}
const deps = { createCompileTool, installClip, studioScene, readClip: file => JSON.parse(readFileSync(file, "utf8")) };
const refit = studio => refitMotion({ hub: studio.hub, workspaceHandle: "ws", invoke: studio.invoke, env: ENV, deps });

// --- 1 and 2 ---
{
	const source = written(CASES[0], 0), studio = studioOf(source, 0.8), out = await refit(studio);
	assert.equal(out.refit.length, 1, JSON.stringify(out));
	const [done] = out.refit, installs = studio.steps.filter(([a]) => a === "motion.v4.install").map(([, args]) => args);
	assert.equal(done.from, source.name);
	assert.deepEqual(done.sizes, [{ id: "a", was: 1, now: 0.8 }]);
	assert.equal(installs.length, 1, "the take is replaced");
	assert.equal(decodeRawTrack(installs[0].raw, skeletonFor(TRACK_RIG)).scale, 0.8 * B, "of the new size");
	assert.deepEqual(installs[0].lowvis.spec, source.spec, "the spec as kept: nothing rescaled");
	assert.equal(installs[0].lowvis.scene.characters[0].scale, 0.8, "the kept scene now has the new scale");
	assert.equal(installs[0].lowvis.name, done.name);
	assert.ok(!studio.steps.some(([a, args]) => a === "character.update" && "scale" in (args.patch ?? {})), "no scale set: the character has it");
	assert.ok(Array.isArray(done.rows));
	console.log(`ok refit: compiled again at 0.8 and installed, rows told: ${done.rows.length ? done.rows.join(" | ") : "none"}`);

	// the body this conversation remembers for its fit lines (motion-fit.mjs) becomes the refit one
	rememberBodies("conv-refit", [{ id: "a", scale: 1, tint: null }]);
	await refitMotion({ ...studioOf(source, 0.8), workspaceHandle: "ws", memoryKey: "conv-refit", env: ENV, deps });
	assert.deepEqual(bodyFitOf(bodiesOf("conv-refit").get("a"), { scale: 0.8 }), [], "after the refit an edit of the character has no size line");
	assert.equal(bodiesOf("conv-other").size, 0, "a conversation that remembers no motion gets none");

	const same = await refit(studioOf(source, 1));
	assert.deepEqual([same.refit.length, same.kept.length], [0, 1], "no size changed: kept as it is");
	const moved = await refit(studioOf(source, 0.8, { moved: 0.3 }));
	assert.equal(moved.refit.length, 0);
	assert.match(moved.skipped[0].why, /more than a body's size or tint \(.*table: place.*\): the motion writer is needed/, moved.skipped[0]?.why);
	const over = await refit(studioOf(source, 3.5)); // a size the tool does not build (a row carried over from another look may hold it)
	assert.equal(over.refit.length, 0);
	assert.match(over.skipped[0].why, /^the engine did not compile it: .*want a number from 0\.2 to 3, got 3\.5/, over.skipped[0]?.why);
	const bare = await refit(studioOf(source, 0.8, { bare: true }));
	assert.deepEqual([bare.refit.length, bare.keptNone], [0, ["a"]], "a take that keeps no spec: told, nothing changed");
	console.log("ok refit: a scene changed otherwise is skipped for the writer, a take with no spec is told, an untouched motion is kept");
}

// --- 3: the sweep ---
{
	let runs = 0, missed = 0;
	const table = [];
	for (const [k, c] of CASES.entries()) {
		const source = written(c, k), row = [];
		for (const s of SIZES) {
			const studio = studioOf(source, s), out = await refit(studio);
			assert.equal(out.refit.length, 1, `${c.name} at ${s}: ${JSON.stringify(out.skipped)}`);
			assert.equal(studio.steps.filter(([a]) => a === "motion.v4.install").length, 1);
			const rows = out.refit[0].rows;
			runs++; if (rows.length) missed++;
			row.push(`${s}: ${rows.length ? rows.map(line => line.slice(2, 60)).join("; ") : "-"}`);
		}
		table.push(`${c.name}\n  ${row.join("\n  ")}`);
	}
	console.log(table.join("\n"));
	console.log(`ok sweep: ${runs} refits of ${CASES.length} scenes at ${SIZES.join(", ")}; ${missed} told a new or worse row`);
}
// --- 4: a motion made under an earlier body of the look (0.81): its take is of that size and the stored character was
// carried over to the scale that stands as large (scenes.js), so the refit finds no size change, and the follow-up and the
// refit start from the size the take plays; a resize after that is refit from that size ---
{
	const OLD = 0.81, carried = OLD / B, source = { ...written(CASES[1], 9), as: "a" };
	const studioAt = scale => {
		const s = studioOf(source, scale), command = s.hub.command;
		return { ...s, hub: { command: async () => { const read = await command(); read.document.scenes[0].stage = { figureBody: B, characters: [{ id: "a", motionTake: { spec: { lowvis: source, raw: { scale: OLD } } } }] }; return read; } } };
	};
	assert.ok(Math.abs(keptTakes(await studioAt(carried).hub.command()).kept.a.scene.characters[0].scale - carried) < 1e-6, "the kept scene has the size its take plays");
	const same = await refit(studioAt(carried));
	assert.deepEqual([same.refit.length, same.kept], [0, [{ name: source.name, characters: ["a"] }]], `no size change: ${JSON.stringify(same)}`);
	const grown = await refit(studioAt(1));
	assert.equal(grown.refit.length, 1, JSON.stringify(grown));
	assert.deepEqual(grown.refit[0].sizes, [{ id: "a", was: Math.round(carried * 1e6) / 1e6, now: 1 }], "a resize is told from the size the take played");
	console.log(`ok an earlier body's motion: kept at ${carried.toFixed(6)}; resized to 1 it is refit from that size (rows ${JSON.stringify(grown.refit[0].rows)})`);
}
console.log("PASS verify-refit");
