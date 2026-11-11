#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parseSync } from "rolldown/experimental";
import { startUserEdits, telemetrySeam } from "../../src/command-bus-telemetry.js";
import { fixture, result } from "./fixture.mjs";

const WRITER_NAMES = new Set([
  "setStyle", "setKeyLight", "setEnvironmentImage", "setShotAspectKey", "setSensorFormat",
  "setCharacters", "setSceneObjects", "setScenes", "setActiveSceneId", "setCustomPoses",
  "setMotion", "setProject", "setStage",
]);
// These cells are absent from project serialization and owned undo slices.
// Selection has view.select; the uncommitted video form has motion.setVideoDraft.
// Toasts are feedback captured in receipts, not an agent-editable capability.
export const TRANSIENT_WRITERS = Object.freeze({ setToast: 'toast', setSelectedHierarchyId: 'selectedHierarchyId', setI2vMotion: 'i2vMotion' });
const writerName = name => WRITER_NAMES.has(name) || /^record.*Undo$/.test(name);
const isRunCall = node => node?.type === "CallExpression" && ((node.callee?.type === "Identifier" && node.callee.name === "run") || (node.callee?.type === "MemberExpression" && node.callee.property?.name === "run"));
const functionName = node => node?.id?.name ?? "<anonymous>";

function scanSource(source, file = "fixture.jsx") {
  const ast = parseSync(file, source);
  const aliases = new Set();
  const references = [];
  const handlers = [];
  const functions = [];
  const visit = (node, owner = "<module>", parent = null) => {
    if (!node || typeof node !== "object") return;
    let nextOwner = owner;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      nextOwner = functionName(node);
      functions.push(nextOwner);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "Identifier" && writerName(node.init.name)) aliases.add(node.id.name);
    if (node.type === "Identifier" && (writerName(node.name) || aliases.has(node.name))) {
      const declaration = parent?.type === "VariableDeclarator" && parent.id === node;
      const property = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      const label = parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      if (!declaration && !property && !label) references.push({ file, function: nextOwner, name: node.name, kind: "reference" });
    }
    if (node.type === 'MemberExpression') {
      const name = node.computed ? node.property?.value : node.property?.name;
      if (writerName(name)) references.push({ file, function: nextOwner, name, kind: 'reference' });
    }
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && ["liveStateRef", "liveHandlersRef"].includes(node.object.name)) references.push({ file, function: nextOwner, name: `${node.object.name}.${node.computed ? "computed" : node.property?.name}`, kind: "computed-live-ref" });
    if (node.type === "JSXAttribute" && node.value?.type === "JSXExpressionContainer" && node.value.expression?.type === "Identifier" && (writerName(node.value.expression.name) || aliases.has(node.value.expression.name))) handlers.push({ file, function: nextOwner, name: node.value.expression.name });
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "loc") continue;
      if (Array.isArray(value)) for (const child of value) visit(child, nextOwner, node);
      else if (value && typeof value === "object") visit(value, nextOwner, node);
    }
  };
  visit(ast.program ?? ast);
  const perFunction = Object.fromEntries(functions.map(name => [name, references.filter(ref => ref.function === name).length]).filter(([, count]) => count > 0));
  return { references, handlers, perFunction };
}

function applyRatchet(current, baseline) {
  const errors = [];
  for (const [key, count] of Object.entries(baseline)) {
    if (!(key in current)) errors.push(`${key}: stale baseline entry`);
    else if (current[key] > count) errors.push(`${key}: ${current[key]} exceeds baseline ${count}`);
  }
  for (const key of Object.keys(current)) if (!(key in baseline)) errors.push(`${key}: new writer reference`);
  return errors;
}

function scanTree(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsx") || (relative(root, path).startsWith("domains/") && entry.name.endsWith(".js"))) files.push(path);
    }
  };
  walk(root);
  return files.flatMap(file => scanSource(readFileSync(file, "utf8"), relative(root, file)).references);
}

function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

test("fixture setStyle call is detected as a document-writer reference", () => {
  const result = scanSource("function Panel(){ const onChange = () => setStyle('film'); return <input onChange={onChange}/>; }");
  assert.equal(result.references.some(ref => ref.name === "setStyle"), true);
});

test("fixture setter passed as JSX prop is detected", () => {
  const result = scanSource("function Panel(){ return <Child onChange={setStyle}/>; }");
  assert.equal(result.references.some(ref => ref.name === "setStyle"), true);
  assert.equal(result.handlers.some(ref => ref.name === "setStyle"), true);
});

test("fixture run call is not a document-writer reference", () => {
  const result = scanSource("function Panel(){ return run('stage.set', {value: 1}); }");
  assert.equal(result.references.length, 0);
});

test('#496.1 member writers and writes inside run arguments cannot bypass the ratchet', () => {
  for (const source of [
    `function Panel(){ controls.setStyle('film'); }`,
    `function Panel(){ controls['setStyle']('film'); }`,
    `function Panel(){ const write = controls.setStyle; write('film'); }`,
    `function Panel(){ run('stage.set', { value: setStyle('film') }); }`,
  ]) assert.ok(scanSource(source).references.some(ref => ref.name === 'setStyle'), source);
});

test('#496.1 property labels are not writers, but setter values and shorthand remain references', () => {
  for (const key of ['setEnvironmentImage', '"setEnvironmentImage"']) {
    assert.deepEqual(scanSource(`const api = { ${key}: value => run('stage.setEnvironment', { environmentImage: value }) };`).references, []);
  }
  for (const value of ['{ setStyle }', '{ setStyle: setStyle }', '{ "setStyle": setStyle }']) {
    assert.ok(scanSource(`const api = ${value};`).references.some(ref => ref.name === 'setStyle'));
  }
});

test("stale baseline entries fail the ratchet", () => {
  assert.deepEqual(applyRatchet({ Panel: 1 }, { Panel: 1, Removed: 1 }), ["Removed: stale baseline entry"]);
});

test("aliases and computed live references count", () => {
  const result = scanSource("function Panel(){ const s=setStyle; return <Child onChange={s} value={liveHandlersRef.current['setStyle']}/>; }");
  assert.equal(result.references.some(ref => ref.name === "s"), true);
  assert.equal(result.references.some(ref => ref.kind === "computed-live-ref"), true);
});

test("ratchet baseline is non-increasing", () => {
  assert.deepEqual(applyRatchet({ Panel: 2 }, { Panel: 1 }), ["Panel: 2 exceeds baseline 1"]);
});

test("a user edit counts from its bus receipt, not from a write outside a bus run", () => {
  const sent = [];
  const restore = telemetrySeam({ track: (event, props) => sent.push({ event, props }) });
  try {
    startUserEdits("craft");
    const f = fixture();
    f.register("shot.create", () => { f.edit(1); return result(); });
    f.edit(2);
    assert.deepEqual(sent, [], "a document write outside a bus run is not an edit");
    assert.equal(f.bus.run("shot.create", {}, f.request("ui")).ok, true);
    assert.deepEqual(sent.filter(({ event }) => event.endsWith(":first_edit")), [{ event: "craft:first_edit", props: { edit_kind: "shot_add", definition_version: 2 } }]);
  } finally { restore(); }
});

export { scanSource, scanTree, writerName, isRunCall };

const actualReferences = scanTree(fileURLToPath(new URL("../../src", import.meta.url)));
const currentCounts = Object.create(null);
for (const ref of actualReferences) currentCounts[`${ref.file}::${ref.function}`] = (currentCounts[`${ref.file}::${ref.function}`] ?? 0) + 1;
const actual = actualReferences;
console.log(`BUS COVERAGE (a) document-writer references outside commands: ${actual.length}`);
console.log("BUS COVERAGE (b) handler sites: measured by parity matrix");
console.log("BUS COVERAGE (c) registered commands exposed to agents: generated by parity matrix");

test("#496.1 every document writer has moved to an owned command", () => {
  assert.equal(actualReferences.length, 0, JSON.stringify(actualReferences));
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url)));
  assert.deepEqual(baseline.writers, {});
  assert.equal(baseline.coverage.writerReferences, 0);
});

test("#496.1 an empty baseline rejects newly introduced writers", () => {
  assert.deepEqual(applyRatchet({ 'Panel::change': 1 }, {}), ['Panel::change: new writer reference']);
});

test("committed baseline accepts the current writer set", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url))).writers;
  assert.deepEqual(applyRatchet(currentCounts, baseline), []);
});
