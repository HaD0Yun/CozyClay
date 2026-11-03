// app:render_crash and app:gl_lost: a white screen and a dead GPU context become
// countable and joinable to device:profile. Only closed values leave: the thrown
// value's type label (the app:error vocabulary, via describeError) and the GL
// failure kind, plus the studio UI locale (en, ko, zh, other) on a crash. Never a
// message, stack, component stack or file name.
import { describeError, initAnalytics, track } from "./analytics.js";
import { admit, bump } from "./analytics-friction.js";
import { uiLocale } from "./analytics-values.js";

const CRASHES_PER_SESSION = 2;
const GL_LOST_KINDS = new Set(["unavailable", "context_lost"]);

// A crash on the first render, or a missing WebGL at mount, comes before the
// analytics SDK has loaded; initAnalytics() is idempotent (main.jsx already
// started it), so waiting on it keeps those events instead of dropping them.
let send = (event, props) => {
	initAnalytics().then(() => track(event, props), () => {});
};

/** An error ErrorBoundary caught. React 19 does not re-dispatch a caught
 * render error to window "error", so app:error never sees it and the friction
 * `errors` counter moves here, not twice. */
export function reportRenderCrash(error) {
	try {
		bump("errors");
		const props = { error_type: describeError({ error }).error_type, locale: uiLocale() };
		if (admit("app:render_crash", CRASHES_PER_SESSION)) send("app:render_crash", props);
	} catch {
		// Telemetry must never throw from inside the crash net.
	}
}

/** The stage's WebGL failed: "unavailable" at mount, "context_lost" later. Once per kind per session. */
export function reportGlLost(kind) {
	try {
		if (GL_LOST_KINDS.has(kind) && admit(`app:gl_lost:${kind}`, 1)) send("app:gl_lost", { kind });
	} catch {
		// Telemetry must never affect the stage.
	}
}

/** Tests only: capture what is sent; returns the restore. */
export function crashTelemetrySeam(capture) {
	const previous = send;
	send = capture;
	return () => { send = previous; };
}
