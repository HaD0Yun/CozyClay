import { isEffectivelyHidden } from './scene-objects.js';

/** Named subjects never silently become another character, even when hidden or removed. */
export function shotSubjects(shot, characters, activeId, objects = []) {
  const visible = characters.filter(entry => !isEffectivelyHidden(entry, objects, characters));
  const ids = shot?.subjectIds?.length ? shot.subjectIds : activeId ? [activeId] : [];
  return [...new Set(ids)].map(id => visible.find(entry => entry.id === id)).filter(Boolean);
}

export function subjectsCenter(subjects) {
  if (!subjects.length) return null;
  const mean = axis => subjects.reduce((sum, entry) => sum + (entry[axis] ?? 0), 0) / subjects.length;
  return { x: mean('x'), y: mean('y'), z: mean('z'), rot: subjects[0].rot ?? 0 };
}
