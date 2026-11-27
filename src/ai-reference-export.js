// Export → AI video reference (zip): the shots rendered as the blurmove
// reference (blurmove-ref.js) for a reference-video model, with a README.
// The mosaic/blur cycle restarts at every shot, so each cut opens on a
// readable frame. Settings are fixed; see BLURMOVE.
//
// App owns the export lifecycle (request, job, status, save); this module
// only drives one run through it, so App.jsx stays thin.
import { blurmoveRefSize, createBlurmoveDecorator } from "./blurmove-ref.js";
import { AI_REFERENCE_ZIP, aiReferenceEntries } from "./ai-reference-pack.js";
import { buildZip } from "./zip-store.js";
import { aiReferenceFacts, buildAiReferencePrompt } from "./ai-reference-prompt.js";
import { classifyMove, moveSequencePhrase } from "./camera-move.js";
import { subjectsCenter } from "./shot-subjects.js";
import { SUBJECT_HEIGHT_M, fovToFocalMm } from "./shot.js";
import { shotScene } from "./ai-reference-scene.js";
import { castAimPoint, castBodyPoints } from "./camera-direction.js";
import { bodyScale } from "./lowvis/studio/figure.js";
import { objectSize } from "./object-size.js";
import { OBJECT_MENU_ENTRIES, isEffectivelyHidden, isEmptyObject } from "./scene-objects.js";
import { TEXT_KIND } from "./text/text-record.js";

function runAiReferenceExport(app, extraEntries = null) {
	const { shots, shotOutput, recRef, setToast, ko, tlFps, executeExportRequest, exportRequest, runShotExport, updateExportStatus, exportBoundary, saveExport } = app;
	if (recRef.current) return null;
	if (!shots.length) {
		setToast(ko("Add at least one Shot before exporting an AI video reference", "AI 영상 레퍼런스를 내보내려면 샷을 하나 이상 추가하세요"));
		return null;
	}
	// The shots' span, not the whole timeline: the reference and its prompt
	// describe the same frames, and a model's reference slot is short (30 s).
	const startFrame = Math.min(...shots.map((entry) => entry.startFrame));
	const endFrame = Math.max(...shots.map((entry) => entry.endFrame));
	const size = blurmoveRefSize(shotOutput.width, shotOutput.height);
	return executeExportRequest(exportRequest("ai_reference", async (job) => {
		const contextShots = job.request.context.shots;
		const output = job.request.context.output;
		const decorate = createBlurmoveDecorator({ width: output.width, height: output.height, segmentStarts: contextShots.map((entry) => entry.startFrame) });
		const recorded = await runShotExport({ startFrame, endFrame, download: false, decorate }, job);
		updateExportStatus(job, "finalizing", { stage: "archive", cancellable: true });
		await exportBoundary(job);
		const entries = aiReferenceEntries({
			video: new Uint8Array(await recorded.blob.arrayBuffer()),
			fps: tlFps, frameCount: recorded.frameCount, shotCount: contextShots.length, size: output,
			extra: extraEntries ? extraEntries(job) : [],
		});
		const bytes = buildZip(entries);
		await exportBoundary(job);
		await saveExport(new Blob([bytes], { type: "application/zip" }), AI_REFERENCE_ZIP);
		setToast(ko(`${AI_REFERENCE_ZIP} exported · ${recorded.frameCount} frames`, `${AI_REFERENCE_ZIP} 내보내기 완료 · ${recorded.frameCount}프레임`, `${AI_REFERENCE_ZIP} 已导出 · ${recorded.frameCount} 帧`));
		return { fileName: AI_REFERENCE_ZIP, frameCount: recorded.frameCount, entries: entries.map((entry) => entry.name) };
	}, { output: size }));
}

// What one shot's camera does, for the reference prompt: the camera keys
// classified segment by segment (camera-move.js), or, for a rail/follow shot
// without keys, its first frame against its last. Static segments drop out
// when the shot moves elsewhere.
function shotCameraForPrompt(app, entry) {
	const { shotFramingAtFrame, cameraSubjectsAt, filmback, tlFps } = app;
	const keyed = (entry.cameraKeys?.length ?? 0) >= 2;
	const frames = keyed ? entry.cameraKeys.map((key) => key.frame) : [entry.startFrame, entry.endFrame];
	const framings = keyed ? entry.cameraKeys.map((key) => key.framing) : frames.map((frame) => shotFramingAtFrame(entry, frame));
	const first = framings[0];
	const focalMm = first && Number.isFinite(first.fovDeg) ? fovToFocalMm((first.fovDeg * Math.PI) / 180, filmback.sensorId, filmback.aspectRatio) : null;
	if (framings.some((framing) => !framing) || frames.length < 2 || frames[frames.length - 1] <= frames[0]) return { phrase: "", focalMm };
	const segs = [];
	for (let i = 0; i < framings.length - 1; i += 1) {
		if (frames[i + 1] <= frames[i]) continue;
		segs.push(classifyMove(framings[i], framings[i + 1], subjectsCenter(cameraSubjectsAt(entry, frames[i])) ?? { x: 0, z: 0, rot: 0 }, {
			durationS: (frames[i + 1] - frames[i]) / tlFps, ...filmback,
		}));
	}
	const moving = segs.filter((seg) => seg.id !== "static");
	return { phrase: moving.length ? moveSequencePhrase(moving) : segs.length ? segs[0].phrase : "", focalMm };
}

const castName = (entry, index) => (typeof entry.subject === "string" && entry.subject.trim()) || `Character ${index + 1}`;

/** The corners of an upright box: half-width w, from y0 to y1, round (x, z). */
const uprightBox = (x, z, w, y0, y1) => [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [[x + sx * w, y0, z + sz * w], [x + sx * w, y1, z + sz * w]]));

/** The names the Studio gives on its own: the create menu's labels and the
 * imported kinds' ("Cutout", "Model", "Sculpt"), each with or without " N". */
const CATALOG_LABELS = new Set([...OBJECT_MENU_ENTRIES.map((entry) => entry.label), "Cutout", "Model", "Sculpt"]);
const hasCatalogName = (object) => CATALOG_LABELS.has(object.name.trim().replace(/\s+\d+$/, ""));

/** A scene name as words: "N_Seoul_Tower" -> "N Seoul Tower", "TurbineVent 3" -> "Turbine Vent". */
const spokenName = (name) => name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+\d+$/, "").replace(/\s+/g, " ").trim();

// Every visible character, and every top-level object or group, each with the
// points that bound it at a frame: a character's posed joints (its take), else
// an upright box its height round where it stands; a group's boxes are its
// parts' boxes where their routes put them. A group speaks for its parts (a
// building, not its parapets). Things still named after their catalogue shape,
// empties without parts, lights and on-screen text are left out: the prompt
// would name a shape or ask for lettering.
function sceneEntities(app) {
	const cast = app.sceneCast;
	if (!cast) return [];
	const objects = cast.objects ?? [], characters = cast.characters ?? [];
	const byId = new Map(objects.map((object) => [object.id, object]));
	// The cast line already carries the full subject ("Jin, a lean Korean man ..."); the picture lines name the person only.
	const people = characters.map((entry, index) => ({ entry, name: castName(entry, index).split(",")[0].trim() }))
		.filter(({ entry }) => !isEffectivelyHidden(entry, objects, characters))
		.map(({ entry, name }) => ({ id: entry.id, name, kind: "character", pointsAt: (frame) => {
			const joints = castBodyPoints(entry.id, frame, cast);
			if (joints?.length) return joints;
			const at = castAimPoint(entry.id, frame, cast);
			const height = SUBJECT_HEIGHT_M * bodyScale(entry), base = entry.y ?? 0;
			return at ? uprightBox(at.x, at.z, 0.25 * bodyScale(entry), base, base + height) : null;
		} }));
	const rootOf = (object) => {
		let current = object;
		for (let guard = 0; guard < 64 && current.parent && byId.has(current.parent); guard += 1) current = byId.get(current.parent);
		return current;
	};
	const solid = (object) => !isEmptyObject(object) && object.renderer !== TEXT_KIND && !isEffectivelyHidden(object, objects, characters);
	const groups = new Map();
	for (const object of objects) {
		if (!solid(object)) continue;
		const root = rootOf(object);
		if (!groups.has(root.id)) groups.set(root.id, { root, parts: [] });
		groups.get(root.id).parts.push(object);
	}
	const boxAt = (object, frame) => {
		const at = castAimPoint(object.id, frame, cast);
		if (!at) return [];
		const size = objectSize(object), half = Math.max(size.width, size.depth) / 2;
		return uprightBox(at.x, at.z, half, at.y - size.height / 2, at.y + size.height / 2);
	};
	const things = [...groups.values()]
		.filter(({ root }) => typeof root.name === "string" && !hasCatalogName(root) && spokenName(root.name))
		.map(({ root, parts }) => ({ id: root.id, name: spokenName(root.name), kind: "object", pointsAt: (frame) => {
			const points = parts.flatMap((part) => boxAt(part, frame));
			return points.length ? points : null;
		} }));
	return [...people, ...things];
}

// What each shot's picture holds (ai-reference-scene.js), read through the
// shot camera at the export's output aspect.
function shotScenesForPrompt(app, contextShots, output) {
	const entities = sceneEntities(app);
	if (!entities.length) return contextShots.map(() => []);
	const aspect = output?.width > 0 && output?.height > 0 ? output.width / output.height : 16 / 9;
	return contextShots.map((entry) => shotScene({
		startFrame: entry.startFrame, endFrame: entry.endFrame, fps: app.tlFps, aspect, entities,
		cameraAt: (frame) => app.shotFramingAtFrame(entry, frame),
	}));
}

// prompt.txt and scene-facts.json for the pack, from the export's own
// snapshot of the shots and cast.
function promptEntries(app, job, setting) {
	const contextShots = job.request.context.shots;
	const facts = aiReferenceFacts({
		shots: contextShots, fps: app.tlFps, setting,
		// The name the operator typed (its subject), else the Outliner's "Character N".
		cast: (job.request.context.characters ?? app.characters).map(castName),
		shotCameras: contextShots.map((entry) => shotCameraForPrompt(app, entry)),
		shotScenes: shotScenesForPrompt(app, contextShots, job.request.context.output),
	});
	return [
		{ name: "prompt.txt", data: buildAiReferencePrompt(facts) + "\n" },
		{ name: "scene-facts.json", data: JSON.stringify(facts, null, 2) + "\n" },
	];
}

// The menu item opens the one-field dialog (ai-reference-dialog.jsx); its
// Export runs the render with the prompt entries.
export function openAiReferenceDialog(app) {
	const { shots, recRef, setToast, ko, setAiReferenceAsk } = app;
	if (recRef.current) return;
	if (!shots.length) {
		setToast(ko("Add at least one Shot before exporting an AI video reference", "AI 영상 레퍼런스를 내보내려면 샷을 하나 이상 추가하세요"));
		return;
	}
	setAiReferenceAsk({
		shotCount: shots.length,
		captionCount: shots.filter((entry) => (entry.caption ?? "").trim()).length,
		onCancel: () => setAiReferenceAsk(null),
		onExport: (setting) => {
			setAiReferenceAsk(null);
			void runAiReferenceExport(app, (job) => promptEntries(app, job, setting));
		},
	});
}
