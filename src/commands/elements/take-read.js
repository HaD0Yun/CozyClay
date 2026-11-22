import { specIdOf } from '../../motion3/spec-store.js';
import { savedTakeSource } from '../../domains/motion/take-source.js';

// A take's source (its spec, placement and the scene boxes it was compiled against) runs to
// ~110k characters a character, and a document read carried it in full wherever a take sits:
// motion (as take and fullTake), the cast and stage (motionTake) and every saved scene. One read
// of motion alone answered 460k characters, ~300k tokens a model call for the rest of the turn.
// A read answers the take's specId instead (motion.compile { base: specId } recompiles it); a
// character named in ids also gets its spec and placement, never the scene boxes.
const LEFT_OUT = 'left out of this read: name this character in ids for its spec and placement, or compile { base: specId }';
const leftOutScene = scene => `left out (the ${Object.keys(scene?.objects ?? {}).length} scene objects it was compiled against)`;

// A raw take's spec (motion.v4.install) carries its whole track in base64 (~250k characters for 7 s): a read names its size.
// It also keeps the motion writer's scene and spec it was compiled from (spec.lowvis, ~20k characters for 30 s of three
// bodies), which the motion tool reads by itself: a read names the motion they are of.
const leanSpec = spec => (spec?.raw ? { ...spec, raw: `left out (the encoded track of ${spec.raw.frames} frames, ${JSON.stringify(spec.raw).length} characters)`,
  ...(spec.lowvis ? { lowvis: `left out (the scene and spec of motion ${spec.lowvis.name}, kept with this take for the motion tool)` } : {}) } : spec);

/** A take source ({ schema, rig, spec, placement, scene, ... }) as a read answers it: { specId, ... }. */
function readSource(source, named) {
  const specId = specIdOf(source.spec);
  if (!named) return { specId, frames: source.spec?.frames, ...(source.takeId ? { takeId: source.takeId } : {}), ...(source.edit ? { edit: source.edit } : {}), spec: LEFT_OUT };
  const { scene, spec, ...kept } = source;
  return { specId, ...kept, spec: leanSpec(spec), scene: leftOutScene(scene) };
}

/** A motion layer's take descriptor, its source read as above. */
export function readTake(take, named) {
  if (!take?.source) return take;
  const { source, ...descriptor } = take, specId = specIdOf(source.spec);
  if (!named) return { ...descriptor, specId, source: LEFT_OUT };
  const { scene, spec, ...kept } = source;
  return { ...descriptor, specId, source: { ...kept, spec: leanSpec(spec), scene: leftOutScene(scene) } };
}

/** Cast rows with their saved takes (motionTake) read as above. */
export const readCastTakes = (characters, named) => (Array.isArray(characters)
  ? characters.map(row => (row?.motionTake?.spec ? { ...row, motionTake: readSource(row.motionTake, named(row.id)) } : row)) : characters);

/** A document whose cast rows carry the take the motion owner holds now (a cast row's motionTake is what the scene last
 * saved or loaded; while the scene is open the motion layer owns the take, as document-mirrors.js saves it). */
export function withLiveTakes(document) {
  if (!Array.isArray(document?.characters) || !Array.isArray(document.motion)) return document;
  const takes = new Map(document.motion.map(row => [row.id, savedTakeSource(row.take)]));
  return { ...document, characters: document.characters.map(row => ({ ...row, motionTake: takes.get(row.id) ?? null })) };
}
