// Which character a follow or rail shot follows: the pick (subjectIds, or a rail's
// aim.ids) wins over the selected character, survives saving and duplicating,
// and a removed pick never hands the camera to another character.
import assert from "node:assert/strict";
import { createCameraBlock, updateCameraBlock } from "../src/camera-block.js";
import { buildShotCameraTracks, castAimPoint, shotSubjectTrack } from "../src/camera-direction.js";
import { duplicateShot } from "../src/cuts.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";

const frames = 48;
const characters = [{ id: "char-a", name: "Ada", x: -4, z: 0, rot: 0 }, { id: "char-b", name: "Bo", x: 4, z: 0, rot: 0 }];
const rail = [{ x: -2, z: 6 }, { x: 2, z: 6 }];
const railShot = (extra = {}, camera = createCameraBlock({ mode: "rail", cameraRail: rail })) =>
	({ id: "shot-1", name: "Rail", startFrame: 0, endFrame: frames - 1, cameraKeys: [], camera, ...extra });
const tracks = (shot, cast = characters, activeId = "char-a") => {
	const state = { characters: cast, objects: [], shots: [shot], frameCount: frames, fps: 24, activeId, clipOf: () => null };
	return buildShotCameraTracks({ shots: [shot], subjectTrack: shotSubjectTrack(state), fps: 24, aimAt: (id, frame) => castAimPoint(id, frame, state) });
};
const aimsAt = (sample, x) => Math.abs(sample.yaw - Math.atan2(-(x - sample.pos.x), -(0 - sample.pos.z))) < 0.05;

// Untouched: the selected character is followed, as before.
const untouched = tracks(railShot());
assert.ok(aimsAt(untouched[frames - 1], -4), "no pick follows the selected character (Ada)");
assert.ok(aimsAt(tracks(railShot(), characters, "char-b")[frames - 1], 4), "and changes with the selection");

// Picked: Bo is followed whatever is selected, on a rail and on a free follow shot.
const picked = railShot({ subjectIds: ["char-b"] });
assert.ok(aimsAt(tracks(picked)[frames - 1], 4), "the picked character is followed while Ada is selected");
const follow = { ...picked, camera: createCameraBlock({ mode: "follow" }) };
const followed = tracks(follow);
assert.ok(followed.every(Boolean) && Math.hypot(followed[0].pos.x - 4, followed[0].pos.z) < 4, "a follow shot rides with the picked character");
// two picked: their middle
assert.ok(aimsAt(tracks(railShot({ subjectIds: ["char-a", "char-b"] }))[frames - 1], 0), "two picks: their middle");
// a rail aimed at a cast names its pick in aim.ids, marked as picked by hand
const aimedPick = railShot({}, updateCameraBlock(createCameraBlock({ mode: "rail", cameraRail: rail }), { aim: { ids: ["char-b"], picked: true } }));
assert.ok(aimsAt(tracks(aimedPick)[frames - 1], 4), "aim.ids is the rail's pick");
// the same cast aim nobody picked by hand (an older shot, or one the assistant aimed)
const aimedOld = railShot({}, updateCameraBlock(createCameraBlock({ mode: "rail", cameraRail: rail }), { aim: { ids: ["char-b"] } }));
assert.deepEqual(tracks(aimedOld), tracks(aimedPick), "the mark changes nothing while the cast is there");

// Saved and duplicated with the shot.
const stored = createShotAuthoringDocument({ frameCount: 200, shots: [picked, { ...aimedPick, id: "shot-2", startFrame: 60, endFrame: 107 }] }).shots;
assert.deepEqual(stored[0].subjectIds, ["char-b"], "save and load keep subjectIds");
assert.deepEqual(stored[1].camera.aim, { ids: ["char-b"], picked: true }, "save and load keep aim.ids and its mark");
assert.deepEqual(createShotAuthoringDocument({ frameCount: 200, shots: [aimedOld] }).shots[0].camera.aim, { ids: ["char-b"] }, "an unmarked aim is stored as it was");
const copied = duplicateShot(stored, "shot-1", 200).find(shot => shot.name === "Rail copy");
assert.deepEqual(copied.subjectIds, ["char-b"], "a duplicated shot follows the same pick");
assert.deepEqual(duplicateShot(stored, "shot-2", 200).find(shot => shot.name === "Rail copy").camera.aim, { ids: ["char-b"], picked: true });

// Removed: the camera holds still (no track) instead of following Ada; restoring Bo resumes.
const withoutBo = characters.filter(entry => entry.id !== "char-b");
assert.ok(tracks(picked, withoutBo).every(sample => sample === null), "a removed pick: no follow track, never Ada");
assert.ok(tracks(follow, withoutBo).every(sample => sample === null), "the same on a follow shot");
assert.ok(tracks(aimedPick, withoutBo).every(sample => sample === null), "and on a rail whose picked aim is the removed character");
// An aim nobody picked by hand does what it did before the pick existed: it turns to the follow subject.
assert.deepEqual(tracks(aimedOld, withoutBo), tracks(railShot(), withoutBo), "an unmarked aim that lost its member plays as the same rail with no aim");
assert.ok(aimsAt(tracks(aimedOld, withoutBo)[frames - 1], -4), "which is the selected character (Ada)");
assert.ok(aimsAt(tracks(picked)[frames - 1], 4), "with Bo back (Undo), the pick is followed again");
// a hidden pick is the same as a removed one
assert.ok(tracks(picked, [characters[0], { ...characters[1], hidden: true }]).every(sample => sample === null), "a hidden pick holds still too");

console.log("PASS follow pick: the picked character wins over the selection, survives save/load and duplicate, and a removed pick holds the camera still");
