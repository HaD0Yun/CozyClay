// #1146: App's timeline-length effect runs while an agent turn holds its composed transaction (a take was installed in the
// turn). Its write must join that transaction: opening a second one is refused, and a refusal thrown from the effect remounts the app.
import assert from 'node:assert/strict';
import { shotsFixture } from './shots-fixture.mjs';
const f = shotsFixture();
try {
  Object.assign(f.scope, { characters: f.characterRef.current, activeChar: f.characterRef.current[0],
    motion: null, promptClips: f.buffer.current.promptClips, multiModelFootage: null });
  f.shots.syncTimelineExtent();
  const frames = () => f.live.current.timeline.frameCount, rail = { shotId: 'shot-a', points: [{ x: 0, z: 0 }, { x: 1, z: 2 }] };
  const turn = () => { const turnId = crypto.randomUUID(); return (id, args = {}) => f.run(id, args.turnId === null ? { turnId } : args, 'agent', { turnId }); };
  assert.equal(frames(), 120);

  // a turn that lands: the length change is part of the turn's one history entry
  let agent = turn();
  assert.equal(agent('agent.turn.begin', { turnId: null }).ok, true);
  assert.equal(agent('shot.setCameraRail', rail).ok, true, 'the turn holds an open transaction');
  f.scope.motion = { frames: 240 };
  assert.doesNotThrow(() => f.shots.syncTimelineExtent(), 'the effect never throws inside an agent turn');
  assert.equal(frames(), 240, 'the timeline follows the take installed in the turn');
  const depth = f.shots.documentStore.depths().past;
  assert.equal(agent('agent.turn.finish', { turnId: null }).ok, true);
  assert.equal(frames(), 240);
  f.actual.undoScene();
  assert.equal(frames(), 120, 'one Undo takes the turn back, its timeline length included');
  f.actual.redoScene();
  assert.equal(frames(), 240);
  assert.ok(f.shots.documentStore.depths().past >= depth);

  // a cancelled turn takes the length back with everything else
  agent = turn();
  assert.equal(agent('agent.turn.begin', { turnId: null }).ok, true);
  assert.equal(agent('shot.clearCameraRail', { shotId: 'shot-a' }).ok, true);
  f.scope.motion = { frames: 96 };
  assert.doesNotThrow(() => f.shots.syncTimelineExtent());
  assert.equal(frames(), 96);
  assert.equal(agent('agent.turn.cancel', { turnId: null }).ok, true);
  assert.equal(frames(), 240, 'a cancelled turn restores the timeline length');

  // outside a turn the effect still authors its own entry (verify-shots-extent-undo.mjs)
  f.scope.motion = { frames: 300 };
  f.shots.syncTimelineExtent();
  assert.equal(frames(), 300);
  console.log('PASS the timeline length joins an open agent turn instead of opening a second transaction');
} finally { f.dispose(); }
