// The text prompt that goes with the AI video reference (ai-reference-pack.js).
//
// The engine only states facts it owns and a model cannot read back from a
// blurred clip: where the cuts are, what each shot's camera does (classified
// from the camera keys by camera-move.js), the lens, who is in the cast, and
// what the operator wrote for each shot (its caption) and for the place.
// The wording follows what held camera, cuts and look on the 2026-11-21..23
// Seedance 2.5 tests:
//   1. reference images get a role, and what not to take from them;
//   2. the reference video is called a damaged copy of the same film, once;
//      the place around the action is a placeholder to fill in;
//   3. the place in concrete words;
//   4. every shot's camera move written out, cuts named between shots;
//   5. live action named once at the end.
// Pure string building: no DOM; runs in node tests.

import { lensWordFromFocalMm } from "./shot-prompt.js";

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * @param {object} input
 * @param {Array<{ name?: string, startFrame: number, endFrame: number, caption?: string }>} input.shots
 * @param {number} input.fps
 * @param {Array<string>} [input.cast]           cast names, in reference-image order
 * @param {Array<{ phrase?: string, focalMm?: number }>} [input.shotCameras] one per shot
 * @param {string} [input.setting]                the place and look, as the operator wrote it
 */
export function aiReferenceFacts({ shots = [], fps = 24, cast = [], shotCameras = [], setting = "" } = {}) {
	const ordered = shots
		.map((entry, index) => ({ entry, camera: shotCameras[index] ?? {} }))
		.sort((a, b) => a.entry.startFrame - b.entry.startFrame);
	const facts = ordered.map(({ entry, camera }, index) => ({
		index: index + 1,
		title: typeof entry.name === "string" ? entry.name : `Shot ${index + 1}`,
		startS: round2(entry.startFrame / fps),
		endS: round2((entry.endFrame + 1) / fps),
		focalMm: Number.isFinite(camera.focalMm) ? Math.round(camera.focalMm) : null,
		lens: Number.isFinite(camera.focalMm) ? lensWordFromFocalMm(camera.focalMm) : null,
		camera: typeof camera.phrase === "string" && camera.phrase ? camera.phrase : "static, locked-off shot",
		moving: typeof camera.phrase === "string" && camera.phrase !== "" && !/^static/.test(camera.phrase),
		action: typeof entry.caption === "string" ? entry.caption.trim() : "",
	}));
	return {
		fps,
		durationS: facts.length ? facts[facts.length - 1].endS : 0,
		cuts: facts.slice(1).map((shot) => shot.startS),
		cast: cast.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()),
		setting: typeof setting === "string" ? setting.trim() : "",
		shots: facts,
	};
}

const sentence = (text) => {
	const value = text.trim();
	if (!value) return "";
	return /[.!?]$/.test(value) ? value : `${value}.`;
};

function shotLine(shot, first) {
	const lens = shot.focalMm ? `, ${shot.focalMm}mm` : "";
	const head = first ? `Shot ${shot.index}${lens}` : `Cut to shot ${shot.index}${lens}`;
	const camera = shot.moving ? `one continuous move: ${shot.camera}` : shot.camera;
	return [`${head}, ${camera}.`, sentence(shot.action)].filter(Boolean).join(" ");
}

/**
 * @param {ReturnType<typeof aiReferenceFacts>} facts
 * @returns {string} the prompt, paragraphs separated by blank lines
 */
export function buildAiReferencePrompt(facts) {
	const blocks = [];
	if (facts.cast.length) {
		const roles = facts.cast.map((name, index) => `@img${index + 1} is ${name}.`).join(" ");
		blocks.push(`${roles} Use these images only for faces and clothes, not their poses or backgrounds.`);
	}
	blocks.push("@vid1 is a badly compressed low-resolution copy of the film. Its square pixel blocks and blur are compression damage, not part of the scene. Recover the original film behind it: same camera moves, same cuts, same timing, and the same actions of the people and vehicles. The damage also wiped out most of the place around them, so the buildings, walls and objects in the copy are only rough placeholders; fill the place in fully as a real, lived-in location.");
	const moving = facts.shots.some((shot) => shot.moving);
	const count = facts.shots.length;
	const shape = count > 1
		? `The film has ${count} shots${moving ? ", and the camera keeps moving inside each one" : ""}.`
		: moving ? "The film is one shot, and the camera keeps moving." : "";
	blocks.push([sentence(facts.setting), shape].filter(Boolean).join(" "));
	blocks.push(facts.shots.map((shot, index) => shotLine(shot, index === 0)).join(" "));
	blocks.push("Real live-action footage shot on 35mm film, natural light, visible film grain. No on-screen text.");
	return blocks.filter(Boolean).join("\n\n");
}
