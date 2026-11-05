/**
 * `cclay live capture`: one PNG with --out, or a run of timeline frames with
 * --frames A-B --out-dir DIR (#1074), one `capture_framing_png { frame }` per
 * frame in one live session.
 *
 * For a run, the editor poses the cast and parks the shot camera at each frame
 * the way the video export does, then puts both back, so there is no seek round
 * trip and the playhead never moves. The confirmed `export.shotVideo` stays
 * behind its click: these bytes only cross the socket, and this process writes
 * them.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LiveCliError } from "./client.mjs";
import { pngFromCaptureFrame, pngFromDataUrl } from "./studio.mjs";

const MAX_FRAMES = 10_000;
const FRAME_FILE = /^\d{6}\.png$/;
const RUN_FLAGS = ["--frames", "--out-dir", "--step", "--force"];

/** `--frames A-B` (inclusive) or `--frames N`, every `--step` frames. */
function frameList(flags, usage) {
	if (!flags.has("--frames")) throw usage("--out-dir, --step and --force go with --frames");
	if (flags.has("--out")) throw usage("--frames writes into --out-dir, not --out");
	const match = /^(\d+)(?:-(\d+))?$/.exec(String(flags.get("--frames")).trim());
	if (!match) throw usage("--frames takes start-end or one frame, for example 0-242");
	const first = Number(match[1]), last = Number(match[2] ?? match[1]);
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw usage("--frames needs start <= end");
	const step = flags.has("--step") ? Number(flags.get("--step")) : 1;
	if (!Number.isSafeInteger(step) || step < 1) throw usage("--step must be a positive integer");
	// Checked before the list is built: a huge range is a typo, not a shot.
	const count = Math.floor((last - first) / step) + 1;
	if (count > MAX_FRAMES) throw usage(`--frames asks for ${count} frames; one run takes at most ${MAX_FRAMES}`);
	const frames = [];
	for (let frame = first; frame <= last; frame += step) frames.push(frame);
	return frames;
}

/** A glob encode reads every PNG in the folder, so a run starts from none:
 * --force clears an earlier run's frame files, and anything else is the
 * operator's to move. */
function emptyFrameDir(dir, force) {
	mkdirSync(dir, { recursive: true });
	const pngs = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".png"));
	if (force) for (const name of pngs.filter((entry) => FRAME_FILE.test(entry))) rmSync(join(dir, name));
	const left = force ? pngs.filter((name) => !FRAME_FILE.test(name)) : pngs;
	if (left.length === 0) return;
	throw new LiveCliError("DIR_NOT_EMPTY", `${dir} already holds ${left.length} PNG file(s), e.g. ${left[0]}; an encode would pick them up.`, {
		recovery: { action: "select", hint: force ? "--force only removes frame files (000042.png); move the other PNGs out" : "pass an empty --out-dir, or --force to replace its frame files" },
		details: { dir, png: left.slice(0, 5) },
	});
}

/** Each file is named for its timeline frame, six digits: DIR/000042.png. */
async function captureRun(flags, { command, progress, usage }) {
	const frames = frameList(flags, usage);
	const outDir = flags.get("--out-dir");
	if (typeof outDir !== "string" || !outDir) throw usage("capture --frames needs --out-dir");
	const dir = resolve(outDir);
	emptyFrameDir(dir, flags.get("--force") === true);
	let bytes = 0, size = null;
	for (const [index, frame] of frames.entries()) {
		try {
			const value = await command("capture_framing_png", { frame });
			// An editor from before #1074 ignores the frame and answers the playhead.
			if (value?.frame !== frame) throw new LiveCliError("EDITOR_ERROR", `The editor answered frame ${value?.frame} for frame ${frame}; reload the Studio tab so it runs a build with batch capture.`);
			const png = pngFromDataUrl(value.dataUrl);
			writeFileSync(join(dir, `${String(frame).padStart(6, "0")}.png`), png);
			bytes += png.byteLength;
			size ??= { width: value.width, height: value.height };
		} catch (error) {
			if (error && typeof error === "object") error.details = { ...(error.details ?? {}), dir, frame, written: index };
			throw error;
		}
		if ((index + 1) % 24 === 0 || index + 1 === frames.length) progress(`captured ${index + 1}/${frames.length} frames`);
	}
	return { ok: true, dir, frames: frames.length, first: frames[0], last: frames.at(-1), bytes, ...size };
}

export async function captureVerb(flags, context) {
	if (RUN_FLAGS.some((key) => flags.has(key))) return captureRun(flags, context);
	const outFlag = flags.get("--out");
	if (typeof outFlag !== "string" || !outFlag) throw context.usage("capture needs --out");
	const out = resolve(outFlag);
	if (flags.get("--framing") === true) {
		const value = await context.command("capture_framing_png", {});
		const bytes = pngFromDataUrl(value?.dataUrl);
		writeFileSync(out, bytes);
		return { path: out, width: value.width, height: value.height, bytes: bytes.byteLength };
	}
	const value = await context.command("capture_frame", {});
	const bytes = pngFromCaptureFrame(value);
	writeFileSync(out, bytes);
	return { path: out, width: value.width, height: value.height, bytes: bytes.byteLength, assertions: value.assertions };
}
