// "Did this change?" for document values, without writing them out. The Studio binding (studio-app-binding.js) asks it
// of the whole document several times per bus command, a camera drag runs one command per pointer move, and all but
// the touched rows are the same objects as last time: an object that is the same object is equal at once, so a check
// costs the size of what changed, not of the document. The answer is exact (nothing is hashed).
//
// Both checks compare a value with an earlier one the caller kept, so a plain object or array must not be changed in
// place after it was handed over: the document stores copy what they are given, hand out deep-frozen slices in
// development (document-store.js) and replace what they change.

const isObject = (value) => value !== null && typeof value === "object";
/** A plain object or array: what JSON.stringify writes field by field. Anything else (a typed array, a Map, a Date,
 *  a class instance, an object with toJSON) is compared through its JSON text. */
function isPlain(value) {
	if (typeof value.toJSON === "function") return false;
	if (Array.isArray(value)) return true;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** What JSON.stringify leaves out of an object and writes as null in an array (an object that is not plain may
 *  write itself as nothing). */
const isLeftOut = (value) => value === undefined || typeof value === "function" || typeof value === "symbol"
	|| (isObject(value) && !isPlain(value) && JSON.stringify(value) === undefined);
const writtenKeys = (value) => Object.keys(value).filter((key) => !isLeftOut(value[key]));

/** Whether JSON.stringify(a) === JSON.stringify(b), read off the values. */
export function sameJson(a, b) {
	if (a === b) return true;
	const objectA = isObject(a), objectB = isObject(b);
	if (!objectA && !objectB) {
		if (isLeftOut(a) || isLeftOut(b)) return isLeftOut(a) && isLeftOut(b);
		// a number that is not finite is written as null
		const written = (value) => typeof value === "number" && !Number.isFinite(value) ? null : value;
		return written(a) === written(b);
	}
	if ((objectA && !isPlain(a)) || (objectB && !isPlain(b))) return JSON.stringify(a) === JSON.stringify(b);
	if (!objectA || !objectB) return false;
	const array = Array.isArray(a);
	if (array !== Array.isArray(b)) return false;
	if (array) {
		if (a.length !== b.length) return false;
		for (let index = 0; index < a.length; index++) {
			if (!sameJson(isLeftOut(a[index]) ? null : a[index], isLeftOut(b[index]) ? null : b[index])) return false;
		}
		return true;
	}
	const keysA = writtenKeys(a), keysB = writtenKeys(b);
	return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && sameJson(a[key], b[key]));
}

/** Whether two plain data values hold the same fields and the same leaves (Object.is), key order aside. Stricter
 *  than sameJson (an undefined field is not a missing one, -0 is not 0); two objects that are not plain are the
 *  same only when they are one object. */
export function sameData(a, b) {
	if (Object.is(a, b)) return true;
	if (!isObject(a) || !isObject(b) || !isPlain(a) || !isPlain(b) || Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}
