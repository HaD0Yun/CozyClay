// #1185: a refusal of a UI-origin shots command ends at the UI door, logged, never in window.onerror.
// The timeline's key drag sends shot.moveKey and the orbit end sends shot.captureCamera; neither has a caller
// above it that catches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shotsFixture } from './shots-fixture.mjs';

function quietly(fn) {
  const warn = console.warn, warned = []; console.warn = (...args) => { warned.push(args); };
  try { assert.doesNotThrow(fn); } finally { console.warn = warn; }
  return warned;
}

test('shots: a timeline key drag on a shot that is gone is logged, not thrown, and changes nothing', () => {
  const f = shotsFixture();
  try {
    const refused = f.run('shot.moveKey', { shotId: 'gone', keyId: 'key-a', frame: 5 });
    assert.equal(refused.code, 'STALE_TARGET', 'precondition: the bus refuses a stale shot');
    const before = f.snapshot();
    const warned = quietly(() => f.shots.moveCameraKeyframe('gone', 'key-a', 0, 5));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(warned.length, 1); assert.ok(warned[0].includes('STALE_TARGET'), JSON.stringify(warned[0]));
    const moved = f.shots.moveCameraKeyframe('shot-a', 'key-a', 0, 5);
    assert.equal(moved.ok, true, 'an admitted move still answers with its receipt');
  } finally { f.dispose(); }
});

test('shots: an orbit end whose lens is out of range is logged, not thrown, and changes nothing', () => {
  const f = shotsFixture();
  try {
    f.scope.shotCamRef.current.fov = 120;
    const before = f.snapshot();
    const warned = quietly(() => f.shots.commitManualCameraFraming());
    assert.deepEqual(f.snapshot(), before);
    assert.equal(warned.length, 1); assert.ok(warned[0].includes('INVALID_ARGUMENT'), JSON.stringify(warned[0]));
  } finally { f.dispose(); }
});
