#!/usr/bin/env node
// The studio side of a character imported with a skeleton of its own (character-import.js, character-rig.js,
// character-playback.js, imported-rig-root.js), without a browser: the ue5 file built from the X Bot bind
// (fixtures/ue5-character-glb.mjs) parsed by three's GLTFLoader, as the asset store's mesh cache parses it.
//   (a) adaptCharacterScene reads and adapts it: detected ue5, cm, a per-file model id; files the player could not
//       drive are refused (no bones, two bones of one name, a non-bone node between two bones, a scaled joint).
//   (b) the project file keeps it: createCharacterEntry keeps the model, the rig and the report; an entry missing a
//       part falls back to the default body; the file's asset stays reachable (referencedAssetIds).
//   (c) playback: a standIdle + walkTo compiled on the adapted rig and baked at a placement, played with
//       playTakeFrame onto the rig root, puts the file's pelvis, feet, hands and head on the compiled joints in world
//       space; restoreImportedBind puts the bones back; a built-in take still goes to applyTakeFrame's Mixamo bones.
//   (d) a malformed entry (a project file, load_scenes, an agent patch): a report without Hips, a bone without its
//       localQuat, a rig without landmarks is dropped to the default body, registers nothing, and builds and plays
//       nothing without throwing; the compile path registers the cast through registerCastRigs.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildUe5Glb } from "./fixtures/ue5-character-glb.mjs";
import { adaptCharacterScene } from "../src/character-import.js";
import { registerCastRigs, isImportedCharacter, importedRigData } from "../src/character-rig.js";
import { playTakeFrame, restoreImportedBind } from "../src/character-playback.js";
import { buildImportedRig } from "../src/imported-rig-root.js";
import { createCharacterEntry } from "../src/scenes.js";
import { referencedAssetIds } from "../src/scene-assets.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";
import { compileSpec } from "../src/motion3/pipeline.js";
import { bakeTake } from "../src/motion3/take.js";
import { createStudioAppActions } from "../src/commands/index.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = fn => { try { fn(); return null; } catch (error) { return error.message; } };
const parse = async bytes => (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), "")).scene;

// --- (a) read and adapt -----------------------------------------------------------------------------------------------
const { bytes, names } = buildUe5Glb(), source = await parse(bytes), assetId = `mesh-${"ab".repeat(16)}`;
const fields = adaptCharacterScene(source, { assetId, name: "ue5-xbot" });
const { report, raw, sources } = fields.rigImport;
expect("detects the ue5 names", report.detected.id === "ue5" && report.template === "ue5", JSON.stringify(report.detected));
expect("reads centimetres", raw.units === "cm" && fields.rigImport.unitsDetected === true, raw.units);
expect("model id per file and template", fields.model === `rig-${"ab".repeat(8)}-auto`, fields.model);
expect("maps Hips to the file's pelvis", report.retarget.Hips.source === names.Hips && sources.includes(names.Hips), report.retarget.Hips.source);
const forced = adaptCharacterScene(source, { assetId, template: "ue5" });
expect("a forced template gets its own model id", forced.model === `rig-${"ab".repeat(8)}-ue5` && forced.rigImport.template === "ue5", forced.model);
expect("a file without bones is refused", /no skeleton/.test(refusal(() => adaptCharacterScene(new THREE.Group(), { assetId })) ?? ""));
const twin = await parse(bytes);
twin.getObjectByName(names.LeftHand).name = names.RightHand;
expect("two bones of one name are refused", /same name/.test(refusal(() => adaptCharacterScene(twin, { assetId })) ?? ""));
const helper = await parse(bytes), knee = helper.getObjectByName(names.LeftLeg), group = new THREE.Group();
knee.parent.add(group); group.add(knee);
expect("a non-bone node between two bones is refused", /not a bone/.test(refusal(() => adaptCharacterScene(helper, { assetId })) ?? ""));
const scaledRoot = await parse(bytes), armature = scaledRoot.getObjectByName("Armature"), root = Object.assign(new THREE.Bone(), { name: "root" });
root.scale.setScalar(0.01);
armature.scale.setScalar(1);
armature.add(root);
root.add(scaledRoot.getObjectByName(names.Hips));
expect("a joint with a scale is refused (a scaled armature above the joints is not)", /root has a scale/.test(refusal(() => adaptCharacterScene(scaledRoot, { assetId })) ?? ""), refusal(() => adaptCharacterScene(scaledRoot, { assetId })));

// --- (b) the project file -----------------------------------------------------------------------------------------------
const entry = createCharacterEntry({ id: "char-9", x: 1, ...fields }, 2);
expect("the entry keeps model, rig and report", entry.model === fields.model && isImportedCharacter(entry) && entry.rigImport.report.detected.id === "ue5");
expect("the entry is a copy", entry.rigImport !== fields.rigImport && entry.adaptedRig !== fields.adaptedRig);
const broken = createCharacterEntry({ id: "char-8", model: fields.model, adaptedRig: fields.adaptedRig }, 0);
expect("an entry without its rigImport is the default body", broken.model === "y-bot-tpose" && !("rigImport" in broken) && !("adaptedRig" in broken), broken.model);
const plain = createCharacterEntry({ id: "char-7", model: "x-bot-tpose" }, 0);
expect("a built-in entry gains no rig fields", plain.model === "x-bot-tpose" && !("rigImport" in plain));
expect("the file stays reachable", referencedAssetIds([{ stage: { characters: [entry] }, objects: [] }]).has(assetId));

// --- (c) playback ---------------------------------------------------------------------------------------------------------
registerCastRigs([entry]);
const sk = skeletonFor(entry.model), placement = { position: [1, 0, 0.4], yaw: 30 };
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 150, use: [{ skill: "standIdle", f0: 0, args: { at: [1, 0.4], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [1.5, 1.9] } }] };
const { out } = compileSpec(spec, { sk, scene: { objects: {} } });
const take = bakeTake(sk, out, placement), rig = buildImportedRig(source, entry), stage = new THREE.Group();
stage.position.fromArray(placement.position);
stage.rotation.y = (placement.yaw * Math.PI) / 180;
stage.add(rig);
const JOINTS = ["Hips", "LeftFoot", "RightFoot", "LeftHand", "RightHand", "Head"], worldOf = name => rig.getObjectByName(name).getWorldPosition(new THREE.Vector3()).toArray();
let worst = 0;
for (const f of [0, 75, take.frameCount - 1]) {
	playTakeFrame(rig, take, f);
	stage.updateMatrixWorld(true);
	for (const n of JOINTS) worst = Math.max(worst, Math.hypot(...worldOf(report.retarget[n].source).map((v, i) => v - out.frames[f].s.P[sk.index[n]][i])));
}
expect("the file's bones play the take on the compiled joints (< 0.1 mm)", worst < 1e-4, `${(worst * 1000).toFixed(4)} mm`);
console.log(`  worst joint ${(worst * 1000).toExponential(2)} mm over 3 frames x ${JOINTS.length} joints`);
const pelvis = rig.getObjectByName(names.Hips), bindAt = raw.bones[sources.indexOf(names.Hips)].localPos;
expect("the pelvis moved off its bind", Math.hypot(...pelvis.position.toArray().map((v, i) => v - bindAt[i])) > 1);
const playedFrame = take.frameCount - 1, beforeRestore = worldOf(names.LeftHand);
playTakeFrame(rig, take, playedFrame);
const unchanged = Math.hypot(...worldOf(names.LeftHand).map((v, i) => v - beforeRestore[i]));
expect("playing the same frame again is stable", unchanged < 1e-9, unchanged);
restoreImportedBind(rig, entry.model);
expect("restoreImportedBind puts the bones back", Math.hypot(...pelvis.position.toArray().map((v, i) => v - bindAt[i])) < 1e-9);
const xRig = new THREE.Group(), xHips = Object.assign(new THREE.Bone(), { name: "mixamorigHips" });
xRig.add(xHips);
const xSk = skeletonFor("x-bot-tpose"), xTake = bakeTake(xSk, compileSpec({ ...spec, frames: 30, use: [spec.use[0]] }, { sk: xSk, scene: { objects: {} } }).out, placement);
playTakeFrame(xRig, xTake, 10);
expect("a built-in take still plays on the Mixamo bones (applyTakeFrame)", Math.abs(xHips.position.y - xTake.hips[10 * 3 + 1] * 100) < 1e-3, xHips.position.y);

// --- (d) malformed entries -------------------------------------------------------------------------------------------------
const quiet = console.warn;
console.warn = () => {};
const BREAKS = { "a report without Hips": e => delete e.rigImport.report.retarget.Hips, "a bone without its localQuat": e => delete e.rigImport.raw.bones[3].localQuat,
	"a rig without landmarks": e => delete e.adaptedRig.landmarks };
Object.entries(BREAKS).forEach(([label, damage], n) => {
	const bad = structuredClone(fields), model = `rig-${String(n + 1).repeat(16)}-auto`;
	bad.model = model;
	damage(bad);
	const kept = createCharacterEntry({ id: "char-6", ...bad }, 0);
	expect(`${label}: dropped to the default body`, kept.model === "y-bot-tpose" && !("rigImport" in kept) && !isImportedCharacter(bad), kept.model);
	const built = refusal(() => expect(`${label}: buildImportedRig answers null`, buildImportedRig(source, bad) === null));
	expect(`${label}: buildImportedRig does not throw`, built === null, built);
	registerCastRigs([bad]);
	expect(`${label}: registers nothing`, importedRigData(model) === null && skeletonFor(model) === null);
	const played = refusal(() => expect(`${label}: its take plays nothing`, playTakeFrame(rig, { ...take, rig: model }, 3) === null));
	expect(`${label}: playTakeFrame does not throw`, played === null, played);
});
console.warn = quiet;
expect("a valid entry still registers and plays", isImportedCharacter(entry) && importedRigData(entry.model) && playTakeFrame(rig, take, 3) === undefined);
// a malformed imported character in the scene state (not normalized): the X Bot beside it still compiles, it is refused
const noLandmarks = structuredClone(fields), xBot = { id: "char-x", model: "x-bot-tpose", subject: "X", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
noLandmarks.model = `rig-${"7".repeat(16)}-auto`;
delete noLandmarks.adaptedRig.landmarks;
const castState = { characters: [xBot, { id: "char-bad", subject: "Bad", x: 2, y: 0, z: 0, rot: 0, scale: 1, ...noLandmarks }], objects: [], frameCount: 400 };
const compiled = new Map(), motionOwner = { replace: (cid, t) => compiled.set(cid, t), motionFor: cid => compiled.get(cid) ?? null };
const actions = createStudioAppActions({ state: () => castState, storeDomain: name => (name === "motion" ? motionOwner : null) });
const idle = { ...spec, frames: 30, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }] };
console.warn = () => {};
const xRun = refusal(() => actions.run("motion.compile", { characterId: "char-x", spec: idle, install: false }));
expect("an X Bot compiles beside a malformed imported character", xRun === null, xRun);
const badRun = refusal(() => actions.run("motion.compile", { characterId: "char-bad", spec: idle, install: false }));
expect("the malformed imported character's compile is refused with a sentence", /imported skeleton is incomplete/.test(badRun ?? ""), badRun);
console.warn = quiet;

console.log(failures ? `FAIL ${failures}` : "PASS all");
process.exit(failures ? 1 : 0);
