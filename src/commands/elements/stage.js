import { createSceneStage } from '../../scenes.js';
import { STUDIO_ELEMENTS } from '../../studio-elements.js';
import { registerElementKind } from '../elements.js';
import { readStage } from './take-read.js';

const elements = STUDIO_ELEMENTS.filter(row => row.path.startsWith('stage.'));
export const STAGE_FIELDS = [...new Set(elements.map(element => (element.documentPath ?? element.path.slice(6)).split('.')[0]))];
export function normalizeStage(source) {
  const normalized = createSceneStage(source);
  return Object.fromEntries(STAGE_FIELDS.map(key => [key, normalized[key]]));
}
registerElementKind('stage', { elements, read: readStage, normalize: normalizeStage });
