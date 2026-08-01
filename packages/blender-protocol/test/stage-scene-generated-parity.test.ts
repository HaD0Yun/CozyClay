import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generatedCameraManifestFields, generatedLightManifestFields } from "../src/stage-scene-ops.generated.ts";

const generatedSources = [
	readFileSync(new URL("../src/stage-scene-ops.generated.ts", import.meta.url), "utf8"),
	readFileSync(new URL("../src/manifest-fields.generated.ts", import.meta.url), "utf8"),
];
const fixture = JSON.parse(
	readFileSync(new URL("fixtures/canonical-fields.generated.json", import.meta.url), "utf8"),
) as Array<{
	operation: { op: string; focus_distance?: number; cutoff_distance?: number };
	stageSceneOperation: boolean;
	canonicalFields: string;
	sha256: string;
}>;

function typescriptCanonicalFields(operation: (typeof fixture)[number]["operation"]): string {
	switch (operation.op) {
		case "set_camera_focus_distance":
			return JSON.stringify(generatedCameraManifestFields({ focus_distance: operation.focus_distance! }));
		case "set_light_cutoff_distance":
			return JSON.stringify(generatedLightManifestFields({ cutoff_distance: operation.cutoff_distance! }));
		default:
			throw new Error(`unexpected generated operation ${operation.op}`);
	}
}

describe("generated manifest field parity", () => {
	it("executes Python and TypeScript projections over identical manifest-only inputs and compares bytes and hashes directly", () => {
		const directory = mkdtempSync(join(tmpdir(), "cclay-generated-parity-"));
		const output = join(directory, "python.json");
		try {
			const script = `
import hashlib, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path("blender-addon").resolve()))
from cclay.manifest_fields_generated import generated_camera_manifest_fields, generated_light_manifest_fields
rows = json.load(open(sys.argv[1], encoding="utf-8"))
class Camera:
    def __init__(self): self.dof = type("Dof", (), {"focus_distance": 0.0})()
class Light:
    def __init__(self): self.cutoff_distance = 0.0
result = []
for row in rows:
    operation = row["operation"]
    data = Camera() if operation["op"] == "set_camera_focus_distance" else Light()
    if operation["op"] == "set_camera_focus_distance":
        data.dof.focus_distance = operation["focus_distance"]
    else:
        data.cutoff_distance = operation["cutoff_distance"]
    fields = generated_camera_manifest_fields(data) if isinstance(data, Camera) else generated_light_manifest_fields(data)
    canonical = json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
    result.append({"canonicalFields": canonical, "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()})
json.dump(result, open(sys.argv[2], "w", encoding="utf-8"), separators=(",", ":"))
`;
			const result = spawnSync(
				"python3",
				["-c", script, "packages/blender-protocol/test/fixtures/canonical-fields.generated.json", output],
				{
					cwd: new URL("../../..", import.meta.url),
					encoding: "utf8",
				},
			);
			assert.equal(result.status, 0, result.stderr);
			const python = JSON.parse(readFileSync(output, "utf8")) as Array<{ canonicalFields: string; sha256: string }>;
			assert.equal(python.length, fixture.length);
			for (const [index, row] of fixture.entries()) {
				assert.equal(row.stageSceneOperation, false);
				const canonicalFields = typescriptCanonicalFields(row.operation);
				const sha256 = createHash("sha256").update(canonicalFields, "utf8").digest("hex");
				assert.equal(canonicalFields, python[index].canonicalFields);
				assert.equal(sha256, python[index].sha256);
				assert.equal(canonicalFields, row.canonicalFields);
				assert.equal(sha256, row.sha256);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses only TypeScript syntax Node can strip from generated output", () => {
		for (const source of generatedSources) {
			for (const forbidden of [
				/\benum\b/,
				/\bnamespace\b/,
				/constructor\s*\(\s*(?:public|private|protected|readonly)\b/,
				/\bimport\s+[\w$]+\s*=/,
				/\bexport\s*=/,
			])
				assert.doesNotMatch(source, forbidden, `generated output contains forbidden syntax: ${forbidden}`);
		}
	});
});
