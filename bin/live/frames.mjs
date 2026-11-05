/**
 * `cclay live capture --frames A-B --out-dir DIR` (#1074): a run of timeline
 * frames in one live session, one `capture_framing_png { frame }` per frame.
 *
 * The editor poses the cast and parks the shot camera at that frame the way
 * the video export does, then puts both back, so there is no seek round trip
 * and the playhead never moves. The confirmed `export.shotVideo` stays behind
 * its click: these bytes only cross the socket, and this process writes them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LiveCliError } from "./client.mjs";
import { pngFromDataUrl } from "./studio.mjs";

/** `--frames A-B` (inclusive) or `--frames N`, every `--step` frames. */
function frameList(flags, usage) {
	if (!flags.has("--frames")) throw usage("--out-dir and --step go with --frames");
	if (flags.has("--out")) throw usage("--frames writes into --out-dir, not --out");
	const match = /^(\d+)(?:-(\d+))?$/.exec(String(flags.get("--frames")).trim());
	if (!match) throw usage("--frames takes start-end or one frame, for example 0-242");
	const first = Number(match[1]), last = Number(match[2] ?? match[1]);
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw usage("--frames needs start <= end");
	const step = flags.has("--step") ? Number(flags.get("--step")) : 1;
	if (!Number.isSafeInteger(step) || step < 1) throw usage("--step must be a positive integer");
	const frames = [];
	for (let frame = first; frame <= last; frame += step) frames.push(frame);
	return frames;
}

/** Each file is named for its timeline frame, six digits: DIR/000042.png. */
export async function captureFrames(flags, { command, progress, usage }) {
	const frames = frameList(flags, usage);
	const outDir = flags.get("--out-dir");
	if (typeof outDir !== "string" || !outDir) throw usage("capture --frames needs --out-dir");
	const dir = resolve(outDir);
	mkdirSync(dir, { recursive: true });
	let bytes = 0, size = null;
	for (const [index, frame] of frames.entries()) {
		let value;
		try {
			value = await command("capture_framing_png", { frame });
			// An editor from before #1074 ignores the frame and answers the playhead.
			if (value?.frame !== frame) throw new LiveCliError("EDITOR_ERROR", `The editor answered frame ${value?.frame} for frame ${frame}; reload the Studio tab so it runs a build with batch capture.`);
		} catch (error) {
			if (error && typeof error === "object") error.details = { ...(error.details ?? {}), dir, frame, written: index };
			throw error;
		}
		const png = pngFromDataUrl(value.dataUrl);
		writeFileSync(join(dir, `${String(frame).padStart(6, "0")}.png`), png);
		bytes += png.byteLength;
		size ??= { width: value.width, height: value.height };
		if ((index + 1) % 24 === 0 || index + 1 === frames.length) progress(`captured ${index + 1}/${frames.length} frames`);
	}
	return { ok: true, dir, frames: frames.length, first: frames[0], last: frames.at(-1), bytes, ...size };
}
