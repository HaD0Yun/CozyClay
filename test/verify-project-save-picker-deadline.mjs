#!/usr/bin/env node
// #1207: the command deadline also runs while the user sits in the browser's Save dialog.
// Save, Save As and Export as Animation project give the user the hub's picker time, like Open,
// and a project file that was written is never reported as "Could not save the project".
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The fixture renders the scenes hook once on the server, where a later setState is a no-op.
// Record the values given to the save-state setter so the test can read what the user would see.
const React = createRequire(import.meta.url)('react');
const useState = React.useState, saveStates = [];
React.useState = initial => {
  const [value, set] = useState(initial);
  return initial === 'idle' ? [value, next => { if (typeof next === 'string') saveStates.push(next); return set(next); }] : [value, set];
};
// Loaded after the patch: Node binds a CommonJS module's named exports when ESM first imports it.
const { projectFixture } = await import('./bus/project-fixture.mjs');

// The Studio binding builds its bus without a timer port, so the bus reads the global timer.
// Deadlines (30 s and longer) become injected timers; shorter timers stay real.
const timers = [], realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (run, ms, ...args) => {
  if (!(ms >= 30_000)) return realSetTimeout(run, ms, ...args);
  const timer = { run, ms, cleared: false, unref() { return timer; }, ref() { return timer; } };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = timer => { if (timers.includes(timer)) timer.cleared = true; else realClearTimeout(timer); };
const settle = async () => { for (let i = 0; i < 50; i += 1) await new Promise(resolve => setImmediate(resolve)); };
function setup(options) {
  saveStates.length = 0;
  timers.length = 0;
  const f = projectFixture(options), notices = [], written = [];
  f.scope.setToast = message => notices.push(typeof message === 'function' ? message(false, english => english) : String(message));
  let pick = null;
  const handle = { name: 'Heist.cclayproject', createWritable: async () => ({ write: async text => { written.push(text); }, close: async () => handle.onClose?.() }) };
  globalThis.window = { showOpenFilePicker() {}, showSaveFilePicker: () => new Promise(resolve => { pick = () => resolve(handle); }) };
  // Advance injected time: every live timer due within ms fires.
  const advance = ms => { for (const timer of timers) if (!timer.cleared && timer.ms <= ms) { timer.cleared = true; timer.run(); } };
  return { f, timers, notices, written, handle, advance, pick: () => pick?.() };
}

const failures = [];
async function check(label, run, options) {
  const t = setup(options);
  try { await run(t); console.log(`PASS ${label}`); }
  catch (error) { failures.push(label); console.error(`FAIL ${label}\n${error.message}`); }
  finally { t.f.dispose(); }
}

for (const id of ['project.save', 'project.saveAs', 'project.exportAsAnimation']) {
  await check(`${id} survives 30 s of injected time in the file picker`, async t => {
    const answer = t.f.run(id);
    await settle();
    t.advance(30_000);
    await settle();
    t.pick();
    const receipt = await answer;
    assert.equal(receipt.ok, true, `${id}: a user who stays 30 s in the Save dialog is not refused (${receipt.code}: ${receipt.message})`);
    assert.equal(t.written.length, 1, `${id}: the project file is written`);
  }, id === 'project.exportAsAnimation' ? { session: { name: 'Heist', previsMode: 'storyboard' } } : undefined);
}

if (failures.length) { console.error(`${failures.length} failing: ${failures.join('; ')}`); process.exit(1); }
