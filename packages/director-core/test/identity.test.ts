import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUuidV4Lowercase, newUuidV4 } from "../src/identity.ts";

describe("stable identity (architecture §6)", () => {
	it("accepts only strict lowercase UUIDv4 values", () => {
		assert.equal(isUuidV4Lowercase("123e4567-e89b-42d3-a456-426614174000"), true);
		for (const invalid of [
			"123E4567-E89B-42D3-A456-426614174000",
			"123e4567-e89b-32d3-a456-426614174000",
			"123e4567-e89b-42d3-7456-426614174000",
			"123e4567e89b42d3a456426614174000",
			"not-a-uuid",
			42,
		])
			assert.equal(isUuidV4Lowercase(invalid), false, String(invalid));
	});

	it("generates lowercase UUIDv4 values", () => {
		const values = Array.from({ length: 32 }, newUuidV4);
		for (const value of values) assert.equal(isUuidV4Lowercase(value), true);
		assert.equal(new Set(values).size, values.length);
	});
});
