#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import { createCharacterEntry } from "../src/scenes.js";
import { placementAt } from "../src/root-path.js";
import { isProxyFigure } from "../src/scenes.js";

const proxy = createCharacterEntry({ id: "proxy", model: "proxy-figure", posture: "sit" });
const tree = buildHierarchyNodes([], [proxy]);
const row = tree[0].children.find(node => node.id === "characters").children[0];
assert.equal(row.kind, "character");
assert.equal(row.children, undefined);

// Execute the actual render-prop mapping without mounting React or loading FBX.
const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const mapping = source.slice(source.indexOf("characters.flatMap((entry, index) => {", source.indexOf("const characterViews")),
	source.indexOf("}), [characters, activeChar.id, motion", source.indexOf("const characterViews")) + 2);
const map = new Function("characters", "activeChar", "motion", "tlFrame", "shots", "shotAtFrame", "partColoursEnabled", "partColoursMode", "DEFAULT_POSE", "characterModelUrl", "defaultCharacterTint", "placementAt", "reportRig", "isProxyFigure",
	`return ${mapping}`);
let rigReports = 0;
const views = map([proxy, createCharacterEntry({ id: "rig" })], proxy, null,
	0, [], () => null, false, "shaded", {}, model => `/models/${model}.fbx`, () => "#bdbec3",
	placementAt, () => { rigReports++; return () => {}; }, isProxyFigure);
assert.equal(Object.hasOwn(views[0], "url"), false);
assert.equal(Object.hasOwn(views[0], "onRig"), false);
assert.equal(views[0].posture, "sit");
assert.equal(views[0].model, "proxy-figure");
assert.equal(views[0].pickId, "proxy");
assert.equal(views[1].pickId, "rig");
assert.equal(views[1].url, "/models/y-bot-tpose.fbx");
assert.equal(rigReports, 1);
console.log("PASS proxy hierarchy has no rig; render mapping carries posture without URL/onRig");
