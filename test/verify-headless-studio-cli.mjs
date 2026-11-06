#!/usr/bin/env node
// #1073: tools/headless-studio.mjs must resolve its browser helper and print
// usage without a project, Chrome or dev server; the helper must seed the
// project session (cast style included) and restore embedded assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStudioProject, startChrome, studioSeedScript, waitFor } from "../tools/headless-chrome.mjs";
import { createProjectDocument, loadProjectSession, readProjectDocument } from "../src/project.js";
import { restoreProjectAssets } from "../src/project-assets.js";
import { assetIdForBytes } from "../src/scene-assets.js";
import { createCutoutObject } from "../src/scene-objects.js";
import { createSceneDocument, SCENES_STORAGE_KEY } from "../src/scenes.js";

const tool = fileURLToPath(new URL("../tools/headless-studio.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", timeout: 30000 });

for (const fn of [openStudioProject, startChrome, waitFor]) assert.equal(typeof fn, "function");

const help = run("--help");
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--project <file>/);
assert.equal(help.stderr, "");

const missing = run();
assert.equal(missing.status, 2, missing.stderr);
assert.match(missing.stderr, /--project <file>/);

assert.equal(await waitFor("probe", async () => 7, { timeoutMs: 1000 }), 7);
await assert.rejects(waitFor("never", async () => false, { timeoutMs: 50, intervalMs: 10 }), /never: timed out/);

// A project with one embedded image (referenced by a cutout) and a rig cast.
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
const assetId = await assetIdForBytes(bytes);
const scenesDocument = createSceneDocument({ seedCharacter: true });
scenesDocument.scenes[0].objects = [createCutoutObject({ assetId, name: "card" }, [])];
const raw = createProjectDocument({ scenesDocument, name: "Rig Shot", castStyle: "rig", assets: [{ id: assetId, type: "image/png", width: 1, height: 1, bytes, name: "card.png" }] });
const parsed = readProjectDocument(typeof raw === "string" ? raw : JSON.stringify(raw));
assert.equal(parsed.ok, true, parsed.reason);
assert.equal(parsed.project.castStyle, "rig");
assert.deepEqual(parsed.project.assets.map((asset) => asset.id), [assetId]);

const store = new Map();
const storage = { setItem: (key, value) => store.set(key, String(value)), getItem: (key) => store.get(key) ?? null };
new Function("localStorage", studioSeedScript(parsed.project))(storage);
const session = loadProjectSession(storage);
assert.equal(session.name, "Rig Shot");
assert.equal(session.castStyle, "rig");
assert.equal(session.previsMode, parsed.project.previsMode);
assert.deepEqual(JSON.parse(store.get(SCENES_STORAGE_KEY)).scenes[0].objects[0].assetId, assetId);

const written = [];
const restored = await restoreProjectAssets(parsed.project, { open: async () => ({ close() {} }), put: async (_db, asset) => { written.push(asset); } });
assert.deepEqual(restored, [assetId]);
assert.equal(written.length, 1);
assert.deepEqual(new Uint8Array(written[0].bytes), png);

console.log("PASS verify-headless-studio-cli: --help exits 0, missing --project exits 2, session seeds castStyle, embedded asset restored");
