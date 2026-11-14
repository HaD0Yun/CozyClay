import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseSync } from 'rolldown/experimental';
import { createAppContext } from '../../src/app-context.js';
import { createDocumentStore } from '../../src/document-store.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else walk(value, visit);
  }
}
function parse(path) {
  const result = parseSync(path, read(path));
  assert.deepEqual(result.errors, [], path);
  return result.program;
}
function stateNames(ast) {
  const names = [];
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'ArrayPattern'
      && ['useState', 'useSemanticState'].includes(node.init?.callee?.name)) names.push(node.id.elements[0].name);
  });
  return names;
}
const domains = {
  motion: { states: ['domain'], panels: ['RigControlPanel'] },
  cast: { states: ['domain', 'activeCharacterId'], panels: ['SubjectsPanel', 'CharacterTransformPanel', 'RigPanel', 'PosePanel'] },
  shots: { states: ['domain', 'tlFrame'], panels: ['CameraPanel'] },
  objects: { states: ['domain'], panels: ['PropsPanel', 'ObjectTransformPanel'] },
  scenes: { states: ['domain'], panels: ['ProjectPanel'] },
  stage: { states: ['domain', 'preset'], panels: ['LightPanel', 'EnvironmentPanel'] },
};
// Existing source-driven integration fixtures follow the moved implementation,
// not a copy of it. Keep source text intact except for the extra default exports.
export function readStudioSource() {
  const paths = ['src/App.jsx', ...['domains', 'panels', 'shell'].flatMap(directory =>
    readdirSync(new URL(`src/${directory}/`, root)).filter(name => /\.(js|jsx)$/.test(name)).map(name => `src/${directory}/${name}`))];
  return paths.map(path => read(path).replace(/export default /g, '')).join('\n');
}

export function readStudioFunction(name, source = readStudioSource()) {
  let found;
  walk(parseSync('studio.jsx', source).program, node => {
    if (node.type === 'FunctionDeclaration' && node.id.name === name) found = node;
  });
  assert(found, `studio function ${name}`);
  return source.slice(found.start, found.end);
}

// Resolve lexical references rather than treating property names or callback
// parameters as dependencies. Also used when following source-based fixtures.
export function freeReferences(rootNode) {
  const references = [];
  const bindings = (node, names) => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'RestElement') bindings(node.argument, names);
    else if (node.type === 'AssignmentPattern') bindings(node.left, names);
    else if (node.type === 'ArrayPattern') node.elements.forEach(n => bindings(n, names));
    else if (node.type === 'ObjectPattern') node.properties.forEach(n => bindings(n.value ?? n.argument, names));
  };
  const collect = (node, names) => {
    if (!node || typeof node !== 'object') return;
    if (/Function/.test(node.type)) { if (node.id) names.add(node.id.name); return; }
    if (node.type === 'VariableDeclarator') bindings(node.id, names);
    if (node.type === 'ImportDeclaration') node.specifiers.forEach(n => names.add(n.local.name));
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach(n => collect(n, names));
      else if (value && typeof value === 'object') collect(value, names);
    }
  };
  function visit(node, scopes = [], parent = null, key = '') {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Program' || /Function/.test(node.type) || node.type === 'CatchClause') {
      const names = new Set();
      if (node.id) bindings(node.id, names);
      (node.params ?? []).forEach(n => bindings(n, names));
      if (node.param) bindings(node.param, names);
      collect(node.body, names);
      scopes = [...scopes, names];
    }
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
      if (node.type === 'JSXIdentifier' && (!/^[A-Z]/.test(node.name) || parent?.type === 'JSXAttribute')) return;
      if ((parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent?.type === 'Property' && key === 'key' && !parent.computed)
        || (parent?.type === 'VariableDeclarator' && key === 'id')
        || (parent?.type?.startsWith('Import')) || key === 'label') return;
      if (!scopes.some(names => names.has(node.name))) references.push({ node, parent, key });
      return;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'parent' || childKey === 'id' || childKey === 'params' || childKey === 'param') continue;
      if (Array.isArray(value)) value.forEach(n => visit(n, scopes, node, childKey));
      else visit(value, scopes, node, childKey);
    }
    // Defaults (including destructured options) execute in the function scope.
    const defaults = pattern => {
      if (!pattern) return;
      if (pattern.type === 'AssignmentPattern') { visit(pattern.right, scopes, pattern, 'right'); defaults(pattern.left); }
      else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(n => defaults(n.value ?? n.argument));
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(defaults);
    };
    (node.params ?? []).forEach(defaults);
    if (node.type === 'VariableDeclarator') defaults(node.id);
  }
  visit(rootNode);
  return references;
}

function verify() {
  const app = { type: 'Program', body: ['src/App.jsx', ...readdirSync(new URL('src/shell/', root))
    .filter(name => /\.(js|jsx)$/.test(name)).map(name => `src/shell/${name}`)].map(parse) };
  for (const [domain, { states, panels }] of Object.entries(domains)) {
    const path = `src/domains/${domain}.js`;
    assert(existsSync(new URL(path, root)), `acceptance 1: ${path} owns its domain state`);
    const ast = parse(path);
    for (const name of states) {
      assert(!stateNames(app).includes(name), `acceptance 1: ${name} must leave App.jsx`);
      assert(stateNames(ast).includes(name), `acceptance 1: ${name} must live in ${path}`);
    }
    if (domain === 'objects') {
      let owner = false, remaining = false;
      walk(ast, node => { if (node.type === 'VariableDeclarator' && node.id.name === 'storeRef') owner = true; });
      walk(app, node => { if (node.type === 'VariableDeclarator' && node.id.name === 'storeRef') remaining = true; });
      assert(owner && !remaining, 'acceptance 1: the scene-history storeRef belongs to useObjects');
    }
    const globals = new Set(['window', 'document', 'localStorage', 'globalThis', 'console', 'fetch', 'navigator', 'crypto', 'URL', 'URLSearchParams', 'File', 'FileReader', 'Blob', 'Image', 'HTMLElement', 'Element', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', 'performance', 'createImageBitmap', 'undefined', 'NaN', 'Infinity', ...Object.getOwnPropertyNames(globalThis)]);
    assert.deepEqual([...new Set(freeReferences(ast).map(ref => ref.node.name))].filter(name => !globals.has(name)), [], `acceptance 2: all shared dependencies in ${path} resolve through the facade`);
    const handlers = {
      stage: ['changeKeyLight', 'resetKeyLight', 'changeEnvironmentImage'],
      scenes: ['persistScenes', 'openScene', 'saveProject', 'applyProject'],
      objects: ['addSceneObject', 'importCutout', 'importMesh', 'spawnCutoutAt', 'spawnMeshAt'],
      shots: ['addCameraKeyframe', 'moveCameraKeyframe', 'removeCameraKeyframe'],
      cast: ['updateCharacterAt', 'removeCharacter', 'savePose', 'removePose'],
      motion: ['clearMotion', 'toggleIkMode', 'ikAddKeyframe', 'ikDragEnd'],
    };
    const functions = tree => {
      const names = [];
      walk(tree, node => { if (node.type === 'FunctionDeclaration') names.push(node.id.name); });
      return names;
    };
    for (const name of handlers[domain]) {
      assert(functions(ast).includes(name), `acceptance 1: ${name} belongs to ${path}`);
      assert(!functions(app).includes(name), `acceptance 1: ${name} must leave App.jsx`);
    }
    const hooks = [];
    walk(ast, node => {
      if (node.type === 'ImportDeclaration') assert(!/(?:^|\/)domains\/|^\.\/(?:stage|scenes|objects|shots|cast|motion)\.js$/.test(node.source.value), `acceptance 2: no cross-domain import in ${path}`);
      if (node.type === 'Identifier') assert(!['opClockRef', 'charHistoryRef'].includes(node.name), `acceptance 2: ${node.name} bypasses the facade`);
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') hooks.push(node.declaration.id.name);
    });
    assert(hooks.includes(`use${domain[0].toUpperCase()}${domain.slice(1)}`), `acceptance 2: exported ${domain} hook`);
    for (const panel of panels) {
      const panelPath = `src/panels/${panel}.jsx`;
      assert(existsSync(new URL(panelPath, root)), `acceptance 3: ${panel} has its own panel file`);
      const panelAst = parse(panelPath);
      const elements = [];
      walk(panelAst, node => { if (node.type === 'JSXOpeningElement') elements.push(node.name.name); });
      assert(elements.includes(panel === 'ProjectPanel' ? 'ResourceStatus' : 'Foldout'), `acceptance 3: ${panel} owns its section, not a children passthrough`);
      let rendered = false;
      walk(app, node => { if (node.type === 'JSXOpeningElement' && node.name.name === panel) rendered = true; });
      assert(rendered, `acceptance 3: App renders ${panel}`);
    }
    console.log(`PASS domain ${domain}: state ownership, facade isolation, Inspector panels`);
  }
  let inlineSections = 0;
  walk(app, node => { if (node.type === 'JSXOpeningElement' && node.name.name === 'Foldout') inlineSections++; });
  assert.equal(inlineSections, 0, 'acceptance 3: every Inspector foldout now belongs to a panel file');
  const lines = read('src/App.jsx').split('\n').length - 1;
  assert(lines <= 15613 - 50 * Object.keys(domains).length, `acceptance 4: App.jsx shrinks with each domain (${lines} lines)`);
  console.log(`PASS domain metric: App.jsx 15613 -> ${lines} lines`);

  const notices = [];
  const facade = createAppContext({ notify: (...args) => notices.push(args) });
  const cell = { current: 1 };
  const first = facade.forRender({ selected: 'first', cell });
  const retained = () => [first.shared.selected, first.shared.cell.current];
  const second = facade.forRender({ selected: 'second', cell });
  cell.current = 2;
  assert.deepEqual(retained(), ['first', 2], 'retained handlers keep render values but share the same ref cells');
  assert.equal(second.shared.selected, 'second');
  assert.equal(first.notify, second.notify, 'all domains share the stable App-owned notifier');
  first.notify('visible', 'receipt');
  assert.deepEqual(notices, [['visible', 'receipt']], 'notification arguments are forwarded without reinterpretation');
  const store = createDocumentStore({ owned: { cast: [] } });
  first.registerStoreDomain('cast', { documentStore: store, beginAction: () => store.beginAction('cast') });
  first.recordAction('cast', () => store.write('cast', [{ id: 'actor' }]));
  assert.equal(second.recordShotUndo, undefined, 'shots use their registered document owner');
  assert.equal(first.historyEntry(), second.historyEntry());
  assert.equal(facade.nextStoreHistory(false), first.storeDomain('cast'));
  assert.equal(facade.undoClock, 1, 'render projections never fork committed history');
  console.log('PASS domain facade: render closure lifetime and shared interleaved undo clock');

  // Each domain reads only the shared values its App.jsx forRender block hands it: forRender scopes them per domain, so a
  // value another domain receives is undefined here. A plain read of a missing one crashed every object.attach and
  // object.detach (`appContext.shared.attachFrameRef.current`, "Cannot read properties of undefined"). Optional reads
  // (`?.`) fall back on purpose and are not counted.
  const appSource = read('src/App.jsx'), unwired = [];
  for (const [, hook, body] of appSource.matchAll(/const \w+ = (use[A-Z]\w*)\(appContext\.forRender\(\{([\s\S]*?)\n\t\}\)\);/g)) {
    const given = new Set([...body.matchAll(/get (\w+)\(\)/g), ...body.matchAll(/^\s*(\w+)\s*[,:]/gm)].map(m => m[1]));
    const name = hook.slice(3, 4).toLowerCase() + hook.slice(4), file = [`src/domains/${name}.js`, `src/domains/${name}s.js`].find(path => existsSync(new URL(path, root)));
    for (const m of read(file).matchAll(/appContext\.shared(\?)?\.(\w+)(\?\.)?/g)) if (!m[1] && !m[3] && !given.has(m[2])) unwired.push(`${file}: ${m[2]}`);
  }
  assert.deepEqual([...new Set(unwired)], [], 'every plain appContext.shared read is handed to that domain by its App.jsx forRender block');
  console.log('PASS domain wiring: every plain shared read is provided by its forRender block');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) verify();
