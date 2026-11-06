import { readFileSync } from "node:fs";

export class UsageError extends Error {}

export function jsonFlag(flags, key) {
	let parsed;
	try {
		parsed = JSON.parse(String(flags.get(key)));
	} catch (error) {
		throw new UsageError(`${key} is not valid JSON: ${error.message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`${key} must be a JSON object`);
	return parsed;
}

/** Read large JSON outside argv, before connecting to the live hub. */
export function commandArguments(flags) {
	if (flags.has("--args") && flags.has("--args-file")) throw new UsageError("give only one of --args or --args-file");
	const file = flags.get("--args-file");
	const stdin = flags.get("--args") === "-";
	if (file !== undefined || stdin) {
		let text;
		try {
			text = readFileSync(stdin ? 0 : String(file), "utf8");
		} catch (error) {
			throw new UsageError(`could not read ${stdin ? "stdin" : file}: ${error.message}`);
		}
		return jsonFlag(new Map([["--args", text]]), "--args");
	}
	return flags.has("--args") ? jsonFlag(flags, "--args") : {};
}
