// Shot geometry the Studio agent reads as facts instead of judging from a picture:
// where the cast stands, which side of the line between the two leading
// characters each shot camera sits on (the 180-degree rule), and which props
// stand between a camera and its subject. Pure: no renderer, no React.
import { entityWorldBounds } from './studio-agent-commands.js';
import { isEffectivelyHidden } from './scene-objects.js';
import { shotAtFrame } from './cuts.js';
import { contactBody } from './solid-contact.js';
import { entry, hiddenBy, HIDDEN_SHARE } from './motion3/sightline.js';
import { PerspectiveCamera, Vector3 } from 'three';
import { focalMmToFov } from './shot.js';
import { shotSubjects } from './shot-subjects.js';

export const GEOMETRY_FACTS_LIMITS = Object.freeze({ shots: 8, subjects: 24, pairs: 24, occluders: 8 });
/** Closer to the action line than this (m) is "on-axis", neither side. */
const ON_AXIS_M = 0.05;
const EPS = 1e-9;
/** Bones closer than this share of the body's height are one point; GRID places the points of a body with no bones. */
const BODY_GAP = 1 / 20, GRID = [1 / 6, 1 / 2, 5 / 6];
const round = v => Math.round(v * 1000) / 1000 + 0;
const point = p => ({ x: round(p.x), y: round(p.y ?? 0), z: round(p.z) });
const visibleCharacters = state => state.characters.filter(c => !isEffectivelyHidden(c, state.objects, state.characters));

/** Does the segment p0->p1 pass through the box {min, max}? Slab test over t in [0, 1]. */
export function segmentIntersectsAabb(p0, p1, box) {
  let t0 = 0, t1 = 1;
  for (const a of ['x', 'y', 'z']) {
    const d = p1[a] - p0[a];
    if (Math.abs(d) < EPS) {
      if (p0[a] < box.min[a] || p0[a] > box.max[a]) return false;
      continue;
    }
    let near = (box.min[a] - p0[a]) / d, far = (box.max[a] - p0[a]) / d;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near); t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/** Which side of the horizontal line a->b the point p stands on, seen from above
 * (+Y up) looking along a->b: the sign of (axis x (p - a)).y with the axis
 * normalised, so the threshold is metres. Negative is right, positive left;
 * within ON_AXIS_M it is "on-axis". Null when a and b share a spot. */
export function sideOfAxis(a, b, p) {
  const ax = b.x - a.x, az = b.z - a.z, length = Math.hypot(ax, az);
  if (length < EPS) return null;
  const offset = (az * (p.x - a.x) - ax * (p.z - a.z)) / length;
  return Math.abs(offset) < ON_AXIS_M ? 'on-axis' : offset > 0 ? 'left' : 'right';
}

/** All named visible subjects, or the visible cast for an unnamed geometry observation. */
export function primarySubjects(ids, cameraPosition, state) {
  const subjects = ids.length ? shotSubjects({ subjectIds: ids }, state.characters, null, state.objects) : visibleCharacters(state);
  return subjects.slice(0, GEOMETRY_FACTS_LIMITS.subjects).sort((p, q) => p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
}

/** A consistently oriented axis pair, separate from the complete subject list. */
export function axisSubjects(ids, cameraPosition, state) {
  const subjects = primarySubjects(ids, cameraPosition, state);
  const rest = visibleCharacters(state).filter(entry => !subjects.includes(entry));
  const near = entry => Math.hypot(entry.x - cameraPosition.x, entry.z - cameraPosition.z);
  if (!ids.length) subjects.sort((p, q) => near(p) - near(q));
  rest.sort((p, q) => near(p) - near(q));
  return [...subjects, ...rest].slice(0, 2).sort((p, q) => p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
}

/** The subject as points: the posed body's bones its bounds carry (the editor's bounds port), thinned to one per
 * BODY_GAP of its height so a hand's finger bones count as one point, not twenty; else a 3 x 3 x 3 grid inside its box. */
function bodyPoints(subject, state, ports, bounds) {
  let posed = bounds.points;
  if (!posed && !subject.renderer && ports?.bounds) try { posed = ports.bounds({ entity: subject, frame: state.frame, state })?.points; } catch { posed = null; }
  const gap = (bounds.max.y - bounds.min.y) * BODY_GAP, kept = [];
  for (const p of posed ?? []) if (kept.every(q => Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]) >= gap)) kept.push([p.x, p.y, p.z]);
  if (kept.length) return kept;
  const at = (a, k) => bounds.min[a] + (bounds.max[a] - bounds.min[a]) * k;
  return GRID.flatMap(i => GRID.flatMap(j => GRID.map(k => [at('x', i), at('y', j), at('z', k)])));
}

/** How much the props hide the subject from the camera: { share (0..1 of its points hidden), hidden (share >= HIDDEN_SHARE),
 * by: [{ id, share }] in scene order }. The one answer the framing check (occludersOf) and the Relations rows
 * (studio-relations.js) both give. The subject is several points of its posed body (bodyPoints); a prop hides a point when
 * the sight line to it crosses the prop's solid (solid-shape.js: what the viewport draws), else its box, and each hidden
 * point counts for the prop nearest the camera on its sight line (feet behind both a wall and the steps beyond it are the
 * wall's). The subject itself, props attached to it, hidden props and a box the camera stands inside (a room set) never count. */
export function occlusionOf(subject, cameraPosition, state, ports, subjectBounds = entityWorldBounds(subject, state, ports)) {
  if (!subjectBounds) return { share: 0, hidden: false, by: [] };
  const eye = [cameraPosition.x, cameraPosition.y, cameraPosition.z], boxes = {}, solids = {}, skip = new Set();
  for (const o of state.objects) {
    if (o.id === subject.id || o.attach?.characterId === subject.id || isEffectivelyHidden(o, state.objects, state.characters)) continue;
    const body = contactBody(o, () => entityWorldBounds(o, state, ports));
    if (!body) continue;
    boxes[o.id] = body.box;
    if (body.solid) solids[o.id] = body.solid; else if (entry(eye, eye, body.box) !== null) skip.add(o.id);
  }
  const points = bodyPoints(subject, state, ports, subjectBounds), by = points.map(p => Object.keys(hiddenBy(boxes, eye, [p], skip, solids)));
  const count = {}, nearest = (hiders, p) => hiders.reduce((a, b) => (entry(eye, p, boxes[b]) < entry(eye, p, boxes[a]) ? b : a));
  by.forEach((hiders, i) => { if (hiders.length) { const id = nearest(hiders, points[i]); count[id] = (count[id] ?? 0) + 1; } });
  const hiddenPoints = by.filter(ids => ids.length).length;
  return { share: hiddenPoints / points.length, hidden: hiddenPoints >= HIDDEN_SHARE * points.length,
    by: state.objects.filter(o => count[o.id]).map(o => ({ id: o.id, share: count[o.id] / points.length })) };
}

/** The failure codes of one framing check, in a fixed order. */
export const framingCodes = checks => [checks.clipped ? 'CLIPPED' : null, checks.behindCamera ? 'BEHIND_CAMERA' : null, checks.occluded ? 'OCCLUDED' : null].filter(Boolean);

/** Posed points as Vector3s, each with a drawn radius (radii[i] > 0, a capsule figure) replaced by the four points of its outline
 * across the camera's view (right and up of the camera, through the point): what a viewer sees of it at the frame edge. */
export function outlinePoints(points, radii, camera) {
  const ahead = new Vector3().subVectors(new Vector3(camera.lookAt.x, camera.lookAt.y, camera.lookAt.z), new Vector3(camera.position.x, camera.position.y, camera.position.z)).normalize();
  const right = new Vector3().crossVectors(ahead, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  const across = [right.normalize(), new Vector3().crossVectors(right, ahead).normalize()];
  return points.flatMap((p, i) => (radii?.[i] > 0 ? across.flatMap(e => [1, -1].map(s => new Vector3(p.x, p.y, p.z).addScaledVector(e, s * radii[i]))) : [new Vector3(p.x, p.y, p.z)]));
}

/** How much of the subject the shot camera shows: { inFrame (0..1 of its body points inside the picture, in front of the
 * lens), hidden (0..1 of them behind props, occlusionOf) }. The points are the ones the sight line reads (bodyPoints). */
function subjectView(subject, state, ports, bounds = entityWorldBounds(subject, state, ports)) {
  if (!bounds || !state.camera) return { inFrame: 0, hidden: 0 };
  const { sensorId, aspectRatio } = state.filmback, lens = new PerspectiveCamera(focalMmToFov(state.camera.focalMm, sensorId, aspectRatio) * 180 / Math.PI, aspectRatio, 0.01, 10000);
  lens.position.set(state.camera.position.x, state.camera.position.y, state.camera.position.z);
  lens.lookAt(state.camera.lookAt.x, state.camera.lookAt.y, state.camera.lookAt.z); lens.updateMatrixWorld(true);
  // a drawn radius round the posed points (a capsule figure): its outline across the view, the points the frame-edge check reads
  const points = bounds.radii?.length ? outlinePoints(bounds.points, bounds.radii, state.camera).map(p => p.toArray()) : bodyPoints(subject, state, ports, bounds);
  const inside = points.map(p => new Vector3(...p).project(lens)).filter(q => Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1 && q.z >= -1 && q.z <= 1);
  return { inFrame: round(inside.length / points.length), hidden: round(occlusionOf(subject, state.camera.position, state, ports, bounds).share) };
}

/** For a sampled frame whose framing failed: each subject that fails on its own ({ id, codes, inFrame, hidden }), checked
 * alone by check (framingChecks). A failure of the cast as a whole does not say whose it is, nor whether that one is seen. */
export function subjectIssues(ids, state, ports, check) {
  return ids.slice(0, GEOMETRY_FACTS_LIMITS.subjects).flatMap(id => {
    const subject = [...state.characters, ...state.objects].find(e => e.id === id), codes = subject ? framingCodes(check([id], state, ports)) : [];
    return codes.length ? [{ id, codes, ...subjectView(subject, state, ports) }] : [];
  });
}

/** Props that hide the subject from the camera (occlusionOf): the props it names when the subject counts as hidden, else none. */
export function occludersOf(subject, cameraPosition, state, ports, subjectBounds = entityWorldBounds(subject, state, ports)) {
  const { hidden, by } = occlusionOf(subject, cameraPosition, state, ports, subjectBounds);
  return hidden ? by.map(({ id }) => ({ subjectId: subject.id, byObjectId: id })) : [];
}

/** A shot's camera as position + aim: the live camera for the shot under the
 * playhead, else the shot's first camera key; null when it has neither. */
export function shotCamera(shot, state) {
  if (state.camera && shotAtFrame(state.shotDocument.shots, state.frame)?.id === shot.id) return { position: state.camera.position, lookAt: state.camera.lookAt };
  const framing = shot.cameraKeys?.[0]?.framing;
  if (!framing) return null;
  const { pos, yaw, pitch } = framing;
  return { position: pos, lookAt: { x: pos.x - Math.sin(yaw) * Math.cos(pitch), y: pos.y + Math.sin(pitch), z: pos.z - Math.cos(yaw) * Math.cos(pitch) } };
}

/** The 180-degree rule over shots read against the same pair: false when any
 * pair has cameras on both sides, true when some pair has two sided shots and
 * none crosses, null when no pair has two sided shots to compare. */
function axisConsistency(shots) {
  const byPair = new Map();
  for (const shot of shots) {
    if (shot.cameraSide !== 'left' && shot.cameraSide !== 'right') continue;
    const key = (shot.axisSubjectIds ?? shot.subjectIds).join('|');
    byPair.set(key, [...(byPair.get(key) ?? []), shot.cameraSide]);
  }
  const compared = [...byPair.values()].filter(sides => sides.length >= 2);
  return compared.length ? compared.every(sides => sides.every(side => side === sides[0])) : null;
}

/** Facts for the given shots, bounded by GEOMETRY_FACTS_LIMITS. Without shotIds:
 * the shots named in `first` (other ids are skipped), then the rest of the cut, so
 * axisConsistent compares the named shots with the others. */
export function shotGeometryFacts(state, { shotIds, first = [], ports } = {}) {
  const cast = visibleCharacters(state).slice(0, GEOMETRY_FACTS_LIMITS.subjects);
  const subjects = cast.map(c => ({ id: c.id, position: point(c), yawDeg: round(c.rot ?? 0) }));
  const pairs = cast.flatMap((a, i) => cast.slice(i + 1).map(b => ({ a: a.id, b: b.id, distanceM: round(Math.hypot(b.x - a.x, b.z - a.z)) })))
    .sort((p, q) => p.distanceM - q.distanceM).slice(0, GEOMETRY_FACTS_LIMITS.pairs);
  const all = state.shotDocument.shots;
  const named = all.filter(s => first.includes(s.id)).sort((p, q) => first.indexOf(p.id) - first.indexOf(q.id));
  const wanted = (shotIds ? shotIds.map(id => all.find(s => s.id === id)) : [...named, ...all.filter(s => !named.includes(s))]).filter(Boolean).slice(0, GEOMETRY_FACTS_LIMITS.shots);
  const shots = wanted.map(shot => {
    const camera = shotCamera(shot, state);
    if (!camera) return { shotId: shot.id, subjectIds: [], camera: null, cameraSide: null, occluders: [] };
    const subjects = primarySubjects(shot.subjectIds ?? [], camera.position, state), pair = axisSubjects(shot.subjectIds ?? [], camera.position, state);
    return { shotId: shot.id, subjectIds: subjects.map(c => c.id), ...(subjects.length !== pair.length ? { axisSubjectIds: pair.map(c => c.id) } : {}), camera: { position: point(camera.position), lookAt: point(camera.lookAt) },
      cameraSide: pair.length === 2 ? sideOfAxis(pair[0], pair[1], camera.position) : null,
      occluders: subjects.flatMap(subject => occludersOf(subject, camera.position, state, ports)).slice(0, GEOMETRY_FACTS_LIMITS.occluders) };
  });
  return { subjects, pairs, shots, axisConsistent: axisConsistency(shots) };
}
