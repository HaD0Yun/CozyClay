// A short key of a document value's content, for "did this change?" checks that ran on JSON.stringify: equal JSON text
// gives an equal key, different text a different one (a 64-bit hash of the text's structure, so two different values
// share a key with odds of about 1 in 2^64). The Studio binding (studio-app-binding.js) keys the whole document several
// times per bus command, a camera drag runs one command per pointer move, and all but the touched rows are the same
// objects as last time: their keys are remembered, so a key costs the size of what changed, not of the document.
//
// A plain object or array is remembered by identity, so it must not be changed in place after it was keyed: the
// document stores hand out deep-frozen slices in development (document-store.js) and replace what they change. Any
// other object (a typed array, a Map, one with toJSON) is keyed through JSON.stringify each time. A long string (a data
// URL, an encoded take) is remembered by value among the last few.

const keyed = new WeakMap();
const LONG = 4096, LONG_KEPT = 64;
const longKeyed = new Map();
const OBJECT = 1, ARRAY = 2, TEXT = 3, OTHER = 4;

// two independent 32-bit lanes
const step = (h, x) => [Math.imul(h[0] ^ x, 0x01000193) >>> 0, Math.imul((h[1] ^ x) + 0x7f4a7c15 | 0, 0x5bd1e995) >>> 0];
const START = [0x811c9dc5, 0x2545f491];

function textHash(text, tag) {
	let a = Math.imul(START[0] ^ tag, 0x01000193) >>> 0, b = Math.imul(START[1] ^ tag, 0x5bd1e995) >>> 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		a = Math.imul(a ^ code, 0x01000193) >>> 0;
		b = Math.imul((b ^ code) + 0x7f4a7c15 | 0, 0x5bd1e995) >>> 0;
	}
	return [Math.imul(a ^ text.length, 0x01000193) >>> 0, b];
}

function longText(value) {
	const hit = longKeyed.get(value);
	if (hit) return hit;
	const hash = textHash(value, TEXT);
	if (longKeyed.size >= LONG_KEPT) longKeyed.delete(longKeyed.keys().next().value);
	longKeyed.set(value, hash);
	return hash;
}

/** The hash of what JSON.stringify writes for `value` (undefined where it writes nothing). */
function hashOf(value) {
	if (typeof value === "string") return value.length >= LONG ? longText(value) : textHash(value, TEXT);
	if (value === null || typeof value !== "object") {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : textHash(text, OTHER);
	}
	const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
	if (typeof value.toJSON === "function" || (!array && prototype !== Object.prototype && prototype !== null)) {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : textHash(text, OTHER);
	}
	const hit = keyed.get(value);
	if (hit) return hit;
	let hash = step(START, array ? ARRAY : OBJECT);
	if (array) {
		for (let index = 0; index < value.length; index++) {
			const item = hashOf(value[index]) ?? textHash("null", OTHER);
			hash = step(step(hash, item[0]), item[1]);
		}
		hash = step(hash, value.length);
	} else {
		let fields = 0;
		for (const key of Object.keys(value)) {
			const item = hashOf(value[key]);
			if (item === undefined) continue;
			const name = textHash(key, TEXT);
			hash = step(step(step(step(hash, name[0]), name[1]), item[0]), item[1]);
			fields++;
		}
		hash = step(hash, fields);
	}
	keyed.set(value, hash);
	return hash;
}

/** The content key of `value`: equal for values whose JSON text is equal. */
export function contentKey(value) {
	const hash = hashOf(value);
	return hash === undefined ? "undefined" : `${hash[0].toString(36)}.${hash[1].toString(36)}`;
}

/** Whether two plain data values hold the same fields and leaves (Object.is), key order aside. */
export function sameData(a, b) {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}
