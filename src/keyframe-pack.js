// Keyframe pack export: bundles a shot's reference material into a ZIP that
// can be dropped into Seedance-style multi-reference video tools. Each pack
// is one folder holding first/last frames, an optional motion clip, the
// camera state, the prompt, and a README explaining what each file is for.

import { buildZip } from "./zip-store.js";

function slugifyTitle(title) {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "shot";
}

/** ZIP file name for a shot pack: `cozyclay-shot-<index>-<slug>.zip`. */
export function keyframePackName(shot) {
	return `cozyclay-shot-${shot.index}-${slugifyTitle(shot.title)}.zip`;
}

function readmeText({ shot, fps, hasLast, hasClip, ext }) {
	const lines = [
		`CozyClay keyframe pack - shot ${shot.index}: ${shot.title}`,
		`Frame range ${shot.startFrame}-${shot.endFrame} at ${fps} fps.`,
		"",
		"This pack is a multi-reference bundle for Seedance-style tools.",
		"Each file plays a distinct reference role:",
		"",
		"- first.png: identity reference. The first frame defines what the",
		"  subject and scene must look like when the shot begins.",
	];
	if (hasLast) {
		lines.push(
			"- last.png: motion endpoint reference. The final frame pins where",
			"  the motion should land, constraining the generated trajectory.",
		);
	} else {
		lines.push(
			"- last.png: not included. Without an endpoint the tool is free to",
			"  choose how the motion resolves.",
		);
	}
	if (hasClip) {
		lines.push(
			`- clip.${ext}: motion reference. The source clip carries the movement`,
			"  the generated video should follow.",
		);
	} else {
		lines.push(
			`- clip.${ext}: not included. Without a motion clip the tool must`,
			"  invent the movement from the frames and prompt alone.",
		);
	}
	lines.push(
		"- camera.json: camera reference. The recorded camera move, fps, and",
		"  frame range to reproduce the framing over time.",
		"- prompt.txt: the text prompt describing the intended action.",
	);
	lines.push(
		"",
		"Not in this pack: the shot-wide depth video (blocking-depth.mp4) is a",
		"separate export - use Depth (mp4) in the export menu.",
	);
	return lines.join("\n") + "\n";
}

/**
 * Build the ZIP entries for one shot's keyframe pack.
 * @param {object} args
 * @param {{ title: string, index: number, startFrame: number, endFrame: number }} args.shot
 * @param {string} [args.folder] folder inside the zip, default `<index>-<slug>`
 * @param {number} args.fps
 * @param {Uint8Array} args.firstFramePng
 * @param {Uint8Array | null} args.lastFramePng
 * @param {{ data: Uint8Array, ext: "mp4" | "webm" } | null} args.clip
 * @param {object} args.camera
 * @param {string} args.prompt
 * @returns {Array<{ name: string, data: Uint8Array | string }>} entries for buildZip
 */
export function keyframePackEntries({ shot, fps, firstFramePng, lastFramePng, clip, camera, prompt, folder = `${shot.index}-${slugifyTitle(shot.title)}` }) {
	const entries = [{ name: `${folder}/first.png`, data: firstFramePng }];
	if (lastFramePng != null) entries.push({ name: `${folder}/last.png`, data: lastFramePng });
	if (clip != null) entries.push({ name: `${folder}/clip.${clip.ext}`, data: clip.data });
	const range = { startFrame: shot.startFrame, endFrame: shot.endFrame };
	entries.push(
		{ name: `${folder}/camera.json`, data: JSON.stringify({ ...camera, fps, ...range }, null, 2) + "\n" },
		{ name: `${folder}/prompt.txt`, data: `${prompt}\n` },
		{ name: `${folder}/README.txt`, data: readmeText({ shot, fps, hasLast: lastFramePng != null, hasClip: clip != null, ext: clip ? clip.ext : "mp4" }) },
	);
	return entries;
}

/** Convenience wrapper: entries plus the archive bytes. */
export function buildKeyframePack(args) {
	return buildZip(keyframePackEntries(args));
}
