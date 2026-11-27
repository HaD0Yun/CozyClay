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
// The Agent panel's approval card (src/workflow/agent-confirm.js): the agent's exact export request, run once the user said yes.
{
  const g = fixture(); let ran = null;
  g.register('export.shotVideo', args => { ran = args; return result(); });
  const asked = { shotId: 'shot-1', scope: 'shot' }, events = [];
  g.bus.subscribe(event => { if (event.type === 'confirmation.required') events.push(event); });
  assert.equal((await g.bus.run('export.shotVideo', asked, g.request())).code, 'CONFIRMATION_REQUIRED');
  assert.equal(ran, null);
  assert.deepEqual(events, [{ type: 'confirmation.required', id: 'export.shotVideo', args: asked, reason: 'Exporting writes a video file outside the Studio.' }], 'the refusal reaches the Agent panel');
  await g.bus.run('export.shotVideo', asked, g.request('mcp'));
  assert.equal(events.length, 1, 'only an agent request asks the panel');
  const approved = await g.bus.runConfirmed('export.shotVideo', asked);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(ran, asked, 'the request the agent made, not another');
  g.bus.dispose();
}
console.log('PASS bus acceptance 7: open defaults, confirmed external/destructive actions and one-use bound tokens');
