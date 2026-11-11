import assert from 'node:assert/strict';
import { TRANSIENT_WRITERS } from './verify-bus-coverage.mjs';
import { projectFixture, ok } from './project-fixture.mjs';

const f = projectFixture();
try {
  const app = f.scope.appContext;
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio });
  const before = f.project.collectProjectSnapshot('Heist'), clock = app.undoClock;
  ok(f.run('view.select', { selection: { kind: 'character', id: 'actor-b' } }, 'agent'));
  app.notify('transient-feedback-496');
  const sentinel = 'transient-state-must-not-be-saved-496';
  // Populate the same render/live/save envelopes the real serializer reads.
  // Guard both the setter names and the state fields, including nested leakage.
  for (const [, state] of Object.entries(TRANSIENT_WRITERS)) {
    f.scope[state] = sentinel;
    f.scope.projectStateRef.current[state] = sentinel;
    app.patchLive({ [state]: sentinel });
  }
  const serialized = await f.project.collectProjectSerialized('Heist');
  const forbidden = new Set([...Object.keys(TRANSIENT_WRITERS), ...Object.values(TRANSIENT_WRITERS)]);
  const check = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `${key} must never enter the saved project document`);
      check(child);
    }
  };
  check(JSON.parse(serialized));
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(f.project.collectProjectSnapshot('Heist'), before);
  assert.equal(app.undoClock, clock, 'selection and feedback never author an undo entry');
  console.log('PASS #496 transient writer names and state are absent from the saved project');
} finally { f.dispose(); }

