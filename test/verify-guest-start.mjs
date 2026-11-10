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
expect("self-served (http), first run: the chooser stays", guestStart(at("http:"), store(null)) === false);
expect("self-served with ?try: guest start", guestStart(at("http:", "?try=1"), store(null)) === true && guestStart(at("http:", "?try"), store(null)) === true);
expect("?try with a project session: the visitor resumes it", guestStart(at("http:", "?try=1"), store({ name: "My Project" })) === false);
expect("an embed never guest-starts", guestStart(at("https:", "?embed=playground"), store(null)) === false && guestStart(at("https:", "?embed=scene"), store(null)) === false);
expect("a ?scene= launch opens its scene, not a guest project", guestStart(at("https:", "?scene=/scenes/a.cclayproject"), store(null)) === false);

const scenes = readFileSync(new URL("../src/domains/scenes.js", import.meta.url), "utf8");
expect("the chooser's first state leaves a guest start alone", scenes.includes("&& !loadProjectSession()?.name && !guestStart());"));
const panel = readFileSync(new URL("../src/panels/ProjectPanel.jsx", import.meta.url), "utf8");
expect("the project panel mounts the guest start", panel.includes("<GuestStart />"));
const source = readFileSync(new URL("../src/guest-start.js", import.meta.url), "utf8");
expect("it creates a named project through project.new, then one character", source.includes('run("project.new", { name:') && source.includes("spawnCharacter?.(CHARACTER_MODEL_IDS[0], 0, 0)"));
process.exit(failures ? 1 : 0);
