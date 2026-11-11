#!/usr/bin/env node
// Every name a module imports from scene-mesh-cache.js must stay exported
// (#1136): character import loads a rig file through loadMeshScene.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as meshCache from "../src/scene-mesh-cache.js";

const src = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(src, { recursive: true }).filter((file) => /\.(?:js|jsx|mjs)$/.test(file));
const importRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:\.\.?\/)+scene-mesh-cache\.js["']/g;
const wanted = new Map();
for (const file of files) {
	for (const match of readFileSync(join(src, file), "utf8").matchAll(importRe)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/)[0];
			if (name) wanted.set(name, file);
		}
	}
}

assert.ok(wanted.has("loadMeshScene"), "character-import.js still imports loadMeshScene");
for (const [name, file] of wanted) assert.equal(typeof meshCache[name], "function", `${file} imports ${name} from scene-mesh-cache.js`);
console.log(`PASS scene-mesh-cache exports every imported name (${wanted.size})`);
