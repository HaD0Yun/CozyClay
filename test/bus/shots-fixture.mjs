import { appFixture } from './app-fixture.mjs';
import { mountShots } from './shots-hook.mjs';
import { createShot } from '../../src/cuts.js';
import { createShotAuthoringDocument } from '../../src/shot-authoring.js';

export const framing = { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 40 };
export function seedShot() {
  return { ...createShot('Hero', 0, 23, [{ id: 'key-a', frame: 0, framing }]), id: 'shot-a' };
}
export function shotsFixture(f = appFixture()) {
  const scope = f.scope;
  scope.startupScene = { shotDocument: createShotAuthoringDocument({ shots: [seedShot()], frameCount: 120 }) };
  scope.markCraftAction = () => {};
  scope.cameraPreviewEndRef = { current: null };
  const shots = mountShots(scope.appContext.forRender(scope));
  shots.load({ shots: [seedShot()], frameCount: 120, camera: f.actual.readStudioState().camera });
  Object.assign(scope, shots);
  scope.shotsDomain = shots;
  Object.assign(f.ports, scope.appContext.ports);
  Object.assign(f.actionHandlers.current, scope.appContext.actionPorts);
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio });
  const oldState = f.actionHandlers.current.state;
  f.actionHandlers.current.state = () => ({ ...oldState(), shots: f.live.current.shots, frame: f.live.current.timeline.currentFrame, frameCount: f.live.current.timeline.frameCount });
  f.ports.canUndo = f.actual.canUndoStudioReceipt;
  const run = (id, args = {}, origin = 'ui', options = {}) => f.binding.bus.run(id, args, {
    origin, host: f.host(), expectedRevision: f.binding.refresh().revision, ...options,
  });
  const snapshot = () => structuredClone(shots.documentStore.getSnapshot().slices);
  return { ...f, shots, run, snapshot, dispose() { f.dispose(); shots.dispose?.(); } };
}
