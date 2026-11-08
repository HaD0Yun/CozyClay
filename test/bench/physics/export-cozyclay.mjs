#!/usr/bin/env node
// CozyClay project document -> take.json (docs/qa/physics-bench.md, PR 2). The harness exports, never the agent:
// it saves the Studio's document (window.__cozyclayProject.export) and this compiles char-a's installed spec again
// in Node with the same compileSpec and motionScene the Studio runs (as test/bench/motion-track.mjs does). The
// compile's per-frame world bone frames (out.frames[i].s.P, .R) are the take; scene bodies are their boxes at their
// centres (object-pose.js objectBoxesAt), groups their root pose.
//   node test/bench/physics/export-cozyclay.mjs <doc.cclayproject> <set id or task> --out take.json [--run n]
import { readFileSync } from "node:fs";
import { compileSpec } from "../../../src/motion3/pipeline.js";
import { objectBoxesAt, rootPoseAt } from "../../../src/motion3/object-pose.js";
import { skeletonFor } from "../../../src/motion3/rigs/index.js";
import { motionScene } from "../../../src/motion3/scene.js";
import { placedOut } from "../../../src/motion3/shot-framing.js";
import { activeScene } from "../motion-track.mjs";
import { loadSets } from "./sets.mjs";
import { RIG, mat4, writeTake } from "./take.mjs";

const apply = (R, v) => [0, 1, 2].map(i => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// The turn build-cozyclay.mjs gives a cylinder along X (rotZ -90) or Z (rotX 90). The take keeps the set's axes as an
// object's rest axes, so this turn comes off the body's pose.
const ALIGN = { x: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], z: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] };
const mul = (A, B) => [0, 1, 2].map(i => [0, 1, 2].map(j => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));
const T = R => [0, 1, 2].map(i => [R[0][i], R[1][i], R[2][i]]);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/** One object's matrices over the compiled frames; a still one keeps a single matrix. */
function objectTrack(out, o, frames) {
	const f0 = out.f0 ?? 0, still = mat4(I3, o.center), align = o.shape === "cylinder" ? ALIGN[o.axis] : null;
	const ms = [];
	for (let i = 0; i < frames; i++) {
		if (o.shape === "group") { const r = rootPoseAt(out, o.id, f0 + i); ms.push(r ? mat4(r.R, r.pos) : still); continue; }
		const box = objectBoxesAt(out, o.id, f0 + i)?.[0];
		ms.push(box ? mat4(align ? mul(box.R, T(align)) : box.R, apply(box.R, [0, box.half[1], 0]).map((v, k) => v + box.pos[k])) : still);
	}
	return ms.every(m => same(m, ms[0])) ? [ms[0]] : ms;
}

/** take.json for a document the Studio saved after a run. Throws when char-a has no installed take. */
export function takeFromDoc(doc, set, source = {}) {
	const scene = activeScene(doc), id = set.character.id;
	const character = (scene?.stage?.characters ?? []).find(c => c.id === id);
	const spec = character?.motionTake?.schema === "cozyclay.take.v3" ? character.motionTake.spec : null;
	if (!spec) throw new Error(`${id} has no installed take`);
	const sk = skeletonFor(character.motionTake.rig ?? character.model);
	if (sk?.model !== RIG.name) throw new Error(`${id} is ${character.model}, the bench needs ${RIG.name}`);
	const r = compileSpec({ fps: 24, ...spec }, { sk, scene: motionScene(scene.objects ?? []) });
	// The bones where the Studio shows them: the take moved from where it was made to where the character stands now
	// (studio-motion-visual.js), as the Blender take carries the armature's placement.
	const placed = placedOut(r.out, character.motionTake.placement, character);
	const frames = r.out.frames.length;
	const objects = {};
	for (const o of set.objects) {
		objects[o.id] = { shape: o.shape, size: o.size ?? null, fixed: Boolean(o.fixed), mass: o.mass ?? null, parent: o.parent ?? null, matrix: objectTrack(r.out, o, frames) };
	}
	return {
		version: 0, fps: 24, frames, rig: RIG,
		characters: { [id]: { bones: placed.frames.map(fr => fr.s.P.map((p, b) => mat4(fr.s.R[b], p))) } },
		objects, source: { tool: "cozyclay", set: set.id, f0: r.out.f0 ?? 0, qa: { ok: r.qa.ok, total: r.qa.total }, ...source },
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [docPath, which] = process.argv.slice(2), at = process.argv.indexOf("--out"), run = process.argv.indexOf("--run");
	const [set] = loadSets([which]);
	if (!docPath || !set || at < 0) { console.error("usage: export-cozyclay.mjs <doc> <set> --out take.json [--run n]"); process.exit(2); }
	const take = takeFromDoc(JSON.parse(readFileSync(docPath, "utf8")), set, run > 0 ? { run: Number(process.argv[run + 1]) } : {});
	writeTake(process.argv[at + 1], take);
	console.log(`${set.id}: ${take.frames} frames -> ${process.argv[at + 1]}`);
}
