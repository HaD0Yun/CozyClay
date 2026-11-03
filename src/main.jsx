import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// First stylesheet on the page: it fixes the cascade-layer order before any
// component sheet (topbar.css, viewport.css, pose.css...) opens a layer.
import "./styles/tokens.css";
import "./styles/themes.css";
import { applyTheme, readTheme } from "./theme.js";
import App from "./App.jsx";
import ErrorBoundary from "./error-boundary.jsx";
import "./styles.css";
import { registerPwa } from "./pwa.js";
import { LOCALE } from "./locale.js";
import { initAnalytics } from "./analytics.js";
import { StudioReadyMark } from "./studio-telemetry.js";
import { listenForUnboundShortcuts } from "./shortcut-friction.js";
import { fetchPlaygroundProject, isPlaygroundEmbed, playgroundSceneUrl, stashPlaygroundProject } from "./playground.js";
import { preloadBodies } from "./motion3/body.js";
import { installDomMutationGuard } from "./dom-mutation-guard.js";

// Before the first render: a translator can rewrite text nodes at any time (#1046).
installDomMutationGuard();
registerPwa();
void initAnalytics();
listenForUnboundShortcuts();
document.documentElement.lang = LOCALE === "zh" ? "zh-CN" : LOCALE;
applyTheme(readTheme());

async function boot() {
	// The landing-page playground needs its preset in hand before the first
	// render: scene startup is synchronous, and a fetch racing the mount
	// would flash the empty default room first.
	if (isPlaygroundEmbed(location.search)) {
		const url = playgroundSceneUrl(location.search);
		const project = url ? await fetchPlaygroundProject(url) : null;
		stashPlaygroundProject(project ?? { name: "Playground", document: null });
	}
	createRoot(document.getElementById("root")).render(
		<StrictMode>
			<ErrorBoundary>
				<App />
				{/* studio:ready: one frame after this first commit, without delaying it. */}
				<StudioReadyMark />
			</ErrorBoundary>
		</StrictMode>,
	);
	// The motion compiler's body fits are not in the first-load bundle (motion3/body.js): fetch them once
	// the first screen is up, so a saved take compiled on this thread does not have to wait for them.
	const idle = globalThis.requestIdleCallback ?? (run => setTimeout(run, 200));
	idle(() => preloadBodies().catch(error => console.warn("[cozyclay] could not preload the motion body fits", error)));
}

void boot();
