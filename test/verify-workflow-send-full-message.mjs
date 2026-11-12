#!/usr/bin/env node
// Source contract for the "Send to Workflow" failure toast (#1208). When the
// browser refuses the draft write for quota, the Board says the Workflow draft
// is full and what to do (remove pictures from the Workflow canvas, or save the
// project) in every language, instead of the raw storage error text. Other
// failures keep the existing "Could not send" toast with the error message.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/shell/BoardSlot.jsx", import.meta.url), "utf8");
const start = source.indexOf("async function sendToWorkflow(");
assert.ok(start >= 0, "BoardSlot defines sendToWorkflow");
const end = source.indexOf("\n\t}\n", start);
const body = source.slice(start, end);
const handler = body.slice(body.indexOf("} catch (error) {"));

assert.match(handler, /QuotaExceededError|\/quota\/i/, "the catch branch recognises a storage quota error by its name");
const full = handler.match(/ko\(\s*"([^"]*Workflow draft is full[^"]*)",\s*"([^"]+)",\s*"([^"]+)"\s*\)/);
assert.ok(full, "the quota branch shows a ko(en, ko, zh) message saying the Workflow draft is full");
const [, en, koText, zh] = full;
assert.match(en, /Remove pictures from the Workflow canvas/, "the message says to remove pictures from the Workflow canvas");
assert.match(en, /save the project/, "the message says to save the project");
assert.doesNotMatch(en, /\$\{/, "the quota message carries no raw error text");
assert.match(koText, /워크플로/, "the Korean message names the Workflow");
assert.match(zh, /工作流/, "the Chinese message names the Workflow");
assert.match(handler, /Could not send the panel to Workflow: \$\{error\?\.message \|\| error\}/, "other failures keep the error text");
assert.match(handler, /attempt\.fail\(error\)/, "telemetry still records the original error");
console.log("PASS a full Workflow draft is reported with what to do, in en/ko/zh, without the raw storage error");
