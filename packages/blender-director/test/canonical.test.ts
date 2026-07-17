import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalJson, canonicalNumber, canonicalRevision, canonicalString } from "../src/canonical.ts";

const fixturesDirectory = join(import.meta.dirname, "fixtures");

interface NumberCase {
	readonly value: number;
	readonly expected: string;
}

const numberCases = JSON.parse(readFileSync(join(fixturesDirectory, "canonical-numbers.json"), "utf8")) as NumberCase[];

interface ParityFixture {
	readonly revision: string;
	readonly snapshot: unknown;
}

const parity = JSON.parse(readFileSync(join(fixturesDirectory, "parity-snapshot.json"), "utf8")) as ParityFixture;

describe("canonical numbers", () => {
	it("matches the shared cross-language number table", () => {
		// Given adversarial binary64 values with expected canonical strings
		for (const { value, expected } of numberCases) {
			// When each value is serialized, then it matches the Python output byte for byte
			assert.equal(canonicalNumber(value), expected, `canonicalNumber(${value})`);
		}
		assert.ok(numberCases.length >= 30);
	});

	it("resolves exact 1e-9 ties with round-half-even", () => {
		// 2^-10 * 1e9 = 976562.5 exactly: even quotient stays, odd quotient rounds up
		assert.equal(canonicalNumber(0.0009765625), "0.000976562");
		assert.equal(canonicalNumber(0.0029296875), "0.002929688");
	});

	it("normalizes negative zero and sub-resolution values to zero", () => {
		assert.equal(canonicalNumber(-0), "0");
		assert.equal(canonicalNumber(1e-10), "0");
		assert.equal(canonicalNumber(-1e-10), "0");
	});

	it("rejects non-finite and out-of-magnitude values", () => {
		assert.throws(() => canonicalNumber(Number.NaN));
		assert.throws(() => canonicalNumber(Number.POSITIVE_INFINITY));
		assert.throws(() => canonicalNumber(1e15));
		assert.throws(() => canonicalNumber(-1e15));
	});
});

describe("canonical strings and keys", () => {
	it("normalizes to NFC and applies minimal escaping", () => {
		// Given a decomposed e + combining acute accent
		assert.equal(canonicalString("e\u0301"), '"\u00e9"');
		assert.equal(canonicalString('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\u0001"');
	});

	it("sorts object keys by code point, not locale", () => {
		// localeCompare would order "a" before "B"; code-point order must not
		assert.equal(canonicalJson({ a: 1, B: 2 }), '{"B":2,"a":1}');
	});
});

describe("canonical revision parity", () => {
	it("reproduces the Python-computed revision of the shared snapshot fixture", () => {
		// Given the committed v2-shaped snapshot with non-ASCII names
		// When the revision is computed from the parsed JSON
		// Then it matches the hash the Python serializer committed
		assert.equal(canonicalRevision(parity.snapshot), parity.revision);
	});

	it("re-canonicalizes its own output to identical bytes", () => {
		const first = canonicalJson(parity.snapshot);
		const second = canonicalJson(JSON.parse(first));
		assert.equal(second, first);
	});
});
