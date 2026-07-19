#!/usr/bin/env node
import { runDirectorTui } from "./app.ts";

function daemonArguments(argv: readonly string[], environment: NodeJS.ProcessEnv): readonly string[] {
	if (argv.length > 0) return argv;
	const configured = environment.OMB_DAEMON_ARGS?.trim();
	if (configured === undefined || configured === "") {
		throw new Error("NOT_CONFIGURED: pass --faux or --provider <id> --model <id>");
	}
	return configured.split(/\s+/);
}

try {
	await runDirectorTui({
		projectDirectory: process.cwd(),
		daemonArguments: daemonArguments(process.argv.slice(2), process.env),
	});
} catch (error) {
	const message = error instanceof Error ? error.message : "OMB_TUI_FAILED: controller startup failed";
	process.stderr.write(`${message.slice(0, 512)}\n`);
	process.exitCode = 1;
}
