#!/usr/bin/env node
// A character imported from an FBX file (character-import.js), without a browser: the repo's own
// public/models/x-bot-tpose.fbx parsed by three's FBXLoader, as the asset store's mesh cache parses it. FBXLoader nests a
// same-name copy of every bone that two skinned meshes share (129 bones, 65 names); the import folds the copies.
//   (a) adaptCharacterScene reads 65 joints and detects mixamo; a copy that moved off its bone is still refused.
//   (b) playback: a standIdle + walkTo compiled on the adapted rig, baked at a placement and played with playTakeFrame,
//       puts the file's pelvis, feet, hands and head on the compiled joints, and every nested copy stays on its bone.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { adaptCharacterScene } from "../src/character-import.js";
import { registerCastRigs } from "../src/character-rig.js";
import { playTakeFrame } from "../src/character-playback.js";
import { buildImportedRig } from "../src/imported-rig-root.js";
import { createCharacterEntry } from "../src/scenes.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";
import { compileSpec } from "../src/motion3/pipeline.js";
import { bakeTake } from "../src/motion3/take.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = fn => { try { fn(); return null; } catch (error) { return error.message; } };
const bytes = readFileSync(new URL("../public/models/x-bot-tpose.fbx", import.meta.url));
const parse = () => new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), "");

// --- (a) read and adapt -----------------------------------------------------------------------------------------------
const source = parse(), all = [];
source.traverse(o => { if (o.isBone) all.push(o); });
const copies = all.filter(o => o.parent?.isBone && o.parent.name === o.name);
expect("the file nests same-name copies (the case under test)", all.length === 129 && new Set(all.map(o => o.name)).size === 65 && copies.length === 64,
	`${all.length} bones, ${copies.length} copies`);
const assetId = `mesh-${"cd".repeat(16)}`, fields = adaptCharacterScene(source, { assetId, name: "x-bot-fbx" });
const { report, raw, sources } = fields.rigImport;
expect("reads one joint per name", raw.bones.length === 65 && new Set(sources).size === 65, raw.bones.length);
expect("detects the mixamo names", report.detected.id === "mixamo" && report.missing.length === 0, JSON.stringify(report.detected));
const moved = parse();
let copy = null;
moved.traverse(o => { if (!copy && o.isBone && o.parent?.isBone && o.parent.name === o.name) copy = o; });
copy.position.x += 1;
expect("a same-name bone off its parent's place is still refused", /same name/.test(refusal(() => adaptCharacterScene(moved, { assetId })) ?? ""));

// --- (b) playback ---------------------------------------------------------------------------------------------------------
const entry = createCharacterEntry({ id: "char-9", x: 0, ...fields }, 0);
registerCastRigs([entry]);
const sk = skeletonFor(entry.model), placement = { position: [-0.5, 0, 0.8], yaw: -40 };
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 150, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [0.6, 1.4] } }] };
const { out } = compileSpec(spec, { sk, scene: { objects: {} } });
const take = bakeTake(sk, out, placement), rig = buildImportedRig(source, entry), stage = new THREE.Group();
stage.position.fromArray(placement.position);
stage.rotation.y = (placement.yaw * Math.PI) / 180;
stage.add(rig);
const JOINTS = ["Hips", "LeftFoot", "RightFoot", "LeftHand", "RightHand", "Head"], at = o => o.getWorldPosition(new THREE.Vector3());
const nested = [];
rig.traverse(o => { if (o.isBone && o.parent?.isBone && o.parent.name === o.name) nested.push(o); });
let worst = 0, drift = 0;
for (const f of [0, 75, take.frameCount - 1]) {
	playTakeFrame(rig, take, f);
	stage.updateMatrixWorld(true);
	for (const n of JOINTS) worst = Math.max(worst, at(rig.getObjectByName(report.retarget[n].source)).distanceTo(new THREE.Vector3(...out.frames[f].s.P[sk.index[n]])));
	for (const o of nested) drift = Math.max(drift, at(o).distanceTo(at(o.parent)));
}
expect("the file's bones play the take on the compiled joints (< 0.1 mm)", worst < 1e-4, `${(worst * 1000).toFixed(4)} mm`);
console.log(`  worst joint ${(worst * 1000).toExponential(2)} mm over 3 frames x ${JOINTS.length} joints`);
expect("every nested copy stays on its bone (< 0.1 mm)", nested.length === 64 && drift < 1e-4, `${nested.length} copies, ${(drift * 1000).toFixed(4)} mm`);
const hips = rig.getObjectByName(report.retarget.Hips.source), bindAt = raw.bones[sources.indexOf(report.retarget.Hips.source)].localPos;
expect("the pelvis moved off its bind", Math.hypot(...hips.position.toArray().map((v, i) => v - bindAt[i])) > 1);

console.log(failures ? `FAIL ${failures}` : "PASS all");
process.exit(failures ? 1 : 0);
