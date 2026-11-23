// verify_result checks ["lighting"]: how the shot frame is exposed, measured from
// the pixels the export path renders (the same frame capture_frame and the
// contact sheets show), not from the light settings. The agent reads the
// numbers; it does not have to judge darkness from a thumbnail.
import { PerspectiveCamera, Vector3 } from "three";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { entityWorldBounds } from "./studio-agent-commands.js";
import { focalMmToFov } from "./shot.js";
import { normalizeLighting } from "./stage-lighting.js";
import { readyHdrMap } from "./stage-hdr-map.js";
import { stageScene } from "./stage-scene-ref.js";
import { stageLightFacts } from "./stage-light-facts.js";

// Rec. 709 weights on the 8-bit sRGB values: luma as a monitor shows it.
const lumaOf = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
const round = (value, digits) => Number(value.toFixed(digits));
// A clipped pixel has a channel at full scale; a crushed one is black in every channel.
const CLIP = 254, CRUSH = 3;

/** Percentile of a 256-bin luma histogram, as 0..1. */
function percentile(histogram, count, fraction) {
	let seen = 0;
	for (let bin = 0; bin < 256; bin++) if ((seen += histogram[bin]) >= fraction * count) return bin / 255;
	return 1;
}

/**
 * Exposure statistics of one RGBA frame (rows bottom-up, as the GPU reads them
 * back) and of pixel boxes inside it: meanLuma 0..1, clippedPct and crushedPct
 * of the whole frame; per box its meanLuma and contrast (the spread between
 * the 5th and 95th luma percentile, 0..1). A box is { id, x0, y0, x1, y1 } in
 * pixels with y up, or { id } alone when the subject is out of frame.
 */
export function frameLighting({ data, width, height }, boxes = []) {
	let sum = 0, clipped = 0, crushed = 0;
	for (let i = 0; i < width * height * 4; i += 4) {
		sum += lumaOf(data, i);
		const high = Math.max(data[i], data[i + 1], data[i + 2]);
		if (high >= CLIP) clipped++;
		else if (high <= CRUSH) crushed++;
	}
	const pixels = width * height;
	const subjects = boxes.map(({ id, x0, y0, x1, y1 }) => {
		if (x0 === undefined || x1 < x0 || y1 < y0) return { id, meanLuma: null, contrast: null };
		const histogram = new Uint32Array(256);
		let total = 0, count = 0;
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const luma = lumaOf(data, (y * width + x) * 4);
			histogram[Math.min(255, Math.round(luma))]++;
			total += luma;
			count++;
		}
		return { id, meanLuma: round(total / count / 255, 3), contrast: round(percentile(histogram, count, 0.95) - percentile(histogram, count, 0.05), 3) };
	});
	return { meanLuma: round(sum / pixels / 255, 3), clippedPct: round((100 * clipped) / pixels, 1), crushedPct: round((100 * crushed) / pixels, 1), subjects };
}

/** The shot camera at the frame's aspect, as the frame was rendered. */
function shotView({ camera, filmback }, width, height) {
	const aspect = width / height;
	const view = new PerspectiveCamera((focalMmToFov(camera.focalMm, filmback.sensorId, aspect) * 180) / Math.PI, aspect, 0.01, 10000);
	view.position.set(camera.position.x, camera.position.y, camera.position.z);
	view.lookAt(camera.lookAt.x, camera.lookAt.y, camera.lookAt.z);
	view.updateMatrixWorld(true);
	return view;
}

/** A world box projected through the shot camera to a clamped pixel box (y up), or null off screen. */
function pixelBox(bounds, state, width, height) {
	const { camera } = state, view = shotView(state, width, height);
	const forward = new Vector3(camera.lookAt.x - camera.position.x, camera.lookAt.y - camera.position.y, camera.lookAt.z - camera.position.z);
	const corners = [bounds.min.x, bounds.max.x].flatMap((x) => [bounds.min.y, bounds.max.y].flatMap((y) => [bounds.min.z, bounds.max.z].map((z) => new Vector3(x, y, z))))
		.filter((corner) => corner.clone().sub(view.position).dot(forward) > 0).map((corner) => corner.project(view));
	if (!corners.length) return null;
	const px = (ndc, size) => Math.round(((ndc + 1) / 2) * size);
	const box = { x0: px(Math.min(...corners.map((c) => c.x)), width), x1: px(Math.max(...corners.map((c) => c.x)), width) - 1,
		y0: px(Math.min(...corners.map((c) => c.y)), height), y1: px(Math.max(...corners.map((c) => c.y)), height) - 1 };
	const clamped = { x0: Math.max(0, box.x0), x1: Math.min(width - 1, box.x1), y0: Math.max(0, box.y0), y1: Math.min(height - 1, box.y1) };
	return clamped.x1 >= clamped.x0 && clamped.y1 >= clamped.y0 ? clamped : null;
}

/** The lighting check for verify_result: the shot frame at the playhead, its
 * subjects the target characters (every visible one when no target is a
 * character). Fails as TARGET_NOT_READY when nothing can be rendered. */
export function lightingChecks(ids, state, ports) {
	if (typeof ports.renderFrameBuffer !== "function") throw new StudioProtocolError("CAPABILITY_MISSING", "This editor cannot render the shot frame.");
	if (!state.camera || !(state.camera.focalMm > 0)) throw new StudioProtocolError("TARGET_NOT_READY", "The shot camera must be available.");
	const named = state.characters.filter((character) => ids.includes(character.id));
	const characters = named.length ? named : state.characters.filter((character) => !character.hidden);
	// The light facts are read while the scene still stands as the frame drew it (the port's inspect), so a light's aim
	// and level and every body's pose are that frame's even when the editor shows another one (playback, a hidden tab).
	let image, lights;
	const read = (drawn) => { try { lights = drawnLightFacts(characters, state, ports, drawn); } catch (error) { lights = { error: String(error?.message ?? error).slice(0, 120) }; } };
	try { image = ports.renderFrameBuffer(state.frame, null, read); }
	catch (error) { throw new StudioProtocolError("TARGET_NOT_READY", `The shot frame could not be rendered: ${error.message}`); }
	// a port that does not inspect: read right after the frame
	if (lights === undefined) read(image);
	const boxes = characters.map((character) => {
		const bounds = entityWorldBounds(character, state, ports);
		return { id: character.id, ...(bounds && !character.hidden ? pixelBox(bounds, state, image.width, image.height) : {}) };
	});
	// What lit the frame beyond the lights: the look, its environment light and its occlusion pass.
	// An HDR environment is named with whether its map had loaded for this frame (until then the look's sky lit it).
	const { preset, envLight, ao, hdr, hdrRotation, hdrIntensity, hdrBackground } = normalizeLighting(state.stage?.lighting);
	const measured = frameLighting(image, boxes);
	if (lights?.subjects) measured.subjects = measured.subjects.map((row) => ({ ...row, ...lights.subjects[row.id] }));
	return { coverage: "rendered-shot-frame", frame: state.frame, ...measured,
		...(lights?.notDrawn ? { lightsNotDrawn: lights.notDrawn } : {}), ...(lights?.aimNotFound ? { aimNotFound: lights.aimNotFound } : {}), ...(lights?.error ? { lightsError: lights.error } : {}),
		look: { preset, envLight, ao, ...(hdr ? { hdr, hdrLoaded: Boolean(readyHdrMap(hdr)), hdrRotation, hdrIntensity, hdrBackground } : {}) } };
}

/** The camera a frame was drawn through, as the capture made it (stage-capture.jsx): a copy of the shot camera at the
 * frame's aspect, unless a view offset already fixes it. */
function drawnView(camera, width, height) {
	const view = camera.clone();
	if (!view.view?.enabled) view.aspect = width / height;
	view.updateProjectionMatrix();
	view.updateMatrixWorld(true);
	return view;
}

/** The drawn lights against each shown subject (stage-light-facts.js), read from the stage scene the frame `drawn`
 * { data, width, height, camera: the shot camera as it stood for the frame, when the port hands it } was rendered
 * from; null when no stage canvas is mounted. */
function drawnLightFacts(characters, state, ports, drawn) {
	const scene = stageScene();
	if (!scene || typeof ports.bounds !== "function") return null;
	const boundsOf = (subject) => { try { return ports.bounds({ entity: subject, frame: state.frame, state }); } catch { return null; } };
	const subjects = characters.filter((character) => !character.hidden).map((subject) => ({ subject, bounds: boundsOf(subject) }));
	const { width, height } = drawn, camera = drawn.camera ? drawnView(drawn.camera, width, height) : shotView(state, width, height);
	return stageLightFacts(scene, { subjects, keyLight: state.stage?.keyLight, view: { camera, width, height }, image: drawn, state, ports });
}

/** Puts the lighting check on a verify_result answer, or its reason in unsupportedReasons. */
export function verifyLighting(result, ids, state, ports) {
	try { result.checks = { ...result.checks, lighting: lightingChecks(ids, state, ports) }; }
	catch (error) {
		if (!(error instanceof StudioProtocolError)) throw error;
		result.unsupportedReasons.lighting = error.message;
	}
}
