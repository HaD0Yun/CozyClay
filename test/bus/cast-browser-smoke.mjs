// Manual browser gate: node test/bus/cast-browser-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createSceneDocument, SCENES_STORAGE_KEY, serializeSceneDocument } from '../../src/scenes.js';
import { characterRowId } from '../../src/hierarchy-model.js';

const fixture = createSceneDocument({ seedCharacter: true });
const rowId = characterRowId(fixture.scenes[0].stage.characters[0].id);
process.env.COZYCLAY_LIVE_PORT = '5742';
const server = await createServer({ server: { host: '127.0.0.1', port: 5222, strictPort: true, hmr: false } });
const profile = mkdtempSync(join(tmpdir(), 'cast-browser-'));
let chrome, ws, sequence = 0, sessionId;
const pending = new Map(), pageErrors = [];
function bounded(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${pageErrors.join('; ')}`)), ms); })]).finally(() => clearTimeout(timer));
}
const send = (method, params = {}, browser = false) => bounded(new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }));
}), method);
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
// Observe the actual React DOM transition before dispatching its action. No
// sleeps or polling: a missed transition is a bounded test failure.
async function transition(condition, action = '') {
  return evaluate(`new Promise((resolve,reject) => {
    let timer; const done = () => { observer.disconnect(); clearTimeout(timer); resolve(true); };
    const check = () => { if (${condition}) done(); };
    const observer = new MutationObserver(check);
    observer.observe(document, { childList:true, subtree:true, attributes:true, characterData:true });
    timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM transition deadline: ' + ${JSON.stringify(condition)})); }, 15000);
    ${action}; check();
  })`);
}
try {
  await server.listen();
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank',
    ...String(process.env.QA_CHROME_FLAGS || '').trim().split(/\s+/).filter(Boolean),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    chrome.once('error', reject); chrome.once('exit', code => reject(new Error(`Chrome exited ${code}`)));
  }), 'Chrome ready');
  ws = new WebSocket(endpoint);
  await bounded(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 'CDP connected');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const result = pending.get(message.id); if (!result) return;
    pending.delete(message.id);
    if (message.error) result.reject(new Error(JSON.stringify(message.error))); else result.resolve(message.result);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('cozyclay.locale', 'en');
    localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({name:'Cast QA',updatedAt:Date.now()}));
    localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(serializeSceneDocument(fixture))});
  ` });
  const loaded = bounded(new Promise(resolve => {
    const listener = event => { const message = JSON.parse(event.data); if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { ws.removeEventListener('message', listener); resolve(); } };
    ws.addEventListener('message', listener);
  }), 'Page load');
  await send('Page.navigate', { url: 'http://127.0.0.1:5222/app/' }); await loaded;
  await transition(`document.querySelector('[data-node-id="${rowId}"] .hierarchy-row')`);
  await transition(`document.querySelector('.subjects-row') && !document.querySelector('.subjects-row').closest('[hidden]')`, `document.querySelector('[data-node-id="${rowId}"] .hierarchy-row').click()`);
  const initial = await evaluate(`document.querySelectorAll('.subject-box').length`);
  await transition(`document.querySelectorAll('.subject-box').length === ${initial + 1}`, `document.querySelector('.add-subject').click()`);
  console.log('PASS browser cast UI: add subject publishes the owned cast');
  const undo = async condition => {
    const waiting = transition(condition, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
    await waiting;
  };
  await undo(`document.querySelectorAll('.subject-box').length === ${initial}`);
  console.log('PASS browser cast UI: keyboard undo restores the subject list');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/442-cast-browser.png', Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(pageErrors, []);
  console.log('PASS browser cast smoke: no runtime exceptions; screenshot /tmp/442-cast-browser.png');
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGTERM'); await bounded(exited, 'Chrome cleanup'); }
  await server.close(); rmSync(profile, { recursive: true, force: true });
}
