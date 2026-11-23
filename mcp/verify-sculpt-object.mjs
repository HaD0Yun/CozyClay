#!/usr/bin/env node
/** sculpt_object (#730): a recipe in, a clay prop out — in memory without an editor, admitted as object.sculpt with one. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, readImageFromPath } from "./image-file.mjs";

import { mcpToolCategory } from "../src/execution-telemetry.js";
import { createToolHandlers, setLiveHub } from "./tool-handlers.mjs";

const turtle = JSON.parse(readFileSync(new URL("../test/fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"));
const pillar = { parts: [{ id: "body", shape: "cylinder", size: [0.4, 1.2, 0.4], position: [0, 0.6, 0] }] };

assert.equal(mcpToolCategory("sculpt_object"), "scene_write");
const tools = createToolHandlers({});
const sculpt = tools.find((tool) => tool.name === "sculpt_object");
assert.ok(sculpt, "sculpt_object is registered");
assert.equal(sculpt.live, true);
assert.equal(sculpt.annotations.openWorldHint, false, "a recipe never reaches outside the scene");
assert.match(sculpt.description, /^Unlike place_object, import_mesh and compare_sculpt, sculpt_object /);
const describe = tools.find((tool) => tool.name === "describe_scene");

/* ------------------------------------------------ memory-only MCP ---- */

setLiveHub(null);
const made = await sculpt.handler({ recipe: turtle, name: "Nerd turtle", x: 1, z: -1, facing: 20 });
assert.equal(made.isError, undefined, made.content[0].text);
assert.match(made.content[0].text, /^Sculpted Nerd turtle as sculpt: [\d.]+ x [\d.]+ m, 0\.\d+ m tall\./);
assert.match((await describe.handler({})).content[0].text, /sculpt {2}Nerd turtle {2}at x 1, y 0, z -1 {2}yaw 20deg/);

const refused = await sculpt.handler({ recipe: { parts: [{ id: "head", shape: "blob", size: [0.4, 400, 0.4] }] } });
assert.equal(refused.isError, true);
assert.match(refused.content[0].text, /^Recipe refused at parts\[head\]\.size\[1\]/);

const resculpt = await sculpt.handler({ id: "sculpt", recipe: pillar });
assert.equal(resculpt.isError, undefined, resculpt.content[0].text);
assert.match(resculpt.content[0].text, /^Re-sculpted Nerd turtle as sculpt: 0\.4 x 0\.4 m, 1\.2 m tall\./);
assert.match((await describe.handler({})).content[0].text, /sculpt {2}Nerd turtle {2}at x 1, y 0, z -1/, "re-sculpt keeps the transform");

const notSculpt = await sculpt.handler({ id: "ghost", recipe: pillar });
assert.match(notSculpt.content[0].text, /No object "ghost"/);
const orphan = await sculpt.handler({ recipe: pillar, parent: "ghost" });
assert.match(orphan.content[0].text, /No object "ghost" to attach to/);
const child = await sculpt.handler({ recipe: pillar, parent: "sculpt" });
assert.match(child.content[0].text, /as sculpt-2: .* under sculpt\./);

// Part-level edits, and the argument rules around them.
const patched = await sculpt.handler({ id: "sculpt-2", edits: [{ set: "body", size: [0.4, 1.6, 0.4], position: [0, 0.8, 0] }] });
assert.match(patched.content[0].text, /^Patched body on Sculpt as sculpt-2: 0\.4 x 0\.4 m, 1\.6 m tall\./);
assert.match((await sculpt.handler({ edits: [{ remove: "body" }] })).content[0].text, /give its id/);
assert.match((await sculpt.handler({ id: "sculpt-2" })).content[0].text, /exactly one of recipe/);
assert.match((await sculpt.handler({ id: "sculpt-2", edits: [{ set: "ghost", color: "#000" }] })).content[0].text, /no part named "ghost"/);
const offline = await sculpt.handler({ recipe: pillar, capture: true });
assert.equal(offline.isError, true);
assert.match(offline.content[0].text, /capture: true needs a connected CozyClay editor/);

/* -------------------------------------------- compare_sculpt + images ---- */

const compare = tools.find((tool) => tool.name === "compare_sculpt");
assert.equal(compare.annotations.readOnlyHint, true);
assert.equal(mcpToolCategory("compare_sculpt"), "read");
// A 120x200 PNG: a 0.4 x 1.2 slab on a flat backdrop -- the pillar's shape exactly.
const w = 120, h = 200, rgba = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
	const inside = x >= 40 && x < 80 && y >= 40 && y < 160, i = (y * w + x) * 4;
	rgba.set(inside ? [60, 120, 140, 255] : [154, 220, 254, 255], i);
}
const png = encodePng(w, h, rgba);
const back = decodePng(png);
assert.deepEqual([back.width, back.height], [w, h]);
assert.deepEqual(Buffer.from(back.data), Buffer.from(rgba), "PNG encode/decode round-trips");
const refPath = join(tmpdir(), `cozyclay-sculpt-ref-${process.pid}.png`);
writeFileSync(refPath, png);
assert.equal((await readImageFromPath(refPath)).width, w);
await sculpt.handler({ id: "sculpt-2", recipe: { parts: [{ id: "slab", shape: "box", roundness: 0, size: [0.4, 1.2, 0.2], position: [0, 0.6, 0] }] } });
const scored = await compare.handler({ id: "sculpt-2", reference: refPath, yaw: 0 });
assert.equal(scored.isError, undefined, scored.content[0].text);
const report = JSON.parse(scored.content[0].text);
assert.ok(report.iou > 0.95, JSON.stringify(report));
assert.equal(scored.content[1].type, "image");
const sheet = decodePng(Buffer.from(scored.content[1].data, "base64"));
assert.deepEqual([sheet.width, sheet.height], [240, 200], "reference | overlay, side by side");
// Candidates: several fixes scored in one call, ranked, none applied.
const before = JSON.stringify((await describe.handler({})).content[0].text.match(/sculpt-2 .*/)[0]);
const ranked = await compare.handler({ id: "sculpt-2", reference: refPath, yaw: 0, candidates: [
	{ label: "too-wide", edits: [{ set: "slab", size: [0.8, 1.2, 0.2] }] },
	{ label: "exact", edits: [{ set: "slab", size: [0.4, 1.2, 0.2] }] },
	{ label: "broken", edits: [{ set: "ghost", color: "#000000" }] },
] });
assert.equal(ranked.isError, undefined, ranked.content[0].text);
const ranking = JSON.parse(ranked.content[0].text);
assert.deepEqual(ranking.ranking.map((row) => row.label).slice(-1), ["too-wide"], "the worse fix ranks last");
assert.ok(ranking.ranking.find((row) => row.label === "too-wide").delta < -0.2);
assert.match(ranking.refused[0].error, /no part named "ghost"/);
assert.match(ranking.note, /Nothing was applied/);
assert.equal(ranked.content[1].type, "image", "the winner's sheet");
assert.equal(JSON.stringify((await describe.handler({})).content[0].text.match(/sculpt-2 .*/)[0]), before, "scoring candidates changes nothing");
assert.match((await compare.handler({ id: "sculpt-2", reference: "/no/such/ref.png" })).content[0].text, /Could not read the reference image/);
assert.match((await compare.handler({ id: "ghost", reference: refPath })).content[0].text, /No object "ghost"/);
const notPng = join(tmpdir(), `cozyclay-sculpt-ref-${process.pid}.txt`);
writeFileSync(notPng, "hello");
assert.match((await compare.handler({ id: "sculpt-2", reference: notPng })).content[0].text, /PNG or a JPEG/);
const jpegPath = join(tmpdir(), `cozyclay-sculpt-ref-${process.pid}.jpg`);
writeFileSync(jpegPath, (await import("jpeg-js")).default.encode({ width: w, height: h, data: rgba }, 90).data);
const viaJpeg = JSON.parse((await compare.handler({ id: "sculpt-2", reference: jpegPath, yaw: 0 })).content[0].text);
assert.ok(viaJpeg.iou > 0.9, `a JPEG reference scores too (${viaJpeg.iou})`);
assert.ok((await readImageFromPath(fileURLToPath(new URL("../docs/images/cozyclay-logo.png", import.meta.url)))).width > 0, "a real PNG from the repo decodes");

/* ---------------------------------------------------- live editor ---- */

const commands = [];
const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
let revision = 0;
setLiveHub({
	connected: true,
	command: async (name, args) => {
		commands.push({ name, args });
		if (name === "inspect_studio") return { context: { host, revision: { scene: revision } }, actions: [{ id: "object.sculpt" }] };
		assert.equal(name, "run_action", `unexpected live command ${name}`);
		assert.equal(args.args.action, "object.sculpt");
		const before = revision++;
		return { ok: true, status: "applied", kind: "mutation", action: "object.sculpt", commandId: args.commandId, receiptId: `receipt-${revision}`,
			host, authored: true, revision: { before, after: revision }, affectedIds: ["sculpt"], delta: [], checks: {}, warnings: [],
			undo: { historyEntryId: `history-${revision}`, entries: 1, canUndoDirect: true }, summary: "Sculpted Sculpt (sculpt): 1 parts." };
	},
});
const live = await sculpt.handler({ recipe: pillar, x: 2, facing: 15, parent: "plinth" });
assert.equal(live.isError, undefined, live.content[0].text);
const run = commands.find((entry) => entry.name === "run_action");
assert.ok(run, "the live path admits a command");
assert.deepEqual(run.args.args.args, { recipe: pillar, placement: { x: 2, rot: 15 }, parent: "plinth" }, "the recipe goes to the editor untouched; it validates there");
commands.length = 0;
await sculpt.handler({ id: "sculpt", edits: [{ remove: "tooth" }] });
assert.deepEqual(commands.find((entry) => entry.name === "run_action").args.args.args, { edits: [{ remove: "tooth" }], id: "sculpt" });

setLiveHub(null);
console.log("PASS verify-sculpt-object (MCP): memory create/refuse/re-sculpt/patch/parent, compare_sculpt on PNG and JPEG, live admission as object.sculpt");
