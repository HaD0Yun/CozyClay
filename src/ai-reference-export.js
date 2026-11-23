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
import { fovToFocalMm } from "./shot.js";

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

// prompt.txt and scene-facts.json for the pack, from the export's own
// snapshot of the shots and cast.
function promptEntries(app, job, setting) {
	const contextShots = job.request.context.shots;
	const facts = aiReferenceFacts({
		shots: contextShots, fps: app.tlFps, setting,
		// The name the operator typed (its subject), else the Outliner's "Character N".
		cast: (job.request.context.characters ?? app.characters).map((entry, index) => (typeof entry.subject === "string" && entry.subject.trim()) || `Character ${index + 1}`),
		shotCameras: contextShots.map((entry) => shotCameraForPrompt(app, entry)),
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
