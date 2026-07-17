import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childRevisionId, initialRevisionId, sceneHash } from "../src/revision.ts";

const INITIAL_GOLDEN = "122984b38a7d8aab7bb51ede0f6bb1301994071027a72961ef5fde52e5b47393";
const CHILD_GOLDEN = "31fd69059c03d22b5f74314b06ebf99607fd6a5a6ab0ac0434a61a3b474fe7f1";
const CHILD_FIELDS = ["project-123", "parent-456", '{"op":"move","x":1}', "result-789", '["dep-a","dep-b"]'] as const;

describe("revision IDs (architecture §6)", () => {
	it("matches committed UTF-8 SHA-256 golden vectors", () => {
		assert.equal(initialRevisionId("project-123", "scene-hash-abc"), INITIAL_GOLDEN);
		assert.equal(childRevisionId(...CHILD_FIELDS), CHILD_GOLDEN);
	});

	it("sceneHash is the canonical revision and chains deterministically", () => {
		const hash = sceneHash({ z: 1, a: "e\u0301" });
		const initial = initialRevisionId("project", hash);
		const child = childRevisionId("project", initial, '{"kind":"inspect"}', hash, "[]");
		assert.equal(sceneHash({ a: "é", z: 1 }), hash);
		assert.equal(childRevisionId("project", initial, '{"kind":"inspect"}', hash, "[]"), child);
	});

	it("changes the child ID when any architecture §6 preimage field changes", () => {
		const baseline = childRevisionId(...CHILD_FIELDS);
		for (let index = 0; index < CHILD_FIELDS.length; index++) {
			const changed = [...CHILD_FIELDS] as [string, string, string, string, string];
			changed[index] += "-changed";
			assert.notEqual(childRevisionId(...changed), baseline, `field ${index}`);
		}
	});
});
