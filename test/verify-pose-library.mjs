#!/usr/bin/env node

// There is no saved-pose library: the pose tiles hold the default standing
// pose a character spawns in, and Pose mode's hand posing stays. A project
// file no longer writes a pose library, and one from an older file is dropped
// without an error.

import { readFileSync } from "node:fs";
import { DEFAULT_POSE, POSE_BONES } from "../src/poses.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneDocument } from "../src/scenes.js";

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
expect("no saved-pose library is left", !appSource.includes("customPoses") && !appSource.includes("savePose") && !appSource.includes("removePose") && !posesSource.includes("loadCustomPoses"));

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
	"the default is the one pose tile",
	appSource.includes("const selectablePoses = useMemo(() => [DEFAULT_POSE], []);"),
);

/* --- a project file carries no pose library ------------------------------- */

const written = createProjectDocument({ scenesDocument: createSceneDocument(), name: "Poses" });
expect("a saved project writes no pose library", !("poseLibrary" in written));
const older = readProjectDocument(JSON.stringify({ ...written, poseLibrary: [{ id: "custom_1", label: "My Pose 1", bones: { hips: [1, 0, 0] }, custom: true }] }));
expect("an older file with a pose library still opens", older.ok === true);
expect("its pose library is dropped", older.ok && !("customPoses" in older.project) && !("poseLibrary" in older.project));

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
	"an old Y Bot changes to the rig figure with one button; an X Bot row has no rig choice",
	appSource.includes("run('character.update', { characterId: activeChar.id, patch: { model: NEW_CHARACTER_MODEL } })") &&
	appSource.includes("if (activeChar.model === NEW_CHARACTER_MODEL) return null;") &&
	appSource.includes('ko("Cube figure", "큐브 인형", "方块人")') && appSource.includes('ko("Block figure", "블록 인형", "积木人")') && appSource.includes('"x-bot-tpose": FIGURE_LABEL'),
);
expect("the posture picker keeps the radio-group style", appSource.includes('role="radiogroup"') && stylesSource.includes(".rig-picker"));

expect("Pose Studio exposes stable pose id hook", studioSource.includes("data-pose-id={pose.id}"));
expect("Pose Studio has no save tile", !studioSource.includes('data-pose-id="save-custom"'));
expect("Pose Studio no longer offers a photo source", !studioSource.includes('data-pose-id="photo-pose"'));
expect("Pose Studio has no empty-library note", !studioSource.includes("data-pose-empty"));
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

console.log("pose checks PASS (no saved-pose library; the default pose tile and pose studio stay)");
