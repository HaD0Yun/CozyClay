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
const map = new Function("characters", "activeChar", "motion", "tlFrame", "shots", "shotAtFrame", "partColoursEnabled", "partColoursMode", "DEFAULT_POSE", "characterModelUrl", "defaultCharacterTint", "placementAt", "reportRig", "isProxyFigure", "defaultCharacterColour",
	`return ${mapping}`);
let rigReports = 0;
const views = map([proxy, createCharacterEntry({ id: "rig" })], proxy, null,
	0, [], () => null, false, "shaded", {}, model => `/models/${model}.fbx`, () => "#bdbec3",
	placementAt, () => { rigReports++; return () => {}; }, isProxyFigure, () => null);
assert.equal(Object.hasOwn(views[0], "url"), false);
assert.equal(Object.hasOwn(views[0], "onRig"), false);
assert.equal(views[0].posture, "sit");
assert.equal(views[0].model, "proxy-figure");
assert.equal(views[0].pickId, "proxy");
assert.equal(views[1].pickId, "rig");
assert.equal(views[1].url, "/models/y-bot-tpose.fbx");
assert.equal(rigReports, 1);
console.log("PASS proxy hierarchy has no rig; render mapping carries posture without URL/onRig");

// Untinted block figures are drawn in different default colours, by their place in the cast;
// a tint of their own wins, and the default is never written into the entry.
const { defaultCharacterColour, defaultCharacterTint } = await import("../src/stage-startup-defaults.js");
const { TRACK_RIG } = await import("../src/lowvis/studio/take.js");
const figure = (id, extra = {}) => createCharacterEntry({ id, model: TRACK_RIG, ...extra });
const cast = [figure("a"), figure("b"), figure("c"), figure("d", { tint: "#123456" })];
const render = list => map(list, list[0], null, 0, [], () => null, false, "shaded", {}, model => `/models/${model}.fbx`, defaultCharacterTint,
	placementAt, () => () => {}, isProxyFigure, defaultCharacterColour);
const drawn = render(cast);
const bodies = drawn.slice(0, 3).map(v => v.colour ?? "blockout");
assert.equal(new Set(bodies).size, 3, `three untinted figures, three colours: ${bodies}`);
assert.equal(drawn[0].colour, null, "the first keeps today's blockout grey");
assert.equal(new Set(drawn.slice(0, 3).map(v => v.tint)).size, 3, "the swatch tints differ too");
assert.equal(drawn[3].colour, "#123456");
assert.equal(drawn[3].tint, "#123456");
assert.deepEqual(render(cast).map(v => v.colour), drawn.map(v => v.colour), "the same cast draws the same colours again");
assert.equal(cast.some((entry, i) => i < 3 && entry.tint != null), false, "no default is written into an entry");
const untinted = render([cast[0], cast[1], cast[2], { ...cast[3], tint: null }]);
assert.notEqual(untinted[3].colour, "#123456", "removing the tint returns a default");
assert.ok(untinted[3].colour, "a fourth untinted figure still gets a default colour");
assert.equal(defaultCharacterColour({ model: "proxy-figure" }, 2), null, "other models keep their old defaults");
console.log(`PASS untinted block figures: ${bodies.join(", ")}; a tint of their own wins; nothing saved`);
