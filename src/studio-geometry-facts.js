// Shot geometry the Studio agent reads as facts instead of judging from a picture:
// where the cast stands, which side of the line between the two leading
// characters each shot camera sits on (the 180-degree rule), and which props
// stand between a camera and its subject. Pure: no renderer, no React.
import { entityWorldBounds } from './studio-agent-commands.js';
import { isEffectivelyHidden } from './scene-objects.js';
import { shotAtFrame } from './cuts.js';
import { shotSubjects } from './shot-subjects.js';

export const GEOMETRY_FACTS_LIMITS = Object.freeze({ shots: 8, subjects: 24, pairs: 24, occluders: 8 });
/** Closer to the action line than this (m) is "on-axis", neither side. */
const ON_AXIS_M = 0.05;
const EPS = 1e-9;
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
const contains = (box, p) => ['x', 'y', 'z'].every(a => p[a] >= box.min[a] && p[a] <= box.max[a]);

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

/** Props whose world box crosses the sight line from the camera to the centre of
 * the subject's box. The subject itself, props attached to it, hidden props and
 * an enclosure the camera stands inside (a room set) never count. */
export function occludersOf(subject, cameraPosition, state, ports, subjectBounds = entityWorldBounds(subject, state, ports)) {
  if (!subjectBounds) return [];
  const centre = Object.fromEntries(['x', 'y', 'z'].map(a => [a, (subjectBounds.min[a] + subjectBounds.max[a]) / 2]));
  return state.objects.filter(o => o.id !== subject.id && o.attach?.characterId !== subject.id && !isEffectivelyHidden(o, state.objects, state.characters))
    .flatMap(o => {
      const box = entityWorldBounds(o, state, ports);
      return box && !contains(box, cameraPosition) && segmentIntersectsAabb(cameraPosition, centre, box) ? [{ subjectId: subject.id, byObjectId: o.id }] : [];
    });
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
