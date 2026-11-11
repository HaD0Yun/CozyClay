// Export commands: the Export menu's Video (mp4), the same export, awaited to
// its file. A failure was already shown in the export panel, so it refuses
// silently.
import { studioActionDeclaration } from "../studio-actions.js";
import { fail, shotLabel, shotOf } from "./shared.js";

export const declarations = Object.freeze(["export.shotVideo"].map(studioActionDeclaration));

export function register(registry, ports) {
	registry.register({ ...studioActionDeclaration("export.shotVideo"),
		available: state => state.exporting ? "An export is already running; wait for it to finish."
			: state.canExportVideo || "There is nothing to record yet: add a shot (shot.create), camera keys or a motion take first.",
		run: async ({ shotId, scope, passKind, depthCurve, output }, context) => {
			const shot = shotId ? shotOf(ports, shotId) : null;
			const result = await ports.exportShotVideo({ shotId: shotId ?? null, ...(scope ? { scope } : {}), ...(passKind ? { passKind } : {}), ...(depthCurve ? { depthCurve } : {}), ...(output ? { output } : {}) }, context);
			if (!result?.fileName) fail("TARGET_NOT_READY", "The video export did not finish; the editor's export panel shows why and offers Retry.");
			return { affectedIds: shot ? [shot.id] : [], output: { fileName: result.fileName, frameCount: result.frameCount },
				summary: `Recorded ${scope === "timeline" ? "the whole timeline" : shot ? shotLabel(shot) : "the shot"} to ${result.fileName} (${result.frameCount} frames); it was handed to the configured export folder or the browser download.` };
		} });
}
