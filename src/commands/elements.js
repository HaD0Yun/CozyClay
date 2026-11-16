// Shared set/read machinery. Domain modules supply only their kind, declared
// fields and persistence normalizer; no UI or runtime resources live here.
import { patchValueSchema, validateStudioSchema, StudioProtocolError, StudioSchemas, utf8ByteLength } from '../studio-agent-protocol.js';

import { isSettableElement } from '../studio-elements.js';
import { withLiveTakes } from './elements/take-read.js';

const kinds = new Map();
// Each kind registers its declared elements and persistence normalizer once.
// Its command port supplies read()/write(); all schemas and path aliases use
// this same spec so a migration adds a module, not another generic switch.
export function registerElementKind(kind, spec) {
  if (kinds.has(kind)) throw new Error(`Element kind already registered: ${kind}`);
  kinds.set(kind, { documentKey: kind, ...spec });
}
const projectionKind = key => [...kinds].find(([, spec]) => spec.documentKey === key)?.[0] ?? key;
const patchElements = kind => kinds.get(kind).elements.filter(isSettableElement);
const object = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
// String mappings retain the single-document schema. Component mappings use
// the logical field in set args and fan out only at the storage boundary.
const setPath = element => typeof element.documentPath === 'string' ? element.documentPath : element.path.slice(element.path.indexOf('.') + 1);
const atPath = (value, path) => path.split('.').reduce((value, key) => value?.[key], value);
const nestedValue = (path, value) => path.split('.').reduceRight((value, key) => ({ [key]: value }), value);
export function elementSetSchema(kind) {
  const schema = object();
  for (const element of patchElements(kind)) {
    const keys = setPath(element).split('.');
    let parent = schema;
    for (const key of keys.slice(0, -1)) parent = parent.properties[key] ??= object();
    // Validate the wire type here; persistence owns numeric clamps. Empty
    // strings are valid authored text, including intermediate typing states.
    const value = element.type === 'number' ? { type: 'number' }
      : element.type === 'string' ? { oneOf: [{ const: '' }, { type: 'string', maxLength: 240 }] } : patchValueSchema(element);
    parent.properties[keys.at(-1)] = element.nullable ? { oneOf: [value, { type: 'null' }] } : value;
  }
  if (!kinds.get(kind).collection) return schema;
  // A single item is { id, set }; a batch is { ops: [{ id, set }] }.
  // Both forms publish once and therefore own exactly one history entry.
  const item = { ...object(), properties: { id: StudioSchemas.TargetGuard.properties.targetId, set: schema }, required: ['id', 'set'] };
  const batch = { ...object(), properties: { ops: { type: 'array', items: item, minItems: 1, maxItems: 32 } }, required: ['ops'] };
  return { ...object(), properties: { ...item.properties, ...batch.properties }, oneOf: [item, batch] };
}
export function elementTarget(kind, value, id, sceneId) {
  return kinds.get(projectionKind(kind)).collection ? value.find(row => row.id === id) : id === sceneId ? value : undefined;
}
// A kind's `read` shapes what a document read answers (motion leaves out a take's bulky source
// unless its row id was named): `named` are the ids the caller asked for by name. A read answers
// at most DOCUMENT_READ_CHARS of kinds, the smallest first; the rest are named in `omitted` with
// their size, to select alone or by ids. One kind alone answers whole (ids narrow it).
const DOCUMENT_READ_CHARS = 90_000;
export function readElementDocument(projection, { ids, select, named = ids } = {}, sceneId) {
  const entries = Object.entries(withLiveTakes(projection)).flatMap(([key, value]) => {
    const kind = projectionKind(key);
    if (select && !select.includes(key) && !select.includes(kind)) return [];
    if (!ids || ids.includes(key) || ids.includes(kind) || ids.includes(sceneId)) return [[key, value]];
    const selected = kinds.get(kind).collection ? value.filter(row => ids.includes(row.id)) : [];
    return selected.length ? [[key, selected]] : [];
  }).map(([key, value]) => {
    const read = kinds.get(projectionKind(key))?.read;
    return [key, read ? read(value, id => Boolean(named?.includes(id))) : value];
  });
  const sized = entries.map(([key, value]) => { const schema = elementSetSchema(projectionKind(key)); return { key, value, schema, chars: JSON.stringify([value, schema]).length }; });
  let room = DOCUMENT_READ_CHARS;
  const fits = new Set(sized.length < 2 ? sized.map(row => row.key) : [...sized].sort((a, b) => a.chars - b.chars).filter(row => (room -= row.chars) >= 0).map(row => row.key));
  const kept = sized.filter(row => fits.has(row.key)), omitted = sized.filter(row => !fits.has(row.key));
  return { document: structuredClone(Object.fromEntries(kept.map(row => [row.key, row.value]))), schema: Object.fromEntries(kept.map(row => [row.key, row.schema])),
    ...(omitted.length ? { omitted: Object.fromEntries(omitted.map(row => [row.key, row.chars])),
      note: `Left out to keep this read under ${DOCUMENT_READ_CHARS} characters (sizes in omitted): select a kind alone, name ids, or page objects with scope "entities".` } : {}) };
}
export function readElement(document, path) {
  const element = kinds.get(path.slice(0, path.indexOf('.'))).elements.find(row => row.path === path);
  return element.documentPath && typeof element.documentPath === 'object'
    ? Object.fromEntries(Object.entries(element.documentPath).map(([component, stored]) => [component, atPath(document, stored)]))
    : atPath(document, setPath(element));
}
function mergeElementSet(document = {}, patch) {
  document = document ?? {};
  const next = { ...document };
  for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeElementSet(document[key], value) : value;
  return next;
}
function storedElementSet(kind, patch) {
  let stored = mergeElementSet({}, patch);
  for (const element of patchElements(kind)) {
    if (!element.documentPath || typeof element.documentPath !== 'object') continue;
    const value = atPath(patch, setPath(element));
    if (value === undefined) continue;
    const keys = setPath(element).split('.');
    const parent = keys.slice(0, -1).reduce((value, key) => value[key], stored);
    delete parent[keys.at(-1)];
    for (const [component, path] of Object.entries(element.documentPath)) stored = mergeElementSet(stored, nestedValue(path, value[component]));
  }
  return stored;
}
export function elementPatchArgs(kind, args) {
  const set = { ...object(), additionalProperties: true };
  const collection = kinds.get(kind).collection;
  const target = { ...object(), properties: { kind: { const: kind }, ...(collection ? { id: StudioSchemas.TargetGuard.properties.targetId } : {}) }, required: collection ? ['kind', 'id'] : ['kind'] };
  const op = { ...object(), properties: { target, set }, required: ['target', 'set'] };
  const schema = { ...object(), properties: { ops: { type: 'array', items: op, minItems: 1, maxItems: 32 } }, required: ['ops'] };
  const validated = validateStudioSchema(schema, args);
  const ops = validated.ops.map(({ target, set }) => {
    let patch = {};
    for (const [key, value] of Object.entries(set)) {
      const element = patchElements(kind).find(row => row.path === `${kind}.${key}`);
      if (!element) throw new StudioProtocolError('INVALID_ARGUMENT', `Unknown ${kind} path: ${key}`);
      const nested = nestedValue(setPath(element), value);
      patch = mergeElementSet(patch, nested);
    }
    return { id: target.id, set: patch };
  });
  return collection ? ops.length === 1 ? ops[0] : { ops } : ops.reduce((patch, op) => mergeElementSet(patch, op.set), {});
}
// Unasked, an optional structured value (a glow, a light) or a `sparse` field (a
// surface preset) is listed only where the item has one, so every plain
// object's receipt stays as short as before.
const listed = (element, item, paths) => paths ? paths.includes(element.path) : (element.type !== 'object' && !element.sparse) || readElement(item, element.path) != null;
export function elementReadback(kind, item, paths, document) {
  return patchElements(projectionKind(kind)).filter(element => listed(element, item, paths)).map(element => {
    const path = element.path;
    if (element.readback) return { path, ...element.readback(item, document) };
    const value = readElement(item, path);
    if (value === null || value === undefined || value === '') return { path, text: null };
    if (element.type === 'image') return { path, bytes: utf8ByteLength(value) };
    // A small structured value (a light, a glow) reads back whole, as compact JSON.
    if (element.type === 'object') return { path, text: JSON.stringify(value).slice(0, 512) };
    if (element.type === 'vec3') return { path, vec: value };
    if (element.type === 'array') return { path, count: Array.isArray(value) ? value.length : value.points?.length ?? 0 };
    return { path, [typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'flag' : 'text']: value };
  });
}
// Normalizer-added defaults are allowed; changed/clamped requested members
// are reported as dropped, just like the native patch planners. A number that
// landed within float noise (a wrap leaves -17.529999999999973 for -17.53),
// or an angle that landed one or more whole turns away (190 kept as -170), survives.
const turn = (delta, angle) => angle ? delta - 360 * Math.round(delta / 360) : delta;
function survives(requested, actual, angle = false) {
  if (typeof requested === 'number' && typeof actual === 'number') return requested === actual
    || Math.abs(turn(requested - actual, angle)) <= 1e-9 * Math.max(1, Math.abs(requested), Math.abs(actual));
  if (requested === null || typeof requested !== 'object') return requested === actual;
  if (Array.isArray(requested)) return Array.isArray(actual) && requested.length === actual.length && requested.every((value, index) => survives(value, actual[index], angle));
  return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(requested).every(([key, value]) => survives(value, actual[key], angle));
}
export function elementPatchReceipt(receipt, request, projection) {
  const kind = request?.args.ops[0].target.kind;
  if (!receipt.ok || !kind || !kinds.get(kind).collection) return receipt;
  const value = projection[kinds.get(kind).documentKey];
  const ops = request.args.ops.map(({ target, set }, index) => {
    const item = elementTarget(kind, value, target.id, receipt.host.sceneId);
    const droppedPaths = Object.entries(set).filter(([key, requested]) => {
      const element = patchElements(kind).find(element => element.path === `${kind}.${key}`);
      return !element.readback && !survives(requested, readElement(item, element.path), element.angle === true);
    }).map(([key]) => `${kind}.${key}`);
    return { index, status: droppedPaths.length ? 'partial' : receipt.authored ? 'applied' : 'noop', ...(droppedPaths.length ? { droppedPaths } : {}) };
  });
  // A dropped path makes the receipt "partial" whenever it published one revision: an applied
  // patch, or one inside an agent turn (which the bus answers "completed"). A composite that moved
  // the revision further stays "completed", and its ops name the dropped paths.
  const partial = receipt.authored && ops.some(op => op.status === 'partial') && receipt.revision.after === receipt.revision.before + 1 && !receipt.nextHost;
  // The protocol's partial variant is a patch receipt, not an action or composite receipt.
  const { action, summary, kind: composite, ...base } = receipt;
  // A row the edit carried along (a moved group's part) reads back where it went: its vec3 transform paths.
  const targets = new Set(request.args.ops.map(({ target }) => target.id));
  const moved = patchElements(kind).filter(element => element.type === 'vec3').map(element => element.path);
  const carried = receipt.affectedIds.filter(id => !targets.has(id) && elementTarget(kind, value, id, receipt.host.sceneId)).map(id => ({ id, paths: moved }));
  return { ...(partial ? base : receipt), ops, status: partial ? 'partial' : receipt.status,
    delta: !receipt.authored ? [] : [...request.args.ops.map(({ target, set }) => ({ id: target.id, paths: Object.keys(set).map(key => `${kind}.${key}`) })), ...carried]
      .slice(0, 8).map(({ id, paths }) => ({ id, after: { patched: elementReadback(kind, elementTarget(kind, value, id, receipt.host.sceneId), paths, value) } })) };
}
export function registerElementSet(registry, ports, declaration) {
  const kind = declaration.id.slice(0, declaration.id.indexOf('.'));
  const { normalize, collection, carry, warn } = kinds.get(kind);
  registry.register({ ...declaration, available: () => true, run(args) {
    const domain = ports.storeDomain(declaration.undoDomain ?? kind);
    let next = domain.read();
    const ops = collection ? args.ops ?? [args] : [{ id: ports.state().activeSceneId, set: args }];
    const carried = new Set(), warnings = [];
    for (const { id, set } of ops) {
      const before = collection ? next.find(row => row.id === id) : next;
      if (!before) throw new StudioProtocolError('TARGET_NOT_READY', `Unknown ${kind} id: ${id}`);
      const after = normalize(mergeElementSet(before, storedElementSet(kind, set)));
      if (warn) warnings.push(...warn({ ...after, id }, set));
      // A kind whose rows hang off each other (a group's parts) moves the rows its target carries.
      if (collection && carry) {
        const rows = carry(next, id, after);
        rows.forEach((row, index) => { if (row !== next[index] && row.id !== id) carried.add(row.id); });
        next = rows;
      }
      next = collection ? next.map(row => row.id === id ? { ...after, id } : row) : after;
    }
    if (JSON.stringify(next) !== JSON.stringify(domain.read())) domain.write(next);
    return { affectedIds: [...new Set([...ops.map(op => op.id), ...carried])], summary: `Updated ${kind}.`, ...(warnings.length ? { warnings } : {}) };
  } });
}
