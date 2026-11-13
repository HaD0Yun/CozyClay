#!/usr/bin/env node
// #1223: user-visible copy in the panels and the shell says what the English
// says, carries no Korean typos, and reaches the Korean and Chinese UI through
// ko() instead of showing a bare English literal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Collect every failure so one run lists all wrong strings, without dumping whole source files.
const failures = [];
const has = (text, pattern, message) => { if (!pattern.test(text)) failures.push(message ?? `missing ${pattern}`); };
const lacks = (text, pattern, message) => { if (pattern.test(text)) failures.push(message ?? `still has ${pattern}`); };

// The arguments of every ko( call whose first argument starts with `prefix`,
// split at top-level commas (strings, templates and brackets are skipped).
function koCalls(text, prefix) {
	const calls = [];
	for (let start = text.indexOf(`ko(${prefix}`); start !== -1; start = text.indexOf(`ko(${prefix}`, start + 1)) {
		const args = [];
		let depth = 0, from = start + 3, index = from;
		const stack = [];
		for (; index < text.length; index += 1) {
			const char = text[index], mode = stack.at(-1);
			if (mode === '"' || mode === "'") { if (char === "\\") index += 1; else if (char === mode) stack.pop(); continue; }
			if (mode === "`") {
				if (char === "\\") index += 1;
				else if (char === "`") stack.pop();
				else if (char === "$" && text[index + 1] === "{") { stack.push("${"); index += 1; }
				continue;
			}
			if (char === '"' || char === "'" || char === "`") stack.push(char);
			else if (char === "{" && (mode === "${" || mode === "{")) stack.push("{");
			else if (char === "}" && (mode === "${" || mode === "{")) stack.pop();
			else if (stack.length) continue;
			else if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" && depth === 0) break;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
			else if (char === "," && depth === 0) { args.push(text.slice(from, index).trim()); from = index + 1; }
		}
		const last = text.slice(from, index).trim();
		if (last) args.push(last);
		calls.push({ line: text.slice(0, start).split("\n").length, args });
	}
	return calls;
}

// Korean typo: 캐프처 is not a word; the hint means a framing capture (캡처).
for (const path of ["src/panels/EnvironmentPanel.jsx", "src/panels/PosePanel.jsx"]) {
	const text = read(path);
	lacks(text, /캐프처/, `${path} spells capture as 캐프처`);
	has(text, /모든 프레이밍 캡처에 함께 실려/, `${path} keeps the framing capture hint`);
}

// The sample-motion warning says what the English says: applying a pose clears the motion.
const poseStudio = read("src/posestudio.jsx");
lacks(poseStudio, /눈앞에/, "the sample-motion warning adds 'right before your eyes'");
has(poseStudio, /"A sample motion is moving the character — applying a pose clears it and returns to the blocking pose\.", "현재 샘플 모션이 캐릭터를 움직이고 있어요\. 포즈를 적용하면 샘플 모션이 지워지고 블로킹 포즈로 돌아가요\."\)/);

// Viewport toolbar: Off is 끔, the Sculpt mode uses the studio's 조형, and the mode tablist is named for modes.
const toolbar = read("src/shell/ViewportToolbar.jsx");
lacks(toolbar, /끕/, "the part-colour Off option reads 끕");
has(toolbar, /\{ value: "off", label: ko\("Off", "끔"\) \}/);
has(toolbar, /\{ id: "sculpt", key: "5", label: ko\("Sculpt", "조형"\) \}/, "the Sculpt mode matches 조형 used by the Inspector");
has(toolbar, /role="tablist" aria-label=\{ko\("Mode", "모드", "模式"\)\}/, "the mode tablist is not named Workflow");
for (const path of ["tools/tutorial/episodes/beginner-guide/02-layout.mjs", "tools/tutorial/episodes/stub-tour.mjs"]) {
	lacks(read(path), /조각/, `${path} still names the Sculpt mode 조각`);
}

// The measurement readout goes through ko().
const measurement = read("src/viewport-measurement.jsx");
lacks(measurement, /\? "Pick second point"/, "the measurement readout is a bare English literal");
has(measurement, /ko\("Pick second point", "두 번째 점 선택", "选择第二个点"\)/);

// The new-project default name follows the locale, read late through a getter.
const browser = read("src/project-browser.jsx");
lacks(browser, /defaultName: "Untitled Project"/, "the new-project default name is English only");
has(browser, /get defaultName\(\) \{ return ko\("Untitled Project", "제목 없는 프로젝트"\); \}/);

// Tree rows for the third and later cast members are translated by pattern.
const hierarchy = read("src/hierarchy-panel.jsx");
has(hierarchy, /\/\^Character \(\\d\+\)\$\//, "Character N rows need a pattern, not an exact-key map");
has(hierarchy, /ko\(node\.label, `캐릭터 \$\{characterNumber\}`, `角色 \$\{characterNumber\}`\)/);

// Pose key bar: interpolated status lines carry their own Chinese, and the missing-rig error is localized.
const keyBar = read("src/shell/PoseKeyBar.jsx");
const templates = koCalls(keyBar, "`");
assert.ok(templates.length >= 8, `expected the pose key bar's interpolated ko() calls, found ${templates.length}`);
for (const { line, args } of templates) {
	if (!args[0].includes("${")) continue;
	if (args.length !== 3) failures.push(`src/shell/PoseKeyBar.jsx:${line} interpolates English that the Chinese dictionary cannot match: ${args[0]}`);
}
has(keyBar, /throw new Error\(ko\("The character rig is not loaded\.", "캐릭터 리그가 로드되지 않았어요\.", "角色的骨骼尚未加载。"\)\)/, "the missing-rig error reaches the status line in English");

// The fallback project name follows the locale like the new-project default.
lacks(browser, /value\.trim\(\) \|\| "My Project"/, "the name dialog falls back to an English-only project name");
has(browser, /value\.trim\(\) \|\| ko\("Untitled Project", "제목 없는 프로젝트", "未命名项目"\)/);
const scenesDomain = read("src/domains/scenes.js");
lacks(scenesDomain, /"My Project"/, "the save and new-project dialogs fall back to an English-only project name");

// An Empty is not called a node: the Add menu caption and the Details type line say Empty.
lacks(read("src/object-catalog.jsx"), /node only/, "the Add menu calls an Empty a node");
has(read("src/object-catalog.jsx"), /ko\("empty, no geometry", "빈 오브젝트, 형상 없음", "空对象，无几何体"\)/);
lacks(read("src/shell/details-selection.js"), /ko\("Node", "노드"\)/, "the Details type line calls an Empty a node");

// Sculpt: the visible label and the aria-labels say Match; IoU stays in the title tooltip.
const sculpt = read("src/panels/SculptPanel.jsx");
lacks(sculpt, /: "IoU"\}/, "the sculpt meter label shows the bare term IoU");
lacks(sculpt, /ko\("Final IoU"/, "the finished sculpt meter label shows the term IoU");
has(sculpt, /title=\{ko\("Silhouette match \(IoU\)", "실루엣 일치도 \(IoU\)"\)\}>\{stage === "done" \? ko\("Final match", "최종 일치도", "最终匹配度"\) : ko\("Match", "일치도", "匹配度"\)\}/);
has(sculpt, /role="meter" aria-label=\{ko\("Silhouette match", "실루엣 일치도", "轮廓匹配度"\)\}/);
has(sculpt, /aria-label=\{ko\(`Match by round: /, "the round trail aria-label names IoU");

if (failures.length) {
	console.error(`UI copy checks FAIL (${failures.length}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log("UI copy checks PASS");
