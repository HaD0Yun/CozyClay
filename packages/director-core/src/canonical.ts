// Canonical JSON serialization and revision hashing for Scene Snapshot v2.
// Contract: docs/SCENE-SNAPSHOT-V2.md §4. Must stay byte-identical to
// blender-addon/cclay/canonical.py; the shared fixture
// test/fixtures/canonical-numbers.json guards parity in both test suites.

import { createHash } from "node:crypto";

const TEN_POW_9 = 1_000_000_000n;
const MAX_MAGNITUDE = 1e15;

/**
 * Serialize a finite binary64 as decimal rounded half-even to 1e-9,
 * trailing fractional zeros stripped, `-0` as `"0"`, no exponent notation.
 *
 * The integer rule of the spec (base-10, no leading zeros) coincides with
 * this algorithm for integral values, so all JSON numbers go through here.
 */
export function canonicalNumber(value: number): string {
	if (!Number.isFinite(value)) throw new Error(`canonical number must be finite, got ${value}`);
	if (Math.abs(value) >= MAX_MAGNITUDE) throw new Error(`canonical number magnitude must be < 1e15, got ${value}`);
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	if (bits << 1n === 0n) return "0"; // +0 and -0
	const negative = bits >> 63n === 1n;
	const exponentBits = Number((bits >> 52n) & 0x7ffn);
	const mantissaBits = bits & 0xf_ffff_ffff_ffffn;
	// Exact magnitude is mantissa * 2^exponent.
	const mantissa = exponentBits === 0 ? mantissaBits : mantissaBits | (1n << 52n);
	const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
	// scaled = round_half_even(magnitude * 1e9), computed exactly over BigInt.
	let scaled: bigint;
	if (exponent >= 0) {
		scaled = (mantissa * TEN_POW_9) << BigInt(exponent);
	} else {
		const numerator = mantissa * TEN_POW_9;
		const denominator = 1n << BigInt(-exponent);
		const quotient = numerator / denominator;
		const remainder = numerator % denominator;
		const doubled = remainder * 2n;
		scaled = doubled > denominator || (doubled === denominator && (quotient & 1n) === 1n) ? quotient + 1n : quotient;
	}
	if (scaled === 0n) return "0";
	const sign = negative ? "-" : "";
	const integerPart = scaled / TEN_POW_9;
	const fractionPart = (scaled % TEN_POW_9).toString().padStart(9, "0").replace(/0+$/, "");
	return fractionPart === "" ? `${sign}${integerPart}` : `${sign}${integerPart}.${fractionPart}`;
}

/** NFC-normalize and serialize with JSON minimal escaping. */
export function canonicalString(value: string): string {
	const normalized = value.normalize("NFC");
	let out = '"';
	for (const character of normalized) {
		const code = character.codePointAt(0) as number;
		if (character === '"') out += '\\"';
		else if (character === "\\") out += "\\\\";
		else if (code < 0x20) {
			if (character === "\b") out += "\\b";
			else if (character === "\t") out += "\\t";
			else if (character === "\n") out += "\\n";
			else if (character === "\f") out += "\\f";
			else if (character === "\r") out += "\\r";
			else out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else out += character;
	}
	return `${out}"`;
}

function compareCodePoints(left: string, right: string): number {
	const leftPoints = [...left];
	const rightPoints = [...right];
	const shared = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < shared; index++) {
		const difference = (leftPoints[index].codePointAt(0) as number) - (rightPoints[index].codePointAt(0) as number);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

/**
 * Serialize a parsed JSON value to canonical bytes: code-point-sorted NFC keys,
 * no whitespace, numbers per canonicalNumber. Array order is preserved —
 * semantic sorting happens in the schema layer before serialization.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return canonicalNumber(value);
	if (typeof value === "string") return canonicalString(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.map(([key, nested]) => [key.normalize("NFC"), nested] as const)
			.sort(([left], [right]) => compareCodePoints(left, right));
		return `{${entries.map(([key, nested]) => `${canonicalString(key)}:${canonicalJson(nested)}`).join(",")}}`;
	}
	throw new Error(`value is not canonical JSON serializable: ${typeof value}`);
}

/** Lowercase-hex SHA-256 of the UTF-8 canonical bytes. */
export function canonicalRevision(value: unknown): string {
	return createHash("sha256")
		.update(Buffer.from(canonicalJson(value), "utf8"))
		.digest("hex");
}
