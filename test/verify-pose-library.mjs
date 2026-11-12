#!/usr/bin/env node

// The pose library is the user's own material. Nothing ships in it: it fills
// with poses read out of photographs and poses saved off the rig, and those
// persist across sessions and projects. These checks pin that contract —
// no presets, a default that is NOT a library entry, and storage that keeps
// what the user put there.

import { readFileSync } from "node:fs";
import { DEFAULT_POSE, POSE_BONES, deleteCustomPose, loadCustomPoses, saveCustomPoses } from "../src/poses.js";
import { mergeProjectCustomPoses } from "../src/project-poses.js";

const failures = [];
const expect = (name, condition, detail = "") => {
	if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const boneIds = new Set(POSE_BONES.map((bone) => bone.id));
const posesSource = readFileSync(new URL("../src/poses.js", import.meta.url), "utf8");
const studioSource = readFileSync(new URL("../src/posestudio.jsx", import.meta.url), "utf8");
// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const appSource = readStudioSource()
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-startup-defaults.js", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/character-name.js", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/* --- no presets ship ------------------------------------------------------- */

expect("no built-in pose preset list remains", !posesSource.includes("BUILT_IN_POSES"));
expect("App no longer seeds the library with presets", !appSource.includes("BUILT_IN_POSES"));
expect(
	"the library shown to the user is exactly the user's own poses",
	appSource.includes("const allPoses = customPoses;"),
);

/* --- the default is a spawn state, not a library entry --------------------- */

expect("a default pose exists", Boolean(DEFAULT_POSE) && typeof DEFAULT_POSE === "object");
expect("the default carries an id", DEFAULT_POSE.id === "default");
expect("the default carries a prompt", typeof DEFAULT_POSE.prompt === "string" && DEFAULT_POSE.prompt.length > 0);
expect("the default is not flagged custom", DEFAULT_POSE.custom !== true);
for (const [boneId, value] of Object.entries(DEFAULT_POSE.bones ?? {})) {
	expect(`default.${boneId} uses an editable bone`, boneIds.has(boneId));
	expect(
		`default.${boneId} is an Euler triple`,
		Array.isArray(value) && value.length === 3 && value.every(Number.isFinite),
	);
}
expect(
	"the default stays selectable even with an empty library",
	appSource.includes("const selectablePoses = useMemo(() => [DEFAULT_POSE, ...customPoses]"),
);

/* --- user poses accumulate and persist ------------------------------------- */

const store = new Map();
globalThis.localStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => { store.set(key, String(value)); },
	removeItem: (key) => { store.delete(key); },
};

expect("an untouched library is empty", loadCustomPoses().length === 0);

const photoPose = { id: "photo_1", label: "Photo Pose 1", prompt: "in the exact body pose shown in the reference photograph", bones: { lArm: [1, 0, 0] }, custom: true };
const savedPose = { id: "custom_1", label: "My Pose 1", prompt: "in the exact body pose shown in the blocking frame", bones: { rArm: [0, 1, 0] }, custom: true };

expect("saving a pose reports success", saveCustomPoses([photoPose]) === true);
expect("a saved pose survives a reload", loadCustomPoses().length === 1);

saveCustomPoses([photoPose, savedPose]);
const reloaded = loadCustomPoses();
expect("poses accumulate rather than replace", reloaded.length === 2, reloaded.map((p) => p.id).join(", "));
expect("both sources land in the same library", reloaded.map((p) => p.id).join(",") === "photo_1,custom_1");

const afterDelete = deleteCustomPose("photo_1", reloaded);
expect("deleting removes only the named pose", afterDelete.length === 1 && afterDelete[0].id === "custom_1");
expect("the deletion is persisted", loadCustomPoses().length === 1);

/* --- project imports preserve the local library --------------------------- */

const localOnlyPose = { id: "local-only", label: "Local only", bones: { hips: [1, 0, 0] }, custom: true };
const localConflictPose = { id: "shared", label: "Stale local", bones: { hips: [2, 0, 0] }, custom: true };
const projectOnlyPose = { id: "project-only", label: "Project only", bones: { hips: [3, 0, 0] }, custom: true };
const projectConflictPose = { id: "shared", label: "Project wins", bones: { hips: [4, 0, 0] }, custom: true };

// Given: a local library with one unrelated pose and one stale shared pose.
const localLibrary = [localOnlyPose, localConflictPose];
// When: a project with one unrelated pose and a replacement for the shared id opens.
const mergedProjectLibrary = mergeProjectCustomPoses(localLibrary, [projectOnlyPose, projectConflictPose]);
// Then: local-only and project-only entries remain, and exactly one project-owned shared entry wins.
expect(
	"project import merges local and project-only poses in stable source order",
	JSON.stringify(mergedProjectLibrary) === JSON.stringify([localOnlyPose, projectOnlyPose, projectConflictPose]),
	JSON.stringify(mergedProjectLibrary),
);
expect(
	"project import keeps exactly one project-owned conflicting pose",
	mergedProjectLibrary.filter((pose) => pose.id === "shared").length === 1 && mergedProjectLibrary.find((pose) => pose.id === "shared")?.label === "Project wins",
	JSON.stringify(mergedProjectLibrary),
);
saveCustomPoses(mergedProjectLibrary);
expect(
	"the merged project library persists both sources",
	JSON.stringify(loadCustomPoses()) === JSON.stringify([localOnlyPose, projectOnlyPose, projectConflictPose]),
	JSON.stringify(loadCustomPoses()),
);

// Given: a local library.
const localLibraryForEmptyProject = [localOnlyPose, localConflictPose];
// When: a project without custom poses opens.
const mergedEmptyProjectLibrary = mergeProjectCustomPoses(localLibraryForEmptyProject, []);
// Then: the local library is unchanged.
expect(
	"an empty project pose library preserves every local pose",
	JSON.stringify(mergedEmptyProjectLibrary) === JSON.stringify(localLibraryForEmptyProject),
	JSON.stringify(mergedEmptyProjectLibrary),
);

const malformed = JSON.stringify([{ id: "ok", bones: {} }, { id: 5 }, null, { bones: {} }]);
store.set("cozyclay_poses", malformed);
expect("a corrupted library degrades to only its valid entries", loadCustomPoses().length === 1);

/* --- the studio tells an empty library what to do -------------------------- */

/* --- the Inspector picks poses by shape, and the rig is free ---------------- */

// A pose read out of a photograph has no name worth reading, so the Inspector
// shows the same tiles the studio does instead of a dropdown of labels.
expect("the pose tiles are a shared component", studioSource.includes("export function PoseTileGrid({"));
expect("the Inspector renders pose tiles", appSource.includes("<PoseTileGrid") && appSource.includes("poses={selectablePoses}"));
expect(
	"the Inspector no longer picks a pose from a dropdown",
	!appSource.includes('ariaLabel={ko("Subject 1 pose"') && !appSource.includes('ariaLabel={ko("Subject 2 pose"'),
);
expect("picking a tile clears a running take first", appSource.includes("const hadMotion = Boolean(motion);"));
expect(
	"both shipped rigs are selectable per character",
	appSource.includes("CHARACTER_MODEL_IDS.map((id) => (") &&
	appSource.includes("run('character.update', { characterId: activeChar.id, patch: { model: id } })") &&
	appSource.includes('const CHARACTER_MODEL_LABELS = { "y-bot-tpose": "Y Bot", "x-bot-tpose": "X Bot" };'),
);
expect("the rig options preview the character's own pose", appSource.includes("<PoseThumbPreview model={id}") && studioSource.includes("export function PoseThumbPreview({"));
expect("the rig picker is styled as a radio group", appSource.includes('role="radiogroup"') && stylesSource.includes(".rig-picker"));

expect("Pose Studio exposes stable pose id hook", studioSource.includes("data-pose-id={pose.id}"));
expect("Pose Studio exposes save custom hook", studioSource.includes('data-pose-id="save-custom"'));
expect("Pose Studio no longer offers a photo source", !studioSource.includes('data-pose-id="photo-pose"'));
expect("Pose Studio keeps custom pose labels", studioSource.includes("pose.custom ? pose.label"));
expect("Pose Studio explains an empty library", studioSource.includes("data-pose-empty"));
expect("Pose Studio applies its synchronous draft selection", studioSource.includes("onApply(selectedIdRef.current)"));
expect(
	"Pose Studio explains motion ownership",
	studioSource.includes("data-pose-motion-warning")
		&& studioSource.includes('ko("Clear motion and apply pose"')
		&& studioSource.includes('ikCorrection ? ko("Key pose as IK correction"'),
);
expect(
	"App clears loaded motion before applying a blocking pose",
	appSource.includes("motionActive={Boolean(motion)}") && appSource.includes("castDomain.run('character.setPose', { characterId: posingChar.id, pose: pose.id, clearMotion: hadMotion })"),
);
expect(
	"Pose Studio keeps tiles inside a scrollable panel",
	stylesSource.includes(".studio-filters") && stylesSource.includes(".pose-grid") && stylesSource.includes("min-height: 0"),
);

if (failures.length) {
	console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
	process.exit(1);
}

console.log("pose library checks PASS (user-owned library, no shipped presets)");
