#!/usr/bin/env node
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
// #523: the 2a top bar has a project swatch, not a wordmark; the brand is
// named in Help › About (src/shell/MenuBar.jsx).
const app = ["../src/App.jsx", "../src/shell/TopBar.jsx", "../src/shell/MenuBar.jsx"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/stage-startup-defaults.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");
// The tuned rig's numbers and the stage colours live in the stage look (stage.lighting).
const look = readFileSync(new URL("../src/stage-lighting.js", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/theme.js", import.meta.url), "utf8");

expect("header brand is Cozy Clay", app.includes("Cozy <span>Clay</span>"));
expect("browser title names the studio", /<title>[^<]*Cozy\s?Clay[^<]*<\/title>/.test(html));
expect("IBM Plex Sans is the only active studio UI family", css.includes('@font-face {\n\tfont-family: "IBM Plex Sans";') && !css.includes("font-family:Inter"));
expect("display and UI roles both use IBM Plex Sans", css.includes("--display: var(--sans)") && css.includes('--sans: "IBM Plex Sans"'));
expect("numeric editing data has a JetBrains Mono role", css.includes('--mono: "JetBrains Mono"') && css.includes("font-family: var(--mono)"));
expect("wordmark uses a modern heavy display treatment", css.includes("font-weight: 750") && css.includes("letter-spacing: -.045em"));
expect("chrome backdrop token uses the v2 surface", css.includes("--bg: var(--surface-0)"));
expect("chrome foreground token uses the v2 text scale", css.includes("--fg: var(--text-1)"));
expect("chrome panel token uses the v2 panel surface", css.includes("--panel: var(--surface-panel)"));
expect("chrome accent token uses the v2 selection role", css.includes("--accent: var(--select)"));
expect("timeline lanes use the v2 panel surface", css.includes("background-color: var(--surface-panel)"));
expect("IK uses the v2 danger token", css.includes(".tl-marker.ik") && css.includes("background: var(--danger)"));
expect("current frame uses the v2 selection token", css.includes(".tl-frame-box") && css.includes("background: var(--select)"));
expect("new installs start in dark mode", theme.includes('export const DEFAULT_THEME = "dark"'));
// The stage is the grey workbench (editor, preview, exports), dark or light
// with the UI theme; grid view only trades the deck for the reference grid.
expect("Canvas uses the grey workbench background", app.includes("<StageAtmosphere lighting={lighting} keyLight={keyLight} theme={uiTheme} grid={gridView} />")
	&& look.includes("const sky = themed ? stageBackground(theme) : l.sky;"));
expect("Character uses white clay", app.includes('const CLAY = "#ffffff"'));
expect("Room uses a grey deck a step above the sky", room.includes('const FLOOR = "#5b5d63"'));
// The walls are gone on purpose: the set is an open deck, so a shot can stage a
// run or a chase without meeting a corner. These assert their ABSENCE, which is
// what would regress if a wall were ever reintroduced by accident.
expect("the stage has no walls", !room.includes("BACK_WALL") && !room.includes("SIDE_WALL") && !room.includes("Skirting"));
expect("the deck is large enough to read as open", room.includes("export const STAGE_SIZE = 500"));
expect("Room has no ceiling plane", !room.includes("function Ceiling") && !room.includes("SHOT_LAYER"));
expect(
	"Studio uses directional high-key toon lighting",
	// The key is user-movable now: the tuned rig survives as the keyLight
	// DEFAULTS, so an untouched stage still renders the same high-key look.
	// grid view may swap in the neutral studio rig; the clay values stay the default arm
	// stage.lighting's studio default carries it (test/bus/verify-stage-lighting.mjs pins the numbers)
	room.includes("<hemisphereLight args={[look.hemi.sky, look.hemi.ground, 0.9]}") &&
		look.includes('ground: neutral ? "#3a3d42" : lightTheme ? "#d6d8de" : l.hemiGround') &&
		look.includes('hemiSky: "#ffffff", hemiGround: "#5a5d64"') &&
		look.includes("(neutral ? 0.34 : lightTheme ? 0.32 : 0.18)") &&
		// the key colour is now the user's warmth dial (or an explicit colour),
		// defaulting to the bright neutral key (brightness 4, warmth 0) the default keyLight shape carries
		look.includes("{ x: 6, y: 9, z: 4, intensity: 4, warmth: 0, color: null }"),
);

// #650: the project-mode badge is quiet secondary text from the v2 text scale,
// so it follows the light and dark themes with every other label.
const modeCss = readFileSync(new URL("../src/shell/mode.css", import.meta.url), "utf8");
const badgeRule = modeCss.match(/\.topbar-previs-mode\s*\{([^}]*)\}/)?.[1] ?? "";
expect("the previs mode badge uses the secondary text token", /color:\s*var\(--text-2\b/.test(badgeRule) && !/background/.test(badgeRule), badgeRule);

if (failures) process.exit(1);
console.log("all Cozy Clay theme checks PASS");
