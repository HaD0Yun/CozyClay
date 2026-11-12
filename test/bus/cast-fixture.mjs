import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { appFixture } from './app-fixture.mjs';
import { createStudioAppActions } from '../../src/commands/index.js';
import { createCharacterEntry, PROXY_FIGURE_MODEL } from '../../src/scenes.js';

// The two rigged fixture actors plus one capsule figure, which has no rig.
export const PROXY_ID = 'actor-proxy';
export const proxyCast = () => [createCharacterEntry({ id: 'actor-a', model: 'y-bot-tpose', x: 0, z: 0 }),
  createCharacterEntry({ id: 'actor-b', model: 'y-bot-tpose', x: 4, z: 0 }), createCharacterEntry({ id: PROXY_ID, model: PROXY_FIGURE_MODEL, x: -4, z: 0 }, 2)];

// Keep the shipped constants and cast hook; exclude only renderer components
// imported by app-stage, which cannot mount in this Node integration fixture.
const source = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8')
  + readFileSync(new URL('../../src/timeline-defaults.js', import.meta.url), 'utf8')
  + readFileSync(new URL('../../src/stage-startup-defaults.js', import.meta.url), 'utf8');
const names = new Set(['nextCharacterId', 'MAX_WAYPOINTS', 'TIMELINE_FPS']);
const constants = parseSync('stage.jsx', source).program.body.filter(node => node.type === 'ExportNamedDeclaration' &&
  names.has(node.declaration?.id?.name ?? node.declaration?.declarations?.[0]?.id?.name)).map(node => source.slice(node.start, node.end)).join('\n');
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', plugins: [{ name: 'cast-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return constants;
  } }] });
let useCast;
try { ({ useCast } = await server.ssrLoadModule('/src/domains/cast.js')); }
finally { await server.close(); }

export function castFixture(f = appFixture()) {
  const scope = f.scope, app = scope.appContext;
  Object.assign(scope, { startupStage: { characters: f.characterRef.current, hasCharSheet: false }, startupShotState: {},
    rigReportersRef: { current: new Map() }, rigWaitersRef: { current: new Map() },
    setActiveWaypointId() {}, setPendingWaypointFrame() {}, setWaypointMode() {}, setPosing() {}, setPosingClosing() {},
    clearMotion() { throw new Error('motion clearing must be supplied by the native-motion integration case'); },
  });
  let cast;
  function renderCast() {
    function Mount() { cast = useCast(app); return null; }
    renderToStaticMarkup(createElement(Mount));
    scope.castDomain = cast;
    Object.assign(scope, cast);
    return cast;
  }
  renderCast();
  Object.assign(f.actionHandlers.current, app.actionPorts);
  const registry = createStudioAppActions(f.actionHandlers.current);
  scope.studioActionsRef.current = registry;
  f.ports.actions = () => registry;
  app.updatePorts({ read: f.actual.readStudioState, bounds: f.actual.studioBounds, revision: f.revision,
    poses: () => f.poses, actions: () => registry, recordAction: f.actual.recordStudioAction, beginAction: f.actual.beginStudioAction });
  Object.assign(f.ports, app.ports);
  const run = (id, args = {}, origin = 'ui', options = {}) => f.binding.bus.run(id, args, {
    origin, host: f.host(), expectedRevision: f.binding.refresh().revision, ...options,
  });
  const snapshot = () => structuredClone(app.storeDomain('cast').documentStore.getSnapshot().slices);
  return { ...f, cast, registry, run, snapshot, renderCast, dispose() { f.dispose(); cast.dispose?.(); } };
}
