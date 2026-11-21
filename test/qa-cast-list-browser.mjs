// Run through tools/qa-browser.mjs with an isolated QA_URL, CDP_PORT and QA_OUT.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SCENES_STORAGE_KEY } from '../src/scenes.js';
import { verifyCastIdentity } from './cast-identity-scenario.mjs';

const url = process.env.QA_URL, out = process.env.QA_OUT;
assert.ok(url && out, 'QA_URL and QA_OUT are required');
const readerCase = process.env.QA_CAST_READER ?? 'all';
const locale = process.env.QA_LOCALE ?? 'en';
assert.ok(['en', 'ko', 'zh'].includes(locale));
assert.ok(['all', 'basic', 'metrics', 'move', 'playback', 'preset', 'held', 'follow', 'prompt', 'caption', 'identity'].includes(readerCase));
const checkReader = name => readerCase === 'all' || readerCase === name;
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
const requests = new Map();
events.set('Network.requestWillBeSent', new Set([event => requests.set(event.requestId, event.request.url)]));
events.set('Network.loadingFailed', new Set([event => record('network-failure', { url: requests.get(event.requestId), error: event.errorText, canceled: event.canceled })]));
const capture = async name => {
  await evaluate(`(async()=>{const running=()=>document.getAnimations().filter(a=>a.playState==='running'&&a.effect.getComputedTiming().iterations!==Infinity);
    for(let pending=running();pending.length;pending=running())await Promise.all(pending.map(a=>a.finished.catch(error=>{if(error.name!=='AbortError')throw error;})));})()`);
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
const action = (name, args) => `(()=>{try {
  const r=window.__cozyclay.runStudioAction(${JSON.stringify(name)},${JSON.stringify(args)});
  if(r?.ok!==true)throw Object.assign(new Error(r?.message??'Action returned no receipt.'),{code:r?.code??'ACTION_REFUSED'});
}catch(error){throw new Error((error.code??'STUDIO_ACTION_FAILED')+': '+(error.message??String(error)));}})()`;
const frame = ids => action('shot.frame', { subjectIds: ids, framing: { intent: { size: 'wide shot', view: 'front', level: 'eye', side: 'right', focalMm: 35 } } });
const projection = id => evaluate(`(() => {
  const qa=window.__cozyclay, c=qa.characters.find(entry=>entry.id===${JSON.stringify(id)}), cam=qa.shotCam;
  cam.updateMatrixWorld(); const direction=cam.getWorldDirection(cam.position.clone()), parent=qa.rigs[c.id].parent;
  parent.updateWorldMatrix(true,false);const world=parent.getWorldPosition(cam.position.clone());
  const point=cam.position.clone().set(world.x,world.y+0.9,world.z).project(cam);
  const aimX=cam.position.x + direction.x * (-cam.position.z/direction.z);
  return { camera:{x:cam.position.x,y:cam.position.y,z:cam.position.z}, world:{x:world.x,y:world.y,z:world.z}, planar:Math.hypot(cam.position.x-world.x,cam.position.z-world.z), aimX, screenX:point.x, screenY:point.y, screenZ:point.z };
})()`);

try {
  await mkdir(out, { recursive: true });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__castQaErrors=[];window.addEventListener('error',e=>window.__castQaErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__castQaErrors.push(String(e.reason?.stack??e.reason)));
    let qa;Object.defineProperty(window,'__cozyclay',{configurable:true,enumerable:true,get:()=>qa,set:value=>{qa=value;window.dispatchEvent(new Event('cast-qa:state'));}});
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(`${new URL(url).origin}/favicon.ico`);
  await evaluate(`localStorage.setItem('cozyclay.locale',${JSON.stringify(locale)});localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'Cast list QA',updatedAt:Date.now()}));localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)},${JSON.stringify(JSON.stringify(seed))})`);
  await navigate(url);
  await transition(`window.__cozyclay?.characters?.length===3 && document.querySelector('[data-node-id="character:cast-3"]')`);
  await transition(`window.__cozyclay.characters.every(entry=>!!window.__cozyclay.rigs[entry.id]?.parent) && !!window.__cozyclay.shotCam`);
  await transition(`window.__cozyclay?.tlFrame===1 && !!window.__cozyclay.shotCam`, 'window.__cozyclay.scrub(1)');
  await transition(`window.__cozyclay?.tlFrame===0`, 'window.__cozyclay.scrub(0)');
  await capture('ready-desktop');
  await transition(`Math.abs(window.__cozyclay.shotCam.position.x-3)<0.001`, frame(['cast-3']));
  await capture('third-desktop');
  const third = await projection('cast-3');
  record('third-frame', third);
  assert.ok(Math.abs(third.aimX - 3) < 0.05);
  assert.ok(Math.abs(third.screenX) < 1 && Math.abs(third.screenY) < 1 && third.screenZ < 1);
  if (checkReader('metrics')) {
    const metrics = await evaluate('window.__cozyclay.shotMetrics');
    const expected = Math.hypot(third.camera.x - 3, third.camera.y - 1.3, third.camera.z);
    record('live-metrics', { distance: metrics.distance, expected });
    assert.ok(Math.abs(metrics.distance - expected) < 0.05, 'live framing measures the third shot subject');
  }
  await transition(`Math.abs(window.__cozyclay.shotCam.position.x)<0.001`, frame(['cast-1','cast-2','cast-3']));
  await capture('group-desktop');
  const group = await Promise.all(['cast-1','cast-2','cast-3'].map(projection));
  record('group-frame', { members: group });
  for (const member of group) assert.ok(Math.abs(member.screenX) < 1 && Math.abs(member.screenY) < 1 && member.screenZ < 1);
  if (checkReader('preset')) {
    await transition(`window.__cozyclay.characters.find(c=>c.id==='cast-2').hidden`, action('character.update', { characterId: 'cast-2', patch: { hidden: true } }));
    await evaluate(action('shot.frame', { preset: 'mocapInteraction' }));
    await capture('preset-hidden');
    const ids = await evaluate(`window.__cozyclay.sampleStateAt(0).shots.find(s=>s.id==='cast-shot').subjectIds`);
    record('preset-hidden', { ids }); assert.deepEqual(ids, ['cast-1', 'cast-2', 'cast-3']);
    for (const id of ['cast-1', 'cast-3']) { const p = await projection(id); assert.ok(Math.abs(p.screenX) < 1 && Math.abs(p.screenY) < 1); }
    await transition(`window.__cozyclay.characters.every(c=>!!window.__cozyclay.rigs[c.id]?.parent)`, action('character.update', { characterId: 'cast-2', patch: { hidden: false } }));
    await transition('Math.abs(window.__cozyclay.shotCam.position.x)<0.001', frame(['cast-1', 'cast-2', 'cast-3']));
  }
  if (checkReader('move')) {
    const keys = [4, 3].map((z, index) => ({ id: `reader-key-${index}`, frame: index * 47, framing: { pos: { x: 3, y: 1.6, z }, yaw: 0, pitch: 0, fovDeg: 40 } }));
    await transition('!!window.__cozyclay.moveMetrics', action('shot.set', { id: 'cast-shot', set: { subjectIds: ['cast-3'], cameraKeys: keys } }));
    const move = await evaluate('window.__cozyclay.moveMetrics');
    record('move-metrics', { fromDistance: move.fromShot.distance, expected: Math.hypot(4, 0.3) });
    assert.ok(Math.abs(move.fromShot.distance - Math.hypot(4, 0.3)) < 0.05, 'camera move classification uses the shot subject');
    await transition('Math.abs(window.__cozyclay.shotCam.position.x)<0.001', frame(['cast-1', 'cast-2', 'cast-3']));
  }
  if (checkReader('playback') || checkReader('follow')) {
    await transition(`window.__cozyclay.rigA===window.__cozyclay.rigs['cast-3']`, `document.querySelector('[data-node-id="character:cast-3"] .hierarchy-row').click()`);
    const sampled = await evaluate(`(() => { const s=window.__cozyclay.sampleStateAt(0);return {active:s.activeCharacterId,third:s.characters.find(c=>c.id==='cast-3').x};})()`);
    record('active-playback', sampled);
    assert.equal(sampled.active, 'cast-3'); assert.ok(Math.abs(sampled.third - 3) < 0.01, 'playback samples the active third member, not the first');
  }
  if (checkReader('held')) {
    const installed = await evaluate(`(async()=>{const qa=window.__cozyclay,done=[];for(const c of qa.characters){
      const r=await qa.runStudioAction('motion.compile',{characterId:c.id,install:true,spec:{schema:'cozyclay.motion-spec.v1',fps:24,frames:8,use:[{skill:'standIdle',f0:0,args:{at:[c.x,c.z],heading:c.rot,until:7}}]}});
      if(!r?.ok)throw new Error('Idle take refused for '+c.id);done.push(c.id);}return done;})()`);
    assert.equal(installed.length, 3);
    const held = await evaluate(`(async()=>{const r=await window.__cozyclay.runStudioAction('shot.frame',{subjectIds:['cast-1','cast-2','cast-3'],over:'shot',framing:{intent:{size:'wide shot',view:'front',level:'eye',side:'left',focalMm:35}}});if(!r?.ok)throw new Error('Group held framing refused');return r.checks;})()`);
    record('held-group', held); assert.ok(held.held.frames.length > 0);
    assert.deepEqual(held.held.outOfFrame, []); assert.deepEqual(held.held.hidden, []);
    await capture('held-group');
    for (const id of installed) { const p = await projection(id); assert.ok(Math.abs(p.screenX) < 1 && Math.abs(p.screenY) < 1); }
    assert.equal(await evaluate(`window.__cozyclay.shotCameraKeyCount('cast-shot')`), 1);
  }
  if (checkReader('follow')) {
    const carrier = await evaluate(`(() => {const qa=window.__cozyclay,id=qa.sceneObject.place({kind:'cube',name:'Carrier',x:0,y:-1,z:0}).id;
      const r=qa.sceneObject.update({id,path:{points:[{x:0,y:-1,z:0},{x:6,y:-1,z:0}],faceTravel:false}});if(!r.ok)throw new Error('Carrier route refused');return id;})()`);
    await transition(`document.querySelector('[data-node-id="object:${carrier}"]')||document.querySelector('[data-node-id="props"] .hierarchy-toggle')`);
    await transition(`!!document.querySelector('[data-node-id="object:${carrier}"]')`, `if(!document.querySelector('[data-node-id="object:${carrier}"]'))document.querySelector('[data-node-id="props"] .hierarchy-toggle').click()`);
    await transition(`window.__cozyclay.characters.find(c=>c.id==='cast-3').parent===${JSON.stringify(carrier)}`, `(() => {
      const source=document.querySelector('[data-node-id="character:cast-3"]'),target=document.querySelector('[data-node-id="object:${carrier}"]'),dataTransfer=new DataTransfer();
      for(const [node,type]of [[source,'dragstart'],[target,'dragenter'],[target,'dragover'],[target,'drop'],[source,'dragend']])node.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer}));})()`);
    await evaluate(action('shot.set', { id: 'cast-shot', set: { subjectIds: ['cast-3'] } }));
    await transition(`Math.abs(window.__cozyclay.shotCam.position.x-3)<0.01&&Math.abs(window.__cozyclay.shotCam.position.z+3)<0.01`, action('shot.setCameraMode', { shotId: 'cast-shot', mode: 'follow' }));
    for (const frameNumber of [0, 24, 47]) {
      await transition(`window.__cozyclay.tlFrame===${frameNumber}`, `window.__cozyclay.scrub(${frameNumber})`);
      const range = frameNumber === 0 ? 'Math.abs(x-3)<0.01' : frameNumber === 47 ? 'Math.abs(x-9)<0.01' : 'x>3.1&&x<8.9';
      await transition(`(() => {const p=window.__cozyclay.rigs['cast-3'].parent,x=p.getWorldPosition(p.position.clone()).x;return ${range};})()`);
      await capture(`follow-${frameNumber}`);
      const measured = await projection('cast-3');
      const state = await evaluate(`window.__cozyclay.sampleStateAt(${frameNumber}).characters.find(c=>c.id==='cast-3').x`);
      record(`follow-${frameNumber}`, { ...measured, sampledX: state });
      assert.ok(Math.abs(measured.planar - 3) < 0.05, 'the camera holds its third member through real playback');
      assert.ok(Math.abs(state - measured.world.x) < 0.05, 'the sampled active layer and its carried body agree');
    }
    await transition(`Math.abs(Math.hypot(window.__cozyclay.shotCam.position.x-4.5,window.__cozyclay.shotCam.position.z)-3)<0.05`, action('shot.set', { id: 'cast-shot', set: { subjectIds: ['cast-2', 'cast-3'] } }));
    const grouped = await projection('cast-3'), center = grouped.world.x / 2;
    record('follow-group', { camera: grouped.camera, center });
    assert.ok(Math.abs(Math.hypot(grouped.camera.x - center, grouped.camera.z) - 3) < 0.05);
  }
  if (checkReader('prompt')) {
    await evaluate(action('shot.setCameraMode', { shotId: 'cast-shot', mode: 'keys' }));
    await transition('window.__cozyclay.tlFrame===0', 'window.__cozyclay.scrub(0)');
    await evaluate(`(async()=>{const r=await window.__cozyclay.runStudioAction('ai.prepareShot',{mode:'video'});if(!r?.ok)throw new Error('Video prompt preparation refused');})()`);
    await transition(`!!document.querySelector('.result-modal .promptbox')`);
    record('prompt-preview', { text: await evaluate(`document.querySelector('.result-modal .promptbox').textContent`) });
    assert.equal(await evaluate(`document.querySelectorAll('.result-modal img.preview').length`), 1);
    await capture('prompt-preview');
    await transition(`!document.querySelector('.result-modal')`, `document.querySelector('.result-modal button.x').click()`);
  }
  if (checkReader('caption')) {
    await evaluate(action('shot.setCameraMode', { shotId: 'cast-shot', mode: 'keys' }));
    await transition('window.__cozyclay.shotCam.position.z>5', frame(['cast-1', 'cast-2', 'cast-3']));
    await evaluate(action('shot.set', { id: 'cast-shot', set: { subjectIds: ['cast-3'] } }));
    await transition('window.__cozyclay.lookThroughShot', 'window.__cozyclay.setLookThrough(true)');
    await transition(`document.querySelector('.caption')&&!document.querySelector('.caption').hidden&&!document.querySelector('.caption').classList.contains('off')`);
    await transition(`document.querySelector('.caption').classList.contains('off')`, action('character.update', { characterId: 'cast-3', patch: { x: 40 } }));
    await capture('third-out-of-frame');
    const outside = await projection('cast-3'); record('third-out-of-frame', outside);
    assert.ok(Math.abs(outside.screenX) > 1, 'the named third member is actually outside the image');
    const notice = await evaluate(`(()=>{const e=document.querySelector('.caption'),s=getComputedStyle(e),r=e.getBoundingClientRect(),p=window.__cozyclay.mainPane.getBoundingClientRect();return {shown:!e.hidden&&s.display!=='none'&&s.visibility!=='hidden',opacity:Number(s.opacity),width:r.width,height:r.height,x:r.x,y:r.y,text:e.textContent,pane:{x:p.x,y:p.y,right:p.right,bottom:p.bottom}};})()`);
    record('caption-visible', notice);
    assert.ok(notice.shown && notice.opacity > 0.95 && notice.width > 0 && notice.height > 0, 'the out-of-frame warning must actually be visible');
    assert.ok(notice.x >= notice.pane.x && notice.y >= notice.pane.y && notice.x + notice.width <= notice.pane.right && notice.y + notice.height <= notice.pane.bottom, 'the warning must be inside the actual viewport, not behind the timeline');
  }
  if (checkReader('identity')) await verifyCastIdentity({ evaluate, transition, capture, record, send, events });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('group-mobile');
  assert.deepEqual(errors, []);
  console.log(`PASS cast-list browser contract: ${readerCase}`);
} finally {
  record('final-state', await evaluate(`({url:location.href,ready:document.readyState,body:document.body.innerText.slice(0,1500),startupErrors:window.__castQaErrors,scripts:[...document.scripts].map(s=>s.src),cast:window.__cozyclay?.characters?.map(c=>c.id),camera:!!window.__cozyclay?.shotCam,rows:[...document.querySelectorAll('[data-node-id]')].map(n=>n.dataset.nodeId)})`));
  await capture('final');
  await writeFile(`${out}/measurements.json`, JSON.stringify({ report, errors }, null, 2));
  ws.close();
}
