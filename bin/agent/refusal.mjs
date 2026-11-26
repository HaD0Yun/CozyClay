// One refusal form for every tool of a Studio turn (pi-tools.mjs, tool-arguments.mjs): the line "<CODE>: <message>" a
// model and the panel read as before, then one JSON line with what the code knows of the cause. A script's nested
// refusal carries the same facts in its calls row (script-tool.mjs). The facts:
//   tool     the tool that refused (inside a script: the nested tool)
//   at       the argument it names, as a path into that call's arguments (ops[2].target), when the message or the
//            check names one
//   asked    the value the call sent there (cut at ASKED_CHARS characters of JSON)
//   allowed  the values the schema allows there, when the check has a closed list
//   changed  whether the scene changed: false when no command reached the editor or the editor says so,
//            true when the editor says so, "unknown" otherwise (a lost answer, a stop); a raiser that undid a
//            call itself states which of the three holds (the motion door's guard)
//   retry    "allowed" only when the editor marks the cause as one that clears by itself; otherwise absent
//   schema   the action's input schema, on the first refusal of an action's arguments in a turn (studio-tools.mjs)
// No hint that does not follow from the cause: the old "(inspect, do not retry)" stood on every refusal.

const ASKED_CHARS = 240;
// Codes the sidecar raises before any command reaches the editor (argument checks, the agent view's refusals, a running
// motion), unless the error itself states what became of the scene (changed: the motion door's guard raises
// MOTION_RUNNING after a call ran and was undone, motion-door.mjs).
const NOT_SENT = new Set(["INVALID_ARGUMENT", "NOT_AVAILABLE", "MOTION_RUNNING"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** "$.args.ops[0].target" (protocol and bus checks), "$.ops[0].target" (tool-arguments.mjs) or "/ops/0/target" (TypeBox) -> ["ops", 0, "target"]. */
function pathSteps(path) {
	if (typeof path !== "string" || !path) return null;
	// a TypeBox path keeps each key whole (a patch path such as "keyLight.x" is one key)
	if (path.startsWith("/")) return path.slice(1).split("/").map(step => (/^\d+$/.test(step) ? Number(step) : step.replaceAll("~1", "/").replaceAll("~0", "~")));
	return [...path.replace(/^\$(\.args)?/, "").matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map(match => (match[2] === undefined ? match[1] : Number(match[2])));
}
const written = steps => steps.map((step, i) => (typeof step === "number" ? `[${step}]` : `${i ? "." : ""}${step}`)).join("");
const valueAt = (value, steps) => steps.reduce((at, step) => (at !== null && typeof at === "object" && Object.hasOwn(at, step) ? at[step] : undefined), value);

/**
 * The path the error names: its own details, else a "$.args..." path at the start of its message, else a field name
 * at the start of its message ("over: ...") when the call sent that field (for run_action: inside its args).
 */
function namedPath(error, tool, args) {
	if (typeof error?.details?.path === "string" && error.details.path !== "$") return error.details.path;
	const message = String(error?.rawMessage ?? error?.message ?? "");
	const named = /^(\$\.args[^\s:]*):/.exec(message)?.[1];
	if (named) return named;
	const field = /^([A-Za-z_][\w]*(?:\[\d+\]|\.[A-Za-z_]\w*)*): /.exec(message)?.[1];
	if (!field) return null;
	const steps = pathSteps(`$.${field}`), base = tool === "run_action" ? args?.args : args;
	return steps?.length && valueAt(base, steps) !== undefined ? `$.args.${field}` : null;
}

/**
 * Where a refusal points inside the call's arguments. A run_action's own fields are action, args, confirmationToken;
 * the editor checks the action's input as "$.args...", which is the call's args.args.
 */
function located(tool, args, path) {
	let steps = pathSteps(path);
	if (!steps?.length) return {};
	if (tool === "run_action" && path.startsWith("$.args") && !["action", "args", "confirmationToken"].includes(steps[0])) steps = ["args", ...steps];
	// A check may read the call more kindly than it was written (pi reads a single value as a list of one): the place ends where the call's own arguments end.
	while (steps.length > 1 && valueAt(args, steps.slice(0, -1)) === undefined) steps = steps.slice(0, -1);
	const asked = valueAt(args, steps), text = asked === undefined ? undefined : JSON.stringify(asked);
	return { at: written(steps), ...(text === undefined ? {} : { asked: text.length > ASKED_CHARS ? `${text.slice(0, ASKED_CHARS)}…` : asked }) };
}

/** Whether the scene changed, from the editor's refusal receipt, else what the raiser states, else where the code was raised. */
function changedOf(error) {
	const receipt = error?.receipt;
	if (isRecord(receipt)) {
		if (receipt.mutated === true || receipt.mutated === false) return receipt.mutated;
		if (receipt.preserved?.authoredState === "unchanged") return false;
		if (receipt.preserved?.authoredState === "changed") return true;
		return "unknown";
	}
	if (error?.changed === true || error?.changed === false || error?.changed === "unknown") return error.changed;
	return NOT_SENT.has(error?.code) ? false : "unknown";
}

/** The facts of one refusal as an object: { code, message, tool, at?, asked?, allowed?, changed, retry?, schema? }. */
export function refusalFacts(error, { tool, args } = {}) {
	const code = error?.code || "BACKEND_UNAVAILABLE";
	const message = String(error?.rawMessage ?? error?.message ?? "Tool execution failed.");
	const allowed = Array.isArray(error?.details?.allowed) ? error.details.allowed : undefined;
	return { code, message, ...(tool ? { tool } : {}), ...located(tool, args, namedPath(error, tool, args)), ...(allowed ? { allowed } : {}),
		changed: changedOf(error), ...(error?.receipt?.recovery?.retryAllowed === true ? { retry: "allowed" } : {}), ...(isRecord(error?.schema) ? { schema: error.schema } : {}) };
}

/** The text a model reads for a refusal: "<CODE>: <message>" and the facts line. */
function refusalText(error, call = {}) {
	if (error?.refusal === true) return String(error.message);
	const { code, message, ...facts } = refusalFacts(error, call);
	return `${code}: ${message}\n${JSON.stringify(facts)}`;
}

/** The error with its message in the refusal form, marked so a wrapper above it does not format it twice. */
export function asRefusal(error, call = {}) {
	const target = error instanceof Error ? error : new Error(String(error));
	if (target.refusal === true) return target;
	const text = refusalText(target, call);
	return Object.assign(target, { rawMessage: target.rawMessage ?? target.message, message: text, refusal: true });
}
