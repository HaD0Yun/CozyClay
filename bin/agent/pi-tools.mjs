import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { STUDIO_TOOL_LABELS } from "../../src/studio-agent-protocol.js";
import { toTypeBox } from "./schema-to-typebox.mjs";
import { toolArgumentPreparer } from "./tool-arguments.mjs";
import { asRefusal } from "./refusal.mjs";


function dataUrlImage(dataUrl) {
	const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || "");
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

// A result's pictures: dataUrl (one), dataUrls (several: a script's nested pictures, script-tool.mjs). Both leave the text.
const PICTURE_KEYS = new Set(["dataUrl", "dataUrls"]);
function publicResult(result) {
	if (!result || typeof result !== "object" || Array.isArray(result) || ![...PICTURE_KEYS].some(key => Object.hasOwn(result, key))) return result;
	return Object.fromEntries(Object.entries(result).filter(([key]) => !PICTURE_KEYS.has(key)));
}
const picturesOf = result => (!result || typeof result !== "object" || Array.isArray(result) ? [] : [result.dataUrl, ...(Array.isArray(result.dataUrls) ? result.dataUrls : [])].map(dataUrlImage).filter(Boolean));

// What a model can never use leaves the text it reads (the panel keeps the whole result): detailCursor, which no tool accepts.
const modelView = details => (details && typeof details === "object" ? JSON.parse(JSON.stringify(details, (key, value) => (key === "detailCursor" ? undefined : value))) : details);

// One tool result rides whole in every later model call of its turn (studio-context-budget.mjs shrinks only older ones),
// so a result past this many characters is cut, with a note on how to ask for less. A scene-document read once
// answered 470k characters, ~300k tokens a call for the rest of that turn.
export const RESULT_CHARS = 100_000;
export function resultText(details) {
	const text = JSON.stringify(details ?? null);
	if (text.length <= RESULT_CHARS) return text;
	return `${text.slice(0, RESULT_CHARS)} … [cut: this result is ${text.length} characters, over the ${RESULT_CHARS}-character limit for one tool result. `
		+ "Ask for less: name ids, select kinds, page with cursor, or read it inside a script and return only what you need.]";
}

/** The handler's result, unless the run is stopped first: then the call ends at once as aborted, as it did under pi's
 * removed AgentHarness. The handler may still settle in the background; its result no longer counts. */
function untilAborted(pending, signal) {
	const aborted = () => Object.assign(new Error("Stopped before this call finished."), { name: "AbortError", code: "ABORTED" });
	if (!signal) return pending;
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(aborted());
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
// Whether the value breaks a constant the form itself states (its own fields, not those of a form inside it): the
// call then named another form.
const namesAnother = (form, value) => (form?.const !== undefined ? value !== form.const
	: isRecord(form?.properties) && isRecord(value) && Object.entries(form.properties).some(([key, sub]) => key in value && namesAnother(sub, value[key])));

/**
 * The failed rule to tell of a value that does not match its schema: { rule, path, allowed?, forms? }, found by going
 * down to where the value first breaks a rule. Where the schema offers several forms (anyOf) the rule told is of the
 * form the call named (the one form whose own constants it matches), else of the form with the fewest failures, and
 * `forms` then counts the forms it was the nearest of. A missing field and an unknown field are told by name, the
 * unknown one with the fields allowed beside it. (TypeBox alone lists the failures of every form, the first form first,
 * and stops at eight.)
 */
function failedRule(schema, value, path = "") {
	if (Array.isArray(schema?.anyOf)) {
		const named = schema.anyOf.filter(form => !namesAnother(form, value)), pool = named.length ? named : schema.anyOf;
		const failures = form => [...Value.Errors(form, value)].length;
		const told = failedRule(pool.reduce((best, form) => (failures(form) < failures(best) ? form : best)), value, path);
		return named.length === 1 ? told : { ...told, forms: told.forms ?? schema.anyOf.length };
	}
	if (isRecord(schema?.properties) && isRecord(value)) {
		const missing = (schema.required ?? []).filter(key => !(key in value));
		if (missing.length) return { rule: `missing required field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, path: `${path}/${missing[0]}` };
		const unknown = schema.additionalProperties === false ? Object.keys(value).find(key => !Object.hasOwn(schema.properties, key)) : undefined;
		if (unknown !== undefined) return { rule: `unknown field ${JSON.stringify(unknown)}`, path: `${path}/${unknown}`, allowed: Object.keys(schema.properties) };
		const broken = Object.keys(schema.properties).find(key => key in value && !Value.Check(schema.properties[key], value[key]));
		if (broken !== undefined) return failedRule(schema.properties[broken], value[broken], `${path}/${broken}`);
	}
	if (isRecord(schema?.items) && Array.isArray(value)) {
		const broken = value.findIndex(item => !Value.Check(schema.items, item));
		if (broken !== -1) return failedRule(schema.items, value[broken], `${path}/${broken}`);
	}
	const first = [...Value.Errors(schema, value)][0];
	if (!first) return { rule: "", path };
	const allowed = Array.isArray(first.params?.allowedValues) ? first.params.allowedValues : first.keyword === "const" ? [first.params?.allowedValue] : undefined;
	return { rule: `${first.keyword}: ${first.message}`, path: `${path}${first.instancePath}`, ...(allowed ? { allowed } : {}) };
}

/** The refusal (refusal.mjs form) of `params` that do not match the TypeBox `parameters`, else null. `sent`: the arguments as the call wrote them, which `asked` quotes. */
function argumentRefusal(name, parameters, params, sent = params) {
	if (Value.Check(parameters, params)) return null;
	const { rule, path, allowed, forms } = failedRule(parameters, params);
	const error = Object.assign(new Error(`Invalid arguments for ${name}${rule ? `: ${rule}` : "."}${forms ? ` (the nearest of ${forms} forms)` : ""}`), { code: "INVALID_ARGUMENT", details: { ...(path ? { path } : {}), ...(allowed ? { allowed } : {}) } });
	return asRefusal(error, { tool: name, args: sent });
}

/** Throws INVALID_ARGUMENT in the refusal form (refusal.mjs), naming the failed rule and its path, when `params` do not match the TypeBox `parameters`. */
export function assertToolArguments(name, parameters, params) {
	const refusal = argumentRefusal(name, parameters, params);
	if (refusal) throw refusal;
}

// pi's own check runs after prepareArguments and forgives what a provider's JSON adds: an optional field sent as null
// counts as left out, and text is converted to the declared type (pi-ai validateToolArguments). The check before it
// refuses exactly what pi would refuse, so only the wording of a refusal changes: pi decides, and the rule told is
// read from the arguments as pi reads them.
function asPiReads(parameters, args) {
	const dropNulls = (value, schema) => {
		if (Array.isArray(value)) { if (schema?.items && !Array.isArray(schema.items)) for (const item of value) dropNulls(item, schema.items); return; }
		if (!value || typeof value !== "object" || !schema?.properties) return;
		const required = new Set(schema.required ?? []);
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (!(key in value)) continue;
			if (value[key] === null && !required.has(key) && !Value.Check(sub, null)) delete value[key]; else dropNulls(value[key], sub);
		}
	};
	const read = structuredClone(args);
	dropNulls(read, parameters); Value.Convert(parameters, read);
	return read;
}
function refusedByPi(name, parameters, args) {
	try { validateToolArguments({ name, parameters }, { name, arguments: args }); return null; } catch { return argumentRefusal(name, parameters, asPiReads(parameters, args), args); }
}

/**
 * Convert CozyClay's handler catalogue into pi AgentTools; ready AgentTools pass through unchanged.
 * plain: a surface whose tools are not the Studio's (the Workflow agent) keeps its errors as they were, "<CODE>:
 * <message>" and pi's own wording of a schema failure, without the Studio refusal form.
 */
export function toAgentTools(tools, { emit, signal, labels = STUDIO_TOOL_LABELS, plain = false } = {}) {
	return (Array.isArray(tools) ? tools : []).map((tool) => {
		// A ready pi AgentTool (it has its own execute) passes through as the same object.
		if (typeof tool?.execute === "function") return tool;
		const schema = tool.parameters || { type: "object", properties: {}, additionalProperties: false }, parameters = toTypeBox(schema);
		// Before pi's own check: array texts parsed, unknown fields named (tool-arguments.mjs), and what pi would refuse
		// refused here, so a refused call reads in the refusal form, never in pi's own wording.
		const prepare = toolArgumentPreparer(tool.name, schema, plain ? undefined : args => { const refusal = refusedByPi(tool.name, parameters, args); if (refusal) throw refusal; });
		return {
			name: tool.name,
			label: labels?.[tool.name] ?? tool.label ?? tool.name.replaceAll("_", " "),
			description: tool.description || tool.name,
			parameters,
			prepareArguments: plain ? args => { try { return prepare(args); } catch (error) { throw new Error(`Validation failed for tool "${tool.name}": ${error.rawMessage ?? error.message}`, { cause: error }); } } : prepare,
			// pi's `Agent` calls `execute(id, params, signal, onUpdate)`, where `signal`
			// is the REAL run abort signal (session.abort() fires it); a caller that
			// passes none gets the adapter's own fallback signal.
			execute: async (toolCallId, params, runSignal) => {
				const executeSignal = runSignal ?? signal;
				assertToolArguments(tool.name, parameters, params);
				try {
					const result = await untilAborted(Promise.resolve(tool.handler(params, { signal: executeSignal, toolCallId, emit })), executeSignal);
					const details = publicResult(result);
					return { content: [{ type: "text", text: resultText(modelView(details)) }, ...picturesOf(result)], details };
				} catch (error) {
					if (!plain) throw asRefusal(error, { tool: tool.name, args: params });
					error.message = `${error?.code || "BACKEND_UNAVAILABLE"}: ${error?.message || "Tool execution failed."}`;
					throw error;
				}
			},
		};
	});
}
