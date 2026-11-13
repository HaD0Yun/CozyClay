// prepareArguments for every pi tool (pi-tools.mjs). pi runs it before its own schema check, so
// this is where a call can be repaired or refused with words pi's check leaves out:
//   - An array argument sent as JSON text ("[\"motion.compile\"]") is parsed. A model's tool-call
//     encoder sometimes stringifies a nested array; pi would wrap the whole text as one item and
//     refuse it as a bad id ("ids.0: must match pattern"), so the model retries blind. The intent
//     is unambiguous, so it is taken, and the parsed array is still validated in full. Text that
//     does not parse to an array is left for the schema check to refuse.
//   - An unknown field in a closed object is refused by name, with the fields allowed there. pi
//     says only "root: must not have additional properties", and a model then resends the call
//     unchanged. The message keeps pi's "Validation failed for tool" prefix (agent-routes.mjs
//     shortens that prefix for the browser).
export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const where = at => at || "root";

function parseArrayText(value) {
	if (typeof value !== "string" || !value.trimStart().startsWith("[")) return value;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		return value;
	}
}

/** The value with array texts parsed along the schema's arrays and closed objects; unknown fields go to problems. */
function prepare(schema, value, at, problems) {
	if (schema?.type === "array") {
		const parsed = parseArrayText(value);
		return Array.isArray(parsed) && schema.items ? parsed.map((item, i) => prepare(schema.items, item, `${at}[${i}]`, problems)) : parsed;
	}
	if (schema?.type !== "object" || !isRecord(value)) return value;
	const properties = schema.properties ?? {}, allowed = Object.keys(properties);
	const unknown = schema.additionalProperties === false ? Object.keys(value).filter(key => !Object.hasOwn(properties, key)) : [];
	// a misnamed field usually leaves a required one out: name both in the one refusal
	const missing = unknown.length ? (schema.required ?? []).filter(key => !Object.hasOwn(value, key)) : [];
	if (unknown.length) problems.push(`${where(at)} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map(key => JSON.stringify(key)).join(", ")}; allowed: ${allowed.join(", ") || "no fields"}${missing.length ? `; missing required: ${missing.join(", ")}` : ""}`);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Object.hasOwn(properties, key) ? prepare(properties[key], item, at ? `${at}.${key}` : key, problems) : item]));
}

/** prepareArguments(args) for one tool: parsed array texts, or a throw naming every unknown field. */
export function toolArgumentPreparer(name, schema) {
	return args => {
		const problems = [], prepared = prepare(schema, args, "", problems);
		if (!problems.length) return prepared;
		const actionHint = name === "run_action" && isRecord(args) && Object.keys(args).some(key => !Object.hasOwn(schema.properties ?? {}, key))
			? " The action's own inputs go inside args: { \"action\": \"<id>\", \"args\": { ... } }." : "";
		throw new Error(`Validation failed for tool "${name}": ${problems.join("; ")}.${actionHint}`);
	};
}
