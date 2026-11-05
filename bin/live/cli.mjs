/**
 * `cclay live …` — drive a running Studio from a terminal.
 *
 * The hub already owns workspace routing, admission and typed failures, so this
 * file is deliberately thin: parse a verb, read the one context an admitted
 * command needs, forward JSON, and print exactly one JSON object. Progress
 * goes to stderr, so `cclay live … | jq` never sees anything but the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { captureVerb } from "./capture.mjs";
import { connectController, discoverEndpoint, LiveCliError, resolveLivePort } from "./client.mjs";
import { admissionEnvelope, describeEditors, inspectArguments, numberedPath, pngFromDataUrl, selectWorkspace } from "./studio.mjs";

const USAGE = `cclay live - drive a running CozyClay studio from a terminal

  cclay live status [--wait]             the hub, its editors, and the selected one
  cclay live describe                    read the live scene document
  cclay live inspect --scope selection|scene|entities|shot|motion|catalogue
                                         [--ids a,b] [--query text] [--limit n] [--cursor c]
  cclay live capture --out frame.png [--framing]
  cclay live capture --frames 0-242 --out-dir frames/ [--step N] [--force]
  cclay live arrange-objects --op '<json>' | -f ops.json
  cclay live arrange-characters --op '<json>' | -f ops.json
  cclay live patch --target <kind>[:<id>] --set '<json>'
                                         kind: character|object|shot|stage; paths from
                                         'cclay live inspect --scope catalogue'
  cclay live frame-shot --subject <id> --size "medium shot" --view front --level eye
                                         [--side left] [--focal 50]
  cclay live frame-shot --subject <id> --exact px,py,pz,lx,ly,lz,focal
  cclay live operate [--select object:<id>] [--frame N] [--mode scene|camera|motion]
                                         [--play | --pause]
  cclay live verify (--receipt <id> | --targets a,b) --checks placement,framing
                                         [--range whole_clip|start:end] [--strict]
                                         [--visual frame|contact_sheet|plan|trace [--frames even|beats] --out check.png]
  cclay live undo --receipt <id>
  cclay live commands [--ids a,b]        the commands the editor registers; ids add schemas
  cclay live run <id> [--args '<json>']  any command the editor registers, admitted like
                                         the agent's run_action; waits its declared timeout
  cclay live cmd <name> --args '<json>'   any live-protocol command
  cclay live tool <name> --args '<json>'  any registry tool, e.g. describe_shot

Global flags: --workspace <handle|project>  --timeout <ms>  --pretty  --live-port <port>

Discovery: --live-port, then COZYCLAY_LIVE_PORT, then 5184. The hub token comes
from the endpoint file its owner published; COZYCLAY_LIVE_TOKEN overrides it.

Units are metres, degrees and +Y up; ids are the ids the editor uses.
Exit codes: 0 ok - 1 editor or receipt error - 2 usage - 3 no hub -
4 workspace - 5 timeout or uncertain apply - 6 stale scene or busy target.`;

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(["--force", "--pretty", "--wait", "--framing", "--play", "--pause", "--strict"]);
const GLOBAL_FLAGS = ["--workspace", "--timeout", "--pretty", "--live-port"];
const VERBS = new Map([
	["status", { flags: ["--wait"] }],
	["describe", { flags: [] }],
	["inspect", { flags: ["--scope", "--ids", "--query", "--limit", "--cursor"] }],
	["capture", { flags: ["--out", "--framing", "--frames", "--out-dir", "--step", "--force"] }],
	["arrange-objects", { flags: ["--op", "-f", "--file"], command: "arrange_objects" }],
	["arrange-characters", { flags: ["--op", "-f", "--file"], command: "arrange_characters" }],
	["patch", { flags: ["--target", "--set"], command: "patch_elements" }],
	["frame-shot", { flags: ["--subject", "--size", "--view", "--level", "--side", "--focal", "--exact"] }],
	["operate", { flags: ["--select", "--frame", "--mode", "--play", "--pause"] }],
	["verify", { flags: ["--receipt", "--targets", "--checks", "--range", "--strict", "--visual", "--frames", "--out"] }],
	["undo", { flags: ["--receipt"] }],
	["commands", { flags: ["--ids"] }],
	["run", { flags: ["--args"], argument: "command id" }],
	["cmd", { flags: ["--args"], argument: "command name" }],
	["tool", { flags: ["--args"], argument: "tool name" }],
]);

/** One action and one sentence per stable code: a terminal that fails should
 * say what to do next, not only what went wrong. */
const RECOVERY = {
	NO_SERVER: { action: "start", hint: "run `npm run dev` or `cclay`" },
	NO_EDITOR: { action: "open", hint: "open the studio in a browser so an editor connects to this hub" },
	AMBIGUOUS_WORKSPACE: { action: "select", hint: "repeat the verb with --workspace <handle>" },
	STALE_HANDLE: { action: "select", hint: "run `cclay live status` and use a handle that is connected now" },
	TIMEOUT: { action: "inspect", hint: "the editor never answered; read the scene back before retrying" },
	UNCERTAIN_APPLY: { action: "reconcile", hint: "do not retry; the reconcile status reports whether it applied" },
	STALE_SCENE: { action: "inspect", hint: "the document moved under this command; read it again and re-issue" },
	STALE_TARGET: { action: "inspect", hint: "a target moved under this command; read it again and re-issue" },
	TARGET_BUSY: { action: "retry", hint: "the target is busy; wait for the edit in flight to finish" },
	USAGE: { action: "none", hint: "run `cclay live --help`" },
};
const EXIT_CODES = new Map([
	["USAGE", 2], ["DIR_NOT_EMPTY", 2],
	["NO_SERVER", 3],
	["NO_EDITOR", 4], ["AMBIGUOUS_WORKSPACE", 4], ["STALE_HANDLE", 4],
	["TIMEOUT", 5], ["UNCERTAIN_APPLY", 5],
	["STALE_SCENE", 6], ["STALE_TARGET", 6], ["TARGET_BUSY", 6],
]);
const exitCodeFor = (code) => EXIT_CODES.get(code) ?? 1;
const recoveryFor = (code) => RECOVERY[code] ?? { action: "none", hint: "read the message and details below" };

const write = (stream, text) => new Promise((done) => stream.write(text, done));
const emit = (value, pretty) => write(process.stdout, `${JSON.stringify(value, null, pretty ? "\t" : undefined)}\n`);
const progress = (message) => { process.stderr.write(`live: ${message}\n`); };

/** stdout carries one JSON object; a bare value still gets an envelope. */
const shape = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : { ok: true, value });

const usageFailure = (message) => ({ ok: false, error: { code: "USAGE", message, recovery: recoveryFor("USAGE") } });

function toFailure(error) {
	const code = error instanceof LiveCliError ? error.code : "EDITOR_ERROR";
	const body = { code, message: error?.message ?? String(error), recovery: error?.recovery ?? recoveryFor(code) };
	if (error?.details !== undefined) body.details = error.details;
	return { ok: false, error: body };
}

/** The hub's own typed failure, kept whole: its code decides the exit code and
 * its sentence becomes the hint. */
function hubFailure(body) {
	const code = typeof body?.code === "string" ? body.code : "EDITOR_ERROR";
	return new LiveCliError(code, body?.message ?? "The live hub rejected the request.", {
		recovery: { ...recoveryFor(code), ...(typeof body?.recovery === "string" ? { hint: body.recovery } : {}) },
		details: body?.details,
	});
}

/** A refused Studio command answers with a failure receipt rather than a hub
 * error; its own code and recovery action pass straight through. */
function receiptFailure(receipt) {
	const code = typeof receipt?.code === "string" ? receipt.code : "EDITOR_ERROR";
	return new LiveCliError(code, receipt?.message ?? `The Studio refused the command (${code}).`, {
		recovery: { ...recoveryFor(code), ...(receipt?.recovery ?? {}) },
		details: { receipt },
	});
}

const unwrap = (frame) => {
	if (frame?.ok === true) return frame.value;
	throw hubFailure(frame?.error);
};

function parseInvocation(argv) {
	const [verb, ...rest] = argv;
	const spec = VERBS.get(verb);
	if (!spec) throw new UsageError(`unknown verb ${verb ? `"${verb}"` : "(none given)"}`);
	const flags = new Map();
	const positional = [];
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("-")) {
			positional.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const key = equals === -1 ? token : token.slice(0, equals);
		if (!spec.flags.includes(key) && !GLOBAL_FLAGS.includes(key)) throw new UsageError(`${verb} does not take ${key}`);
		if (BOOLEAN_FLAGS.has(key)) {
			if (equals !== -1) throw new UsageError(`${key} takes no value`);
			flags.set(key, true);
			continue;
		}
		let value;
		if (equals === -1) {
			index += 1;
			value = rest[index];
		} else {
			value = token.slice(equals + 1);
		}
		if (value === undefined) throw new UsageError(`${key} needs a value`);
		flags.set(key, value);
	}
	if (spec.argument && positional.length !== 1) throw new UsageError(`${verb} needs exactly one ${spec.argument}`);
	if (!spec.argument && positional.length > 0) throw new UsageError(`${verb} takes no positional arguments (got ${positional.join(" ")})`);
	return { verb, spec, name: positional[0] ?? null, flags };
}

const required = (flags, key, verb) => {
	const value = flags.get(key);
	if (typeof value !== "string" || !value) throw new UsageError(`${verb} needs ${key}`);
	return value;
};
const commaList = (value) => String(value).split(",").map((part) => part.trim()).filter(Boolean);
const numberFlag = (flags, key) => {
	const value = Number(flags.get(key));
	if (!Number.isFinite(value)) throw new UsageError(`${key} must be a number`);
	return value;
};
const integerFlag = (flags, key) => {
	const value = Number(flags.get(key));
	if (!Number.isSafeInteger(value)) throw new UsageError(`${key} must be an integer`);
	return value;
};
const frameRangeFlag = (flags, key) => {
	const raw = String(flags.get(key));
	if (raw === "whole_clip") return raw;
	const match = /^(\d+):(\d+)$/.exec(raw);
	if (!match) throw new UsageError(`${key} must be whole_clip or start:end`);
	const startFrame = Number(match[1]), endFrameExclusive = Number(match[2]);
	if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrameExclusive) || endFrameExclusive <= startFrame) throw new UsageError(`${key} must have a nonempty start:end range`);
	return { startFrame, endFrameExclusive };
};
const jsonFlag = (flags, key) => {
	let parsed;
	try {
		parsed = JSON.parse(String(flags.get(key)));
	} catch (error) {
		throw new UsageError(`${key} is not valid JSON: ${error.message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`${key} must be a JSON object`);
	return parsed;
};

function timeoutFlag(flags) {
	if (!flags.has("--timeout")) return undefined;
	const value = integerFlag(flags, "--timeout");
	if (value <= 0) throw new UsageError("--timeout must be a positive integer in milliseconds");
	return value;
}

function livePortFlag(flags) {
	if (!flags.has("--live-port")) return resolveLivePort();
	const port = Number(flags.get("--live-port"));
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--live-port must be an integer in 1..65535");
	return resolveLivePort(port);
}

/** `--op` for one operation or a list of them, `-f` for a file holding either;
 * `{ "ops": [...] }` additionally carries collisionPolicy. */
function operationArguments(flags, verb) {
	const file = flags.get("-f") ?? flags.get("--file");
	const hasFile = file !== undefined;
	const hasInline = flags.has("--op");
	if (hasFile === hasInline) throw new UsageError(`${verb} needs exactly one of --op '<json>' or -f ops.json`);
	let raw;
	if (hasFile) {
		try {
			raw = readFileSync(String(file), "utf8");
		} catch (error) {
			throw new UsageError(`could not read ${file}: ${error.message}`);
		}
	} else {
		raw = String(flags.get("--op"));
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new UsageError(`${hasFile ? String(file) : "--op"} is not valid JSON: ${error.message}`);
	}
	if (Array.isArray(parsed)) return { ops: parsed };
	if (parsed !== null && typeof parsed === "object") return Array.isArray(parsed.ops) ? parsed : { ops: [parsed] };
	throw new UsageError(`${verb} expects one operation object, an array of them, or { "ops": [ … ] }`);
}

/** `--target kind[:id]` names one entity, `--set '<json>'` carries declared
 * element paths. One patch is one target kind, so one commit domain. */
function patchArguments(flags, verb) {
	const raw = String(required(flags, "--target", verb));
	const colon = raw.indexOf(":");
	if (colon === 0 || colon === raw.length - 1) throw new UsageError("--target takes kind or kind:id, for example character:char-a");
	const target = colon < 0 ? { kind: raw } : { kind: raw.slice(0, colon), id: raw.slice(colon + 1) };
	required(flags, "--set", verb);
	const set = jsonFlag(flags, "--set");
	return { ops: [{ target, set }] };
}

function framingArguments(flags, verb) {
	const args = { subjectIds: [required(flags, "--subject", verb)] };
	if (flags.has("--exact")) {
		for (const key of ["--size", "--view", "--level", "--side", "--focal"]) {
			if (flags.has(key)) throw new UsageError(`--exact replaces ${key}`);
		}
		const numbers = commaList(flags.get("--exact")).map(Number);
		if (numbers.length !== 7 || numbers.some((value) => !Number.isFinite(value))) throw new UsageError("--exact takes px,py,pz,lx,ly,lz,focal");
		args.framing = { exact: {
			position: { x: numbers[0], y: numbers[1], z: numbers[2] },
			lookAt: { x: numbers[3], y: numbers[4], z: numbers[5] },
			focalMm: numbers[6],
		} };
		return args;
	}
	// The shot vocabulary always measures a side; left is the default the
	// editor would otherwise have to guess at.
	const intent = {
		size: required(flags, "--size", verb),
		view: required(flags, "--view", verb),
		level: required(flags, "--level", verb),
		side: flags.has("--side") ? String(flags.get("--side")) : "left",
	};
	if (flags.has("--focal")) intent.focalMm = numberFlag(flags, "--focal");
	args.framing = { intent };
	return args;
}

function operateArguments(flags) {
	const args = {};
	if (flags.has("--select")) {
		const raw = String(flags.get("--select"));
		const colon = raw.indexOf(":");
		if (colon <= 0 || colon === raw.length - 1) throw new UsageError("--select takes kind:id, for example object:cube-1");
		args.selection = { kind: raw.slice(0, colon), id: raw.slice(colon + 1) };
	}
	if (flags.has("--frame")) args.frame = integerFlag(flags, "--frame");
	if (flags.has("--mode")) args.mode = String(flags.get("--mode"));
	if (flags.get("--play") === true && flags.get("--pause") === true) throw new UsageError("--play and --pause are exclusive");
	if (flags.get("--play") === true) args.playing = true;
	if (flags.get("--pause") === true) args.playing = false;
	if (Object.keys(args).length === 0) throw new UsageError("operate needs at least one of --select, --frame, --mode, --play or --pause");
	return args;
}

async function runVerb({ client, verb, spec, name, flags }) {
	const timeoutMs = timeoutFlag(flags);
	const forwarded = timeoutMs === undefined ? {} : { timeoutMs };
	let handle = null;

	const hubStatus = async () => unwrap(await client.request({ type: "status" }));
	const workspace = async () => {
		if (handle === null) handle = selectWorkspace((await hubStatus()).editors, flags.get("--workspace"));
		return handle;
	};
	const command = async (commandName, args, options = forwarded) =>
		unwrap(await client.request({ type: "cmd", name: commandName, args, workspaceHandle: await workspace(), ...options }, options));

	// Recovery reads deliberately ignore --timeout: the bound the operator set
	// for their command is not a reason to lose the evidence about it.
	const reconcile = async (envelope) => {
		try {
			const value = await command("reconcile_studio_command", { commandId: envelope.commandId, host: envelope.host }, {});
			return { status: typeof value?.status === "string" ? value.status : "unknown", ...(value?.receipt ? { receipt: value.receipt } : {}) };
		} catch (error) {
			return { status: "unknown", reason: error.message };
		}
	};
	const admitted = async (commandName, args, { context, options = forwarded } = {}) => {
		const envelope = admissionEnvelope(commandName, args, context ?? await command("inspect_studio", { scope: "selection" }));
		try {
			const value = await command(commandName, envelope, options);
			if (value?.ok === false) throw receiptFailure(value);
			return value;
		} catch (error) {
			if (error?.code !== "UNCERTAIN_APPLY") throw error;
			error.details = { ...(error.details ?? {}), commandId: envelope.commandId, reconcile: await reconcile(envelope) };
			throw error;
		}
	};
	/** A raw command has no receipt journal to reconcile against, so the scene
	 * it left behind is the only evidence there is. */
	const raw = async (work) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code !== "UNCERTAIN_APPLY") throw error;
			try {
				const description = await command("describe", {}, {});
				error.recovery = { action: "inspect", hint: {
					objects: description?.objects?.length ?? 0,
					characters: description?.characters?.length ?? 0,
					camera: description?.camera ?? null,
				} };
			} catch {
				/* a hub that cannot even describe leaves the uncertainty standing */
			}
			throw error;
		}
	};

	if (verb === "status") {
		const waiting = flags.get("--wait") === true;
		const bound = timeoutMs ?? 30_000;
		const deadline = Date.now() + bound;
		let announced = false;
		for (;;) {
			// Mark the event log BEFORE the read, so an editor that connects
			// during the round trip is found in the buffer instead of missed.
			const mark = client.eventCount();
			const value = await hubStatus();
			let selected = null;
			try {
				selected = selectWorkspace(value.editors, flags.get("--workspace"));
			} catch {
				// Status reports what is there; it never fails on ambiguity.
				selected = null;
			}
			if (selected !== null || !waiting) return { server: value.server, editors: describeEditors(value.editors), selected };
			if (!announced) {
				announced = true;
				progress("waiting for a selectable editor to connect");
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new LiveCliError("TIMEOUT", `No selectable editor connected within ${bound} ms.`);
			await client.nextEvent("editor_connected", { since: mark, timeoutMs: remaining });
		}
	}

	if (verb === "describe") return command("describe", {});

	if (verb === "inspect") {
		const args = { scope: required(flags, "--scope", verb) };
		return command("inspect_studio", { ...args, ...inspectArguments(flags, integerFlag) });
	}

	if (verb === "capture") return captureVerb(flags, { command, progress, usage: (message) => new UsageError(message) });

	if (verb === "arrange-objects" || verb === "arrange-characters") return admitted(spec.command, operationArguments(flags, verb));

	if (verb === "patch") return admitted(spec.command, patchArguments(flags, verb));

	if (verb === "frame-shot") return admitted("frame_shot", framingArguments(flags, verb));

	if (verb === "operate") return admitted("operate_studio", operateArguments(flags));

	if (verb === "verify") {
		const hasReceipt = flags.has("--receipt"), hasTargets = flags.has("--targets");
		if (hasReceipt === hasTargets) throw new UsageError("verify needs exactly one of --receipt or --targets");
		const args = { checks: commaList(required(flags, "--checks", verb)), ...(hasReceipt ? { receiptId: required(flags, "--receipt", verb) } : { targets: commaList(required(flags, "--targets", verb)) }) };
		if (flags.has("--range")) args.range = frameRangeFlag(flags, "--range");
		const visual = flags.has("--visual") ? String(flags.get("--visual")) : "none";
		if (visual !== "none") Object.assign(args, { visual }, flags.has("--frames") ? { frames: String(flags.get("--frames")) } : {});
		const out = visual === "none" ? null : resolvePath(required(flags, "--out", verb));
		const value = await admitted("verify_result", args);
		if (flags.get("--strict") === true && value?.checks?.framing?.issueFrames?.length) {
			throw new LiveCliError("VERIFICATION_FAILED", `Sampled framing found ${value.checks.framing.issueFrames.length} problematic frame(s).`, { details: value.checks.framing.issueFrames });
		}
		if (out === null) return value;
		const written = [];
		for (const [index, reference] of (value?.visualRefs ?? []).entries()) {
			const image = await command("resolve_studio_image", {
				imageId: reference.imageId,
				...(value.receiptId ? { receiptId: value.receiptId } : {}),
				...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}),
			});
			const bytes = pngFromDataUrl(image?.dataUrl);
			const path = numberedPath(out, index);
			writeFileSync(path, bytes);
			written.push({ imageId: reference.imageId, path, width: image?.width ?? null, height: image?.height ?? null, bytes: bytes.byteLength });
		}
		return { ...value, visual: written };
	}

	if (verb === "undo") return admitted("undo_edit", { receiptId: required(flags, "--receipt", verb) });

	if (verb === "commands") {
		const value = await command("inspect_studio", { scope: "actions", ...(flags.has("--ids") ? { ids: commaList(flags.get("--ids")) } : {}) });
		return { actions: value?.actions ?? [] };
	}

	if (verb === "run") {
		const args = flags.has("--args") ? jsonFlag(flags, "--args") : {};
		// The editor declares the command: one read gives the context to admit
		// at and the deadline it needs, which --timeout overrides.
		const inspected = await command("inspect_studio", { scope: "actions", ids: [name] });
		const deadline = timeoutMs ?? inspected?.actions?.find((row) => row.id === name)?.timeoutMs;
		return admitted("run_action", { action: name, args }, { context: inspected, options: deadline === undefined ? {} : { timeoutMs: deadline } });
	}

	if (verb === "cmd") return raw(() => command(name, flags.has("--args") ? jsonFlag(flags, "--args") : {}));

	if (verb === "tool") {
		const args = flags.has("--args") ? jsonFlag(flags, "--args") : {};
		return raw(async () => unwrap(await client.request({ type: "tool", name, args, workspaceHandle: await workspace() })));
	}

	throw new UsageError(`unsupported verb "${verb}"`);
}

export async function runLiveCli(argv) {
	if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
		await write(process.stdout, `${USAGE}\n`);
		return 0;
	}
	let invocation;
	try {
		invocation = parseInvocation(argv);
	} catch (error) {
		await write(process.stderr, `${USAGE}\n`);
		await emit(usageFailure(error.message), false);
		return 2;
	}
	const pretty = invocation.flags.get("--pretty") === true;
	let client = null;
	try {
		client = await connectController(discoverEndpoint(livePortFlag(invocation.flags)));
		await emit(shape(await runVerb({ client, ...invocation })), pretty);
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			await write(process.stderr, `${USAGE}\n`);
			await emit(usageFailure(error.message), pretty);
			return 2;
		}
		const failure = toFailure(error);
		await emit(failure, pretty);
		return exitCodeFor(failure.error.code);
	} finally {
		client?.close();
	}
}
