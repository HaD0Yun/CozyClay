// The refusal texts of validateStudioSchema (studio-agent-protocol.js). Every text starts with the
// path ("$.args.topic") and says what the schema allows there: the allowed values, the allowed
// fields, the expected type or bounds. What arrived is named by its kind ("got a string"), or by
// a short preview of a scalar (at most 40 characters), never as a whole payload such as an image.
// Shared by the browser and the sidecar: no imports.
const LIST_MAX = 24, PREVIEW_MAX = 40;

const preview = value => {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 3)}...` : text;
};
const kindOf = value => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object"
	: typeof value === "number" && !Number.isFinite(value) ? String(value) : `a ${typeof value}`);
/** A list of names, cut after LIST_MAX with how many there are in all. */
const listOf = values => (values.length > LIST_MAX ? `${values.slice(0, LIST_MAX).join(", ")}, ... (${values.length} in all)` : values.join(", "));
const typeName = schema => (Object.hasOwn(schema, "const") ? JSON.stringify(schema.const) : schema.type === "integer" ? "an integer"
	: schema.type === "array" ? `an array${schema.items?.type ? ` of ${schema.items.type}s` : ""}`
		: schema.type === "object" ? "an object" : schema.type === "null" ? "null" : `a ${schema.type}`);

/** Wrong type, or a constant that differs: what the schema wants and what arrived. */
export const wrongType = (path, schema, value) => `${path}: expected ${typeName(schema)}, got ${Object.hasOwn(schema, "const") ? preview(value) : kindOf(value)}.`;

export const unknownField = (path, schema, key) => {
	const allowed = Object.keys(schema.properties);
	return `${path} has unknown field ${preview(key)}; ${allowed.length ? `allowed: ${listOf(allowed)}` : "it takes no fields"}.`;
};

export const missingField = (path, key) => `${path}: missing required field "${key}".`;

/** An array of the wrong type or length. */
export function arrayRefusal(path, schema, value) {
	if (!Array.isArray(value)) return wrongType(path, schema, value);
	const lo = schema.minItems ?? 0, hi = schema.maxItems ?? Infinity;
	const want = lo === hi ? `exactly ${lo}` : hi === Infinity ? `at least ${lo}` : lo === 0 ? `at most ${hi}` : `${lo} to ${hi}`;
	// x-studio-bound says why the bound is what it is (frame_shot subjectIds: one character), so the retry is right.
	return `${path}: expected ${want} item${lo === hi && lo === 1 ? "" : "s"}, got ${value.length}.${schema["x-studio-bound"] ? ` ${schema["x-studio-bound"]}` : ""}`;
}

export const duplicateItem = (path, items) => {
	const seen = new Set(), twice = items.map(item => JSON.stringify(item)).find(text => (seen.has(text) ? true : (seen.add(text), false)));
	return `${path}: items must be unique; ${twice && twice.length <= PREVIEW_MAX ? twice : "one item"} appears twice.`;
};

/** A string of the wrong type, empty, too long, or off its pattern. */
export function stringRefusal(path, schema, value) {
	if (typeof value !== "string") return wrongType(path, schema, value);
	if (!value.trim()) return `${path}: must not be empty.`;
	const length = [...value].length;
	if (schema.maxLength !== undefined && length > schema.maxLength) return schema.description ? `${path}: over ${schema.maxLength} characters. ${schema.description}` : `${path}: at most ${schema.maxLength} characters, got ${length}.`;
	return `${path}: ${preview(value)} does not match ${schema.pattern}.`;
}

export const enumRefusal = (path, schema, value) => `${path}: ${preview(value)} is not one of: ${listOf(schema.enum)}.`;

/** A number of the wrong type, not an integer, or not above an exclusive minimum. */
export function numberRefusal(path, schema, value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return wrongType(path, schema, value);
	if (schema.type === "integer" && !Number.isSafeInteger(value)) return `${path}: expected an integer, got ${value}.`;
	return `${path}: must be greater than ${schema.exclusiveMinimum}, got ${value}.`;
}

const isPlain = schema => ((schema.oneOf ?? schema.anyOf) ? (schema.oneOf ?? schema.anyOf).every(isPlain) : schema.type !== "object" && schema.type !== "array");
const bounded = schema => [schema.minimum, schema.maximum].some(bound => bound !== undefined) ? ` within [${[schema.minimum ?? "-inf", schema.maximum ?? "inf"].join(", ")}]` : "";
/** Each value or type a schema admits, in words: true, false, "ifClean", an integer within [1, 8]. */
const formsOf = schema => ((schema.oneOf ?? schema.anyOf) ? (schema.oneOf ?? schema.anyOf).flatMap(formsOf)
	: Object.hasOwn(schema, "const") ? [JSON.stringify(schema.const)] : schema.enum ? schema.enum.map(v => JSON.stringify(v))
		: schema.type === "boolean" ? ["true", "false"] : [`${typeName(schema)}${schema.type === "number" || schema.type === "integer" ? bounded(schema) : ""}`]);

/**
 * A union no branch matched, when every branch failed at the union's own path and the branches are
 * plain values (or the value is not an object): `$.args.install must be true, false or "ifClean",
 * got "yes".` Otherwise null, and the caller surfaces the deepest branch failure.
 */
export function unionRefusal(path, failures, value) {
	if (!failures.every(({ error }) => error.details?.path === path)) return null;
	if (value !== null && typeof value === "object" && !failures.every(({ branch }) => isPlain(branch))) return null;
	const forms = [...new Set(failures.flatMap(({ branch }) => formsOf(branch)))];
	const shown = forms.length > LIST_MAX ? [...forms.slice(0, LIST_MAX), `... (${forms.length} in all)`] : forms;
	const words = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}` : shown[0];
	return `${path} must be ${words}, got ${value !== null && typeof value === "object" ? kindOf(value) : preview(value)}.`;
}
