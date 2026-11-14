#!/usr/bin/env node
// Authors one lowvis scene from a request with the pi harness (src/lowvis/pi/harness.mjs).
//   node tools/lowvis/pi/run.mjs --name <name> [--model <id>] [--effort <level>] [--images latest|all] [--variant base|lean|patch] "<request>"
// Needs CLIPROXY_BASE_URL and CLIPROXY_API_KEY. Writes public/lowvis/clips/pi/<name>.json and lowvis-out/pi/<name>/.
import { DEFAULT_EFFORT, DEFAULT_MODEL, runScene } from "../../../src/lowvis/pi/harness.mjs";

/** One line per fact of a run record, for the terminal. */
export function summary(run) {
	const s = ms => ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`, u = run.unnecessary;
	if (run.infraError && !run.modelCalls) return [`${run.name}: INFRASTRUCTURE ERROR at ${run.infraError.at}: ${run.infraError.message}`];
	return [
		`${run.name}: ended by ${run.endedBy}${run.infraError ? `: ${run.infraError.message}` : ""}`,
		`  model asked ${run.asked.model} at ${run.asked.effort}; served ${run.served.models.join(", ") || "not exposed"}`,
		`  wall ${s(run.wallMs)}, first compile ${s(run.firstCompileMs)}, model ${s(run.modelMs)} in ${run.modelCalls} calls, tool ${s(run.toolMs)} in ${run.shots} shots`,
		`  tokens: input ${run.tokens.inputFresh} fresh, ${run.tokens.cacheRead} cache read, ${run.tokens.cacheWrite} cache write; output ${run.tokens.output}; context per call average ${run.context.average}, max ${run.context.max}`,
		`  unnecessary actions: ${u.total} (redundant ${u.redundant}, mistakes ${u.mistakes}, sweeps ${u.sweeps}); longest streak of shots on one moment: ${u.streak ? `${u.streak} (shots ${u.list.streak.calls.join(", ")}, frames ${u.list.streak.frames.join("-")})` : "none of 3 or more"}`,
		...u.list.mistakes.map(m => `    mistake at shot ${m.call}: ${m.error}`),
		`  final spec: ${run.final ? `${run.final.specChars} characters, ${run.final.frames} frames` : "none compiled"}`,
		`  Missing: ${run.missing ?? "(no such line)"}`,
		`  safety limit hit: ${run.safety.hit ?? "no"}`,
	];
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	const argv = process.argv.slice(2), opt = {}, rest = [];
	for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i]; else rest.push(argv[i]); }
	if (!opt.name || !rest.length) { console.error('usage: node tools/lowvis/pi/run.mjs --name <name> [--model <id>] [--effort <level>] [--images latest|all] [--variant base|lean] "<request>"'); process.exit(2); }
	const run = await runScene({ name: opt.name, request: rest.join(" "), model: opt.model ?? DEFAULT_MODEL, effort: opt.effort ?? DEFAULT_EFFORT, keepImages: opt.images ?? "latest", variant: opt.variant ?? "base", log: line => console.log(line) });
	console.log(summary(run).join("\n"));
	if (run.report) console.log(`\n${run.report}`);
	process.exit(run.infraError ? 1 : 0);
}
