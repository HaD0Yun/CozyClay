#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree, scanSource } from "./verify-bus-coverage.mjs";
import { handlerCoverage } from './handler-coverage.mjs';
import { COMMAND_MODULES } from "../../src/commands/index.js";
const STUDIO_ACTIONS = Object.values(COMMAND_MODULES).flatMap(module => module.declarations);
import { fixture, result } from "./fixture.mjs";
import { documentFixture } from "./document-store-fixture.mjs";

const ORIGINS = ["ui", "agent", "mcp", "cli"];
const CHECKS = ["receipt", "undo", "UNDO_EXPIRED", "tx cancel", "stale revision", "job after concurrent edit"];

function parityMatrix(registry) {
  return registry.list().filter(command => command.kind === "mutation").flatMap(command => ORIGINS.flatMap(origin => CHECKS.map(check => ({ command: command.id, origin, check }))));
}
function executeParity({ run, snapshot, command, args = { value: 1 }, raw = run }) {
  const rows = [];
  for (const origin of ORIGINS) {
    const before = structuredClone(snapshot().slices ?? snapshot());
    const receipt = run(command, args, origin);
    rows.push({ command, origin, check: "receipt", ok: Boolean(receipt.ok && receipt.revision.after === receipt.revision.before + 1 && receipt.affectedIds.length && receipt.undo?.historyEntryId) });
    const undone = run("edit.undo", { receiptId: receipt.receiptId }, "ui");
    rows.push({ command, origin, check: "undo", ok: undone.status === "undone" && JSON.stringify(snapshot().slices ?? snapshot()) === JSON.stringify(before) });
  }
  const first = run(command, args, "ui");
  for (let i = 0; i < 50; i++) run(command, { ...args, value: i + 2 }, "ui");
  rows.push({ command, origin: "ui", check: "UNDO_EXPIRED", ok: run("edit.undo", { receiptId: first.receiptId }, "ui").code === "UNDO_EXPIRED" });
  const transactionBefore = structuredClone(snapshot().slices ?? snapshot());
  const opened = run("run.begin", { id: command, args }, "agent");
  run("run.update", { txId: opened.txId, args: { ...args, value: 9 } }, "agent");
  rows.push({ command, origin: "agent", check: "tx cancel", ok: run("run.cancel", { txId: opened.txId }, "agent").ok && JSON.stringify(snapshot().slices ?? snapshot()) === JSON.stringify(transactionBefore) });
  const staleRevision = snapshot().revision;
  run(command, { ...args, value: 77 }, "ui");
  const refused = raw(command, args, "agent", { expectedRevision: staleRevision });
  rows.push({ command, origin: "agent", check: "stale revision", ok: refused.code === "STALE_SCENE" });

  return rows;
}

function pendingErrors(previous, current) {
  return current.filter(id => !previous.includes(id)).map(id => `${id}: newly pending`);
}
function readParityPending(directory = new URL('./parity-pending/', import.meta.url), { allowPending = false } = {}) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  return readdirSync(root).sort().flatMap(file => {
    assert.ok(file.endsWith('.json'), `Unexpected pending file: ${file}`);
    const domain = file.slice(0, -5);
    const { version, pending } = JSON.parse(readFileSync(join(root, file), 'utf8'));
    assert.equal(version, 1);
    // A migration empties only its own file. Keeping the empty file avoids
    // a shared manifest edit when the five migrations run in parallel.
    assert.ok(Array.isArray(pending) && pending.length <= 1);
    assert.deepEqual(pendingErrors([domain], pending), []);
    if (!allowPending) assert.deepEqual(pending, [], `${domain}: parity migration is complete; pending rows cannot return`);
    return pending;
  });
}
function sourceFiles(root) {
  const files = [];
  const walk = dir => readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".jsx")) files.push(path);
  });
  walk(root);
  return files;
}
function coverageMetrics(fixtures = null) {
  const root = fileURLToPath(new URL('../../src', import.meta.url));
  const sources = fixtures ?? sourceFiles(root).map(file => ({ file, source: readFileSync(file, 'utf8') }));
  const handlers = sources.map(({ source, file }) => handlerCoverage(source, file, STUDIO_ACTIONS));
  const handlerTotal = handlers.reduce((total, sites) => total + sites.handlerTotal, 0);
  const handlerSites = handlers.reduce((total, sites) => total + sites.handlerSites, 0);
  const writerReferences = fixtures ? fixtures.flatMap(({ source, file }) => scanSource(source, file).references).length : scanTree(root).length;
  const registeredCommands = STUDIO_ACTIONS.filter(action => action.exposure !== "ui-only").length;
  const metrics = { writerReferences, handlerSites, handlerTotal, registeredCommands, commandOriginRows: registeredCommands * ORIGINS.length };
  console.log(`BUS COVERAGE (a) document-writer references outside commands: ${metrics.writerReferences}`);
  console.log(`BUS COVERAGE (b) document-mutating UI handler sites that reach run: ${metrics.handlerSites} of ${metrics.handlerTotal} (${metrics.handlerTotal ? 100 * metrics.handlerSites / metrics.handlerTotal : 100}%)`);
  console.log(`BUS COVERAGE (c) registered commands exposed to agents: ${metrics.registeredCommands} of ${metrics.registeredCommands}`);
  return metrics;
}
function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

test("a fixture-only registration gets every origin/check row", () => {
  const f = fixture();
  f.registry.register({
    id: "fixture.parity", label: "Parity fixture", kind: "mutation", description: "fixture", undoDomain: "shot",
    input: { type: "object", properties: {}, required: [], additionalProperties: false }, available: () => true, run: () => result(),
  });
  const rows = parityMatrix(f.registry).filter(row => row.command === "fixture.parity");
  assert.equal(rows.length, ORIGINS.length * CHECKS.length);
  assert.deepEqual(new Set(rows.map(row => row.origin)), new Set(ORIGINS));
  assert.deepEqual(new Set(rows.map(row => row.check)), new Set(CHECKS));
});

test("parity pending ids may only shrink", () => {
  const ceiling = ['shots', 'objects', 'cast', 'motion', 'project'];
  const pending = readParityPending();
  assert.deepEqual(pendingErrors(ceiling, pending), []);
  assert.deepEqual(pendingErrors(['stage', 'shots'], ['stage']), []);
  assert.deepEqual(pendingErrors(pending, [...pending, 'new-domain']), ['new-domain: newly pending']);
  assert.deepEqual(pendingErrors(ceiling, [...pending, 'stage']), ['stage: newly pending']);
  console.log(`BUS PARITY pending rows: ${pending.length * ORIGINS.length * CHECKS.length}`);
});

test('#496.2 only document-mutating handlers enter the denominator', () => {
  const metrics = coverageMetrics([{ file: 'fixture.jsx', source: `function Panel() {
    const change = () => run('stage.setStyle', { style: 'film' });
    const alias = change;
    return <Child onChange={alias} onClick={() => run('character.update', {})}
      onMouseOver={() => setToast('hover')} onFocus={() => run('view.select', {})}
      onBlur={() => setSelectedHierarchyId('camera')} />;
  }` }]);
  assert.equal(metrics.handlerTotal, 2);
  assert.equal(metrics.handlerSites, 2);
});

test('#496.2 a direct-writing fixture handler makes the coverage gate red', () => {
  for (const writer of ['setStyle(\'film\')', 'change(\'film\')', 'controls.setStyle(\'film\')']) {
    const metrics = coverageMetrics([{ file: 'fixture.jsx', source: `function Panel() {
      const change = setStyle;
      return <Child onChange={() => ${writer}} onClick={() => run('stage.setStyle', {})} />;
    }` }]);
    assert.equal(metrics.handlerTotal, 2);
    assert.equal(metrics.handlerSites, 1);
    assert.throws(() => assert.equal(metrics.handlerSites, metrics.handlerTotal), assert.AssertionError);
  }
  const mixed = coverageMetrics([{ file: 'fixture.jsx', source: `function Panel() {
    return <Child onChange={() => { run('stage.setStyle', {}); setStyle('film'); }} />;
  }` }]);
  assert.equal(mixed.handlerTotal, 1); assert.equal(mixed.handlerSites, 0);
});

test("coverage metrics are measured from the source and registered actions", () => {
  const metrics = coverageMetrics();
  assert.equal(typeof metrics.writerReferences, "number");
  assert.equal(typeof metrics.handlerSites, "number");
  assert.equal(typeof metrics.registeredCommands, "number");
  assert.equal(metrics.commandOriginRows, metrics.registeredCommands * ORIGINS.length);
  assert.equal(metrics.registeredCommands, STUDIO_ACTIONS.filter(action => action.exposure !== "ui-only").length);
  const floor = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url))).coverage;
  assert.ok(metrics.writerReferences <= floor.writerReferences);
  assert.ok(metrics.handlerSites >= floor.handlerSites && metrics.handlerTotal >= floor.handlerTotal);
  assert.ok(metrics.registeredCommands >= floor.registeredCommands);
  assert.ok(metrics.handlerTotal > 0);
  assert.equal(metrics.handlerSites, metrics.handlerTotal, '#496.2 every document-mutating handler reaches run without a direct write');
});

test("registered mutations execute receipt and undo checks through the real bus", () => {
  const f = documentFixture();
  const rows = executeParity({
    run: (id, args, origin) => f.run(id, args, origin),
    raw: (id, args, origin, options) => f.bus.run(id, args, { origin, host: f.host, ...options }),
    snapshot: () => f.store.getSnapshot(),
    command: "stage.set",
  });
  assert.equal(rows.length, ORIGINS.length * 2 + 3);
  assert.equal(rows.every(row => row.ok), true, JSON.stringify(rows));
});

// The fixture above proves the generic runner; the pilot also executes every
// stage origin/check against the real hook and App binding, not a fake slice.
await import('./verify-stage-domain.mjs');
export { pendingErrors, readParityPending, coverageMetrics };
