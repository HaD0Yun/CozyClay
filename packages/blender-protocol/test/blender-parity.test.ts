import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSceneSnapshot } from "../src/snapshot.ts";

const fixturePath = join(import.meta.dirname, "fixtures", "blender-exported-snapshot.json");

describe("Blender-exported snapshot parity", () => {
	it("parses the Blender-exported snapshot", () => {
		const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
		const snapshot = parseSceneSnapshot(raw);
		assert.equal(snapshot.scene.name, "Boxing Demo");
	});
});
