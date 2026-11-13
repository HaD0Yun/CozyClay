#!/usr/bin/env node
// Renders a contact sheet of a clip file with no browser (src/lowvis/pi/render.mjs).
//   node tools/lowvis/pi/sheet.mjs <clip.json> --out <file.png> [--frames 0,24,48] [--view three|side|front|top] [--focus a,b]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderSheet } from "../../../src/lowvis/pi/render.mjs";

const argv = process.argv.slice(2), file = argv.find(a => !a.startsWith("--") && a.endsWith(".json"));
const opt = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };
if (!file || !opt("out")) { console.error("usage: node tools/lowvis/pi/sheet.mjs <clip.json> --out <file.png> [--frames 0,24] [--view three] [--focus a]"); process.exit(2); }
const clip = JSON.parse(readFileSync(file, "utf8"));
const frames = opt("frames") ? opt("frames").split(",").map(Number) : Array.from({ length: 8 }, (_, k) => Math.round(k * (clip.frameCount - 1) / 7));
const sheet = renderSheet(clip, { frames, view: opt("view"), focus: opt("focus")?.split(",") });
mkdirSync(dirname(resolve(opt("out"))), { recursive: true });
writeFileSync(opt("out"), sheet.png);
console.log(JSON.stringify({ out: resolve(opt("out")), width: sheet.width, height: sheet.height, bytes: sheet.png.length, renderMs: sheet.ms, figurePx: sheet.figurePx, frames: sheet.frames, view: sheet.view }));
