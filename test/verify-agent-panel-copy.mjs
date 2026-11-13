#!/usr/bin/env node
// #1239: the Agent panel's job outcome lines, the installed-with-warnings undo
// note and the failure card's recovery copy reach the Korean and Chinese UI
// through ko() instead of showing a bare English literal, and they ask the user
// to check the scene in plain words instead of to "reconcile".
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
const failures = [];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each English line is the first argument of a ko() call that also carries
// Korean (Hangul) and Chinese (CJK ideographs) text.
const LOCALIZED = [
	"Not applied — scene unchanged.",
	"Stopped, but the result is unknown — check the scene before editing this target.",
	"Undo with Cmd+Z or ask the agent.",
	"No recovery is available for this command.",
	"Ask the agent to inspect the target before trying again.",
	"The same command can be retried.",
	"Tell the agent what to do with the changed target.",
	"The result is unknown; check the scene before changing this target.",
	"Sign in again to continue.",
	"Log in again under Connect a model, then retry.",
	" Nothing in the scene changed.",
	" Whether the scene changed is unknown.",
];
for (const english of LOCALIZED) {
	const call = new RegExp(`ko\\("${escape(english)}", "([^"]*)", "([^"]*)"\\)`).exec(panel);
	if (!call) { failures.push(`not wrapped in ko(english, korean, chinese): ${JSON.stringify(english)}`); continue; }
	if (!/[가-힣]/.test(call[1])) failures.push(`no Korean text for ${JSON.stringify(english)}`);
	if (!/[一-鿿]/.test(call[2])) failures.push(`no Chinese text for ${JSON.stringify(english)}`);
	const bare = panel.split(`"${english}"`).length - 1, wrapped = panel.split(`ko("${english}"`).length - 1;
	if (bare !== wrapped || panel.includes(`>${english.trim()}<`)) failures.push(`still shown as a bare English literal: ${JSON.stringify(english)}`);
}
// The jargon "reconcile" is not user copy: neither the outcome line nor the recovery copy uses it.
for (const old of ["reconcile before editing this target", "reconcile before changing this target"]) {
	if (panel.includes(old)) failures.push(`the panel still asks the user to ${JSON.stringify(old)}`);
}

if (failures.length) {
	console.error(`Agent panel copy checks FAIL (${failures.length}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log(`Agent panel copy checks PASS (${LOCALIZED.length} lines localized)`);
