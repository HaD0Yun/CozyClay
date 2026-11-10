// guide:opened, guide:step, guide:dismissed, guide:completed: the first-60-seconds
// guide (first-success-guide.jsx) as a funnel. The mode and step numbers are the
// component's own (its STEPS_BY_MODE keys, 1-based step index); each event and step
// is sent at most once per session. Only the mode, a step number and a duration
// bucket leave: never step text or what the user did.
import { initAnalytics, track } from "./analytics.js";
import { admit } from "./analytics-friction.js";
import { bucketLong } from "./analytics-strict.js";

const GUIDE_MODES = Object.freeze(["animation", "storyboard", "camera"]);
const GUIDE_STEP_VALUES = Object.freeze(["1", "2", "3", "4", "5", "6", "7"]);

// The guide can open before the SDK has loaded; initAnalytics() is idempotent (main.jsx started
// it), so waiting on it keeps an early guide:opened instead of spending its cap on a no-op.
let send = (event, props) => { initAnalytics().then(() => track(event, props), () => {}); }, clock = () => Date.now();
let stepStartedAt = null;

const stepValue = (step) => (GUIDE_STEP_VALUES.includes(String(step)) ? String(step) : null);
const guarded = (run) => { try { run(); } catch { /* Telemetry must never affect the guide. */ } };

/** The guide became visible in `mode`; its first step's clock starts. */
export function noteGuideOpened(mode) {
	guarded(() => {
		if (!GUIDE_MODES.includes(mode)) return;
		stepStartedAt = clock();
		if (admit("guide:opened", 1)) send("guide:opened", { mode });
	});
}

/** The user marked step `step` (1-based) of `total` done; the last one also completes the guide. */
export function noteGuideStep(mode, step, total) {
	guarded(() => {
		const value = stepValue(step);
		if (!GUIDE_MODES.includes(mode) || !value) return;
		const now = clock();
		const stepMs = stepStartedAt === null ? NaN : now - stepStartedAt;
		stepStartedAt = now;
		if (admit(`guide:step:${value}`, 1)) send("guide:step", { mode, step: value, step_ms: bucketLong(stepMs) });
		if (step === total && admit("guide:completed", 1)) send("guide:completed", { mode });
	});
}

/** The guide was closed before its last step; `reached` is the step it was showing (1-based). */
export function noteGuideDismissed(mode, reached) {
	guarded(() => {
		const value = stepValue(reached);
		if (!GUIDE_MODES.includes(mode) || !value) return;
		stepStartedAt = null;
		if (admit("guide:dismissed", 1)) send("guide:dismissed", { mode, reached: value });
	});
}

/** Tests only: capture what is sent and drive the clock; returns the restore. */
export function guideTelemetrySeam(capture, now) {
	const previous = [send, clock];
	send = capture;
	if (now) clock = now;
	stepStartedAt = null;
	return () => { [send, clock] = previous; stepStartedAt = null; };
}
