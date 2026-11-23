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

export function runAiReferenceExport(app, extraEntries = null) {
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
