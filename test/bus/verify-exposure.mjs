import assert from 'node:assert/strict';
import { fixture, result, sample } from './fixture.mjs';
import { STUDIO_ACTIONS } from '../../src/studio-actions.js';
const confirm = new Set(['scene.delete', 'export.shotVideo', 'project.save']);
for (const action of STUDIO_ACTIONS) {
  const f = fixture(); let calls = 0;
  f.register(action.id, () => { calls++; if (action.kind === 'mutation') f.edit(1); return result(); });
  const args = sample(action.input);
  const first = await f.bus.run(action.id, args, f.request());
  if (confirm.has(action.id)) {
    assert.equal(first.code, 'CONFIRMATION_REQUIRED', action.id);
    assert.equal(calls, 0);
    assert.equal((await f.bus.run(action.id, args, f.request('cli', { confirmationToken: 'invented' }))).code, 'CONFIRMATION_REQUIRED');
    const token = f.bus.confirm(action.id, args);
    assert.equal((await f.bus.run(action.id, args, f.request('mcp', { confirmationToken: token }))).ok, true, action.id);
    assert.equal((await f.bus.run(action.id, args, f.request('mcp', { confirmationToken: token }))).code, 'CONFIRMATION_REQUIRED', 'tokens are single-use');
  } else assert.equal(first.ok, true, `${action.id}: ${JSON.stringify(first)}`);
  f.bus.dispose();
}
const f = fixture();
f.register('scene.delete', () => result());
assert.equal((await f.bus.run('scene.delete', { sceneId: 'target' }, f.request('ui'))).ok, true);
f.register('view.setInset', () => result(), { exposure: 'ui-only' });
assert.equal((await f.bus.run('view.setInset', { collapsed: true }, f.request())).code, 'CAPABILITY_MISSING');
assert.throws(() => f.register('shot.create', () => result(), { exposure: 'public' }), /exposure/);
console.log('PASS bus acceptance 7: open defaults, confirmed external/destructive actions and one-use bound tokens');
