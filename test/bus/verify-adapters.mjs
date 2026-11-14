import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appFixture, appProgram, appSource, parseJavaScript } from './app-fixture.mjs';
import { deferred } from './fixture.mjs';
import { StudioProtocolError } from '../../src/studio-agent-protocol.js';
const f = appFixture();
try {
 const completion = deferred();
 let context;
 const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
 f.registry.register({ id: 'test.deferredJob', kind: 'job', domain: 'motion', input: inputs, available: () => true,
  run: (_args, ctx) => { context = ctx; return completion.promise.then(() => ({ affectedIds: [], summary: 'Deferred job done.' })); } });
 const event = deferred();
 const unsubscribe = f.binding.bus.subscribe(e => { if (e.type === 'job.completed') event.resolve(e); });
 const running = f.actual.runStudioAction('test.deferredJob');
 assert.ok(context.signal instanceof AbortSignal);
 completion.resolve();
 const completed = await running;
 assert.equal(completed?.status, 'completed', JSON.stringify(completed));
 assert.equal((await event.promise).receipt.receiptId, completed.receiptId);
 unsubscribe();
 f.registry.register({ id: 'shot.nested', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true,
  run: (_args, ctx) => { const created = ctx.run('shot.create'); ctx.run('shot.setCameraRail', { shotId: created.affectedIds[0], points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }); return { affectedIds: f.live.current.shots.map(s => s.id), summary: 'Two nested edits.' }; } });
 const before = f.scope.shotsDomain.documentStore.depths().past;
 const receipt = await f.actual.runStudioAction('shot.nested');
 assert.equal(receipt?.ok, true, JSON.stringify(receipt));
 assert.equal(f.scope.shotsDomain.documentStore.depths().past, before + 1);
 assert.equal(f.history.current.past.length, 0, 'nested shots do not add native cast entries');
 const undo = await f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }, { origin: 'ui' });
 assert.equal(undo.status, 'undone', JSON.stringify(undo));
 assert.equal(f.live.current.shots.length, 0);
 const source = appSource;
 let publishedRun;
 const visit = node => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'AssignmentExpression' && node.left?.object?.name === 'window' && node.left?.property?.name === '__cozyclay') {
   publishedRun = node.right.properties.find(property => property.key?.name === 'runStudioAction')?.value;
  }
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') {
   if (Array.isArray(value)) value.forEach(visit); else visit(value);
  }
 };
 visit(appProgram);
 assert.ok(publishedRun, 'the real browser QA action publisher is present');
 const visibleRun = new Function('runStudioAction', `return (${source.slice(publishedRun.start, publishedRun.end)});`)(f.actual.runStudioAction);
 f.registry.register({ id: 'test.refused', kind: 'job', domain: 'motion', input: inputs, available: () => true,
  run: () => { throw new StudioProtocolError('TARGET_NOT_READY', 'Original machine refusal.'); } });
 const refused = await visibleRun('test.refused');
 assert.equal(refused?.ok, false, 'the test-visible UI path preserves a refused receipt');
 assert.equal(refused.code, 'TARGET_NOT_READY');
 assert.equal(refused.message, 'Original machine refusal.');
 assert.equal(refused.phase, 'admission');
 assert.equal(f.actual.runStudioAction('test.refused'), null, 'ordinary UI refusal behavior is retained');
 f.registry.register({ id: 'test.refusedAsync', kind: 'job', domain: 'motion', input: inputs, available: () => true,
  run: () => Promise.reject(new StudioProtocolError('STALE_TARGET', 'Original async refusal.')) });
 const asyncRefused = await visibleRun('test.refusedAsync');
 assert.equal(asyncRefused?.ok, false);
 assert.equal(asyncRefused.code, 'STALE_TARGET');
 assert.equal(asyncRefused.message, 'Original async refusal.');
 const originalRun = f.binding.bus.run;
 const thrown = new StudioProtocolError('STALE_SCENE', 'Original protocol exception.');
 try {
  f.binding.bus.run = () => { throw thrown; };
  assert.throws(() => visibleRun('test.refused'), error => error === thrown, 'test-visible synchronous errors retain identity');
  f.binding.bus.run = () => Promise.reject(thrown);
  await assert.rejects(visibleRun('test.refused'), error => error === thrown, 'test-visible asynchronous errors retain identity');
 } finally { f.binding.bus.run = originalRun; }
 const browserSource = readFileSync(new URL('../motion3/qa-motion3-playback-browser.mjs', import.meta.url), 'utf8');
 const browserParsed = parseJavaScript('qa-motion3-playback-browser.mjs', browserSource);
 assert.deepEqual(browserParsed.errors, []);
 let evaluator;
 const findEvaluator = node => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id?.name === 'evaluate') evaluator = node.init;
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') {
   if (Array.isArray(value)) value.forEach(findEvaluator); else findEvaluator(value);
  }
 };
 findEvaluator(browserParsed.program);
 assert.ok(evaluator);
 const details = { targetId: 'actor-a', phase: 'commit' };
 const remote = { name: 'StudioProtocolError', code: 'STALE_TARGET', message: 'Original browser protocol error.', details };
 const evaluate = new Function('send', `return (${browserSource.slice(evaluator.start, evaluator.end)});`)(async (method, args) => {
  if (method === 'Runtime.evaluate') return { exceptionDetails: { exception: { objectId: 'error-1', description: remote.message } } };
  assert.equal(method, 'Runtime.callFunctionOn');
  assert.equal(args.objectId, 'error-1');
  const inspect = new Function(`return (${args.functionDeclaration});`)();
  return { result: { value: inspect.call(remote) } };
 });
 await assert.rejects(evaluate('original UI action'), error => {
  assert.equal(error.code, remote.code);
  assert.equal(error.message, remote.message);
  assert.deepEqual(error.details, details);
  return true;
 }, 'browser protocol error fields survive the CDP result boundary');
 const helperFailures = [];
 for (const path of ['../qa-effects-browser.mjs', '../motion3/qa-motion3-follow-browser.mjs',
  '../motion3/qa-motion3-kits-browser.mjs', '../qa-view-ghosts-browser.mjs', '../qa-cast-list-browser.mjs']) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const syntax = parseJavaScript(path, text);
  assert.deepEqual(syntax.errors, []);
  const scriptHelper = path.endsWith('/qa-cast-list-browser.mjs');
  let helper;
  const findHelper = node => {
   if (!node || typeof node !== 'object') return;
   if (node.type === 'VariableDeclarator' && node.id?.name === (scriptHelper ? 'action' : 'act')) helper = node.init;
   for (const [key, value] of Object.entries(node)) if (key !== 'parent') {
    if (Array.isArray(value)) value.forEach(findHelper); else findHelper(value);
   }
  };
  findHelper(syntax.program); assert.ok(helper, `${path} has its real action helper`);
  for (const mode of ['receipt', 'throw']) {
   const window = { __cozyclay: { runStudioAction: () => {
    if (mode === 'throw') throw new StudioProtocolError('STALE_TARGET', 'Injected thrown setup refusal.');
    return { ok: false, code: 'TARGET_NOT_READY', message: 'Injected setup refusal.', affectedIds: [] };
   } } };
   const actual = new Function('evaluate', `return (${text.slice(helper.start, helper.end)});`)(
    expression => new Function('window', `return (${expression});`)(window));
   const invoke = scriptHelper
    ? (id, args) => Promise.resolve().then(() => new Function('window', actual(id, args))(window))
    : actual;
   try {
    await assert.rejects(invoke(scriptHelper ? 'character.update' : 'stage.applyLighting',
     scriptHelper ? { characterId: 'cast-2', patch: { hidden: false } } : { preset: 'night' }), error =>
     error.message.includes(mode === 'throw' ? 'STALE_TARGET' : 'TARGET_NOT_READY') &&
     error.message.includes(mode === 'throw' ? 'Injected thrown setup refusal.' : 'Injected setup refusal.'));
    console.log(`PASS strict helper injected ${mode}: ${path}`);
   } catch (error) { helperFailures.push({ path, mode, error: error.message }); }
  }
 }
 assert.deepEqual(helperFailures, [], 'each real browser helper rejects receipt and thrown setup refusals with their code/message');
} finally { f.dispose(); }
console.log('PASS bus native adapters: deferred lifecycle, atomic undo and visible UI refusal results');
