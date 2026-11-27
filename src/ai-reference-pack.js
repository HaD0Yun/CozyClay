// AI video reference pack: the zip the Export menu's "AI video reference"
// writes. It carries the timeline rendered as the blurmove reference
// (blurmove-ref.js) plus a README that says how to use it.
//
// Pure: no DOM. App.jsx renders the video and hands the bytes in.

import { BLURMOVE } from "./blurmove-ref.js";
import { buildZip } from "./zip-store.js";

export const AI_REFERENCE_ZIP = "cozyclay-ai-reference.zip";
export const AI_REFERENCE_VIDEO = "reference.mp4";

// Seedance 2.5 reference video: 2-30 s per clip (model-presets.js).
export const REFERENCE_MAX_SECONDS = 30;

function readmeText({ seconds, shotCount, width, height, hasPrompt = false }) {
	const lines = [
		"CozyClay AI video reference",
		`${shotCount} shot${shotCount === 1 ? "" : "s"}, ${seconds.toFixed(2)} s, ${width}x${height}.`,
		"",
		`- ${AI_REFERENCE_VIDEO}: put this in your video tool's Video Reference slot`,
		"  (Seedance 2.5 on Krea, Artlist, fal, BytePlus...). It is your previs",
		"  with most detail taken out on purpose:",
		`  in every ${BLURMOVE.cycle} frames, ${BLURMOVE.on} frame is a light mosaic and the rest keep playing`,
		"  under a heavy blur. The model keeps the camera, the cuts and the",
		"  blocking, and fills the look and the in-between motion itself, so the",
		"  grey mannequins and their stiff poses do not come back.",
		"",
		"Do not sharpen or replace it with the plain previs export: the model",
		"copies whatever the reference shows frame by frame.",
	];
	if (hasPrompt) {
		lines.push(
			"",
			"- prompt.txt: paste it as the prompt. It names each shot's camera move,",
			"  the cuts and the cast, and who and what is in frame: where, how big,",
			"  when it enters or leaves and which way it moves, all read from your",
			"  scene. Objects still named after their shape (Box 3) are left out, so",
			"  name the ones that matter (Bus stop, Red truck). @vid1 is this video and",
			"  @img1, @img2... are your character images in the order listed; swap in",
			"  your tool's own reference tags (Krea: @vid-1, @img-1). It calls the",
			"  video a damaged copy on purpose: that keeps the blocks and blur out of",
			"  the result. Say it once; do not add more mentions of the video.",
			"- scene-facts.json: the same facts as data (cuts, camera, cast and what is in frame per shot).",
		);
	}
	if (seconds > REFERENCE_MAX_SECONDS) {
		lines.push("", `Note: the timeline is longer than ${REFERENCE_MAX_SECONDS} s, the Seedance 2.5 reference limit. Trim it before uploading.`);
	}
	return lines.join("\n") + "\n";
}

/**
 * @param {object} args
 * @param {Uint8Array} args.video     the rendered blurmove mp4
 * @param {number} args.fps
 * @param {number} args.frameCount
 * @param {number} args.shotCount
 * @param {{ width: number, height: number }} args.size
 * @param {Array<{ name: string, data: Uint8Array | string }>} [args.extra] more entries (prompt, facts)
 */
export function aiReferenceEntries({ video, fps, frameCount, shotCount, size, extra = [] }) {
	const seconds = frameCount / fps;
	return [
		{ name: AI_REFERENCE_VIDEO, data: video },
		...extra,
		{ name: "README.txt", data: readmeText({ seconds, shotCount, width: size.width, height: size.height, hasPrompt: extra.some((entry) => entry.name === "prompt.txt") }) },
	];
}

export function buildAiReferencePack(args) {
	return buildZip(aiReferenceEntries(args));
}
