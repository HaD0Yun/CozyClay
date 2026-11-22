// One semantic entry point for timeline, camera controls and agent framing.
import { createCameraBlock, updateCameraBlock, removeCameraRail } from '../camera-block.js';
import { addShotAtFrame, appendShotGrowingTake, cutAtFrame, duplicateShot, removeShot, reorderShot, resizeShot, renameShot, moveCameraKey, removeCameraKey } from '../cuts.js';
import { createStableItemId, updateStableItem } from '../stable-items.js';
import { railFollowForNewGeometry } from '../camera-rail-schedule.js';
import { buildRail } from '../camera-follow.js';
import { railDollyLag } from '../rail-dolly-lag.js';
import { cameraKeyWarnings } from '../camera-direction.js';
import { TIMELINE_FPS } from '../timeline-defaults.js';
import { studioActionDeclaration } from '../studio-actions.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';
import { normalizeFramingArgs } from '../studio-framing-words.js';
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/shot.js';
import { changedIds, fail, shotLabel } from './shared.js';
import { repairOptics } from '../camera-optics.js';
import { repairReview } from '../shot-review.js';
import { heldReport, resolveOverShot } from './shot-held.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const TAKE_FRAME_MAX = 28800;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const number = { type: 'number' };
const frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const mutation = (id, label, schema, description = label) => ({ id, label, description, kind: 'mutation', undoDomain: 'shot', input: schema });
const existing = ['shot.create', 'shot.split', 'shot.duplicate', 'shot.remove', 'shot.setRange', 'shot.setCameraRail', 'shot.clearCameraRail', 'shot.setCameraMode', 'shot.rename', 'shot.reorder'].map(studioActionDeclaration);
const extra = [
  mutation('shot.set', 'Set shot fields', elementSetSchema('shot')),
  mutation('shot.setCamera', 'Set camera block', input({ shotId: id, patch: { type: 'object', properties: {}, additionalProperties: true } })),
  mutation('shot.addKey', 'Add camera key', input({ shotId: id, frame })),
  { ...mutation('shot.recordKeys', 'Record camera performance', input({ shotId: id, keys: { type: 'array', maxItems: 600, items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' },
  { ...mutation('shot.setOptics', 'Set shot optics', input({ shotId: id, optics: { type: 'object', properties: {}, additionalProperties: true } })), exposure: 'ui-only' },
  { ...mutation('shot.setReview', 'Set shot review', input({ shotId: id, review: { type: 'object', properties: {}, additionalProperties: true } })), exposure: 'ui-only' },
  mutation('shot.moveKey', 'Move camera key', input({ shotId: id, keyId: id, frame })),
  mutation('shot.removeKey', 'Remove camera key', input({ shotId: id, keyId: id })),
  mutation('shot.clearKeys', 'Clear camera keys', input({ shotId: id })),
  mutation('shot.setTimeline', 'Set shot timeline', input({ frameCount: { type: 'integer', minimum: 24, maximum: TAKE_FRAME_MAX } })),
  mutation('shot.setLens', 'Set camera lens', input({ fovDeg: { ...number, minimum: 14, maximum: 90 } })),
  mutation('shot.frame', 'Frame the shot', { ...input({ ...STUDIO_TOOL_SCHEMAS.frame_shot.properties, preset: { type: 'string' } }, []), oneOf: [STUDIO_TOOL_SCHEMAS.frame_shot, input({ preset: { type: 'string' } })] },
    'Frame a shot on its named characters together (the frame_shot tool): framing.intent { size, level, view, side, focalMm } or framing.exact { position, lookAt, focalMm }. Without keyAtFrame a shot that holds one framing is reframed whole: a held shot. keyAtFrame adds a camera key there; every key eases in and out, so the camera slows to a stop at each one: key a pan or zoom from one spot with two keys (its start and end), lay a moving camera as a rail (shot.setCameraRail) and cut to a new shot for a new view. On a rail shot it puts the shot back on keys. over: "shot" (with intent, after a take is installed) fits one held camera to every pose of the shot and turns it off the asked view only as far as walls need. Answers checks { derivedSize, screenFraction, clipped, behindCamera, occluded, cameraSide } for the subjects at that frame, and checks.held { frames, hidden, outOfFrame, askedDeg, chosenDeg } and a HELD_SHOT warning for what a camera holding still misses over the shot.'),
  { ...mutation('shot.replace', 'Replace shot authoring', input({ shots: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' },
  { ...mutation('shot.captureCamera', 'Capture camera framing', input({ shotId: id }, [])), exposure: 'ui-only' },
  { ...mutation('shot.placeCamera', 'Place camera', input(Object.fromEntries(['x', 'y', 'z', 'lookAtX', 'lookAtY', 'lookAtZ', 'focalMm'].map(key => [key, number])), [])), exposure: 'ui-only' },
];
export const declarations = Object.freeze([extra[0], ...existing, ...extra.slice(1).map(entry => entry.id === 'shot.frame' ? entry : { ...entry, exposure: 'ui-only' })]);

// shot.setRange also takes range: [startFrame, endFrameExclusive] or flat startFrame/endFrameExclusive
// fields; both become range: { startFrame, endFrameExclusive } before validation (registry normalizeArgs).
function lenientRange(args) {
  const { range, startFrame, endFrameExclusive, ...rest } = args, flat = Object.fromEntries(Object.entries({ startFrame, endFrameExclusive }).filter(([, v]) => v !== undefined));
  if (Array.isArray(range) && range.length === 2 && !Object.keys(flat).length) return { ...rest, range: { startFrame: range[0], endFrameExclusive: range[1] } };
  return range === undefined && Object.keys(flat).length ? { ...rest, range: flat } : args;
}

export function register(registry, ports) {
  const owner = () => ports.storeDomain('shot');
  const mounted = () => Boolean(ports.storeDomain?.('shot')) || 'The shots document owner is not mounted.';
  const shotOf = shotId => owner().read().find(shot => shot.id === shotId) ?? fail('STALE_TARGET', `Shot ${shotId} is not in this scene.`);
  const patchShot = (shotId, update) => { shotOf(shotId); owner().write(current => updateStableItem(current, shotId, update, 'shots')); };
  // A clip shot goes in the free time at (or after) the playhead; with none left the take grows at its end,
  // in the same write so one undo takes both back, and the playhead lands in the new shot.
  function createClip() {
    const current = owner().read(), { frameCount } = owner().state(), framing = owner().capture();
    const placed = addShotAtFrame(current, ports.state().frame, frameCount, framing);
    if (placed !== current) return owner().write(placed);
    const grown = appendShotGrowingTake(current, frameCount, framing, TAKE_FRAME_MAX) ?? fail('INVALID_ARGUMENT', `The take is at its longest (${TAKE_FRAME_MAX} frames); shorten or remove a shot first.`);
    owner().writeState(before => ({ ...before, ...grown }));
    const added = grown.shots.find(shot => !current.some(row => row.id === shot.id)), { selection, view } = ports.readView();
    if (added) ports.publishView({ selection, view: { ...view, frame: added.startFrame }, shotId: added.id });
  }
  function duplicate(shotId) {
    const source = shotOf(shotId), copied = { ...(source.subjectIds?.length ? { subjectIds: [...source.subjectIds] } : {}), ...(source.optics ? { optics: structuredClone(source.optics) } : {}), ...(source.review ? { review: structuredClone(source.review) } : {}) };
    const before = owner().read(), next = duplicateShot(before, shotId, owner().state().frameCount);
    return owner().write(next.map(shot => before.includes(shot) ? shot : { ...shot, ...copied }));
  }
  function reorder({ shotId, startFrame }) {
    shotOf(shotId);
    return owner().write(current => reorderShot(current, shotId, startFrame, owner().state().frameCount));
  }
  // A rail owns the frames it covers, so the camera keys there go. Its answer
  // names the move it makes: length, speed, height, aim and lens.
  function setRail({ shotId, points, height, aim, aimHeight, focalMm, rollDeg }) {
    const shot = shotOf(shotId), cast = [...ports.state().characters, ...ports.state().objects];
    for (const id of Array.isArray(aim) ? aim : []) if (!cast.some(row => row.id === id)) fail('STALE_TARGET', `Aim ${id} is not a character or object in this scene.`);
    const railFollow = railFollowForNewGeometry(shot.camera?.railFollow, shot.endFrame - shot.startFrame + 1);
    const span = railFollow?.mode === 'range' ? [shot.startFrame + railFollow.startFrame, shot.startFrame + railFollow.endFrame] : [shot.startFrame, shot.endFrame];
    const patch = { cameraRail: points, mode: 'rail', railFollow, ...(focalMm === undefined ? {} : { focalMm }), ...(rollDeg === undefined ? {} : { rollDeg }),
      ...(height === undefined ? {} : { craneHeight: { points: typeof height === 'number' ? [{ t: 0, height }, { t: 1, height }] : height } }),
      ...(aim === undefined && aimHeight === undefined ? {} : { aim: aimOf(aim === undefined ? createCameraBlock(shot.camera).aim : aim && (Array.isArray(aim) ? { ids: aim } : { point: aim }), aimHeight) }),
      // a named aim is held: a head the user set to turn to nothing turns to it again
      ...(aim && createCameraBlock(shot.camera).head?.follow === false ? { head: null } : {}) };
    const keys = shot.cameraKeys.filter(key => key.frame < span[0] || key.frame > span[1]);
    const markTurns = block => block.craneHeight?.points.filter(point => point.yawDeg || point.pitchDeg).length ?? 0, marks = n => `${n} crane mark${n === 1 ? '' : 's'}`, turnedBefore = markTurns(createCameraBlock(shot.camera));
    patchShot(shotId, row => ({ ...row, cameraKeys: keys, camera: updateCameraBlock(row.camera, patch) }));
    const camera = createCameraBlock(shotOf(shotId).camera), metres = buildRail(camera.cameraRail)?.length ?? 0, seconds = (span[1] - span[0] + 1) / TIMELINE_FPS;
    const heights = camera.craneHeight?.points.map(point => point.height) ?? [camera.followCam.height], speed = metres / seconds;
    const aimed = camera.head?.follow === false ? `nothing (held at yaw ${camera.head.yawDeg}°, pitch ${camera.head.pitchDeg}° set by hand)` : camera.aim?.ids ? `${camera.aim.ids.join(', ')}${camera.aim.height === undefined ? '' : ` at ${camera.aim.height.toFixed(2)} m`}` : (camera.aim ? `(${['x', 'y', 'z'].map(axis => camera.aim.point[axis].toFixed(2)).join(', ')})` : 'the follow subject');
    const note = `${metres.toFixed(1)} m over ${seconds.toFixed(1)} s (${speed.toFixed(2)} m/s), height ${[...new Set([heights[0], heights.at(-1)])].map(h => h.toFixed(2)).join('-')} m, aim ${aimed}${camera.head && camera.head.follow !== false ? ` turned yaw ${camera.head.yawDeg}°, pitch ${camera.head.pitchDeg}° by hand` : ''}${markTurns(camera) ? `, turned by hand at ${marks(markTurns(camera))} along the rail` : ''}, ${camera.focalMm ? `${camera.focalMm} mm` : 'scene lens'}${shot.cameraKeys.length > keys.length ? `; ${shot.cameraKeys.length - keys.length} camera keys removed` : ''}${turnedBefore > markTurns(camera) ? `; the hand turn of ${marks(turnedBefore - markTurns(camera))} removed` : ''}.`;
    // A dolly cap is a setting of the shot (the user's, or the world's fastest dolly): the answer is the lag it measures (rail-dolly-lag.js), on the rail
    // alone and ridden from its head; a rail that opens nearest its subject starts where the subject is, so only the two speeds are said. 120 characters at most.
    const cap = camera.followCam.maxDollySpeed, lag = camera.followCam.railStartMode === 'head' ? railDollyLag(buildRail(camera.cameraRail), span[1] - span[0] + 1, TIMELINE_FPS, { ...camera.followCam, dollyTiming: camera.dollyTiming }) : null;
    const asks = `Dolly cap ${Number(cap.toFixed(2))} m/s, rail asks ${speed.toFixed(2)}`, held = lag && `${asks}: rail alone, the cap holds the dolly ${lag.behindM.toFixed(1)} m back at frame ${span[0] + lag.frame}, ${lag.endShortM.toFixed(1)} m at the end.`;
    const fast = (lag ? lag.behindM > 0.05 : speed > cap) ? [{ code: 'RAIL_TOO_FAST', id: shotId, message: held && held.length <= 120 ? held : `${asks} m/s.` }] : [];
    return { note, warnings: fast };
  }
  // aimHeight moves a cast aim off the chest to a world height (a whole body, a face).
  const aimOf = (aim, aimHeight) => (aim?.ids && aimHeight !== undefined ? { ...aim, height: aimHeight } : aim);
  const methods = {
    'shot.create': () => createClip(),
    'shot.split': ({ shotId }) => {
      const shot = shotOf(shotId), { frame } = ports.state();
      if (frame <= shot.startFrame || frame > shot.endFrame) fail('TARGET_NOT_READY', `The playhead (frame ${frame}) is not inside ${shot.name} after its first frame.`);
      owner().write(current => cutAtFrame(current, shotId, frame, owner().capture()));
    },
    'shot.duplicate': ({ shotId }) => duplicate(shotId),
    'shot.remove': ({ shotId }) => { shotOf(shotId); owner().write(current => removeShot(current, shotId)); },
    'shot.reorder': args => reorder(args),
    'shot.setRange': ({ shotId, range }) => {
      const shot = shotOf(shotId), startFrame = range.startFrame, endFrame = range.endFrameExclusive - 1;
      const edges = startFrame > shot.endFrame ? [['end', endFrame], ['start', startFrame]] : [['start', startFrame], ['end', endFrame]];
      owner().write(current => edges.reduce((rows, [edge, frame]) => resizeShot(rows, shotId, edge, frame, owner().state().frameCount), current));
    },
    'shot.setCameraRail': args => setRail(args),
    'shot.clearCameraRail': ({ shotId }) => {
      const shot = shotOf(shotId);
      if (!createCameraBlock(shot.camera).cameraRail) fail('TARGET_NOT_READY', `${shot.name || shotId} has no camera rail.`);
      patchShot(shotId, shot => ({ ...shot, camera: removeCameraRail(shot.camera) }));
    },
    'shot.rename': ({ shotId, name }) => { shotOf(shotId); owner().write(current => renameShot(current, shotId, name)); },
    'shot.setCameraMode': ({ shotId, mode }) => {
      const shot = shotOf(shotId);
      if (mode === 'rail' && !createCameraBlock(shot.camera).cameraRail) fail('TARGET_NOT_READY', `${shot.name || shotId} has no camera rail; lay one with shot.setCameraRail.`);
      patchShot(shotId, row => ({ ...row, camera: updateCameraBlock(row.camera, { mode }) }));
    },
    'shot.setCamera': ({ shotId, patch }) => patchShot(shotId, shot => ({ ...shot, camera: updateCameraBlock(shot.camera, patch) })),
    'shot.recordKeys': ({ shotId, keys }) => {
      shotOf(shotId);
      if (!keys.length) fail('INVALID_ARGUMENT', 'A recording must contain at least one camera key.');
      patchShot(shotId, row => ({ ...row, camera: updateCameraBlock(row.camera, { mode: 'keys' }),
        cameraKeys: keys.map(key => ({ id: row.cameraKeys.find(current => current.frame === key.frame)?.id ?? createStableItemId('camera-key'), frame: key.frame, framing: key.framing })) }));
    },
    'shot.setOptics': ({ shotId, optics }) => patchShot(shotId, shot => ({ ...shot, optics: repairOptics(optics) })),
    'shot.setReview': ({ shotId, review }) => patchShot(shotId, shot => ({ ...shot, review: repairReview(review, shot) })),
    'shot.addKey': ({ shotId, frame }) => {
      const shot = shotOf(shotId), target = Math.min(owner().state().frameCount - 1, frame);
      if (target < shot.startFrame || target > shot.endFrame) return;
      const framing = owner().capture();
      patchShot(shotId, shot => ({ ...shot, cameraKeys: [...shot.cameraKeys.filter(key => key.frame !== target),
        { id: shot.cameraKeys.find(key => key.frame === target)?.id ?? createStableItemId('camera-key'), frame: target, framing }].sort((a, b) => a.frame - b.frame) }));
    },
    'shot.moveKey': ({ shotId, keyId, frame }) => patchShot(shotId, shot => ({ ...shot,
      cameraKeys: moveCameraKey(shot.cameraKeys, keyId, Math.max(shot.startFrame, Math.min(shot.endFrame, frame))) })),
    'shot.removeKey': ({ shotId, keyId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: removeCameraKey(shot.cameraKeys, keyId) })),
    'shot.clearKeys': ({ shotId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: [] })),
    'shot.setTimeline': ({ frameCount }) => owner().writeState(before => ({ ...before, frameCount })),
    'shot.setLens': ({ fovDeg }) => owner().setLens(fovDeg),
    'shot.replace': ({ shots }) => owner().write(shots),
    'shot.captureCamera': args => owner().captureCamera(args.shotId),
    'shot.placeCamera': args => owner().placeCamera(args),
  };
  const hasShots = state => state.shots.length > 0 || 'There are no shots yet; add one with shot.create.';
  const availability = {
    'shot.create': state => addShotAtFrame(state.shots, state.frame, state.frameCount, null) !== state.shots || appendShotGrowingTake(state.shots, state.frameCount, null, TAKE_FRAME_MAX) !== null || `The take is at its longest (${TAKE_FRAME_MAX} frames); shorten or remove a shot first.`,
    'shot.split': state => state.shots.some(shot => state.frame > shot.startFrame && state.frame <= shot.endFrame) || `The playhead (frame ${state.frame}) is not inside a shot after its first frame; move it with operate_studio { frame }.`,
    'shot.clearCameraRail': state => state.shots.some(shot => createCameraBlock(shot.camera).cameraRail) || 'No shot has a camera rail; lay one with shot.setCameraRail.',
  };
  registerElementSet(registry, ports, extra[0]);
  for (const declaration of declarations.filter(row => row.id !== 'shot.set')) registry.register({ ...declaration,
    ...(declaration.id === 'shot.setRange' ? { normalizeArgs: lenientRange } : {}),
    // run_action shot.frame reads a crew's framing words as frame_shot does (studio-framing-words.js, #1042).
    ...(declaration.id === 'shot.frame' ? { normalizeArgs: normalizeFramingArgs } : {}),
    available: state => mounted() === true ? (availability[declaration.id] ?? (existing.includes(declaration) ? hasShots : () => true))(state) : mounted(),
    run(args) {
      if (declaration.id === 'shot.frame') return framed(args);
      const before = owner().read();
      const answered = methods[declaration.id](args), answer = typeof answered?.note === 'string' ? answered : null;
      // The owner re-normalizes every shot on write, so compare content, not
      // identity; a write can still move more shots than a receipt names (100),
      // and the first 100 stand for the batch.
      const after = owner().read(), changed = changedIds(before.map(row => after.find(next => next.id === row.id && same(next, row)) ?? row), after).slice(0, 100);
      const affectedIds = changed.length ? changed : [args.shotId ?? ports.state().activeSceneId];
      const summary = changed.length ? `${declaration.label}: ${changed.map(id => after.find(row => row.id === id)).filter(Boolean).map(shotLabel).join('; ')}.` : `${declaration.label}.`;
      return { affectedIds, summary: answer?.note ? `${summary.slice(0, -1)}: ${answer.note}`.slice(0, 240) : summary, ...(answer?.warnings ? { warnings: answer.warnings } : {}) };
    },
  });
  // frame_shot answers what it measured, and what its keys do to a move.
  function framed(args) {
    const raw = ports.readView(), before = owner().read(), { args: resolved, held: over } = resolveOverShot(args, { raw, shots: before, ports });
    const plan = owner().frame(resolved), shot = owner().read().find(row => row.id === plan.details.shotId), report = heldReport(plan, shot, { raw, ports, over });
    const wasRail = createCameraBlock(before.find(row => row.id === shot.id)?.camera).mode === 'rail';
    return { affectedIds: plan.affectedIds, summary: `Framed ${shotLabel(shot)}: ${plan.checks.derivedSize} at frame ${plan.details.frame}, ${shot.cameraKeys.length} camera key${shot.cameraKeys.length === 1 ? '' : 's'}.`.slice(0, 240),
      checks: { ...plan.checks, ...(report.held ? { held: report.held } : {}) }, warnings: [...plan.warnings, ...(report.warning ? [report.warning] : []), ...(wasRail ? [{ code: 'RAIL_REPLACED', id: shot.id, message: 'This shot is back on camera keys; its rail no longer drives it. Re-lay it with shot.setCameraRail.' }] : []),
        ...cameraKeyWarnings(shot)] };
  }
  if (ports.storeDomain?.('shot')) registry.registerToolAlias('frame_shot', 'shot.frame');
}
