// The frame an object is placed in by arrange_objects space "parent": its parent, or the bone it rides.
import { Euler, Quaternion, Vector3 } from "three";
import { StudioProtocolError } from "./studio-agent-protocol.js";

const DEG = Math.PI / 180;
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const pos = e => ({ x: e.x, y: e.y ?? 0, z: e.z });
const vector = p => new Vector3(p.x, p.y, p.z);
const normalizedName = name => name.normalize("NFC").trim();
// Parent-relative (local) space. Object rows are flat world-space; `parent` only
// groups. A parent's frame is its stored pivot (base, y = bottom) and Euler XYZ
// degrees; parent SCALE is deliberately not part of the frame.
const objectQuat = o => new Quaternion().setFromEuler(new Euler((o.rotX ?? 0) * DEG, (o.rot ?? 0) * DEG, (o.rotZ ?? 0) * DEG, 'XYZ'));
const wrapDeg = a => ((a + 540) % 360 + 360) % 360 - 180;
// XYZ Euler angles come in two equal-orientation spellings, (x,y,z) and
// (x+180, 180-y, z+180). Report the one with the least pitch/roll, so a pure
// yaw of 135 reads back as yaw 135 rather than (180, 45, 180).
function eulerDegOf(q) {
  const e = new Euler().setFromQuaternion(q, 'XYZ'), a = { x: e.x / DEG, y: e.y / DEG, z: e.z / DEG };
  const b = { x: wrapDeg(a.x + 180), y: wrapDeg(180 - a.y), z: wrapDeg(a.z + 180) };
  return Math.abs(b.x) + Math.abs(b.z) < Math.abs(a.x) + Math.abs(a.z) - 1e-9 ? b : a;
}
const eulerQuat = r => new Quaternion().setFromEuler(new Euler(r.x * DEG, r.y * DEG, r.z * DEG, 'XYZ'));
/** world = parentPivot + R_parent * local; orientation = R_parent * R_local. */
export function localToWorld(parent, local) {
  const p = vector(local.position ?? { x: 0, y: 0, z: 0 }).applyQuaternion(objectQuat(parent)).add(vector(pos(parent)));
  const q = objectQuat(parent).multiply(eulerQuat(local.rotationDeg ?? { x: 0, y: 0, z: 0 }));
  return { position: { x: p.x, y: p.y, z: p.z }, rotationDeg: eulerDegOf(q) };
}
/** Inverse of localToWorld for an object row under its parent row. */
export function worldToLocal(parent, object) {
  const inverse = objectQuat(parent).invert();
  const p = vector(pos(object)).sub(vector(pos(parent))).applyQuaternion(inverse);
  return { position: { x: p.x, y: p.y, z: p.z }, rotationDeg: eulerDegOf(inverse.multiply(objectQuat(object))) };
}
const tidy = v => Math.round(v * 1e4) / 1e4 + 0;
/** Compact readback: the object's transform in the frame that carries it, or null
 * for a root, a missing parent, a routed child or a child of an attached record.
 * An attached record's stored channels ARE its place and turn in the bone frame;
 * a parent that travels (a route or a take) carries its children rigidly from its
 * authored pose (object-travel.js), so the local pose against that pose holds on every frame. */
export function localTransformReadback(object, objects) {
  const round = v => ({ x: tidy(v.x), y: tidy(v.y), z: tidy(v.z) });
  if (object.attach) return { position: round(pos(object)), rotationDeg: round({ x: object.rotX ?? 0, y: object.rot ?? 0, z: object.rotZ ?? 0 }) };
  const parent = object.parent ? objects.find(o => o.id === object.parent) : null;
  if (!parent || parent.attach || object.path) return null;
  const { position, rotationDeg } = worldToLocal(parent, object);
  return { position: round(position), rotationDeg: round(rotationDeg) };
}
// An attached record's frame is the bone it rides: its channels are written as given.
export function attachedFrameOp(op, entity) {
  const frame = `${entity.attach.characterId}'s ${entity.attach.bone ?? 'root'}`;
  if (op.space !== 'parent' && (op.position || op.rotationDeg || op.facing)) fail('INVALID_ARGUMENT', `${entity.id} rides ${frame}: its position and rotation are stored in that frame. Give space "parent" to set them there (metres and degrees, the bone's unscaled frame), or object.detach it first.`);
  if (op.space !== 'parent') return op;
  if (op.position && !op.position.world) fail('INVALID_ARGUMENT', `space "parent" takes position {world:{x,y,z}} as metres in ${frame} frame; relativeTo, between and onObject resolve in world space.`);
  if (op.facing && !('yawDeg' in op.facing)) fail('INVALID_ARGUMENT', 'space "parent" takes facing {yawDeg} only (local yaw); towardId, awayFromId and sameAsId are world-space.');
  if (!op.position && !op.rotationDeg && !op.facing && !op.scale) fail('INVALID_ARGUMENT', 'space "parent" applies to position, rotationDeg, facing or scale; none was given.');
  const { space, facing, ...rest } = op;
  return { ...rest, ...(facing && !op.rotationDeg ? { rotationDeg: { x: entity.rotX ?? 0, y: facing.yawDeg, z: entity.rotZ ?? 0 } } : {}) };
}
// A bone-frame place is not bound by the world's limits (the deck at y 0, the room): a hand's own frame puts what it
// carries below or behind its origin, so the place is written past them, as an attach writes it (stage-attach-frames.js placeSceneObject).
export const attachedPlace = (entity, op) => (op.position ? { ...entity, ...op.position.world } : entity);
export function writeAttached(rows, id, patch, update) {
  const { x, y, z, ...rest } = patch, place = Object.fromEntries(Object.entries({ x, y, z }).filter(([, value]) => value !== undefined));
  return update(rows, id, rest).map(row => (row.id === id ? { ...row, ...place } : row));
}
const resolveParentRef = (ref, rows, createdByName) => rows.some(e => e.id === ref) ? ref : createdByName.get(normalizedName(ref));
/** Rewrites an op given in the parent's local frame into the equivalent world op. */
export function parentFrameOp(op, entity, rows, createdByName) {
  const create = op.op === 'create';
  if (create && op.parent === undefined) fail('INVALID_ARGUMENT', 'space "parent" needs `parent` on a create: an existing object id, or the name of an object created earlier in this batch.');
  if (!create && !entity.parent) fail('INVALID_ARGUMENT', 'space "parent" needs an object that already has a parent; group it under one first, or omit space for world coordinates.');
  const parentId = create ? resolveParentRef(op.parent, rows, createdByName) : entity.parent;
  const parent = rows.find(e => e.id === parentId);
  if (!parent) fail('AMBIGUOUS_TARGET', 'space "parent": the parent is neither an existing object id nor an object created earlier in this batch.');
  // A routed or take-moved parent carries its children from its authored pose (object-travel.js); one that rides a character carries none.
  if (parent.attach) fail('CAPABILITY_MISSING', `space "parent": ${parent.id} rides ${parent.attach.characterId}'s ${parent.attach.bone ?? 'root'}, and a record grouped under it does not follow it; put the object on that frame with object.attach { local }.`);
  if (!op.position && !op.rotationDeg && !op.facing) fail('INVALID_ARGUMENT', 'space "parent" applies to position, rotationDeg or facing; none was given.');
  if (op.position && !op.position.world) fail('INVALID_ARGUMENT', 'space "parent" takes position {world:{x,y,z}} as local metres from the parent pivot; relativeTo, between and onObject resolve in world space, so omit space for them.');
  if (op.facing && !('yawDeg' in op.facing)) fail('INVALID_ARGUMENT', 'space "parent" takes facing {yawDeg} only (local yaw); towardId, awayFromId and sameAsId are world-space.');
  const current = create ? { position: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } } : worldToLocal(parent, entity);
  // Local rotation: rotationDeg, else the current local one with its yaw set by
  // facing; a new child with neither takes the parent's orientation (local zero).
  const rotation = op.rotationDeg ?? (op.facing ? { ...current.rotationDeg, y: op.facing.yawDeg } : create ? current.rotationDeg : null);
  const world = localToWorld(parent, { position: op.position ? op.position.world : current.position, rotationDeg: rotation ?? current.rotationDeg });
  const { space, facing, ...rest } = op;
  return { ...rest, ...(op.position ? { position: { world: world.position } } : {}), ...(rotation ? { rotationDeg: world.rotationDeg } : {}) };
}
