import { useEffect, useRef, useState } from 'react';
import { aimAt } from '../controls.jsx';
import { PRESETS, DEFAULT_DURATION_S, TIMELINE_FPS } from '../app-stage.jsx';
import { usePlaybackFrameState } from '../motion/playback-frame-store.js';
import { CAMERA_MOVES, SUBJECT_HEIGHT_M, focalMmToFov, fovToFocalMm } from '../shot.js';
import { CAMERA_PRESETS, cameraPresetFraming } from '../camera-move.js';
import { createDocumentStore } from '../document-store.js';
import { useDocumentDomain } from '../store/use-document-store.js';
import { frameDraft } from '../studio-agent-commands.js';
import { StudioProtocolError } from '../studio-agent-protocol.js';
import { createShotAuthoringDocument, readShotAuthoring, readShotAuthoringDocument, SHOT_AUTHORING_KEY,
  SHOT_AUTHORING_LEGACY_KEYS, SHOT_AUTHORING_QUARANTINE_KEY } from '../shot-authoring.js';
import { shotIndexAtFrame } from '../cuts.js';
import { createCameraBlock, updateCameraBlock } from '../camera-block.js';
import { followFramingFromCamera, craneHeightAt, buildRail, simplifyStroke } from '../camera-follow.js';
import { defaultRailRange, clampRailRange } from '../camera-rail-schedule.js';
import { timelineSpan, timelineContentExtent } from '../timeline-extent.js';
import { trackFeature } from '../analytics.js';
import { ko } from '../locale.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function normalizeState(value) {
  const document = createShotAuthoringDocument(value);
  const shots = document.shots.map(shot => {
    const follow = shot.camera.railFollow;
    if (follow?.mode !== 'range') return shot;
    return { ...shot, camera: updateCameraBlock(shot.camera, { railFollow: { mode: 'range', ...clampRailRange(follow, shot.endFrame - shot.startFrame + 1) } }) };
  });
  return { ...value, shots, frameCount: document.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS };
}

// The stable handle survives scene loads. Camera pose belongs to the same
// history entry as the shot it frames; only the persisted shots are projected.
function createShotsDomain(appContext, initial = {}) {
  const initialState = value => normalizeState({ shots: [], frameCount: DEFAULT_DURATION_S * TIMELINE_FPS,
    cameraMove: CAMERA_MOVES[1], fovDeg: PRESETS.medium.fov, camera: null, manual: false, ...value });
  let native = createDocumentStore({ owned: { shot: initialState(initial) } });
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  let release = native.subscribe(notify), loading = false;
  const documentStore = { ...Object.fromEntries(Object.keys(native).map(key => [key, (...args) => native[key](...args)])),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const state = () => documentStore.read('shot');
  const read = () => state().shots;
  function writeState(update) {
    return documentStore.write('shot', before => {
      const next = normalizeState(typeof update === 'function' ? update(before) : update);
      return same(before, next) ? before : next;
    });
  }
  const write = update => writeState(before => ({ ...before, shots: typeof update === 'function' ? update(before.shots) : update }));
  function renderCamera(camera, manual, fovDeg) {
    const angles = aimAt(camera.position, camera.lookAt), shared = appContext.shared;
    Object.assign(shared.look.current, angles, { roll: 0 });
    shared.shotCameraPosRef.current = { ...camera.position };
    const mounted = shared.shotCamRef.current;
    if (mounted) {
      mounted.position.copy(camera.position); mounted.rotation.order = 'YXZ';
      mounted.rotation.set(angles.pitch, angles.yaw, 0); mounted.fov = fovDeg; mounted.updateProjectionMatrix();
    }
    shared.manualCameraOverrideRef.current = manual;
    shared.setCameraPos(camera.position);
    appContext.patchLive({ camera: camera.position, studioCamera: camera });
  }
  let previous = state();
  const publish = () => {
    const next = state(), live = appContext.live.state;
    if (live) {
      appContext.patchLive({ shots: next.shots, fovDeg: next.fovDeg });
      appContext.patchTimeline({ frameCount: next.frameCount });
      if (next.camera && (!same(previous.camera, next.camera) || previous.fovDeg !== next.fovDeg || previous.manual !== next.manual)) renderCamera(next.camera, next.manual, next.fovDeg);
      if (!loading && !same(previous, next)) appContext.shared.markSemanticEdit('shot', previous, next);
    }
    previous = next;
  };
  const unsubscribe = documentStore.subscribe(publish);
  function replaceState(next) {
    release(); native.dispose(); native = createDocumentStore({ owned: { shot: next } }); release = native.subscribe(notify);
  }
  function beginAction() {
    // The camera mounts after this hook. Capture its actual pose before the
    // first authored entry, rather than seeding a second camera at render time.
    if (!state().camera) {
      const live = appContext.ports.read();
      if (live.camera) {
        replaceState({ ...state(), camera: structuredClone(live.camera), manual: live.manual });
        previous = state();
      }
    }
    return documentStore.beginAction('shot');
  }
  function cameraPatch(camera, manual = true) {
    const filmback = appContext.live.state.filmback;
    const fovDeg = focalMmToFov(camera.focalMm, filmback.sensorId, filmback.aspectRatio) * 180 / Math.PI;
    if (fovDeg < 14 || fovDeg > 90) throw new StudioProtocolError('INVALID_ARGUMENT', 'focalMm is outside the editor lens range');
    return { camera, manual, fovDeg };
  }
  function commitDraft(draft) {
    writeState(before => ({ ...before, shots: draft.shotDocument.shots, ...cameraPatch(draft.camera, draft.manual) }));
  }
  function setPresetMetadata(cameraPresetId) {
    const stage = appContext.storeDomain('stage');
    if (!stage || stage.read().cameraPresetId === cameraPresetId) return [];
    appContext.recordAction('stage', () => stage.setCameraPresetId(cameraPresetId), null, true);
    return [appContext.ports.read().host.sceneId];
  }
  function frame(args) {
    const raw = appContext.ports.read(), filmback = raw.filmback, cameraPresetId = args.preset ?? null;
    if (args.preset !== undefined) {
      if (!CAMERA_PRESETS[args.preset]) throw new StudioProtocolError('INVALID_ARGUMENT', 'Unknown camera preset');
      const subject = raw.characters.find(row => row.id === raw.activeCharacterId) ?? raw.characters[0];
      const framing = cameraPresetFraming(args.preset, { x: subject?.x ?? 0, z: subject?.z ?? 0, height: SUBJECT_HEIGHT_M * (subject?.scale ?? 1) }, filmback);
      args = { subjectIds: [subject?.id], framing: { exact: { position: framing.pos,
        lookAt: { x: subject?.x ?? 0, y: SUBJECT_HEIGHT_M * (subject?.scale ?? 1) * 0.52, z: subject?.z ?? 0 }, focalMm: framing.focalMm } } };
    }
    const plan = frameDraft({ name: 'frame_shot', args }, { ...raw, camera: raw.camera ?? state().camera,
      frame: raw.view.frame, shotDocument: { shots: read() } }, { bounds: appContext.ports.bounds });
    commitDraft(plan.draft);
    return { ...plan, affectedIds: [...plan.affectedIds, ...setPresetMetadata(cameraPresetId)] };
  }
  function captureCamera(shotId) {
    const shared = appContext.shared, mounted = shared.shotCamRef.current;
    if (!mounted) return;
    const position = { x: mounted.position.x, y: mounted.position.y, z: mounted.position.z };
    const { yaw, pitch } = shared.look.current;
    const camera = { position, lookAt: { x: position.x - Math.sin(yaw) * Math.cos(pitch), y: position.y + Math.sin(pitch), z: position.z - Math.cos(yaw) * Math.cos(pitch) },
      focalMm: fovToFocalMm(mounted.fov * Math.PI / 180, appContext.live.state.filmback.sensorId, appContext.live.state.filmback.aspectRatio),
      sensorId: appContext.live.state.filmback.sensorId, slate: 'Shot camera' };
    writeState(before => {
      const subject = shared.motionPos ?? shared.charA, subjectYaw = (shared.charA.rot * Math.PI) / 180;
      const shots = before.shots.map(shot => {
        if (shot.id !== shotId) return shot;
        const followCam = createCameraBlock(shot.camera).followCam;
        const measured = followFramingFromCamera(position, pitch, subject, followCam.aimHeight, { x: Math.sin(subjectYaw), z: Math.cos(subjectYaw) });
        return { ...shot, camera: updateCameraBlock(shot.camera, { followCam: { ...followCam, ...measured } }) };
      });
      return { ...before, shots, ...cameraPatch(camera) };
    });
  }
  function setLens(fovDeg) {
    const before = state(), filmback = appContext.live.state.filmback;
    writeState({ ...before, fovDeg, camera: before.camera && { ...before.camera, focalMm: fovToFocalMm(fovDeg * Math.PI / 180, filmback.sensorId, filmback.aspectRatio) } });
  }
  function setCastOverride(shotId, characterId, override) {
    if (!read().some(shot => shot.id === shotId)) throw new StudioProtocolError('STALE_TARGET', `Shot ${shotId} is not in this scene.`);
    if (!appContext.live.characters.some(entry => entry.id === characterId)) throw new StudioProtocolError('STALE_TARGET', `Character ${characterId} is not in this scene.`);
    if (override !== null && (!override || !Number.isFinite(override.x) || !Number.isFinite(override.z) || !Number.isFinite(override.rot)
      || (override.posture !== undefined && !['stand', 'sit', 'lie'].includes(override.posture))
      || (override.pose !== undefined && (!override.pose || typeof override.pose !== 'object' || Array.isArray(override.pose))))) {
      throw new StudioProtocolError('INVALID_ARGUMENT', 'Cast override requires finite x, z and rot and valid posture/pose fields.');
    }
    return writeState(before => ({
      ...before,
      shots: before.shots.map(shot => {
        if (shot.id !== shotId) return shot;
        const cast = { ...shot.cast };
        if (override === null) delete cast[characterId];
        else cast[characterId] = structuredClone(override);
        return { ...shot, cast };
      }),
    }));
  }
  function placeCamera(args) {
    const before = appContext.ports.read().camera ?? state().camera;
    const position = { ...before.position, ...Object.fromEntries(['x', 'y', 'z'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
    const aim = ['lookAtX', 'lookAtY', 'lookAtZ'].filter(key => args[key] !== undefined);
    if (aim.length && aim.length !== 3) throw new StudioProtocolError('INVALID_ARGUMENT', 'Supply all three lookAt coordinates.');
    const lookAt = aim.length ? { x: args.lookAtX, y: args.lookAtY, z: args.lookAtZ } : Object.fromEntries(['x', 'y', 'z'].map(key => [key, position[key] + before.lookAt[key] - before.position[key]]));
    writeState(current => ({ ...current, ...cameraPatch({ ...before, position, lookAt, focalMm: args.focalMm ?? before.focalMm }) }));
    setPresetMetadata(null);
  }
  function run(id, args = {}) {
    const result = appContext.bus.run(id, args);
    if (!result.ok) throw new StudioProtocolError(result.code, result.message);
    return result;
  }
  let gesture = null;
  function finishGesture(cancel = false) {
    if (!gesture) return;
    const active = gesture; gesture = null; active.unsubscribe?.(); active.release();
    return active.txId ? run(cancel ? 'run.cancel' : 'run.commit', { txId: active.txId }) : undefined;
  }
  function beginGesture() {
    if (gesture) return;
    const commit = () => finishGesture(), cancel = () => finishGesture(true);
    const key = event => { if (event.key === 'Escape') cancel(); };
    const target = globalThis.window;
    const events = { pointerup: commit, pointercancel: cancel, blur: commit, keydown: key };
    for (const [name, handler] of Object.entries(events)) target?.addEventListener?.(name, handler);
    gesture = { release() { for (const [name, handler] of Object.entries(events)) target?.removeEventListener?.(name, handler); } };
  }
  function edit(id, args) {
    if (!gesture) return run(id, args);
    if (gesture.id && gesture.id !== id) { finishGesture(); beginGesture(); }
    if (!gesture.txId) {
      gesture.id = id; gesture.txId = run('run.begin', { id, args }).txId;
      gesture.unsubscribe = appContext.bus.subscribe(event => {
        if (event.type !== 'transaction.cancelled' || event.txId !== gesture?.txId) return;
        const active = gesture; gesture = null; active.unsubscribe(); active.release();
      });
    }
    return run('run.update', { txId: gesture.txId, args });
  }
  const domain = { documentStore, state, read, write, writeState, setCastOverride, beginAction, run, edit, beginGesture, finishGesture,
    bindRender(context) { appContext = context; },
    capture: () => appContext.shared.captureCurrentFraming(), frame, captureCamera, placeCamera, setLens, renderCamera,
    canUndo: id => documentStore.canUndo(id), stepHistory: redo => { finishGesture(); return Boolean((redo ? documentStore.redo : documentStore.undo)()); },
    document: () => ({ shots: read() }), publish: value => writeState(before => ({ ...before, shots: value.shots, ...cameraPatch(value.camera, value.manual) })), commitDraft,
    load(value) { finishGesture(true); loading = true; try { replaceState(initialState(value)); notify(); } finally { loading = false; } },
    dispose() { finishGesture(true); unregister(); unsubscribe(); release(); native.dispose(); listeners.clear(); },
  };
  const unregister = appContext.registerStoreDomain('shot', domain);
  // Startup publication is non-authored and happens before the first bus read.
  loading = true; publish(); loading = false;
  return domain;
}

export function useShots(appContext) {
  const [shotStartup] = useState(() => {
    try {
      let sourceKey = SHOT_AUTHORING_KEY, raw = localStorage.getItem(sourceKey), loaded = readShotAuthoring(raw);
      for (const legacyKey of SHOT_AUTHORING_LEGACY_KEYS) {
        if (loaded.status !== 'absent') break;
        sourceKey = legacyKey; raw = localStorage.getItem(sourceKey); loaded = readShotAuthoring(raw);
      }
      if (loaded.status === 'corrupt') { localStorage.setItem(SHOT_AUTHORING_QUARANTINE_KEY, raw); localStorage.removeItem(sourceKey); return { state: null, saveBlocked: false }; }
      if (loaded.status === 'future') return { state: null, saveBlocked: true };
      return { state: loaded.state, saveBlocked: false };
    } catch { return { state: null, saveBlocked: false }; }
  });
  const startupShotState = readShotAuthoringDocument(appContext.shared.startupScene.shotDocument ?? undefined).state ?? shotStartup.state;
  const [domain] = useState(() => appContext.storeDomain('shot') ?? createShotsDomain(appContext, startupShotState ?? {}));
  domain.bindRender(appContext);
  const { shots, frameCount: tlFrameCount, fovDeg, cameraMove } = useDocumentDomain(domain.documentStore, 'shot');
  const [customMove] = useState('');
  const [movePlaying, setMovePlaying] = useState(false);
  const [moveFollow] = useState(true);
  const [railDraw, setRailDraw] = useState(false);
  const [craneSelectedIndex, setCraneSelectedIndex] = useState(null);
  const [tlFrame, setTlFrameState] = useState(0), [tlFps, setTlFps] = useState(TIMELINE_FPS);
  const { setTlFrame, commitPlaybackFrame, activeShotIdx, activeShot } = usePlaybackFrameState({ frameCount: tlFrameCount, setReactFrame: setTlFrameState, shots });
  const cameraKeys = activeShot?.cameraKeys ?? [], activeCamera = createCameraBlock(activeShot?.camera);
  const craneActive = !!activeCamera.craneHeight, cameraRail = activeCamera.cameraRail;
  const activeShotDuration = activeShot ? activeShot.endFrame - activeShot.startFrame + 1 : 0;
  const hasCameraKeys = shots.some(shot => shot.cameraKeys.length > 0);
  const selectedShotId = () => domain.read()[shotIndexAtFrame(domain.read(), appContext.live.state?.timeline.currentFrame ?? tlFrame)]?.id;
  // Arm before the first pointer tick; clicks without a write create no entry.
  useEffect(() => {
    const start = () => domain.beginGesture();
    window.addEventListener('pointerdown', start, true);
    return () => { window.removeEventListener('pointerdown', start, true); domain.finishGesture(true); };
  }, [domain]);
  function setShots(value) { return appContext.storeDomain('shot').write(value); }
  function editShots(value) { const owner = appContext.storeDomain('shot'); return owner.run('shot.replace', { shots: typeof value === 'function' ? value(owner.read()) : value }); }
  function setTlFrameCount(value) {
    const before = domain.state().frameCount, frameCount = Math.max(24, Math.round(typeof value === 'function' ? value(before) : value));
    if (frameCount !== before) return domain.run('shot.setTimeline', { frameCount });
  }
  function setFovDeg(value) { return domain.edit('shot.setLens', { fovDeg: typeof value === 'function' ? value(domain.state().fovDeg) : value }); }
  function changeActiveCamera(patch, shotId = selectedShotId()) {
    if (!shotId) return;
    return appContext.storeDomain('shot').edit('shot.setCamera', { shotId, patch });
  }
  function changeShotTargetModel(targetModel, shotId = selectedShotId()) {
    if (shotId) return domain.run('shot.set', { id: shotId, set: { targetModel: targetModel || null } });
  }
  function syncActiveCameraFraming() {
    if (!appContext.shared.shotCamRef.current || appContext.shared.ikMode || appContext.shared.playMode) return;
    const shotId = selectedShotId();
    return domain.edit('shot.captureCamera', shotId ? { shotId } : {});
  }
  function commitManualCameraFraming() { trackFeature('orbit'); return syncActiveCameraFraming(); }
  function beginCameraFramingGesture() { if (!appContext.shared.ikMode && !appContext.shared.playMode) domain.beginGesture(); }
  function beginTimelineEditGesture(kind, id) {
    if (kind === 'ik-key') return appContext.storeDomain('motion').beginGesture();
    if (['camera-key', 'rail', 'shot-boundary'].includes(kind)) return domain.beginGesture();
    if (['prompt-move', 'prompt-resize', 'prompt-text'].includes(kind)) return appContext.storeDomain('cast').beginGesture();
  }
  function setShotCameraRail(shotId, points) { return appContext.storeDomain('shot').run('shot.setCameraRail', { shotId, points }); }
  function clearShotCameraRail(shotId) { return appContext.storeDomain('shot').run('shot.clearCameraRail', { shotId }); }
  function changeCameraRail(points) { const shotId = selectedShotId(); if (shotId) return setShotCameraRail(shotId, points.map(({ x, z }) => ({ x, z }))); }
  function addCameraKeyframe(frame, shotId = selectedShotId()) {
    if (!shotId) return;
    const receipt = domain.run('shot.addKey', { shotId, frame: Math.max(0, Math.round(frame)) });
    if (receipt.authored) appContext.shared.markCraftAction('camera_key');
    appContext.shared.setSelectedHierarchyId('camera'); return receipt;
  }
  function moveCameraKeyframe(shotId, keyId, from, to) { if (from !== to) return domain.edit('shot.moveKey', { shotId, keyId, frame: Math.max(0, Math.round(to)) }); }
  function removeCameraKeyframe(shotId, keyId) { return domain.run('shot.removeKey', { shotId, keyId }); }
  function clearMove() { setMovePlaying(false); const shotId = selectedShotId(); if (shotId) return domain.run('shot.clearKeys', { shotId }); }
  function addTimelineShot() { return appContext.storeDomain('shot').run('shot.create'); }
  function splitTimelineShot(shotId) { return appContext.storeDomain('shot').run('shot.split', { shotId }); }
  function duplicateTimelineShot(shotId) { return appContext.storeDomain('shot').run('shot.duplicate', { shotId }); }
  function removeTimelineShot(shotId) { return appContext.storeDomain('shot').run('shot.remove', { shotId }); }
  function moveTimelineShot(shotId, startFrame) { return appContext.storeDomain('shot').run('shot.reorder', { shotId, startFrame }); }
  function setTimelineShotRange(shotId, startFrame, endFrame) { return appContext.storeDomain('shot').edit('shot.setRange', { shotId, range: { startFrame, endFrameExclusive: endFrame + 1 } }); }
  function resizeTimelineShot(shotId, edge, frame) {
    const shot = domain.read().find(row => row.id === shotId);
    return setTimelineShotRange(shotId, edge === 'start' ? Math.min(frame, shot.endFrame) : shot.startFrame, edge === 'end' ? Math.max(frame, shot.startFrame) : shot.endFrame);
  }
  function renameTimelineShot(shotId, name) { return domain.run('shot.rename', { shotId, name }); }
  function selectTimelineShot(shotId) {
    const selected = domain.read().find(row => row.id === shotId);
    if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
    appContext.shared.manualCameraOverrideRef.current = false; setTlFrame(selected.startFrame);
    appContext.shared.setSelectedHierarchyId('camera');
    if (appContext.shared.workflowMode !== 'camera') appContext.shared.selectWorkflowMode('camera');
  }
  function previewCameraShot(shotId) {
    const selected = domain.read().find(row => row.id === shotId);
    if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
    if (appContext.shared.waypointMode) return;
    if (appContext.shared.tlPlaying && appContext.shared.cameraPreviewEndRef.current === selected.endFrame) {
      appContext.shared.cameraPreviewEndRef.current = null; appContext.shared.setTlPlaying(false); return;
    }
    setMovePlaying(false); appContext.shared.manualCameraOverrideRef.current = false;
    appContext.shared.cameraPreviewEndRef.current = selected.endFrame; setTlFrame(selected.startFrame); appContext.shared.setTlPlaying(true);
  }
  function addActiveCranePoint(requestedT = null, shotId = selectedShotId()) {
    const shot = domain.read().find(row => row.id === shotId), camera = createCameraBlock(shot?.camera), points = camera.craneHeight?.points;
    if (!points || points.length >= 8) return;
    let t = Number.isFinite(requestedT) ? Math.max(0.02, Math.min(0.98, requestedT)) : null;
    if (t != null) { const nearby = points.findIndex(point => Math.abs(point.t - t) < 0.02); if (nearby >= 0) { setCraneSelectedIndex(nearby); return; } }
    let gap = 0;
    if (t == null) {
      for (let i = 1; i < points.length - 1; i++) if (points[i + 1].t - points[i].t > points[gap + 1].t - points[gap].t) gap = i;
      t = (points[gap].t + points[gap + 1].t) / 2;
    } else { gap = points.findIndex((point, index) => index < points.length - 1 && t > point.t && t < points[index + 1].t); if (gap < 0) return; }
    changeActiveCamera({ craneHeight: { points: [...points.slice(0, gap + 1), { t, height: craneHeightAt(camera.craneHeight, t) }, ...points.slice(gap + 1)] } }, shotId);
    trackFeature('crane_graph'); setCraneSelectedIndex(gap + 1);
  }
  function deleteSelectedCranePoint() {
    const points = activeCamera.craneHeight?.points;
    if (!points || craneSelectedIndex == null || craneSelectedIndex <= 0 || craneSelectedIndex >= points.length - 1) return;
    changeActiveCamera({ craneHeight: { points: points.filter((_, index) => index !== craneSelectedIndex) } }); setCraneSelectedIndex(null);
  }
  function changeCranePoints(points, options) {
    if (options?.dragging) domain.beginGesture();
    return changeActiveCamera({ craneHeight: { points } });
  }
  function changeCraneRail(points, options) {
    if (options?.dragging) domain.beginGesture();
    return changeActiveCamera({ cameraRail: points });
  }
  function toggleCameraRailDraw() {
    if (!activeShot || appContext.shared.waypointMode) return;
    domain.finishGesture();
    syncActiveCameraFraming();
    if (activeCamera.mode !== 'rail') changeActiveCamera({ mode: 'rail', railFollow: activeCamera.railFollow?.mode === 'off' ? defaultRailRange(activeShotDuration) : activeCamera.railFollow }, activeShot.id);
    const next = !railDraw; trackFeature('dolly_rail'); setRailDraw(next);
    if (next) { appContext.shared.setWorkspaceLayout(current => ({ ...current, insetCollapsed: false })); appContext.notify(ko("Draw the selected Shot's rail in the Top-View", '탑뷰에서 선택한 샷의 레일을 그리세요')); }
  }
  function deleteCameraRail() {
    if (!cameraRail || !activeShot) return;
    setRailDraw(false); clearShotCameraRail(activeShot.id);
    appContext.notify(ko('Camera rail deleted — Follow keeps the current distance', '카메라 레일 삭제됨 — 팔로우가 현재 거리를 유지합니다'));
  }
  function drawCameraRail(stroke) {
    const simplified = simplifyStroke(stroke, 0.12);
    if (simplified.length < 2) return;
    changeCameraRail(simplified); setRailDraw(false);
    const curve = buildRail(simplified);
    if (appContext.shared.playgroundMode && activeShot && curve) {
      const speed = Math.max(0.2, activeCamera.followCam?.maxDollySpeed ?? 4);
      const travel = Math.ceil(curve.length / speed * tlFps) + Math.round(tlFps * 0.5);
      const endFrame = Math.min(tlFrameCount - 1, activeShot.startFrame + Math.max(travel, activeShot.endFrame - activeShot.startFrame));
      setTimelineShotRange(activeShot.id, activeShot.startFrame, endFrame);
      // In the landing playground a drawn rail opens the player
      // on the shot camera, but leave playback to the visitor.
      appContext.shared.enterPreview(); appContext.shared.setTlPlaying(false); setTlFrame(activeShot.startFrame);
      appContext.notify(ko('Rail drawn — you are looking through the shot camera. Press ▶ to ride it; Esc goes back to flying.', '레일 완성 — 샷 카메라 시점으로 전환했습니다. ▶ 로 재생, Esc 로 복귀', '轨道已完成 — 已切换到镜头摄影机视角。按 ▶ 播放，按 Esc 返回自由视角。')); return;
    }
    appContext.notify(ko(`Camera rail drawn — ${curve ? curve.length.toFixed(1) : '?'} m, ${simplified.length} control points`, `카메라 레일 완성 — ${curve ? curve.length.toFixed(1) : '?'} m, 제어점 ${simplified.length}개`, `摄影机轨道已完成 — ${curve ? curve.length.toFixed(1) : '?'} m，${simplified.length} 个控制点`));
  }
  function publishStudioShots(value) { return appContext.storeDomain('shot').publish(value); }
  function commitStudioShots(draft) { return appContext.storeDomain('shot').commitDraft(draft); }
  function publishStudioCamera(camera, manual) { return appContext.storeDomain('shot').writeState(before => ({ ...before, camera, manual })); }
  function applyPreset(key) { appContext.shared.stageDomain.setPreset(key); setFovDeg(PRESETS[key].fov); appContext.shared.setNonce(n => n + 1); }
  function setLiveCamera(args) { return domain.run(args.preset !== undefined ? 'shot.frame' : 'shot.placeCamera', args); }
  function changeLens(value) { return setFovDeg(value); }
  // Range normalization happens inside the authored write, not a later effect.
  function clampShotRailRanges() {}
  const extentInputs = useRef(null);
  function syncTimelineExtent() {
    const inputs = [appContext.shared.characters, appContext.shared.activeChar.id, appContext.shared.motion];
    // App also re-runs this effect when shot history publishes. Only new
    // content can request a new extent; replaying it after Undo would replace
    // the restored entry and destroy Redo. Shot writes already clamp ranges.
    if (extentInputs.current?.every((value, index) => value === inputs[index])) return;
    extentInputs.current = inputs;
    const extent = timelineContentExtent(...inputs);
    const span = timelineSpan(extent, domain.read(), domain.state().frameCount);
    setTlFrameCount(span); if (extent > 0) setTlFrame(frame => Math.min(frame, span - 1));
  }
  function finishCameraMove(finalFov) { setMovePlaying(false); setFovDeg(Math.round(finalFov * 10) / 10); }
  // scope "timeline" records every frame of the timeline, shot boxes and all;
  // "shot" records one shot (shotId, or the one under the playhead). Without a
  // scope the old rule stands: a named shot, or the playhead's shot when there
  // is no motion, else the whole record.
  async function exportShotVideo({ download = true, shotId = null, scope = null, passKind = null, depthCurve = "linear" } = {}, commandContext = null) {
    if (appContext.shared.recRef.current) return null;
    const atPlayhead = shotIndexAtFrame(shots, tlFrame);
    const target = shotId ? shots.find(entry => entry.id === shotId) : shots[atPlayhead >= 0 ? atPlayhead : 0] ?? null;
    if (shotId && !target) return null;
    let exportShots = shots;
    if (target && target.cameraKeys.length === 0 && (target.camera?.mode ?? 'keys') === 'keys' && !shotId && scope !== 'timeline') {
      appContext.bus.run('shot.addKey', { shotId: target.id, frame: target.startFrame });
      exportShots = appContext.storeDomain('shot').read();
    }
    const oneShot = scope === 'shot' ? Boolean(target) : scope === 'timeline' ? false : Boolean(target && (shotId || !appContext.shared.motion));
    const range = oneShot ? { startFrame: target.startFrame, endFrame: target.endFrame }
      : { startFrame: 0, endFrame: Math.max(0, appContext.shared.currentRecordFrameCount() - 1, ...(scope === 'timeline' ? shots.map(entry => entry.endFrame) : [])) };
    return appContext.shared.executeExportRequest(appContext.shared.exportRequest('video', async job => {
      const abort = () => job.controller.abort(commandContext.signal.reason);
      commandContext?.signal.addEventListener('abort', abort, { once: true });
      try { commandContext?.signal.throwIfAborted(); return await appContext.shared.runShotExport({ ...range, download, passKind, depthCurve, ...(passKind === 'depth' ? { fileName: 'blocking-depth.mp4' } : {}) }, job); }
      finally { commandContext?.signal.removeEventListener('abort', abort); }
    }, { exportShots, download }));
  }
  return { ...domain, shots, setShots, editShots, fovDeg, setFovDeg, cameraMove, customMove, startupShotState,
    movePlaying, setMovePlaying, moveFollow, railDraw, setRailDraw, craneSelectedIndex, setCraneSelectedIndex,
    tlFrame, setTlFrame, commitPlaybackFrame, tlFrameCount, setTlFrameCount, tlFps, setTlFps, activeShotIdx, activeShot, cameraKeys,
    activeCamera, craneActive, cameraRail, activeShotDuration, hasCameraKeys, changeActiveCamera, changeShotTargetModel,
    syncActiveCameraFraming, commitManualCameraFraming, beginCameraFramingGesture, beginTimelineEditGesture,
    setShotCameraRail, clearShotCameraRail, changeCameraRail, addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, clearMove,
    addTimelineShot, splitTimelineShot, duplicateTimelineShot, removeTimelineShot, moveTimelineShot, setTimelineShotRange,
    resizeTimelineShot, renameTimelineShot, selectTimelineShot, previewCameraShot, addActiveCranePoint, deleteSelectedCranePoint,
    changeCranePoints, changeCraneRail, toggleCameraRailDraw, deleteCameraRail, drawCameraRail,
    publishStudioShots, commitStudioShots, publishStudioCamera, applyPreset, setLiveCamera, changeLens,
    clampShotRailRanges, syncTimelineExtent, finishCameraMove, exportShotVideo };
}
