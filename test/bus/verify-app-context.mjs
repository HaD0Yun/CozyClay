import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/experimental';
import { createSceneObject } from '../../src/scene-objects.js';
import { createDocumentStore } from '../../src/document-store.js';

const { createAppContext } = await import('../../src/app-context.js');
const ref = current => ({ current });
function test(name, run) {
  run();
  console.log(`PASS AppContext ${name}`);
}

test('acceptance 1: composes owned history and exposes live projections and ports', () => {
  const clock = ref(0), history = ref({ past: [], future: [] });
  const characters = ref([{ id: 'actor' }]), scenes = ref([{ id: 'scene' }]), motion = ref({ frames: 48 });
  const state = ref({ shots: [], timeline: { frameCount: 48 } });
  const context = createAppContext({ clock, history, characters, scenes, motion, state });
  assert.equal(context.undoClock, 0);
  assert.equal(context.castHistory, undefined, 'there is no native snapshot history');
  assert.equal(context.recordCharacterUndo, undefined);
  assert.equal(context.recordShotUndo, undefined, 'shots own their document history');
  assert.equal(clock.current, 0, 'native clock cells are not used');
  assert.deepEqual(history.current, { past: [], future: [] });
  const store = createDocumentStore({ owned: { cast: [] } });
  context.registerStoreDomain('cast', { documentStore: store, beginAction: () => store.beginAction('cast') });
  context.recordAction('cast', () => store.write('cast', characters.current));
  assert.deepEqual(store.depths(), { past: 1, future: 0 });
  assert.equal(context.historyEntry(), store.history().present.historyEntryId);
  assert.equal(context.undoClock, 1, 'committed store sessions advance the project checkpoint');
  assert.equal(context.live.characters, characters.current);
  assert.equal(context.live.scenes, scenes.current);
  assert.equal(context.live.motion, motion.current);
  assert.equal(context.live.state, state.current);
  assert.throws(() => { context.live.characters = []; }, TypeError);
  assert.throws(() => { context.live.state = {}; }, TypeError);
  context.updatePorts({ read: () => 'first' });
  const read = context.ports.read;
  context.updatePorts({ read: () => 'latest' });
  assert.equal(read(), 'latest', 'retained delegates reach the latest render');
  context.updateActionPorts({ state: () => 'first action' });
  const ports = context.actionPorts;
  context.updateActionPorts({ state: () => 'latest action' });
  assert.equal(ports, context.actionPorts);
  assert.equal(ports.state(), 'latest action');
});

import { readStudioSource } from './verify-domain-modules.mjs';
const app = readStudioSource();
const parsed = parseSync('App.jsx', app);
assert.deepEqual(parsed.errors, []);
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else walk(child, visit);
  }
}
test('acceptance 2: App has no direct undo-clock or cast-history refs', () => {
  const leaks = [];
  walk(parsed.program, node => {
    if (node.type === 'Identifier' && ['opClockRef', 'charHistoryRef'].includes(node.name)) leaks.push(node.name);
  });
  assert.deepEqual(leaks, []);
});

function memberPath(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression') return '';
  return `${memberPath(node.object)}.${node.computed ? node.property.value : node.property.name}`;
}
test('acceptance 3: live model publications stay behind the facade, including aliases', () => {
  const aliases = new Set(['charactersRef.current', 'liveStateRef.current', 'scenesRef.current', 'appContext.live']);
  walk(parsed.program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
      && [...aliases].some(path => memberPath(node.init).startsWith(path))) aliases.add(node.id.name);
  });
  const leaks = [];
  const check = node => {
    const path = memberPath(node);
    // Rebinding a local (including scalar projections) is not a model write.
    if ([...aliases].some(alias => (alias.includes('.') && path === alias) || path.startsWith(`${alias}.`))) leaks.push(path);
  };
  walk(parsed.program, node => {
    if (node.type === 'AssignmentExpression') check(node.left);
    if (node.type === 'UpdateExpression') check(node.argument);
    if (node.type === 'CallExpression' && memberPath(node.callee) === 'Object.assign') check(node.arguments[0]);
  });
  assert.deepEqual(leaks, []);
});
test('acceptance 3: synchronous publications and later renders reach retained readers', () => {
  const context = createAppContext();
  const read = () => context.live;
  const first = { characters: [], shots: [], timeline: { frameCount: 48 } };
  context.publishLive(first);
  const cast = [{ id: 'new actor' }];
  context.publishCharacters(cast);
  context.patchLive({ characters: cast, shots: [{ id: 'shot' }] });
  context.patchTimeline({ frameCount: 96 });
  assert.equal(read().characters, cast);
  assert.equal(first.characters, cast);
  assert.equal(read().state.timeline.frameCount, 96);
  const next = { characters: cast, shots: [], timeline: { frameCount: 120 } };
  context.publishLive(next);
  context.publishScenes([{ id: 'new scene' }]);
  context.publishMotion({ frames: 120 });
  assert.equal(read().state, next);
  assert.equal(read().scenes[0].id, 'new scene');
  assert.equal(read().motion.frames, 120);
});

const { appFixture } = await import('./app-fixture.mjs');
test('acceptance 4: App has no native object-clock callbacks', () => {
  const callbacks = [];
  walk(parsed.program, node => {
    if (node.type === 'Property' && node.key.name === 'onObjects') callbacks.push(node.value);
  });
  assert.equal(callbacks.length, 0, 'scene loads also use the registered object owner');
});
test('acceptance 4: real App undo and redo traverse interleaved object and cast edits in reverse order', () => {
  const f = appFixture();
  try {
    const state = () => {
      const { objects, characters } = f.actual.readStudioState();
      return { objects, characters };
    };
    const snapshots = [state()];
    for (let index = 1; index <= 3; index++) {
      f.actual.commitStudioDraft({ domain: 'objects', draft: [{ ...createSceneObject('cube'), id: `object-${index}`, x: index }] });
      snapshots.push(state());
      f.actual.commitStudioDraft({ domain: 'cast', draft: f.characterRef.current.map(c => ({ ...c, x: index })) });
      snapshots.push(state());
    }
    assert.equal(f.scope.appContext.undoClock, 6);
    assert.equal(f.scope.appContext.objectClock, undefined, 'objects need no independent arbitration clock');
    for (let index = snapshots.length - 2; index >= 0; index--) {
      f.actual.undoScene();
      assert.deepEqual(state(), snapshots[index], `undo ${index}`);
    }
    for (let index = 1; index < snapshots.length; index++) {
      f.actual.redoScene();
      assert.deepEqual(state(), snapshots[index], `redo ${index}`);
    }
    f.scope.appContext.storeDomain('cast').load(f.characterRef.current);
    f.scope.appContext.storeDomain('objects').load([]);
    assert.equal(f.scope.appContext.nextStoreHistory(false), undefined);
    assert.equal(f.scope.appContext.nextStoreHistory(true), undefined);
  } finally { f.dispose(); }
});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const contextModule = await import('../../src/app-context.js');
test('acceptance 5: App provides the facade and its one bus to descendants', () => {
  const providers = [], directPorts = [];
  walk(parsed.program, node => {
    if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXMemberExpression'
      && node.name.object.name === 'AppContext' && node.name.property.name === 'Provider') providers.push(node);
    if (node.type === 'Identifier' && ['studioPortsRef', 'studioActionPortsRef'].includes(node.name)) directPorts.push(node.name);
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].attributes.find(attr => attr.name?.name === 'value').value.expression.name, 'appContext');
  assert.deepEqual(directPorts, []);
  const f = appFixture();
  try {
    // Reading the bus refreshes the whole binding: a panel's render must not read it (playback renders every frame).
    let reads = 0;
    const context = createAppContext({ getBus: () => { reads += 1; return f.binding.bus; } });
    let observed;
    function Consumer() { observed = contextModule.useBus(); return null; }
    renderToStaticMarkup(React.createElement(contextModule.AppContext.Provider, { value: context }, React.createElement(Consumer)));
    assert.equal(reads, 0, 'useBus() during a render does not read the bus');
    const receipt = observed.run('shot.create', {}, { origin: 'ui' });
    assert.equal(receipt.ok, true);
    assert.equal(f.actual.readStudioState().shots.length, 1);
    f.actual.undoScene();
    assert.equal(f.actual.readStudioState().shots.length, 0);
  } finally { f.dispose(); }
});
