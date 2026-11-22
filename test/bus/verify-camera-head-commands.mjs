// The rail head and the follow pick through the real shot domain and bus:
// turning the camera by hand on a rail writes the head and leaves the dolly's
// follow settings alone; picks and heads undo, redo and duplicate; an agent's
// named aim turns a head that was set to follow no one back on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { shotsFixture, seedShot } from './shots-fixture.mjs';

const DEG = Math.PI / 180;
const railShot = (camera = {}) => ({ ...seedShot(), cameraKeys: [], camera: { mode: 'rail', cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], railFollow: { mode: 'range', startFrame: 0, endFrame: 23 }, ...camera } });
function load(f, shot) {
  f.shots.load({ shots: [shot], frameCount: 120, camera: f.actual.readStudioState().camera });
  f.live.current.timeline.currentFrame = 12;
}
const shotOf = f => f.shots.read()[0];

test('a hand turn on a rail frame writes the head as an offset and keeps the follow settings', () => {
  const f = shotsFixture();
  try {
    load(f, railShot());
    const followBefore = structuredClone(shotOf(f).camera.followCam);
    // what the stage shows at frame 12 (no head yet), and where the user turned the camera to
    f.scope.railCameraAt = () => ({ camera: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0.1, pitch: -0.05 }, head: null });
    const cam = new THREE.PerspectiveCamera(40); cam.position.set(0, 1.6, 4);
    f.scope.shotCamRef = { current: cam };
    f.scope.look = { current: { yaw: 0.1 + 15 * DEG, pitch: -0.05 - 4 * DEG } };
    const receipt = f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.deepEqual(shotOf(f).camera.head, { yawDeg: 15, pitchDeg: -4 });
    assert.deepEqual(shotOf(f).camera.followCam, followBefore, 'a hand turn on the rail never re-measures distance or pitch (the dolly stays)');
    // with follow off the turn is the camera's own angle
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { head: { follow: false, yawDeg: 0, pitchDeg: 0 } } });
    f.scope.railCameraAt = () => ({ camera: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: 0 }, head: { follow: false, yawDeg: 0, pitchDeg: 0 } });
    f.scope.look = { current: { yaw: 40 * DEG, pitch: 10 * DEG } };
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.deepEqual(shotOf(f).camera.head, { follow: false, yawDeg: 40, pitchDeg: 10 });
    // an aim take owns its frames: no head is measured there
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { aimTake: { startFrame: 0, samples: Array.from({ length: 24 }, () => ({ yaw: 1, pitch: 0 })) } } });
    f.scope.look = { current: { yaw: 1.2, pitch: 0.3 } };
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.deepEqual(shotOf(f).camera.head, { follow: false, yawDeg: 40, pitchDeg: 10 }, 'the take wins on its frames');
  } finally { f.dispose(); }
});

test('a hand move on a rail frame sets the follow framing as before; a turn after it is the head', () => {
  const f = shotsFixture();
  try {
    load(f, railShot());
    const at = { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0.1, pitch: -0.05 };
    // what the stage shows: the rail's sample with the shot's head on it
    f.scope.railCameraAt = () => {
      const head = shotOf(f).camera.head ?? null;
      return { camera: { ...at, yaw: at.yaw + (head?.yawDeg ?? 0) * DEG, pitch: at.pitch + (head?.pitchDeg ?? 0) * DEG }, head };
    };
    // the camera lifted 0.8 m by hand (gizmo, Transform Position), not turned
    const cam = new THREE.PerspectiveCamera(40); cam.position.set(0, 2.4, 4);
    f.scope.shotCamRef = { current: cam };
    f.scope.look = { current: { yaw: at.yaw, pitch: at.pitch } };
    assert.equal(f.run('shot.captureCamera', { shotId: 'shot-a' }).ok, true);
    const moved = structuredClone(shotOf(f).camera);
    assert.equal(moved.followCam.height, 2.4, 'the lens height is read from where the camera was put');
    assert.equal(moved.head, undefined, 'a move is not a turn');
    assert.equal(f.shots.state().manual, true, 'the camera stays where the hand put it');
    // nothing changed since: capturing again writes nothing
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.deepEqual(shotOf(f).camera, moved);
    // turned 12 degrees there, before the playhead moved: the head takes the turn, the follow framing stays
    f.scope.look = { current: { yaw: at.yaw + 12 * DEG, pitch: at.pitch } };
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.deepEqual(shotOf(f).camera.head, { yawDeg: 12, pitchDeg: 0 });
    assert.deepEqual(shotOf(f).camera.followCam, moved.followCam);
    // moved again with that head: its tilt is not counted a second time into the follow pitch
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { head: { yawDeg: 12, pitchDeg: -4 } } });
    const flat = structuredClone(shotOf(f).camera.followCam);
    cam.position.set(0, 2.4, 4.5);
    f.scope.look = { current: { yaw: at.yaw + 12 * DEG, pitch: at.pitch - 4 * DEG } };
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    const again = shotOf(f).camera;
    assert.deepEqual(again.head, { yawDeg: 12, pitchDeg: -4 });
    assert.notEqual(again.followCam.distance, flat.distance, 'the distance is read from the new place');
    cam.position.set(0, 2.4, 4.5 + 1e-9);
    f.scope.look = { current: { yaw: at.yaw + 12 * DEG, pitch: at.pitch } };
    f.run('shot.captureCamera', { shotId: 'shot-a' });
    assert.deepEqual(shotOf(f).camera.head, { yawDeg: 12, pitchDeg: 0 }, 'tilting back up 4 degrees takes the head tilt out');
    assert.deepEqual(shotOf(f).camera.followCam, again.followCam);
  } finally { f.dispose(); }
});

test('the pick and the head undo, redo and duplicate with the shot', () => {
  const f = shotsFixture();
  try {
    load(f, railShot());
    const picked = f.run('shot.set', { id: 'shot-a', set: { subjectIds: ['actor-a'] } });
    assert.equal(picked.ok, true, JSON.stringify(picked));
    assert.deepEqual(shotOf(f).subjectIds, ['actor-a']);
    assert.equal(f.run('edit.undo', { receiptId: picked.receiptId }).status, 'undone');
    assert.equal(shotOf(f).subjectIds, undefined, 'undo returns to the selected character');
    f.run('edit.redo', {});
    assert.deepEqual(shotOf(f).subjectIds, ['actor-a'], 'redo picks again');
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { head: { yawDeg: 12, pitchDeg: 3 } } });
    f.run('shot.duplicate', { shotId: 'shot-a' });
    const copy = f.shots.read().find(row => row.id !== 'shot-a');
    assert.deepEqual([copy.subjectIds, copy.camera.head], [['actor-a'], { yawDeg: 12, pitchDeg: 3 }], 'a duplicate follows the same pick at the same hand angle');
  } finally { f.dispose(); }
});

test('an agent naming an aim turns a head that follows no one back on', () => {
  const f = shotsFixture();
  try {
    load(f, railShot({ head: { follow: false, yawDeg: 30, pitchDeg: -5 } }));
    const kept = f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -3, z: 4 }, { x: 3, z: 4 }] }, 'agent');
    assert.equal(kept.ok, true, JSON.stringify(kept));
    assert.deepEqual(shotOf(f).camera.head, { follow: false, yawDeg: 30, pitchDeg: -5 }, 'relaying the rail keeps the hand angle');
    assert.match(kept.summary, /aim nothing \(held at yaw 30°, pitch -5° set by hand\)/, kept.summary);
    const aimed = f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -3, z: 4 }, { x: 3, z: 4 }], aim: ['actor-a'] }, 'agent');
    assert.equal(aimed.ok, true, JSON.stringify(aimed));
    assert.equal(shotOf(f).camera.head, undefined, 'the named aim is held');
    // a hand offset stays through the agent's next rail, and its answer says so, whole (not cut at 240 characters)
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { head: { yawDeg: -12.5, pitchDeg: 3.2 } } });
    const turned = f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -3, z: 4 }, { x: 3, z: 4 }], aim: ['actor-a'], aimHeight: 0.9, focalMm: 50 }, 'agent');
    assert.deepEqual(shotOf(f).camera.head, { yawDeg: -12.5, pitchDeg: 3.2 });
    assert.match(turned.summary, /aim actor-a at 0\.90 m turned yaw -12\.5°, pitch 3\.2° by hand, 50 mm\.$/, turned.summary);
    // a cast the user picked by hand keeps its mark when the agent only changes the aim height
    f.run('shot.setCamera', { shotId: 'shot-a', patch: { aim: { ids: ['actor-a'], picked: true } } });
    f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -3, z: 4 }, { x: 3, z: 4 }], aimHeight: 1.6 }, 'agent');
    assert.deepEqual(shotOf(f).camera.aim, { ids: ['actor-a'], height: 1.6, picked: true });
    f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -3, z: 4 }, { x: 3, z: 4 }], aim: ['actor-a'] }, 'agent');
    assert.deepEqual(shotOf(f).camera.aim, { ids: ['actor-a'] }, "an aim the agent names is the agent's: no mark");
  } finally { f.dispose(); }
});
