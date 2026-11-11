#!/usr/bin/env node
// Guest start (src/guest-start.js): a first visit to the hosted Studio skips the project chooser and opens a ready
// project. The rule: no project session yet, not an embed or a ?scene= launch, and the page is hosted (https) or asks
// with ?try. A self-served Studio (http) and a returning visitor keep what they had.
import { readFileSync } from "node:fs";
import { guestStart } from "../src/guest-start.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const store = (session) => ({ getItem: (key) => (session && key === "cozyclay.project-session.v1" ? JSON.stringify(session) : null) });
const at = (protocol, search = "") => ({ protocol, search });

expect("hosted, first visit: guest start", guestStart(at("https:"), store(null)) === true);
expect("hosted, a project session exists: the visitor resumes it", guestStart(at("https:"), store({ name: "My Project" })) === false);
const draft = (key) => ({ getItem: (k) => (k === key ? JSON.stringify({ version: 5, activeSceneId: "a", scenes: [] }) : null) });
expect("hosted, an unnamed stored draft and no session: the draft stays", ["cozyclay.scenes.v5", "cozyclay.scenes.v4", "cozyclay.scenes.v1", "cozyclay.scene.v1"].every((key) => guestStart(at("https:"), draft(key)) === false));
expect("self-served (http), first run: the chooser stays", guestStart(at("http:"), store(null)) === false);
expect("self-served with ?try: guest start", guestStart(at("http:", "?try=1"), store(null)) === true && guestStart(at("http:", "?try"), store(null)) === true);
expect("?try with a project session: the visitor resumes it", guestStart(at("http:", "?try=1"), store({ name: "My Project" })) === false);
expect("an embed never guest-starts", guestStart(at("https:", "?embed=playground"), store(null)) === false && guestStart(at("https:", "?embed=scene"), store(null)) === false);
expect("a ?scene= launch opens its scene, not a guest project", guestStart(at("https:", "?scene=/scenes/a.cclayproject"), store(null)) === false);

const scenes = readFileSync(new URL("../src/domains/scenes.js", import.meta.url), "utf8");
expect("the chooser's first state leaves a guest start alone", scenes.includes("&& !loadProjectSession()?.name && !guestStart());"));
const panel = readFileSync(new URL("../src/panels/ProjectPanel.jsx", import.meta.url), "utf8");
expect("the project panel mounts the guest start", panel.includes("<GuestStart />"));
const source = readFileSync(new URL("../src/guest-start-mount.jsx", import.meta.url), "utf8");
expect("it creates a named project through project.new, then one character", source.includes('run("project.new", { name:') && source.includes("spawnCharacter?.(CHARACTER_MODEL_IDS[0], 0, 0)"));
expect("the character gets a sample walk, so the camera steps have somebody moving", source.includes('sampleMotionSpec("walk", character)') && source.includes("install: true"));
expect("the walk waits for the character and retries until the rig can take it, instead of giving up after a second", source.includes("tries < 120 && !character") && source.includes("if (walk?.ok) return;") && source.includes("await pause(1500);") && source.includes("the sample walk did not install"));
expect("the camera tutorial opens with the guest start and closes for good", source.includes("useState(() => guestStart())") && source.includes("<StudioCameraTutorial onClose={() => setTutorial(false)} />"));
// The language comes before the project: another language reloads the page, and a reload after the project exists
// would resume it without the tutorial.
const language = readFileSync(new URL("../src/camera-tutorial-language.jsx", import.meta.url), "utf8");
expect("a visitor who never chose a language is asked first, and the guest project waits for the answer", source.includes("useState(localeChosen)") && source.includes("if (!language || started.current || !guestStart()) return;") && source.includes("<TutorialLanguage onChosen={() => setLanguage(true)} />"));
expect("the three languages are offered in their own names", ["English", "한국어", "简体中文"].every((name) => language.includes(`label: "${name}"`)));
expect("keeping the page's language saves the choice without a reload; another one reloads into it", language.includes("if (language.id === LOCALE) { keepLocale(); onChosen?.(); } else setLocale(language.id);"));
const stepsText = readFileSync(new URL("../src/camera-tutorial-steps.jsx", import.meta.url), "utf8");
expect("every step's instruction is written in Chinese too", (stepsText.match(/how: /g) ?? []).length === 8 && ["环顾四周", "各按一次", "推近和拉远", "绕着角色转", "添加镜头", "向右拖动", "绘制轨道", "镜头视角"].every((words) => stepsText.includes(words)));

// The tutorial itself: seven steps in the order a camera is learnt, each finished by doing it in the Studio.
const stepsSource = readFileSync(new URL("../src/camera-tutorial-steps.jsx", import.meta.url), "utf8");
const kinds = [...stepsSource.matchAll(/kind: "([a-z]+)"/g)].map((match) => match[1]);
expect("eight steps: controls first, then the camera work", kinds.join(",") === "fly,walk,dolly,orbit,shot,length,rail,play", kinds.join(","));
const tutorial = readFileSync(new URL("../src/camera-tutorial.jsx", import.meta.url), "utf8");
expect("no next button: steps are finished by the studio's own signals", !/Next step|I did this|Mark complete/.test(tutorial) && tutorial.includes('addEventListener("cozyclay:nav"'));
const controls = readFileSync(new URL("../src/controls.jsx", import.meta.url), "utf8");
expect("the fly camera reports look, walk, dolly and orbit", controls.includes('announceNav("walk", key)') && controls.includes("announceNav(kind)") && controls.includes('announceNav("dolly")'));
for (const selector of [".tl-track.shots .tl-track-add", ".tl-shot-edge.end", ".tl-rail-draw", ".vp-inset", ".dock-shot-look", ".tl-transport .tl-btn.play"]) expect(`a beacon's target is named in the tutorial: ${selector}`, stepsSource.includes(selector));
const telemetry = readFileSync(new URL("../src/guide-telemetry.js", import.meta.url), "utf8");
expect("guide telemetry knows the camera tutorial and its eight steps", telemetry.includes('["animation", "storyboard", "camera"]') && telemetry.includes('["1", "2", "3", "4", "5", "6", "7", "8"]'));
expect("Play needs playback seen through the shot camera, not look-through alone", tutorial.includes('if (previewing && playing && next.has("rail")) next.add("play");'));
expect("Length is done once a shot is longer than it was made", tutorial.includes('if (firstFrames && shotFrames > firstFrames) next.add("length");'));
process.exit(failures ? 1 : 0);
