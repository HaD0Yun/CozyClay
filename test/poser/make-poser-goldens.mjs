// Writes test/fixtures/poser/ybot-goldens.json: what src/poser answers for the authored cases in poser-cases.mjs on
// CozyClay's Y Bot rig JSON, with the network inputs and outputs it used. Needs the model file:
//   node test/poser/make-poser-goldens.mjs
// Regenerate only when a change to the poser is meant to change its answers; the diff shows which cases moved.
import { writeFileSync } from "node:fs";
import { POSER_MODEL } from "../../src/poser/config.js";
import { createPoser } from "../../src/poser/poser.js";
import { characterFromRigJson } from "../../src/poser/ybot.js";
import { GOLDENS_PATH, recordCase, rigFacts, wasmNetwork } from "./golden-format.mjs";
import { CASES } from "./poser-cases.mjs";

const network = await wasmNetwork();
let seen;
const poser = createPoser({ network: { run: async (inputs) => { const out = await network.run(inputs); seen = { inputs, out }; return out; } } });
const character = characterFromRigJson();
const cases = [];
for (const c of CASES) {
	seen = null;
	cases.push(recordCase(c.name, await poser.solve(c.sends, character, c.options), seen));
}
const head = {
	about: "Golden outputs of src/poser for the authored Y Bot cases in test/poser/poser-cases.mjs. Written by test/poser/make-poser-goldens.mjs.",
	model: { sha256: POSER_MODEL.sha256 },
	rig: rigFacts(poser.prepare(character)),
};
const text = `${JSON.stringify(head).slice(0, -1)},\n"cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;
writeFileSync(GOLDENS_PATH, text);
console.log(`wrote ${GOLDENS_PATH}: ${cases.length} cases (${cases.filter((c) => !c.ok).length} rejected), ${text.length} bytes`);
