// #437 acceptance 3: the Studio's one action registry is built from the
// command modules. It lists the same 32 actions App.jsx registered before, and
// App.jsx registers none of them itself any more.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { STUDIO_ACTION_IDS } from '../../src/studio-actions.js';
import { COMMAND_MODULES, createStudioAppActions } from '../../src/commands/index.js';

assert.deepEqual(Object.keys(COMMAND_MODULES), ['shot', 'cast', 'motion', 'motion3', 'motion3Fill', 'physics', 'objects', 'kits', 'view', 'scene', 'project', 'export', 'ai', 'stage']);
const state = { shots: [], objects: [], characters: [], frame: 0, frameCount: 48, selectedObjectId: null, activeCharacterId: null, promptBlockCount: 0,
 generating: false, motionReady: true, exporting: false, canExportVideo: false, scenes: [{ id: 'scene', name: 'ONE' }], activeSceneId: 'scene',
 project: { name: null, hasFile: false, fileAccess: false, gesture: false }, aiShot: { mode: 'image', imageModel: 'gpt_image_2' },
 i2vMotion: { enabled: false, status: 'idle', dailyRemaining: null } };
const registry = createStudioAppActions({ state: () => state });
assert.equal(registry.ids().length, 123, 'the registry includes owned cast, motion (with the take timing edits), motion3 (with motion.fill and motion.primitive), physics, kits and IK actions (and sculpt.compare)');
assert.deepEqual([...registry.ids()].sort(), [...new Set([...STUDIO_ACTION_IDS, ...['stage', 'objects', 'kits', 'scene', 'project', 'shot', 'cast', 'motion', 'motion3', 'motion3Fill', 'physics', 'view'].flatMap(name => COMMAND_MODULES[name].declarations.map(entry => entry.id))])].sort(), 'legacy ids plus the owned domain commands');
assert.deepEqual(registry.ids(), Object.values(COMMAND_MODULES).flatMap(module => module.declarations.map(entry => entry.id)), 'each id comes from its command module');
const listed = registry.list();
assert.equal(listed.length, 123, 'every action answers availability over the published state');
assert.equal(registry.state(), state, 'the registry reads the port object\'s state');

// App.jsx keeps no registration of its own: no registry factory and no entry.
const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const functions = new Set();
const visit = node => { if (!node || typeof node !== 'object') return; if (node.type === 'FunctionDeclaration') functions.add(node.id.name); for (const [key, child] of Object.entries(node)) if (key !== 'parent') Array.isArray(child) ? child.forEach(visit) : visit(child); };
visit(parseSync('App.jsx', app).program);
assert.equal(functions.has('createStudioAppActions'), false, 'App.jsx no longer declares the registry');
assert.equal(/\bregistry\.register\(|\bstudioActionDeclaration\(/.test(app), false, 'App.jsx registers no action itself');
console.log(`PASS #437 acceptance 3: the registry lists ${listed.length} actions read from ${Object.keys(COMMAND_MODULES).length} command modules`);
