import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { appFixture } from './app-fixture.mjs';

// Mount the shipped hook, then use the shipped App native functions, registry
// and binding. Only React rendering and renderer hardware are supplied here.
const defaults = 'export {};';
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'stage-default-without-renderer', enforce: 'pre',
    load(id) { if (id.endsWith('/src/app-stage.jsx')) return defaults; } }],
});
let useStage, AppContext;
const stagePanels = {};
try {
  ({ useStage } = await server.ssrLoadModule('/src/domains/stage.js'));
  ({ AppContext } = await server.ssrLoadModule('/src/app-context.js'));
  for (const name of ['EnvironmentPanel', 'LightPanel']) stagePanels[name] = (await server.ssrLoadModule(`/src/panels/${name}.jsx`)).default;
}
finally { await server.close(); }
export function stageFixture() {
  const f = appFixture();
  let stage;
  function Mount() {
    stage = useStage(f.scope.appContext.forRender({
      startupStage: f.live.current.stage,
      get actorStageRef() { return f.scope.actorStageRef; },
      get objects() { return f.store.current.objects; },
    }));
    return null;
  }
  f.scope.actorStageRef = { current: structuredClone(f.live.current.stage) };
  renderToStaticMarkup(createElement(Mount));
  Object.assign(f.scope, stage);
  Object.assign(f.ports, f.scope.appContext.ports);
  Object.assign(f.actionHandlers.current, f.scope.appContext.actionPorts);
  f.ports.canUndo = f.actual.canUndoStudioReceipt;
  const run = (id, args = {}, origin = 'ui', options = {}) => f.binding.bus.run(id, args, {
    origin, host: f.host(), expectedRevision: f.binding.refresh().revision, ...options,
  });
  function panel(name, props) {
    let tree;
    function Capture() { tree = stagePanels[name](props); return null; }
    renderToStaticMarkup(createElement(AppContext.Provider, { value: f.scope.appContext }, createElement(Capture)));
    return tree;
  }
  return { ...f, stage, run, panel, dispose() { f.dispose(); stage.dispose?.(); } };
}
