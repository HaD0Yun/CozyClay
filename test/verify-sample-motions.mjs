#!/usr/bin/env node
// Sample motions (src/motion/sample-motions.js): the takes the Motion tab installs with one click, with no agent.
// Every sample compiles QA-clean on both rigs wherever the character stands and faces, and a walk ends on the
// character's spot (it comes from behind it, so the take does not leave the view set up around the character).
import { compileSpec } from "../src/motion3/pipeline.js";
import { motionScene } from "../src/motion3/scene.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";
import { SAMPLE_MOTIONS, sampleMotionSpec } from "../src/motion/sample-motions.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const scene = motionScene([]);
const PLACES = [{ x: 0, z: 0, rot: 0 }, { x: 0.4, z: -0.3, rot: 30 }, { x: -1.2, z: 2, rot: 90 }, { x: 2, z: 1, rot: 180 }, { x: 0, z: 0, rot: -135 }];

expect("four samples, unique ids, a label in each language", SAMPLE_MOTIONS.length === 4 && new Set(SAMPLE_MOTIONS.map(s => s.id)).size === 4
	&& SAMPLE_MOTIONS.every(s => s.en && s.ko && s.zh), JSON.stringify(SAMPLE_MOTIONS.map(s => s.id)));
expect("an unknown id has no spec", sampleMotionSpec("nope", PLACES[0]) === null);
expect("a character with no placement stands at the origin facing +z", JSON.stringify(sampleMotionSpec("back_flip").use[0].args) === JSON.stringify({ at: [0, 0], heading: 0 }));

for (const rig of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(rig);
	for (const sample of SAMPLE_MOTIONS) {
		const bad = [];
		for (const place of PLACES) {
			const spec = sampleMotionSpec(sample.id, place), r = compileSpec(spec, { sk, scene });
			if (!r.qa.ok) bad.push(`${JSON.stringify(place)}: ${r.qa.groups.map(g => `${g.kind} ${g.subject}`).join("; ")}`);
			const walk = spec.use.find(u => u.skill === "walkTo");
			if (walk && (walk.args.to[0] !== place.x || walk.args.to[1] !== place.z)) bad.push(`${JSON.stringify(place)}: the walk ends at ${walk.args.to}`);
		}
		expect(`${rig} ${sample.id}: QA-clean at ${PLACES.length} placements, a walk ends on the character's spot`, bad.length === 0, bad.join(" | "));
	}
}
process.exit(failures ? 1 : 0);
