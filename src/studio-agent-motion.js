// Read-only verification of installed takes on isolated rig clones.
// Generation, repair, publication and history belong to the motion domain.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { StudioProtocolError, freezeStudioData } from './studio-agent-protocol.js';
import { playTakeFrame as applyTakeFrame } from './character-playback.js';
import { resolveIkRig, createIkState, ikEvaluate, findBone, hasBindPose } from './motion/ik.js';
import { PHYSICS_LIMITS, createSupportSampler, copyPhysicsKeys, supportIntervals, physicsMetrics } from './motion/physics-review.js';
import { createDynamicsSampler, supportDiagnostics } from './motion/physics-support.js';
import { computeCenterOfMass } from './motion/center-of-mass.js';
import { buildCollisionCapsules, detectPenetrations, supportsCollisionCleanup } from './motion/fix-collisions.js';
import { collisionBlockers, blockerSummary } from './motion/collision-blockers.js';
import { createGroundSampler } from './motion/ground.js';
import { OBJECT_LIBRARY } from './scene-objects.js';
import { sceneObjectsAt } from './object-travel.js';
import { objectTracksOf } from './motion3/object-tracks.js';
import { sampleAt } from './sample-at.js';
import { isProxyFigure } from './scenes.js';

const PROFILE = 'studio-motion-v1', BLEND = 6;
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const copyLayer = state => ({ ...createIkState(), keys: copyPhysicsKeys(state?.keys ?? new Map()), tracked: new Set(state?.tracked ?? []) });
const poseOf = rig => { const result = []; rig.traverse(n => { if (n.isBone) result.push({ bone: n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() }); }); return result; };
const restore = pose => { for (const { bone, p, q, s } of pose) { bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(s); } };
const poseValues = pose => pose.map(({ bone }) => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
const BASE_LIMITATIONS = ['discrete-integer-24fps-frames', 'calibrated-capsule-and-upright-box-proxies', 'external-torso-head-and-other-cast-fingers-excluded', 'rest-overlap-calibration-and-4mm-actionable-depth', 'centroidal-support-not-biomechanical-certification', 'semantic-and-visual-review-unavailable'];

function isolatedRig(source) {
  if (!source || !hasBindPose(source)) fail('TARGET_NOT_READY', 'A target rig with its original bind snapshot is required.');
  // SkeletonUtils remaps skeleton bones, but Object3D's JSON userData copy does
  // not remap poseBind's Map keys. Rebuild that map against the cloned nodes.
  const original = []; source.traverse(n => original.push(n));
  const rig = cloneSkeleton(source), nodes = []; rig.traverse(n => nodes.push(n));
  rig.userData.poseBind = new Map(original.flatMap((n, i) => {
    const bind = source.userData.poseBind.get(n);
    return bind ? [[nodes[i], structuredClone(bind)]] : [];
  }));
  const parent = new THREE.Group(); parent.matrixAutoUpdate = false;
  if (source.parent) parent.matrix.copy(source.parent.matrixWorld);
  parent.add(rig); parent.updateMatrixWorld(true);
  const rest = poseOf(rig), resolved = resolveIkRig(rig);
  if (!resolved || !supportsCollisionCleanup(rig)) { disposeRig({ rig, parent }); fail('TARGET_NOT_READY', 'Complete supported target IK and collision bones are required.'); }
  return { rig, parent, rest, ...resolved, surface: createSupportSampler(rig), dynamics: createDynamicsSampler(rig) };
}
function disposeRig(value) {
  // Geometry/material/texture assets are borrowed read-only. Only cloned
  // skeleton palettes and the private hierarchy belong to this evaluation.
  const skeletons = new Set(); value.rig.traverse(n => { if (n.isSkinnedMesh) skeletons.add(n.skeleton); });
  for (const skeleton of skeletons) skeleton.dispose();
  value.parent.remove(value.rig);
}
function poseFrame(evaluator, motion, layer, frame) {
  restore(evaluator.rest);
  if (motion) applyTakeFrame(evaluator.rig, motion, sampleAt({ frameCount: motion.frames, motion }, null, frame).motionFrame);
  if (layer) ikEvaluate(evaluator.chains, layer, frame, evaluator.fkJoints, motion ? BLEND : 0);
  evaluator.parent.updateMatrixWorld(true);
}
function readSample(evaluator, groundAt) {
  const support = evaluator.surface(), toes = {};
  for (const side of ['left', 'right']) toes[`${side}Foot`] = findBone(evaluator.rig, `mixamorig${side === 'left' ? 'Left' : 'Right'}ToeBase`).getWorldPosition(new THREE.Vector3());
  const knees = Object.fromEntries(['leftFoot', 'rightFoot'].map(key => {
    const [a, b, c] = evaluator.chains.get(key).bones.map(n => n.getWorldPosition(new THREE.Vector3()));
    return [key, a.sub(b).angleTo(c.sub(b)) * 180 / Math.PI];
  }));
  const ground = Object.fromEntries(Object.entries(support).map(([key, p]) => [key, groundAt(p.point.x, p.point.z, p.position.y + .001)]));
  return { support, toes, knees, ground, root: evaluator.fkJoints.get('hips').bone.getWorldPosition(new THREE.Vector3()), com: computeCenterOfMass(evaluator.rig), dynamics: evaluator.dynamics() };
}
const nextTask = () => new Promise(resolve => {
  const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(0);
});
const verificationBudget = (frames, ms) => (ms ?? 60000) * Math.max(1, frames / 48) * 2;
function checkEnvironment(env) {
  if (!Number.isSafeInteger(env.physicsRevision) || env.physicsRevision < 0 || !Number.isFinite(env.floor?.y)) fail('TARGET_NOT_READY', 'Authoritative physics revision and floor are required.');
  return env;
}
const copyEnvironment = env => ({ ...env, host: structuredClone(env.host), floor: structuredClone(env.floor), objects: structuredClone(env.objects), cast: undefined });
/** Private evaluators for the other visible cast, pushed one by one so a
 * refused rig leaves every evaluator made before it disposable. */
function stageCast(env, characterId, cast) {
  for (const member of env.cast) {
    if (member.character.id === characterId || member.character.hidden || isProxyFigure(member.character)) continue;
    // Unsupported bystanders remain explicit missing coverage, never vanish
    // into characterBlockers' otherwise legitimate best-effort skip path.
    const entry = { character: structuredClone(member.character), motion: member.motion ? structuredClone(member.motion) : null, layer: copyLayer(member.ikState), evaluator: null };
    cast.push(entry);
    if (member.rig && hasBindPose(member.rig) && supportsCollisionCleanup(member.rig)) entry.evaluator = isolatedRig(member.rig);
  }
}

/* One take under evaluation, `t`: {evaluator, motion, env, cast, characterId,
 * character, protectedFrames, range, poseCast?, yieldTask, checkpoint}. */
function blockersAt(t, frame, objects) {
  t.checkpoint();
  const rigs = {};
  for (const member of t.cast) {
    if (!member.evaluator) continue;
    poseFrame(member.evaluator, member.motion, member.layer, frame);
    t.poseCast?.(member.evaluator, member, frame);
    member.evaluator.parent.updateMatrixWorld(true);
    rigs[member.character.id] = member.evaluator.rig;
  }
  const cast = t.cast.map((member) => member.character).filter(Boolean);
  // `objects` already stand where this frame renders them (routes and take tracks), so no re-sampling here.
  return collisionBlockers({ rigs, activeId: t.characterId, characterIds: cast, sceneObjects: objects, library: OBJECT_LIBRARY });
}
async function samples(t, layer) {
  const rows = [], poses = [], collisions = [], blockers = [];
  const cast = t.cast.map((member) => member.character).filter(Boolean);
  for (let frame = t.range.startFrame; frame < t.range.endFrameExclusive; frame++) {
    t.checkpoint(); poseFrame(t.evaluator, t.motion, layer, frame);
    // Objects as the editor renders them at this frame: travel routes plus the
    // object tracks the installed takes bake (object-travel.js sceneObjectsAt).
    const objects = sceneObjectsAt(t.env.objects, frame, t.objectTake);
    for (const o of objects) if (!o.hidden && (o.rotX || o.rotZ)) t.tilted.add(o.id);
    const shapes = blockersAt(t, frame, objects);
    rows.push(readSample(t.evaluator, createGroundSampler(objects, { floorY: t.env.floor.y, characters: cast })));
    poses.push(poseValues(t.evaluator.rest));
    const capsules = buildCollisionCapsules(t.evaluator.rig);
    collisions.push(detectPenetrations(capsules, { blockers: shapes }).map(p => ({ a: p.a.def.id, b: p.b.def?.id ?? p.b.id, depth: p.depth })));
    blockers.push(blockerSummary(shapes));
    if (frame % 12 === 11) { await t.yieldTask(); t.checkpoint(); }
  }
  const contacts = supportIntervals(rows, 24, [], t.env.floor.y);
  return { rows, poses, collisions, blockers, contacts, metrics: physicsMetrics(rows, contacts.masks, 24, t.env.floor.y), support: supportDiagnostics(rows, 24, t.env.floor.y) };
}
/** The verdict on one layer's samples (`after`) against the bare take's
 * (`before`): status inputs, coverage, metrics and limitations. */
function judge(t, before, after) {
  const m = after.metrics;
  const continuityRegressed = m.kneeStep > Math.max(before.metrics.kneeStep + 2, 12)
    || m.kneeAcceleration > Math.max(1e-6, before.metrics.kneeAcceleration * 1.1)
    || m.rootAcceleration > Math.max(1e-6, before.metrics.rootAcceleration * 1.1);
  let protectedPoseError = 0;
  for (const frame of t.protectedFrames) {
    const f = frame - t.range.startFrame;
    if (f < 0 || f >= before.poses.length) continue;
    for (let b = 0; b < before.poses[f].length; b++) for (let i = 0; i < before.poses[f][b].length; i++) protectedPoseError = Math.max(protectedPoseError, Math.abs(before.poses[f][b][i] - after.poses[f][b][i]));
  }
  const supportedCollisionFrames = after.collisions.filter(p => p.length).length;
  const elevatedFrames = after.rows.flatMap((row, f) => Object.values(row.ground).some(y => y !== t.env.floor.y) ? [t.range.startFrame + f] : []);
  const unsupportedObjects = t.env.objects.filter(o => o.attach || o.rotX || o.rotZ || t.tilted.has(o.id));
  const missingCast = t.cast.filter(m => !m.evaluator || ((m.character.layer?.waypoints?.length ?? 0) > 0 && !t.poseCast));
  const measuredSupportFrames = after.support.frames.filter(f => f.measured).length;
  const flat = t.env.floor.model === 'flat' && elevatedFrames.length === 0 && Math.abs(t.character.y ?? 0) < 1e-8;
  const contactDefects = m.penetration > PHYSICS_LIMITS.floor || m.slide > PHYSICS_LIMITS.slide || m.float > PHYSICS_LIMITS.float || after.support.unsupportedFrames > 0;
  const coverageComplete = m.surfaceMeasured && measuredSupportFrames === after.rows.length && after.contacts.spans.length > 0 && !missingCast.length && !unsupportedObjects.length;
  const verified = coverageComplete && flat && !contactDefects && !after.support.unresolved.length && !supportedCollisionFrames && !continuityRegressed && protectedPoseError <= 1e-8;
  const limitations = [...BASE_LIMITATIONS];
  if (!m.surfaceMeasured || measuredSupportFrames !== after.rows.length) limitations.push('skin-or-dynamics-coverage-unavailable');
  if (!after.contacts.spans.length) limitations.push('no-reliable-inferred-contact-spans');
  if (!flat) limitations.push('elevated-moving-or-nonflat-support-unsupported');
  if (missingCast.length) limitations.push('other-cast-evaluation-incomplete');
  if (unsupportedObjects.length) limitations.push('attached-or-tilted-object-proxies-unsupported');
  return { verified, flat, contactDefects, missingCast, unsupportedObjects, supportedCollisionFrames, limitations,
    range: { ...t.range }, evaluatedFrames: after.rows.length,
    coverage: { sourceFrames: before.rows.length, candidateFrames: after.rows.length, measuredSupportFrames, contactSpans: after.contacts.spans.length,
      collisionFrames: after.collisions.length, otherCastIds: t.cast.map(m => m.character.id), pathObjectIds: t.env.objects.filter(o => o.path).map(o => o.id), elevatedFrames },
    metrics: { surfaceMeasured: m.surfaceMeasured, maxFloorPenetrationM: m.penetration, maxContactSlipM: m.slide, maxContactFloatM: m.float,
      unsupportedFrames: after.support.unsupportedFrames, supportedCollisionFrames, continuityRegressed, protectedPoseError,
      kneeAcceleration: m.kneeAcceleration, rootAcceleration: m.rootAcceleration, supportForceResidual: after.support.forceResidual, supportMomentResidual: after.support.momentResidual } };
}
/** The verification a receipt carries, from a full verification result. */
function receiptVerification(v) {
  const m = v.metrics;
  return { id: v.verificationId, status: v.status, profile: PROFILE, range: v.range, evaluatedFrames: v.evaluatedFrames, physicsRevision: v.physicsRevision,
    limitations: v.limitations, surfaceMeasured: m.surfaceMeasured, maxFloorPenetrationM: m.maxFloorPenetrationM, maxContactSlipM: m.maxContactSlipM, maxContactFloatM: m.maxContactFloatM,
    unsupportedFrames: m.unsupportedFrames, supportedCollisionFrames: m.supportedCollisionFrames, continuityRegressed: m.continuityRegressed, semanticStatus: 'unavailable' };
}
/** Object tracks the installed takes bake (this take and the other cast's), keyed by object id. */
function installedObjectTracks(target, environment) {
  const takes = new Map((environment.cast ?? []).map(member => [member.character?.id, member.motion]));
  takes.set(target.character.id, target.motion);
  const characters = [...takes.keys()].filter(id => typeof id === 'string').map(id => ({ id }));
  return objectTracksOf({ motionFor: id => takes.get(id) }, characters);
}
/** Motion verification of an installed take, on a private rig clone over
 * `range` (default and upper bound: the whole take). target: {character, rig,
 * motion, ikState?, protectedFrames?}; environment has readEnvironment()'s
 * shape. Returns the receipt verification shape tagged with the character id. */
export async function verifyInstalledTake({ target, environment, range, poseCast, yieldTask = nextTask, now = Date.now, verificationMs, newId = () => crypto.randomUUID() }) {
  const motion = target?.motion;
  if (!motion?.frames) fail('TARGET_NOT_READY', 'The character has no installed take.');
  const env = copyEnvironment(checkEnvironment(environment));
  const startFrame = range?.startFrame ?? 0, endFrameExclusive = Math.min(range?.endFrameExclusive ?? motion.frames, motion.frames);
  if (startFrame >= endFrameExclusive) fail('INVALID_RANGE', 'The range lies outside the installed take.');
  const deadline = now() + verificationBudget(endFrameExclusive - startFrame, verificationMs);
  const t = { evaluator: isolatedRig(target.rig), motion, env, cast: [], characterId: target.character.id, character: target.character,
    protectedFrames: target.protectedFrames ?? [], range: { startFrame, endFrameExclusive }, poseCast, yieldTask,
    objectTake: { frameCount: env.frameCount, fps: 24, objectTracks: installedObjectTracks(target, environment) }, tilted: new Set(),
    checkpoint: () => { if (now() > deadline) fail('VERIFICATION_FAILED', 'Private verification budget exceeded.'); } };
  try {
    stageCast(environment, t.characterId, t.cast);
    const before = await samples(t, copyLayer()), after = await samples(t, copyLayer(target.ikState)), j = judge(t, before, after);
    return freezeStudioData({ characterId: t.characterId, ...receiptVerification({ verificationId: newId(), status: j.verified ? 'verified' : 'unverified',
      range: j.range, evaluatedFrames: j.evaluatedFrames, physicsRevision: env.physicsRevision, limitations: j.limitations, metrics: j.metrics }) });
  } finally {
    disposeRig(t.evaluator);
    for (const member of t.cast) if (member.evaluator) disposeRig(member.evaluator);
  }
}
