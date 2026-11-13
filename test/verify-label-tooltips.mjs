#!/usr/bin/env node
// Issue #102: labels use the selected locale and icon-only actions explain
// themselves to both mouse and keyboard users.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const app = readStudioSource();
// Playback lives in the timeline transport only (#193 removed the PlayView
// bar's duplicate), so its icon contract is asserted where the buttons are.
const timeline = readFileSync(new URL("../src/motion/timeline.jsx", import.meta.url), "utf8");

// #523: the top bar keeps the hidden element only for the live workspace handle; its MCP copy is never shown.
assert.match(app, /data-live-workspace=\{liveWorkspaceHandle \|\| undefined\}/, "the hidden top bar element keeps the live workspace handle");
assert.doesNotMatch(app, /"MCP connected"|"MCP offline"/, "the hidden MCP state carries no unseen copy");
assert.match(timeline, /aria-label=\{playing \? ko\("Pause playback", "재생 일시중지"\) : ko\("Play playback", "재생 시작"\)\}/, "the play icon needs an accessible name");
assert.match(timeline, /title=\{ko\("Play \/ pause \(Space\)", "재생\/일시중지 \(Space\)"\)\}/, "the play icon needs a tooltip");
assert.match(app, /title=\{ko\("Download OTIO cut list", "OTIO 컷 목록 다운로드"\)\}/, "the OTIO export item needs a tooltip");
assert.match(app, /aria-label=\{ko\(`Open pose studio for \$\{label\}`, `\$\{label\} 포즈 열기`, `打开 \$\{label\} 的姿势工作室`\)\}/, "pose glyph needs an accessible name");
assert.match(app, /title=\{ko\(`Pose \$\{label\}`, `\$\{label\} 포즈`, `\$\{label\} 姿势`\)\}/, "pose glyph keeps a visible tooltip");

console.log("label and icon tooltip checks PASS");
