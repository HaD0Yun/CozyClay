// JSON Schema (the V4Tool inputSchema) -> the Zod raw shape the Agent SDK's tool() takes.
// Unlike jsonSchemaToZodShape (anthropic-subscription-stream.mjs), an object whose only content is
// `additionalProperties: <schema>` becomes a record, so a map such as the track tool's `objects`
// keeps its keys instead of being stripped by z.object.
import { z } from "zod";

const bounded = (type, s, min, max) => {
	let out = type;
	if (Number.isFinite(s[min])) out = out.min(s[min]);
	if (Number.isFinite(s[max])) out = out.max(s[max]);
	return out;
};

function literalUnion(values) {
	if (values.every(value => typeof value === "string")) return z.enum(values);
	const literals = values.map(value => (value === null ? z.null() : z.literal(value)));
	return literals.length === 1 ? literals[0] : z.union(literals);
}

function objectOf(s) {
	const properties = s.properties && typeof s.properties === "object" ? s.properties : {};
	const extra = s.additionalProperties;
	if (!Object.keys(properties).length && extra && typeof extra === "object") return z.record(z.string(), convert(extra));
	const shape = rawShape(s);
	if (extra === false) return z.strictObject(shape);
	if (extra && typeof extra === "object") return z.object(shape).catchall(convert(extra));
	// JSON Schema allows unknown keys by default; keep them.
	return z.looseObject(shape);
}

function convert(node) {
	const s = node && typeof node === "object" ? node : {};
	let out;
	if (s.const !== undefined) out = literalUnion([s.const]);
	else if (Array.isArray(s.enum) && s.enum.length) out = literalUnion(s.enum);
	else if (Array.isArray(s.anyOf ?? s.oneOf) && (s.anyOf ?? s.oneOf).length) {
		const variants = (s.anyOf ?? s.oneOf).map(convert);
		out = variants.length === 1 ? variants[0] : z.union(variants);
	} else {
		const type = Array.isArray(s.type) ? s.type[0] : s.type;
		if (type === "string") {
			out = bounded(z.string(), s, "minLength", "maxLength");
			if (typeof s.pattern === "string") out = out.regex(new RegExp(s.pattern));
		} else if (type === "number") out = bounded(z.number(), s, "minimum", "maximum");
		else if (type === "integer") out = bounded(z.int(), s, "minimum", "maximum");
		else if (type === "boolean") out = z.boolean();
		else if (type === "null") out = z.null();
		else if (type === "array") out = bounded(z.array(s.items ? convert(s.items) : z.unknown()), s, "minItems", "maxItems");
		else if (type === "object") out = objectOf(s);
		else out = z.unknown();
	}
	return typeof s.description === "string" && s.description ? out.describe(s.description) : out;
}

function rawShape(s) {
	const required = new Set(Array.isArray(s?.required) ? s.required : []);
	const shape = {};
	for (const [key, value] of Object.entries(s?.properties ?? {})) {
		const converted = convert(value);
		shape[key] = required.has(key) ? converted : converted.optional();
	}
	return shape;
}

/** The raw shape ({ key: ZodType }) of an object JSON Schema, for sdk.tool(name, description, shape, handler). */
export function zodShape(jsonSchema) {
	return rawShape(jsonSchema ?? {});
}
