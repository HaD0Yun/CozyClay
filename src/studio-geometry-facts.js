// Shot geometry the Studio agent reads as facts instead of judging from a picture:
// where the cast stands, which side of the line between the two leading
// characters each shot camera sits on (the 180-degree rule), and which props
// stand between a camera and its subject. Pure: no renderer, no React.
import { entityWorldBounds } from './studio-agent-commands.js';
import { isEffectivelyHidden } from './scene-objects.js';
import { shotAtFrame } from './cuts.js';
import { objectSize } from './object-size.js';
import { solidOf } from './solid-shape.js';
import { entry, hiddenBy, HIDDEN_SHARE } from './motion3/sightline.js';
import { mul, rx, ry, rz } from './motion3/compiler/math.js';

export const GEOMETRY_FACTS_LIMITS = Object.freeze({ shots: 8, subjects: 24, pairs: 24, occluders: 8 });
/** Closer to the action line than this (m) is "on-axis", neither side. */
const ON_AXIS_M = 0.05;
const EPS = 1e-9;
/** Bones closer than this share of the body's height are one point; GRID places the points of a body with no bones. */
const BODY_GAP = 1 / 20, GRID = [1 / 6, 1 / 2, 5 / 6], IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
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

/** The two characters a camera is read against: the given ids that are visible
 * characters, then the visible characters nearest the camera. Ordered by id, so
 * every shot of the same pair reads the line in the same direction. */
export function primarySubjects(ids, cameraPosition, state) {
  const visible = visibleCharacters(state);
  const chosen = ids.map(id => visible.find(c => c.id === id)).filter(Boolean);
  const near = c => Math.hypot(c.x - cameraPosition.x, c.z - cameraPosition.z);
  const rest = visible.filter(c => !chosen.includes(c)).sort((p, q) => near(p) - near(q));
  return [...chosen, ...rest].slice(0, 2).sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** Where a prop stands for a sight line: a motion box (motion3/scene.js) from its record, or, for a carried or routed prop,
 * the world box its evaluated bounds give (no solid then: its record's pose is not where it is drawn). */
function sightBody(o, state, ports) {
  if (o.attach || o.path) {
    const box = entityWorldBounds(o, state, ports);
    return box && { box: { pos: [(box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2], R: IDENTITY, half: ['x', 'y', 'z'].map(a => (box.max[a] - box.min[a]) / 2) } };
  }
  const size = objectSize(o);
  if (!(size.width > 0 && size.height > 0 && size.depth > 0)) return null;
  return { box: { pos: [o.x ?? 0, o.y ?? 0, o.z ?? 0], R: mul(rx(o.rotX ?? 0), mul(ry(o.rot ?? 0), rz(o.rotZ ?? 0))), half: [size.width / 2, size.height / 2, size.depth / 2] }, solid: solidOf(o) };
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

/** Props that hide the subject from the camera. The subject is several points of its posed body (bodyPoints); a prop
 * hides a point when the sight line to it crosses the prop's solid (solid-shape.js: what the viewport draws), else its
 * box. The subject is hidden when HIDDEN_SHARE of its points are, and then the prop nearest the camera on each hidden
 * point's sight line is listed.
 * The subject itself, props attached to it, hidden props and a box the camera stands inside (a room set) never count. */
export function occludersOf(subject, cameraPosition, state, ports, subjectBounds = entityWorldBounds(subject, state, ports)) {
  if (!subjectBounds) return [];
  const eye = [cameraPosition.x, cameraPosition.y, cameraPosition.z], boxes = {}, solids = {}, skip = new Set();
  for (const o of state.objects) {
    if (o.id === subject.id || o.attach?.characterId === subject.id || isEffectivelyHidden(o, state.objects, state.characters)) continue;
    const body = sightBody(o, state, ports);
    if (!body) continue;
    boxes[o.id] = body.box;
    if (body.solid) solids[o.id] = body.solid; else if (entry(eye, eye, body.box) !== null) skip.add(o.id);
  }
  const points = bodyPoints(subject, state, ports, subjectBounds), by = points.map(p => Object.keys(hiddenBy(boxes, eye, [p], skip, solids)));
  if (by.filter(ids => ids.length).length < HIDDEN_SHARE * points.length) return [];
  // A point is the nearest prop's to name: feet behind both a wall and the steps beyond it are the wall's.
  const ids = new Set(by.flatMap((hiders, i) => hiders.length ? [hiders.reduce((a, b) => (entry(eye, points[i], boxes[b]) < entry(eye, points[i], boxes[a]) ? b : a))] : []));
  return state.objects.filter(o => ids.has(o.id)).map(o => ({ subjectId: subject.id, byObjectId: o.id }));
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
    const key = shot.subjectIds.join('|');
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
    const pair = primarySubjects(shot.subjectIds ?? [], camera.position, state);
    return { shotId: shot.id, subjectIds: pair.map(c => c.id), camera: { position: point(camera.position), lookAt: point(camera.lookAt) },
      cameraSide: pair.length === 2 ? sideOfAxis(pair[0], pair[1], camera.position) : null,
      occluders: pair.flatMap(subject => occludersOf(subject, camera.position, state, ports)).slice(0, GEOMETRY_FACTS_LIMITS.occluders) };
  });
  return { subjects, pairs, shots, axisConsistent: axisConsistency(shots) };
}
