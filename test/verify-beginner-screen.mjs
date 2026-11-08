#!/usr/bin/env node
import { readFileSync } from "node:fs";

const browser = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../src/first-success-guide.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/project-browser.css", import.meta.url), "utf8");
let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

expect("start screen has the v2 region root", browser.includes('className={`v2-start-screen project-browser-backdrop'));
expect("start screen has the three navigation destinations", ["Recent", "New Project", "Learn"].every((label) => browser.includes(`label: ko("${label}"`)) && !browser.includes('label: ko("Samples"'));
expect("start screen exposes the template grid and the + card as its one blank entry", browser.includes("v2-start-template-grid") && browser.includes('data-testid="start-new-project-card"') && !browser.includes("BLANK_TEMPLATE") && !browser.includes("v2-start-tabs"));
expect("the New view offers an Open project card beside the + card that opens a project file", /data-testid="start-open-project-card" onClick=\{onOpenFile\}/.test(browser));
const recentWork = readFileSync(new URL("../src/project-recent-work.jsx", import.meta.url), "utf8");
expect("an empty recent list offers to open a project file", recentWork.includes('className="v2-start-empty-open" onClick={onOpenFile}') && browser.includes("onOpenFile={onOpenFile} onRefresh="));
expect("recent work rows select on click, open on double-click, and the list filters and takes arrow keys", recentWork.includes("onClick={() => onSelect(entry)}") && recentWork.includes("onDoubleClick={() => onOpen(entry)}") && recentWork.includes('data-testid="start-recent-search"') && recentWork.includes('event.key === "ArrowDown"'));
expect("a selected recent project replaces the create form in the preview column", browser.includes("{selectedRecent ? <RecentPreview"));
expect("start screen exposes the name and storage fields, without frame rate or units", browser.includes('data-testid="start-project-name"') && browser.includes('ko("Location"') && !browser.includes('ko("Frame rate"') && !browser.includes('ko("Units"'));
expect("empty project names disable Create with a reason title", browser.includes("disabled={!canCreate}") && browser.includes("createReason"));
expect("the first-success guide keeps its v2 region root", guide.includes('className="v2-first-success-guide first-success-guide"'));
expect("all new visual rules are rooted in the v2 regions", css.includes(".v2-start-screen") && css.includes(".v2-first-success-guide") && !/^\.(project-browser|first-success-guide)/m.test(css));
expect("the v2 screen keeps the fixed 232px and 340px columns", css.includes("var(--start-nav-width, 232px)") && css.includes("var(--start-preview-width, 340px)"));

// Previs modes (#649, #654) and cast style: the start screen offers no picker
// for either; every new project is an Animation project with the Hybrid cast.
const project = readFileSync(new URL("../src/project.js", import.meta.url), "utf8");
expect("the start screen has no mode or cast-style picker", !browser.includes("start-previs-mode") && !browser.includes("start-cast-style") && !browser.includes("StartChoiceGroup"));
expect("Animation is the default mode and Hybrid the default cast style", project.includes('DEFAULT_PREVIS_MODE = "animation"') && project.includes('DEFAULT_CAST_STYLE = "hybrid"'));
expect("Create always sends the default mode and the Hybrid cast", browser.includes("onNew(projectName, { previsMode: DEFAULT_PREVIS_MODE, castStyle: DEFAULT_CAST_STYLE })") && browser.includes("onStarter?.(selectedTemplate.starterId, projectName, { previsMode: DEFAULT_PREVIS_MODE, castStyle: DEFAULT_CAST_STYLE })"));

if (failures) process.exitCode = 1;
else console.log("all v2 start-screen checks PASS");
