#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as protocol from '../src/studio-agent-protocol.js';
import * as context from '../src/studio-agent-context.js';
import * as commands from '../src/studio-agent-commands.js';
import * as studioMotion from '../src/studio-agent-motion.js';
import { createSceneHistoryStore } from '../src/document-store.js';
import { createObjectsDomain, createMotionDomain, mountHistoryCast } from './bus/history-owners.mjs';
import { createStageDomain } from '../src/domains/stage.js';
import { createCharacterEntry, createCharacterLayer, addScene, duplicateScene, renameScene, removeScene, isProxyFigure } from '../src/scenes.js';
import * as characterKind from '../src/character-kind.js';
import { judgeNextWaypoint } from '../src/motion/waypoints.js';
import { createStableItemId, removeStableItem, updateStableItem } from '../src/stable-items.js';
import { createCameraBlock, removeCameraRail, updateCameraBlock } from '../src/camera-block.js';
import { railFollowForNewGeometry } from '../src/camera-rail-schedule.js';
import * as objects from '../src/scene-objects.js';
import * as ik from '../src/motion/ik.js';
import { copyPhysicsKeys, physicsKeyStamp } from '../src/motion/physics-review.js';
import * as playback from '../src/motion3/playback.js';
import * as rigSnapshot from '../src/motion/rig-snapshot.js';
import { compileTakeSource } from '../src/domains/motion/take-source.js';
import { skeletonFor } from '../src/motion3/rigs/index.js';
import { primeBindPose, normalizeBoneName } from '../src/poses.js';
import { sampleAt } from '../src/sample-at.js';
import { createShot, shotAtFrame, addShotAtFrame } from '../src/cuts.js';
import { placementAt } from '../src/root-path.js';
import * as studioActions from '../src/studio-actions.js';
import { createCommandBus, withCommandHistory } from '../src/command-bus.js';
import { createStudioAppBinding } from '../src/studio-app-binding.js';
import { createAppContext } from '../src/app-context.js';
import { mountShots } from './bus/shots-hook.mjs';
import { createStudioAppActions, commandDeclarations } from '../src/commands/index.js';
import { HISTORY_LIMIT } from '../src/history.js';
import { focalMmToFov, fovToFocalMm, IMAGE_MODELS, CUSTOM_MOVE, SUBJECT_HEIGHT_M, composePrompt, deriveShot } from '../src/shot.js';
import { PART_COLOURS } from '../src/part-colours.js';
import { objectTransformAt } from '../src/object-path.js';
import { dispatchLiveFrame } from '../src/live-control.js';
import { studioBusy } from '../src/studio-busy.js';

const cases = ['previs-mode-and-character-kind', 'verify-plan-and-geometry', 'inspect-entity-transforms', 'targeted-commit-and-undo', 'stale-target-and-epoch', 'mid-gesture-target', 'lost-acknowledgement', 'camera-undo', 'still-frame-shot-camera-key', 'clip-frame-shot-camera-key', 'rail-camera-undo', 'rail-camera-undo-after-object-undo', 'context-revisions', 'recreated-motion-read-and-verify', 'stale-receipt-undo', 'reverted-edit-invalidates-target', 'patch-character-tint-and-undo', 'patch-stage-key-light-and-undo', 'patch-partial-drop', 'patch-inside-agent-turn', 'patch-during-gesture', 'patch-shot-and-prompt-blocks', 'patch-stage-environment-text-and-undo', 'run-action-shot-create-and-undo', 'run-action-object-duplicate-and-undo', 'run-action-refusals', 'run-action-character-waypoints-and-undo', 'run-action-character-ik-keys-and-undo', 'run-action-object-attach-and-undo', 'ui-refusals-localized-or-silent', 'run-action-shot-camera-rail-and-undo', 'run-action-shot-camera-rail-aim-lens-and-key-stops', 'run-action-view-toggles', 'context-entity-index', 'context-assets', 'inspect-scopes', 'cursor-survives-edit', 'verify-stale-receipt', 'verify-result-targets', 'late-apply-inspect-patch', 'arrange-with-attached-prop', 'arrange-local-space', 'run-action-export-shot-video', 'run-action-scenes', 'run-action-project-save', 'run-action-asset-import-and-undo', 'run-action-ai-prepare-shot'];
const argv = process.argv.slice(2);
assert(!argv.length || (argv.length === 2 && argv[0] === '--case' && cases.includes(argv[1])), 'Unknown test arguments');
import { readStudioSource } from './bus/verify-domain-modules.mjs';
const app = readStudioSource();
const parsed = parseSync('App.jsx', app);
assert.deepEqual(parsed.errors, []);
const declarations = new Map();
function visit(value) {
 if (!value || typeof value !== 'object') return;
 if (value.type === 'FunctionDeclaration') declarations.set(value.id.name, app.slice(value.start, value.end));
 for (const [key, child] of Object.entries(value)) if (key !== 'parent') Array.isArray(child) ? child.forEach(visit) : visit(child);
}
visit(parsed.program);
const ref = current => ({ current });
// The carried-prop maths App.jsx imports from app-stage.jsx (a React module
// Node cannot load), evaluated from its own source.
const carried = (() => {
 const source = readFileSync(new URL('../src/stage-attach-frames.js', import.meta.url), 'utf8');
 const start = source.indexOf('export const ATTACH_BONE_ROWS'), end = source.length;
 assert(start > 0 && end > start, 'app-stage.jsx attachment block');
 return new Function('THREE', 'SCENE_ATTACH_BONES', 'normalizeBoneName', `${source.slice(start, end).replace(/^export /gm, '')}\nreturn { attachFrameMatrix, sceneObjectMatrix, attachPlacementPatch, placeSceneObject, attachWorldMatrix };`)(THREE, objects.SCENE_ATTACH_BONES, normalizeBoneName);
})();
function bounded(promise) {
 let timer;
 return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('binding event deadline')), 10000); })]).finally(() => clearTimeout(timer));
}
const aimAt = (p,t) => ({ yaw: Math.atan2(-(t.x-p.x), -(t.z-p.z)), pitch: Math.atan2(t.y-p.y, Math.hypot(t.x-p.x,t.z-p.z)) });
const forwardFrom = (yaw,pitch) => new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
// A 48-frame compiled take v3 (standing Y Bot) for the active character.
function clip() {
 const sk=skeletonFor('y-bot-tpose'),I=sk.index,P=sk.restWorldPos,ank=P[I.LeftFoot][1];
 const spec={schema:'cozyclay.motion-spec.v1',fps:24,frames:48,keys:[{f:0,set:{root:[0,P[I.Hips][1]-0.01,0],yaw:0,foot_l:[0.09,ank,-0.03],foot_r:[-0.09,ank,0.03]}}]};
 return compileTakeSource({schema:'cozyclay.take.v3',rig:'y-bot-tpose',spec,placement:{position:[0,0,0],yaw:0},scene:{objects:{}}});
}
const bytes = readFileSync(new URL('../public/models/y-bot-tpose.fbx', import.meta.url));
function rig() { const r=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');r.scale.setScalar(.01);primeBindPose(r);const parent=new THREE.Group();parent.add(r);parent.updateMatrixWorld(true);return r; }
// options.characters stands in for the cast a reloaded page reads back from its
// saved scene; options.motionStore is the IndexedDB motion store, which outlives
// the page.
function fixture(options={}) {
 const a=createCharacterEntry({id:'actor-a',model:'y-bot-tpose',x:0,z:0}), b=createCharacterEntry({id:'actor-b',model:'y-bot-tpose',x:4,z:0});
 const chars=options.characters??[a,b], rigs={'actor-a':rig(),'actor-b':rig()}; rigs['actor-b'].parent.position.x=4;rigs['actor-b'].parent.updateMatrixWorld(true);
 const actionsRef=ref(null);
 const revision=ref(0), clock=ref(0), lastObject=ref(0), history=ref({past:[],future:[]}), studioHistory=ref(new Map()), characterRef=ref(chars), buffer=ref({waypoints:[],motion:null}), state=ref(ik.createIkState()), layers=ref(new Map());
 const stage={shotAspect:'16:9',cameraPresetId:null,sensorId:'fullFrame',hasCharSheet:false,environmentImage:null,environment:'a sunlit modern living room',style:'moody cinematic lighting, 35mm film look',hasEnvSheet:false,keyLight:{x:6,y:9,z:4,intensity:1.12,warmth:0.5,color:null},
  lighting:{preset:'studio',sky:null,skyTop:null,ambient:1,hemiSky:'#ffffff',hemiGround:'#5a5d64',fill:1,fog:0,exposure:1,shadowSoftness:0,envLight:0,ao:0,hdr:null,hdrRotation:0,hdrIntensity:1,hdrBackground:true}};
 const live=ref({characters:chars,objects:[],rigs,shots:[],scenes:[{id:'scene',name:'Fixture',objects:[],shotDocument:null,stage:null}],activeCharacterId:a.id,stage,timeline:{currentFrame:0,frameCount:48},filmback:{sensorId:'fullFrame',aspectRatio:16/9},studioSelection:{kind:'character',id:a.id},studioShotId:null,studioView:{mode:'scene',frame:0,playing:false,lookThrough:false,grid:false,autoColor:false}});
 const camera=new THREE.PerspectiveCamera(45,16/9); camera.position.set(0,1.6,5);
 const values={}, semantic=[], motionStore=options.motionStore??new Map(), motionSet=[];
 let urlLoader=async url=>{throw new Error(`bridge does not serve ${url}`);};
 let currentBinding;
 const markSemanticEdit=(domain,before,after)=>{if(before!==after)revision.current++;currentBinding?.invalidate?.(domain,before,after);semantic.push(domain);if(domain==='characters'&&Array.isArray(after)){characterRef.current=after;live.current.characters=after;}if(domain==='shots')live.current.shots=after;};
 // A value owner: set publishes, edit publishes and marks the semantic edit against the value it replaced.
 const owner=(initial,publish,domain)=>{let current=initial;const apply=(update,authored)=>{const before=current;current=typeof update==='function'?update(before):update;publish(current);if(authored)markSemanticEdit(domain,before,current);return current;};return {set:update=>apply(update,false),edit:update=>apply(update,true)};};
 const castOwner=owner(chars,v=>{values.characters=v;},'characters');
 const shotsOwner=owner([],v=>{values.shots=v;},'shots');
 const suppressObjectClock=ref(false);
 const store=ref(withCommandHistory(createSceneHistoryStore([], {onObjects(next){if(!suppressObjectClock.current)lastObject.current=++clock.current;values.objects=next;},onCommit(before,after){markSemanticEdit('objects',before,after);}})));
 const noPublish = name => value => {values[name]=typeof value==='function'?value(values[name]??0):value;};
 // The shot the Send-to-AI package describes: two camera keys (A and B) on the
 // shot under the playhead, and the render's reference-frame capture.
 const keyA={pos:{x:0,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40},keyB={pos:{x:0.5,y:1.6,z:3},yaw:0,pitch:0,fovDeg:40};
 const heroShot=createShot('Hero',0,23,[{frame:0,framing:keyA},{frame:23,framing:keyB}]);
 const filmback={sensorId:'fullFrame',aspectRatio:16/9},fromShot=deriveShot(keyA.pos,{x:0,z:0,rot:0},40*Math.PI/180,SUBJECT_HEIGHT_M,filmback);
 const captures=[],clipboard=[];
 const aiScope={IMAGE_MODELS,CUSTOM_MOVE,SUBJECT_HEIGHT_M,composePrompt,deriveShot,PART_COLOURS,filmback,shot:fromShot,
  activeShot:heroShot,activeCamera:{mode:'keys',followCam:null,cameraRail:null,railFollow:null},cameraKeys:heroShot.cameraKeys,
  moveSequence:{fromShot,phrase:'a slow push-in toward the subject'},followTrack:null,subjectTrack:null,fovDeg:40,charA:{x:0,z:0,rot:0},
  subject:'a woman in a red coat',showB:false,subject2:null,poseA:{prompt:'arms crossed'},poseB:null,environment:stage.environment,style:stage.style,
  cameraMove:'Static / locked-off',customMove:'',hasCharSheet:false,hasEnvSheet:false,partColoursEnabled:false,shotOutput:{label:'16:9',width:1920,height:1080},characters:chars,
  captureFramingPng:framing=>{captures.push(framing);return `data:image/png;base64,${btoa(JSON.stringify(framing.pos))}`;},captureRef:ref(null),bufferToPng:()=>null,
  navigator:{clipboard:{writeText:async text=>{clipboard.push(text);}}}};
 const scope={THREE,cloneSkeleton,createCommandBus,studioBusy,HISTORY_LIMIT,...characterKind,isProxyFigure,placementAt,...protocol,...context,...commands,...objects,...ik,...playback,...rigSnapshot,verifyInstalledTake:studioMotion.verifyInstalledTake,copyPhysicsKeys,physicsKeyStamp,sampleAt,shotAtFrame,focalMmToFov,fovToFocalMm,objectTransformAt,aimAt,forwardFrom,
 liveStateRef:live,sceneRevisionRef:revision,charactersRef:characterRef,loadedLayerCharRef:ref(a.id),bufferRef:buffer,ikStateRef:state,ikStatesRef:layers,storeRef:store,
 charHistoryRef:history,opClockRef:clock,lastObjectOpRef:lastObject,studioHistoryRef:studioHistory,studioActionGroupRef:ref(null),motionFullRef:ref(new Map()),
 store:store.current,suppressObjectClockRef:suppressObjectClock,studioBindingRef:ref(null),objectDeleteUndo:null,selectedSceneObjectId:null,
 liveWorkspaceIdRef:ref('workspace'),liveWorkspaceHandleRef:ref('handle'),studioDocumentEpochRef:ref('document'),activeSceneIdRef:ref('scene'),studioSceneEpochRef:ref('epoch'),
 look:ref({yaw:0,pitch:0}),shotCamRef:ref(camera),shotCameraPosRef:ref(null),manualCameraOverrideRef:ref(false),frameCountRef:ref(48),tlFrameRef:ref(0),
 physicsOptions:{protectedFrames:[]},bridge:{ok:false},ikBodyDragRef:ref(false),lineDragRef:ref(null),lineDrawRef:ref(null),linePinDragRef:ref(null),autoPhysicsRunRef:ref(null),recRef:ref(null),restoreRef:ref(null),
 committedIkEdits:[],IK_CORRECTION_BLEND_FRAMES:6,tlFps:24,MAX_WAYPOINTS:32,WALK_SPEED_MPS:1.4,clampRootPosition:v=>Math.max(-11,Math.min(11,v)),judgeNextWaypoint,createStableItemId,removeStableItem,createCharacterLayer,gestureUndoRef:ref(null),updateStableItem,createCameraBlock,removeCameraRail,updateCameraBlock,railFollowForNewGeometry,framingSessionRef:ref(null),stageRef:ref(null),
 ...carried,animatedSceneObjects:[],attachFrameRef:ref((characterId,bone,out)=>carried.attachFrameMatrix(rigs[characterId]??null,bone,out)),
 // Stands in for the mounted prop groups: where each prop is drawn right now.
 propWorldRef:ref((id,out)=>{const o=store.current.objects.find(row=>row.id===id);if(!o)return null;const local=carried.sceneObjectMatrix(o,new THREE.Matrix4());if(!o.attach)return out.copy(local);const frame=carried.attachFrameMatrix(rigs[o.attach.characterId]??null,o.attach.bone??null,new THREE.Matrix4());return frame?out.copy(frame.multiply(local)):null;}),snapshotCast:()=>({}),markSemanticEdit,setCharacters:castOwner.set,editCharacters:castOwner.edit,setShots:shotsOwner.set,editShots:shotsOwner.edit,
 ...studioActions,addShotAtFrame,shots:[],tlFrame:0,tlFrameCount:48,captureCurrentFraming:()=>({pos:{x:0,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40}),trackFeature:()=>{},window:{dispatchEvent:()=>true},
 ko:options.korean?(en,kr)=>kr:en=>en,isKo:Boolean(options.korean),studioActionsRef:actionsRef,TIMELINE_FPS:24,
 // The scene document: App's own scene handlers over the real scenes.js
 // edits; persistence is a no-op and openScene stands in for the React room swap.
 scenesRef:ref(live.current.scenes),addScene,duplicateScene,renameScene,removeScene,track:()=>{},persistScenes:()=>{},snapshotActiveScene:()=>scope.scenesRef.current,
 openMotionDb:async()=>({close(){}}),getMotion:async(db,id)=>motionStore.get(id.toLowerCase())??null,
 putMotion:async(db,record)=>{motionStore.set(record.motionId.toLowerCase(),record);return record;}};
 for(const name of ['setTlFps','setProjectManifest','setCameraPos','setFovDeg','setCameraPresetId','setWaypoints','setMotion','setCommittedIkEdits','setIkTick','setTlFrameCount','setToast','setActiveCharacterId','setSelectedHierarchyId','setTlFrame','setWorkflowMode','setLookThroughShot','setGridView','setAutoColor','setTlPlaying','setIkMode','setIkFocus','setKeyLight','setEnvironmentImage','setEnvironment','setStyle','setHasEnvSheet','setShotAspectKey','setSensorFormat','setMovePlaying','setPartColoursEnabled','setPartColoursMode','setGuideMode','setWorkspaceLayout','setInsetPos','setResult','setResultOpen','setCopied','setRecordedVideoName'])scope[name]=noPublish(name);
 scope.setToast=value=>{values.setToast=studioActions.resolveStudioToast(value,Boolean(options.korean),scope.ko).uiMessage;};
 // App's render-time choice for the Send-to-AI package (its mode/imageModel state).
 Object.assign(scope,aiScope,{mode:'image',imageModel:'gpt_image_2'});
 scope.setMotion=value=>{noPublish('setMotion')(value);for(const done of motionSet.splice(0))done(value);};
 scope.setScenes=noPublish('setScenes');
 scope.openScene=(scene,nextScenes)=>{scope.scenesRef.current=nextScenes;live.current.scenes=nextScenes;scope.activeSceneIdRef.current=scene.id;scope.studioSceneEpochRef.current=crypto.randomUUID();};
 const names=['beginStudioObjectAction','stepObjectHistory','publishStudioShots','commitStudioShots','finishStudioHistoryGesture',"canUndoStudioReceipt",'readStudioCamera','readStudioState','publishStudioCamera','publishStudioStage','snapshotStudioDomain','publishStudioCharacters','syncStudioLayerBuffer','stepStudioHistory','undoScene','redoScene','commitStudioDraft','studioBounds','operateStudio','snapshotExportRig','restoreExportRig','poseMemberAtFrame','leaveIkMode','sceneObjectWorldMatrix','recordStudioAction','beginStudioAction','publishStudioDomain','isStudioHistoryRetained','addTimelineShot','runStudioAction',
  'choosePartColours','setInsetCollapsed','expandInset','setShotCameraRail','clearShotCameraRail','changeActiveCamera','framingSessionOpen','attachSceneObject','setCharacterIkKey','removeCharacterIkKey','clearCharacterIkKeys','ikStateFor','editCharacterIkKeys','snapshotIkKeys',
  'validateWaypointAt','castMemberOf','readCharacterWaypoints','writeCharacterWaypoints','addCharacterWaypoint','moveCharacterWaypoint','removeCharacterWaypoint','clearCharacterWaypoints',
  'switchSceneDocument','addSceneDocument','duplicateSceneDocument','renameSceneDocument','deleteSceneDocument',
  'selectSceneDocument','createSceneDocumentFromUi','duplicateSceneDocumentFromUi','renameSceneDocumentFromUi','deleteSceneDocumentFromUi',
  'generate','copyPrompt'];
 // The extracted App functions now reach these same fixture-owned cells through the facade.
 scope.appContext=createAppContext({characters:characterRef,state:live,scenes:scope.scenesRef,getBus:()=>scope.studioBindingRef.current.bus,notify:(...args)=>scope.setToast(...args)}).forRender(scope);
 scope.stageDomain=scope;
 scope.scenesDomain=scope;
 scope.previsMode=options.previsMode;
 scope.shotsDomain=scope;
 scope.castDomain=scope;
 scope.motionDomain=scope;
 scope.objectsDomain=scope;
 const code=names.map(n=>{assert(declarations.has(n),`actual App function ${n}`);return declarations.get(n);}).join('\n');
 const actual=new Function(...Object.keys(scope),code+`\nreturn {${names.join(',')}};`)(...Object.values(scope));
 Object.assign(scope,actual);
 // React re-renders App with the state it committed: these functions close
 // over render-time state, so every commit is a fresh evaluation of them.
 const renderNames=['generate','copyPrompt'];
 const renderState={mode:scope.mode,imageModel:scope.imageModel},committed={...renderState};
 const renderApp=()=>{const s={...scope,...committed,runStudioAction:actual.runStudioAction};s.appContext=scope.appContext.forRender(s);return new Function(...Object.keys(s),renderNames.map(n=>declarations.get(n)).join('\n')+`\nreturn {${renderNames.join(',')}};`)(...Object.values(s));};
 let rendered=renderApp();
 let binding; const stamps=new Map();
 // The editor's own handlers stand behind the registry. Shot creation is the
 // real App handler; object duplication is a stand-in with the same store write.
 const unwired = name => () => { throw new Error(`${name} is not wired in this fixture`); };
 // Stand-ins for the editor's renderer-bound project work (the export
 // pipeline): each records what it was asked and answers what `stand` says.
 const stand={exporting:false,exportResult:{fileName:'cozyclay-hero.mp4',frameCount:24},exports:[],renders:0,
  project:{name:'Heist',hasFile:true,fileAccess:true,gesture:false},granted:true,saveOutcome:{saved:true,name:'Heist',fileName:'Heist.cclayproject'},saves:[],
  imports:[],fetched:[],importError:null,staleCommits:0,captures,clipboard,
  captureError:null,falSubmits:[],falSubmitError:null,ingested:[],ingestResult:{frames:120,fps:24,duration:5},waypointMode:false,
  // The editor's prompt-block run: how many blocks it has, and the toasts it
  // shows when it does not start the generation.
  promptBlockCount:0,generationRuns:0,generationToasts:[],
  falFinished:{job:{id:'fal-job-1',status:'done',video:{url:'https://cdn.example.test/fal-act.mp4'},resolution:'480P',width:832,height:480,fps:24,duration:5,resultDuration:5,cost:0.1},dailyRemaining:2}};
 const actionHandlers=ref({
  state:()=>({shots:live.current.shots,objects:store.current.objects,characters:characterRef.current,frame:0,frameCount:48,selectedObjectId:null,activeCharacterId:'actor-a',promptBlockCount:stand.promptBlockCount,generating:false,motionReady:true,
   exporting:stand.exporting,canExportVideo:live.current.shots.length>0,
   scenes:scope.scenesRef.current.map(({id,name})=>({id,name})),activeSceneId:scope.activeSceneIdRef.current,project:{...stand.project},
   aiShot:{mode:committed.mode,imageModel:committed.imageModel}}),
  setAiShotMode:value=>{renderState.mode=value;},setAiImageModel:value=>{renderState.imageModel=value;},generate:()=>rendered.generate(),
  saveProject:async saveAs=>{stand.saves.push(saveAs);return stand.saveOutcome;},
  projectFileGranted:async()=>stand.granted,
  // The live import_asset path: bytes stored, then ONE atomic store entry.
  importAsset:async (args,context)=>{stand.imports.push(args);if(stand.importError)throw new Error(stand.importError);const object=objects.createCutoutObject({assetId:'img-0a1b2c',aspect:1,height:1.8,name:args.name},store.current.objects,{x:1,z:2});context.commit(()=>store.current.applyAtomic(list=>[...list,object]));return {assetId:'img-0a1b2c',objectId:object.id};},
  fetchImportSource:async url=>{stand.fetched.push(url);if(url.includes('missing'))throw new Error('HTTP 404');return 'data:model/gltf-binary;base64,Z2xURg==';},
  exportShotVideo:async options=>{stand.exports.push(options);return stand.exportResult;},
  // The editor answers a scene change once React has rendered the new room.
  // A commit already under way when the action set its state (staleCommits)
  // releases the waiters before that state is rendered.
  afterRender:()=>{stand.renders++;if(stand.staleCommits>0)stand.staleCommits--;else{Object.assign(committed,renderState);rendered=renderApp();}return Promise.resolve();},
  ...Object.fromEntries(['switchSceneDocument','addSceneDocument','duplicateSceneDocument','renameSceneDocument','deleteSceneDocument'].map(name=>[name,(...args)=>actual[name](...args)])),
  addTimelineShot:()=>actual.addTimelineShot(),
  ...Object.fromEntries(['addCharacterWaypoint','moveCharacterWaypoint','removeCharacterWaypoint','clearCharacterWaypoints','setCharacterIkKey','removeCharacterIkKey','clearCharacterIkKeys','attachSceneObject','setShotCameraRail','clearShotCameraRail','choosePartColours','setInsetCollapsed'].map(name=>[name,actual[name]])),
  setGuideMode:mode=>scope.setGuideMode(mode),
  readView:actual.readStudioState,publishView:actual.operateStudio,
  setWaypointMode:value=>{stand.waypointMode=value;},
  duplicateSelectedSceneObject:id=>{const source=store.current.objects.find(o=>o.id===id);store.current.applyAtomic(list=>[...list,{...source,id:'copy-1',name:'Copy',x:source.x+0.5}]);},
  ...Object.fromEntries(['splitTimelineShot','duplicateTimelineShot','removeTimelineShot','setTimelineShotRange','moveTimelineShot'].map(name=>[name,unwired(name)])),
  runAllPromptBlocks:()=>{stand.generationRuns++;return [...stand.generationToasts];},
 });
 // Shots now exercise the registered owner, not the removed native history.
 scope.appContext.updatePorts({ revision, read: actual.readStudioState, bounds: actual.studioBounds });
 scope.startupScene={shotDocument:{version:4,shots:[],frameCount:48,waypoints:[]}};
 scope.markCraftAction=()=>{};
 const shotDomain=mountShots(scope.appContext);
 scope.shotsDomain=shotDomain;
 // The history under test is the shipped owned history, not retired native
 // snapshots. Explicit seeding helpers also enter that same facade session.
 Object.assign(scope, { startupStage: { ...stage, characters: chars }, startupShotState: {}, rigs,
  rigReportersRef: ref(new Map()), rigWaitersRef: ref(new Map()), promptTextSessionRef: ref(null),
  takeRecipeRef: ref(null), physicsSourceCacheRef: ref(new Map()), actorStageRef: ref(stage),
  setArdyDuration() {}, setArdyPrompt() {}, setActiveWaypointId() {}, setPendingWaypointFrame() {},
  setSelectedPromptId() {}, setWaypointMode() {}, setPosing() {}, setPosingClosing() {},
 });
 const castDomain=mountHistoryCast(scope.appContext, Boolean(options.korean));
 scope.castDomain=castDomain;
 const objectDomain=createObjectsDomain(scope.appContext, []);
 store.current=Object.create(objectDomain.store);
 store.current.applyAtomic=fn=>scope.appContext.recordAction('objects',()=>objectDomain.write(fn),null,true).result;
 scope.store=store.current;
 const stageDomain=createStageDomain(scope.appContext);
 // Existing depth assertions observe the corresponding owned histories.
 Object.defineProperty(history,'current',{get:()=>({past:[...castDomain.documentStore.history().past,...stageDomain.documentStore.history().past],future:[...castDomain.documentStore.history().future,...stageDomain.documentStore.history().future]})});
 const motionDomain=createMotionDomain(scope.appContext, chars);
 scope.motionDomain=motionDomain;
 scope.setCharacters=rows=>castDomain.load(rows);
 scope.editCharacters=rows=>scope.appContext.recordAction('cast',()=>castDomain.write(rows),null,true).result;
 scope.setShots=shots=>shotDomain.load({shots,frameCount:live.current.timeline.frameCount});
 Object.assign(actionHandlers.current,scope.appContext.actionPorts,
  Object.fromEntries(['addCharacterWaypoint','moveCharacterWaypoint','removeCharacterWaypoint','clearCharacterWaypoints'].map(name=>[name,actual[name]])),
  {setWaypointMode:value=>{castDomain.setWaypointMode(value);stand.waypointMode=value;}});
 const registry=createStudioAppActions(actionHandlers.current);actionsRef.current=registry;
 const poses=[{id:'pose-rest',label:'Rest',bones:{}},{id:'pose-wave',label:'Wave',bones:{}}];
 scope.appContext.updatePorts({revision,read:actual.readStudioState,bounds:actual.studioBounds,poses:()=>poses,recordAction:actual.recordStudioAction,beginAction:actual.beginStudioAction});
 const ports={revision,read:actual.readStudioState,bounds:actual.studioBounds,commit:actual.commitStudioDraft,operate:actual.operateStudio,poses:()=>poses,
 ikRevision(id,stamp){const old=stamps.get(id);if(!old||old.stamp!==stamp)stamps.set(id,{stamp,revision:(old?.revision??0)+1});return stamps.get(id).revision;},
 isRetained:actual.isStudioHistoryRetained,
 canUndo:actual.canUndoStudioReceipt,
 undo:()=>actual.stepStudioHistory(false),redo:()=>actual.stepStudioHistory(true),history:redo=>scope.appContext.historyEntry(redo),finishHistoryGesture:actual.finishStudioHistoryGesture,
 capture(){throw new Error('renderer capture requires browser');},actions:()=>registry,recordAction:actual.recordStudioAction,beginAction:actual.beginStudioAction,showRefusal:scope.setToast};
 Object.assign(ports,scope.appContext.ports); ports.canUndo=actual.canUndoStudioReceipt;
 binding=createStudioAppBinding(ports);currentBinding=binding;scope.studioBindingRef.current={stepHistory:actual.stepStudioHistory,get bus(){return binding.bus;}};binding.refresh();
 const host=()=>binding.refresh().host;
 const confirmation=(name,args)=>{
  if(name!=='run_action'||!registry.list().some(a=>a.id===args.action&&a.exposure==='confirm'&&a.available))return {};
  try{return {confirmationToken:binding.bus.confirm(args.action,args.args)};}catch(error){if(error.code==='INVALID_ARGUMENT')return {};throw error;}
 };
 const request=(name,args)=>({name,args,host:host(),commandId:crypto.randomUUID(),expectedRevision:binding.refresh().revision,expectedTargets:[...store.current.objects,...characterRef.current].map(c=>binding.guard(c.id)),...confirmation(name,args)});
 const call=async(name,args)=>{const response=await dispatchLiveFrame(JSON.stringify({type:'cmd',id:crypto.randomUUID(),name,args}),binding.handlers);assert(response.ok, response.error);return response.value;};
 // A React commit of the state the test sets (and the App's own setters left).
 const render=(patch={})=>{Object.assign(renderState,patch);Object.assign(committed,renderState);rendered=renderApp();};
 return {render,rendered:()=>rendered,renderState,stand,setUrlLoader:loader=>{urlLoader=loader;},nextMotion:()=>new Promise(resolve=>{const release=motionDomain.documentStore.subscribe(()=>{const take=motionDomain.motionFor(scope.loadedLayerCharRef.current);if(take){release();resolve(take);}});}),motionStore,values,binding,actual,scope,ports,registry,request,call,revision,semantic,live,store,history,characterRef,buffer,rigs,host,poses,dispose:()=>{binding.dispose();motionDomain.dispose();stageDomain.dispose();objectDomain.dispose();castDomain.dispose();shotDomain.dispose();}};
}
const createArgs={ops:[{op:'create',source:{kind:'cube'},position:{world:{x:2,y:0,z:0}}}]};
// Owned stage commands return the complete stage readback. Pin every field,
// rather than weakening the legacy patch-only evidence assertions to a subset.
const stageEvidence = (patch = {}) => Object.entries({
 'stage.keyLight.x': {number:6}, 'stage.keyLight.y': {number:9}, 'stage.keyLight.z': {number:4},
 'stage.keyLight.intensity': {number:1.12}, 'stage.keyLight.warmth': {number:0.5},
 'stage.environmentImage': {text:null}, 'stage.environment': {text:'a sunlit modern living room'},
 'stage.style': {text:'moody cinematic lighting, 35mm film look'}, 'stage.hasEnvSheet': {flag:false},
 'stage.camera': {text:'16:9'}, 'stage.cameraPresetId': {text:null}, 'stage.sensorId': {text:'fullFrame'},
 // The stage look (stage.lighting) reads back at its studio defaults.
 'stage.keyLight.color': {text:null}, 'stage.lighting.sky': {text:null}, 'stage.lighting.skyTop': {text:null}, 'stage.lighting.ambient': {number:1},
 'stage.lighting.hemiSky': {text:'#ffffff'}, 'stage.lighting.hemiGround': {text:'#5a5d64'}, 'stage.lighting.fill': {number:1}, 'stage.lighting.fog': {number:0},
 'stage.lighting.exposure': {number:1}, 'stage.lighting.shadowSoftness': {number:0}, 'stage.lighting.envLight': {number:0}, 'stage.lighting.ao': {number:0},
 'stage.lighting.hdr': {text:null}, 'stage.lighting.hdrRotation': {number:0}, 'stage.lighting.hdrIntensity': {number:1}, 'stage.lighting.hdrBackground': {flag:true},
 ...patch,
}).map(([path,value])=>({path,...value}));
async function railCameraUndo(f, interleaveObject) {
 const shot=createShot('Rail shot',0,47,[],{mode:'rail',cameraRail:[{x:-2,z:4},{x:2,z:4}],railFollow:{mode:'range',startFrame:0,endFrame:47},followCam:{pitchOffsetDeg:4},craneHeight:{points:[{t:0,height:1.2},{t:1,height:2.4}]}});
 f.scope.setShots([shot]);f.live.current.shots=[shot];
 const before=structuredClone(f.actual.snapshotStudioDomain('shot'));
 assert.equal(f.binding.context().shot.mode,'rail');
 const receipt=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:12,framing:{exact:{position:{x:1,y:2,z:6},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
 assert.equal(receipt.ok,true,JSON.stringify(receipt));
 assert.equal(f.binding.context().shot.mode,'keys');
 assert.equal(f.live.current.shots[0].cameraKeys.length,1);
 if(interleaveObject){
  const result=await f.call('arrange_objects',f.request('arrange_objects',createArgs));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.scope.shotsDomain.canUndo(receipt.undo.historyEntryId),true,'the shot pre-image remains retained');
  assert.equal(f.actual.canUndoStudioReceipt(receipt),false,'the newer object edit owns Undo first');
  f.actual.undoScene();
  assert.equal(f.store.current.objects.length,0);
  assert.equal(f.binding.context().shot.mode,'keys','object Undo must not undo the camera');
 }
 const stepped=f.actual.stepStudioHistory(false);
 assert.deepEqual({stepped,mode:f.binding.context().shot.mode,camera:f.actual.snapshotStudioDomain('shot').camera},
  {stepped:true,mode:'rail',camera:before.camera},'Undo must restore the rail camera and shot chip');
 assert.deepEqual(f.actual.snapshotStudioDomain('shot'),before,'restore the complete camera block and camera keys');
 assert.deepEqual(f.scope.shotCamRef.current.position.toArray(),Object.values(before.camera.position));
}
const implementations={
 async 'late-apply-inspect-patch'(f){
  // The agent's real tool wrapper over this binding. The hub gives up on the
  // first arrangement after the editor applied it (the lost-ack timeout).
  const {createStudioTools}=await import('../bin/agent/studio-tools.mjs');
  let giveUp=true,refreshes=0;const sent=[];
  const liveHub={async command(name,args){
   if(args.expectedRevision!==undefined)sent.push({name,expectedRevision:args.expectedRevision});
   const response=await dispatchLiveFrame(JSON.stringify({type:'cmd',id:crypto.randomUUID(),name,args}),f.binding.handlers);
   assert(response.ok,response.error);
   if(giveUp&&name==='arrange_objects'){giveUp=false;throw Object.assign(new Error('Live editor timed out running arrange_objects.'),{code:'UNCERTAIN_APPLY'});}
   return response.value;
  }};
  const {workspaceId,documentEpoch,sceneId,sceneEpoch}=f.host();
  const admission={commandId:()=>crypto.randomUUID(),host:{workspaceId,documentEpoch,sceneId,sceneEpoch},revision:f.binding.context().revision.scene,
   async refresh(){refreshes++;const c=await liveHub.command('read_studio_context',{host:admission.host});admission.revision=c.revision.scene;}};
  const invoke=createStudioTools({liveHub,workspaceHandle:'handle',session:{admission}}).internal.invoke;
  await assert.rejects(invoke('arrange_objects',createArgs),{code:'UNCERTAIN_APPLY'});
  const id=f.store.current.objects[0].id;
  assert.equal(f.store.current.objects.length,1,'the abandoned arrangement still applied');
  // Whatever scope the model inspects after an edit it did not make, the
  // revision that inspect reports is the one the next patch is admitted at.
  const scopes=['scene','entities','selection','shot','motion','actions','catalogue'];
  for(const [index,scope] of scopes.entries()){
   f.actual.publishStudioCharacters(f.characterRef.current.map(c=>c.id==='actor-b'?{...c,x:5+index}:c),true);
   const live=f.binding.refresh().revision;
   const seen=await invoke('inspect_studio',{scope});
   assert.equal(seen.revision?.scene,live,`inspect scope ${scope} reports the admission revision`);
   assert.equal(seen.context,undefined,`inspect scope ${scope} does not echo the whole context`);
   const patched=await invoke('patch_elements',{ops:[{target:{kind:'object',id},set:{color:`#12345${index}`}}]}).catch(error=>error);
   assert.equal(patched.status,'applied',`patch after inspect scope ${scope} is admitted at the revision it reported: ${patched.code ?? ''} ${patched.message ?? ''}`);
   assert.deepEqual(sent.at(-1),{name:'patch_elements',expectedRevision:live});
  }
  assert.equal(refreshes,1,'only the lost acknowledgement needed a refresh');
 },
 async 'verify-stale-receipt'(f){
  // A receipt stays verifiable after later edits: its evidence comes back
  // marked stale with both revisions, and a requested frame is a fresh capture.
  const first=await f.call('arrange_objects',f.request('arrange_objects',createArgs));
  assert.equal(first.ok,true,JSON.stringify(first));
  const second=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'update',id:first.affectedIds[0],position:{world:{x:3,y:0,z:0}}}]}));
  assert.equal(second.ok,true,JSON.stringify(second));
  const captured=[];f.ports.capture=()=>{captured.push(f.binding.refresh().revision);return {dataUrl:'data:image/png;base64,AAAA'};};
  const stale=await f.call('verify_result',f.request('verify_result',{receiptId:first.receiptId,checks:['placement'],visual:'frame'}));
  assert.notEqual(stale.ok,false,`an earlier receipt must stay verifiable: ${JSON.stringify(stale)}`);
  assert.deepEqual({receiptId:stale.receiptId,stale:stale.stale,evidenceRevision:stale.evidenceRevision,revision:stale.revision,checks:stale.checks},
   {receiptId:first.receiptId,stale:true,evidenceRevision:first.revision.after,revision:second.revision.after,checks:first.checks});
  assert.deepEqual(captured,[second.revision.after],'the requested frame is captured from the current scene');
  const image=await f.call('resolve_studio_image',{imageId:stale.visualRefs[0].imageId,receiptId:first.receiptId,revision:stale.revision});
  assert.equal(image.revision,second.revision.after);
  const current=await f.call('verify_result',f.request('verify_result',{receiptId:second.receiptId,checks:['placement'],visual:'none'}));
  assert.deepEqual({stale:current.stale,evidenceRevision:current.evidenceRevision,revision:current.revision},{stale:false,evidenceRevision:second.revision.after,revision:second.revision.after});
  // An edit that lands after the admission was read still never fails it.
  const late=f.request('verify_result',{receiptId:second.receiptId,checks:['placement'],visual:'none'});
  f.actual.publishStudioCharacters(f.characterRef.current.map(c=>c.id==='actor-a'?{...c,x:1}:c),true);
  const after=await f.call('verify_result',late);
  assert.notEqual(after.ok,false,`a later edit must not fail verification: ${JSON.stringify(after)}`);
  assert.deepEqual({stale:after.stale,evidenceRevision:after.evidenceRevision,revision:after.revision},{stale:true,evidenceRevision:second.revision.after,revision:f.binding.refresh().revision});
  assert(after.revision>second.revision.after);
 },
 async 'verify-result-targets'(f){
  // Targets are measured now, with the helpers the arrange/frame_shot receipts
  // and the motion candidate use; only what truly cannot be computed is
  // unsupported, and each such check says why.
  const bindingSource=readFileSync(new URL('../src/studio-app-binding.js',import.meta.url),'utf8');
  const branch=bindingSource.slice(bindingSource.indexOf('if (request.name === "verify_result") {'),bindingSource.indexOf('fail("CAPABILITY_MISSING", "Generation is owned by the server runtime.");'));
  for(const helper of ['placementChecks(','framingChecks(','verifyInstalledTake('])assert(branch.includes(helper),`verify_result computes target checks through ${helper}`);
  const verify=args=>f.call('verify_result',f.request('verify_result',{visual:'none',...args}));
  const first=await verify({targets:['actor-a'],checks:['placement','framing','motion']});
  assert.notEqual(first.ok,false,JSON.stringify(first));
  assert.deepEqual(first.unsupportedChecks,['motion'],JSON.stringify(first));
  assert.match(first.unsupportedReasons.motion,/take/);
  assert.deepEqual(Object.keys(first.unsupportedReasons),['motion']);
  assert.equal(first.checks.placement.coverage,'same-frame-world-AABB-proxies');assert.deepEqual(first.checks.placement.overlapIds,[]);
  assert.equal(first.checks.framing.coverage,'same-frame-subject-bounds-projection');assert(first.checks.framing.screenFraction>0,JSON.stringify(first.checks.framing));
  const made=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},position:{world:{x:0,y:0,z:0}}}]}));
  assert.equal(made.ok,true,JSON.stringify(made));const cube=made.affectedIds[0];
  const overlapped=await verify({targets:['actor-a'],checks:['placement']});
  assert.deepEqual(overlapped.checks.placement.overlapIds,[cube]);assert(overlapped.checks.placement.maximumFootprintOverlapM>0);assert.deepEqual(overlapped.unsupportedChecks,[]);
  const lifted=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},position:{world:{x:3,y:0.25,z:0}}}]}));assert.equal(lifted.ok,true,JSON.stringify(lifted));
  const gaps=(await verify({targets:[cube,lifted.affectedIds[0],'actor-a'],checks:['placement']})).checks.placement;
  assert.deepEqual({supportGapM:gaps.supportGapM,unsupportedIds:gaps.unsupportedIds},{supportGapM:{[cube]:0,[lifted.affectedIds[0]]:0.25},unsupportedIds:[lifted.affectedIds[0]]},'placement measures how far each object stands off its support');
  const prop=await verify({targets:[cube],checks:['motion']});
  assert.deepEqual(prop.unsupportedChecks,['motion']);assert.match(prop.unsupportedReasons.motion,/not a character/);
  // A take the UI installed carries no verification: verify_result measures it.
  f.buffer.current.motion=clip();
  const take=await verify({targets:['actor-a'],checks:['motion']});
  assert.deepEqual(take.unsupportedChecks,[],JSON.stringify(take));assert.deepEqual(take.unsupportedReasons,{});
  assert.equal(take.verification.characterId,'actor-a');assert.equal(take.verification.profile,'studio-motion-v1');
  assert.equal(take.verification.evaluatedFrames,48);assert.deepEqual(take.verification.range,{startFrame:0,endFrameExclusive:48});
  assert(['verified','unverified'].includes(take.verification.status),JSON.stringify(take.verification));
  const moving={...clip()};moving.spec={...moving.spec,objects:{[lifted.affectedIds[0]]:{follow:'joint:Hips'}}};f.buffer.current.motion=moving;
  assert.deepEqual((await verify({targets:[lifted.affectedIds[0]],checks:['placement']})).checks.placement.supportGapM,{},'a record the installed take moves has no support gap');
 },
 async 'verify-plan-and-geometry'(f){
  // verify_result measures the sight line and side of the line, adds the cut's
  // geometry and, asked for a plan, the Top View through its own port.
  const shot=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],framing:{exact:{position:{x:2,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
  assert.equal(shot.ok,true,JSON.stringify(shot));
  assert(!shot.warnings.some(w=>w.code==='OCCLUSION_UNMEASURED'),JSON.stringify(shot.warnings));
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',plans=[];
  f.ports.capturePlan=()=>{plans.push(f.binding.refresh().revision);return {dataUrl:png,width:1280,height:720,frame:0,shotId:shot.affectedIds[0]};};
  const verified=await f.call('verify_result',f.request('verify_result',{receiptId:shot.receiptId,checks:['framing'],visual:'plan'}));
  assert.notEqual(verified.ok,false,JSON.stringify(verified));
  assert.equal(verified.visualRefs.length,1);assert.equal(verified.visualRefs[0].kind,'plan');assert.equal(plans.length,1);
  const image=await f.call('resolve_studio_image',{imageId:verified.visualRefs[0].imageId,receiptId:shot.receiptId,revision:verified.revision});
  assert.match(image.dataUrl,/^data:image\/png;base64,/);assert.equal(image.width,1280);
  protocol.validateStudioSchema(protocol.StudioSchemas.GeometryFacts,verified.geometry);
  assert.deepEqual(verified.geometry.shots.map(s=>({shotId:s.shotId,subjectIds:s.subjectIds,cameraSide:s.cameraSide})),[{shotId:shot.affectedIds[0],subjectIds:['actor-a','actor-b'],cameraSide:'right'}]);
  assert.equal(verified.geometry.axisConsistent,null,'one shot has nothing to compare');
  // A target verify of the framing reports the same sight-line evidence; an editor without the port refuses the plan.
  const targets=await f.call('verify_result',f.request('verify_result',{targets:['actor-a'],checks:['framing'],visual:'none'}));
  assert.equal(typeof targets.checks.framing.occluded,'boolean',JSON.stringify(targets.checks));assert.equal(targets.checks.framing.occluded,false);
  assert.equal(targets.checks.framing.cameraSide,'right','actor-b stands 4 m along +x; a camera at +z is right of the line');
  const crate=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},position:{world:{x:1,y:0,z:2.5}},scale:{x:1,y:2,z:1}}]}));
  assert.equal(crate.ok,true,JSON.stringify(crate));
  const blocked=await f.call('verify_result',f.request('verify_result',{targets:['actor-a'],checks:['framing'],visual:'none'}));
  assert.equal(blocked.checks.framing.occluded,true,'a crate in the sight line occludes the subject');
  assert.deepEqual(blocked.geometry.shots[0].occluders,[{subjectId:'actor-a',byObjectId:crate.affectedIds[0]}]);
  delete f.ports.capturePlan;
  const refused=await f.call('verify_result',f.request('verify_result',{receiptId:shot.receiptId,checks:['framing'],visual:'plan'}));
  assert.equal(refused.code,'CAPABILITY_MISSING',JSON.stringify(refused));
 },
 async 'previs-mode-and-character-kind'(){
  const proxy=createCharacterEntry({id:'actor-cap',model:'proxy-figure',x:2,z:2,posture:'lie'});
  const g=fixture({previsMode:'storyboard',characters:[createCharacterEntry({id:'actor-a',model:'y-bot-tpose',x:0,z:0}),proxy]});
  try{
   const c=g.binding.context();
   assert.equal(c.scene.previsMode,'storyboard');
   assert.equal(c.capabilities.storyboard,true);
   const rigged=c.entities.find(e=>e.id==='actor-a'),proxy=c.entities.find(e=>e.id==='actor-cap');
   assert.deepEqual({kind:rigged.characterKind,posture:rigged.posture},{kind:'rig',posture:undefined});
   assert.deepEqual({kind:proxy.characterKind,posture:proxy.posture,rigReady:proxy.capabilities.rigReady},{kind:'proxy',posture:'lie',rigReady:false});
   assert.deepEqual(c.view.mode,'scene','tool modes are untouched');
  }finally{g.dispose();}
  const h=fixture({previsMode:'animation'});
  try{const c=h.binding.context();assert.equal(c.scene.previsMode,'animation');assert.equal(c.capabilities.storyboard,false);}finally{h.dispose();}
  const bare=fixture();
  try{const c=bare.binding.context();assert.equal(c.scene.previsMode,undefined);assert.equal(c.capabilities.storyboard,undefined);}finally{bare.dispose();}
 },
 async 'inspect-entity-transforms'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',{ops:Array.from({length:30},(_,i)=>({op:'create',source:{kind:'cube'},name:`Prop ${i}`,position:{world:{x:i+2,y:1,z:3}},facing:{yawDeg:30},scale:{x:2,y:3,z:4}}))}));
  assert.equal(created.status,'applied',JSON.stringify(created));
  const id=f.store.current.objects.at(-1).id;
  const c=f.binding.context();
  assert.equal(c.units.pivot,'base');
  assert.equal(c.entityPage.truncated,true);
  assert(!c.entities.some(row=>row.id===id),'fixture target must be outside the bounded context');
  const result=await f.call('inspect_studio',{scope:'entities',ids:[id,'actor-a']});
  assert.equal(result.total,2);
  const row=result.entities.find(row=>row.id===id),character=result.entities.find(row=>row.id==='actor-a');
  assert.deepEqual(row.position,{x:31,y:1,z:3},'entity inspect must carry object position beyond the context page');
  assert.deepEqual(row.rotationDeg,{x:0,y:30,z:0});
  assert.deepEqual(row.scale,{x:2,y:3,z:4});
  assert.equal(row.renderer,'cube');assert.equal(row.parentId,null);assert.equal(row.attachment,null);
  assert.equal(row.token,f.binding.guard(id).token);
  assert.deepEqual(character,c.entities.find(row=>row.id==='actor-a'),'character inspect reuses the context projection');
  assert.deepEqual(character.position,{x:0,y:0,z:0});assert.equal(character.yawDeg,0);
  const first=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:29});
  assert.equal(first.total,30);assert.equal(first.entities.length,29);
  const last=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:29,cursor:first.nextCursor});
  const byId=f.store.current.objects.map(o=>o.id).sort();
  assert.deepEqual([...first.entities,...last.entities].map(e=>e.id),byId,'pages walk a stable id ordering');
  assert.equal(last.nextCursor,null);
 },
 async 'cursor-survives-edit'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',{ops:Array.from({length:30},(_,i)=>({op:'create',source:{kind:'cube'},name:`Prop ${i}`,position:{world:{x:i+2,y:0,z:3}}}))}));
  assert.equal(created.status,'applied',JSON.stringify(created));
  const byId=f.store.current.objects.map(o=>o.id).sort();
  const first=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:12});
  assert.deepEqual(first.entities.map(e=>e.id),byId.slice(0,12));
  const moved=await f.call('arrange_characters',f.request('arrange_characters',{ops:[{op:'update',characterId:'actor-b',position:{world:{x:5,y:0,z:1}}}]}));
  assert.equal(moved.status,'applied',JSON.stringify(moved));
  const second=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:12,cursor:first.nextCursor});
  assert.deepEqual(second.entities.map(e=>e.id),byId.slice(12,24),'an unrelated edit leaves the cursor usable');
  const c=f.binding.context();
  assert.equal(c.entityPage.truncated,true);
  const fromContext=await f.call('inspect_studio',{scope:'entities',limit:32,cursor:c.entityPage.nextCursor});
  assert.ok(fromContext.entities.length>0,'the context cursor is a real inspect cursor');
  f.scope.studioSceneEpochRef.current='reopened';
  assert.throws(()=>f.binding.handlers.inspect_studio({scope:'entities',query:'Prop',limit:12,cursor:second.nextCursor}),e=>e.code==='STALE_CURSOR');
 },
 async 'context-entity-index'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',{ops:Array.from({length:61},(_,i)=>({op:'create',source:{kind:'cube'},name:`Crate ${i}`,position:{world:{x:i,y:0,z:-3}}}))}));
  assert.equal(created.status,'applied',JSON.stringify(created));
  f.binding.handlers.operate_studio(f.request('operate_studio',{selection:{kind:'object',id:'cube-40'}}));
  const c=f.binding.context();
  protocol.validateStudioContext(c);
  assert.equal(c.entityPage.total,63);assert.equal(c.entities.length,24);
  assert.deepEqual(c.entities.slice(0,2).map(e=>e.id),['cube-40','actor-a'],'selected, then active, lead the detail');
  const all=[...f.store.current.objects.map(o=>o.id),'actor-a','actor-b'].sort();
  assert.deepEqual(c.entityIndex.map(e=>e.id),all,'the per-turn context indexes all 63 entities');
  assert.deepEqual(c.entityIndex.find(e=>e.id==='cube-40'),{id:'cube-40',kind:'object',name:'Crate 39',position:{x:39,y:0,z:-3}});
  assert.equal(c.entityIndex.find(e=>e.id==='actor-b').kind,'character');
 },
 async 'context-assets'(f){
  f.store.current.applyAtomic(rows=>[...rows,objects.createCutoutObject({assetId:'img-0a1b2c',name:'Poster'},rows)]);
  f.store.current.applyAtomic(rows=>[...rows,objects.createMeshObject({assetId:'mesh-3d4e5f',name:'Robot'},rows)]);
  f.store.current.applyAtomic(rows=>[...rows,objects.createMeshObject({assetId:'mesh-3d4e5f',name:'Robot'},rows)]);
  const c=f.binding.context();
  protocol.validateStudioContext(c);
  assert.deepEqual(c.assets.filter(a=>a.kind).map(a=>a.kind),commands.studioObjectCatalogue().objects.map(o=>o.kind),'every placeable catalogue kind is listed');
  assert.equal(c.assets.some(a=>['chair','car','small-plane'].includes(a.kind)),false,'the retired set pieces are not offered');
  assert.deepEqual(c.assets.find(a=>a.kind==='text'),{kind:'text',name:'Text',type:'set-piece'});
  assert.deepEqual(c.assets.find(a=>a.kind==='cube'),{kind:'cube',name:'Cube',type:'primitive'});
  assert.deepEqual(c.assets.filter(a=>a.id),[{id:'img-0a1b2c',name:'Poster',type:'image'},{id:'mesh-3d4e5f',name:'Robot',type:'mesh'}],'imported scene assets are listed once each');
 },
 async 'inspect-scopes'(f){
  const rail=createShot('Rail shot',0,47,[{frame:5,framing:{pos:{x:0,y:1.6,z:5},yaw:0.1,pitch:-0.05,fovDeg:40}}],{mode:'rail',cameraRail:[{x:-2,z:4},{x:2,z:4}]});
  f.scope.setShots([rail]);f.live.current.shots=[rail];
  const shot=await f.call('inspect_studio',{scope:'shot'});
  assert.equal(shot.revision.scene,f.binding.refresh().revision,'every scope carries the admission revision');
  assert.equal(shot.context,undefined,'and no embedded context');
  assert.deepEqual(shot.host,(({workspaceId,documentEpoch,sceneId,sceneEpoch})=>({workspaceId,documentEpoch,sceneId,sceneEpoch}))(f.binding.context().host),'with the minimal document identity');
  assert.equal(shot.scope,'document');
  assert.deepEqual(shot.document.shots.map(s=>({id:s.id,name:s.name,range:{startFrame:s.startFrame,endFrameExclusive:s.endFrame+1},mode:s.camera.mode,
   cameraKeys:s.cameraKeys.map(({id,...key})=>key),rail:s.camera.cameraRail})),[{id:rail.id,name:'Rail shot',range:{startFrame:0,endFrameExclusive:48},mode:'rail',
   cameraKeys:[{frame:5,framing:{pos:{x:0,y:1.6,z:5},yaw:0.1,pitch:-0.05,fovDeg:40}}],rail:[{x:-2,z:4},{x:2,z:4}]}]);
  f.scope.castDomain.run('cast.setLayer',{characterId:'actor-a',layer:{...f.scope.castDomain.read()[0].layer,waypoints:[{frame:0,x:0,z:0},{frame:24,x:1,z:2}]}});
  const keyed=await f.call('run_action',f.request('run_action',{action:'ik.setKey',args:{characterId:'actor-b',frame:7,tracks:{hips:{p:{x:0,y:1,z:0},q:[{x:0,y:0,z:0,w:1}]}}}}));
  assert.equal(keyed.ok,true,JSON.stringify(keyed));
  const motion=await f.call('inspect_studio',{scope:'motion'}),actor=motion.document.characters.find(c=>c.id==='actor-a');
  assert.deepEqual(actor.layer.waypoints.map(p=>({frame:p.frame,position:{x:p.x,y:p.y??0,z:p.z}})),[{frame:0,position:{x:0,y:0,z:0}},{frame:24,position:{x:1,y:0,z:2}}]);
  assert.deepEqual(motion.document.motion.find(c=>c.id==='actor-b').ikKeys.map(k=>k.frame),[7]);
  assert.equal(f.binding.context().entities.find(c=>c.id==='actor-a').motion.frames,0);
  assert.equal(f.binding.context().entities.find(c=>c.id==='actor-a').motion.takeId,null);
  const scene=await f.call('inspect_studio',{scope:'scene'}),stage=scene.document.stage;
  assert.deepEqual({environment:stage.environment,style:stage.style,hasEnvironmentImage:!!stage.environmentImage,hasEnvSheet:stage.hasEnvSheet,keyLight:stage.keyLight,camera:{presetId:stage.cameraPresetId,aspect:stage.shotAspect,sensorId:stage.sensorId}},
   {environment:'a sunlit modern living room',style:'moody cinematic lighting, 35mm film look',hasEnvironmentImage:false,hasEnvSheet:false,keyLight:{x:6,y:9,z:4,intensity:1.12,warmth:0.5,color:null},camera:{presetId:null,aspect:'16:9',sensorId:'fullFrame'}});
  assert.deepEqual({characters:f.binding.context().scene.characterCount,objects:f.binding.context().scene.objectCount,shots:scene.document.shots.length,frames:f.binding.context().scene.frameCount,assets:f.binding.context().assets.length},
   {characters:2,objects:0,shots:1,frames:48,assets:commands.studioObjectCatalogue().objects.length});
  const made=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},position:{world:{x:0,y:0,z:0}}},{op:'create',source:{kind:'cube'},position:{world:{x:2,y:0,z:0}}}]}));
  assert.equal(made.status,'applied',JSON.stringify(made));
  const [base,child]=made.affectedIds;
  for(const args of [{ops:[{op:'group',parentId:base,childIds:[child]}]},{ops:[{op:'update',id:child,color:'#d94a4a'}]}]){const r=await f.call('arrange_objects',f.request('arrange_objects',args));assert.equal(r.ok,true,JSON.stringify(r));}
  const routed=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'object',id:child},set:{path:{points:[{x:2,y:0,z:0},{x:4,y:0,z:1}]}}}]}));
  assert.equal(routed.status,'applied',JSON.stringify(routed));
  assert.equal(f.binding.handlers.operate_studio(f.request('operate_studio',{selection:{kind:'object',id:child}})).ok,true);
  const selected=await f.call('inspect_studio',{scope:'selection'}),entity=selected.document.objects[0];
  assert.deepEqual(f.binding.context().selection,{kind:'object',id:child});
  assert.equal(entity.id,child);assert.equal(entity.color,'#d94a4a');assert.equal(entity.parent,base);assert.equal(entity.attach,null);
  assert.deepEqual(entity.path.points,[{x:2,y:0,z:0},{x:4,y:0,z:1}]);
  const tinted=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'character',id:'actor-a'},set:{tint:'#123456'}}]}));
  assert.equal(tinted.status,'applied',JSON.stringify(tinted));
  assert.equal(f.binding.handlers.operate_studio(f.request('operate_studio',{selection:{kind:'character',id:'actor-a'}})).ok,true);
  const cast=await f.call('inspect_studio',{scope:'selection'}),character=cast.document.characters[0];
  assert.equal(character.id,'actor-a');assert.equal(character.tint,'#123456');assert.equal(character.model,'y-bot-tpose');
  const rows=await f.call('inspect_studio',{scope:'entities',ids:[child,'actor-a']});
  assert.equal(rows.entities.find(e=>e.id===child).color,'#d94a4a');
  assert.equal(rows.entities.find(e=>e.id==='actor-a').tint,'#123456');assert.equal(rows.entities.find(e=>e.id==='actor-a').modelId,'y-bot-tpose');
 },
 async 'patch-character-tint-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'character',id:'actor-a'},set:{tint:'#123456',pose:'pose-wave'}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.before,before);assert.equal(r.revision.after,before+1);assert.deepEqual(r.ops,[{index:0,status:'applied'}]);assert.deepEqual(r.delta,[{id:'actor-a',after:{patched:[{path:'character.tint',text:'#123456'},{path:'character.pose',text:'pose-wave'}]}}]);assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').tint,'#123456');assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').pose.id,'pose-wave');assert.equal(f.history.current.past.length,1);const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').tint,null);assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').pose,null);},
 async 'patch-stage-key-light-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{'keyLight.intensity':2.5,camera:'9:16'}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.after,before+1);assert.deepEqual(r.affectedIds,['scene']);assert.deepEqual(r.delta[0].after.patched,stageEvidence({'stage.keyLight.intensity':{number:2.5},'stage.camera':{text:'9:16'}}));assert.equal(f.live.current.stage.keyLight.intensity,2.5);assert.equal(f.live.current.stage.shotAspect,'9:16');assert.equal(f.history.current.past.length,1);assert.equal(f.binding.refresh().revision,before+1,'one stage patch is one authored revision');const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.equal(f.live.current.stage.keyLight.intensity,1.12);assert.equal(f.live.current.stage.shotAspect,'16:9');},
 // Every Studio turn is one editor transaction (#715), so the sidecar's patch_elements arrives
 // with a turnId and the bus answers "completed". The receipt carries ops[] there too (it used to
 // fail validation with INVALID_RECEIPT after the edit had landed), and a dropped path is "partial".
 async 'patch-inside-agent-turn'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  const turnId=crypto.randomUUID(),inTurn=(name,args)=>({...f.request(name,args),turnId});
  const begin=await f.call('run_action',inTurn('run_action',{action:'agent.turn.begin',args:{turnId}}));assert.equal(begin.ok,true,JSON.stringify(begin));
  const before=f.binding.refresh().revision;
  const r=await f.call('patch_elements',inTurn('patch_elements',{ops:[{target:{kind:'object',id},set:{color:'#a8743f',position:{x:1.5,y:0,z:-2}}}]}));
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.status,'completed',JSON.stringify(r));assert.equal(r.kind,'mutation');assert.equal(r.action,'object.set');
  assert.deepEqual(r.ops,[{index:0,status:'applied'}]);assert.deepEqual(r.revision,{before,after:before+1});
  assert.deepEqual(r.delta,[{id,after:{patched:[{path:'object.position',vec:{x:1.5,y:0,z:-2}},{path:'object.color',text:'#a8743f'}]}}]);
  assert.deepEqual(r.undo,{historyEntryId:turnId,entries:1,canUndoDirect:false});
  assert.deepEqual(protocol.validateReceipt(r),r,'the receipt the sidecar relays is a valid protocol receipt');
  const placed=f.store.current.objects.find(o=>o.id===id);assert.equal(placed.color,'#a8743f');assert.deepEqual([placed.x,placed.y,placed.z],[1.5,0,-2]);
  const partial=await f.call('patch_elements',inTurn('patch_elements',{ops:[{target:{kind:'object',id},set:{color:'#123456',name:''}}]}));
  assert.equal(partial.status,'partial',JSON.stringify(partial));assert.deepEqual(partial.ops,[{index:0,status:'partial',droppedPaths:['object.name']}]);
  assert.equal(partial.kind,undefined);assert.deepEqual(partial.undo,{historyEntryId:turnId,entries:1,canUndoDirect:false});
  const finish=await f.call('run_action',inTurn('run_action',{action:'agent.turn.finish',args:{turnId}}));assert.equal(finish.authored,true,JSON.stringify(finish));
  assert.equal((await f.call('undo_edit',f.request('undo_edit',{receiptId:finish.receiptId}))).status,'undone','the turn is one undo step');
  const undone=f.store.current.objects.find(o=>o.id===id);assert.equal(undone.color,'#c2c6c8');assert.deepEqual([undone.x,undone.y,undone.z],[2,0,0]);
 },
 async 'patch-partial-drop'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  // The owned object setter can change renderer. Exercise its persistence
  // repair instead: an empty name falls back while the valid color applies.
  const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'object',id},set:{color:'#123456',name:''}}]}));
  assert.equal(r.status,'partial',JSON.stringify(r));assert.deepEqual(r.ops,[{index:0,status:'partial',droppedPaths:['object.name']}]);
  assert.equal(f.store.current.objects.find(o=>o.id===id).color,'#123456');assert.equal(f.store.current.objects.find(o=>o.id===id).name,'Cube');
  const noop=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'object',id},set:{name:''}}]}));
  assert.equal(noop.status,'noop',JSON.stringify(noop));assert.deepEqual(noop.ops,[{index:0,status:'partial',droppedPaths:['object.name']}]);assert.equal(noop.undo,null);
  assert.equal((await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}))).status,'undone');
  assert.equal(f.store.current.objects.find(o=>o.id===id).color,'#c2c6c8');
 },
 async 'patch-shot-and-prompt-blocks'(f){const framed=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:0,framing:{exact:{position:{x:0,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));assert.equal(framed.ok,true,JSON.stringify(framed));const shotId=f.live.current.shots[0].id;const model=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'shot',id:shotId},set:{targetModel:'seedance-2.5'}}]}));assert.equal(model.status,'applied',JSON.stringify(model));assert.equal(f.live.current.shots[0].targetModel,'seedance-2.5');assert.deepEqual(model.delta,[{id:shotId,after:{patched:[{path:'shot.targetModel',text:'seedance-2.5'}]}}]);const unnamed=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'shot'},set:{targetModel:'no-such-model'}}]}));assert.equal(unnamed.code,'INVALID_ARGUMENT','owned collection patches require an explicit id');const unknown=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'shot',id:shotId},set:{targetModel:'no-such-model'}}]}));assert.equal(unknown.status,'partial',JSON.stringify(unknown));assert.deepEqual(unknown.ops,[{index:0,status:'partial',droppedPaths:['shot.targetModel']}]);assert.equal(f.live.current.shots[0].targetModel,undefined,'an unknown video model is dropped by the shot document repair');},
 async 'patch-stage-environment-text-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{environment:'a rainy rooftop at dusk',style:'handheld 16mm',hasEnvSheet:true}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.after,before+1);assert.deepEqual(r.delta[0].after.patched,stageEvidence({'stage.environment':{text:'a rainy rooftop at dusk'},'stage.style':{text:'handheld 16mm'},'stage.hasEnvSheet':{flag:true}}));assert.equal(f.live.current.stage.environment,'a rainy rooftop at dusk');assert.equal(f.live.current.stage.style,'handheld 16mm');assert.equal(f.live.current.stage.hasEnvSheet,true);assert.equal(f.history.current.past.length,1,'one stage patch is one history entry');const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.notEqual(f.live.current.stage.environment,'a rainy rooftop at dusk');assert.equal(f.live.current.stage.hasEnvSheet,false);},
 async 'patch-during-gesture'(f){f.scope.ikBodyDragRef.current=true;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{'keyLight.warmth':0.9}}]}));assert.equal(r.code,'TARGET_BUSY',JSON.stringify(r));assert.equal(f.history.current.past.length,0);assert.equal(f.live.current.stage.keyLight.warmth,0.5);},
 async 'run-action-shot-create-and-undo'(f){
  const listed=await f.call('inspect_studio',{scope:'actions'});
  assert.deepEqual(listed.actions.map(a=>a.id).sort(),commandDeclarations().filter(entry=>!entry.agentHidden).map(entry=>entry.id).sort(),'the App registers every declared action except agentHidden ones');
  const byId=Object.fromEntries(listed.actions.map(a=>[a.id,a]));
  assert.equal(byId['shot.create'].available,true,JSON.stringify(byId['shot.create']));
  assert.equal(byId['shot.create'].input,undefined,'the listing carries no schema');
  const [described]=(await f.call('inspect_studio',{scope:'actions',ids:['shot.create']})).actions;
  assert.deepEqual(described.input,studioActions.studioActionDeclaration('shot.create').input,'ids answer the schema');
  assert.equal(byId['shot.remove'].available,false);assert.equal(typeof byId['shot.remove'].reason,'string');
  const before=f.binding.refresh().revision;
  const r=await f.call('run_action',f.request('run_action',{action:'shot.create',args:{}}));
  assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.action,'shot.create');assert.equal(typeof r.summary,'string');
  assert.deepEqual(r.revision,{before,after:before+1});
  assert.equal(f.live.current.shots.length,1);const shot=f.live.current.shots[0];
  assert.deepEqual(r.affectedIds,[shot.id]);
  assert.deepEqual(r.delta,[{id:shot.id,after:{patched:[{path:'shot.cameraKeys',count:1},{path:'shot.targetModel',text:null}]}}]);
  assert.equal(f.scope.shotsDomain.documentStore.depths().past,1,'one owned Ctrl+Z entry');
  assert.equal(f.history.current.past.length,0,'shots leave native cast history');
  assert.equal((await f.call('reconcile_studio_command',{host:f.host(),commandId:r.commandId})).status,'applied');
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(f.live.current.shots,[]);assert.equal(f.history.current.past.length,0);
 },
 async 'run-action-object-duplicate-and-undo'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  const r=await f.call('run_action',f.request('run_action',{action:'object.duplicate',args:{objectId:id}}));
  assert.equal(r.status,'applied',JSON.stringify(r));assert.deepEqual(r.affectedIds,['copy-1']);assert.equal(r.revision.after,r.revision.before+1);
  assert.deepEqual(r.delta,[{id:'copy-1',after:{bounds:{min:{x:2,y:0,z:-0.5},max:{x:3,y:1,z:0.5}},patched:[
   {path:'object.renderer',text:'cube'},{path:'object.position',vec:{x:2.5,y:0,z:0}},
   {path:'object.rotation',vec:{x:0,y:0,z:0}},{path:'object.scale',vec:{x:1,y:1,z:1}},
   {path:'object.name',text:'Copy'},{path:'object.color',text:'#c2c6c8'},{path:'object.opacity',text:null},
   {path:'object.parent',text:null},{path:'object.path',text:null},{path:'object.remove',flag:false},
  ]}}]);
  assert.equal(f.store.current.objects.length,2);
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(f.store.current.objects.map(o=>o.id),[id]);
 },
 async 'run-action-refusals'(f){
  const refused=async(args,code)=>{const r=await f.call('run_action',f.request('run_action',args));assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);};
  await refused({action:'shot.teleport'},'INVALID_ARGUMENT');
  await refused({action:'shot.create',args:{frame:3}},'INVALID_ARGUMENT');
  await refused({action:'shot.remove',args:{shotId:'shot-missing'}},'TARGET_NOT_READY');
  await refused({action:'object.duplicate',args:{objectId:'missing'}},'TARGET_NOT_READY');
  const stale=f.request('run_action',{action:'shot.create'});stale.expectedRevision++;
  assert.equal((await f.call('run_action',stale)).code,'STALE_SCENE');
  assert.equal(f.history.current.past.length,0);assert.deepEqual(f.live.current.shots,[]);
 },
 async 'run-action-character-waypoints-and-undo'(f){
  const path=async id=>(await f.call('inspect_studio',{scope:'document',select:['character']})).document.characters.find(c=>c.id===id).layer.waypoints.map(p=>({frame:p.frame,position:{x:p.x,y:p.y??0,z:p.z}}));
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  for(const id of ['character.addWaypoint','character.moveWaypoint','character.removeWaypoint','character.clearWaypoints'])assert.equal(listed[id]?.available,true,id);
  // Every action names its character; none depends on the UI's waypoint mode
  // or on which character is active.
  f.live.current.studioView={...f.live.current.studioView,mode:'camera'};
  const before=f.binding.refresh().revision;
  const added=await run('character.addWaypoint',{characterId:'actor-b',position:{x:5,z:0},frame:24});
  assert.equal(added.status,'applied',JSON.stringify(added));assert.equal(added.action,'character.addWaypoint');
  assert.deepEqual(added.affectedIds,['actor-b']);assert.deepEqual(added.revision,{before,after:before+1});assert.match(added.summary,/frame 24/);
  assert.deepEqual(await path('actor-b'),[{frame:24,position:{x:5,y:0,z:0}}]);
  assert.equal(f.stand.waypointMode,true,'an agent-added waypoint turns Waypoint mode on');
  assert.deepEqual(f.buffer.current.waypoints,[],'the active character keeps its own path');
  // Without a frame the pin is paced at a walk: 1.4 m from actor-a's spot is one second.
  const paced=await run('character.addWaypoint',{characterId:'actor-a',position:{x:1.4,z:0}});
  assert.equal(paced.status,'applied',JSON.stringify(paced));
  assert.deepEqual(await path('actor-a'),[{frame:24,position:{x:1.4,y:0,z:0}}]);
  assert.equal(f.buffer.current.waypoints.length,1,'the loaded layer is written through its editing buffer');
  assert.equal((await run('character.addWaypoint',{characterId:'actor-a',position:{x:2.4,z:0},frame:40})).status,'applied');
  f.stand.waypointMode=false;
  const moved=await run('character.moveWaypoint',{characterId:'actor-a',frame:24,position:{x:1,z:0.5}});
  assert.equal(moved.status,'applied',JSON.stringify(moved));
  assert.equal(f.stand.waypointMode,true,'an agent-moved waypoint turns Waypoint mode on');
  assert.deepEqual((await path('actor-a')).map(w=>w.position),[{x:1,y:0,z:0.5},{x:2.4,y:0,z:0}]);
  const removed=await run('character.removeWaypoint',{characterId:'actor-b',frame:24});
  assert.equal(removed.status,'applied',JSON.stringify(removed));assert.deepEqual(await path('actor-b'),[]);
  const cleared=await run('character.clearWaypoints',{characterId:'actor-a'});
  assert.equal(cleared.status,'applied',JSON.stringify(cleared));assert.deepEqual(await path('actor-a'),[]);
  assert.equal(f.scope.castDomain.documentStore.depths().past,6,'one owned Ctrl+Z entry per action');
  // undo_edit reverts the clear through the editing buffer; Ctrl+Z then
  // reverts the removal on the other character.
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:cleared.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));
  assert.deepEqual((await path('actor-a')).map(w=>w.frame),[24,40]);assert.equal(f.buffer.current.waypoints.length,2);
  assert(f.actual.stepStudioHistory(false));assert.deepEqual(await path('actor-b'),[{frame:24,position:{x:5,y:0,z:0}}]);
  // Refusals change nothing and say why.
  const depth=f.history.current.past.length;
  const refused=async(action,args,code)=>{const r=await run(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,`${action} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);assert.equal(r.mutated,false);};
  await refused('character.addWaypoint',{characterId:'actor-a',position:{x:1.2,z:0},frame:40},'INVALID_ARGUMENT');
  await refused('character.addWaypoint',{characterId:'actor-a',position:{x:9,z:0},frame:44},'INVALID_ARGUMENT');
  await refused('character.addWaypoint',{characterId:'actor-a',position:{x:3,z:0},frame:60},'INVALID_RANGE');
  await refused('character.addWaypoint',{characterId:'ghost',position:{x:1,z:0},frame:30},'STALE_TARGET');
  await refused('character.moveWaypoint',{characterId:'actor-a',frame:30,position:{x:1,z:0}},'STALE_TARGET');
  await refused('character.removeWaypoint',{characterId:'actor-a',frame:30},'STALE_TARGET');
  assert.equal(f.history.current.past.length,depth);
 },
 async 'run-action-character-ik-keys-and-undo'(f){
  const frames=async id=>(await f.call('inspect_studio',{scope:'document',select:['motion']})).document.motion.find(c=>c.id===id).ikKeys.map(key=>key.frame);
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const q=(x=0,y=0,z=0,w=1)=>({x,y,z,w});
  const layerB=()=>f.scope.ikStatesRef.current.get('actor-b');
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  for(const id of ['character.setIkKey','character.removeIkKey','character.clearIkKeys'])assert.equal(listed[id]?.available,true,id);
  // A key for the inactive character lands on its stored layer, from JSON.
  const before=f.binding.refresh().revision;
  const set=await run('character.setIkKey',{characterId:'actor-b',frame:7,tracks:{leftHand:{q:[q(),q(0,0,0.3826834,0.9238795),q()]},hips:{q:[q()],p:{x:0,y:0.9,z:0.05}}}});
  assert.equal(set.status,'applied',JSON.stringify(set));assert.deepEqual(set.affectedIds,['actor-b']);assert.deepEqual(set.revision,{before,after:before+1});
  assert.deepEqual(await frames('actor-b'),[7]);
  assert.deepEqual(layerB().keys.get(7).get('hips').p.toArray(),[0,0.9,0.05]);
  assert(Math.abs(layerB().keys.get(7).get('leftHand').q[1].z-0.3826834)<1e-6);
  assert(layerB().tracked.has('leftHand')&&layerB().tracked.has('hips'),'keyed tracks evaluate');
  assert.equal(f.scope.ikStateRef.current.keys.size,0,'the active layer is untouched');
  // The active character's key lands on the live layer.
  assert.equal((await run('character.setIkKey',{characterId:'actor-a',frame:3,tracks:{head:{q:[q(0,0.258819,0,0.9659258)]}}})).status,'applied');
  assert(f.scope.ikStateRef.current.keys.has(3));assert.deepEqual(await frames('actor-a'),[3]);
  // A second key at the same frame replaces only the tracks it names.
  assert.equal((await run('character.setIkKey',{characterId:'actor-b',frame:7,tracks:{rightFoot:{q:[q(),q(),q()]}}})).status,'applied');
  assert.deepEqual([...layerB().keys.get(7).keys()].sort(),['hips','leftHand','rightFoot']);
  const removed=await run('character.removeIkKey',{characterId:'actor-b',frame:7});
  assert.equal(removed.status,'applied',JSON.stringify(removed));assert.deepEqual(await frames('actor-b'),[]);
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:removed.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));
  assert.deepEqual(await frames('actor-b'),[7]);assert.equal(layerB().keys.get(7).size,3,'undo restores the inactive character\'s whole key');
  const cleared=await run('character.clearIkKeys',{characterId:'actor-a'});
  assert.equal(cleared.status,'applied',JSON.stringify(cleared));assert.deepEqual(await frames('actor-a'),[]);assert.equal(f.scope.ikStateRef.current.tracked.size,0);
  assert(f.actual.stepStudioHistory(false));assert.deepEqual(await frames('actor-a'),[3],'Ctrl+Z restores the cleared layer');
  // Refusals change nothing and say why.
  const depth=f.history.current.past.length;
  const refused=async(action,args,code)=>{const r=await run(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,`${action} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);assert.equal(r.mutated,false);};
  await refused('character.setIkKey',{characterId:'actor-a',frame:5,tracks:{leftHand:{q:[q()]}}},'INVALID_ARGUMENT');
  await refused('character.setIkKey',{characterId:'actor-a',frame:5,tracks:{}},'INVALID_ARGUMENT');
  await refused('character.setIkKey',{characterId:'actor-a',frame:5,tracks:{head:{}}},'INVALID_ARGUMENT');
  await refused('character.setIkKey',{characterId:'actor-a',frame:5,tracks:{head:{q:[q(0,0,0,0)]}}},'INVALID_ARGUMENT');
  await refused('character.setIkKey',{characterId:'actor-a',frame:48,tracks:{head:{q:[q()]}}},'INVALID_RANGE');
  await refused('character.setIkKey',{characterId:'ghost',frame:5,tracks:{head:{q:[q()]}}},'STALE_TARGET');
  await refused('character.removeIkKey',{characterId:'actor-a',frame:9},'STALE_TARGET');
  assert.equal(f.history.current.past.length,depth);
 },
 async 'arrange-local-space'(f){
  const made=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},name:'Chassis',position:{world:{x:4,y:0,z:1}},facing:{yawDeg:90}},{op:'create',source:{kind:'cube'},name:'Wheel',parent:'Chassis',space:'parent',position:{world:{x:1,y:0.5,z:0}}}]}));
  assert.equal(made.status,'applied',JSON.stringify(made));
  const [chassis,wheel]=made.affectedIds;
  const result=await f.call('inspect_studio',{scope:'entities',ids:[chassis,wheel]});
  const root=result.entities.find(row=>row.id===chassis),part=result.entities.find(row=>row.id===wheel);
  assert.equal(root.local,undefined,'a root carries no local transform');
  assert.deepEqual(part.position,{x:4,y:0.5,z:0},'local +X of a yaw-90 parent is world -Z');
  assert.equal(part.yawDeg,90);
  assert.deepEqual(part.local,{position:{x:1,y:0.5,z:0},rotationDeg:{x:0,y:0,z:0}});
 },
 async 'arrange-with-attached-prop'(f){
  // A prop riding a character is measured where it is drawn, so carrying it
  // never stops the agent from placing anything else.
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  const hand=await f.call('run_action',f.request('run_action',{action:'object.attach',args:{objectId:id,characterId:'actor-b',bone:'rightHand'}}));
  assert.equal(hand.status,'applied',JSON.stringify(hand));
  const placed=await f.call('arrange_objects',f.request('arrange_objects',createArgs));
  assert.equal(placed.ok,true,`an arrange still runs while a prop is carried: ${JSON.stringify(placed)}`);
  const verified=await f.call('verify_result',f.request('verify_result',{targets:placed.affectedIds,checks:['placement'],visual:'none'}));
  assert(verified.checks.placement.overlapIds.includes(id),`a cube dropped where the carried prop is drawn overlaps it: ${JSON.stringify(verified.checks.placement)}`);
 },
 async 'run-action-object-attach-and-undo'(f){
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  // A second, loose prop, made before anything is attached (arrange_objects
  // needs every prop's bounds, which an attached prop does not have here).
  const second=await f.call('arrange_objects',f.request('arrange_objects',{ops:[{op:'create',source:{kind:'cube'},position:{world:{x:-2,y:0,z:0}}}]}));assert.equal(second.ok,true,JSON.stringify(second));const loose=second.affectedIds[0];
  const object=()=>f.store.current.objects.find(o=>o.id===id);
  // Where the prop is drawn: its numbers, through the frame it rides.
  const shown=()=>{const o=object(),local=carried.sceneObjectMatrix(o,new THREE.Matrix4());if(o.attach)local.premultiply(carried.attachFrameMatrix(f.rigs[o.attach.characterId],o.attach.bone,new THREE.Matrix4()));return new THREE.Vector3().setFromMatrixPosition(local).toArray().map(v=>Math.round(v*1e4)/1e4+0);};
  assert.deepEqual(shown(),[2,0,0]);
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  assert.equal(listed['object.attach']?.available,true);assert.equal(listed['object.detach']?.available,false,'nothing rides a character yet');
  const before=f.binding.refresh().revision;
  const hand=await run('object.attach',{objectId:id,characterId:'actor-b',bone:'rightHand'});
  assert.equal(hand.status,'applied',JSON.stringify(hand));assert.deepEqual(hand.affectedIds,[id]);assert.deepEqual(hand.revision,{before,after:before+1});
  assert.deepEqual(object().attach,{characterId:'actor-b',bone:'rightHand'});
  assert.deepEqual(shown(),[2,0,0],'the prop keeps its place on screen');
  assert.deepEqual((await f.call('inspect_studio',{scope:'entities',ids:[id]})).entities[0].attachment,{characterId:'actor-b',bone:'rightHand'});
  // Bone to root on another character: one conversion from where it is drawn.
  const root=await run('object.attach',{objectId:id,characterId:'actor-a'});
  assert.equal(root.status,'applied',JSON.stringify(root));assert.deepEqual(object().attach,{characterId:'actor-a',bone:null});assert.deepEqual(shown(),[2,0,0]);
  assert.equal((await run('object.attach',{objectId:id,characterId:'actor-a'})).status,'noop');
  const detached=await run('object.detach',{objectId:id});
  assert.equal(detached.status,'applied',JSON.stringify(detached));assert.equal(object().attach,null);assert.deepEqual(shown(),[2,0,0]);
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:detached.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(object().attach,{characterId:'actor-a',bone:null});
  f.actual.undoScene();assert.deepEqual(object().attach,{characterId:'actor-b',bone:'rightHand'},'Ctrl+Z steps back through the attachments');
  // Refusals change nothing and say why.
  const depth=f.store.current.depths().past;
  const refused=async(action,args,code)=>{const r=await run(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,`${action} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);assert.equal(r.mutated,false);};
  await refused('object.attach',{objectId:loose,characterId:'ghost'},'STALE_TARGET');
  await refused('object.attach',{objectId:'missing',characterId:'actor-a'},'STALE_TARGET');
  await refused('object.attach',{objectId:loose,characterId:'actor-a',bone:'tail'},'INVALID_ARGUMENT');
  await refused('object.detach',{objectId:loose},'TARGET_NOT_READY');
  delete f.rigs['actor-b'];
  await refused('object.attach',{objectId:loose,characterId:'actor-b',bone:'leftHand'},'TARGET_NOT_READY');
  assert.equal(f.store.current.depths().past,depth);
 },
 async 'ui-refusals-localized-or-silent'(){
  // The editor's UI door into the registry (runStudioAction) under the Korean
  // locale. A refusal written for the model never reaches a person: the UI
  // toasts only the localized text the thrower attached, and is otherwise as
  // silent as the old handlers were. The model keeps its English message.
  const f=fixture({korean:true});
  try {
   const ui=(id,args)=>{f.values.setToast=undefined;return f.actual.runStudioAction(id,args);};
   const agent=(id,args,pattern)=>assert.throws(()=>f.registry.run(id,args),e=>e.code==='TARGET_NOT_READY'&&pattern.test(e.message)&&!/[\uac00-\ud7a3]/.test(e.message),`${id} tells the model in English`);
   // + Add shot with no free room: the take grows at its end and the Shot lands there, never a silent no-op.
   const whole=createShot('Whole',0,47,[]);f.scope.setShots([whole]);f.live.current.shots=[whole];
   assert.equal(ui('shot.create')?.ok,true,'a full take grows for the new shot');assert.equal(f.values.setToast,undefined,'and says nothing it need not');
   // Ctrl+D with nothing selected: silent.
   assert.equal((await f.call('arrange_objects',f.request('arrange_objects',createArgs))).ok,true);
   assert.equal(ui('object.duplicate'),null);assert.equal(f.values.setToast,undefined,'duplicate with nothing selected stays silent');
   agent('object.duplicate',{},/select an object/);
   // The waypoint cap: its original Korean toast.
   f.scope.setCharacters(f.characterRef.current.map(c=>c.id==='actor-a'?{...c,layer:{...c.layer,waypoints:Array.from({length:32},(_,i)=>({id:`waypoint-${i}`,frame:i+1,x:0,z:0,heading:null}))}}:c));
   const pin={characterId:'actor-a',position:{x:1,z:0}};
   assert.equal(ui('character.addWaypoint',pin),null);assert.equal(f.values.setToast,'루트 경로는 웨이포인트 32개까지 사용할 수 있어요');
   agent('character.addWaypoint',pin,/capped at 32 waypoints/);
   assert.equal(f.history.current.past.length,0,'no refusal records history');
  } finally { f.dispose(); }
 },
 async 'run-action-shot-camera-rail-and-undo'(f){
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const shot=createShot('Dolly',0,47,[]);f.scope.setShots([shot]);f.live.current.shots=[shot];
  const rails=async()=>(await f.call('inspect_studio',{scope:'shot'})).document.shots.map(s=>({mode:s.camera.mode,rail:s.camera.cameraRail??null}));
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  assert.equal(listed['shot.setCameraRail']?.available,true);assert.equal(listed['shot.clearCameraRail']?.available,false,'no shot has a rail yet');
  const before=f.binding.refresh().revision;
  const laid=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-2,z:4},{x:0,z:5},{x:2,z:4}]});
  assert.equal(laid.status,'applied',JSON.stringify(laid));assert.deepEqual(laid.affectedIds,[shot.id]);assert.deepEqual(laid.revision,{before,after:before+1});
  assert.deepEqual(await rails(),[{mode:'rail',rail:[{x:-2,z:4},{x:0,z:5},{x:2,z:4}]}]);
  assert.equal(f.scope.shotsDomain.documentStore.depths().past,1,'one owned Ctrl+Z entry');
  assert.equal((await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-3,z:3},{x:3,z:3}]})).status,'applied');
  assert.deepEqual((await rails())[0].rail,[{x:-3,z:3},{x:3,z:3}],'a new rail replaces the old one');
  const cleared=await run('shot.clearCameraRail',{shotId:shot.id});
  assert.equal(cleared.status,'applied',JSON.stringify(cleared));
  const bare=(await rails())[0];assert.equal(bare.rail,null);assert.notEqual(bare.mode,'rail');
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:cleared.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(await rails(),[{mode:'rail',rail:[{x:-3,z:3},{x:3,z:3}]}]);
  assert(f.actual.stepStudioHistory(false));assert.deepEqual((await rails())[0].rail,[{x:-2,z:4},{x:0,z:5},{x:2,z:4}]);
  // Refusals change nothing and say why.
  const depth=f.scope.shotsDomain.documentStore.depths().past;
  const refused=async(action,args,code)=>{const r=await run(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,`${action} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);assert.equal(r.mutated,false);};
  await refused('shot.setCameraRail',{shotId:shot.id,points:[{x:0,z:0}]},'INVALID_ARGUMENT');
  await refused('shot.setCameraRail',{shotId:'shot-ghost',points:[{x:0,z:0},{x:1,z:0}]},'STALE_TARGET');
  await refused('shot.clearCameraRail',{shotId:'shot-ghost'},'STALE_TARGET');
  assert.equal(f.scope.shotsDomain.documentStore.depths().past,depth);
 },
 async 'run-action-shot-camera-rail-aim-lens-and-key-stops'(f){
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const camera=async()=>(await f.call('inspect_studio',{scope:'shot'})).document.shots[0];
  const shot=createShot('Orbit',0,47,[]);f.scope.setShots([shot]);f.live.current.shots=[shot];
  // Keys written through a move halt it at each inner key: the receipt says so.
  const keyed=await run('shot.set',{id:shot.id,set:{cameraKeys:[0,12,24,36,47].map((frame,i)=>({id:`camera-key-${i}`,frame,framing:{pos:{x:i*0.5,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40}}))}});
  assert.equal(keyed.status,'applied',JSON.stringify(keyed));assert.deepEqual(keyed.warnings.map(w=>[w.code,w.count]),[['CAMERA_KEY_STOPS',3]]);
  // One rail call lays the whole move: the keys it covers go, and the answer names the move.
  const laid=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-2,z:4},{x:2,z:4}],height:2.5,aim:['actor-a','actor-b'],focalMm:35});
  assert.equal(laid.status,'applied',JSON.stringify(laid));
  assert.match(laid.summary,/4\.0 m over 2\.0 s \(2\.00 m\/s\), height 2\.50 m, aim actor-a, actor-b, 35 mm; 5 camera keys removed\.$/,laid.summary);
  let read=await camera();
  assert.deepEqual({mode:read.camera.mode,aim:read.camera.aim,focalMm:read.camera.focalMm,crane:read.camera.craneHeight,keys:read.cameraKeys.length},
   {mode:'rail',aim:{ids:['actor-a','actor-b']},focalMm:35,crane:{points:[{t:0,height:2.5},{t:1,height:2.5}]},keys:0});
  // A re-laid rail keeps the aim, height and lens it is not given; null clears them; a world point aims there.
  assert.equal((await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-3,z:4},{x:3,z:4}]})).status,'applied');
  read=await camera();assert.deepEqual([read.camera.aim,read.camera.focalMm,read.camera.craneHeight.points[0].height],[{ids:['actor-a','actor-b']},35,2.5]);
  const low=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-3,z:4},{x:3,z:4}],aimHeight:0.9});
  assert.match(low.summary,/aim actor-a, actor-b at 0\.90 m, 35 mm\.$/,low.summary);assert.deepEqual((await camera()).camera.aim,{ids:['actor-a','actor-b'],height:0.9},'aimHeight lowers the kept cast aim');
  const point=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-3,z:4},{x:3,z:4}],aim:{x:0,y:1,z:0},focalMm:null,height:[{t:0,height:0.6},{t:1,height:3}]});
  assert.match(point.summary,/height 0\.60-3\.00 m, aim \(0\.00, 1\.00, 0\.00\), scene lens\.$/,point.summary);
  read=await camera();assert.deepEqual([read.camera.aim,'focalMm' in read.camera],[{point:{x:0,y:1,z:0}},false]);
  // Past the dolly's speed cap it warns; an aim that is not in the scene is refused.
  const fast=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-10,z:4},{x:10,z:4}]});
  assert.deepEqual(fast.warnings.map(w=>w.code),['RAIL_TOO_FAST'],JSON.stringify(fast));
  const ghost=await run('shot.setCameraRail',{shotId:shot.id,points:[{x:-2,z:4},{x:2,z:4}],aim:['actor-ghost']});
  assert.equal(ghost.ok,false);assert.equal(ghost.code,'STALE_TARGET',JSON.stringify(ghost));
  // frame_shot answers what it measured; on a rail shot it says the rail stopped driving it.
  const frame=(keyAtFrame,x)=>f.call('frame_shot',f.request('frame_shot',{shotId:shot.id,subjectIds:['actor-a'],keyAtFrame,framing:{exact:{position:{x,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
  const first=await frame(0,-2);
  assert.equal(first.ok,true,JSON.stringify(first));assert.deepEqual(first.warnings.map(w=>w.code),['RAIL_REPLACED']);
  assert.match(first.summary,/^Framed Orbit \[0, 48\): (wide|medium|extreme)[a-z -]* at frame 0, 1 camera key\.$/,first.summary);
  assert.equal(typeof first.checks.derivedSize,'string');assert.equal(typeof first.checks.screenFraction,'number');
  assert.deepEqual((await frame(47,2)).warnings,[],'a two-key move is clean');
  assert.deepEqual((await frame(24,0)).warnings.map(w=>[w.code,w.count]),[['CAMERA_KEY_STOPS',1]],'a key in the middle of the move stops it');
 },
 async 'run-action-view-toggles'(f){
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  for(const id of ['view.setPartColours','view.setGuideMode','view.setInset'])assert.equal(listed[id]?.available,true,id);
  const before=f.binding.refresh().revision;
  const colours=await run('view.setPartColours',{mode:'flat'});
  assert.equal(colours.status,'transient',JSON.stringify(colours));assert.equal(colours.action,'view.setPartColours');
  assert.deepEqual(colours.revision,{before,after:before},'a viewer preference is not an authored edit');assert.equal(colours.undo,null);
  assert.equal(f.values.setPartColoursEnabled,true);assert.equal(f.values.setPartColoursMode,'flat');assert.match(colours.summary,/flat/);
  assert.equal((await run('view.setPartColours',{mode:'off'})).status,'transient');assert.equal(f.values.setPartColoursEnabled,false);
  const guide=await run('view.setGuideMode',{mode:'thirds'});
  assert.equal(guide.status,'transient',JSON.stringify(guide));assert.equal(f.values.setGuideMode,'thirds');
  assert.equal((await run('view.setInset',{collapsed:true})).status,'transient');assert.equal(f.values.setWorkspaceLayout.insetCollapsed,true);
  assert.equal((await run('view.setInset',{collapsed:false})).status,'transient');assert.equal(f.values.setWorkspaceLayout.insetCollapsed,false);
  assert.equal(f.history.current.past.length,0,'no undo entry');
  const refused=await run('view.setGuideMode',{mode:'fibonacci'});assert.equal(refused.code,'INVALID_ARGUMENT',JSON.stringify(refused));
 },
 async 'run-action-export-shot-video'(f){
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const listed=async()=>Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  assert.equal((await listed())['export.shotVideo']?.available,false,'nothing to record yet');
  const shot=createShot('Hero',0,23,[]);f.scope.setShots([shot]);f.live.current.shots=[shot];
  assert.equal((await listed())['export.shotVideo']?.available,true);
  const before=f.binding.refresh().revision;
  // The job runs to its end and answers with the file it produced.
  const done=await run('export.shotVideo',{shotId:shot.id});
  assert.deepEqual({ok:done.ok,kind:done.kind,status:done.status,affectedIds:done.affectedIds,output:done.output},
   {ok:true,kind:'job',status:'completed',affectedIds:[shot.id],output:{fileName:'cozyclay-hero.mp4',frameCount:24}},JSON.stringify(done));
  assert.match(done.summary,/cozyclay-hero\.mp4/);
  assert.deepEqual(f.stand.exports,[{shotId:shot.id}],'the menu export ran for that shot');
  assert.equal(f.binding.refresh().revision,before,'an export authors nothing');assert.equal(f.history.current.past.length,0);
  // Refusals reach the model in English and change nothing.
  const refused=async(args,code,pattern)=>{const r=await run('export.shotVideo',args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);assert.match(r.message??'',pattern,JSON.stringify(r));};
  await refused({shotId:'shot-ghost'},'STALE_TARGET',/not in this scene/);
  f.stand.exportResult=null;await refused({},'TARGET_NOT_READY',/did not finish/);
  f.stand.exporting=true;await refused({},'TARGET_NOT_READY',/already running/);
  assert.equal(f.stand.exports.length,2,'a busy export never starts a second one');
  // The UI door (the Export menu's Video item) awaits the same action; its
  // refusals stay silent, as the menu always was.
  f.stand.exporting=false;f.stand.exportResult={fileName:'cozyclay-shot.mp4',frameCount:3};
  const ui=f.actual.runStudioAction('export.shotVideo',{});assert.equal(typeof ui?.then,'function');
  assert.deepEqual((await ui).output,{fileName:'cozyclay-shot.mp4',frameCount:3});
  f.stand.exportResult=null;f.values.setToast=undefined;
  assert.equal(await f.actual.runStudioAction('export.shotVideo',{}),null);assert.equal(f.values.setToast,undefined,'a failed export was already reported by the export panel');
 },
 async 'run-action-scenes'(f){
  // Scene rename now needs its real document owner, not the native-only adapter.
  f=(await import('./bus/project-fixture.mjs')).projectFixture({singleScene:true});
  try {
  const run=(action,args)=>f.call('run_action',f.request('run_action',{action,args}));
  const listed=async()=>Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  const names=()=>f.scope.scenesRef.current.map(s=>s.name);
  const first=await listed();
  assert.equal(first['scene.create']?.available,true);assert.equal(first['scene.rename']?.available,true);
  assert.equal(first['scene.switch']?.available,false,'one scene: nothing to switch to');assert.equal(first['scene.delete']?.available,false,'the last scene stays');
  const home=f.host();
  // A scene change answers the document identity later commands are admitted at.
  const created=await run('scene.create',{});
  assert.deepEqual({ok:created.ok,kind:created.kind,status:created.status},{ok:true,kind:'document',status:'completed'},JSON.stringify(created));
  const second=f.scope.scenesRef.current[1];
  assert.deepEqual(names(),['Fixture','SCENE 01']);assert.deepEqual(created.affectedIds,[second.id]);
  assert.deepEqual(created.host,f.host(),'the receipt carries the new open scene');assert.equal(created.host.sceneId,second.id);
  assert.equal(created.host.workspaceId,home.workspaceId);assert.notEqual(created.host.sceneEpoch,home.sceneEpoch);
  assert.equal(f.stand.renders,1,'a scene change answers after the editor rendered it');
  const back=await run('scene.switch',{sceneId:'scene'});
  assert.equal(back.status,'completed',JSON.stringify(back));assert.equal(back.host.sceneId,'scene');assert.match(back.summary,/Fixture/);
  const copy=await run('scene.duplicate',{sceneId:'scene'});
  assert.equal(copy.status,'completed',JSON.stringify(copy));assert.deepEqual(names(),['Fixture','Fixture 2','SCENE 01'],'the copy sits after its source');
  assert.equal(copy.host.sceneId,f.scope.scenesRef.current[1].id,'the copy opens');
  const renamed=await run('scene.rename',{sceneId:second.id,name:'Rooftop'});
  assert.equal(renamed.status,'applied',JSON.stringify(renamed));assert.ok(renamed.undo?.historyEntryId);assert.deepEqual(renamed.host,f.host(),'a rename keeps the open scene');
  assert.deepEqual(names(),['Fixture','Fixture 2','Rooftop']);assert.deepEqual(renamed.affectedIds,[second.id]);
  const removed=await run('scene.delete',{sceneId:copy.host.sceneId});
  assert.equal(removed.status,'completed',JSON.stringify(removed));assert.deepEqual(names(),['Fixture','Rooftop']);
  assert.equal(removed.host.sceneId,second.id,'deleting the open scene opens its neighbour');
  const other=await run('scene.delete',{sceneId:'scene'});
  assert.equal(other.status,'completed',JSON.stringify(other));assert.deepEqual(other.host,f.host(),'deleting another scene keeps the open one');
  assert.equal(f.stand.renders,4);assert.equal(f.history.current.past.length,0,'scenes are outside the undo history');
  // Refusals reach the model in English and change nothing.
  const refused=async(action,args,code,pattern)=>{const r=await run(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);assert.match(r.message??'',pattern,JSON.stringify(r));};
  await refused('scene.delete',{sceneId:second.id},'TARGET_NOT_READY',/last scene/);
  await refused('scene.switch',{sceneId:second.id},'TARGET_NOT_READY',/one scene/);
  await refused('scene.rename',{sceneId:'scene-ghost',name:'X'},'STALE_TARGET',/not in this project/);
  assert.deepEqual(names(),['Rooftop']);
  // The UI doors: the scene pill's and the Hierarchy scene menu's callbacks
  // dispatch the same actions, and a refusal there stays silent as it always was.
  await f.actual.createSceneDocumentFromUi();assert.deepEqual(names(),['Rooftop','SCENE 01']);
  const added=f.scope.scenesRef.current[1].id;
  await f.actual.renameSceneDocumentFromUi(added,'Alley');assert.deepEqual(names(),['Rooftop','Alley']);
  await f.actual.selectSceneDocument(second.id);assert.equal(f.host().sceneId,second.id);
  await f.actual.duplicateSceneDocumentFromUi(second.id);assert.deepEqual(names(),['Rooftop','Rooftop 2','Alley']);
  await f.actual.deleteSceneDocumentFromUi(f.host().sceneId);assert.deepEqual(names(),['Rooftop','Alley']);
  f.values.setToast=undefined;assert.equal(await f.actual.selectSceneDocument('scene-ghost'),null);assert.equal(f.values.setToast,undefined);
  } finally { f.dispose(); }
 },
 async 'run-action-project-save'(f){
  const run=()=>f.call('run_action',f.request('run_action',{action:'project.save',args:{}}));
  // A refusal carries its whole reason, in English, within the receipt's message.
  const refused=async(code,pattern)=>{const r=await run();assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);
   assert.match(r.message??'',pattern,JSON.stringify(r));assert.ok(!r.message.endsWith('\u2026'),`the reason fits the receipt: ${r.message}`);};
  // A named project with its file this session: saved there, like Save Project.
  const saved=await run();
  assert.deepEqual({ok:saved.ok,kind:saved.kind,status:saved.status,output:saved.output},{ok:true,kind:'document',status:'completed',output:{fileName:'Heist.cclayproject'}},JSON.stringify(saved));
  assert.match(saved.summary,/Heist\.cclayproject/);assert.deepEqual(f.stand.saves,[false],'the menu save, never Save As');
  // Choosing a file or re-granting one needs the user's click: refused before
  // any picker is attempted.
  f.stand.project.hasFile=false;await refused('TARGET_NOT_READY',/click/);
  f.stand.project.hasFile=true;f.stand.granted=false;await refused('TARGET_NOT_READY',/access/);
  assert.equal(f.stand.saves.length,1,'no save was attempted without a gesture');
  // An unnamed project: the editor opens its Save dialog for the user.
  f.stand.project={...f.stand.project,name:null};f.stand.saveOutcome={saved:false,naming:true};await refused('TARGET_NOT_READY',/name/);
  assert.equal(f.stand.saves.length,2,'the first save still opens the naming dialog');
  f.stand.project.name='Heist';f.stand.granted=true;
  f.stand.saveOutcome={saved:false,failure:'missing-resources'};await refused('TARGET_NOT_READY',/missing/);
  f.stand.saveOutcome={saved:false,cancelled:true};await refused('TARGET_NOT_READY',/closed/);
  // A browser without file access downloads the project instead.
  f.stand.project={name:'Heist',hasFile:false,fileAccess:false,gesture:false};f.stand.saveOutcome={saved:true,name:'Heist',fileName:'Heist.cclayproject',downloaded:true};
  const downloaded=await run();assert.equal(downloaded.status,'completed',JSON.stringify(downloaded));assert.match(downloaded.summary,/download/);
  // The UI door carries the user's click: it may choose the file itself.
  f.stand.project={name:'Heist',hasFile:false,fileAccess:true,gesture:true};f.stand.saveOutcome={saved:true,name:'Heist',fileName:'Heist 2.cclayproject'};
  assert.deepEqual((await f.actual.runStudioAction('project.save')).output,{fileName:'Heist 2.cclayproject'});
  f.stand.saveOutcome={saved:false,failure:'error'};f.values.setToast=undefined;
  assert.equal(await f.actual.runStudioAction('project.save'),null);assert.equal(f.values.setToast,undefined,'the save path already reported its failure');
  assert.equal(f.history.current.past.length,0,'saving authors nothing');
 },
 async 'run-action-asset-import-and-undo'(f){
  const run=args=>f.call('run_action',f.request('run_action',{action:'asset.import',args}));
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  assert.equal(listed['asset.import']?.available,true);
  const before=f.binding.refresh().revision;
  // A data URL goes straight to the editor's import path.
  const poster=await run({source:'data:image/png;base64,AAAA',name:'poster.png',placeAs:'backdrop'});
  assert.equal(poster.status,'completed',JSON.stringify(poster));assert.equal(poster.action,'asset.import');
  const placed=f.store.current.objects.at(-1);
  assert.deepEqual(poster.affectedIds,[placed.id]);assert.deepEqual(poster.revision,{before,after:before+1});assert.notEqual(poster.undo,null);
  assert.equal(poster.delta[0].after.patched.find(row=>row.path==='object.name').text,'poster.png');assert.match(poster.summary,/img-0a1b2c/);
  assert.deepEqual(f.stand.imports,[{name:'poster.png',placeAs:'backdrop',dataUrl:'data:image/png;base64,AAAA'}]);assert.deepEqual(f.stand.fetched,[]);
  // An http(s) URL is fetched by the editor, then imported the same way.
  const chair=await run({source:'https://example.test/chair.glb',name:'chair.glb',placeAs:'mesh'});
  assert.equal(chair.status,'completed',JSON.stringify(chair));
  assert.deepEqual(f.stand.fetched,['https://example.test/chair.glb']);
  assert.deepEqual(f.stand.imports[1],{name:'chair.glb',placeAs:'mesh',dataUrl:'data:model/gltf-binary;base64,Z2xURg=='});
  assert.equal(f.store.current.objects.length,2);
  // undo_edit reverts the import; Ctrl+Z then the one before it.
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:chair.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(f.store.current.objects.map(o=>o.id),[placed.id]);
  f.actual.undoScene();assert.deepEqual(f.store.current.objects,[]);
  // Refusals reach the model in English and place nothing.
  const depth=f.store.current.depths().past;
  const refused=async(args,code,pattern)=>{const r=await run(args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);assert.match(r.message??'',pattern,JSON.stringify(r));};
  await refused({source:'https://example.test/missing.png',name:'missing.png',placeAs:'cutout'},'TARGET_NOT_READY',/fetch/);
  f.stand.importError='dataUrl must be an image data URL';
  await refused({source:'data:text/plain;base64,AAAA',name:'notes.txt',placeAs:'cutout'},'INVALID_ARGUMENT',/image data URL/);
  await refused({source:'/Users/me/poster.png',name:'poster.png',placeAs:'cutout'},'INVALID_ARGUMENT',/.+/);
  assert.equal(f.store.current.depths().past,depth);assert.deepEqual(f.store.current.objects,[]);
 },
 async 'run-action-ai-prepare-shot'(f){
  const run=args=>f.call('run_action',f.request('run_action',{action:'ai.prepareShot',args}));
  const listed=Object.fromEntries((await f.call('inspect_studio',{scope:'actions'})).actions.map(a=>[a.id,a]));
  assert.equal(listed['ai.prepareShot']?.available,true,JSON.stringify(listed['ai.prepareShot']));
  const before=f.binding.refresh().revision;
  const shown=()=>f.values.setResult;
  const frames=result=>(result.frame?1:0)+(result.frameB?1:0);
  const hero={id:f.scope.activeShot.id,name:'Hero',range:{startFrame:0,endFrameExclusive:24}};
  // The Studio's current choice (an image prompt for GPT Image 2), built and
  // shown by the editor's own generate().
  const image=await run({});
  assert.deepEqual({ok:image.ok,kind:image.kind,status:image.status},{ok:true,kind:'job',status:'completed'},JSON.stringify(image));
  assert.equal(f.values.setResultOpen,true,'the result panel opens');
  assert.equal(shown().mode,'image');assert.equal(shown().modelLabel,'GPT Image 2');assert.match(shown().frame,/^data:image\/png;base64,/);
  assert.deepEqual(image.output,{prompt:shown().prompt,mode:'image',modelLabel:'GPT Image 2',shot:hero,aspectRatio:'16:9',cameraMode:'keys',referenceFrames:frames(shown())},JSON.stringify(image.output));
  assert.match(image.output.prompt,/a woman in a red coat, arms crossed/);
  assert(!JSON.stringify(image).includes('data:image'),'the frames stay in the Studio');
  assert.deepEqual(f.stand.captures,[f.scope.cameraKeys[0].framing,f.scope.cameraKeys[1].framing],'the frames are rendered from the shot\'s camera keys');
  assert.deepEqual(f.stand.clipboard,[image.output.prompt],'the prompt goes to the clipboard like the button\'s');
  assert.equal(f.stand.renders,0,'an unchanged choice needs no render');
  // A model changes what generate() reads, so it runs once React has rendered it.
  const flux=await run({model:'flux_2'});
  assert.equal(flux.status,'completed',JSON.stringify(flux));
  assert.equal(shown().modelLabel,'Flux 2');assert.equal(flux.output.modelLabel,'Flux 2');assert.match(flux.output.prompt,/f\/2\.2/);
  assert.equal(f.stand.renders,1);
  // A commit that predates the new mode is waited past.
  f.stand.staleCommits=1;
  const video=await run({mode:'video'});
  assert.equal(video.status,'completed',JSON.stringify(video));
  assert.deepEqual({mode:video.output.mode,modelLabel:video.output.modelLabel,shownMode:shown().mode},{mode:'video',modelLabel:null,shownMode:'video'});
  assert.match(video.output.prompt,/Camera move: a slow push-in toward the subject\./);
  assert.equal(video.output.referenceFrames,2);assert.equal(f.stand.renders,3);
  assert.equal(f.binding.refresh().revision,before,'nothing is authored');assert.equal(f.history.current.past.length,0);
  // Refusals reach the model in English and show nothing new.
  const last=shown();
  const refused=async(args,code,pattern)=>{const r=await run(args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);assert.match(r.message??'',pattern,JSON.stringify(r));};
  await refused({mode:'video',model:'flux_2'},'INVALID_ARGUMENT',/image/);
  await refused({model:'flux_2'},'INVALID_ARGUMENT',/image/);
  await refused({model:'midjourney'},'INVALID_ARGUMENT',/.+/);
  assert.strictEqual(shown(),last);
 },
 async 'stale-receipt-undo'(f){const first=await f.call('arrange_objects',f.request('arrange_objects',createArgs));await f.call('arrange_objects',f.request('arrange_objects',createArgs));const before=f.store.current.objects;const r=await f.call('undo_edit',f.request('undo_edit',{receiptId:first.receiptId}));assert.equal(r.code,'UNDO_CONFLICT');assert.strictEqual(f.store.current.objects,before);},
 async 'reverted-edit-invalidates-target'(f){const token=f.binding.guard('actor-a').token,original=f.characterRef.current;f.actual.publishStudioCharacters(original.map(c=>c.id==='actor-a'?{...c,x:1}:c),true);f.actual.publishStudioCharacters(original,true);assert.notEqual(f.binding.guard('actor-a').token,token,'editing and reverting must not revive an admitted target');},
 async 'targeted-commit-and-undo'(f){const before=f.store.current.objects;const r=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.revision.after,1);assert.equal(f.store.current.depths().past,1);assert.equal(f.store.current.objects[0].x,2);assert.equal(f.scope.appContext.storeDomain('objects').documentStore.getSnapshot().revision,1);assert.equal(f.semantic.length,0,'objects no longer publish through the native semantic-state adapter');const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.strictEqual(f.store.current.objects,before);},
 async 'stale-target-and-epoch'(f){const r=f.request('arrange_characters',{ops:[{op:'update',characterId:'actor-a',position:{world:{x:1,y:0,z:0}}}]});f.scope.studioSceneEpochRef.current='new-epoch';const result=await f.call('arrange_characters',r);assert.equal(result.code,'STALE_SCENE');assert.equal(f.history.current.past.length,0);},
 async 'mid-gesture-target'(f){f.scope.ikBodyDragRef.current=true;const r=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(r.code,'TARGET_BUSY');assert.equal(f.store.current.depths().past,0);},
 async 'lost-acknowledgement'(f){const request=f.request('arrange_objects',createArgs);const r=await f.call('arrange_objects',request);assert(r.ok);const replay=await f.call('reconcile_studio_command',{host:f.host(),commandId:request.commandId});assert.equal(replay.status,'applied');assert.deepEqual(replay.receipt,r);assert.deepEqual(await f.call('arrange_objects',request),r);assert.equal(f.store.current.depths().past,1);assert.equal((await f.call('reconcile_studio_command',{host:f.host(),commandId:'unknown'})).status,'unknown');},
 async 'camera-undo'(f){const before=f.actual.snapshotStudioDomain('shot');const r=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:0,framing:{exact:{position:{x:0,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(f.live.current.shots[0].cameraKeys.length,1);assert.equal(f.scope.shotsDomain.documentStore.depths().past,1);assert.equal(f.history.current.past.length,0);assert(f.actual.stepStudioHistory(false));assert.deepEqual(f.live.current.shots,before.shots);assert.deepEqual(f.scope.shotCamRef.current.position.toArray(),Object.values(before.camera.position));assert(Math.abs(f.scope.shotCamRef.current.fov-focalMmToFov(before.camera.focalMm,'fullFrame',16/9)*180/Math.PI)<1e-9);},
 async 'still-frame-shot-camera-key'(f){
  const keyA={pos:{x:0,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40}, keyB={pos:{x:0.5,y:1.6,z:3},yaw:0,pitch:0,fovDeg:40};
  const first={...createShot('Still A',0,23,[{frame:0,framing:keyA}]),kind:'still'};
  const second={...createShot('Still B',24,47,[{frame:24,framing:keyB}]),kind:'still'};
  f.scope.setShots([first,second]);f.live.current.shots=[first,second];
  const beforeFirst=structuredClone(f.live.current.shots[0].cameraKeys[0]), beforeSecond=structuredClone(f.live.current.shots[1].cameraKeys[0]);
  const r=await f.call('frame_shot',f.request('frame_shot',{shotId:first.id,subjectIds:['actor-a'],framing:{exact:{position:{x:2,y:2,z:4},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
  assert.equal(r.ok,true,JSON.stringify(r));
  const afterFirst=f.live.current.shots[0].cameraKeys[0], afterSecond=f.live.current.shots[1].cameraKeys[0];
  assert.equal(afterFirst.id,beforeFirst.id);assert.equal(afterFirst.frame,beforeFirst.frame);
  assert.notDeepEqual(afterFirst.framing,beforeFirst.framing);
  assert.deepEqual(afterSecond,beforeSecond);
  // #863: the retained key's receipt delta is its shot readback, never a removal marker.
  const keyDelta=r.delta.find(row=>row.id===afterFirst.id);
  assert(keyDelta,JSON.stringify(r.delta));assert.deepEqual(keyDelta.after,{shotId:first.id,frame:0});
  console.log(`STILL FRAME SHOT CAMERA KEY first=${JSON.stringify(afterFirst.framing.pos)} previous=${JSON.stringify(afterSecond.framing.pos)} keyIdPreserved=true untouched=true`);
 },
 async 'clip-frame-shot-camera-key'(f){
  const first={...createShot('Clip',0,23,[{id:'camera-key-clip-0',frame:0,framing:{pos:{x:0,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40}}]),kind:'clip'};
  f.scope.setShots([first]);f.live.current.shots=[first];
  const before=f.live.current.shots[0].cameraKeys[0];
  const r=await f.call('frame_shot',f.request('frame_shot',{shotId:first.id,subjectIds:['actor-a'],keyAtFrame:12,framing:{exact:{position:{x:2,y:2,z:4},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.notEqual(r.affectedIds[1],before.id,'frame_shot must allocate a distinct clip key ID');
  const keys=f.live.current.shots[0].cameraKeys;
  assert.equal(keys.length,2);assert.deepEqual(keys.map(key=>key.frame),[0,12]);
  assert.equal(new Set(keys.map(key=>key.id)).size,2);
  assert.equal(keys.find(key=>key.frame===0).id,'camera-key-clip-0');
  const added=keys.find(key=>key.frame===12);
  assert.deepEqual(r.delta.find(row=>row.id===added.id)?.after,{shotId:first.id,frame:12},JSON.stringify(r.delta));
  const gone=await f.call('run_action',f.request('run_action',{action:'shot.remove',args:{shotId:first.id}}));
  // A genuine removal stays distinguishable from a retained key.
  assert.equal(gone.ok,true,JSON.stringify(gone));assert.deepEqual(gone.delta.find(row=>row.id===first.id)?.after,{removed:true},JSON.stringify(gone.delta));
  console.log(`CLIP FRAME SHOT CAMERA KEYS frames=${JSON.stringify(keys.map(key=>key.frame))} distinctIds=true originalPreserved=true`);
 },
 async 'rail-camera-undo'(f){await railCameraUndo(f,false);},
 async 'rail-camera-undo-after-object-undo'(f){await railCameraUndo(f,true);},
 async 'context-revisions'(f){const before=f.binding.context();assert.equal(before.host.workspaceHandle,'handle');f.binding.handlers.operate_studio(f.request('operate_studio',{frame:3}));const view=f.binding.context();assert.equal(view.revision.scene,before.revision.scene);assert.equal(view.revision.physics,before.revision.physics);assert(view.revision.view>before.revision.view);assert.equal(view.entities.find(e=>e.id==='actor-a').token,before.entities.find(e=>e.id==='actor-a').token);f.scope.ikStatesRef.current.set('actor-b',{...ik.createIkState(),keys:new Map([[1,new Map([['hips',{p:new THREE.Vector3(0,1,0),q:[new THREE.Quaternion()]}]])]])});const changed=f.binding.context();assert(changed.revision.physics>view.revision.physics);assert.notEqual(changed.entities.find(e=>e.id==='actor-b').token,view.entities.find(e=>e.id==='actor-b').token);},
 async 'recreated-motion-read-and-verify'(f){const baseline=f.binding.context();const equivalent=()=>({...clip(),studioTakeId:'equivalent-take'});f.buffer.current.motion=equivalent();const first=f.binding.context();assert.equal(first.revision.scene,baseline.revision.scene);assert.equal(first.recentReceipts.length,0);f.buffer.current.motion=equivalent();const second=f.binding.context();assert.equal(second.revision.scene,baseline.revision.scene);assert.equal(second.recentReceipts.length,0);const mutation=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(mutation.ok,true,JSON.stringify(mutation));assert.equal(mutation.revision.before,baseline.revision.scene);assert.equal(mutation.revision.after,baseline.revision.scene+1);const verified=await f.call('verify_result',f.request('verify_result',{receiptId:mutation.receiptId,checks:['placement'],visual:'none'}));assert.equal(verified.receiptId,mutation.receiptId);assert.equal(verified.revision,mutation.revision.after);assert.equal(verified.stale,false,'verify_result must not be stale after an immediate authored receipt');}
};
let passed=0;
const failures=[];
for(const name of argv.length?[argv[1]]:cases){const f=fixture();try{await implementations[name](f);console.log('PASS',name);passed++;}catch(error){failures.push(name);console.error('FAIL',name,error);}finally{f.dispose();}}
console.log(`Studio App binding: ${passed}/${argv.length?1:cases.length} passed`);
assert.deepEqual(failures, []);
