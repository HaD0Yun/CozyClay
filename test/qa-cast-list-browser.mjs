// Run through tools/qa-browser.mjs with an isolated QA_URL, CDP_PORT and QA_OUT.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SCENES_STORAGE_KEY } from '../src/scenes.js';

const url = process.env.QA_URL, out = process.env.QA_OUT;
assert.ok(url && out, 'QA_URL and QA_OUT are required');
const debuggerUrl = new URL(url);
debuggerUrl.port = process.env.CDP_PORT; debuggerUrl.pathname = '/json';
const targets = await (await fetch(debuggerUrl)).json();
const target = targets.find(entry => entry.type === 'page');
assert.ok(target, 'the owned browser has a page');
const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), events = new Map();
let sequence = 0;
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method) for (const listener of events.get(message.method) ?? []) listener(message.params);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP deadline: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  console.log(`ACTION evaluate ${expression.slice(0, 180)}`);
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const nextEvent = method => new Promise((resolve, reject) => {
  const listeners = events.get(method) ?? new Set(); events.set(method, listeners);
  const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Event deadline: ${method}`)); }, 30000);
  const listener = value => { clearTimeout(timer); listeners.delete(listener); resolve(value); };
  listeners.add(listener);
});
const navigate = async destination => {
  console.log(`ACTION navigate ${destination}`);
  const loaded = nextEvent('Page.loadEventFired');
  await send('Page.navigate', { url: destination }); await loaded;
};
const transition = (condition, action = '') => evaluate(`new Promise((resolve,reject) => {
  let timer; const cleanup = () => { observer.disconnect(); window.removeEventListener('cast-qa:state',check); clearTimeout(timer); };
  const finish = () => { cleanup(); resolve(true); };
  const check = () => { if (${condition}) finish(); };
  const observer = new MutationObserver(check);
  observer.observe(document, { childList:true, subtree:true, attributes:true, characterData:true });
  window.addEventListener('cast-qa:state',check);
  timer = setTimeout(() => { cleanup(); reject(new Error('State transition deadline: ' + ${JSON.stringify(condition)})); }, 30000);
  try { ${action}; check(); } catch(error) { cleanup(); reject(error); }
})`);
const report = [], errors = [];
events.set('Runtime.exceptionThrown', new Set([event => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text)]));
events.set('Log.entryAdded', new Set([event => { if (event.entry.level === 'error') console.log(`BROWSER ${event.entry.text}`); }]));
events.set('Runtime.consoleAPICalled', new Set([event => {
  if (event.type === 'error') console.log(`CONSOLE ${event.args.map(arg => arg.description ?? arg.value ?? '').join(' ').slice(0, 1500)}`);
}]));
const record = (name, measurement) => { report.push({ name, ...measurement }); console.log(`MEASURE ${name} ${JSON.stringify(measurement)}`); };
const capture = async name => {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${out}/${name}.png`, Buffer.from(image.data, 'base64'));
};
const seed = {
  version: 5, activeSceneId: 'cast-scene', scenes: [{
    id: 'cast-scene', name: 'Cast list QA', objects: [],
    stage: { characters: [-3, 0, 3].map((x, index) => ({ id: `cast-${index + 1}`, model: 'y-bot-tpose', subject: `Performer ${index + 1}`, x, z: 0, rot: 0 })), shotAspect: '16:9' },
    shotDocument: { version: 5, frameCount: 48, shots: [{ id: 'cast-shot', name: 'Third character', startFrame: 0, endFrame: 47,
      subjectIds: ['cast-3'], cameraKeys: [{ id: 'cast-key', frame: 0, framing: { pos: { x: -3, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 45 } }],
      camera: { mode: 'keys' } }], waypoints: [] },
  }],
};
const frame = ids => `if (!window.__cozyclay.runStudioAction('shot.frame', { subjectIds: ${JSON.stringify(ids)}, framing: { intent: { size:'wide shot',view:'front',level:'eye',side:'right',focalMm:35 } } })) throw new Error('shot.frame refused its ready cast')`;
const projection = id => evaluate(`(() => {
  const qa=window.__cozyclay, c=qa.characters.find(entry=>entry.id===${JSON.stringify(id)}), cam=qa.shotCam;
  cam.updateMatrixWorld(); const direction=cam.getWorldDirection(cam.position.clone());
  const point=cam.position.clone().set(c.x,0.9,c.z).project(cam);
  const aimX=cam.position.x + direction.x * (-cam.position.z/direction.z);
  return { camera:{x:cam.position.x,y:cam.position.y,z:cam.position.z}, aimX, screenX:point.x, screenY:point.y, screenZ:point.z };
})()`);

try {
  await mkdir(out, { recursive: true });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__castQaErrors=[];window.addEventListener('error',e=>window.__castQaErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__castQaErrors.push(String(e.reason?.stack??e.reason)));
    let qa;Object.defineProperty(window,'__cozyclay',{configurable:true,enumerable:true,get:()=>qa,set:value=>{qa=value;window.dispatchEvent(new Event('cast-qa:state'));}});
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(`${new URL(url).origin}/favicon.ico`);
  await evaluate(`localStorage.setItem('cozyclay.locale','en');localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'Cast list QA',updatedAt:Date.now()}));localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)},${JSON.stringify(JSON.stringify(seed))})`);
  await navigate(url);
  await transition(`window.__cozyclay?.characters?.length===3 && document.querySelector('[data-node-id="character:cast-3"]')`);
  await transition(`window.__cozyclay?.tlFrame===1 && !!window.__cozyclay.shotCam`, 'window.__cozyclay.scrub(1)');
  await transition(`window.__cozyclay?.tlFrame===0`, 'window.__cozyclay.scrub(0)');
  await transition(`window.__cozyclay.characters.every(entry=>!!window.__cozyclay.rigs[entry.id]?.parent)`);
  await capture('ready-desktop');
  await transition(`Math.abs(window.__cozyclay.shotCam.position.x-3)<0.001`, frame(['cast-3']));
  await capture('third-desktop');
  const third = await projection('cast-3');
  record('third-frame', third);
  assert.ok(Math.abs(third.aimX - 3) < 0.05);
  assert.ok(Math.abs(third.screenX) < 1 && Math.abs(third.screenY) < 1 && third.screenZ < 1);
  await transition(`Math.abs(window.__cozyclay.shotCam.position.x)<0.001`, frame(['cast-1','cast-2','cast-3']));
  await capture('group-desktop');
  const group = await Promise.all(['cast-1','cast-2','cast-3'].map(projection));
  record('group-frame', { members: group });
  for (const member of group) assert.ok(Math.abs(member.screenX) < 1 && Math.abs(member.screenY) < 1 && member.screenZ < 1);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('group-mobile');
  assert.deepEqual(errors, []);
  console.log('PASS cast-list browser contract: third and group framing');
} finally {
  record('final-state', await evaluate(`({url:location.href,ready:document.readyState,body:document.body.innerText.slice(0,1500),startupErrors:window.__castQaErrors,scripts:[...document.scripts].map(s=>s.src),cast:window.__cozyclay?.characters?.map(c=>c.id),camera:!!window.__cozyclay?.shotCam,rows:[...document.querySelectorAll('[data-node-id]')].map(n=>n.dataset.nodeId)})`));
  await capture('final');
  await writeFile(`${out}/measurements.json`, JSON.stringify({ report, errors }, null, 2));
  ws.close();
}
