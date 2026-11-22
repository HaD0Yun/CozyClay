import { registerElementKind } from '../elements.js';
import { readStage } from './take-read.js';

// Array position is the authoritative order. The owner refreshes this persisted
// field after every move, so generic set/read and the project file agree.
registerElementKind('scene', {
  collection: true, documentKey: 'scenes',
  elements: [
    { path: 'scene.name', type: 'string' },
    { path: 'scene.order', type: 'number' },
  ],
  // a saved scene keeps its cast's takes: a read answers their spec ids (take-read.js)
  read: (scenes, named) => scenes.map(scene => (scene?.stage ? { ...scene, stage: readStage(scene.stage, named) } : scene)),
  normalize: scene => ({ ...scene, name: scene.name.trim(), order: Math.max(0, Math.round(scene.order)) }),
});
registerElementKind('project', {
  elements: [{ path: 'project.name', type: 'string' }],
  normalize: project => project,
});
