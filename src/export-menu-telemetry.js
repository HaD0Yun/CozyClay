// export:menu_opened: one event each time the Export flyout opens, by click or
// keyboard (the open state's false -> true edge), so reopening counts again.
// webcodecs is the synchronous constructor check only; whether a codec config
// is supported stays with the export attempt (unsupported_codec).
import { useEffect } from "react";
import { bucketCount, track } from "./analytics.js";

/** The closed properties for one open: surface, webcodecs and the shot count bucket. */
export function exportMenuOpenedProps({ embedMode, shots }, scope = globalThis) {
	const list = Array.isArray(shots) ? shots : [];
	return {
		surface: embedMode ? "embed" : "studio",
		webcodecs: typeof scope.VideoEncoder === "function" && typeof scope.VideoFrame === "function",
		shots: bucketCount(list.length),
	};
}

// Keyed on the open flag only: the render that opens the flyout supplies the shell it reports.
export function useExportMenuTelemetry(open, shell) {
	useEffect(() => {
		if (!open) return;
		try { track("export:menu_opened", exportMenuOpenedProps(shell)); } catch { /* telemetry is advisory */ }
	}, [open]);
}
