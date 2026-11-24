// Converts a plain JSON-Schema object (the dialect used by
// src/studio-agent-protocol.js and bin/agent/agent-tools.mjs) into a
// TypeBox TSchema with typebox's `Type` builder. pi's Tool.parameters takes
// it (a TSchema is JSON Schema), and the adapters check a tool call's
// arguments against the same object with typebox's Value.Check
// (pi-tools.mjs), so every CozyClay tool schema passes through this
// converter before it reaches pi.
//
// Structural keywords (type, properties, items, oneOf, anyOf, allOf, const,
// $ref) drive the conversion; everything else on a schema node (enum,
// pattern, minLength/maxLength, minimum/maximum/exclusiveMinimum/
// exclusiveMaximum, multipleOf, minItems/maxItems, uniqueItems,
// additionalProperties, required, description, title, and any x-* vendor
// keyword) is passed straight through to the matching Type.* call as its
// options bag, so TypeBox embeds it verbatim in the produced JSON schema and
// Value.Check enforces it at runtime exactly as the source schema intended.
// `format` is the one exception: it is a hint (e.g. "email", "date-time"),
// not a constraint, so it is dropped rather than forwarded — TypeBox/AJV
// would otherwise enforce it as if it were a pattern.
import { Type } from "typebox";

const STRUCTURAL_OBJECT_KEYS = ["type", "properties"];
const STRUCTURAL_ARRAY_KEYS = ["type", "items"];
const STRUCTURAL_UNION_KEYS = { oneOf: "oneOf", anyOf: "anyOf" };

const rest = (schema, omit) => Object.fromEntries(Object.entries(schema).filter(([key]) => !omit.includes(key)));

/** Pure: walk a JSON-Schema node and return the equivalent TypeBox TSchema.
 * `path` is a JSON pointer used only to name the node in a $ref error. */
export function toTypeBox(schema, path = "#") {
	if (schema === null || typeof schema !== "object") throw new Error(`Unsupported JSON-Schema node at ${path}: expected an object, got ${JSON.stringify(schema)}`);
	if ("$ref" in schema) throw new Error(`$ref is not supported (found at ${path}): ${schema.$ref}`);
	if ("allOf" in schema) return Type.Intersect(schema.allOf.map((sub, index) => toTypeBox(sub, `${path}/allOf/${index}`)), rest(schema, ["allOf"]));
	if ("oneOf" in schema || "anyOf" in schema) {
		const key = "oneOf" in schema ? STRUCTURAL_UNION_KEYS.oneOf : STRUCTURAL_UNION_KEYS.anyOf;
		return Type.Union(schema[key].map((sub, index) => toTypeBox(sub, `${path}/${key}/${index}`)), rest(schema, [key]));
	}
	if ("const" in schema) return Type.Literal(schema.const, rest(schema, ["const", "type"]));

	switch (schema.type) {
		case "object": {
			const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, toTypeBox(value, `${path}/properties/${key}`)]));
			return Type.Object(properties, rest(schema, STRUCTURAL_OBJECT_KEYS));
		}
		case "array": {
			const items = schema.items === undefined ? Type.Unknown() : toTypeBox(schema.items, `${path}/items`);
			return Type.Array(items, rest(schema, STRUCTURAL_ARRAY_KEYS));
		}
		case "string": return Type.String(rest(schema, ["type", "format"]));
		case "number": return Type.Number(rest(schema, ["type"]));
		case "integer": return Type.Integer(rest(schema, ["type"]));
		case "boolean": return Type.Boolean(rest(schema, ["type"]));
		case "null": return Type.Null(rest(schema, ["type"]));
		case undefined:
			if (Array.isArray(schema.enum)) return Type.Union(schema.enum.map((value) => Type.Literal(value)), rest(schema, ["enum"]));
			return Type.Unknown(rest(schema, []));
		default: throw new Error(`Unsupported JSON-Schema "type" at ${path}: ${schema.type}`);
	}
}
