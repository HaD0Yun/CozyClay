#!/usr/bin/env node
// Builds every demo with engine-simple, validates each clip, writes public/lowvis/clips/simple/<demo>.json and
// prints the build time and the self-checks (all measured from the written clip).
import { mkdirSync, writeFileSync } from "node:fs";
import { serializeClip, validateClip } from "../../../src/lowvis/clip.js";
import { DEMO_IDS } from "../../../src/lowvis/demos.js";
import { buildClip } from "../../../src/lowvis/engine-simple/engine.js";
import { checkClip } from "../../../src/lowvis/engine-simple/checks.js";

const outDir = new URL("../../../public/lowvis/clips/simple/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const mm = v => v == null ? "-" : (v * 1000).toFixed(1);
let failed = false;

console.log("demo        frames buildMs  KB  stretch_mm  slide_mm(step)  footLow_mm  jointLow_mm  carry_mm[min..max]  valid");
for (const demo of DEMO_IDS) {
	const { default: spec } = await import(`../../../src/lowvis/engine-simple/demos/${demo}.js`);
	const t0 = performance.now(), { clip, aux } = buildClip(spec);
	clip.stats.buildMs = Math.round((performance.now() - t0) * 100) / 100;
	const parsed = JSON.parse(serializeClip(clip)), valid = validateClip(parsed), c = checkClip(parsed, aux);
	Object.assign(clip.stats, { stretch: valid.stretch, plantedFootSlide: c.slide, footLow: c.footLow, carryHandToBox: c.carryFrames ? [c.carryMin, c.carryMax] : null });
	writeFileSync(new URL(`${demo}.json`, outDir), serializeClip(clip));
	console.log([demo.padEnd(11), String(clip.frameCount).padStart(6), clip.stats.buildMs.toFixed(1).padStart(7), (serializeClip(clip).length / 1024).toFixed(0).padStart(3),
		mm(valid.stretch).padStart(10), `${mm(c.slide)}(${mm(c.slideStep)})`.padStart(15), mm(c.footLow).padStart(11), mm(c.jointLow).padStart(12),
		(c.carryFrames ? `${mm(c.carryMin)}..${mm(c.carryMax)}` : "-").padStart(19), valid.ok ? "  ok" : "  FAIL"].join(" "));
	if (c.bodyToBox != null) console.log(`  ${demo}: hands-to-face while pushing ${mm(c.carryMin)}..${mm(c.carryMax)} mm; body-to-crate clearance ${mm(c.bodyToBox)} mm (negative = inside)`);
	if (parsed.props.some(p => p.pos.length > 3)) console.log(`  ${demo}: prop travel while nothing holds or keys it ${mm(c.freeTravel)} mm`);
	if (c.gripDrift != null) console.log(`  ${demo}: prop-in-hand drift ${mm(c.gripDrift)} mm, ${(c.gripTurn * 180 / Math.PI).toFixed(3)} deg`);
	for (const k of c.cuts) console.log(`  ${demo}: ${k.blade} to ${k.target} at cut frame ${k.f}: ${mm(Math.max(0, k.dist))} mm (0 = the blade is inside it, depth ${mm(Math.max(0, -k.dist))} mm)`);
	Object.assign(clip.stats, { freeTravel: c.freeTravel, bodyToBox: c.bodyToBox, gripDrift: c.gripDrift, cuts: c.cuts });
	for (const p of aux.placed) console.log(`  ${demo}: prop ${p.prop} released at frame ${p.f}, ${mm(p.miss)} mm from its place target`);
	if (!valid.ok) { failed = true; console.error(valid.errors); }
}
process.exit(failed ? 1 : 0);
