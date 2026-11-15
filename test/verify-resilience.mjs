#!/usr/bin/env node
// Failure containment: a render error, a lost WebGL context, or a full
// localStorage must degrade into a message with a way back — never a silent
// white or black screen over an autosaving document. App.jsx only runs in a
// browser, so like verify-record-mp4-source this asserts the wiring in the
// source; the browser owns the rest.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

// --- the error boundary wraps the whole tree -------------------------------
const main = await read("main.jsx");
// StudioReadyMark (studio:ready) sits beside App inside the boundary, so a crashed first render never reports ready.
assert.match(main, /<ErrorBoundary>\s*<App \/>\s*(?:\{\/\*[^}]*\*\/\}\s*)?(?:<StudioReadyMark \/>\s*)?<\/ErrorBoundary>/, "App must render inside the error boundary");
assert.match(main, /addEventListener\("pagehide"[\s\S]*delete window\.__cozyclay/, "reload must clear stale studio QA globals");

const boundary = await read("error-boundary.jsx");
assert.match(boundary, /static getDerivedStateFromError/, "the boundary must derive fallback state from the error");
assert.match(boundary, /componentDidCatch/, "the crash must reach the console, not vanish");
assert.match(boundary, /window\.location\.reload/, "the crash screen must offer the reload recovery");
assert.match(boundary, /Failed to fetch dynamically imported module/, "a transient module fetch failure must be recognized");
assert.match(boundary, /sessionStorage/, "a module fetch retry must be bounded per browser session");
assert.match(boundary, /role="alert"/, "the crash screen announces itself to assistive tech");

// --- a lost GL context is handled, not ignored -----------------------------
// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const app = (await read("App.jsx")) + (await read("app-stage.jsx")) + (await read("stage-canvas-rigs.jsx"));
assert.match(app, /addEventListener\("webglcontextlost", onLost\)/, "the stage must listen for context loss");
assert.match(app, /addEventListener\("webglcontextrestored", onRestored\)/, "…and for its restoration");
assert.match(
	app,
	/const onLost = \(event\) => \{\s*event\.preventDefault\(\);/,
	"preventDefault on webglcontextlost is the opt-in for browser-driven restoration",
);
assert.match(app, /removeEventListener\("webglcontextlost", onLost\)/, "the listeners must unmount with the guard");
assert.match(app, /glContextLost && \(/, "the lost context must surface as an overlay, not a black stage");

// --- storage writes in render paths cannot throw ---------------------------
assert.match(
	app,
	/try \{\s*localStorage\.setItem\(WORKSPACE_LAYOUT_KEY/,
	"the layout write runs on every panel resize and must not crash on full storage",
);

console.log("PASS failure containment is wired: boundary, GL context guard, guarded layout write");
