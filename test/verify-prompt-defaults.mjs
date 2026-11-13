#!/usr/bin/env node
// A new scene invents no location or look, and the prompt states the real
// output aspect (#1238).
//
// - A new scene starts with an empty environment and an empty style; an empty
//   one leaves its sentence out of the prompt. A saved scene keeps its text.
// - composePrompt prints the aspect its caller passes: a ratio label as is, a
//   preset with no ratio label as its pixel size, and nothing without one.
// This file has its own process because the MCP handler module keeps state.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSceneDocument, createSceneStage, readSceneDocument, serializeSceneDocument } from "../src/scenes.js";
import { composePrompt, deriveShot } from "../src/shot.js";
import { createToolHandlers, setLiveHub } from "../mcp/tool-handlers.mjs";

let failures = 0;
const expect = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n  ${detail}`}`);
	if (!ok) failures += 1;
};

// --- a new scene ------------------------------------------------------------
const fresh = createSceneDocument().scenes[0].stage;
expect("a new scene starts with an empty environment", fresh.environment === "", JSON.stringify(fresh.environment));
expect("a new scene starts with an empty style", fresh.style === "", JSON.stringify(fresh.style));
const bare = createSceneStage({});
expect("a stage that stores no environment or style gets empty ones", bare.environment === "" && bare.style === "", JSON.stringify([bare.environment, bare.style]));

// --- a saved scene keeps its text --------------------------------------------
const saved = createSceneDocument();
saved.scenes[0].stage = { ...saved.scenes[0].stage, environment: "a sunlit modern living room", style: "  moody cinematic lighting, 35mm film look " };
const reopened = readSceneDocument(serializeSceneDocument(saved)).document.scenes[0].stage;
expect("a saved environment loads byte for byte", reopened.environment === "a sunlit modern living room", JSON.stringify(reopened.environment));
expect("a saved style loads byte for byte", reopened.style === "  moody cinematic lighting, 35mm film look ", JSON.stringify(reopened.style));

// --- empty environment or style leaves its sentence out ----------------------
const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const subjects = [{ description: "a courier", posePhrase: "" }];
const tidy = (prompt) => !prompt.includes("  ") && !/ [.,]/.test(prompt) && !/\.\./.test(prompt) && !prompt.includes("undefined");
const both = composePrompt({ shot, subjects, environment: "a rainy street", style: "35mm film look" });
expect("both: the environment sentence is printed", both.includes(" Environment: a rainy street. "), both);
expect("both: the style sentence is printed", both.includes(` 35mm film look, ${shot.sizeContext}. `), both);
const envOnly = composePrompt({ shot, subjects, environment: "a rainy street", style: "" });
expect("environment only: no style text, the shot context stays", envOnly.includes(` Environment: a rainy street. The full figure with the environment clearly visible, deep focus. Use the attached`), envOnly);
expect("environment only: no stray punctuation or doubled space", tidy(envOnly), envOnly);
const styleOnly = composePrompt({ shot, subjects, environment: "", style: "35mm film look" });
expect("style only: no environment sentence", !styleOnly.includes("Environment:") && styleOnly.includes(`placement shown in the blocking frame. 35mm film look, ${shot.sizeContext}. `), styleOnly);
expect("style only: no stray punctuation or doubled space", tidy(styleOnly), styleOnly);
const neither = composePrompt({ shot, subjects, environment: "", style: "" });
expect("neither: no environment and no style text", !neither.includes("Environment:") && neither.includes("blocking frame. The full figure with the environment clearly visible, deep focus. Use the attached"), neither);
expect("neither: no stray punctuation or doubled space", tidy(neither), neither);
const sheet = composePrompt({ shot, subjects, environment: "", style: "", hasEnvSheet: true });
expect("an environment sheet still names the sheet when the text is empty", sheet.includes(" The setting is the location from the attached environment sheet. "), sheet);

// --- the aspect ---------------------------------------------------------------
for (const label of ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7"]) {
	const prompt = composePrompt({ shot, subjects, environment: "a rainy street", style: "film", aspect: label });
	expect(`aspect ${label} ends the prompt`, prompt.endsWith(` flat lighting. ${label}.`), prompt.slice(-60));
}
const fal = composePrompt({ shot, subjects, environment: "a rainy street", style: "film", aspect: "fal 480P" });
expect("a preset without a ratio label prints its pixel size", fal.endsWith(" flat lighting. 832x480."), fal.slice(-60));
const none = composePrompt({ shot, subjects, environment: "a rainy street", style: "film" });
expect("no aspect prints no ratio", none.endsWith(" flat lighting.") && !/\d:\d/.test(none), none.slice(-60));

// --- every caller passes the aspect -------------------------------------------
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const generateCall = app.slice(app.indexOf("function generate()"), app.indexOf("let frame = null;", app.indexOf("function generate()")));
expect("the studio's generate passes the shot aspect", /composePrompt\(\{[\s\S]*aspect: shotAspectKey[\s\S]*\}\);/.test(generateCall), generateCall.slice(-300));

// --- the panel shows a hint, not a value --------------------------------------
const panel = await readFile(new URL("../src/panels/EnvironmentPanel.jsx", import.meta.url), "utf8");
const hints = [...panel.matchAll(/placeholder=\{ko\("[^"]+", "[^"]+", "[^"]+"\)\}/g)];
expect("the environment and style fields carry a placeholder hint in three languages", hints.length === 2, `found ${hints.length}`);

// --- MCP render_prompt -------------------------------------------------------
setLiveHub(null);
const root = await mkdtemp(join(tmpdir(), "cozyclay-prompt-defaults-"));
try {
	const resolved = await realpath(root);
	process.chdir(resolved);
	const tools = createToolHandlers({ projectRootPromise: Promise.resolve(resolved) });
	const call = async (name, args = {}) => {
		const result = await tools.find((entry) => entry.name === name).handler(args);
		assert.equal(result.isError, undefined, `${name} failed: ${result.content[0].text}`);
		return result.content[0].text;
	};
	const promptArgs = { mode: "image", environment: "", style: "plain", camera_move: "hold", pose_phrase: "", pose2_phrase: "" };
	const plain = await call("render_prompt", promptArgs);
	expect("render_prompt: the default 16:9 stage prints 16:9", plain.endsWith(" 16:9."), plain.slice(-60));
	expect("render_prompt: an empty environment prints no environment sentence", !plain.includes("Environment:") && tidy(plain), plain);

	await call("save_project", { path: "wide.cclayproject" });
	const file = join(resolved, "wide.cclayproject");
	const project = JSON.parse(await readFile(file, "utf8"));
	const scenesDocument = project.scenesDocument ?? project.scenes;
	for (const scene of scenesDocument.scenes) scene.stage.shotAspect = "2.39:1";
	await writeFile(file, JSON.stringify(project));
	await call("open_project", { path: "wide.cclayproject" });
	const wide = await call("render_prompt", promptArgs);
	expect("render_prompt: a 2.39:1 stage prints 2.39:1", wide.endsWith(" 2.39:1."), wide.slice(-60));
} finally {
	process.chdir(tmpdir());
	await rm(root, { recursive: true, force: true });
}

if (failures) {
	console.log(`\n${failures} prompt default check(s) FAIL`);
	process.exit(1);
}
console.log("\nprompt defaults PASS");
